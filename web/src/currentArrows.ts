// Currents layer: arrows that glide a little way downstream and fade in and out, like a dash riding the
// current. Faster water glides faster and further and shows brighter; slack water drifts faintly. Drawn on a
// canvas over the map (a symbol layer can't animate per arrow). Still when the viewer prefers reduced motion.
import type * as maplibregl from "maplibre-gl";

export type Arrow = { lng: number; lat: number; to: number; kn: number }; // to: degrees true the water goes

export class ArrowOverlay {
  private arrows: (Arrow & { seed: number })[] = [];
  private raf = 0;
  private ctx: CanvasRenderingContext2D;
  private still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  constructor(
    private map: maplibregl.Map,
    private canvas: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext("2d")!;
  }

  set(arrows: Arrow[]) {
    // Each arrow its own phase, so they don't pulse in step.
    this.arrows = arrows.map((a, i) => ({ ...a, seed: (i * 0.618034) % 1 }));
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(t: number) {
    const { canvas, ctx, map } = this;
    const dpr = window.devicePixelRatio || 1;
    const c = map.getContainer();
    const [w, h] = [c.clientWidth, c.clientHeight];
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      [canvas.width, canvas.height] = [w * dpr, h * dpr];
      [canvas.style.width, canvas.style.height] = [`${w}px`, `${h}px`];
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.arrows.length) {
      this.raf = 0; // nothing to draw: stop until set() again
      return;
    }
    ctx.lineCap = ctx.lineJoin = "round";
    const turn = (-map.getBearing() * Math.PI) / 180;
    for (const a of this.arrows) {
      const p = map.project([a.lng, a.lat]);
      if (p.x < -40 || p.y < -40 || p.x > w + 40 || p.y > h + 40) continue;
      const s = Math.min(a.kn / 2, 1); // 0 slack .. 1 at 2 kn and above
      const phase = this.still ? 0.5 : ((t / 1000) * (0.12 + 0.6 * s) + a.seed) % 1;
      const alpha = (0.18 + 0.55 * s) * (this.still ? 1 : Math.sin(Math.PI * phase));
      const r = (a.to * Math.PI) / 180 + turn;
      const [dx, dy] = [Math.sin(r), -Math.cos(r)];
      const shift = (phase - 0.5) * (10 + 22 * s);
      const len = 7 + 9 * s;
      const [hx, hy] = [p.x + dx * (shift + len / 2), p.y + dy * (shift + len / 2)]; // the head
      const head = 3.5 + 2 * s;
      ctx.strokeStyle = `rgba(232,244,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = 1.3 + 0.7 * s;
      ctx.beginPath();
      ctx.moveTo(hx - dx * len, hy - dy * len);
      ctx.lineTo(hx, hy);
      for (const side of [-1, 1]) {
        const back = r + Math.PI + side * 0.55;
        ctx.moveTo(hx + Math.sin(back) * head, hy - Math.cos(back) * head);
        ctx.lineTo(hx, hy);
      }
      ctx.stroke();
    }
    this.raf = requestAnimationFrame((tt) => this.tick(tt));
  }
}
