// Shading a field into pixels, with no DOM: used on the main thread (draw.ts) and in shade.worker.ts.
import { Field, type Grid } from "./data";

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y: number) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;
const MAX_LAT = 85; // Web Mercator stops short of the poles

/** What to shade, as plain data so it can go to a worker: the fields, how to combine them (one value, or the
 * speed of a u/v pair), and the colour table with an affine display transform (SI -> shown units). */
export type ShadeJob = {
  mode: "scalar" | "speed";
  sets: { grid: Grid; values: Float32Array }[][];
  fill: boolean; // sea layers: fill gaps so the colour reaches the drawn coastline
  grid: Grid; // the image's extent: the first field's grid
  rgba: Uint8ClampedArray;
  lo: number;
  hi: number;
  a: number; // shown = a * value + b
  b: number;
};

export function valueOf(job: ShadeJob): (lon: number, lat: number) => number {
  const sets = job.sets.map((s) => s.map((f) => new Field(f.grid, f.values)));
  if (job.fill) sets[0] = sets[0].map((f) => f.filled());
  const fields = sets[0];
  const speed = (f: Field[], lon: number, lat: number) => Math.hypot(f[0].at(lon, lat), f[1].at(lon, lat));
  if (job.mode === "speed") return (lon, lat) => speed(fields, lon, lat);
  return (lon, lat) => fields[0].at(lon, lat);
}

/** RGBA pixels whose rows are evenly spaced in Mercator, so MapLibre's linear image placement lands every
 * pixel on the right latitude. */
export function shadePixels(job: ShadeJob, value = valueOf(job)) {
  const g = job.grid;
  const W = Math.min(1600, (g.nx - 1) * 2);
  const yTop = mercY(Math.min(g.north, MAX_LAT));
  const yBottom = mercY(Math.max(g.south, -MAX_LAT));
  const H = Math.min(2000, Math.round((W * (yTop - yBottom)) / (((g.east - g.west) * Math.PI) / 180)));
  const data = new Uint8ClampedArray(W * H * 4);
  const { rgba, lo, a, b } = job;
  const k = 255 / (job.hi - lo);
  for (let r = 0; r < H; r++) {
    const lat = invMercY(yTop + ((yBottom - yTop) * (r + 0.5)) / H);
    for (let c = 0; c < W; c++) {
      const v = value(g.west + ((g.east - g.west) * (c + 0.5)) / W, lat);
      if (!Number.isFinite(v)) continue; // stays transparent
      const o = (r * W + c) * 4;
      const i = Math.max(0, Math.min(255, Math.round((a * v + b - lo) * k))) * 4;
      data[o] = rgba[i];
      data[o + 1] = rgba[i + 1];
      data[o + 2] = rgba[i + 2];
      data[o + 3] = 255;
    }
  }
  return { W, H, data };
}

/** Where the image splits at 180 degrees: its west and east in -180.. and the pixel column of the cut. */
export function cutAt180(g: Grid, width: number) {
  const shift = Math.floor((g.west + 180) / 360) * 360;
  const [west, east] = [g.west - shift, g.east - shift];
  return { west, east, cut: east > 180 ? Math.round((width * (180 - west)) / (east - west)) : width };
}
