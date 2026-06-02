/**
 * OptionChainPanel — Live option chain table with Greeks
 * Shows CE | Strike | PE layout, ATM highlighted, OI bar charts inline.
 * Refreshes every 30s automatically when live; supports expiry selector.
 */
import { useEffect, useState, useRef } from "react";

const API = "http://localhost:8000";
const REFRESH_MS = 30_000;

// Small inline OI bar (max-width normalised to max OI in visible chain)
function OIBar({ oi, maxOi, side }) {
  const pct = maxOi > 0 ? Math.min(100, (oi / maxOi) * 100) : 0;
  const color = side === "ce" ? "#ef5350" : "#26a69a";
  return (
    <div style={{ position: "relative", height: 3, background: "#1e2130",
                  borderRadius: 2, width: 60, display: "inline-block",
                  verticalAlign: "middle", margin: "0 4px" }}>
      <div style={{
        position: "absolute",
        [side === "ce" ? "right" : "left"]: 0,
        width: `${pct}%`, height: "100%",
        background: color, borderRadius: 2,
      }} />
    </div>
  );
}

function fmt(n, dec = 2) {
  if (n == null) return "—";
  return Number(n).toFixed(dec);
}

function fmtOI(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (v >= 1_00_00_000) return (v / 1_00_00_000).toFixed(1) + "Cr";
  if (v >= 1_00_000)    return (v / 1_00_000).toFixed(1) + "L";
  return v.toLocaleString("en-IN");
}

export default function OptionChainPanel({ securityId, ltp }) {
  const [expiries, setExpiries]   = useState([]);
  const [expiry, setExpiry]       = useState(null);
  const [chain, setChain]         = useState([]);
  const [loading, setLoading]     = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [showGreeks, setShowGreeks] = useState(false);
  const timerRef = useRef(null);

  // Fetch expiry list
  useEffect(() => {
    if (!securityId) return;
    fetch(`${API}/api/option-chain/${securityId}/expiries`)
      .then(r => r.json())
      .then(({ expiries: list }) => {
        setExpiries(list);
        if (list.length) setExpiry(list[0]);
      });
  }, [securityId]);

  // Fetch OC data
  const fetchOC = async () => {
    if (!securityId || !expiry) return;
    setLoading(true);
    try {
      const url = `${API}/api/option-chain/${securityId}?expiry=${expiry}`;
      const { data } = await fetch(url).then(r => r.json());
      setChain(data || []);
      setLastUpdate(new Date());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOC();
    timerRef.current = setInterval(fetchOC, REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [securityId, expiry]);

  // Build lookup: strike → { CE, PE }
  const strikes = {};
  for (const row of chain) {
    const s = String(row.strike);
    if (!strikes[s]) strikes[s] = { strike: row.strike };
    strikes[s][row.opt_type] = row;
  }

  const sortedStrikes = Object.values(strikes).sort((a, b) => a.strike - b.strike);

  // ATM = strike closest to LTP
  const atm = ltp
    ? sortedStrikes.reduce((best, cur) =>
        Math.abs(cur.strike - ltp) < Math.abs(best.strike - ltp) ? cur : best,
        sortedStrikes[0] || { strike: 0 }
      )
    : null;

  const maxCeOI = Math.max(...sortedStrikes.map(s => Number(s.CE?.oi || 0)));
  const maxPeOI = Math.max(...sortedStrikes.map(s => Number(s.PE?.oi || 0)));

  const totalCeOI = sortedStrikes.reduce((s, r) => s + Number(r.CE?.oi || 0), 0);
  const totalPeOI = sortedStrikes.reduce((s, r) => s + Number(r.PE?.oi || 0), 0);
  const pcr = totalCeOI > 0 ? (totalPeOI / totalCeOI).toFixed(2) : "—";

  const col = (label, title) => (
    <th title={title} style={thStyle}>{label}</th>
  );

  if (!securityId) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
                  background: "#0f1117", color: "#d1d4dc" }}>

      {/* Panel header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10,
                    padding: "6px 12px", background: "#161b27",
                    borderBottom: "1px solid #1e2130", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#aaa" }}>OPTION CHAIN</span>

        {/* Expiry selector */}
        <select value={expiry || ""} onChange={e => setExpiry(e.target.value)}
          style={{ background: "#1e2130", color: "#d1d4dc", border: "1px solid #2a2d3a",
                   borderRadius: 4, padding: "2px 6px", fontSize: 12 }}>
          {expiries.map(e => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>

        <button onClick={fetchOC}
          style={{ background: "#1e2130", color: "#aaa", border: "1px solid #2a2d3a",
                   borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>
          ↻ Refresh
        </button>

        <label style={{ fontSize: 11, color: "#666", display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={showGreeks}
            onChange={e => setShowGreeks(e.target.checked)} />
          Greeks
        </label>

        <div style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 11 }}>
          <span>PCR: <b style={{ color: Number(pcr) > 1 ? "#26a69a" : "#ef5350" }}>{pcr}</b></span>
          <span style={{ color: "#444" }}>
            {loading ? "Loading..." : lastUpdate ? `${lastUpdate.toLocaleTimeString()}` : ""}
          </span>
        </div>
      </div>

      {/* Table */}
      <div style={{ overflow: "auto", flex: 1, fontSize: 11 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            {showGreeks ? (
              <>
                <col style={{ width: "8%" }} /><col style={{ width: "6%" }} />
                <col style={{ width: "6%" }} /><col style={{ width: "6%" }} />
                <col style={{ width: "6%" }} /><col style={{ width: "6%" }} />
                <col style={{ width: "8%" }} /><col style={{ width: "8%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "8%" }} /><col style={{ width: "6%" }} />
                <col style={{ width: "6%" }} /><col style={{ width: "6%" }} />
                <col style={{ width: "6%" }} /><col style={{ width: "6%" }} />
                <col style={{ width: "8%" }} />
              </>
            ) : (
              <>
                <col style={{ width: "12%" }} /><col style={{ width: "10%" }} />
                <col style={{ width: "12%" }} /><col style={{ width: "10%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "10%" }} /><col style={{ width: "12%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "12%" }} />
              </>
            )}
          </colgroup>
          <thead>
            <tr style={{ background: "#161b27", borderBottom: "1px solid #1e2130", color: "#666" }}>
              {showGreeks ? (
                <>
                  {col("OI (CE)", "Call Open Interest")}
                  {col("Delta", "Call Delta")}
                  {col("Theta", "Call Theta")}
                  {col("IV%", "Call Implied Volatility")}
                  {col("Bid", "Call Bid")}
                  {col("Ask", "Call Ask")}
                  {col("LTP (CE)", "Call Last Traded Price")}
                  <th style={{ ...thStyle, color: "#fff", background: "#1a1d2e" }}>STRIKE</th>
                  {col("LTP (PE)", "Put Last Traded Price")}
                  {col("Bid", "Put Bid")}
                  {col("Ask", "Put Ask")}
                  {col("IV%", "Put Implied Volatility")}
                  {col("Theta", "Put Theta")}
                  {col("Delta", "Put Delta")}
                  {col("OI (PE)", "Put Open Interest")}
                </>
              ) : (
                <>
                  {col("OI (CE)", "Call OI")}
                  {col("Volume", "Call Volume")}
                  {col("IV%", "Call IV")}
                  {col("LTP (CE)", "Call LTP")}
                  <th style={{ ...thStyle, color: "#fff", background: "#1a1d2e", fontSize: 12 }}>STRIKE</th>
                  {col("LTP (PE)", "Put LTP")}
                  {col("IV%", "Put IV")}
                  {col("Volume", "Put Volume")}
                  {col("OI (PE)", "Put OI")}
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {sortedStrikes.map(({ strike, CE, PE }) => {
              const isATM = atm?.strike === strike;
              const itm_ce = ltp && strike < ltp;
              const itm_pe = ltp && strike > ltp;
              const rowBg = isATM
                ? "#1a1d2e"
                : itm_ce ? "#12161a" : itm_pe ? "#10161a" : "transparent";
              return (
                <tr key={strike} style={{ background: rowBg,
                                          borderBottom: "1px solid #13151f" }}>
                  {showGreeks ? (
                    <>
                      <td style={ceCell(maxCeOI, CE?.oi)}>
                        <OIBar oi={CE?.oi || 0} maxOi={maxCeOI} side="ce" />
                        {fmtOI(CE?.oi)}
                      </td>
                      <td style={cellSt("#d1d4dc")}>{fmt(CE?.delta, 3)}</td>
                      <td style={cellSt("#ef5350")}>{fmt(CE?.theta, 3)}</td>
                      <td style={cellSt("#888")}>{fmt(CE?.iv, 1)}</td>
                      <td style={cellSt("#888")}>{fmt(CE?.bid)}</td>
                      <td style={cellSt("#888")}>{fmt(CE?.ask)}</td>
                      <td style={{ ...cellSt("#ef5350"), fontWeight: 600 }}>{fmt(CE?.ltp)}</td>
                      <td style={{ ...strikeCellStyle, color: isATM ? "#fff" : "#aaa",
                                   fontWeight: isATM ? 700 : 500 }}>
                        {isATM && <span style={{ color: "#2962ff", marginRight: 3 }}>●</span>}
                        {strike.toLocaleString("en-IN")}
                      </td>
                      <td style={{ ...cellSt("#26a69a"), fontWeight: 600 }}>{fmt(PE?.ltp)}</td>
                      <td style={cellSt("#888")}>{fmt(PE?.bid)}</td>
                      <td style={cellSt("#888")}>{fmt(PE?.ask)}</td>
                      <td style={cellSt("#888")}>{fmt(PE?.iv, 1)}</td>
                      <td style={cellSt("#ef5350")}>{fmt(PE?.theta, 3)}</td>
                      <td style={cellSt("#26a69a")}>{fmt(PE?.delta, 3)}</td>
                      <td style={ceCell(maxPeOI, PE?.oi)}>
                        {fmtOI(PE?.oi)}
                        <OIBar oi={PE?.oi || 0} maxOi={maxPeOI} side="pe" />
                      </td>
                    </>
                  ) : (
                    <>
                      <td style={ceCell(maxCeOI, CE?.oi)}>
                        <OIBar oi={CE?.oi || 0} maxOi={maxCeOI} side="ce" />
                        {fmtOI(CE?.oi)}
                      </td>
                      <td style={cellSt("#888")}>{fmtOI(CE?.volume)}</td>
                      <td style={cellSt("#888")}>{fmt(CE?.iv, 1)}</td>
                      <td style={{ ...cellSt("#ef5350"), fontWeight: 600 }}>{fmt(CE?.ltp)}</td>
                      <td style={{ ...strikeCellStyle, color: isATM ? "#fff" : "#aaa",
                                   fontWeight: isATM ? 700 : 500 }}>
                        {isATM && <span style={{ color: "#2962ff", marginRight: 3 }}>●</span>}
                        {strike.toLocaleString("en-IN")}
                      </td>
                      <td style={{ ...cellSt("#26a69a"), fontWeight: 600 }}>{fmt(PE?.ltp)}</td>
                      <td style={cellSt("#888")}>{fmt(PE?.iv, 1)}</td>
                      <td style={cellSt("#888")}>{fmtOI(PE?.volume)}</td>
                      <td style={ceCell(maxPeOI, PE?.oi)}>
                        {fmtOI(PE?.oi)}
                        <OIBar oi={PE?.oi || 0} maxOi={maxPeOI} side="pe" />
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {sortedStrikes.length === 0 && (
          <div style={{ textAlign: "center", color: "#444", padding: 40, fontSize: 13 }}>
            {loading ? "Loading option chain..." : "No data available. Market may be closed or OC not yet fetched."}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Styles ---
const thStyle = {
  padding: "6px 4px", textAlign: "center",
  fontWeight: 500, fontSize: 10, letterSpacing: "0.5px",
  position: "sticky", top: 0, background: "#161b27",
};

const strikeCellStyle = {
  padding: "5px 4px", textAlign: "center",
  background: "#1a1d2e", borderLeft: "1px solid #1e2130",
  borderRight: "1px solid #1e2130", fontSize: 12,
};

const cellSt = (color) => ({
  padding: "5px 4px", textAlign: "center", color,
});

const ceCell = (maxOI, oi) => ({
  padding: "5px 4px", textAlign: "center",
  color: "#888",
  background: maxOI > 0 && oi
    ? `rgba(239,83,80,${Math.min(0.12, (oi / maxOI) * 0.12)})`
    : "transparent",
});