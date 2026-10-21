// Runs shading jobs in shade.worker.ts, one at a time, keeping only the newest waiting job per image: while
// scrubbing or playing, superseded frames are dropped (resolved as null) instead of queueing up.
import { cutAt180, shadePixels, type ShadeJob } from "./shadeCore";

export type Shaded = { a: Blob; b: Blob | null; width: number };
type Waiting = { job: ShadeJob; resolve: (r: Shaded | null) => void };

let worker: Worker | null = null;
let busy = false;
const waiting = new Map<string, Waiting>();
const running = new Map<number, Waiting>();
let next = 0;

function pump() {
  if (busy || !waiting.size) return;
  const [key, w] = waiting.entries().next().value!;
  waiting.delete(key);
  busy = true;
  const id = ++next;
  running.set(id, w);
  worker!.postMessage({ id, job: w.job });
}

function start(): boolean {
  if (worker) return true;
  if (typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined") return false;
  if (new URLSearchParams(location.search).get("shade") === "main") return false; // ?shade=main to compare
  worker = new Worker(new URL("./shade.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<{ id: number; error?: string } & Shaded>) => {
    const w = running.get(e.data.id)!;
    running.delete(e.data.id);
    busy = false;
    if (e.data.error) {
      console.error("shade worker:", e.data.error);
      mainThread(w.job).then(w.resolve);
    } else w.resolve(e.data);
    pump();
  };
  return true;
}

/** Shade `job` for image `key`; null when a newer job for the same image replaced it before it ran. */
export function shade(key: string, job: ShadeJob): Promise<Shaded | null> {
  if (!start()) return mainThread(job);
  return new Promise((resolve) => {
    waiting.get(key)?.resolve(null);
    waiting.set(key, { job, resolve });
    pump();
  });
}

/** The same on the main thread, for browsers without OffscreenCanvas in workers. */
async function mainThread(job: ShadeJob): Promise<Shaded> {
  const { W, H, data } = shadePixels(job);
  const full = document.createElement("canvas");
  full.width = W;
  full.height = H;
  full.getContext("2d")!.putImageData(new ImageData(data, W, H), 0, 0);
  const { cut } = cutAt180(job.grid, W);
  const piece = (x0: number, x1: number) => {
    const c = document.createElement("canvas");
    c.width = Math.max(1, x1 - x0);
    c.height = H;
    c.getContext("2d")!.drawImage(full, -x0, 0);
    return new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
  };
  const [a, b] = await Promise.all([piece(0, cut), cut < W ? piece(cut, W) : Promise.resolve(null)]);
  return { a, b, width: W };
}
