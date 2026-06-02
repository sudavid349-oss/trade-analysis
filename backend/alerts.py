"""
OI Buildup Alert Monitor
Runs every OC snapshot cycle, compares latest OC snapshot to previous,
detects surges/unwinds/PCR extremes and pushes alerts over WebSocket.

Alert types:
  oi_surge    — OI jumped > OI_SURGE_PCT% at a strike/type
  oi_unwind   — OI dropped > OI_UNWIND_PCT%
  pcr_extreme — PCR crossed HIGH_PCR or LOW_PCR threshold
  iv_spike    — IV jumped > IV_SPIKE_PCT% at a strike
"""
import asyncio
from datetime import datetime
from typing import Callable, Awaitable

from storage import Storage

# ── Thresholds (tune to taste) ──────────────────────────────────────
OI_SURGE_PCT   = 15.0   # % increase in OI to trigger surge alert
OI_UNWIND_PCT  = 12.0   # % decrease in OI to trigger unwind alert
HIGH_PCR       = 1.6    # PCR above this → bullish extreme
LOW_PCR        = 0.5    # PCR below this → bearish extreme
IV_SPIKE_PCT   = 20.0   # % IV jump to alert

# ── DB schema ───────────────────────────────────────────────────────
ALERT_SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts (
    id          BIGSERIAL   PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    security_id TEXT        NOT NULL,
    alert_type  TEXT        NOT NULL,
    severity    TEXT        NOT NULL,   -- info | warning | critical
    strike      NUMERIC,
    opt_type    TEXT,
    message     TEXT        NOT NULL,
    data        JSONB
);
CREATE INDEX IF NOT EXISTS alerts_ts_idx ON alerts(ts DESC);
CREATE INDEX IF NOT EXISTS alerts_sec_idx ON alerts(security_id, ts DESC);
"""


class AlertMonitor:
    def __init__(self, storage: Storage, broadcast: Callable[[dict], Awaitable]):
        self._storage   = storage
        self._broadcast = broadcast
        # last snapshot cache: {security_id: {(strike, opt_type): row_dict}}
        self._prev: dict[str, dict] = {}

    async def init(self):
        async with self._storage._pool.acquire() as conn:
            await conn.execute(ALERT_SCHEMA)

    async def check(self, security_id: str):
        """Called after each OC snapshot is saved."""
        rows = await self._storage.get_latest_option_chain(security_id)
        if not rows:
            return

        curr = {(float(r["strike"]), r["opt_type"]): r for r in rows}
        prev = self._prev.get(security_id, {})

        alerts = []

        # ── Per-strike checks ──────────────────────────────────────
        for (strike, opt_type), row in curr.items():
            prev_row = prev.get((strike, opt_type))
            if not prev_row:
                continue

            cur_oi  = float(row.get("oi") or 0)
            prev_oi = float(prev_row.get("oi") or 0)
            cur_iv  = float(row.get("iv") or 0)
            prev_iv = float(prev_row.get("iv") or 0)

            if prev_oi > 0 and cur_oi > 0:
                pct_chg = ((cur_oi - prev_oi) / prev_oi) * 100
                if pct_chg >= OI_SURGE_PCT:
                    alerts.append({
                        "security_id": security_id,
                        "alert_type": "oi_surge",
                        "severity": "warning" if pct_chg < 30 else "critical",
                        "strike": strike, "opt_type": opt_type,
                        "message": (f"{opt_type} {int(strike):,}: OI surged "
                                    f"+{pct_chg:.1f}% ({_fmt_oi(prev_oi)} → {_fmt_oi(cur_oi)})"),
                        "data": {"prev_oi": prev_oi, "cur_oi": cur_oi, "pct": pct_chg},
                    })
                elif pct_chg <= -OI_UNWIND_PCT:
                    alerts.append({
                        "security_id": security_id,
                        "alert_type": "oi_unwind",
                        "severity": "info",
                        "strike": strike, "opt_type": opt_type,
                        "message": (f"{opt_type} {int(strike):,}: OI unwinding "
                                    f"{pct_chg:.1f}% ({_fmt_oi(prev_oi)} → {_fmt_oi(cur_oi)})"),
                        "data": {"prev_oi": prev_oi, "cur_oi": cur_oi, "pct": pct_chg},
                    })

            if prev_iv > 0 and cur_iv > 0:
                iv_chg = ((cur_iv - prev_iv) / prev_iv) * 100
                if iv_chg >= IV_SPIKE_PCT:
                    alerts.append({
                        "security_id": security_id,
                        "alert_type": "iv_spike",
                        "severity": "warning",
                        "strike": strike, "opt_type": opt_type,
                        "message": (f"{opt_type} {int(strike):,}: IV spiked "
                                    f"+{iv_chg:.1f}% ({prev_iv:.1f}% → {cur_iv:.1f}%)"),
                        "data": {"prev_iv": prev_iv, "cur_iv": cur_iv, "pct": iv_chg},
                    })

        # ── PCR check ─────────────────────────────────────────────
        ce_oi = sum(float(r.get("oi") or 0) for r in curr.values() if r["opt_type"] == "CE")
        pe_oi = sum(float(r.get("oi") or 0) for r in curr.values() if r["opt_type"] == "PE")
        if ce_oi > 0:
            pcr = pe_oi / ce_oi
            if pcr >= HIGH_PCR:
                alerts.append({
                    "security_id": security_id,
                    "alert_type": "pcr_extreme",
                    "severity": "info",
                    "strike": None, "opt_type": None,
                    "message": f"PCR reached {pcr:.2f} — strong put buildup (bullish signal)",
                    "data": {"pcr": pcr, "ce_oi": ce_oi, "pe_oi": pe_oi},
                })
            elif pcr <= LOW_PCR:
                alerts.append({
                    "security_id": security_id,
                    "alert_type": "pcr_extreme",
                    "severity": "info",
                    "strike": None, "opt_type": None,
                    "message": f"PCR dropped to {pcr:.2f} — heavy call writing (bearish signal)",
                    "data": {"pcr": pcr, "ce_oi": ce_oi, "pe_oi": pe_oi},
                })

        # ── Persist + broadcast ────────────────────────────────────
        import json
        for a in alerts:
            async with self._storage._pool.acquire() as conn:
                row_id = await conn.fetchval("""
                    INSERT INTO alerts(security_id,alert_type,severity,strike,opt_type,message,data)
                    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id
                """, a["security_id"], a["alert_type"], a["severity"],
                    a["strike"], a["opt_type"], a["message"],
                    json.dumps(a.get("data") or {}))
            await self._broadcast({
                "type": "alert",
                "id": row_id,
                **{k: v for k, v in a.items() if k != "data"},
                "ts": datetime.now().isoformat(),
            })

        self._prev[security_id] = curr

    async def get_recent(self, security_id: str, limit: int = 50) -> list:
        async with self._storage._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT id,ts,alert_type,severity,strike,opt_type,message,data
                FROM alerts WHERE security_id=$1 ORDER BY ts DESC LIMIT $2
            """, security_id, limit)
        result = []
        for r in rows:
            row = dict(r)
            # asyncpg may return JSONB as str or dict depending on version — normalise to dict
            if isinstance(row.get("data"), str):
                try:
                    import json
                    row["data"] = json.loads(row["data"])
                except Exception:
                    row["data"] = {}
            elif row.get("data") is None:
                row["data"] = {}
            # serialise ts to ISO string for JSON response
            if hasattr(row.get("ts"), "isoformat"):
                row["ts"] = row["ts"].isoformat()
            result.append(row)
        return result


def _fmt_oi(n: float) -> str:
    if n >= 1_00_00_000: return f"{n/1_00_00_000:.1f}Cr"
    if n >= 1_00_000:    return f"{n/1_00_000:.1f}L"
    return f"{int(n):,}"
