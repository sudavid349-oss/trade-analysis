"""
Option chain snapshot fetcher.
Runs during market hours, snaps every OC_SNAPSHOT_INTERVAL_MIN minutes.
Stores ATM ± OC_LIVE_STRIKES_EACH_SIDE strikes to keep storage sane.
"""
import asyncio
from datetime import datetime, date, time
from dhanhq import DhanContext, dhanhq
from config import (
    DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN, INDICES,
    OC_SNAPSHOT_INTERVAL_MIN, OC_LIVE_STRIKES_EACH_SIDE,
    MARKET_OPEN, MARKET_CLOSE,
)
from storage import Storage


def _is_market_open() -> bool:
    now = datetime.now().time()
    open_t  = time(*map(int, MARKET_OPEN.split(":")))
    close_t = time(*map(int, MARKET_CLOSE.split(":")))
    return open_t <= now <= close_t


def _parse_oc(raw: dict, atm_price: float) -> list[dict]:
    """Extract relevant strikes (ATM ± N) from Dhan OC response."""
    rows = []
    data = raw.get("data") or raw.get("optionChain") or []
    if isinstance(data, dict):
        # Sometimes it's {strike: {CE: ..., PE: ...}}
        all_strikes = sorted(float(k) for k in data.keys())
        dists = [abs(s - atm_price) for s in all_strikes]
        sorted_strikes = [s for _, s in sorted(zip(dists, all_strikes))]
        nearby = set(sorted_strikes[:OC_LIVE_STRIKES_EACH_SIDE * 2])
        for strike_str, opts in data.items():
            strike = float(strike_str)
            if strike not in nearby:
                continue
            for opt_type, od in opts.items():
                if opt_type not in ("CE", "PE"):
                    continue
                rows.append({
                    "strike": strike,
                    "opt_type": opt_type,
                    "ltp": od.get("ltp") or od.get("lastTradedPrice"),
                    "oi": od.get("openInterest") or od.get("oi"),
                    "volume": od.get("volume"),
                    "iv": od.get("impliedVolatility") or od.get("iv"),
                    "delta": od.get("delta"),
                    "gamma": od.get("gamma"),
                    "theta": od.get("theta"),
                    "vega": od.get("vega"),
                    "bid": od.get("bidPrice"),
                    "ask": od.get("askPrice"),
                })
    return rows


class OptionChainScheduler:
    def __init__(self, storage: Storage, alert_mon=None):
        self._storage   = storage
        self._alert_mon = alert_mon
        self._ctx = DhanContext(DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN)
        self._dhan = dhanhq(self._ctx)

    async def run(self):
        """Loop: fetch OC for all indices every N minutes during market hours."""
        while True:
            if _is_market_open():
                await self._fetch_all()
            await asyncio.sleep(OC_SNAPSHOT_INTERVAL_MIN * 60)

    async def _fetch_all(self):
        for idx in INDICES:
            try:
                await asyncio.to_thread(self._fetch_one, idx)
            except Exception as e:
                print(f"[OC] Error fetching {idx['name']}: {e}")

    def _fetch_one(self, idx: dict):
        seg = idx["segment"]
        uid = idx["id"]

        # First get current LTP for ATM calc
        try:
            quote = self._dhan.ohlc_data(securities={seg: [int(uid)]})
            ltp = float(
                quote.get("data", {})
                     .get(seg, {})
                     .get(str(uid), {})
                     .get("ltp", 0)
            )
        except Exception:
            ltp = 0

        # Get nearest expiry
        try:
            exp_resp = self._dhan.expiry_list(
                under_security_id=int(uid),
                under_exchange_segment=seg,
            )
            expiries = exp_resp.get("data", [])
            expiry_str = expiries[0] if expiries else None
        except Exception:
            expiry_str = None

        if not expiry_str:
            return

        expiry_date = date.fromisoformat(expiry_str)

        # Fetch OC
        raw = self._dhan.option_chain(
            under_security_id=int(uid),
            under_exchange_segment=seg,
            expiry=expiry_str,
        )

        rows = _parse_oc(raw, ltp)
        if not rows:
            return

        ts = datetime.now()
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(
                self._storage.insert_oc_snapshot(uid, ts, expiry_date, rows)
            )
        finally:
            loop.close()
        print(f"[OC] Saved {len(rows)} rows for {idx['name']} expiry {expiry_str}")
        # Trigger alert check after snapshot saved
        if self._alert_mon:
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(self._alert_mon.check(uid))
            finally:
                loop.close()
