"""Read published runs: latest run per model and values at a point."""

import json
import math
import shutil
from datetime import datetime
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import config
from .sources import MODELS


def load_run(path: Path) -> tuple[dict, dict] | None:
    """Manifest plus memory-mapped arrays, or None if the run has just been removed or replaced.

    Cached on the manifest's mtime, since a forced re-ingest replaces a run folder in place."""
    try:
        return _open_run(path, (path / "manifest.json").stat().st_mtime_ns)
    except OSError:  # pruned or swapped by the ingest between listing and opening
        return None


@lru_cache(maxsize=16)
def _open_run(path: Path, _mtime: int) -> tuple[dict, dict]:
    manifest = json.loads((path / "manifest.json").read_text())
    arrays = {name: np.load(path / f"{name}.npy", mmap_mode="r") for name in manifest["variables"]}
    return manifest, arrays


def publish(tmp: Path, final: Path):
    """Swap a finished run folder into place. An existing folder of the same name (a forced re-ingest) is
    moved aside first and deleted after, so readers never find it missing."""
    old = final.with_name(f".old-{final.name}")
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        final.rename(old)
    tmp.rename(final)
    shutil.rmtree(old, ignore_errors=True)


def wraps(grid: dict) -> bool:
    """True when the columns go all the way round the world."""
    return abs(grid["nx"] * grid["step"] - 360) < 1e-6


def latest(model_id: str):
    d = config.DATA_DIR / "runs" / model_id
    runs = sorted(p for p in d.glob("[0-9]*") if (p / "manifest.json").exists()) if d.exists() else []
    for path in reversed(runs):  # the newest that can still be opened
        run = load_run(path)
        if run is not None:
            return run
    return None


def corners(grid: dict, lat: float, lon: float):
    """The four surrounding grid cells and bilinear weights, or None outside the grid.
    A global grid wraps: the cell east of 179.75E is 180W."""
    fy = (grid["north"] - lat) / grid["step"]
    fx = ((lon - grid["west"]) % 360) / grid["step"]
    global_ = wraps(grid)
    if not 0 <= fy <= grid["ny"] - 1 or (not global_ and fx > grid["nx"] - 1):
        return None
    y0 = min(int(fy), grid["ny"] - 2)
    x0 = int(fx) if global_ else min(int(fx), grid["nx"] - 2)
    x1 = (x0 + 1) % grid["nx"]
    dy, dx = fy - y0, fx - x0
    return [
        ((y0, x0), (1 - dy) * (1 - dx)),
        ((y0, x1), (1 - dy) * dx),
        ((y0 + 1, x0), dy * (1 - dx)),
        ((y0 + 1, x1), dy * dx),
    ]


def weighted(vals: np.ndarray, cells) -> np.ndarray:
    """Bilinear through time; corners with no value (land in wave grids) are dropped and
    the rest re-weighted, so a coastal point still gets the nearby sea value."""
    w = np.array([w for _, w in cells])[:, None] * np.isfinite(vals)
    total = w.sum(axis=0)
    with np.errstate(invalid="ignore"):
        return np.where(total > 0, (np.nan_to_num(vals) * w).sum(axis=0) / total, np.nan)


def corner_values(arr, cells) -> np.ndarray:
    return np.stack([arr[:, y, x] for (y, x), _ in cells]).astype(np.float64)


def interpolate(arr, cells) -> np.ndarray:
    return weighted(corner_values(arr, cells), cells)


def interpolate_direction(arr, cells) -> np.ndarray:
    """Directions are averaged as unit vectors, so 359 and 1 give 0, not 180."""
    rad = np.radians(corner_values(arr, cells))
    return np.degrees(np.arctan2(weighted(np.sin(rad), cells), weighted(np.cos(rad), cells))) % 360


def wind_from(u, v):
    """Speed and the direction a vector comes from, degrees true (add 180 for where a current goes)."""
    return np.hypot(u, v), np.degrees(np.arctan2(-u, -v)) % 360


def clean(a, digits):
    return [None if not math.isfinite(x) else round(float(x), digits) for x in a]


DIGITS = {"Pa": 0, "K": 2, "kg m-2 s-1": 7, "1": 3, "degree_from": 0, "degree_to": 0}


def point(model_id: str, lat: float, lon: float, variables=None):
    run = latest(model_id)
    if run is None:
        return None
    return point_from(run, model_id, lat, lon, variables)


def point_from(run, model_id: str, lat: float, lon: float, variables=None):
    manifest, arrays = run
    cells = corners(manifest["grid"], lat, lon)
    if cells is None:
        return {"model": model_id, "error": "outside the model grid"}
    units = {k: v["unit"] for k, v in manifest["variables"].items()}
    series = {}
    for name, arr in arrays.items():
        if variables and name not in variables:
            continue
        if units[name] == "degree_from":
            series[name] = interpolate_direction(arr, cells)
        else:
            series[name] = interpolate(arr, cells)
    # Vectors: interpolate components, then derive speed and direction.
    for prefix, towards in (("wind", False), ("current", True)):
        if f"{prefix}_u" in series and f"{prefix}_v" in series:
            speed, frm = wind_from(series[f"{prefix}_u"], series[f"{prefix}_v"])
            series[f"{prefix}_speed"] = speed
            if towards:
                series[f"{prefix}_dir"] = (frm + 180) % 360
                units[f"{prefix}_dir"] = "degree_to"
            else:
                series[f"{prefix}_dir"] = frm
                units[f"{prefix}_dir"] = "degree_from"
            units[f"{prefix}_speed"] = "m s-1"
    return {
        "model": model_id,
        "name": manifest["name"],
        "run": manifest["run"],
        "attribution": manifest["attribution"],
        "licence": manifest["licence"],
        "times": [t / 1000 for t in manifest["valid_times"]],
        "units": {k: units[k] for k in series},
        "series": {k: clean(v, DIGITS.get(units[k], 2)) for k, v in series.items()},
    }


def models_status(now_s: float):
    out = []
    for m in MODELS.values():
        run = latest(m.id)
        item = {
            "id": m.id,
            "name": m.name,
            "provider": m.provider,
            "attribution": m.attribution,
            "licence": m.licence,
            "variables": sorted(m.variables),
        }
        if run:
            man = run[0]
            run_s = datetime.fromisoformat(man["run"]).timestamp()
            expected = run_s + (m.cycle_hours + m.lag_hours) * 3600
            item.update(
                run=man["run"],
                run_id=f"{datetime.fromisoformat(man['run']):%Y%m%d%H}",
                ingested=man["ingested"],
                valid_from=man["valid_times"][0] / 1000,
                valid_until=man["valid_times"][-1] / 1000,
                next_expected=expected,
                status="ok" if now_s < expected + 2 * 3600 else "late",
            )
        else:
            item["status"] = "no data"
        out.append(item)
    return out


def run_path(model_id: str, run: str):
    if model_id not in MODELS or not run.isdigit():
        return None
    p = config.DATA_DIR / "runs" / model_id / run
    return p if (p / "manifest.json").exists() else None


def quantise(x: np.ndarray) -> bytes:
    """Header: float32 lo, float32 hi, uint32 ny, uint32 nx (little-endian); then ny*nx bytes,
    value = lo + b/254*(hi-lo), 255 = no data."""
    x = x.astype(np.float32)
    finite = np.isfinite(x)
    lo, hi = (float(x[finite].min()), float(x[finite].max())) if finite.any() else (0.0, 0.0)
    span = hi - lo or 1.0
    q = np.where(finite, np.rint((np.nan_to_num(x) - lo) / span * 254), 255).astype(np.uint8)
    return np.array([lo, hi], "<f4").tobytes() + np.array(q.shape, "<u4").tobytes() + q.tobytes()


def subset(
    grid: dict, values: np.ndarray, west: float, south: float, east: float, north: float, stride: int
) -> np.ndarray:
    """Rows north to south and columns west to east every stride cells, wrapping round the world;
    NaN where the run's grid has no data. `east` may exceed 180 for views across the antimeridian."""
    d = grid["step"] * stride
    lats = np.arange(north, south - d / 2, -d)
    lons = np.arange(west, east + d / 2, d)
    rows = np.rint((grid["north"] - lats) / grid["step"]).astype(int)
    cols = np.rint(((lons - grid["west"]) % 360) / grid["step"]).astype(int)
    if wraps(grid):
        cols %= grid["nx"]
    ok_r = (rows >= 0) & (rows < grid["ny"])
    ok_c = (cols >= 0) & (cols < grid["nx"])
    out = np.full((len(lats), len(lons)), np.nan, np.float32)
    if ok_r.any() and ok_c.any():
        out[np.ix_(ok_r, ok_c)] = values[np.ix_(rows[ok_r], cols[ok_c])]
    return out


def frame(model_id: str, run: str, var: str, index: int, bbox=None, stride=1):
    path = run_path(model_id, run)
    if path is None:
        return None
    run = load_run(path)
    if run is None:
        return None
    manifest, arrays = run
    if var not in arrays or not 0 <= index < len(manifest["valid_times"]):
        return None
    g = manifest["grid"]
    w, s, e, n = bbox or (g["west"], g["south"], g["east"], g["north"])
    return quantise(subset(g, arrays[var][index], w, s, e, n, stride))
