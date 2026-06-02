/**
 * DrawingTools — SVG overlay on top of lightweight-charts
 * Tools: cursor, H-line, trend line, rectangle, Fibonacci retracement, text
 * Usage:
 *   <DrawingTools chartObj={chartObj.current} series={candleSeries.current}
 *                 containerRef={chartRef} activeTool={tool} />
 */
import { useEffect, useRef, useState, useCallback } from "react";

const COLORS = {
  hline:  "#2962ff",
  trend:  "#f59e0b",
  rect:   "#8b5cf6",
  fib:    "#10b981",
  text:   "#e2e8f0",
};

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export default function DrawingTools({ chartObj, series, containerRef, activeTool, onToolDone }) {
  const svgRef = useRef(null);
  const [drawings, setDrawings] = useState(() => {
    try { return JSON.parse(localStorage.getItem("dc_drawings") || "[]"); } catch { return []; }
  });
  const [draft, setDraft]       = useState(null);   // in-progress drawing
  const [selected, setSelected] = useState(null);   // selected drawing id
  const [svgSize, setSvgSize]   = useState({ w: 0, h: 0 });

  // Persist drawings
  useEffect(() => {
    localStorage.setItem("dc_drawings", JSON.stringify(drawings));
  }, [drawings]);

  // Sync SVG size to container
  useEffect(() => {
    if (!containerRef?.current) return;
    const ro = new ResizeObserver(([entry]) => {
      setSvgSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [containerRef]);

  const toCoords = useCallback((e) => {
    if (!svgRef.current || !chartObj || !series) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    const y    = e.clientY - rect.top;
    const time  = chartObj.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    return { x, y, time, price };
  }, [chartObj, series]);

  const toPixel = useCallback((time, price) => {
    if (!chartObj || !series) return { x: 0, y: 0 };
    return {
      x: chartObj.timeScale().timeToCoordinate(time) ?? 0,
      y: series.priceToCoordinate(price) ?? 0,
    };
  }, [chartObj, series]);

  // ── mouse events ──────────────────────────────────────────────────
  const onMouseDown = useCallback((e) => {
    if (activeTool === "cursor") return;
    const pt = toCoords(e);
    if (!pt || pt.time == null || pt.price == null) return;

    if (activeTool === "hline") {
      const id = Date.now();
      setDrawings(d => [...d, { id, type: "hline", price: pt.price, color: COLORS.hline }]);
      onToolDone?.();
      return;
    }
    if (activeTool === "text") {
      const label = prompt("Label text:");
      if (label) {
        setDrawings(d => [...d, { id: Date.now(), type: "text", time: pt.time, price: pt.price, label, color: COLORS.text }]);
      }
      onToolDone?.();
      return;
    }
    setDraft({ type: activeTool, start: pt, end: pt, color: COLORS[activeTool] });
  }, [activeTool, toCoords, onToolDone]);

  const onMouseMove = useCallback((e) => {
    if (!draft) return;
    const pt = toCoords(e);
    if (!pt) return;
    setDraft(d => ({ ...d, end: pt }));
  }, [draft, toCoords]);

  const onMouseUp = useCallback((e) => {
    if (!draft) return;
    const pt = toCoords(e);
    if (!pt) return;
    const final = { ...draft, end: pt, id: Date.now() };
    setDrawings(d => [...d, final]);
    setDraft(null);
    onToolDone?.();
  }, [draft, toCoords, onToolDone]);

  const deleteSelected = useCallback(() => {
    if (selected != null) {
      setDrawings(d => d.filter(dr => dr.id !== selected));
      setSelected(null);
    }
  }, [selected]);

  useEffect(() => {
    const handler = (e) => { if (e.key === "Delete" || e.key === "Backspace") deleteSelected(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [deleteSelected]);

  // ── render helpers ────────────────────────────────────────────────
  const renderDrawing = (d, preview = false) => {
    const sel = d.id === selected;
    const baseProps = {
      key: d.id ?? "draft",
      onClick: () => !preview && setSelected(sel ? null : d.id),
      style: { cursor: "pointer" },
    };
    const strokeProps = {
      stroke: d.color,
      strokeWidth: sel ? 2.5 : 1.5,
      strokeDasharray: preview ? "6 3" : undefined,
    };

    switch (d.type) {
      case "hline": {
        const y = series?.priceToCoordinate(d.price) ?? 0;
        return (
          <g {...baseProps}>
            <line x1={0} y1={y} x2={svgSize.w} y2={y} {...strokeProps} />
            <text x={6} y={y - 4} fill={d.color} fontSize={10}>
              {d.price?.toFixed(2)}
            </text>
            {sel && <line x1={0} y1={y} x2={svgSize.w} y2={y}
              stroke={d.color} strokeWidth={8} strokeOpacity={0.15} />}
          </g>
        );
      }

      case "trend": {
        const p1 = toPixel(d.start.time, d.start.price);
        const p2 = toPixel(d.end.time, d.end.price);
        return (
          <g {...baseProps}>
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} {...strokeProps} />
            {sel && <><circle cx={p1.x} cy={p1.y} r={4} fill={d.color} />
                      <circle cx={p2.x} cy={p2.y} r={4} fill={d.color} /></>}
          </g>
        );
      }

      case "rect": {
        const p1 = toPixel(d.start.time, d.start.price);
        const p2 = toPixel(d.end.time, d.end.price);
        const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
        const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);
        return (
          <g {...baseProps}>
            <rect x={x} y={y} width={w} height={h}
              fill={d.color} fillOpacity={0.08}
              stroke={d.color} strokeWidth={sel ? 2 : 1.5} />
          </g>
        );
      }

      case "fib": {
        const p1 = toPixel(d.start.time, d.start.price);
        const p2 = toPixel(d.end.time, d.end.price);
        const priceRange = d.end.price - d.start.price;
        return (
          <g {...baseProps}>
            {FIB_LEVELS.map(lvl => {
              const price = d.start.price + priceRange * lvl;
              const py = series?.priceToCoordinate(price) ?? 0;
              const opacity = sel ? 1 : 0.75;
              return (
                <g key={lvl}>
                  <line x1={Math.min(p1.x, p2.x)} y1={py}
                        x2={Math.max(p1.x, p2.x)} y2={py}
                    stroke={d.color} strokeWidth={1} strokeOpacity={opacity} />
                  <text x={Math.min(p1.x, p2.x) + 4} y={py - 3}
                    fill={d.color} fontSize={9} fillOpacity={opacity}>
                    {(lvl * 100).toFixed(1)}% — {price.toFixed(2)}
                  </text>
                </g>
              );
            })}
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
              stroke={d.color} strokeWidth={1} strokeDasharray="4 2"
              strokeOpacity={0.4} />
          </g>
        );
      }

      case "text": {
        const p = toPixel(d.time, d.price);
        return (
          <g {...baseProps}>
            <text x={p.x} y={p.y} fill={d.color} fontSize={12} fontWeight={500}
              style={{ userSelect: "none" }}>
              {d.label}
            </text>
            {sel && <circle cx={p.x} cy={p.y} r={3} fill={d.color} />}
          </g>
        );
      }

      default: return null;
    }
  };

  if (!chartObj || !series) return null;

  return (
    <svg
      ref={svgRef}
      width={svgSize.w} height={svgSize.h}
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: activeTool === "cursor" ? "none" : "all",
               zIndex: 5 }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {drawings.map(d => renderDrawing(d))}
      {draft && renderDrawing(draft, true)}
    </svg>
  );
}

// ── Toolbar component ─────────────────────────────────────────────
export function DrawingToolbar({ activeTool, setActiveTool, onClearAll }) {
  const tools = [
    { id: "cursor", icon: "↖", label: "Select / Move" },
    { id: "hline",  icon: "—", label: "Horizontal Line" },
    { id: "trend",  icon: "╱", label: "Trend Line" },
    { id: "rect",   icon: "▭", label: "Rectangle" },
    { id: "fib",    icon: "Ф", label: "Fibonacci" },
    { id: "text",   icon: "T", label: "Text Label" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2,
                  padding: "6px 4px", background: "#161b27",
                  borderRight: "1px solid #1e2130", alignItems: "center",
                  width: 32, flexShrink: 0 }}>
      {tools.map(t => (
        <button key={t.id} title={t.label}
          onClick={() => setActiveTool(t.id)}
          style={{
            width: 24, height: 24, border: "none", borderRadius: 3,
            background: activeTool === t.id ? "#2962ff" : "transparent",
            color: activeTool === t.id ? "#fff" : "#666",
            cursor: "pointer", fontSize: 13, display: "flex",
            alignItems: "center", justifyContent: "center",
          }}>
          {t.icon}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <button title="Clear all drawings" onClick={onClearAll}
        style={{ width: 24, height: 24, border: "none", borderRadius: 3,
                 background: "transparent", color: "#ef5350", cursor: "pointer", fontSize: 13 }}>
        🗑
      </button>
    </div>
  );
}