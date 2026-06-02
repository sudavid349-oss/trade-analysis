import { useEffect, useRef, useState, useCallback } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";
import OptionChainPanel from "./OptionChain";
import DrawingTools, { DrawingToolbar } from "./DrawingTools";
import OIChart from "./OIChart";
import PLCalculator from "./PLCalculator";
import AlertsPanel, { AlertToasts } from "./AlertsPanel";

const API    = "http://localhost:8000";
const WS_URL = "ws://localhost:8000/ws/live";
const TFS    = ["1m", "5m", "15m", "1h", "1d"];
const MIN_PANE_W = 220;
const BOTTOM_TABS = ["oi", "pl", "alerts"];
const BOTTOM_TAB_LABELS = { oi: "📊 OI Chart", pl: "🧮 P&L", alerts: "🔔 Alerts" };

// IST offset — lightweight-charts has no timezone support
const IST_OFFSET  = 19800;
const toChartTime = (utcMs) => Math.floor(utcMs / 1000) + IST_OFFSET;

// How many candles to load per TF (5 days)
const TF_LIMIT = { "1m": 1875, "5m": 375, "15m": 125, "1h": 40, "1d": 500 };

// Global in-memory cache: { [secId]: { [tf]: chartBar[] } }
const globalCache = {};

export default function App() {
  // ── state ────────────────────────────────────────────────────────
  const [indices, setIndices]       = useState([]);
  const [selected, setSelected]     = useState(null);
  const [tf, setTf]                 = useState("5m");
  const [ltp, setLtp]               = useState(null);
  const [prevLtp, setPrevLtp]       = useState(null);
  const [ltpDir, setLtpDir]         = useState(null);
  const [status, setStatus]         = useState("Connecting…");
  const [cacheReady, setCacheReady] = useState(false);
  const [loadingTf, setLoadingTf]   = useState("");
  const [stats, setStats]           = useState(null);
  const [showStats, setShowStats]   = useState(false);

  const [ocVisible, setOcVisible]   = useState(true);
  const [splitPct, setSplitPct]     = useState(60);
  const [bottomTab, setBottomTab]   = useState("oi");
  const [bottomOpen, setBottomOpen] = useState(false);
  const [bottomH, setBottomH]       = useState(280);
  const containerRef = useRef(null);
  const hDragging    = useRef(false);
  const vDragging    = useRef(false);

  const [drawTool, setDrawTool]     = useState("cursor");
  const [drawingKey, setDrawingKey] = useState(0);

  const [mode, setMode]               = useState("live");
  const [replayDate, setReplayDate]   = useState("");
  const [replayInfo, setReplayInfo]   = useState(null);
  const [replaySpeed, setReplaySpeed] = useState(10);
  const [isReplaying, setIsReplaying] = useState(false);

  const [toastAlerts, setToastAlerts] = useState([]);
  const [alertBadge, setAlertBadge]   = useState(0);

  // ── refs ─────────────────────────────────────────────────────────
  const chartWrapRef = useRef(null);
  const chartRef     = useRef(null);
  const chartObj     = useRef(null);
  const candleSeries = useRef(null);
  const volSeries    = useRef(null);
  const wsRef        = useRef(null);
  const replayTimer  = useRef(null);

  // ── fetch indices ─────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/api/indices`).then(r => r.json()).then(d => {
      setIndices(d); if (d.length) setSelected(d[0]);
    });
  }, []);

  // ── fetch stats ───────────────────────────────────────────────────
  const fetchStats = () =>
    fetch(`${API}/api/storage/stats`).then(r => r.json()).then(setStats);
  useEffect(() => { fetchStats(); }, []);

  // ── init chart ────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = createChart(chartRef.current, {
      layout:    { background: { color: "#0f1117" }, textColor: "#d1d4dc" },
      grid:      { vertLines: { color: "#1a1d2a" }, horzLines: { color: "#1a1d2a" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2a2d3a" },
      timeScale: { borderColor: "#2a2d3a", timeVisible: true, secondsVisible: false },
      width:  chartRef.current.clientWidth,
      height: chartRef.current.clientHeight,
    });
    const candles = chart.addCandlestickSeries({
      upColor: "#26a69a", downColor: "#ef5350",
      borderUpColor: "#26a69a", borderDownColor: "#ef5350",
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    });
    const vol = chart.addHistogramSeries({
      color: "#26a69a44", priceFormat: { type: "volume" }, priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chartObj.current    = chart;
    candleSeries.current = candles;
    volSeries.current   = vol;
    const ro = new ResizeObserver(() => {
      if (!chartRef.current) return;
      chart.applyOptions({ width: chartRef.current.clientWidth, height: chartRef.current.clientHeight });
    });
    ro.observe(chartRef.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, []);

  // ── prefetch ALL TFs when index changes ───────────────────────────
  useEffect(() => {
    if (!selected) return;
    stopReplay();
    candleSeries.current?.setData([]);
    volSeries.current?.setData([]);
    setLtp(null); setPrevLtp(null);

    if (globalCache[selected.id]) {
      setCacheReady(true);
      return;
    }

    setCacheReady(false);
    const fetchAll = async () => {
      const cache = {};
      for (const t of Object.keys(TF_LIMIT)) {
        setLoadingTf(`Loading ${t}…`);
        try {
          const { candles } = await fetch(
            `${API}/api/candles/${selected.id}?tf=${t}&limit=${TF_LIMIT[t]}`
          ).then(r => r.json());
          cache[t] = (candles || []).map(c => ({
            time: toChartTime(c.t), open: c.o, high: c.h,
            low: c.l, close: c.c, vol: c.v,
          }));
        } catch (e) {
          console.error(`Fetch ${t}:`, e);
          cache[t] = [];
        }
      }
      globalCache[selected.id] = cache;
      setCacheReady(true);
      setLoadingTf("");
    };
    fetchAll();
  }, [selected]);

  // ── render from cache when TF or cache ready ──────────────────────
  useEffect(() => {
    if (!selected || !cacheReady || !candleSeries.current || !chartObj.current) return;
    const data = globalCache[selected.id]?.[tf] ?? [];
    if (!data.length) { setStatus("● Live"); return; }

    candleSeries.current.setData(data.map(c => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    volSeries.current?.setData(data.map(c => ({
      time: c.time, value: c.vol,
      color: c.close >= c.open ? "#26a69a44" : "#ef535044",
    })));
    const last = data[data.length - 1];
    setLtp(last.close);
    setPrevLtp(data.length > 1 ? data[data.length - 2].close : last.close);
    chartObj.current.timeScale().fitContent();

    // For 1m and 5m zoom into latest session automatically
    if (tf === "1m" || tf === "5m") {
      const todayCandles = data.filter(c => {
        const d = new Date((c.time - IST_OFFSET) * 1000);
        const today = new Date();
        return d.getDate() === today.getDate() &&
               d.getMonth() === today.getMonth();
      });
      if (todayCandles.length > 0) {
        chartObj.current.timeScale().setVisibleRange({
          from: todayCandles[0].time,
          to:   todayCandles[todayCandles.length - 1].time + 3600,
        });
      }
    }
    setStatus("● Live");
  }, [selected, tf, cacheReady]);

  // ── WebSocket live feed ───────────────────────────────────────────
  useEffect(() => {
    if (mode !== "live") return;
    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen  = () => setStatus("● Live");
      ws.onclose = () => { setStatus("Reconnecting…"); setTimeout(connect, 3000); };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "alert") {
          setToastAlerts(a => [...a, msg]);
          setAlertBadge(b => b + 1);
          return;
        }
        if (!selected || msg.id !== selected.id) return;
        if (msg.type === "tick") {
          setLtp(prev => {
            setLtpDir(msg.ltp >= (prev ?? msg.ltp) ? "up" : "down");
            setPrevLtp(prev);
            setTimeout(() => setLtpDir(null), 500);
            return msg.ltp;
          });
        }
        if (msg.type === "candle") {
          const bar = { time: toChartTime(msg.t), open: msg.o, high: msg.h, low: msg.l, close: msg.c };
          // Update cache for all TFs
          if (globalCache[selected.id]?.[msg.tf]) {
            const cache = globalCache[selected.id][msg.tf];
            const last  = cache[cache.length - 1];
            if (last?.time === bar.time) {
              cache[cache.length - 1] = { ...bar, vol: msg.v };
            } else {
              cache.push({ ...bar, vol: msg.v });
            }
          }
          // Update chart only for current TF
          if (msg.tf === tf) {
            candleSeries.current?.update(bar);
            volSeries.current?.update({
              time: bar.time, value: msg.v,
              color: msg.c >= msg.o ? "#26a69a44" : "#ef535044",
            });
          }
        }
      };
    };
    connect();
    return () => wsRef.current?.close();
  }, [mode, selected, tf]);

  // ── replay ────────────────────────────────────────────────────────
  const checkReplay = async () => {
    if (!selected || !replayDate) return;
    const r = await fetch(`${API}/api/replay/${selected.id}?session_date=${replayDate}`);
    setReplayInfo(await r.json());
  };

  const startReplay = async () => {
    if (!replayInfo) return;
    setIsReplaying(true);
    candleSeries.current?.setData([]);
    volSeries.current?.setData([]);
    const tfSec = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 }[tf];
    const intMs = Math.max(50, 1000 / replaySpeed);

    if (replayInfo.replay_possible) {
      const { ticks } = await fetch(
        `${API}/api/ticks/${selected.id}?from_ts=${replayDate}T09:15:00&to_ts=${replayDate}T15:30:00`
      ).then(r => r.json());
      const buckets = {};
      for (const t of ticks) {
        const b = Math.floor(t.t / 1000 / tfSec) * tfSec;
        if (!buckets[b]) buckets[b] = { time: b, open: t.ltp, high: t.ltp, low: t.ltp, close: t.ltp, volume: 0 };
        else { const c = buckets[b]; c.high = Math.max(c.high, t.ltp); c.low = Math.min(c.low, t.ltp); c.close = t.ltp; c.volume++; }
      }
      const cd = Object.values(buckets).sort((a, b) => a.time - b.time);
      let i = 0;
      replayTimer.current = setInterval(() => {
        if (i >= cd.length) { stopReplay(); return; }
        candleSeries.current?.update({ ...cd[i], time: toChartTime(cd[i].time * 1000) });
        setLtp(cd[i].close); i++;
      }, intMs);
    } else {
      const { candles } = await fetch(
        `${API}/api/candles/${selected.id}?tf=${tf}&from_date=${replayDate}&to_date=${replayDate}&limit=500`
      ).then(r => r.json());
      let i = 0;
      replayTimer.current = setInterval(() => {
        if (i >= candles.length) { stopReplay(); return; }
        const c = candles[i];
        candleSeries.current?.update({ time: toChartTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c });
        volSeries.current?.update({ time: toChartTime(c.t), value: c.v, color: c.c >= c.o ? "#26a69a44" : "#ef535044" });
        setLtp(c.c); i++;
      }, Math.max(100, 1000 / replaySpeed));
    }
  };

  const stopReplay = useCallback(() => {
    if (replayTimer.current) { clearInterval(replayTimer.current); replayTimer.current = null; }
    setIsReplaying(false);
  }, []);

  // ── divider drag ─────────────────────────────────────────────────
  const onHDivDown = (e) => {
    e.preventDefault(); hDragging.current = true;
    const onMove = (ev) => {
      if (!hDragging.current || !containerRef.current) return;
      const { left, width } = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - left) / width) * 100;
      const min = (MIN_PANE_W / width) * 100;
      setSplitPct(Math.min(100 - min, Math.max(min, pct)));
    };
    const onUp = () => { hDragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onVDivDown = (e) => {
    e.preventDefault(); vDragging.current = true;
    const startY = e.clientY; const startH = bottomH;
    const onMove = (ev) => {
      if (!vDragging.current) return;
      setBottomH(Math.min(500, Math.max(150, startH + (startY - ev.clientY))));
    };
    const onUp = () => { vDragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── derived ───────────────────────────────────────────────────────
  const ltpColor = ltpDir === "up" ? "#26a69a" : ltpDir === "down" ? "#ef5350"
    : ltp && prevLtp ? (ltp >= prevLtp ? "#26a69a" : "#ef5350") : "#d1d4dc";
  const ltpPctChange = ltp && prevLtp
    ? (((ltp - prevLtp) / prevLtp) * 100).toFixed(2) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh",
                  background: "#0f1117", color: "#d1d4dc",
                  fontFamily: "'Inter',sans-serif", overflow: "hidden" }}>

      {/* Top bar */}
      <div style={topBarSt}>
        <span style={{ fontWeight: 800, fontSize: 14, color: "#2962ff",
                       letterSpacing: 1, marginRight: 6 }}>DhanChart</span>

        <div style={{ display: "flex", gap: 3 }}>
          {indices.map(idx => (
            <button key={idx.id} onClick={() => { setSelected(idx); setCacheReady(false); }}
              style={tabBtn(selected?.id === idx.id)}>
              {idx.symbol}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 2, marginLeft: 6 }}>
          {TFS.map(t => <button key={t} onClick={() => setTf(t)} style={tfBtn(tf === t)}>{t}</button>)}
        </div>

        <div style={{ display: "flex", gap: 3, marginLeft: 6 }}>
          {["live", "replay"].map(m => (
            <button key={m} onClick={() => { setMode(m); if (m === "live") stopReplay(); }}
              style={tabBtn(mode === m)}>
              {m === "live" ? "🔴 Live" : "⏮ Replay"}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* LTP */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", minWidth: 110 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: ltpColor, transition: "color 0.3s" }}>
            {ltp ? ltp.toLocaleString("en-IN", { minimumFractionDigits: 2 }) : "—"}
          </span>
          {ltpPctChange && (
            <span style={{ fontSize: 10, color: ltpColor }}>
              {Number(ltpPctChange) >= 0 ? "▲" : "▼"} {Math.abs(ltpPctChange)}%
            </span>
          )}
        </div>

        <span style={{ fontSize: 10, color: "#444", minWidth: 100, textAlign: "right" }}>
          {loadingTf || status}
        </span>

        <button onClick={() => setOcVisible(v => !v)}
          style={{ ...tabBtn(ocVisible), marginLeft: 8 }}>
          {ocVisible ? "Hide OC" : "OC"}
        </button>

        {BOTTOM_TABS.map(t => (
          <button key={t}
            onClick={() => { setBottomOpen(v => bottomTab === t ? !v : true); setBottomTab(t); if (t === "alerts") setAlertBadge(0); }}
            style={{ ...tabBtn(bottomOpen && bottomTab === t), marginLeft: 3, position: "relative" }}>
            {BOTTOM_TAB_LABELS[t]}
            {t === "alerts" && alertBadge > 0 && (
              <span style={{ position: "absolute", top: -4, right: -4, background: "#ef5350",
                             color: "#fff", borderRadius: 10, fontSize: 8, padding: "1px 4px" }}>
                {alertBadge}
              </span>
            )}
          </button>
        ))}

        <button onClick={() => { setShowStats(v => !v); fetchStats(); }}
          style={{ ...tabBtn(showStats), marginLeft: 4, fontSize: 11 }}>📦 DB</button>
      </div>

      {/* DB Stats */}
      {showStats && stats && (
        <div style={{ background: "#161b27", borderBottom: "1px solid #1e2130",
                      padding: "5px 16px", display: "flex", gap: 20, fontSize: 11, color: "#555" }}>
          {[["Ticks", stats.ticks], ["Candles", stats.candles],
            ["OC Snapshots", stats.option_chain_snapshots],
            ["Archived Options", stats.expired_options_archive]].map(([l, v]) => (
            <span key={l}>{l}: <b style={{ color: "#d1d4dc" }}>{Number(v).toLocaleString()}</b></span>
          ))}
        </div>
      )}

      {/* Replay controls */}
      {mode === "replay" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 16px",
                      background: "#12161f", borderBottom: "1px solid #1e2130", flexWrap: "wrap" }}>
          <input type="date" value={replayDate} onChange={e => setReplayDate(e.target.value)} style={inputSt} />
          <button onClick={checkReplay} style={smBtn}>Check</button>
          {replayInfo && (
            <>
              <span style={{ fontSize: 11, color: replayInfo.replay_possible ? "#26a69a" : "#ef5350" }}>
                {replayInfo.replay_possible
                  ? `✅ ${replayInfo.tick_count.toLocaleString()} ticks`
                  : "⚠️ Candle replay only"}
              </span>
              <label style={{ fontSize: 11, color: "#666", display: "flex", alignItems: "center", gap: 4 }}>
                Speed {replaySpeed}x
                <input type="range" min="1" max="50" value={replaySpeed}
                  onChange={e => setReplaySpeed(+e.target.value)} style={{ width: 70, marginLeft: 4 }} />
              </label>
              {!isReplaying
                ? <button onClick={startReplay}
                    style={{ ...smBtn, background: "#26a69a", color: "#000", fontWeight: 700 }}>▶ Start</button>
                : <button onClick={stopReplay}
                    style={{ ...smBtn, background: "#ef5350", color: "#fff" }}>■ Stop</button>
              }
            </>
          )}
        </div>
      )}

      {/* Main area */}
      <div ref={containerRef}
        style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0,
                 paddingBottom: bottomOpen ? bottomH + 4 : 0,
                 transition: "padding-bottom 0.2s" }}>

        <DrawingToolbar activeTool={drawTool} setActiveTool={setDrawTool}
          onClearAll={() => { localStorage.removeItem("dc_drawings"); setDrawingKey(k => k + 1); }} />

        {/* Chart pane */}
        <div ref={chartWrapRef}
          style={{ width: ocVisible ? `${splitPct}%` : "100%", minWidth: MIN_PANE_W,
                   position: "relative", display: "flex", flexDirection: "column",
                   transition: hDragging.current ? "none" : "width 0.2s" }}>

          {/* Loading overlay */}
          {!cacheReady && loadingTf && (
            <div style={{ position: "absolute", inset: 0, zIndex: 20,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          background: "#0f111799", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 13, color: "#2962ff" }}>{loadingTf}</div>
              <div style={{ fontSize: 11, color: "#444" }}>Loading all timeframes…</div>
            </div>
          )}

          <div ref={chartRef} style={{ flex: 1, width: "100%", minHeight: 0 }} />
          <DrawingTools
            key={drawingKey}
            chartObj={chartObj.current}
            series={candleSeries.current}
            containerRef={chartRef}
            activeTool={drawTool}
            onToolDone={() => setDrawTool("cursor")}
          />
        </div>

        {/* H divider */}
        {ocVisible && (
          <div onMouseDown={onHDivDown}
            style={{ width: 4, background: "#1e2130", cursor: "col-resize", flexShrink: 0, zIndex: 10 }}
            onMouseEnter={e => e.currentTarget.style.background = "#2962ff"}
            onMouseLeave={e => e.currentTarget.style.background = "#1e2130"} />
        )}

        {/* OC panel */}
        {ocVisible && (
          <div style={{ flex: 1, minWidth: MIN_PANE_W, overflow: "hidden",
                        borderLeft: "1px solid #1e2130" }}>
            <OptionChainPanel securityId={selected?.id} ltp={ltp} />
          </div>
        )}
      </div>

      {/* Bottom drawer */}
      {bottomOpen && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: bottomH,
                      background: "#0d1017", borderTop: "1px solid #1e2130",
                      zIndex: 50, display: "flex", flexDirection: "column" }}>
          <div onMouseDown={onVDivDown}
            style={{ height: 4, cursor: "row-resize", background: "#1e2130", flexShrink: 0 }}
            onMouseEnter={e => e.currentTarget.style.background = "#2962ff"}
            onMouseLeave={e => e.currentTarget.style.background = "#1e2130"} />
          <div style={{ display: "flex", gap: 2, padding: "4px 8px",
                        background: "#161b27", borderBottom: "1px solid #1e2130", flexShrink: 0 }}>
            {BOTTOM_TABS.map(t => (
              <button key={t} onClick={() => setBottomTab(t)} style={tabBtn(bottomTab === t)}>
                {BOTTOM_TAB_LABELS[t]}
              </button>
            ))}
            <button onClick={() => setBottomOpen(false)}
              style={{ marginLeft: "auto", background: "transparent", border: "none",
                       color: "#444", cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            {bottomTab === "oi"     && <OIChart securityId={selected?.id} ltp={ltp} />}
            {bottomTab === "pl"     && <PLCalculator ltp={ltp} securityId={selected?.id} />}
            {bottomTab === "alerts" && <AlertsPanel securityId={selected?.id} />}
          </div>
        </div>
      )}

      {/* Alert toasts */}
      <AlertToasts
        alerts={toastAlerts}
        onDismiss={(id) => setToastAlerts(a => a.filter(x => x.id !== id))}
      />
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────
const topBarSt = {
  display: "flex", alignItems: "center", gap: 4, padding: "6px 12px",
  background: "#161b27", borderBottom: "1px solid #1e2130",
  flexWrap: "wrap", minHeight: 46, flexShrink: 0,
};
const tabBtn = (active) => ({
  padding: "3px 10px", border: "none", borderRadius: 4, cursor: "pointer",
  background: active ? "#2962ff" : "#1e2130",
  color: active ? "#fff" : "#888", fontSize: 12, fontWeight: active ? 600 : 400,
});
const tfBtn = (active) => ({
  padding: "3px 8px", border: "none", borderRadius: 3, cursor: "pointer",
  background: active ? "#2a2d3a" : "transparent",
  color: active ? "#fff" : "#555", fontSize: 11,
});
const smBtn = {
  padding: "3px 10px", border: "none", borderRadius: 4,
  cursor: "pointer", background: "#2a2d3a", color: "#aaa", fontSize: 11,
};
const inputSt = {
  background: "#1e2130", color: "#d1d4dc", border: "1px solid #2a2d3a",
  borderRadius: 4, padding: "3px 8px", fontSize: 12,
};