// Model runs and value frames from the API. Values are SI; layers.ts converts for display.

export type ModelStatus = {
  id: string;
  name: string;
  provider: string;
  attribution: string;
  licence: string;
  variables: string[];
  status: string;
  run?: string;
  run_id?: string;
  ingested?: string;
  valid_from?: number;
  valid_until?: number;
  next_expected?: number;
};

export type Grid = { north: number; south: number; west: number; east: number; step: number; ny: number; nx: number };

export type Manifest = {
  model: string;
  ingested: string;
  name: string;
  run: string;
  valid_times: number[];
  grid: Grid;
  variables: Record<string, { unit: string }>;
  attribution: string;
};

export async function getModels(): Promise<ModelStatus[]> {
  const r = await fetch("/v1/models");
  return (await r.json()).models;
}

const manifests = new Map<string, Promise<Manifest>>();
// Run files are cached forever, so URLs carry the ingest time: a re-ingested run gets new URLs.
export function getManifest(model: string, runId: string, ingested = ""): Promise<Manifest> {
  const key = `${model}/${runId}`;
  const url = `/runs/${key}/manifest.json?v=${encodeURIComponent(ingested)}`;
  if (!manifests.has(url)) {
    const p = fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest ${url}: ${r.status}`))));
    p.catch(() => manifests.delete(url)); // a failed fetch is retried next time, not cached
    manifests.set(url, p);
  }
  return manifests.get(url)!;
}

/** One variable over the whole region at one time, NaN where the model has no value. */
export class Field {
  constructor(
    public grid: Grid,
    public values: Float32Array,
  ) {}

  /** Bilinear value at a point, NaN outside the region or next to a gap. */
  at(lon: number, lat: number): number {
    const g = this.grid;
    const fy = (g.north - lat) / g.step;
    let fx = (lon - g.west) / g.step;
    if (fx < 0 || fx > g.nx - 1) fx = ((((lon - g.west) % 360) + 360) % 360) / g.step; // other world copy
    if (fy < 0 || fx < 0 || fy > g.ny - 1 || fx > g.nx - 1) return NaN;
    const y0 = Math.min(Math.floor(fy), g.ny - 2);
    const x0 = Math.min(Math.floor(fx), g.nx - 2);
    const dy = fy - y0;
    const dx = fx - x0;
    const v = this.values;
    const i = y0 * g.nx + x0;
    return (
      v[i] * (1 - dx) * (1 - dy) + v[i + 1] * dx * (1 - dy) + v[i + g.nx] * (1 - dx) * dy + v[i + g.nx + 1] * dx * dy
    );
  }

  /** Fill gaps from their neighbours a few cells deep, so sea fields reach the drawn
   * coastline instead of stopping at the coarse model coast. Land is drawn over it. */
  filled(passes = 6): Field {
    const { nx, ny } = this.grid;
    let a = this.values.slice();
    for (let p = 0; p < passes; p++) {
      const b = a.slice();
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = y * nx + x;
          if (!Number.isNaN(a[i])) continue;
          // The four neighbours inline: this runs over millions of cells per draw.
          let s = 0;
          let n = 0;
          let v: number;
          if (x > 0 && !Number.isNaN((v = a[i - 1]))) {
            s += v;
            n++;
          }
          if (x < nx - 1 && !Number.isNaN((v = a[i + 1]))) {
            s += v;
            n++;
          }
          if (y > 0 && !Number.isNaN((v = a[i - nx]))) {
            s += v;
            n++;
          }
          if (y < ny - 1 && !Number.isNaN((v = a[i + nx]))) {
            s += v;
            n++;
          }
          if (n) b[i] = s / n;
        }
      }
      a = b;
    }
    return new Field(this.grid, a);
  }
}

/** Detail by zoom: every cell close in, every 2nd or 4th cell further out. */
export function strideFor(zoom: number) {
  return zoom <= 2.5 ? 4 : zoom <= 4.2 ? 2 : 1;
}
// Frames come in fixed chunks so the browser cache can reuse them as the view moves.
const CHUNK: Record<number, number> = { 1: 30, 2: 60 };

export type View = { west: number; south: number; east: number; north: number; stride: number };

/** The chunk boxes covering a view, in the view's own longitudes (which may pass 180). */
export function chunksFor(v: View): [number, number, number, number][] {
  if (v.stride >= 4 || v.east - v.west >= 300) return [[-180, -90, 180, 90]];
  const c = CHUNK[v.stride];
  const out: [number, number, number, number][] = [];
  for (let s = Math.max(-90, Math.floor(v.south / c) * c); s < Math.min(90, v.north); s += c)
    for (let w = Math.floor(v.west / c) * c; w < v.east; w += c) out.push([w, s, w + c, Math.min(90, s + c)]);
  return out;
}

const chunkCache = new Map<string, Promise<{ lo: number; hi: number; ny: number; nx: number; q: Uint8Array }>>();
function chunkUrl(m: Manifest, runId: string, variable: string, index: number, [w, s, e, n]: number[], stride: number) {
  const w0 = ((((w + 180) % 360) + 360) % 360) - 180; // same data, one URL
  return `/v1/frame/${m.model}/${runId}/${variable}/${index}?b=${w0},${s},${w0 + (e - w)},${n}&s=${stride}&v=${encodeURIComponent(m.ingested)}`;
}

function getChunk(url: string) {
  let c = chunkCache.get(url);
  if (!c) {
    c = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`frame ${url}: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const [lo, hi] = new Float32Array(buf, 0, 2);
        const [ny, nx] = new Uint32Array(buf, 8, 2);
        return { lo, hi, ny, nx, q: new Uint8Array(buf, 16) };
      });
    chunkCache.set(url, c);
    c.catch(() => chunkCache.delete(url));
    // Bounded so long timeline scrubs on a phone don't grow memory without limit (Map keeps insertion
    // order, and a hit is re-inserted below, so the first key is the least recently used).
    while (chunkCache.size > 600) chunkCache.delete(chunkCache.keys().next().value!);
  } else {
    chunkCache.delete(url);
    chunkCache.set(url, c);
  }
  return c;
}

/** One variable at one time over the chunks covering a view, stitched into one field. */
export async function getFrame(m: Manifest, runId: string, variable: string, index: number, v: View): Promise<Field> {
  const boxes = chunksFor(v);
  // A missing chunk (a failed request) leaves a gap rather than failing the frame.
  const settled = await Promise.allSettled(
    boxes.map((b) => getChunk(chunkUrl(m, runId, variable, index, b, v.stride))),
  );
  if (settled.every((p) => p.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
  const step = m.grid.step * v.stride; // each run's own grid
  const west = Math.min(...boxes.map((b) => b[0]));
  const south = Math.min(...boxes.map((b) => b[1]));
  const east = Math.max(...boxes.map((b) => b[2]));
  const north = Math.max(...boxes.map((b) => b[3]));
  const nx = Math.round((east - west) / step) + 1;
  const ny = Math.round((north - south) / step) + 1;
  const out = new Float32Array(nx * ny).fill(NaN);
  boxes.forEach(([bw, , , bn], k) => {
    const part = settled[k];
    if (part.status !== "fulfilled") return;
    const { lo, hi, ny: cy, nx: cx, q } = part.value;
    const k2 = (hi - lo) / 254;
    const y0 = Math.round((north - bn) / step);
    const x0 = Math.round((bw - west) / step);
    for (let y = 0; y < cy; y++)
      for (let x = 0; x < cx; x++) {
        const b = q[y * cx + x];
        out[(y0 + y) * nx + x0 + x] = b === 255 ? NaN : lo + b * k2;
      }
  });
  return new Field({ north, south, west, east, step, ny, nx }, out);
}
