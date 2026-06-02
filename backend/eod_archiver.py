"""
EOD Archiver — runs after market close (15:35 IST) every trading day.
1. Fetches full-day candle from Dhan and upserts into candles table (1d).
2. Fetches expired options OHLCV via expired_options_data() and stores permanently.
3. Compresses old intraday option chain snapshots (handled by TimescaleDB policy,
   but we also archive today's OC to a compact daily summary table).
"""
import asyncio
from datetime import date, datetime, timedelta, time as dtime
from dhanhq import DhanContext, dhanhq
from config import (
    DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN,
    INDICES, SEGMENT_MAP,
)
from storage import Storage

# Runs daily at this IST time
EOD_RUN_TIME = dtime(15, 35)

EXPIRY_ARCHIVE_SCHEMA = """
CREATE TABLE IF NOT EXISTS expired_options_archive (
    expiry      DATE        NOT NULL,
    trade_date  DATE        NOT NULL,
    security_id TEXT        NOT NULL,
    strike      NUMERIC     NOT NULL,
    opt_type    TEXT        NOT NULL,
    open        NUMERIC,
    high        NUMERIC,
    low         NUMERIC,
    close       NUMERIC,
    volume      BIGINT,
    oi          BIGINT,
    PRIMARY KEY (expiry, trade_date, security_id, strike, opt_type)
);
"""


def _to_dhan_seg(segment: str) -> str:
    return {"IDX_I": "IDX_I", "BSE_I": "IDX_I"}.get(segment, "IDX_I")


def _seconds_until(target: dtime) -> float:
    now = datetime.now()
    t   = datetime.combine(now.date(), target)
    if t <= now:
        t += timedelta(days=1)
    return (t - now).total_seconds()


class EODArchiver:
    def __init__(self, storage: Storage):
        self._storage = storage
        self._ctx  = DhanContext(DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN)
        self._dhan = dhanhq(self._ctx)

    async def init_schema(self):
        async with self._storage._pool.acquire() as conn:
            await conn.execute(EXPIRY_ARCHIVE_SCHEMA)

    async def run_loop(self):
        """Waits until EOD_RUN_TIME each day, then archives."""
        await self.init_schema()
        while True:
            wait = _seconds_until(EOD_RUN_TIME)
            print(f"[EOD] Next archive run in {wait/3600:.1f}h")
            await asyncio.sleep(wait)
            today = date.today()
            # Skip weekends
            if today.weekday() >= 5:
                continue
            await self._run(today)

    async def _run(self, trade_date: date):
        print(f"[EOD] Running archival for {trade_date}")
        for idx in INDICES:
            try:
                await self._archive_index(idx, trade_date)
            except Exception as e:
                print(f"[EOD] Error archiving {idx['name']}: {e}")

    async def _archive_index(self, idx: dict, trade_date: date):
        sec_id = idx["id"]
        seg    = _to_dhan_seg(idx["segment"])
        name   = idx["name"]

        # 1. Upsert today's daily candle
        try:
            resp = await asyncio.to_thread(
                self._dhan.historical_daily_data,
                security_id=str(sec_id),
                exchange_segment=seg,
                instrument_type="INDEX",
                from_date=trade_date.isoformat(),
                to_date=trade_date.isoformat(),
            )
            data = resp.get("data", {})
            if data.get("close"):
                ts = datetime.combine(trade_date, dtime(15, 30))
                await self._storage.upsert_candle(
                    sec_id, "1d", ts,
                    float(data["open"][0]),
                    float(data["high"][0]),
                    float(data["low"][0]),
                    float(data["close"][0]),
                    int(data.get("volume", [0])[0]),
                )
                print(f"[EOD] {name}: daily candle saved")
        except Exception as e:
            print(f"[EOD] {name} daily candle error: {e}")

        # 2. Archive expired options OHLCV
        try:
            # Get expiry list — any that expired today
            exp_resp = await asyncio.to_thread(
                self._dhan.expiry_list,
                under_security_id=int(sec_id),
                under_exchange_segment=seg,
            )
            expiries = exp_resp.get("data", [])
            expired_today = [e for e in expiries if e == trade_date.isoformat()]

            for expiry_str in expired_today:
                await self._archive_expired_options(sec_id, seg, expiry_str, trade_date)
        except Exception as e:
            print(f"[EOD] {name} expired options error: {e}")

    async def _archive_expired_options(self, sec_id: str, seg: str,
                                        expiry_str: str, trade_date: date):
        try:
            resp = await asyncio.to_thread(
                self._dhan.expired_options_data,
                security_id=str(sec_id),
                exchange_segment=seg,
                expiry=expiry_str,
            )
            rows = resp.get("data") or []
            if not rows:
                return

            records = []
            for r in rows:
                records.append((
                    date.fromisoformat(expiry_str),
                    trade_date,
                    sec_id,
                    float(r.get("strike", 0)),
                    r.get("optionType", "CE"),
                    r.get("open"), r.get("high"), r.get("low"), r.get("close"),
                    r.get("volume"), r.get("openInterest"),
                ))

            async with self._storage._pool.acquire() as conn:
                await conn.executemany("""
                    INSERT INTO expired_options_archive
                      (expiry,trade_date,security_id,strike,opt_type,
                       open,high,low,close,volume,oi)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    ON CONFLICT DO NOTHING
                """, records)
            print(f"[EOD] Archived {len(records)} expired option rows for expiry {expiry_str}")
        except Exception as e:
            print(f"[EOD] Expired options archive error: {e}")
