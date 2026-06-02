"""
DhanChart Backend v3 — adds alert monitor + alert API routes.
Replace main.py v2 with this file.
"""
import asyncio
from datetime import datetime, date
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware

from config import DB_URL, INDICES
from storage import Storage
from dhan_feed import DhanFeedManager
from aggregator import CandleAggregator
from backfill import Backfiller
from eod_archiver import EODArchiver
from option_chain import OptionChainScheduler
from alerts import AlertMonitor
from token_refresh import token_refresh_loop

storage:    Storage           = None
feed_mgr:   DhanFeedManager   = None
aggregator: CandleAggregator  = None
alert_mon:  AlertMonitor      = None
ws_clients: set[WebSocket]    = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global storage, feed_mgr, aggregator, alert_mon

    storage    = Storage(DB_URL)
    await storage.init()

    alert_mon  = AlertMonitor(storage, broadcast)
    await alert_mon.init()

    aggregator = CandleAggregator(storage, broadcast)
    feed_mgr   = DhanFeedManager(aggregator)

    asyncio.create_task(Backfiller(storage).run_all())
    asyncio.create_task(EODArchiver(storage).run_loop())

    # Pass alert_mon into OC scheduler so it checks after each snapshot
    asyncio.create_task(OptionChainScheduler(storage, alert_mon).run())
    asyncio.create_task(feed_mgr.start())

    yield
    await feed_mgr.stop()
    await storage.close()


app = FastAPI(title="DhanChart API v3", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


async def broadcast(msg: dict):
    dead = set()
    for ws in ws_clients:
        try:
            await ws.send_json(msg)
        except Exception:
            dead.add(ws)
    ws_clients.difference_update(dead)


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        ws_clients.discard(ws)


# ── Index / candle / replay (unchanged from v2) ─────────────────────

@app.get("/api/indices")
async def get_indices():
    return INDICES


@app.get("/api/candles/{security_id}")
async def get_candles(
    security_id: str,
    tf: str = Query("1m", pattern="^(1m|5m|15m|1h|1d)$"),
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    limit: int = Query(500, le=5000),
):
    return {"security_id": security_id, "tf": tf,
            "candles": await storage.get_candles(security_id, tf, from_date, to_date, limit)}


@app.get("/api/ticks/{security_id}")
async def get_ticks(
    security_id: str,
    from_ts: Optional[datetime] = None,
    to_ts: Optional[datetime] = None,
    limit: int = Query(5000, le=50000),
):
    ticks = await storage.get_ticks(security_id, from_ts, to_ts, limit)
    return {"security_id": security_id, "has_data": bool(ticks), "ticks": ticks}


@app.get("/api/replay/{security_id}")
async def replay_info(security_id: str, session_date: date = None):
    if not session_date:
        session_date = date.today()
    count = await storage.count_ticks(security_id, session_date)
    return {"security_id": security_id, "date": str(session_date),
            "tick_count": count, "replay_possible": count > 0, "candle_only": count == 0}


# ── Option chain ────────────────────────────────────────────────────

@app.get("/api/option-chain/{security_id}")
async def get_oc(security_id: str, expiry: Optional[str] = None):
    return {"security_id": security_id, "expiry": expiry,
            "data": await storage.get_latest_option_chain(security_id, expiry)}


@app.get("/api/option-chain/{security_id}/expiries")
async def get_expiries(security_id: str):
    return {"security_id": security_id,
            "expiries": await storage.get_available_expiries(security_id)}


@app.get("/api/option-chain/{security_id}/history")
async def get_oc_history(
    security_id: str,
    strike: float,
    opt_type: str = Query(..., pattern="^(CE|PE)$"),
    expiry: Optional[str] = None,
    limit: int = Query(100, le=500),
):
    """OI + IV time-series for a single strike — used by OI change chart."""
    rows = await storage.get_strike_history(security_id, strike, opt_type, expiry, limit)
    return {"data": rows}


# ── Alerts ──────────────────────────────────────────────────────────

@app.get("/api/alerts/{security_id}")
async def get_alerts(security_id: str, limit: int = Query(50, le=200)):
    return {"alerts": await alert_mon.get_recent(security_id, limit)}


@app.delete("/api/alerts/{alert_id}")
async def dismiss_alert(alert_id: int):
    async with storage._pool.acquire() as conn:
        await conn.execute("DELETE FROM alerts WHERE id=$1", alert_id)
    return {"deleted": alert_id}


# ── Storage stats ───────────────────────────────────────────────────

@app.get("/api/storage/stats")
async def storage_stats():
    return await storage.get_stats()
