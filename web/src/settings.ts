// Display preferences, remembered per device. Colour scales stay in knots and °C; only the
// numbers shown change.

export type Settings = {
  wind: "kn" | "m/s" | "km/h" | "mph";
  temp: "°C" | "°F";
  tz: "local" | "UTC";
};

const FROM_KN: Record<Settings["wind"], number> = { kn: 1, "m/s": 0.514444, "km/h": 1.852, mph: 1.150779 };
const KEY = "openwind-settings";
const DEFAULTS: Settings = { wind: "kn", temp: "°C", tz: "local" };

export const settings: Settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
})();

export function saveSettings(next: Settings) {
  Object.assign(settings, next);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* not remembered, still applied */
  }
}

/** A value in a layer's canonical unit (kn or °C) to the viewer's unit, with its label. */
export function convert(unit: string, v: number): { v: number; unit: string } {
  if (unit === "kn") return { v: v * FROM_KN[settings.wind], unit: settings.wind };
  if (unit === "°C" && settings.temp === "°F") return { v: v * 1.8 + 32, unit: "°F" };
  return { v, unit };
}

/** Wind speed from knots, formatted in the viewer's unit. */
export function windText(kn: number, digits = 0) {
  const c = convert("kn", kn);
  return `${c.v.toFixed(digits)} ${c.unit}`;
}

// Times in the device's zone or UTC. Formatters are costly to build, so each is made once per zone setting.
const fmt = (opts: Intl.DateTimeFormatOptions) => {
  const made: Partial<Record<Settings["tz"], Intl.DateTimeFormat>> = {};
  return (t: number) =>
    (made[settings.tz] ??= new Intl.DateTimeFormat("en-AU", {
      ...opts,
      hour12: false,
      timeZone: settings.tz === "UTC" ? "UTC" : undefined,
    })).format(t);
};

export const time = {
  day: fmt({ weekday: "short", day: "numeric", month: "short" }),
  hour: fmt({ hour: "2-digit", minute: "2-digit" }),
  weekday: fmt({ weekday: "short" }),
  dayHour: fmt({ weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  when: fmt({ weekday: "short", hour: "2-digit", minute: "2-digit" }),
  zone: () => (settings.tz === "UTC" ? "UTC" : ""),
};

/** Midnights between two times in the chosen zone, for chart day ticks. */
export function midnights(t0: number, t1: number): number[] {
  const out: number[] = [];
  const d = new Date(t0);
  if (settings.tz === "UTC") {
    d.setUTCHours(24, 0, 0, 0);
    for (; d.getTime() < t1; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.getTime());
  } else {
    d.setHours(24, 0, 0, 0);
    for (; d.getTime() < t1; d.setDate(d.getDate() + 1)) out.push(d.getTime());
  }
  return out;
}
