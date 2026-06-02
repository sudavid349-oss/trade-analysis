/**
 * AlertsPanel — Two parts:
 *   1. Toast stack (top-right, auto-dismiss 8s)
 *   2. History tab (bottom panel, paginated list)
 *
 * Props:
 *   securityId  — current index
 *   wsAlerts    — array of alert objects pushed via WebSocket (managed in App)
 *   onClear     — callback to clear toast queue
 */
import { useState, useEffect, useRef } from "react";

const API = "http://localhost:8000";

const SEVERITY_COLOR = {
  info:     "#2962ff",
  warning:  "#f59e0b",
  critical: "#ef5350",
};

const SEVERITY_BG = {
  info:     "#2962ff18",
  warning:  "#f59e0b18",
  critical: "#ef535018",
};

const TYPE_ICON = {
  oi_surge:    "📈",
  oi_unwind:   "📉",
  pcr_extreme: "⚖️",
  iv_spike:    "🌡️",
};

// ── Toast stack (floating, top-right) ────────────────────────────────
export function AlertToasts({ alerts, onDismiss }) {
  return (
    <div style={{
      position: "fixed", top: 54, right: 12, zIndex: 1000,
      display: "flex", flexDirection: "column", gap: 6,
      maxWidth: 340, pointerEvents: "none",
    }}>
      {alerts.slice(-5).map(a => (
        <Toast key={a.id} alert={a} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ alert: a, onDismiss }) {
  const [visible, setVisible] = useState(true);
  const timer = useRef(null);

  useEffect(() => {
    timer.current = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(a.id), 300);
    }, 8000);
    return () => clearTimeout(timer.current);
  }, [a.id, onDismiss]);

  return (
    <div style={{
      background: SEVERITY_BG[a.severity] ?? "#1a1d2e",
      border: `1px solid ${SEVERITY_COLOR[a.severity] ?? "#2a2d3a"}`,
      borderLeft: `3px solid ${SEVERITY_COLOR[a.severity] ?? "#2a2d3a"}`,
      borderRadius: 6, padding: "8px 10px",
      pointerEvents: "all", cursor: "pointer",
      opacity: visible ? 1 : 0,
      transform: visible ? "translateX(0)" : "translateX(20px)",
      transition: "opacity 0.3s, transform 0.3s",
      backdropFilter: "blur(8px)",
    }}
      onClick={() => { setVisible(false); setTimeout(() => onDismiss(a.id), 300); }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <span style={{ fontSize: 14 }}>{TYPE_ICON[a.alert_type] ?? "🔔"}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: "#d1d4dc", lineHeight: 1.4 }}>{a.message}</div>
          <div style={{ fontSize: 9, color: "#444", marginTop: 2 }}>
            {new Date(a.ts).toLocaleTimeString()} · {a.severity}
          </div>
        </div>
      </div>
    </div>
  );
}


// ── History panel (in bottom drawer) ─────────────────────────────────
export default function AlertsPanel({ securityId }) {
  const [alerts, setAlerts]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter]   = useState("all");

  const load = async () => {
    if (!securityId) return;
    setLoading(true);
    try {
      const { alerts: data } = await fetch(
        `${API}/api/alerts/${securityId}?limit=100`
      ).then(r => r.json());
      setAlerts(data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [securityId]);

  const dismiss = async (id) => {
    await fetch(`${API}/api/alerts/${id}`, { method: "DELETE" });
    setAlerts(a => a.filter(x => x.id !== id));
  };

  const clearAll = async () => {
    await Promise.all(alerts.map(a => fetch(`${API}/api/alerts/${a.id}`, { method: "DELETE" })));
    setAlerts([]);
  };

  const filtered = filter === "all" ? alerts
    : alerts.filter(a => a.alert_type === filter || a.severity === filter);

  const counts = alerts.reduce((acc, a) => {
    acc[a.severity] = (acc[a.severity] || 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
                  background: "#0f1117", color: "#d1d4dc", padding: "10px 12px" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8,
                    marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#aaa" }}>
          ALERTS {alerts.length > 0 && (
            <span style={{ background: "#ef5350", color: "#fff",
                           borderRadius: 10, padding: "1px 6px", fontSize: 10, marginLeft: 4 }}>
              {alerts.length}
            </span>
          )}
        </span>

        {/* Severity filters */}
        {["all", "critical", "warning", "info"].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            style={{ padding: "2px 9px", border: "none", borderRadius: 4,
                     background: filter === s ? (SEVERITY_COLOR[s] ?? "#2a2d3a") : "#1e2130",
                     color: filter === s ? "#fff" : "#666",
                     fontSize: 10, cursor: "pointer" }}>
            {s === "all" ? `All (${alerts.length})` : `${s} (${counts[s] ?? 0})`}
          </button>
        ))}

        <button onClick={load}
          style={{ padding: "2px 8px", background: "#1e2130", color: "#666",
                   border: "none", borderRadius: 4, fontSize: 10, cursor: "pointer" }}>
          ↻
        </button>

        {alerts.length > 0 && (
          <button onClick={clearAll}
            style={{ marginLeft: "auto", padding: "2px 8px", background: "transparent",
                     color: "#ef5350", border: "1px solid #ef535044",
                     borderRadius: 4, fontSize: 10, cursor: "pointer" }}>
            Clear all
          </button>
        )}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        {loading && (
          <div style={{ textAlign: "center", color: "#444", padding: 20, fontSize: 12 }}>
            Loading…
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: "center", color: "#333", padding: 30, fontSize: 12 }}>
            No alerts yet. Alerts fire when OI surges, unwinds, or PCR hits extremes.
          </div>
        )}
        {filtered.map(a => (
          <div key={a.id} style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            background: SEVERITY_BG[a.severity],
            border: `1px solid ${SEVERITY_COLOR[a.severity]}22`,
            borderLeft: `2px solid ${SEVERITY_COLOR[a.severity]}`,
            borderRadius: 5, padding: "7px 10px",
          }}>
            <span style={{ fontSize: 14, flexShrink: 0 }}>{TYPE_ICON[a.alert_type] ?? "🔔"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "#d1d4dc", lineHeight: 1.4 }}>{a.message}</div>
              <div style={{ fontSize: 9, color: "#555", marginTop: 2 }}>
                {new Date(a.ts).toLocaleString("en-IN")}
                {a.strike && ` · Strike ${Number(a.strike).toLocaleString("en-IN")}`}
                {a.opt_type && ` ${a.opt_type}`}
              </div>
            </div>
            <button onClick={() => dismiss(a.id)}
              style={{ background: "transparent", border: "none",
                       color: "#444", cursor: "pointer", fontSize: 14, flexShrink: 0 }}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}