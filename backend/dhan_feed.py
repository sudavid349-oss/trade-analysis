"""
Dhan MarketFeed WebSocket manager.
Subscribes to live ticks for all configured indices and passes them to the aggregator.
"""
import asyncio
import threading
import time
from datetime import datetime, timezone, timedelta

from dhanhq import DhanContext, MarketFeed
from config import DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN, INDICES, SEGMENT_MAP
from aggregator import CandleAggregator

IST = timezone(timedelta(hours=5, minutes=30))


class DhanFeedManager:
    def __init__(self, aggregator: CandleAggregator):
        self._agg     = aggregator
        self._running = False
        self._thread  = None
        self._loop    = None
        self._feed    = None

    async def start(self):
        self._running = True
        self._loop    = asyncio.get_event_loop()
        self._thread  = threading.Thread(target=self._run_feed, daemon=True)
        self._thread.start()

    async def stop(self):
        self._running = False
        if self._feed:
            try:
                self._feed.disconnect()
            except Exception:
                pass

    def _run_feed(self):
        """Runs in a background thread — dhanhq MarketFeed is sync."""
        ctx         = DhanContext(DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN)
        instruments = []
        for idx in INDICES:
            seg_code = SEGMENT_MAP.get(idx["segment"], 13)
            # security_id must be int for MarketFeed
            instruments.append((seg_code, int(idx["id"]), MarketFeed.Ticker))

        print(f"[DhanFeed] Instruments: {instruments}")

        while self._running:
            try:
                print("[DhanFeed] Connecting...")
                self._feed = MarketFeed(ctx, instruments, version="v2")
                self._feed.run_forever()
                print("[DhanFeed] Connected! Waiting for ticks...")

                while self._running:
                    data = self._feed.get_data()
                    if data:
                        print(f"[DhanFeed] Tick: {data}")
                        self._handle_tick(data)

            except Exception as e:
                print(f"[DhanFeed] Error: {e}. Reconnecting in 5s...")
                time.sleep(5)

    def _handle_tick(self, data: dict):
        """Called from feed thread — dispatches to async aggregator safely."""
        try:
            sec_id = str(data.get("security_id") or data.get("securityId", ""))
            ltp    = float(data.get("LTP") or data.get("ltp", 0))
            vol    = data.get("volume", None)
            oi     = data.get("OI") or data.get("oi", None)
            ts     = datetime.now(IST)
            if sec_id and ltp:
                asyncio.run_coroutine_threadsafe(
                    self._agg.on_tick(sec_id, ts, ltp, vol, oi),
                    self._loop
                )
        except Exception as e:
            print(f"[DhanFeed] Tick parse error: {e} | raw: {data}")
