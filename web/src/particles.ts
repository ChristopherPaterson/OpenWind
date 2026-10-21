// Moving particles over the map, carried by a u/v field. Canvas 2D: a few thousand
// particles is light enough for phones and needs no WebGL.

import type * as maplibregl from "maplibre-gl";

type P = { lon: number; lat: number; age: number; life: number; x: number; y: number };
export type Sampler = (lon: number, lat: number) => [number, number] | null;

// Fewer, longer, brighter trails that fade in and out, and faster wind visibly faster.
const DENSITY = 420; // screen px² per particle
const MAX = 3500;
// Trails fade by drawing over the canvas with destination-in. Done every frame by a little, 8-bit rounding
// leaves faint pixels stuck (a*0.955 rounds back to a below alpha 11/255) as ghost streaks; every third
// frame by more, only pixels under 4/255 can stick, which can't be seen.
const FADE_EVERY = 3;
const FADE = 0.955 ** FADE_EVERY;
const BUCKETS = 4; // fade levels; one path each, so fading costs four strokes, not one per particle

export class Particles {
  private ctx: CanvasRenderingContext2D;
  private ps: P[] = [];
  private sample: Sampler | null = null;
  private raf = 0;
  private speed = 1;
  private last = 0;
  private moved = true;
  private frame = 0;
  private kind = "";
  private colour = "255,255,255";
  // Where the trails were drawn: a pan or zoom moves the trail image with the map instead of wiping it.
  private anchor: { lng: number; lat: number; zoom: number; x: number; y: number } | null = null;
  // Since the last frame, where the old view now sits on screen: respawns go to the newly exposed map.
  private seen: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private scratch = document.createElement("canvas");

  constructor(
    private map: maplibregl.Map,
    private canvas: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext("2d")!;
    // A pan or zoom wipes the trails but keeps the particles (those that leave the view respawn);
    // only a real resize reallocates the canvas.
    map.on("move", () => this.follow());
    map.on("resize", () => this.resize());
    this.resize();
  }

  /** speed scales screen movement: 1 suits wind in m/s, currents need far more. A new field of the same
   * kind (the next hour, a sharper view) keeps the particles and trails; a different kind starts afresh. */
  set(sample: Sampler | null, speed = 1, kind = "", colour = "#ffffff") {
    if (!sample) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.sample = null;
      this.kind = "";
      this.ps = [];
      this.clear();
      return;
    }
    this.sample = sample;
    this.speed = speed;
    if (kind === this.kind && this.ps.length) {
      return;
    }
    this.kind = kind;
    this.colour = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16)).join(",");
    this.ps = [];
    this.clear();
    cancelAnimationFrame(this.raf);
    this.last = 0;
    this.raf = requestAnimationFrame(() => this.tick());
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ps = [];
    this.anchor = null;
  }

  /** Keep the trail image on the map during a pan or zoom: Web Mercator moves are a scale and a shift. */
  private follow() {
    this.moved = true;
    const a = this.anchor;
    const c = this.map.getCenter();
    const z = this.map.getZoom();
    if (a) {
      const s = 2 ** (z - a.zoom);
      const p = this.map.project([a.lng, a.lat]);
      const { clientWidth: w, clientHeight: h } = this.map.getContainer();
      const to = (x: number, y: number) => [p.x + s * (x - a.x), p.y + s * (y - a.y)];
      const r = this.seen ?? { x0: 0, y0: 0, x1: w, y1: h };
      [r.x0, r.y0] = to(r.x0, r.y0);
      [r.x1, r.y1] = to(r.x1, r.y1);
      this.seen = r;
      if (s > 0.25 && s < 4 && Math.abs(p.x - a.x) < w && Math.abs(p.y - a.y) < h) {
        // Copy through a scratch canvas (drawing a canvas onto itself isn't reliable everywhere).
        const sc = this.scratch;
        if (sc.width !== this.canvas.width || sc.height !== this.canvas.height)
          [sc.width, sc.height] = [this.canvas.width, this.canvas.height];
        const g = sc.getContext("2d")!;
        g.clearRect(0, 0, sc.width, sc.height);
        g.drawImage(this.canvas, 0, 0);
        const ctx = this.ctx;
        this.clear();
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(s, s);
        ctx.translate(-a.x, -a.y);
        ctx.drawImage(sc, 0, 0, w, h);
        ctx.restore();
      } else this.clear();
    }
    const pc = this.map.project(c);
    this.anchor = { lng: c.lng, lat: c.lat, zoom: z, x: pc.x, y: pc.y };
  }

  private clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** A new particle somewhere on screen; after a pan or zoom, preferably on the newly exposed map, so it
   * fills at once instead of over the few seconds particles take to drift there. */
  private spawn(fresh = false, avoid = this.seen): P {
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 8; tries++) {
      x = Math.random() * w;
      y = Math.random() * h;
      if (!avoid || x < avoid.x0 || x > avoid.x1 || y < avoid.y0 || y > avoid.y1) break;
    }
    const ll = this.map.unproject([x, y]);
    const lon = ll.lng;
    const lat = Math.max(-85, Math.min(85, ll.lat));
    const life = 90 + Math.random() * 120;
    const pt = { x, y };
    // The first fill starts at random ages so the field doesn't pulse; respawns start from nothing.
    return { lon, lat, age: fresh ? Math.random() * life : 0, life, x: pt.x, y: pt.y };
  }

  private tick() {
    const sample = this.sample;
    if (!sample) return;
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const target = Math.min(MAX, Math.round((w * h) / DENSITY));
    while (this.ps.length < target) this.ps.push(this.spawn(true, null));
    this.ps.length = target;
    if (this.moved) {
      for (const p of this.ps) ({ x: p.x, y: p.y } = this.map.project([p.lon, p.lat]));
      this.moved = false;
      // Even density after a move: the old view keeps only its share of particles, the rest move to the
      // newly exposed map (zooming out would otherwise leave a crowded middle and an empty rim).
      const r = this.seen;
      if (r) {
        const ow = Math.max(0, Math.min(w, r.x1) - Math.max(0, r.x0));
        const oh = Math.max(0, Math.min(h, r.y1) - Math.max(0, r.y0));
        const inView = (p: P) => p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h;
        const n = this.ps.filter(inView).length;
        const keep = n ? Math.min(1, (target * (ow * oh)) / (w * h) / n) : 1;
        if (keep < 1) this.ps = this.ps.map((p) => (inView(p) && Math.random() > keep ? this.spawn(true) : p));
      }
    }

    // Move by elapsed time, not per frame, so 120 Hz screens are not twice as fast.
    const now = performance.now();
    const dt = this.last ? Math.min(3, (now - this.last) / (1000 / 60)) : 1;
    this.last = now;
    const ctx = this.ctx;
    if (this.frame++ % FADE_EVERY === 0) {
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = `rgba(0,0,0,${FADE ** dt})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
    }

    // Degrees per screen pixel at this zoom (MapLibre tiles are 512 px).
    const degPx = 360 / (512 * 2 ** this.map.getZoom());
    const k = 0.08 * this.speed * degPx * dt;
    const paths = Array.from({ length: BUCKETS }, () => new Path2D());
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      const uv = sample(p.lon, p.lat);
      p.age += dt;
      if (!uv || p.age > p.life) {
        this.ps[i] = this.spawn(this.seen !== null);
        continue;
      }
      // Screen speed grows with the 0.8 power of the value: strong wind looks faster, without racing.
      const mag = Math.hypot(uv[0], uv[1]);
      const f = mag > 0 ? k * mag ** -0.2 : 0;
      p.lon += uv[0] * f;
      p.lat += uv[1] * f * Math.cos((p.lat * Math.PI) / 180);
      const b = this.map.project([p.lon, p.lat]);
      if (b.x < -20 || b.y < -20 || b.x > w + 20 || b.y > h + 20) {
        this.ps[i] = this.spawn(this.seen !== null); // left the view: after a move, straight in at full strength
        continue;
      }
      // Fade in over the first 15 frames and out over the last 30.
      const a = Math.min(1, p.age / 15, (p.life - p.age) / 30);
      const path = paths[Math.min(BUCKETS - 1, Math.floor(a * BUCKETS))];
      path.moveTo(p.x, p.y);
      path.lineTo(b.x, b.y);
      p.x = b.x;
      p.y = b.y;
    }
    ctx.lineCap = "round";
    ctx.lineWidth = 1.7;
    paths.forEach((path, j) => {
      ctx.strokeStyle = `rgba(${this.colour},${(0.95 * (j + 1)) / BUCKETS})`;
      ctx.stroke(path);
    });
    this.seen = null;
    this.raf = requestAnimationFrame(() => this.tick());
  }
}
