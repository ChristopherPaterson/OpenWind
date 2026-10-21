import { MODEL_COLOURS as COLOURS } from "./models";
import { useEffect, useRef, useState } from "react";
import { convert, midnights, time, windText } from "./settings";
import type { Pick } from "./WeatherMap";

type Series = Record<string, (number | null)[]>;
type ModelPoint = { model: string; name: string; run: string; times: number[]; series: Series };

const KN = 1.943844;
const day = { format: time.weekday };
const when = { format: time.when };
const CURRENT = "#3cc0a0";

type Panel = "waves" | "current";
type Props = { pick: Pick; time?: number; onTime: (t: number) => void };

/** Hour-by-hour wind, gust, waves and current at one point, every model on the same axes. */
export default function Meteogram({ pick, time, onTime }: Props) {
  const [data, setData] = useState<ModelPoint[] | null>(null);
  const [error, setError] = useState("");
  const box = useRef<HTMLElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel>("waves");
  const [W, setW] = useState(900);
  // Line paths by model, variable, size and scale, for this data and width: a pointer move redraws only the
  // hover line and the tip, not every path.
  const paths = useRef({ data: null as ModelPoint[] | null, W: 0, d: new Map<string, string>() });

  // Draw in real pixels so text stays readable on a phone.
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [data]);

  useEffect(() => {
    setData(null);
    setError("");
    const q = new URLSearchParams({
      lat: pick.lat.toFixed(3),
      lon: pick.lon.toFixed(3),
      models: "gfs,ecmwf,icon,gfs-wave,ecmwf-wave,icon-wave",
      vars: "wind_u,wind_v,gust,wave_height,current_u,current_v",
    });
    const ctl = new AbortController();
    fetch(`/v1/point?${q}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => setData(j.models.filter((m: ModelPoint & { error?: string }) => !m.error && m.series)))
      .catch((e) => e.name !== "AbortError" && setError("Forecast unavailable"));
    return () => ctl.abort();
  }, [pick]);

  if (error) return <section className="meteogram">{error}</section>;
  if (!data) return <section className="meteogram">Loading forecast…</section>;
  if (!data.length) return <section className="meteogram">No forecast here (outside the covered region).</section>;

  const atmos = data.filter((m) => !m.model.endsWith("-wave"));
  const waves = data.filter((m) => m.model.endsWith("-wave"));
  // Currents: ECMWF's ocean surface current (no tides), the only model here that has them.
  const current = data.find((m) => m.model === "ecmwf" && m.series.current_speed?.some((v) => v != null));
  const all = data.flatMap((m) => m.times);
  const t0 = Math.min(...all) * 1000;
  const t1 = Math.max(...all) * 1000;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  if (paths.current.data !== data || paths.current.W !== W) paths.current = { data, W, d: new Map() };

  const chart = (models: ModelPoint[], keys: string[], scale: number, unit: string, h: number) => {
    const max = Math.max(
      1,
      ...models.flatMap((m) => keys.flatMap((k) => (m.series[k] ?? []).map((v) => (v ?? 0) * scale))),
    );
    const unitStep = max <= 6 ? 1 : max <= 20 ? 5 : 10;
    const top = Math.ceil(max / unitStep / 2) * unitStep * 2; // even, so the halfway line is a whole number
    const y = (v: number) => h - 4 - (v / top) * (h - 14);
    const path = (m: ModelPoint, k: string) => {
      const key = `${m.model}|${k}|${h}|${scale}|${top}`;
      let d = paths.current.d.get(key);
      if (d === undefined) {
        d = m.times
          .map((t, i) => [t, m.series[k]?.[i]] as const)
          .filter(([, v]) => v != null)
          .map(([t, v], i) => `${i ? "L" : "M"}${x(t * 1000).toFixed(1)},${y(v! * scale).toFixed(1)}`)
          .join("");
        paths.current.d.set(key, d);
      }
      return d;
    };
    return (
      <svg viewBox={`0 0 ${W} ${h}`} width={W} height={h} className="chart">
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={0} x2={W} y1={y(top * f)} y2={y(top * f)} className="grid" />
            <text x={4} y={y(top * f) + 11} className="axis">{`${top * f} ${unit}`}</text>
          </g>
        ))}
        {models.flatMap((m) =>
          keys.map((k, j) => (
            <path
              key={`${m.model}${k}`}
              d={path(m, k)}
              stroke={COLOURS[m.model]}
              strokeDasharray={j ? "4 3" : undefined}
              fill="none"
              strokeWidth={j ? 1.2 : 2}
            />
          )),
        )}
        {time && <line x1={x(time)} x2={x(time)} y1={0} y2={h} className="now" />}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={h} className="hover" />}
      </svg>
    );
  };

  // Midnight ticks in the viewer's time zone.
  const days = midnights(t0, t1);

  const timeAt = (e: React.MouseEvent | React.PointerEvent) => {
    const r = (e.currentTarget.querySelector(".chart") as SVGElement).getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    return f >= 0 && f <= 1 ? t0 + f * (t1 - t0) : null;
  };
  const nearest = (m: ModelPoint, t: number) => {
    let best = 0;
    m.times.forEach((u, i) => {
      if (Math.abs(u * 1000 - t) < Math.abs(m.times[best] * 1000 - t)) best = i;
    });
    // Only report a model where it has a step within 3 hours of the cursor.
    return Math.abs(m.times[best] * 1000 - t) <= 3 * 3600e3 ? best : -1;
  };
  const tip = hover != null && (
    <div className="tip" style={{ left: `${Math.min(80, Math.max(0, (x(hover) / W) * 100))}%` }}>
      <b>{when.format(hover)}</b>
      {atmos.map((m) => {
        const i = nearest(m, hover);
        const u = m.series.wind_u?.[i];
        const v = m.series.wind_v?.[i];
        if (i < 0 || u == null || v == null) return null;
        const from = Math.round(((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360);
        const g = m.series.gust?.[i];
        return (
          <span key={m.model} style={{ color: COLOURS[m.model] }}>
            {m.name}: {windText(Math.hypot(u, v) * KN)} from {from}°{g != null ? `, gust ${windText(g * KN)}` : ""}
          </span>
        );
      })}
      {current &&
        (() => {
          const i = nearest(current, hover);
          const s = current.series.current_speed?.[i];
          const d = current.series.current_dir?.[i];
          return i < 0 || s == null ? null : (
            <span style={{ color: CURRENT }}>
              Current (ECMWF): {(s * KN).toFixed(1)} kn towards {Math.round(d ?? 0)}°
            </span>
          );
        })()}
      {waves.map((m) => {
        const i = nearest(m, hover);
        const h = m.series.wave_height?.[i];
        return i < 0 || h == null ? null : (
          <span key={m.model} style={{ color: COLOURS[m.model] }}>
            {m.name}: waves {h.toFixed(1)} m
          </span>
        );
      })}
    </div>
  );

  // The wind chart, then one more panel at a time (tabs), so the card stays small on any screen.
  const narrow = W < 560;
  const panels: [Panel, string][] = [];
  if (waves.some((m) => m.series.wave_height?.some((v) => v != null))) panels.push(["waves", "Waves"]);
  if (current) panels.push(["current", "Current"]);
  const shown = (p: Panel) => p === (panels.some(([id]) => id === panel) ? panel : panels[0]?.[0]);

  return (
    <section ref={box} className={`meteogram ${narrow ? "narrow" : ""}`}>
      <div className="key">
        {atmos.map((m) => (
          <span key={m.model} style={{ color: COLOURS[m.model] }}>
            ● {m.name}
            {m.run ? ` ${new Date(m.run).toISOString().slice(11, 13)}Z` : ""}
          </span>
        ))}
        <span>solid wind · dashed gust</span>
      </div>
      {/* Pointer and taps act on the charts only, not the text above. */}
      <div
        className="charts"
        onClick={(e) => {
          const t = timeAt(e);
          if (t != null) onTime(t);
        }}
        onPointerMove={(e) => setHover(timeAt(e))}
        onPointerLeave={() => setHover(null)}
      >
        {tip}
        {chart(
          atmos.map((m) => ({
            ...m,
            series: {
              ...m.series,
              speed: m.series.wind_u.map((u, i) =>
                u == null || m.series.wind_v[i] == null ? null : Math.hypot(u, m.series.wind_v[i]!),
              ),
            },
          })),
          ["speed", "gust"],
          KN * convert("kn", 1).v,
          convert("kn", 1).unit,
          narrow ? 100 : 150,
        )}
        {panels.length > 1 && (
          <div
            className="chart-tabs"
            role="tablist"
            onClick={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            onPointerEnter={() => setHover(null)}
          >
            {panels.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={shown(id)} onClick={() => setPanel(id)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {shown("waves") &&
          panels.some(([id]) => id === "waves") &&
          chart(waves, ["wave_height"], 1, "m", narrow ? 80 : 90)}
        {shown("current") && current && (
          <div className="current-chart">
            {chart([{ ...current, model: "current" }], ["current_speed"], KN, "kn", narrow ? 80 : 90)}
            <div className="current-arrows" aria-hidden>
              {current.times.map((t, i) => {
                const d = current.series.current_dir?.[i];
                // Arrows pointing where the water goes: every ~6 hours, and at least 16 px apart.
                const stepH = (current.times[1] - current.times[0]) / 3600 || 6;
                const pxPerStep = x((current.times[0] + stepH * 3600) * 1000) - x(current.times[0] * 1000) || 1;
                const every = Math.max(1, Math.round(6 / stepH), Math.ceil(16 / pxPerStep));
                if (d == null || i % every) return null;
                return (
                  <span
                    key={t}
                    style={{ left: `${(x(t * 1000) / W) * 100}%`, transform: `translateX(-50%) rotate(${d}deg)` }}
                  >
                    ↑
                  </span>
                );
              })}
            </div>
            <span className="current-label">Current · ECMWF (no tides)</span>
          </div>
        )}
        <div className="days">
          {days.map((t) => (
            <span key={t} style={{ left: `${(x(t) / W) * 100}%` }}>
              {day.format(t)}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
