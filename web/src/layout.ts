// Floating UI never overlaps. Two parts:
// 1. Panels are placed from the measured top bar and timeline (--top-b, --bottom-h on :root), not from fixed
//    offsets, since both change height with the screen, wrapping and safe areas.
// 2. Whatever still overlaps something more important is hidden (.occluded) until it is clear again. Earlier
//    tiers win; within a tier, the earlier selector wins.
const TIERS = [
  [".timeline", ".top .brand", ".layer-btn"], // always shown
  [".layer-menu", ".settings"], // menus, open one at a time
  [".readout", ".meteogram"], // panels
  [".hover-card", ".top .tools", ".maplibregl-ctrl-bottom-right"], // give way to all of the above
];

const overlap = (a: DOMRect, b: DOMRect) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;

/** Which elements to hide: each visible one that overlaps one already kept, unless one contains the other. */
export function covered(app: ParentNode): Set<Element> {
  const kept: [Element, DOMRect][] = [];
  const hide = new Set<Element>();
  for (const tier of TIERS)
    for (const sel of tier)
      for (const el of app.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 2 || r.height < 2 || cs.display === "none") continue;
        if ([...hide].some((h) => h.contains(el))) continue; // inside something hidden
        if (kept.some(([k, q]) => !k.contains(el) && !el.contains(k) && overlap(r, q))) hide.add(el);
        else kept.push([el, r]);
      }
  return hide;
}

export function watchLayout(app: HTMLElement): () => void {
  let frame = 0;
  const run = () => {
    frame = 0;
    const root = document.documentElement.style;
    const top = app.querySelector(".top")?.getBoundingClientRect();
    const line = app.querySelector(".timeline")?.getBoundingClientRect();
    if (top) root.setProperty("--top-b", `${Math.round(top.bottom)}px`);
    if (line) root.setProperty("--bottom-h", `${Math.round(innerHeight - line.top)}px`);
    // Hide and show only what changed: a run that changes nothing makes no mutations, so watching our own
    // class edits settles after one more run instead of looping.
    // (Hidden means visibility: hidden, which keeps an element's box, so it is measured as before.)
    const hide = covered(app);
    for (const el of app.querySelectorAll(".occluded")) if (!hide.has(el)) el.classList.remove("occluded");
    for (const el of hide) if (!el.classList.contains("occluded")) el.classList.add("occluded");
  };
  const soon = () => {
    frame ||= requestAnimationFrame(run);
  };
  const mo = new MutationObserver(soon);
  mo.observe(app, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "class", "open"],
  });
  const ro = new ResizeObserver(soon);
  ro.observe(app);
  addEventListener("resize", soon);
  soon();
  return () => {
    cancelAnimationFrame(frame);
    mo.disconnect();
    ro.disconnect();
    removeEventListener("resize", soon);
  };
}
