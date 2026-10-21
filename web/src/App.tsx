import { Arrow } from "./Arrow";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { getManifest, getModels, type Field, type Manifest, type ModelStatus } from "./data";
import {
  FLOW_CHOICES,
  flowFor,
  flowModel,
  format,
  LAYERS,
  lut,
  sourceModel,
  type FlowChoice,
  type Layer,
} from "./layers";
import { convert, saveSettings, settings, time as clock, windText, type Settings } from "./settings";
import { watchLayout } from "./layout";
import WeatherMap, { type Pick } from "./WeatherMap";
// The point chart loads when first opened.
const Meteogram = lazy(() => import("./Meteogram"));

const KN = 1.943844;

const PICKABLE = [
  { id: "gfs", label: "GFS" },
  { id: "ecmwf", label: "ECMWF" },
  { id: "icon", label: "ICON" },
];

const day = { format: clock.day };
const hour = { format: clock.hour };

function ago(iso: string) {
  const h = (Date.now() - Date.parse(iso)) / 3.6e6;
  return h < 1 ? "under 1 h ago" : `${Math.round(h)} h ago`;
}

function useRun(models: ModelStatus[], id: string) {
  const status = models.find((m) => m.id === id);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  useEffect(() => {
    setManifest(null);
    if (status?.run_id)
      getManifest(id, status.run_id, status.ingested)
        .then(setManifest)
        .catch(() => {}); // retried on the next models poll
  }, [id, status?.run_id, status?.ingested]);
  // Until the new manifest arrives, report nothing rather than the previous model's run.
  const current = manifest?.model === id ? manifest : null;
  return { status, manifest: current, runId: current ? (status?.run_id ?? null) : null };
}

type PointNow = { wind?: { kn: number; from: number; gust?: number }; wave?: { m: number; from?: number } };

/** Wind and waves at a point for the shown time, from the chosen model and its wave model. */
function usePointNow(at: Pick | null, model: string, time: number | undefined): PointNow | null {
  const [state, setState] = useState<PointNow | null>(null);
  useEffect(() => {
    setState(null);
    if (!at || time == null) return;
    const ctl = new AbortController();
    const q = new URLSearchParams({
      lat: at.lat.toFixed(3),
      lon: at.lon.toFixed(3),
      models: `${model},${model}-wave`,
      vars: "wind_u,wind_v,gust,wave_height,wave_dir",
    });
    fetch(`/v1/point?${q}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        const out: PointNow = {};
        const nearest = (times: number[]) =>
          times.reduce((b, t, i) => (Math.abs(t * 1000 - time) < Math.abs(times[b] * 1000 - time) ? i : b), 0);
        for (const m of j.models ?? []) {
          if (!m.series) continue;
          const i = nearest(m.times);
          if (Math.abs(m.times[i] * 1000 - time) > 3 * 3600e3) continue;
          const s = m.series;
          if (s.wind_speed?.[i] != null)
            out.wind = {
              kn: s.wind_speed[i] * KN,
              from: Math.round(s.wind_dir[i]),
              gust: s.gust?.[i] != null ? s.gust[i] * KN : undefined,
            };
          if (s.wave_height?.[i] != null)
            out.wave = { m: s.wave_height[i], from: s.wave_dir?.[i] != null ? Math.round(s.wave_dir[i]) : undefined };
        }
        setState(out);
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [at, model, time]);
  return state;
}

const ICONS: Record<string, string> = {
  wind: "🌬",
  gust: "💨",
  rain: "🌧",
  rain24: "☔",
  temp: "🌡",
  cloud: "☁",
  visibility: "🌫",
  storms: "⛈",
  jet: "✈",
  waves: "🌊",
  swell: "〰",
  currents: "🧭",
};
const LAYER_GROUPS = [
  { label: "Weather", ids: ["wind", "gust", "rain", "rain24", "temp", "cloud", "visibility", "storms", "jet"] },
  { label: "Sea", ids: ["waves", "swell", "currents"] },
];

/** A view setting: from the URL when it has one (a shared link), else what this browser last used. */
const VIEW_KEY = "openwind-view";
const urlQ = new URLSearchParams(location.search);
const saved: Record<string, string | null> = (() => {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}");
  } catch {
    return {};
  }
})();
const initial = (k: string): string | null => (urlQ.has(k) ? urlQ.get(k) : (saved[k] ?? null));

export default function App() {
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [picked, setPicked] = useState(() => {
    const m = initial("model");
    return PICKABLE.some((p) => p.id === m) ? m! : "ecmwf";
  });
  const [layer, setLayer] = useState<Layer>(() => LAYERS.find((l) => l.id === initial("layer")) ?? LAYERS[0]);
  const [flowChoice, setFlowChoice] = useState<FlowChoice>(
    () => FLOW_CHOICES.find((f) => f.id === initial("flow"))?.id ?? "auto",
  );
  const [time, setTime] = useState(() => Date.now());
  const [pick, setPick] = useState<Pick | null>(null);
  const [hover, setHover] = useState<(Pick & { x: number; y: number }) | null>(null);
  const [fields, setFields] = useState<Record<string, Field>>({});
  const [playing, setPlaying] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    addEventListener("online", on);
    addEventListener("offline", on);
    return () => {
      removeEventListener("online", on);
      removeEventListener("offline", on);
    };
  }, []);
  const [, rerender] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  // The settings menu closes on a tap anywhere outside it (or Escape), like a native menu.
  useEffect(() => {
    if (!showSettings) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest(".settings, .gear")) setShowSettings(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setShowSettings(false);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", esc);
    };
  }, [showSettings]);
  // Panels never overlap (layout.ts): placed from measured bars, hidden while something covers them.
  useEffect(() => watchLayout(document.querySelector<HTMLElement>(".app")!), []);
  const setPref = (next: Partial<Settings>) => {
    saveSettings({ ...settings, ...next });
    rerender((n) => n + 1);
  };
  const [satellite, setSatellite] = useState(() => initial("sat") === "1");
  const [layersOpen, setLayersOpen] = useState(false);
  // Escape closes the layer menu and puts focus back on its button.
  useEffect(() => {
    if (!layersOpen) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setLayersOpen(false);
      document.querySelector<HTMLButtonElement>(".layer-btn")?.focus();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [layersOpen]);

  useEffect(() => {
    const load = () =>
      getModels()
        .then(setModels)
        .catch(() => {});
    load();
    const t = setInterval(load, 10 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    // The view in the URL (to share) and in this browser (so the next visit opens the same way).
    const view: Record<string, string | null> = {
      model: picked,
      layer: layer.id,
      flow: flowChoice === "auto" ? null : flowChoice,
      sat: satellite ? "1" : null,
    };
    for (const [k, v] of Object.entries(view)) {
      if (v == null) q.delete(k);
      else q.set(k, v);
    }
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // private mode or storage off: the URL still holds the view
    }
    history.replaceState(null, "", `?${q}${location.hash}`);
  }, [picked, layer, satellite, flowChoice]);

  const source = useRun(models, sourceModel(layer, picked));
  // Particles: by default the layer's own field; the viewer can pick another (wind over currents, and so on).
  const flow = flowFor(layer, flowChoice);
  const windModel = useRun(models, flowModel(flow, picked));
  const times = useMemo(() => source.manifest?.valid_times ?? [], [source.manifest]);
  const idx = times.length ? times.reduce((b, t, i) => (Math.abs(t - time) < Math.abs(times[b] - time) ? i : b), 0) : 0;

  useEffect(() => {
    if (!playing || !times.length) return;
    const t = setInterval(() => setTime(times[(idx + 1) % times.length]), 700);
    return () => clearInterval(t);
  }, [playing, idx, times]);

  // What the loaded fields say at a point: the layer's value, plus wind (or current) direction.
  const describe = (lon: number, lat: number) => {
    const at = (v: string) => fields[v]?.at(lon, lat) ?? NaN;
    const speed = (p: string, [a, b]: string[]) => Math.hypot(at(p + a), at(p + b));
    const value = layer.scalar.length === 2 ? speed("", layer.scalar) : at(layer.scalar[0]);
    let dir = "";
    let extra = "";
    if (layer.vector) {
      const u = at(layer.vector[0]);
      const v = at(layer.vector[1]);
      if (Number.isFinite(u) && Number.isFinite(v)) {
        const from = Math.round(((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360);
        if (layer.family === "ocean" && layer.scalar.length === 2) dir = ` towards ${(from + 180) % 360}°`;
        else if (layer.family === "ocean")
          extra = `Current ${(Math.hypot(u, v) * KN).toFixed(1)} kn towards ${(from + 180) % 360}°`;
        else if (layer.scalar.length === 2) dir = ` from ${from}°`;
        else extra = `Wind ${windText(Math.hypot(u, v) * KN)} from ${from}°`;
      }
    }
    if (flow.vars && flow.vars[0] !== layer.vector?.[0]) {
      const u = at(flow.vars[0]);
      const v = at(flow.vars[1]);
      if (Number.isFinite(u) && Number.isFinite(v)) {
        const from = Math.round(((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360);
        const kn = Math.hypot(u, v) * KN;
        const line =
          flow.kind === "currents"
            ? `Current ${kn.toFixed(1)} kn towards ${(from + 180) % 360}°`
            : `Wind ${windText(kn)} from ${from}°`;
        extra = extra ? `${extra} · ${line}` : line;
      }
    }
    const hpa = layer.also?.includes("mslp") ? at("mslp") / 100 : NaN;
    if (Number.isFinite(hpa)) extra = extra ? `${extra} · ${Math.round(hpa)} hPa` : `${Math.round(hpa)} hPa`;
    return { main: `${format(layer, value)}${dir}`, extra };
  };
  const readout = pick ? describe(pick.lon, pick.lat).main : null;
  const hoverInfo = hover ? describe(hover.lon, hover.lat) : null;
  const hoverPoint = usePointNow(hover, picked, times[idx]);
  const latlon = (p: Pick) =>
    `${Math.abs(p.lat).toFixed(2)}°${p.lat < 0 ? "S" : "N"} ${Math.abs(((p.lon + 540) % 360) - 180).toFixed(2)}°${((p.lon + 540) % 360) - 180 < 0 ? "W" : "E"}`;

  const legend = lut(layer);
  const status = source.status;

  return (
    <div className="app">
      <WeatherMap
        layer={layer}
        manifest={source.manifest}
        runId={source.runId}
        vectorManifest={flow.kind === "off" ? null : windModel.manifest}
        vectorRunId={flow.kind === "off" ? null : windModel.runId}
        flow={flow}
        time={times[idx] ?? time}
        pick={pick}
        onPick={(p) => {
          if (layersOpen) return setLayersOpen(false); // a tap on the map first closes the layer menu
          setPick((old) => (old ? null : p)); // a second tap on the map closes the forecast
        }}
        onLocate={setPick}
        onFields={setFields}
        onHover={setHover}
        satellite={satellite}
      />

      <header className="top">
        <a className="brand" href="/about.html" title="About, sources and credits">
          OpenWind
        </a>
        <div className="tools">
          <div className="seg" role="group" aria-label="Model">
            {PICKABLE.map((m) => (
              <button key={m.id} aria-pressed={picked === m.id} onClick={() => setPicked(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <button
            className="gear"
            aria-label="Settings"
            aria-expanded={showSettings}
            onClick={() => {
              setShowSettings(!showSettings);
              setLayersOpen(false);
            }}
          >
            ⚙
          </button>
          {showSettings && (
            <div className="settings">
              <label>
                Wind
                <select value={settings.wind} onChange={(e) => setPref({ wind: e.target.value as Settings["wind"] })}>
                  {["kn", "m/s", "km/h", "mph"].map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              </label>
              <label>
                Temperature
                <select value={settings.temp} onChange={(e) => setPref({ temp: e.target.value as Settings["temp"] })}>
                  {["°C", "°F"].map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              </label>
              <label>
                Times
                <select value={settings.tz} onChange={(e) => setPref({ tz: e.target.value as Settings["tz"] })}>
                  <option value="local">This device</option>
                  <option value="UTC">UTC</option>
                </select>
              </label>
              <p className="muted small">
                <a href="/about.html">About</a> · <a href="/credits.html">Credits</a>
              </p>
            </div>
          )}
        </div>
      </header>

      <div className="layer-box">
        <button className="layer-btn" aria-expanded={layersOpen} onClick={() => setLayersOpen(!layersOpen)}>
          <span className="icon">{ICONS[layer.id]}</span> <span className="label">{layer.label}</span>
          {satellite && <span className="badges"> · Satellite</span>}
          <span className="chev">{layersOpen ? "▴" : "▾"}</span>
        </button>
        {layersOpen && (
          <nav className="layer-menu" aria-label="Layers">
            {LAYER_GROUPS.map((g) => (
              <div key={g.label} className="group">
                <div className="group-label">{g.label}</div>
                <div className="grid">
                  {g.ids.map((id) => {
                    const l = LAYERS.find((x) => x.id === id)!;
                    return (
                      <button
                        key={id}
                        aria-pressed={layer.id === id}
                        onClick={() => {
                          setLayer(l);
                          setLayersOpen(false);
                        }}
                      >
                        <span className="icon">{ICONS[id]}</span>
                        {l.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="group">
              <div
                className="group-label"
                title="Show a second field as moving particles over the colours, such as wind over currents"
              >
                Particles
              </div>
              <div className="flow-row" role="radiogroup" aria-label="Particles">
                {FLOW_CHOICES.map((f) => (
                  <button
                    key={f.id}
                    role="radio"
                    aria-checked={flowChoice === f.id}
                    aria-pressed={flowChoice === f.id}
                    onClick={() => setFlowChoice(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="group">
              <div className="group-label">Overlays</div>
              <div className="toggles">
                <button
                  className="toggle"
                  aria-pressed={satellite}
                  onClick={() => setSatellite(!satellite)}
                  title="Latest infrared satellite image (NASA GIBS, about 10 minutes old)"
                >
                  <span className="icon">🛰</span> Satellite <span className="switch" />
                </button>
              </div>
            </div>
          </nav>
        )}
      </div>

      {pick && (
        <div className="readout">
          <div>
            <b>{readout}</b>
            <span>{latlon(pick)}</span>
          </div>
          <button onClick={() => setPick(null)} aria-label="Close">
            ×
          </button>
        </div>
      )}

      {hoverInfo && hover && (
        <div
          className="hover-card"
          style={{
            left: hover.x + 280 > innerWidth ? hover.x - 270 : hover.x + 16,
            top: hover.y + 110 > innerHeight ? hover.y - 100 : hover.y + 16,
          }}
        >
          {!["wind", "waves"].includes(layer.id) && (
            <span>
              <span className="muted">{layer.label}</span> <b>{hoverInfo.main}</b>
            </span>
          )}
          {flow.kind === "currents" && layer.family !== "ocean" && /Current ([^·]+)/.test(hoverInfo.extra) && (
            <span>
              <span className="muted">Current</span> <b>{hoverInfo.extra.match(/Current ([^·]+)/)![1].trim()}</b>
            </span>
          )}
          <span>
            <span className="muted">Wind</span>{" "}
            {hoverPoint === null ? (
              "…"
            ) : hoverPoint.wind ? (
              <>
                <b>{windText(hoverPoint.wind.kn)}</b> <Arrow from={hoverPoint.wind.from} /> {hoverPoint.wind.from}°
                {hoverPoint.wind.gust != null && (
                  <span className="muted"> · gust {windText(hoverPoint.wind.gust)}</span>
                )}
              </>
            ) : (
              "–"
            )}
          </span>
          <span>
            <span className="muted">Waves</span>{" "}
            {hoverPoint === null ? (
              "…"
            ) : hoverPoint.wave ? (
              <>
                <b>{hoverPoint.wave.m.toFixed(1)} m</b>
                {hoverPoint.wave.from != null && (
                  <>
                    {" "}
                    <Arrow from={hoverPoint.wave.from} /> {hoverPoint.wave.from}°
                  </>
                )}
              </>
            ) : (
              <span className="muted">none (land)</span>
            )}
          </span>
          <span className="muted">{latlon(hover)}</span>
        </div>
      )}

      {pick && (
        <Suspense fallback={null}>
          <Meteogram pick={pick} time={times[idx]} onTime={setTime} />
        </Suspense>
      )}

      <footer className="timeline">
        <div className="row">
          <button className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <div className="when">
            <div>
              {times.length ? (
                <>
                  <span className="forecast-tag">Forecast </span>
                  <b>{day.format(times[idx])}</b> {hour.format(times[idx])} {clock.zone()}
                </>
              ) : (
                "loading…"
              )}
            </div>
            <div className="runline">
              {!online && <b className="offline">Offline · </b>}
              {status?.run && (
                <span title={status.attribution}>
                  {status.name} {new Date(status.run).toISOString().slice(11, 13)}Z run · {ago(status.run)}
                  {status.status === "late" && <b className="offline"> · next run late</b>}
                  {layer.models && !layer.models.includes(picked)
                    ? ` · ${layer.label.toLowerCase()} from ${status.name}`
                    : ""}
                </span>
              )}
            </div>
          </div>
          <div
            className="legend"
            role="img"
            aria-label={`${layer.label} scale${flow.kind !== "off" ? `, ${flow.label.toLowerCase()} particles` : ""}`}
          >
            {/* Particles showing something other than the colours (wind over currents, and so on): say so. */}
            {flow.kind !== "off" &&
              !(flow.vars?.[0] === layer.scalar[0] || (flow.kind === "waves" && layer.id === "waves")) && (
                <span className="flow-chip" title="The moving particles show this, not the colours">
                  <i style={{ background: flow.colour }} /> {flow.label} particles
                </span>
              )}
            <span>{layer.legend?.[0] ?? Math.round(convert(layer.unit, legend.lo).v)}</span>
            <i
              style={{
                background: `linear-gradient(90deg, ${layer.ramp.map(([v, c]) => `${c} ${(((v - legend.lo) / (legend.hi - legend.lo)) * 100).toFixed(1)}%`).join(",")})`,
              }}
            />
            <span>
              {layer.legend?.[1] ?? `${Math.round(convert(layer.unit, legend.hi).v)} ${convert(layer.unit, 0).unit}`}
            </span>
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0, times.length - 1)}
          value={idx}
          onChange={(e) => {
            setPlaying(false);
            setTime(times[+e.target.value]);
          }}
          aria-label="Forecast time"
        />
        <div className="credit">
          <span className="long">
            Not for navigation · <a href="/credits.html">Credits</a> · Data: NOAA, ECMWF, DWD
            {satellite ? ", NASA" : ""} · © OpenStreetMap
          </span>
          <span className="short">
            Not for nav · <a href="/credits.html">Credits</a> · © OSM · NOAA, ECMWF, DWD{satellite ? ", NASA" : ""}
          </span>
        </div>
      </footer>
    </div>
  );
}
