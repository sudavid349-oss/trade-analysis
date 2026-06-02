"""
Historical candle backfill from Dhan API.
Called on backend startup for each index if DB has < MIN_CANDLES for the timeframe.
Uses dhanhq.historical_daily_data() and intraday_minute_data().
"""
import asyncio
from datetime import date, datetime, timedelta
from dhanhq import DhanContext, dhanhq
from config import (
    DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN,
    INDICES, SEGMENT_MAP,
)
from storage import Storage

MIN_CANDLES   = 100        # skip backfill if we already have enough
HISTORY_DAYS  = 30         # how many days of 1m data to fetch
DAILY_YEARS   = 2          # years of daily candles to fetch

# Dhan API TF codes
DHAN_TF_MAP = {
    "1m":  1,
    "5m":  5,
    "15m": 15,
    "1h":  60,
    "1d":  "D",
}


def _to_dhan_seg(segment: str) -> str:
    """Map our segment string to Dhan's exchange segment string."""
    return {
        "IDX_I": "IDX_I",
        "BSE_I": "IDX_I",
        "NSE_EQ": "NSE",
        "NSE_FNO": "NSE",
    }.get(segment, "IDX_I")

INSTRUMENT_TYPE = "INDEX"


def _candles_from_response(resp: dict) -> list[dict]:
    """Normalise Dhan candle response to list of dicts."""
    data = resp.get("data") or {}
    opens   = data.get("open",   [])
    highs   = data.get("high",   [])
    lows    = data.get("low",    [])
    closes  = data.get("close",  [])
    vols    = data.get("volume", [])
    times   = data.get("timestamp", data.get("start_Time", []))
    result  = []
    for i in range(len(closes)):
        try:
            ts_raw = times[i]
            if isinstance(ts_raw, str):
                ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
            else:
                ts = datetime.fromtimestamp(ts_raw)
            result.append({
                "ts": ts,
                "o":  float(opens[i]),
                "h":  float(highs[i]),
                "l":  float(lows[i]),
                "c":  float(closes[i]),
                "v":  int(vols[i]) if vols else 0,
            })
        except Exception:
            continue
    return result


class Backfiller:
    def __init__(self, storage: Storage):
        self._storage = storage
        self._ctx  = DhanContext(DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN)
        self._dhan = dhanhq(self._ctx)

    async def run_all(self):
        """Called once at startup; fills gaps for all indices."""
        print("[Backfill] Starting historical data backfill...")
        for idx in INDICES:
            await self._backfill_index(idx)
        print("[Backfill] Done.")

    async def _backfill_index(self, idx: dict):
        sec_id  = idx["id"]
        seg     = _to_dhan_seg(idx["segment"])
        name    = idx["name"]

        # --- Daily candles (2 years) ---
        count = await self._storage.get_candle_count(sec_id, "1d")
        if count < MIN_CANDLES:
            print(f"[Backfill] {name}: fetching {DAILY_YEARS}y daily candles...")
            from_d = (date.today() - timedelta(days=365 * DAILY_YEARS)).isoformat()
            to_d   = date.today().isoformat()
            try:
                resp = await asyncio.to_thread(
                    self._dhan.historical_daily_data,
                    security_id=str(sec_id),
                    exchange_segment=seg,
                    instrument_type=INSTRUMENT_TYPE,
                    from_date=from_d,
                    to_date=to_d,
                )
                candles = _candles_from_response(resp)
                await self._bulk_insert(sec_id, "1d", candles)
                print(f"[Backfill] {name}: inserted {len(candles)} daily candles")
            except Exception as e:
                print(f"[Backfill] {name} daily error: {e}")

        # --- Intraday candles (1m, 5m, 15m, 1h) for last N days ---
        for tf in ("1m", "5m", "15m", "1h"):
            count = await self._storage.get_candle_count(sec_id, tf)
            if count >= MIN_CANDLES:
                continue
            print(f"[Backfill] {name}: fetching {HISTORY_DAYS}d of {tf} candles...")
            # Dhan intraday allows max 90 days, fetch in 5-day chunks
            chunks = self._date_chunks(HISTORY_DAYS, chunk=5)
            total = 0
            for from_d, to_d in chunks:
                try:
                    resp = await asyncio.to_thread(
                        self._dhan.intraday_minute_data,
                        security_id=str(sec_id),
                        exchange_segment=seg,
                        instrument_type=INSTRUMENT_TYPE,
                        interval=DHAN_TF_MAP[tf],
                        from_date=from_d,
                        to_date=to_d,
                    )
                    candles = _candles_from_response(resp)
                    if candles:
                        await self._bulk_insert(sec_id, tf, candles)
                        total += len(candles)
                    await asyncio.sleep(0.3)  # rate-limit courtesy
                except Exception as e:
                    print(f"[Backfill] {name} {tf} chunk {from_d}→{to_d}: {e}")
            print(f"[Backfill] {name} {tf}: inserted {total} candles")

    async def _bulk_insert(self, sec_id: str, tf: str, candles: list):
        for c in candles:
            await self._storage.upsert_candle(
                sec_id, tf, c["ts"],
                c["o"], c["h"], c["l"], c["c"], c.get("v", 0)
            )

    @staticmethod
    def _date_chunks(total_days: int, chunk: int) -> list[tuple[str, str]]:
        chunks = []
        to = date.today()
        while total_days > 0:
            frm = to - timedelta(days=min(chunk, total_days))
            chunks.append((frm.isoformat(), to.isoformat()))
            to = frm - timedelta(days=1)
            total_days -= chunk
        return chunks
