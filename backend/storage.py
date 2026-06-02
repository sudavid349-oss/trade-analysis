"""
TimescaleDB storage layer.
Tables: ticks, candles, option_chain_snapshots
"""
import asyncpg
from datetime import datetime, date, timedelta, timezone
from typing import Optional
from config import TICK_RETENTION_DAYS, CANDLE_1M_RETENTION_DAYS, OC_SNAPSHOT_RETENTION_DAYS


def _to_utc_ms(ts) -> int:
    """Convert a DB timestamp to UTC milliseconds safely."""
    if ts is None:
        return 0
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return int(ts.timestamp() * 1000)


SCHEMA = """
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS ticks (
    ts          TIMESTAMPTZ NOT NULL,
    security_id TEXT        NOT NULL,
    ltp         NUMERIC     NOT NULL,
    volume      BIGINT,
    oi          BIGINT
);

SELECT create_hypertable('ticks','ts', if_not_exists => TRUE);

ALTER TABLE ticks SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'ts DESC',
    timescaledb.compress_segmentby = 'security_id'
);

SELECT add_compression_policy('ticks',
    compress_after => INTERVAL '3 days',
    if_not_exists  => TRUE);

CREATE TABLE IF NOT EXISTS candles (
    ts          TIMESTAMPTZ NOT NULL,
    security_id TEXT        NOT NULL,
    tf          TEXT        NOT NULL,
    open        NUMERIC     NOT NULL,
    high        NUMERIC     NOT NULL,
    low         NUMERIC     NOT NULL,
    close       NUMERIC     NOT NULL,
    volume      BIGINT      DEFAULT 0,
    PRIMARY KEY (security_id, tf, ts)
);

SELECT create_hypertable('candles','ts',
    partitioning_column => 'security_id',
    number_partitions   => 4,
    if_not_exists       => TRUE);

CREATE TABLE IF NOT EXISTS option_chain_snapshots (
    ts          TIMESTAMPTZ NOT NULL,
    security_id TEXT        NOT NULL,
    expiry      DATE        NOT NULL,
    strike      NUMERIC     NOT NULL,
    opt_type    TEXT        NOT NULL,
    ltp         NUMERIC,
    oi          BIGINT,
    volume      BIGINT,
    iv          NUMERIC,
    delta       NUMERIC,
    gamma       NUMERIC,
    theta       NUMERIC,
    vega        NUMERIC,
    bid         NUMERIC,
    ask         NUMERIC
);

SELECT create_hypertable('option_chain_snapshots','ts', if_not_exists => TRUE);

ALTER TABLE option_chain_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'ts DESC',
    timescaledb.compress_segmentby = 'security_id'
);

SELECT add_compression_policy('option_chain_snapshots',
    compress_after => INTERVAL '3 days',
    if_not_exists  => TRUE);
"""


class Storage:
    def __init__(self, db_url: str):
        self._url = db_url
        self._pool: asyncpg.Pool = None

    async def init(self):
        self._pool = await asyncpg.create_pool(self._url, min_size=2, max_size=10)
        async with self._pool.acquire() as conn:
            await conn.execute(SCHEMA)
        await self._schedule_cleanup()

    async def close(self):
        if self._pool:
            await self._pool.close()

    async def insert_tick(self, security_id: str, ts: datetime, ltp: float,
                          volume: int = None, oi: int = None):
        async with self._pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO ticks(ts,security_id,ltp,volume,oi) VALUES($1,$2,$3,$4,$5)",
                ts, security_id, ltp, volume, oi
            )

    async def upsert_candle(self, security_id: str, tf: str, ts: datetime,
                             o, h, l, c, vol=0):
        async with self._pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO candles(ts,security_id,tf,open,high,low,close,volume)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8)
                ON CONFLICT(security_id,tf,ts) DO UPDATE
                  SET high=GREATEST(candles.high,EXCLUDED.high),
                      low =LEAST(candles.low,EXCLUDED.low),
                      close=EXCLUDED.close,
                      volume=candles.volume+EXCLUDED.volume
            """, ts, security_id, tf, o, h, l, c, vol)

    async def get_candles(self, security_id: str, tf: str,
                           from_date=None, to_date=None, limit=500):
        q = """SELECT ts,open,high,low,close,volume FROM candles
               WHERE security_id=$1 AND tf=$2 {where}
               ORDER BY ts DESC LIMIT $3"""
        args = [security_id, tf, limit]
        where = ""
        if from_date:
            args.append(datetime.combine(from_date, datetime.min.time()))
            where += f" AND ts >= ${len(args)}"
        if to_date:
            args.append(datetime.combine(to_date, datetime.max.time()))
            where += f" AND ts <= ${len(args)}"
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(q.format(where=where), *args)
        return [{"t": _to_utc_ms(r["ts"]),
                 "o": float(r["open"]), "h": float(r["high"]),
                 "l": float(r["low"]),  "c": float(r["close"]),
                 "v": r["volume"]} for r in reversed(rows)]

    async def get_ticks(self, security_id: str, from_ts=None, to_ts=None, limit=5000):
        q = "SELECT ts,ltp,volume,oi FROM ticks WHERE security_id=$1 {where} ORDER BY ts ASC LIMIT $2"
        args = [security_id, limit]
        where = ""
        if from_ts:
            args.append(from_ts)
            where += f" AND ts >= ${len(args)}"
        if to_ts:
            args.append(to_ts)
            where += f" AND ts <= ${len(args)}"
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(q.format(where=where), *args)
        return [{"t": _to_utc_ms(r["ts"]), "ltp": float(r["ltp"]),
                 "v": r["volume"], "oi": r["oi"]} for r in rows]

    async def count_ticks(self, security_id: str, session_date: date) -> int:
        start = datetime.combine(session_date, datetime.min.time())
        end   = datetime.combine(session_date, datetime.max.time())
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT COUNT(*) AS n FROM ticks WHERE security_id=$1 AND ts BETWEEN $2 AND $3",
                security_id, start, end
            )
        return row["n"]

    async def insert_oc_snapshot(self, security_id: str, ts: datetime,
                                  expiry: date, strikes: list):
        async with self._pool.acquire() as conn:
            await conn.executemany("""
                INSERT INTO option_chain_snapshots
                  (ts,security_id,expiry,strike,opt_type,ltp,oi,volume,iv,delta,gamma,theta,vega,bid,ask)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            """, [(ts, security_id, expiry,
                   s["strike"], s["opt_type"],
                   s.get("ltp"), s.get("oi"), s.get("volume"),
                   s.get("iv"), s.get("delta"), s.get("gamma"),
                   s.get("theta"), s.get("vega"),
                   s.get("bid"), s.get("ask")) for s in strikes])

    async def get_latest_option_chain(self, security_id: str, expiry=None):
        q = """SELECT DISTINCT ON (strike, opt_type)
                 ts,strike,opt_type,ltp,oi,volume,iv,delta,gamma,theta,vega,bid,ask
               FROM option_chain_snapshots
               WHERE security_id=$1 {expiry_filter}
               ORDER BY strike ASC, opt_type ASC, ts DESC"""
        args = [security_id]
        expiry_filter = ""
        if expiry:
            args.append(expiry)
            expiry_filter = f"AND expiry=$2"
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(q.format(expiry_filter=expiry_filter), *args)
        return [dict(r) for r in rows]

    async def get_strike_history(self, security_id: str, strike: float,
                                  opt_type: str, expiry=None, limit=100):
        q = """SELECT ts, oi, iv, ltp, volume FROM option_chain_snapshots
               WHERE security_id=$1 AND strike=$2 AND opt_type=$3 {ef}
               ORDER BY ts DESC LIMIT $4"""
        args = [security_id, strike, opt_type, limit]
        ef = ""
        if expiry:
            args.append(date.fromisoformat(expiry))
            ef = f"AND expiry=${len(args)}"
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(q.format(ef=ef), *args)
        return [{"t": _to_utc_ms(r["ts"]),
                 "oi": r["oi"], "iv": float(r["iv"] or 0),
                 "ltp": float(r["ltp"] or 0), "v": r["volume"]}
                for r in reversed(rows)]

    async def get_candle_count(self, security_id: str, tf: str) -> int:
        async with self._pool.acquire() as conn:
            return await conn.fetchval(
                "SELECT COUNT(*) FROM candles WHERE security_id=$1 AND tf=$2",
                security_id, tf
            )

    async def get_available_expiries(self, security_id: str) -> list[str]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT DISTINCT expiry FROM option_chain_snapshots
                   WHERE security_id=$1 ORDER BY expiry ASC""",
                security_id
            )
        return [str(r["expiry"]) for r in rows]

    async def get_archived_options(self, security_id: str, expiry: str,
                                    trade_date=None) -> list[dict]:
        q = """SELECT strike, opt_type, open, high, low, close, volume, oi, trade_date
               FROM expired_options_archive
               WHERE security_id=$1 AND expiry=$2 {td}
               ORDER BY strike ASC, opt_type ASC"""
        args = [security_id, date.fromisoformat(expiry)]
        td = ""
        if trade_date:
            args.append(trade_date)
            td = f"AND trade_date=$3"
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(q.format(td=td), *args)
        return [dict(r) for r in rows]

    async def get_stats(self):
        async with self._pool.acquire() as conn:
            ticks   = await conn.fetchval("SELECT COUNT(*) FROM ticks")
            candles = await conn.fetchval("SELECT COUNT(*) FROM candles")
            oc      = await conn.fetchval("SELECT COUNT(*) FROM option_chain_snapshots")
            try:
                archive = await conn.fetchval("SELECT COUNT(*) FROM expired_options_archive")
            except Exception:
                archive = 0
        return {
            "ticks": ticks,
            "candles": candles,
            "option_chain_snapshots": oc,
            "expired_options_archive": archive,
        }

    async def _schedule_cleanup(self):
        import asyncio

        async def loop():
            while True:
                await asyncio.sleep(86400)
                async with self._pool.acquire() as conn:
                    await conn.execute(
                        "DELETE FROM ticks WHERE ts < NOW() - INTERVAL $1",
                        f"{TICK_RETENTION_DAYS} days"
                    )
                    await conn.execute(
                        "DELETE FROM candles WHERE tf='1m' AND ts < NOW() - INTERVAL $1",
                        f"{CANDLE_1M_RETENTION_DAYS} days"
                    )
                    await conn.execute(
                        "DELETE FROM option_chain_snapshots WHERE ts < NOW() - INTERVAL $1",
                        f"{OC_SNAPSHOT_RETENTION_DAYS} days"
                    )
        asyncio.create_task(loop())
