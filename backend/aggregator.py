"""
Real-time tick → OHLCV candle aggregator.
Supports multiple timeframes: 1m, 5m, 15m, 1h, 1d.
Broadcasts live ticks and completed candles to connected WebSocket clients.
Saves ticks to CSV for MetaTrader.
"""
import asyncio
import csv
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from pathlib import Path
from typing import Callable, Awaitable

TF_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400}
IST = timezone(timedelta(hours=5, minutes=30))

# CSV storage path
TICK_CSV_ROOT = Path("/root/tick_data")
CSV_HEADERS   = ["timestamp", "security_id", "index_name", "last_price"]

SECURITY_NAMES = {
    "13": "nifty_50",
    "25": "bank_nifty",
    "51": "sensex",
}


def _get_csv_file(security_id: str) -> Path:
    now        = datetime.now(IST)
    index_name = SECURITY_NAMES.get(security_id, security_id)
    folder     = TICK_CSV_ROOT / index_name / f"{now.year}" / f"{now.month:02d}" / f"{now.day:02d}"
    folder.mkdir(parents=True, exist_ok=True)
    csv_file   = folder / "live_ticks.csv"
    if not csv_file.exists():
        with open(csv_file, "w", newline="") as f:
            csv.writer(f).writerow(CSV_HEADERS)
    return csv_file


def _save_tick_csv(security_id: str, ts: datetime, ltp: float):
    """Save tick to CSV file for MetaTrader."""
    try:
        index_name = SECURITY_NAMES.get(security_id, security_id)
        csv_file   = _get_csv_file(security_id)
        timestamp  = ts.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        with open(csv_file, "a", newline="") as f:
            csv.writer(f).writerow([timestamp, security_id, index_name, ltp])
    except Exception as e:
        print(f"[CSV] Error saving tick: {e}")


def _cleanup_old_csvs(days: int = 7):
    """Delete CSV files older than N days."""
    try:
        cutoff  = datetime.now(IST) - timedelta(days=days)
        deleted = 0
        for csv_file in TICK_CSV_ROOT.rglob("*.csv"):
            if datetime.fromtimestamp(csv_file.stat().st_mtime, tz=IST) < cutoff:
                csv_file.unlink()
                deleted += 1
        if deleted:
            print(f"[CSV] Cleaned up {deleted} old CSV files")
    except Exception as e:
        print(f"[CSV] Cleanup error: {e}")


def floor_ts(ts: datetime, tf: str) -> datetime:
    """Floor a timestamp to the start of a candle bucket in IST."""
    secs    = TF_SECONDS[tf]
    ts_ist  = ts.astimezone(IST)
    epoch   = int(ts_ist.timestamp())
    floored = (epoch // secs) * secs
    return datetime.fromtimestamp(floored, tz=IST)


class Candle:
    __slots__ = ("ts", "o", "h", "l", "c", "v")

    def __init__(self, ts, price, volume=0):
        self.ts = ts
        self.o  = price
        self.h  = price
        self.l  = price
        self.c  = price
        self.v  = volume or 0

    def update(self, price, volume=0):
        self.h  = max(self.h, price)
        self.l  = min(self.l, price)
        self.c  = price
        self.v += (volume or 0)

    def to_dict(self):
        return {
            "t": int(self.ts.timestamp() * 1000),
            "o": self.o, "h": self.h, "l": self.l, "c": self.c, "v": self.v,
        }


class CandleAggregator:
    def __init__(self, storage, broadcast: Callable[[dict], Awaitable]):
        self._storage   = storage
        self._broadcast = broadcast
        self._candles: dict[str, dict[str, Candle]] = defaultdict(dict)
        self._last_cleanup_date = None

    async def on_tick(self, security_id: str, ts: datetime, ltp: float,
                      volume: int = None, oi: int = None):

        # 1. Persist tick to DB
        await self._storage.insert_tick(security_id, ts, ltp, volume, oi)

        # 2. Save tick to CSV for MetaTrader
        _save_tick_csv(security_id, ts, ltp)

        # 3. Run daily cleanup once per day
        today = ts.astimezone(IST).date()
        if self._last_cleanup_date != today:
            self._last_cleanup_date = today
            _cleanup_old_csvs(days=7)

        # 4. Broadcast raw tick to UI
        await self._broadcast({
            "type": "tick",
            "id": security_id,
            "t": int(ts.timestamp() * 1000),
            "ltp": ltp,
        })

        # 5. Update all timeframes
        for tf in TF_SECONDS:
            bucket   = floor_ts(ts, tf)
            existing = self._candles[security_id].get(tf)

            if existing is None:
                c = Candle(bucket, ltp, volume)
                self._candles[security_id][tf] = c
                await self._upsert_and_broadcast(security_id, tf, c, closed=False)

            elif existing.ts == bucket:
                existing.update(ltp, volume)
                await self._upsert_and_broadcast(security_id, tf, existing, closed=False)

            else:
                await self._upsert_and_broadcast(security_id, tf, existing, closed=True)
                c = Candle(bucket, ltp, volume)
                self._candles[security_id][tf] = c
                await self._upsert_and_broadcast(security_id, tf, c, closed=False)

    async def _upsert_and_broadcast(self, security_id: str, tf: str,
                                     candle: Candle, closed: bool):
        await self._storage.upsert_candle(
            security_id, tf, candle.ts,
            candle.o, candle.h, candle.l, candle.c, candle.v
        )
        await self._broadcast({
            "type": "candle",
            "id": security_id,
            "tf": tf,
            "closed": closed,
            **candle.to_dict(),
        })
