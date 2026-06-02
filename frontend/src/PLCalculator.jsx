/**
 * PLCalculator — Multi-leg options P&L payoff diagram
 * Up to 4 legs. Payoff at expiry + current P&L marker.
 * Uses recharts.
 */
import { useState, useMemo } from "react";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from "recharts";

const LOT_SIZE = { "13": 50, "25": 15, "51": 10 }; // NIFTY, BANKNIFTY, SENSEX
const DEFAULT_LOT = 50;

const PRESETS = {
  "Long Call":     [{ type: "CE", dir: "BUY",  qty: 1 }],
  "Long Put":      [{ type: "PE", dir: "BUY",  qty: 1 }],
  "Short Straddle":[{ type: "CE", dir: "SELL", qty: 1 }, { type: "PE", dir: "SELL", qty: 1 }],
  "Long Straddle": [{ type: "CE", dir: "BUY",  qty: 1 }, { type: "PE", dir: "BUY",  qty: 1 }],
  "Bull Call Spread": [
    { type: "CE", dir: "BUY",  qty: 1, strikeDelta: 0   },
    { type: "CE", dir: "SELL", qty: 1, strikeDelta: 100 },
  ],
  "Bear Put Spread": [
    { type: "PE", dir: "BUY",  qty: 1, strikeDelta: 0    },
    { type: "PE", dir: "SELL", qty: 1, strikeDelta: -100 },
  ],
  "Iron Condor": [
    { type: "PE", dir: "SELL", qty: 1, strikeDelta: -50  },
    { type: "PE", dir: "BUY",  qty: 1, strikeDelta: -150 },
    { type: "CE", dir: "SELL", qty: 1, strikeDelta: 50   },
    { type: "CE", dir: "BUY",  qty: 1, strikeDelta: 150  },
  ],
};

const emptyLeg = (i) => ({
  id: i, type: "CE", strike: 0, premium: 0, qty: 1, dir: "BUY", active: true,
});

function legPayoff(leg, price, lotSize) {
  const { type, strike, premium, qty, dir, active } = leg;
  if (!active || !strike || !premium) return 0;
  const lots = qty * lotSize;
  const sign = dir === "BUY" ? 1 : -1;
  const intrinsic = type === "CE"
    ? Math.max(0, price - strike)
    : Math.max(0, strike - price);
  return sign * (intrinsic - premium) * lots;
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const pnl = payload.find(p => p.dataKey === "pnl")?.value ?? 0;
  return (
    <div style={{ background: "#1a1d2e", border: "1px solid #2a2d3a",
                  borderRadius: 6, padding: "8px 12px", fontSize: 11 }}>
      <div style={{ color: "#aaa" }}>Underlying: {Number(label).toLocaleString("en-IN")}</div>
      <div style={{ color: pnl >= 0 ? "#26a69a" : "#ef5350", fontWeight: 600, fontSize: 13 }}>
        P&L: ₹{pnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
      </div>
    </div>
  );
};

export default function PLCalculator({ ltp, securityId }) {
  const lotSize = LOT_SIZE[securityId] ?? DEFAULT_LOT;
  const atmRounded = ltp ? Math.round(ltp / 50) * 50 : 0;

  const [legs, setLegs] = useState([
    { ...emptyLeg(0), strike: atmRounded, premium: 0, type: "CE", dir: "BUY" },
  ]);
  const [range, setRange] = useState(5);   // ±% from ATM

  const updateLeg = (id, field, value) =>
    setLegs(ls => ls.map(l => l.id === id ? { ...l, [field]: value } : l));

  const addLeg = () => {
    if (legs.length >= 4) return;
    setLegs(ls => [...ls, { ...emptyLeg(Date.now()), strike: atmRounded }]);
  };

  const removeLeg = (id) => setLegs(ls => ls.filter(l => l.id !== id));

  const applyPreset = (name) => {
    const preset = PRESETS[name];
    setLegs(preset.map((p, i) => ({
      ...emptyLeg(i),
      type:    p.type,
      dir:     p.dir,
      qty:     p.qty,
      strike:  atmRounded + (p.strikeDelta || 0),
      premium: 0,
    })));
  };

  // Build chart data
  const chartData = useMemo(() => {
    if (!atmRounded) return [];
    const span   = atmRounded * (range / 100);
    const lo     = atmRounded - span;
    const hi     = atmRounded + span;
    const step   = Math.max(10, Math.round((hi - lo) / 80 / 10) * 10);
    const points = [];
    for (let p = lo; p <= hi; p += step) {
      const pnl = legs.reduce((sum, leg) => sum + legPayoff(leg, p, lotSize), 0);
      points.push({ price: Math.round(p), pnl: Math.round(pnl) });
    }
    return points;
  }, [legs, lotSize, atmRounded, range]);

  const maxProfit = chartData.length ? Math.max(...chartData.map(d => d.pnl)) : 0;
  const maxLoss   = chartData.length ? Math.min(...chartData.map(d => d.pnl)) : 0;
  const beps      = [];
  for (let i = 1; i < chartData.length; i++) {
    if ((chartData[i-1].pnl < 0 && chartData[i].pnl >= 0) ||
        (chartData[i-1].pnl >= 0 && chartData[i].pnl < 0)) {
      beps.push(Math.round((chartData[i-1].price + chartData[i].price) / 2));
    }
  }

  const currentPnl = ltp
    ? legs.reduce((sum, leg) => sum + legPayoff(leg, ltp, lotSize), 0)
    : null;

  const inputStyle = {
    background: "#1e2130", color: "#d1d4dc", border: "1px solid #2a2d3a",
    borderRadius: 4, padding: "3px 6px", fontSize: 11, width: "100%",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
                  background: "#0f1117", color: "#d1d4dc", padding: "10px 12px",
                  gap: 10, overflow: "auto" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#aaa" }}>P&L CALCULATOR</span>
        <span style={{ fontSize: 11, color: "#444" }}>Lot size: {lotSize}</span>

        {/* Presets */}
        <select onChange={e => applyPreset(e.target.value)} defaultValue=""
          style={{ ...inputStyle, width: "auto" }}>
          <option value="" disabled>Load preset…</option>
          {Object.keys(PRESETS).map(p => <option key={p} value={p}>{p}</option>)}
        </select>

        {/* Range */}
        <label style={{ fontSize: 11, color: "#666", display: "flex", alignItems: "center", gap: 4 }}>
          ±{range}%
          <input type="range" min="1" max="15" value={range}
            onChange={e => setRange(+e.target.value)}
            style={{ width: 60, marginLeft: 4 }} />
        </label>

        <div style={{ marginLeft: "auto", display: "flex", gap: 12, fontSize: 11 }}>
          <span>Max Profit: <b style={{ color: "#26a69a" }}>
            {maxProfit === Infinity ? "∞" : `₹${maxProfit.toLocaleString("en-IN")}`}
          </b></span>
          <span>Max Loss: <b style={{ color: "#ef5350" }}>
            {maxLoss === -Infinity ? "∞" : `₹${Math.abs(maxLoss).toLocaleString("en-IN")}`}
          </b></span>
          {beps.map((b, i) => (
            <span key={i} style={{ color: "#f59e0b" }}>
              BEP{beps.length > 1 ? i+1 : ""}: {b.toLocaleString("en-IN")}
            </span>
          ))}
          {currentPnl !== null && (
            <span style={{ color: currentPnl >= 0 ? "#26a69a" : "#ef5350", fontWeight: 600 }}>
              Now: ₹{Math.round(currentPnl).toLocaleString("en-IN")}
            </span>
          )}
        </div>
      </div>

      {/* Legs table */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "grid", gridTemplateColumns: "80px 90px 90px 60px 70px 24px",
                      gap: 4, fontSize: 10, color: "#555", padding: "0 2px" }}>
          {["Direction","Strike","Premium","Qty","Type",""].map(h => <div key={h}>{h}</div>)}
        </div>

        {legs.map(leg => (
          <div key={leg.id}
            style={{ display: "grid", gridTemplateColumns: "80px 90px 90px 60px 70px 24px",
                     gap: 4, alignItems: "center" }}>

            <select value={leg.dir} onChange={e => updateLeg(leg.id, "dir", e.target.value)}
              style={{ ...inputStyle,
                color: leg.dir === "BUY" ? "#26a69a" : "#ef5350" }}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>

            <input type="number" value={leg.strike}
              onChange={e => updateLeg(leg.id, "strike", +e.target.value)}
              style={inputStyle} placeholder="Strike" step="50" />

            <input type="number" value={leg.premium}
              onChange={e => updateLeg(leg.id, "premium", +e.target.value)}
              style={inputStyle} placeholder="Premium" step="0.5" />

            <input type="number" value={leg.qty}
              onChange={e => updateLeg(leg.id, "qty", Math.max(1, +e.target.value))}
              style={inputStyle} min="1" />

            <select value={leg.type} onChange={e => updateLeg(leg.id, "type", e.target.value)}
              style={inputStyle}>
              <option value="CE">CE (Call)</option>
              <option value="PE">PE (Put)</option>
            </select>

            <button onClick={() => removeLeg(leg.id)}
              style={{ background: "transparent", border: "none",
                       color: "#ef5350", cursor: "pointer", fontSize: 14 }}>×</button>
          </div>
        ))}

        {legs.length < 4 && (
          <button onClick={addLeg}
            style={{ alignSelf: "flex-start", background: "#1e2130",
                     color: "#2962ff", border: "1px dashed #2962ff44",
                     borderRadius: 4, padding: "3px 12px", cursor: "pointer", fontSize: 11 }}>
            + Add leg
          </button>
        )}
      </div>

      {/* Payoff chart */}
      <div style={{ flex: 1, minHeight: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 4, right: 12, bottom: 20, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1d2a" />
            <XAxis dataKey="price" tick={{ fill: "#555", fontSize: 9 }}
              tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}
              interval="preserveStartEnd" />
            <YAxis tick={{ fill: "#555", fontSize: 9 }}
              tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}
              width={44} />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#333" strokeWidth={1.5} />
            {ltp && <ReferenceLine x={ltp} stroke="#f59e0b" strokeDasharray="4 2"
              label={{ value: "LTP", position: "top", fill: "#f59e0b", fontSize: 9 }} />}
            {beps.map((b, i) => (
              <ReferenceLine key={i} x={b} stroke="#888" strokeDasharray="3 3" />
            ))}
            <defs>
              <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#26a69a" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#ef5350" stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="pnl" stroke="none"
              fill="url(#pnlGrad)" fillOpacity={1} />
            <Line type="monotone" dataKey="pnl" dot={false} strokeWidth={2}
              stroke="#2962ff"
              // Colour segments: profit=green, loss=red handled via gradient above
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}