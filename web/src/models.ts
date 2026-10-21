// One place for each model's colour and display name, so the map and the chart agree.
export const MODEL_COLOURS: Record<string, string> = {
  gfs: "#5fb4ff",
  ecmwf: "#ffb347",
  icon: "#c58bff",
  "gfs-wave": "#5fb4ff",
  "ecmwf-wave": "#ffb347",
  "icon-wave": "#c58bff",
  current: "#3cc0a0",
};
export const MODEL_NAMES: Record<string, string> = { gfs: "GFS", ecmwf: "ECMWF", icon: "ICON" };

/** Smallest and largest finite values, without spreading a large array into Math.min (which overflows the stack). */
export function extent(values: Iterable<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}
