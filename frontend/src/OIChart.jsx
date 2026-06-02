/**
 * OIChart — Multi-strike OI bar chart (CE vs PE) + OI delta from prev snapshot
 * Uses recharts.   npm install recharts
 *
 * Props: securityId, ltp, expiry
 */
import { useState, useEffect, useCallback } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, ResponsiveContainer, Cell,
} from "recharts";

const API = "http://localhost:8000";

function fmtOI(v) {
  if (v == null) return "—";
  const n = Math.abs(v);
  if (n >= 1e7) return (v / 1e7).toFixed(1) + "Cr";
  if (n >= 1e5) return (v / 1e5).toFixed(1) + "L";
  return v.toLocaleString("en-IN");
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1a1d2e", border: "1px solid #2a2d3a",
                  borderRadius: 6, padding: "8px 12px", fontSize: 11 }}>
      <div style={{ color: "#aaa", marginBottom: 4 }}>Strike: {label?.toLocaleString("en-IN")}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: {fmtOI(p.value)}
        </div>
      ))}
    </div>
  );
};

export default function OIChart({ securityId, ltp, expiry }) {
  const [data, setData]         = useState([]);
  const [view, setView]         = useState("oi");       // oi | delta | iv
  const [loading, setLoading]   = useState(false);
  const [atmStrike, setAtmStrike] = useState(null);

  const load = useCallback(async () => {
    if (!securityId) return;
    setLoading(true);
    try {
      const url = `${API}/api/option-chain/${securityId}${expiry ? `?expiry=${expiry}` : ""}`;
      const { data: rows } = await fetch(url).then(r => r.json());
      if (!rows?.length) { setData([]); return; }

      // Build per-strike map
      const byStrike = {};
      for (const r of rows) {
        const s = r.strike;
        if (!byStrike[s]) byStrike[s] = { strike: s };
        if (r.opt_type === "CE") {
          byStrike[s].ceOI  = Number(r.oi || 0);
          byStrike[s].ceIV  = Number(r.iv || 0);
          byStrike[s].ceLTP = Number(r.ltp || 0);
        } else {
          byStrike[s].peOI  = Number(r.oi || 0);
          byStrike[s].peIV  = Number(r.iv || 0);
          byStrike[s].peLTP = Number(r.ltp || 0);
        }
      }

      const sorted = Object.values(byStrike).sort((a, b) => a.strike - b.strike);

      // Find ATM
      const atm = ltp
        ? sorted.reduce((best, cur) =>
            Math.abs(cur.strike - ltp) < Math.abs(best.strike - ltp) ? cur : best,
            sorted[0])
        : null;
      setAtmStrike(atm?.strike ?? null);

      // OI delta: fetch prev snapshot via history (last 2 points)
      // For simplicity, compute delta = ceOI - peOI (net writer pressure)
      for (const row of sorted) {
        row.oiDiff = (row.ceOI || 0) - (row.peOI || 0);
        row.ivSpread = (row.ceIV || 0) - (row.peIV || 0);
      }

      setData(sorted);
    } finally {
      setLoading(false);
    }
  }, [securityId, expiry, ltp]);

  useEffect(() => { load(); }, [load]);

  // Totals
  const totalCE = data.reduce((s, r) => s + (r.ceOI || 0), 0);
  const totalPE = data.reduce((s, r) => s + (r.peOI || 0), 0);
  const pcr     = totalCE > 0 ? (totalPE / totalCE).toFixed(2) : "—";

  const maxBarStrike = data.reduce((m, r) =>
    (r.ceOI || 0) + (r.peOI || 0) > ((m?.ceOI || 0) + (m?.peOI || 0)) ? r : m, null);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
                  background: "#0f1117", color: "#d1d4dc", padding: "10px 12px" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10,
                    marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#aaa" }}>OI CHART</span>

        {/* View toggle */}
        {["oi", "delta", "iv"].map(v => (
          <button key={v} onClick={() => setView(v)}
            style={{ padding: "3px 10px", border: "none", borderRadius: 4,
                     background: view === v ? "#2962ff" : "#1e2130",
                     color: view === v ? "#fff" : "#666",
                     fontSize: 11, cursor: "pointer" }}>
            {v === "oi" ? "OI" : v === "delta" ? "OI Delta" : "IV Spread"}
          </button>
        ))}

        <button onClick={load}
          style={{ padding: "3px 8px", background: "#1e2130", color: "#666",
                   border: "none", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>
          ↻
        </button>

        <div style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 11 }}>
          <span>Total CE OI: <b style={{ color: "#ef5350" }}>{fmtOI(totalCE)}</b></span>
          <span>Total PE OI: <b style={{ color: "#26a69a" }}>{fmtOI(totalPE)}</b></span>
          <span>PCR: <b style={{ color: Number(pcr) > 1 ? "#26a69a" : "#ef5350" }}>{pcr}</b></span>
          {maxBarStrike && (
            <span style={{ color: "#888" }}>
              Max pain: <b style={{ color: "#f59e0b" }}>
                {maxBarStrike.strike?.toLocaleString("en-IN")}
              </b>
            </span>
          )}
        </div>
      </div>

      {loading && <div style={{ textAlign: "center", color: "#444", flex: 1,
                                display: "flex", alignItems: "center", justifyContent: "center" }}>
        Loading OI data…
      </div>}

      {!loading && data.length === 0 && (
        <div style={{ textAlign: "center", color: "#444", flex: 1,
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>
          No option chain data yet. Waiting for first snapshot (market hours only).
        </div>
      )}

      {!loading && data.length > 0 && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 4, right: 12, bottom: 20, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1d2a" />
              <XAxis
                dataKey="strike"
                tick={{ fill: "#555", fontSize: 9 }}
                tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: "#555", fontSize: 9 }}
                tickFormatter={fmtOI}
                width={48}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: "#888" }} />

              {atmStrike && (
                <ReferenceLine x={atmStrike} stroke="#2962ff" strokeDasharray="4 2"
                  label={{ value: "ATM", position: "top", fill: "#2962ff", fontSize: 9 }} />
              )}
              {ltp && (
                <ReferenceLine x={ltp} stroke="#f59e0b" strokeDasharray="3 3"
                  label={{ value: "LTP", position: "top", fill: "#f59e0b", fontSize: 9 }} />
              )}

              {view === "oi" && (
                <>
                  <Bar dataKey="ceOI" name="CE OI" fill="#ef535066" stroke="#ef5350" strokeWidth={0.5} maxBarSize={18}>
                    {data.map((entry, i) => (
                      <Cell key={i}
                        fill={entry.strike === atmStrike ? "#ef5350cc" : "#ef535044"} />
                    ))}
                  </Bar>
                  <Bar dataKey="peOI" name="PE OI" fill="#26a69a66" stroke="#26a69a" strokeWidth={0.5} maxBarSize={18}>
                    {data.map((entry, i) => (
                      <Cell key={i}
                        fill={entry.strike === atmStrike ? "#26a69acc" : "#26a69a44"} />
                    ))}
                  </Bar>
                </>
              )}

              {view === "delta" && (
                <>
                  <Bar dataKey="oiDiff" name="OI Delta (CE−PE)" maxBarSize={18}>
                    {data.map((entry, i) => (
                      <Cell key={i}
                        fill={entry.oiDiff >= 0 ? "#ef535088" : "#26a69a88"} />
                    ))}
                  </Bar>
                  <ReferenceLine y={0} stroke="#444" />
                </>
              )}

              {view === "iv" && (
                <>
                  <Line type="monotone" dataKey="ceIV" name="CE IV%" stroke="#ef5350"
                    dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="peIV" name="PE IV%" stroke="#26a69a"
                    dot={false} strokeWidth={2} />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}