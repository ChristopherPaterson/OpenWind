import { centres as pressureCentres, isobars as pressureIsobars } from "./pressure";
// Turning fields into pictures on the device: shaded image, isobars, H/L centres.

import type { Field, Grid } from "./data";
import type { ShadeJob } from "./shadeCore";
import { lut, type Layer } from "./layers";

// Web Mercator stops short of the poles.
const MAX_LAT = 85;
const top = (g: Grid) => Math.min(g.north, MAX_LAT);
const bottom = (g: Grid) => Math.max(g.south, -MAX_LAT);

/** The image corners, for a MapLibre image source. */
export function corners(g: Grid): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [g.west, top(g)],
    [g.east, top(g)],
    [g.east, bottom(g)],
    [g.west, bottom(g)],
  ];
}

/** The shading job for a layer's fields (shadeCore.ts). The display transform must be affine (every layer's is:
 * a scale, an offset or both), so it travels to the worker as two numbers. */
export function jobFor(layer: Layer, mode: ShadeJob["mode"], sets: Field[][]): ShadeJob {
  const b = layer.toDisplay(0);
  const a = layer.toDisplay(1) - b;
  if (Math.abs(layer.toDisplay(1000) - (a * 1000 + b)) > 1e-6 * Math.max(1, Math.abs(a * 1000)))
    throw new Error(`layer ${layer.id}: display transform is not affine`);
  return {
    mode,
    sets: sets.map((s) => s.map((f) => ({ grid: f.grid, values: f.values }))),
    fill: !!layer.seaOnly,
    grid: sets[0][0].grid,
    ...lut(layer),
    a,
    b,
  };
}

// Isobars and pressure centres (pressure.ts), on one frame of pressure.
export const isobars = (mslp: Field, interval = 4) => pressureIsobars(mslp.values, mslp.grid, interval);
export const centres = (mslp: Field) => pressureCentres(mslp.values, mslp.grid);
