// Unit tests for the app's pure logic: which fields the particles show, layer sources, pressure maths.
import { describe, expect, it } from "vitest";
import { flowFor, flowModel, LAYERS, sourceModel } from "./layers";
import { extent } from "./models";
import { centres, isobars } from "./pressure";

describe("particles", () => {
  const wind = LAYERS.find((l) => l.id === "wind")!;
  it("follow the layer unless another field is picked", () => {
    expect(flowFor(wind, "auto").vars).toEqual(["wind_u", "wind_v"]);
    expect(flowFor(wind, "currents").vars).toEqual(["current_u", "current_v"]);
    expect(flowFor(wind, "off").vars).toBeUndefined();
  });
  it("take currents from ECMWF and waves from the picked model's wave run", () => {
    expect(flowModel(flowFor(wind, "currents"), "gfs")).toBe("ecmwf");
    expect(flowModel(flowFor(wind, "waves"), "icon")).toBe("icon-wave");
    expect(
      flowModel(
        flowFor(
          LAYERS.find((l) => l.id === "jet")!,
          "auto",
        ),
        "icon",
      ),
    ).toBe("gfs");
  });
});

describe("layers", () => {
  it("fall back to a model that has the field", () => {
    const by = (id: string) => LAYERS.find((l) => l.id === id)!;
    expect(sourceModel(by("currents"), "gfs")).toBe("ecmwf");
    expect(sourceModel(by("waves"), "ecmwf")).toBe("ecmwf-wave");
    expect(sourceModel(by("visibility"), "icon")).toBe("gfs");
    expect(sourceModel(by("wind"), "icon")).toBe("icon");
  });
  it("all have a colour ramp that rises", () => {
    for (const l of LAYERS) expect(l.ramp.every(([v], i) => i === 0 || v > l.ramp[i - 1][0])).toBe(true);
  });
});

describe("pressure", () => {
  // A 21x21 grid at 1 degree with a low in the middle: 1000 hPa there, rising 1 hPa per cell outwards.
  const g = { nx: 21, ny: 21, west: 140, north: -20, step: 1 };
  const pa = Float32Array.from({ length: 441 }, (_, i) => {
    const x = (i % 21) - 10;
    const y = Math.floor(i / 21) - 10;
    return (1000 + Math.hypot(x, y)) * 100;
  });
  it("finds the low at the centre", () => {
    const found = centres(pa, g);
    expect(found).toMatchObject([{ lon: 150, lat: -30, kind: "L", hpa: 1000 }]);
    expect(found[0].depth).toBeCloseTo(Math.hypot(5, 5) * 100, 0); // rise to the edge of its ~5 degree window
  });
  it("draws isobars every 4 hPa", () => {
    const levels = new Set(isobars(pa, g).features.map((f) => f.properties.hpa));
    expect([...levels].sort()).toEqual([1004, 1008, 1012]); // the corners reach 1014 hPa
  });
  it("extent ignores nothing and never overflows the stack", () => {
    expect(extent(new Float32Array(200000).fill(3))).toEqual([3, 3]);
  });
});
