import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState } from "react";
import { Field, getFrame, strideFor, type Manifest, type View } from "./data";
import { centres, corners, isobars, jobFor } from "./draw";
import { shade as shadeImage } from "./shadeClient";
import { cutAt180, type ShadeJob } from "./shadeCore";
import type { Flow, Layer } from "./layers";
import { Particles } from "./particles";
import { ArrowOverlay, type Arrow } from "./currentArrows";

maplibregl.setWorkerUrl(workerUrl);

const ARROW_PX = 70; // current arrows: spacing on screen, so the density is the same at every zoom
// Geostationary satellites, west to east; Himawari last so it wins over Australia.
const SATELLITES: [string, string, [number, number, number, number]][] = [
  ["sat-goes-east", "GOES-East_ABI_Band13_Clean_Infrared", [-150, -81, 0, 81]],
  ["sat-goes-west", "GOES-West_ABI_Band13_Clean_Infrared", [-180, -81, -80, 81]],
  ["sat-himawari", "Himawari_AHI_Band13_Clean_Infrared", [70, -81, 180, 81]],
];

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
// A fully transparent 1x1 PNG (a hand-written data URL here once drew a dark strip at 180).
const BLANK = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  return c.toDataURL("image/png");
})();

export type Pick = { lon: number; lat: number };

type Props = {
  layer: Layer;
  manifest: Manifest | null;
  runId: string | null;
  vectorManifest: Manifest | null; // particles may come from a different run (wind over waves)
  flow: Flow; // what the particles show (see layers.flowFor)
  vectorRunId: string | null;
  time: number; // epoch ms
  onPick: (p: Pick) => void;
  onLocate: (p: Pick) => void;
  pick: Pick | null;
  onFields: (f: Record<string, Field>) => void;
  onHover: (h: (Pick & { x: number; y: number }) | null) => void;
  satellite: boolean;
};

function indexFor(m: Manifest, time: number) {
  let best = 0;
  m.valid_times.forEach((t, i) => {
    if (Math.abs(t - time) < Math.abs(m.valid_times[best] - time)) best = i;
  });
  return best;
}

export default function WeatherMap(props: Props) {
  // Map handlers are bound once; they read the latest props through this ref.
  const latest = useRef(props);
  latest.current = props;
  const box = useRef<HTMLDivElement>(null);
  const particleCanvas = useRef<HTMLCanvasElement>(null);
  const arrowCanvas = useRef<HTMLCanvasElement>(null);
  const arrowOverlay = useRef<ArrowOverlay | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const particles = useRef<Particles | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const ready = useRef<Promise<void> | null>(null);
  const draw = useRef(0);
  const baseDraw = useRef(0);
  const detailVec = useRef<Field[]>([]);
  const baseVec = useRef<Field[]>([]);
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: box.current!,
      center: [0, 20],
      zoom: 2,
      minZoom: 1,
      maxZoom: 14, // tiles overzoom past 11
      // Flat and north up, like a chart: no tilting or turning by right-drag, two fingers or the keyboard.
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
      renderWorldCopies: true,
      hash: "map", // #map=zoom/lat/lon keeps the view in the link for sharing
      style: {
        version: 8,
        glyphs: `${location.origin}/fonts/{fontstack}/{range}.pbf`,
        sources: {
          // Latest geostationary infrared (10 min) from NASA GIBS: GOES-East, GOES-West, Himawari.
          ...Object.fromEntries(
            SATELLITES.map(([id, layer, bounds]) => [
              id,
              {
                type: "raster",
                tileSize: 256,
                maxzoom: 6,
                bounds,
                tiles: [
                  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`,
                ],
                attribution: "Satellite: NASA GIBS, NOAA GOES, JMA Himawari",
              },
            ]),
          ),
          // OSM coastline, the whole world (infra/basemap/world.sh).
          coast: {
            type: "vector",
            tiles: [`${location.origin}/basemap/world/coast/{z}/{x}/{y}.pbf`],
            minzoom: 0,
            maxzoom: 11,
          },
          // OSM land, the whole world.
          land: {
            type: "vector",
            tiles: [`${location.origin}/basemap/world/land/{z}/{x}/{y}.pbf`],
            minzoom: 0,
            maxzoom: 11,
          },
          "shade-base": {
            type: "image",
            url: BLANK,
            coordinates: [
              [-180, 85],
              [180, 85],
              [180, -85],
              [-180, -85],
            ],
          },
          shade: {
            type: "image",
            url: BLANK,
            coordinates: [
              [-180, 85],
              [180, 85],
              [180, -85],
              [-180, -85],
            ],
          },
          // Second half of the image when the view crosses the antimeridian (MapLibre wants -180..180).
          shade2: {
            type: "image",
            url: BLANK,
            coordinates: [
              [-180, 85],
              [-179, 85],
              [-179, -85],
              [-180, -85],
            ],
          },
          isobars: { type: "geojson", data: EMPTY },
          centres: { type: "geojson", data: EMPTY },
        },
        layers: [
          { id: "sea", type: "background", paint: { "background-color": "#0b1220" } },
          {
            id: "land",
            type: "fill",
            source: "land",
            "source-layer": "land",
            // No anti-aliasing: the land polygons' tile splits would otherwise show as faint lines.
            paint: { "fill-color": "#11151c", "fill-antialias": false },
          },
          {
            id: "shade-base",
            type: "raster",
            source: "shade-base",
            paint: { "raster-opacity": 0.92, "raster-resampling": "linear", "raster-fade-duration": 0 },
          },
          {
            id: "shade",
            type: "raster",
            source: "shade",
            paint: { "raster-opacity": 0.92, "raster-resampling": "linear", "raster-fade-duration": 0 },
          },
          {
            id: "shade2",
            type: "raster",
            source: "shade2",
            layout: { visibility: "none" },
            paint: { "raster-opacity": 0.92, "raster-resampling": "linear", "raster-fade-duration": 0 },
          },
          ...SATELLITES.map(([id]) => ({
            id,
            type: "raster" as const,
            source: id,
            layout: { visibility: "none" as const },
            paint: { "raster-opacity": 0.75, "raster-fade-duration": 0 },
          })),
          // Land reads as land under weather layers (as on Windy): opaque dark land sits over the weather
          // image, and these softer copies of the same image go on top, so land shows dimmed colour and the
          // sea looks unchanged. No transparent land, so tile seams can't show. Full colour again close in.
          ...(["shade-base", "shade", "shade2"] as const).map((src) => ({
            id: `${src}-top`,
            type: "raster" as const,
            source: src,
            layout: { visibility: (src === "shade2" ? "none" : "visible") as "none" | "visible" },
            paint: {
              "raster-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                3,
                0.6,
                8,
                0.66,
                9.5,
                0.8,
                11,
                1,
              ] as unknown as number,
              "raster-resampling": "linear" as const,
              "raster-fade-duration": 0,
            },
          })),
          {
            id: "land-outline",
            type: "line",
            source: "coast",
            "source-layer": "coast",
            paint: {
              "line-color": "#eef3fa",
              "line-opacity": 0.75,
              "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 10, 1.1, 14, 1.6],
            },
          },
          {
            id: "isobars",
            type: "line",
            source: "isobars",
            paint: { "line-color": "#ffffff", "line-opacity": 0.55, "line-width": 1 },
          },
          {
            id: "isobar-labels",
            type: "symbol",
            source: "isobars",
            layout: {
              "symbol-placement": "line",
              "symbol-spacing": 320,
              "text-field": ["to-string", ["get", "hpa"]],
              "text-font": ["Noto Sans Regular"],
              "text-size": 11,
            },
            paint: { "text-color": "#ffffff", "text-halo-color": "#0b1220", "text-halo-width": 1.5 },
          },
          {
            // Highs and lows as symbols, so where they crowd MapLibre fades out all but the strongest
            // nearby; zoomed out each needs more clear space, and the rest come back as the map zooms in.
            id: "centres",
            type: "symbol",
            source: "centres",
            layout: {
              "text-field": [
                "format",
                ["get", "kind"],
                { "font-scale": 1.8, "text-color": ["match", ["get", "kind"], "H", "#ff8a7a", "#8ac4ff"] },
                "\n",
                {},
                ["to-string", ["get", "hpa"]],
                { "font-scale": 0.9 },
              ],
              "text-font": ["Noto Sans Regular"],
              "text-size": 12,
              "text-line-height": 1,
              "text-padding": ["interpolate", ["linear"], ["zoom"], 2, 60, 6, 8], // more room zoomed out
              "symbol-sort-key": ["-", ["get", "depth"]], // deepest lows and strongest highs win
            },
            paint: { "text-color": "#ffffff", "text-halo-color": "#0b1220", "text-halo-width": 1.5 },
          },
        ],
      },
    });
    // Added first so it sits under the zoom buttons (bottom corners stack upwards): fly to the device's position and show it as a dot (HTTPS only).
    const locate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      fitBoundsOptions: { maxZoom: 10 },
    });
    // Finding yourself opens the point forecast there, as if you had tapped the spot.
    locate.on("geolocate", (e) => latest.current.onLocate({ lon: e.coords.longitude, lat: e.coords.latitude }));
    map.touchZoomRotate.disableRotation(); // pinch still zooms
    map.keyboard.disableRotation();
    map.once("load", () => map.setBearing(0)); // a shared link may carry an old bearing
    map.addControl(locate, "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    // Hover card: mouse only (touch has tap-for-forecast). It appears once the pointer rests
    // for a moment and disappears as soon as it moves or the map is dragged.
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
      let rest = 0;
      let shown = false;
      const hide = () => {
        clearTimeout(rest);
        if (shown) latest.current.onHover(null);
        shown = false;
      };
      map.on("mousemove", (e: maplibregl.MapMouseEvent) => {
        hide();
        if (e.originalEvent.buttons) return;
        const at = { lon: e.lngLat.lng, lat: e.lngLat.lat, x: e.point.x, y: e.point.y };
        rest = window.setTimeout(() => {
          shown = true;
          latest.current.onHover(at);
        }, 400);
      });
      map.getCanvas().addEventListener("mouseleave", hide);
      map.on("movestart", hide);
    }
    map.on("click", (e: maplibregl.MapMouseEvent) => latest.current.onPick({ lon: e.lngLat.lng, lat: e.lngLat.lat }));
    mapRef.current = map;
    // Zooming out stops once the world is as wide as the screen, so it never shows twice side by side
    // (MapLibre's world is 512 px wide at zoom 0). Copies stay on, so panning across 180° still wraps.
    const fitWorld = () => map.setMinZoom(Math.max(1, Math.log2(map.getContainer().clientWidth / 512)));
    fitWorld();
    map.on("resize", fitWorld);
    ready.current = new Promise((r) => map.on("load", () => r()));
    // Fetch frames for what is on screen, with a margin so small pans need nothing new.
    const updateView = () => {
      const b = map.getBounds();
      const stride = strideFor(map.getZoom());
      const padX = (b.getEast() - b.getWest()) * 0.5;
      const padY = (b.getNorth() - b.getSouth()) * 0.5;
      const v = {
        west: b.getWest() - padX,
        east: b.getEast() + padX,
        south: Math.max(-90, b.getSouth() - padY),
        north: Math.min(90, b.getNorth() + padY),
        stride,
      };
      setView((old) =>
        old &&
        old.stride === stride &&
        old.west <= v.west + padX * 0.9 &&
        old.east >= v.east - padX * 0.9 &&
        old.south <= v.south + padY * 0.9 &&
        old.north >= v.north - padY * 0.9
          ? old
          : v,
      );
    };
    map.on("moveend", updateView);
    map.on("load", updateView);
    particles.current = new Particles(map, particleCanvas.current!);
    arrowOverlay.current = new ArrowOverlay(map, arrowCanvas.current!);
    return () => map.remove();
  }, []);

  // Everything the current layer needs for one box: shaded value, particle vectors, raw fields.
  const load = async (v: View) => {
    const { layer, manifest, runId, time, vectorManifest, vectorRunId } = props;
    const m = manifest!;
    const i = indexFor(m, time);
    const scalarFields = await Promise.all(layer.scalar.map((x) => getFrame(m, runId!, x, i, v)));
    let vec: Field[] = [];
    const fl = props.flow;
    if (fl.vars && vectorManifest && vectorRunId) {
      const vi = indexFor(vectorManifest, time);
      vec = await Promise.all(fl.vars.map((x) => getFrame(vectorManifest, vectorRunId, x, vi, v))).catch(() => []);
    }
    if (fl.waveDir && vectorManifest && vectorRunId) {
      // Unit vectors towards where the waves travel, so directions either side of north blend.
      const d = await getFrame(vectorManifest, vectorRunId, fl.waveDir, indexFor(vectorManifest, time), v).catch(
        () => null,
      );
      if (d) {
        const rad = Array.from(d.values, (x) => ((x + 180) * Math.PI) / 180);
        vec = [
          new Field(d.grid, Float32Array.from(rad, Math.sin)),
          new Field(d.grid, Float32Array.from(rad, Math.cos)),
        ];
      }
    }
    const also = await Promise.all((layer.also ?? []).map((x) => getFrame(m, runId!, x, i, v))).catch(() => []);
    const job = jobFor(layer, scalarFields.length === 2 ? "speed" : "scalar", [scalarFields]);
    return { scalarFields, vec, job, also };
  };

  // Shade a field into one image source, cutting at 180 into a second source when needed. The shading runs
  // in a worker (shadeClient.ts); false when a newer draw superseded this one.
  const paint = async (job: ShadeJob, ids: [string, string?], isCurrent: () => boolean) => {
    const map = mapRef.current!;
    const grid = job.grid;
    const shaded = await shadeImage(ids[0], job);
    if (!shaded) return false;
    const { west, east } = cutAt180(grid, shaded.width);
    const urlA = URL.createObjectURL(shaded.a);
    const urlB = shaded.b ? URL.createObjectURL(shaded.b) : BLANK;
    const revoke = () => [urlA, urlB].forEach((u) => u.startsWith("blob:") && URL.revokeObjectURL(u));
    if (!isCurrent()) {
      revoke(); // superseded by a newer draw (scrubbing, playing, panning)
      return false;
    }
    const [, [, n85], , [, s85]] = corners(grid);
    (map.getSource(ids[0]) as maplibregl.ImageSource).updateImage({
      url: urlA,
      coordinates: [
        [west, n85],
        [Math.min(east, 180), n85],
        [Math.min(east, 180), s85],
        [west, s85],
      ],
    });
    if (ids[1]) {
      if (east > 180) {
        (map.getSource(ids[1]) as maplibregl.ImageSource).updateImage({
          url: urlB,
          coordinates: [
            [-180, n85],
            [east - 360, n85],
            [east - 360, s85],
            [-180, s85],
          ],
        });
      }
      map.setLayoutProperty(ids[1], "visibility", east > 180 ? "visible" : "none");
      if (map.getLayer(`${ids[1]}-top`))
        map.setLayoutProperty(`${ids[1]}-top`, "visibility", east > 180 && !props.layer.seaOnly ? "visible" : "none");
    }
    setTimeout(revoke, 5000); // MapLibre has loaded the image by then
    return true;
  };

  // Arrows every ARROW_PX across the view where there is a current (the raw field: none on land); null clears.
  const currentArrows = (uv: Field[] | null) => {
    const map = mapRef.current!;
    const arrows: Arrow[] = [];
    if (uv?.length === 2) {
      const { width, height } = map.getCanvas().getBoundingClientRect();
      for (let y = ARROW_PX / 2; y < height; y += ARROW_PX)
        for (let x = ARROW_PX / 2; x < width; x += ARROW_PX) {
          const { lng, lat } = map.unproject([x, y]);
          const u = uv[0].at(lng, lat);
          const v = uv[1].at(lng, lat);
          if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
          arrows.push({ lng, lat, to: (Math.atan2(u, v) * 180) / Math.PI, kn: Math.hypot(u, v) * 1.94384 });
        }
    }
    arrowOverlay.current?.set(arrows);
  };

  // Particles read the detailed vectors where loaded and the world base elsewhere.
  const sampleVec = (lon: number, lat: number): [number, number] | null => {
    for (const vec of [detailVec.current, baseVec.current]) {
      if (vec.length !== 2) continue;
      const a = vec[0].at(lon, lat);
      const b = vec[1].at(lon, lat);
      if (Number.isFinite(a) && Number.isFinite(b)) return [a, b];
    }
    return null;
  };

  // The world base at 1 degree: redrawn when the layer, run or time changes but never on a pan,
  // so newly exposed map always shows the weather at once, sharpening as detail lands.
  useEffect(() => {
    if (!props.manifest || !props.runId) return;
    const n = ++baseDraw.current;
    (async () => {
      await ready.current;
      const r = await load({ west: -180, east: 180, south: -90, north: 90, stride: 4 });
      if (n !== baseDraw.current) return;
      baseVec.current = r.vec;
      await paint(r.job, ["shade-base"], () => n === baseDraw.current);
      if (r.vec.length === 2) particles.current!.set(sampleVec, props.flow.scale, props.flow.kind, props.flow.colour);
      else particles.current!.set(null);
    })().catch((e) => console.error(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.layer, props.manifest, props.runId, props.vectorManifest, props.vectorRunId, props.flow.kind, props.time]);

  // Detail for the view on top; a newer draw cancels an older one.
  useEffect(() => {
    const { layer, manifest, runId } = props;
    if (!manifest || !runId || !view) return;
    const n = ++draw.current;
    (async () => {
      await ready.current;
      const map = mapRef.current!;
      const r = await load(view);
      if (n !== draw.current) return;
      if (!(await paint(r.job, ["shade", "shade2"], () => n === draw.current))) return;
      detailVec.current = r.vec;
      currentArrows(layer.id === "currents" ? r.scalarFields : null);

      // Sea-only layers sit under the land fill. Weather sits under it too, with softer copies on top (see style).
      map.moveLayer("land", layer.seaOnly ? "land-outline" : "shade-base-top");
      for (const id of ["shade-base-top", "shade-top"])
        map.setLayoutProperty(id, "visibility", layer.seaOnly ? "none" : "visible");
      if (layer.seaOnly) map.setLayoutProperty("shade2-top", "visibility", "none");

      const iso = map.getSource("isobars") as maplibregl.GeoJSONSource;
      const hl = map.getSource("centres") as maplibregl.GeoJSONSource;
      // Isobars from the pressure field, whether it is the shaded one or loaded alongside (wind).
      const mslp = layer.isobars ? r.also[layer.also!.indexOf("mslp")] : undefined;
      if (mslp) {
        iso.setData(isobars(mslp));
        hl.setData({
          type: "FeatureCollection",
          features: centres(mslp).map(({ lon, lat, ...properties }) => ({
            type: "Feature",
            properties,
            geometry: { type: "Point", coordinates: [lon, lat] },
          })),
        });
      } else {
        iso.setData(EMPTY);
        hl.setData(EMPTY);
      }

      const named: Record<string, Field> = {};
      layer.scalar.forEach((v, k) => (named[v] = r.scalarFields[k]));
      r.also.forEach((f, k) => (named[layer.also![k]] = f));
      if (props.flow.vars && r.vec.length === 2) props.flow.vars.forEach((v, k) => (named[v] = r.vec[k]));
      props.onFields(named);
    })().catch((e) => console.error(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.layer,
    props.manifest,
    props.runId,
    props.vectorManifest,
    props.vectorRunId,
    props.flow.kind,
    props.time,
    view,
  ]);

  useEffect(() => {
    (async () => {
      await ready.current;
      for (const [id] of SATELLITES)
        mapRef.current!.setLayoutProperty(id, "visibility", props.satellite ? "visible" : "none");
    })();
  }, [props.satellite]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    marker.current?.remove();
    if (props.pick) {
      const el = document.createElement("div");
      el.className = "pick";
      marker.current = new maplibregl.Marker({ element: el }).setLngLat([props.pick.lon, props.pick.lat]).addTo(map);
    }
  }, [props.pick]);

  return (
    <div className="map-wrap">
      <div ref={box} className="map" />
      <canvas ref={particleCanvas} className="particles" />
      <canvas ref={arrowCanvas} className="particles current-arrows" />
    </div>
  );
}
