import { convert } from "./settings";

// What each map layer draws: which model family, which variables, display units and colours.

export type Family = "atmos" | "wave" | "ocean";

export type Layer = {
  id: string;
  label: string;
  family: Family;
  scalar: string[]; // variables combined into the shaded value
  vector?: [string, string]; // u, v for particles
  waveDir?: string; // a "coming from" direction drawn as particles travelling the other way
  unit: string;
  toDisplay: (si: number) => number;
  ramp: [number, string][]; // display value, colour
  digits: number;
  isobars?: boolean; // contours and highs and lows from the mslp field in `also`
  seaOnly?: boolean;
  models?: string[]; // limits the model picker, e.g. swell partitions are GFS-Wave only
  also?: string[]; // more fields loaded for the hover readout only
  legend?: [string, string]; // words for the scale's ends instead of numbers
};

const KN = 1.943844;

const WIND_RAMP: [number, string][] = [
  [0, "#2b3f8f"],
  [5, "#2f6db3"],
  [10, "#2fa6b8"],
  [15, "#3cb96a"],
  [20, "#a7c93a"],
  [25, "#f0c43a"],
  [30, "#f08a2c"],
  [35, "#e0452a"],
  [40, "#b8236a"],
  [50, "#7a2a9a"],
  [65, "#f2e6ff"],
];

export const LAYERS: Layer[] = [
  // Wind with pressure: isobars and highs and lows over the wind colours (pressure in the readout too).
  {
    id: "wind",
    label: "Wind",
    family: "atmos",
    scalar: ["wind_u", "wind_v"],
    vector: ["wind_u", "wind_v"],
    also: ["mslp"],
    unit: "kn",
    toDisplay: (v) => v * KN,
    ramp: WIND_RAMP,
    digits: 0,
    isobars: true,
  },
  {
    id: "gust",
    label: "Gusts",
    family: "atmos",
    scalar: ["gust"],
    vector: ["wind_u", "wind_v"],
    unit: "kn",
    toDisplay: (v) => v * KN,
    ramp: WIND_RAMP,
    digits: 0,
  },
  {
    id: "rain",
    label: "Rain",
    family: "atmos",
    scalar: ["precip_rate"],
    unit: "mm/h",
    toDisplay: (v) => v * 3600,
    digits: 1,
    ramp: [
      [0, "#1a2340"],
      [0.2, "#2a4f8a"],
      [1, "#2f8fd0"],
      [2, "#3cc0a0"],
      [5, "#e8d23a"],
      [10, "#f08a2c"],
      [20, "#e0452a"],
      [50, "#b8236a"],
    ],
  },
  {
    id: "rain24",
    label: "Rain 24 h",
    family: "atmos",
    scalar: ["precip_24h"],
    unit: "mm",
    toDisplay: (v) => v,
    digits: 0,
    ramp: [
      [0, "#1a2340"],
      [1, "#2a4f8a"],
      [5, "#2f8fd0"],
      [10, "#3cc0a0"],
      [25, "#e8d23a"],
      [50, "#f08a2c"],
      [100, "#e0452a"],
      [200, "#b8236a"],
    ],
  },
  {
    id: "temp",
    label: "Temperature",
    family: "atmos",
    scalar: ["temp_2m"],
    unit: "°C",
    toDisplay: (v) => v - 273.15,
    digits: 0,
    ramp: [
      [-10, "#5a3a9a"],
      [0, "#3a5fc0"],
      [8, "#3aa0c8"],
      [15, "#3cb96a"],
      [22, "#e8d23a"],
      [30, "#f08a2c"],
      [38, "#d02a2a"],
      [45, "#7a1a3a"],
    ],
  },
  {
    id: "cloud",
    label: "Cloud",
    family: "atmos",
    scalar: ["cloud"],
    unit: "%",
    toDisplay: (v) => v * 100,
    digits: 0,
    ramp: [
      [0, "#14213a"],
      [30, "#3a4a66"],
      [60, "#7a8aa6"],
      [100, "#e6ecf5"],
    ],
  },
  {
    id: "visibility",
    label: "Visibility",
    family: "atmos",
    scalar: ["visibility"],
    vector: ["wind_u", "wind_v"],
    models: ["gfs"],
    unit: "km",
    toDisplay: (v) => v / 1000,
    digits: 1,
    ramp: [
      [0, "#e0452a"],
      [1, "#f08a2c"],
      [2, "#e8d23a"],
      [5, "#7fae7a"],
      [10, "#3a6a8a"],
      [25, "#14213a"],
    ],
  },
  {
    id: "storms",
    label: "Storms",
    family: "atmos",
    scalar: ["cape"],
    vector: ["wind_u", "wind_v"],
    unit: "J/kg",
    toDisplay: (v) => v,
    digits: 0,
    ramp: [
      [0, "#14213a"],
      [250, "#2a4f8a"],
      [500, "#2f8fd0"],
      [1000, "#3cc0a0"],
      [1500, "#e8d23a"],
      [2500, "#f08a2c"],
      [3500, "#e0452a"],
      [5000, "#b8236a"],
    ],
  },
  {
    id: "jet",
    label: "Jet stream",
    family: "atmos",
    models: ["gfs", "ecmwf"],
    scalar: ["wind250_u", "wind250_v"],
    vector: ["wind250_u", "wind250_v"],
    unit: "kn",
    toDisplay: (v) => v * KN,
    digits: 0,
    ramp: [
      [0, "#14213a"],
      [40, "#2a4f8a"],
      [70, "#2f8fd0"],
      [100, "#3cc0a0"],
      [130, "#e8d23a"],
      [160, "#f08a2c"],
      [200, "#e0452a"],
      [250, "#f2e6ff"],
    ],
  },
  {
    id: "waves",
    label: "Waves",
    family: "wave",
    scalar: ["wave_height"],
    waveDir: "wave_dir",
    unit: "m",
    toDisplay: (v) => v,
    digits: 1,
    seaOnly: true,
    ramp: [
      [0, "#24306e"],
      [0.5, "#2a5fa8"],
      [1, "#2fa0b8"],
      [2, "#3cb96a"],
      [3, "#e8d23a"],
      [4, "#f08a2c"],
      [6, "#e0452a"],
      [9, "#a0236a"],
      [14, "#f2e6ff"],
    ],
  },
  {
    id: "swell",
    label: "Swell",
    family: "wave",
    scalar: ["swell1_height"],
    waveDir: "swell1_dir",
    unit: "m",
    toDisplay: (v) => v,
    digits: 1,
    seaOnly: true,
    models: ["gfs", "icon"],
    ramp: [
      [0, "#24306e"],
      [0.5, "#2a5fa8"],
      [1, "#2fa0b8"],
      [2, "#3cb96a"],
      [3, "#e8d23a"],
      [4, "#f08a2c"],
      [6, "#e0452a"],
      [9, "#a0236a"],
    ],
  },
  {
    id: "currents",
    label: "Currents",
    family: "ocean",
    scalar: ["current_u", "current_v"],
    vector: ["current_u", "current_v"],
    unit: "kn",
    toDisplay: (v) => v * KN,
    digits: 1,
    seaOnly: true,
    models: ["ecmwf"], // ECMWF's ocean surface currents (no tides), the only model here that has them
    ramp: [
      [0, "#14213a"],
      [0.25, "#2a4f8a"],
      [0.5, "#2f8fd0"],
      [1, "#3cc0a0"],
      [1.5, "#e8d23a"],
      [2, "#f08a2c"],
      [3, "#e0452a"],
      [4, "#f2e6ff"],
    ],
  },
];

/** The API model behind a layer for the chosen model family member. */
export function sourceModel(layer: Layer, picked: string): string {
  const base = layer.models && !layer.models.includes(picked) ? layer.models[0] : picked;
  if (layer.family === "wave") return `${base}-wave`;
  return base;
}

/** 256-entry RGBA lookup over [lo, hi] in display units. */
export function lut(layer: Layer): { lo: number; hi: number; rgba: Uint8ClampedArray } {
  const stops = layer.ramp.map(([v, c]) => [
    v,
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ]);
  const lo = stops[0][0];
  const hi = stops[stops.length - 1][0];
  const rgba = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = lo + ((hi - lo) * i) / 255;
    let k = 0;
    while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const [a, b] = [stops[k], stops[k + 1]];
    const t = Math.max(0, Math.min(1, (v - a[0]) / (b[0] - a[0] || 1)));
    for (let c = 1; c <= 3; c++) rgba[i * 4 + c - 1] = a[c] + (b[c] - a[c]) * t;
    rgba[i * 4 + 3] = 255;
  }
  return { lo, hi, rgba };
}

export function format(layer: Layer, si: number): string {
  if (!Number.isFinite(si)) return "–";
  const c = convert(layer.unit, layer.toDisplay(si));
  return `${c.v.toFixed(layer.digits)} ${c.unit}`;
}

/** Particles can show a different field from the colours: wind over currents, currents over wind. */
export type FlowChoice = "auto" | "wind" | "currents" | "waves" | "off";
export type FlowKind = "wind" | "jet" | "currents" | "waves" | "off";
export type Flow = {
  kind: FlowKind;
  vars?: [string, string];
  waveDir?: string;
  scale: number;
  colour: string;
  label: string;
};
export const FLOW_CHOICES: { id: FlowChoice; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "wind", label: "Wind" },
  { id: "currents", label: "Currents" },
  { id: "waves", label: "Waves" },
  { id: "off", label: "Off" },
];

/** What the particles show: the layer's own field unless the viewer picked another. */
export function flowFor(layer: Layer, choice: FlowChoice): Flow {
  const kind: FlowKind =
    choice !== "auto"
      ? choice
      : layer.family === "ocean"
        ? "currents"
        : layer.family === "wave"
          ? "waves"
          : layer.id === "jet"
            ? "jet"
            : "wind";
  // Each kind its own tint, so wind over currents doesn't look like the currents themselves.
  if (kind === "currents")
    return { kind, vars: ["current_u", "current_v"], scale: 6, colour: "#9dffe6", label: "Current" };
  if (kind === "waves") return { kind, waveDir: "wave_dir", scale: 8, colour: "#bcd8ff", label: "Wave" };
  if (kind === "jet")
    return { kind, vars: ["wind250_u", "wind250_v"], scale: 0.6, colour: "#ffffff", label: "Jet stream" };
  if (kind === "wind") return { kind, vars: ["wind_u", "wind_v"], scale: 1, colour: "#ffffff", label: "Wind" };
  return { kind, scale: 1, colour: "#ffffff", label: "" };
}

/** The model run the particles come from. Currents are ECMWF's. */
export function flowModel(flow: Flow, picked: string): string {
  if (flow.kind === "currents") return "ecmwf";
  if (flow.kind === "waves") return `${picked}-wave`;
  if (flow.kind === "jet") return picked === "icon" ? "gfs" : picked;
  return picked;
}
