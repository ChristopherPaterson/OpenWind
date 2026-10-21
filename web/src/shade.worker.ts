// Shades weather images off the main thread (the main source of jank during playback): fills sea gaps,
// colours every pixel, splits at 180 degrees and encodes PNGs, returning blobs for MapLibre image sources.
import { cutAt180, shadePixels, type ShadeJob } from "./shadeCore";

self.onmessage = async (e: MessageEvent<{ id: number; job: ShadeJob }>) => {
  const { id, job } = e.data;
  try {
    const { W, H, data } = shadePixels(job);
    const full = new OffscreenCanvas(W, H);
    full.getContext("2d")!.putImageData(new ImageData(data, W, H), 0, 0);
    const { cut } = cutAt180(job.grid, W);
    const piece = (x0: number, x1: number) => {
      const c = new OffscreenCanvas(Math.max(1, x1 - x0), H);
      c.getContext("2d")!.drawImage(full, -x0, 0);
      return c.convertToBlob({ type: "image/png" });
    };
    const [a, b] = await Promise.all([piece(0, cut), cut < W ? piece(cut, W) : Promise.resolve(null)]);
    self.postMessage({ id, a, b, width: W });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
