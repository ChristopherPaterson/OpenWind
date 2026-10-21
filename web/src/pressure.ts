// Isobars and pressure centres from one frame of mean sea level pressure (Pa), rows north to south.
import { contours } from "d3-contour";
import { extent } from "./models";

export type GridShape = { nx: number; ny: number; west: number; north: number; step: number };
type Line = GeoJSON.Feature<GeoJSON.LineString, { hpa: number }>;

/** Isobars every `interval` hPa as lines, with the contour edges along the region border removed. */
export function isobars(
  pa: ArrayLike<number>,
  g: GridShape,
  interval = 4,
): GeoJSON.FeatureCollection<GeoJSON.LineString, { hpa: number }> {
  const hpa = Array.from(pa, (v) => v / 100);
  const features: Line[] = [];
  const finite = hpa.filter(Number.isFinite);
  if (!finite.length) return { type: "FeatureCollection", features };
  const [min, hi] = extent(finite);
  const levels: number[] = [];
  for (let v = Math.ceil(min / interval) * interval; v <= hi; v += interval) levels.push(v);
  const edge = (x: number, y: number) => x <= 0.5 || y <= 0.5 || x >= g.nx - 0.5 || y >= g.ny - 0.5;
  for (const c of contours().size([g.nx, g.ny]).thresholds(levels)(hpa)) {
    for (const poly of c.coordinates) {
      for (const ring of poly) {
        let run: [number, number][] = [];
        const flush = () => {
          if (run.length > 3)
            features.push({
              type: "Feature",
              properties: { hpa: c.value },
              geometry: { type: "LineString", coordinates: run },
            });
          run = [];
        };
        for (const [x, y] of ring) {
          if (edge(x, y)) flush();
          else run.push([g.west + (x - 0.5) * g.step, g.north - (y - 0.5) * g.step]);
        }
        flush();
      }
    }
  }
  return { type: "FeatureCollection", features };
}

export type Centre = { lon: number; lat: number; kind: "H" | "L"; hpa: number };

/** Pressure centres: cells that are the lowest (or highest) within ~5 degrees and stand out from their
 * surroundings by at least 2 hPa. */
export function centres(pa: ArrayLike<number>, g: GridShape): Centre[] {
  const R = Math.max(3, Math.round(5 / g.step)); // ~5 degrees whatever the detail
  const v = pa;
  const out: Centre[] = [];
  const windowed = (pick: (a: number, b: number) => number) => {
    const rows = new Float32Array(v.length);
    const res = new Float32Array(v.length);
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < g.nx; x++) {
        let m = v[y * g.nx + x];
        for (let d = Math.max(0, x - R); d <= Math.min(g.nx - 1, x + R); d++) m = pick(m, v[y * g.nx + d]);
        rows[y * g.nx + x] = m;
      }
    for (let x = 0; x < g.nx; x++)
      for (let y = 0; y < g.ny; y++) {
        let m = rows[y * g.nx + x];
        for (let d = Math.max(0, y - R); d <= Math.min(g.ny - 1, y + R); d++) m = pick(m, rows[d * g.nx + x]);
        res[y * g.nx + x] = m;
      }
    return res;
  };
  const mins = windowed(Math.min);
  const maxs = windowed(Math.max);
  for (let y = Math.ceil(R / 2); y < g.ny - R / 2; y++)
    for (let x = Math.ceil(R / 2); x < g.nx - R / 2; x++) {
      const i = y * g.nx + x;
      const p = v[i];
      if (!Number.isFinite(p)) continue;
      const kind = p === mins[i] && maxs[i] - p > 200 ? "L" : p === maxs[i] && p - mins[i] > 200 ? "H" : null;
      if (Math.abs(g.north - y * g.step) > 80) continue; // polar pressure is extrapolated noise
      if (
        kind &&
        !out.some(
          (o) =>
            o.kind === kind &&
            Math.abs(o.lon - (g.west + x * g.step)) < 3 &&
            Math.abs(o.lat - (g.north - y * g.step)) < 3,
        )
      )
        out.push({ lon: g.west + x * g.step, lat: g.north - y * g.step, kind, hpa: Math.round(p / 100) });
    }
  return out;
}
