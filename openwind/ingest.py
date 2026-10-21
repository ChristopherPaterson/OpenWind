"""Fetch new model runs, crop them to the served grid and publish them as immutable run folders.

    python -m openwind.ingest            # one pass over every model
    python -m openwind.ingest --loop     # pass every 10 minutes (the worker container)
    python -m openwind.ingest gfs        # one model
    python -m openwind.ingest --force    # re-ingest the latest run even if it is already live

A run folder holds one array per variable (float16; float32 for pressure and temperature),
shape (time, lat, lon), plus
manifest.json. It is written under a temporary name and renamed into place only after
every check passes, so readers never see a half-written run and a failed run leaves
the previous one live.
"""

import json
import logging
import random
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import httpx
import numpy as np

from . import config, health, store
from .grib import LATS, LONS, decode
from .sources import MODELS, Model

log = logging.getLogger("openwind.ingest")

# Physical sanity limits in SI units; a value outside these means a decoding fault.
BOUNDS = {
    "wind_u": (-100, 100),
    "wind_v": (-100, 100),
    "gust": (0, 120),
    "mslp": (85000, 110000),
    "precip_rate": (0, 0.1),
    "temp_2m": (180, 340),
    "cloud": (0, 1.0001),
    "current_u": (-6, 6),
    "current_v": (-6, 6),
    "cape": (0, 25000),
    "wind250_u": (-160, 160),
    "wind250_v": (-160, 160),
    "visibility": (0, 100000),
    "precip_total": (0, 10000),
    "precip_24h": (0, 3000),
}
# Allowed missing steps: gust and rain rate have no value at step 0 in some models.
MAX_MISSING = 1


def run_id(run: datetime) -> str:
    return f"{run:%Y%m%d%H}"


def model_dir(model: Model):
    return config.DATA_DIR / "runs" / model.id


def published(model: Model) -> list[str]:
    d = model_dir(model)
    return sorted(p.name for p in d.iterdir() if (p / "manifest.json").exists()) if d.exists() else []


def client() -> httpx.Client:
    return httpx.Client(timeout=60, transport=httpx.HTTPTransport(retries=3), follow_redirects=True)


def get(http: httpx.Client, url: str, **kw) -> httpx.Response:
    """GET with backoff on throttling: S3 answers bursts of range requests with 503 Slow Down."""
    for attempt in range(6):
        r = http.get(url, **kw)
        if r.status_code not in (429, 500, 502, 503, 504):
            break
        time.sleep(min(30, 2**attempt) + random.random())
    r.raise_for_status()
    return r


def available(http: httpx.Client, model: Model, run: datetime) -> bool:
    """A run counts as published once the index of its last step exists."""
    return http.head(model.index_url(run, model.steps(run)[-1])).status_code == 200


def fetch_step(http, model, run, step):
    if hasattr(model, "fetch_step"):  # models without byte-range indexes fetch their own way
        return model.fetch_step(http, get, run, step)
    entries = model.parse_index(get(http, model.index_url(run, step)).text)
    url, out = model.file_url(run, step), {}
    for name, var in model.variables.items():
        if step < var.from_step:
            continue
        key = next((k for k in var.key.split("|") if k in entries), None)
        if key is None:
            continue
        start, length = entries[key]
        end = "" if length is None else start + length - 1
        msg = get(http, url, headers={"Range": f"bytes={start}-{end}"})
        out[name] = var.to_si(decode(msg.content))
    return out


def fit(dst: np.ndarray, values: np.ndarray) -> np.ndarray:
    """Values outside float16's range (GRIB missing-value markers, 9.999e20) become NaN rather than inf."""
    if dst.dtype == np.float16:
        return np.where(np.abs(values) > 65000, np.nan, values)
    return values


def derive(model: Model, arrays: dict, steps: list[int]):
    """Fields computed from downloaded ones, a step at a time to keep memory flat.

    precip_rate from an accumulated total (ICON): the change since the previous step.
    precip_24h: rain over the 24 h after each step, so a sailor reads "how much in the next day".
    From a total it is the difference; from instantaneous rates, a trapezoid sum. NaN where the
    run ends before the 24 h does.
    """
    hours = np.array(steps, float)
    if "precip_total" in arrays and "precip_rate" in model.derived:
        tot, rate = arrays["precip_total"], arrays["precip_rate"]
        for i in range(1, len(steps)):
            gained = np.maximum(0, tot[i].astype(np.float32) - tot[i - 1])
            rate[i] = gained / ((hours[i] - hours[i - 1]) * 3600)
        rate[0] = rate[1]
    if "precip_24h" in model.derived:
        out = arrays["precip_24h"]
        for i in range(len(steps)):
            j = np.searchsorted(hours, hours[i] + 24)
            if j >= len(steps) or hours[j] != hours[i] + 24:
                continue  # stays NaN past the end of the run
            if "precip_total" in arrays:
                total = arrays["precip_total"]
                out[i] = np.maximum(0, total[j].astype(np.float32) - total[i])
            else:
                r = arrays["precip_rate"]
                acc = np.zeros(out.shape[1:], np.float32)
                for k in range(i, j):
                    acc += (r[k].astype(np.float32) + r[k + 1]) / 2 * (hours[k + 1] - hours[k]) * 3600
                out[i] = acc


def check(model: Model, arrays: dict, missing: dict) -> list[str]:
    problems = []
    for name, n in missing.items():
        if n > MAX_MISSING:
            problems.append(f"{name}: {n} steps missing")
    for name, arr in arrays.items():
        lo, hi = BOUNDS.get(name, (-np.inf, np.inf))
        finite = arr[np.isfinite(arr)]
        if finite.size == 0:
            problems.append(f"{name}: no values")
        elif finite.min() < lo or finite.max() > hi:
            problems.append(f"{name}: {finite.min():.4g}..{finite.max():.4g} outside {lo}..{hi}")
    return problems


def ingest(http: httpx.Client, model: Model, run: datetime) -> bool:
    rid, steps = run_id(run), model.steps(run)
    tmp = model_dir(model) / f".tmp-{rid}"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    shape = (len(steps), len(LATS), len(LONS))
    arrays = {
        name: np.lib.format.open_memmap(
            tmp / f"{name}.npy", "w+", np.float32 if name in config.FLOAT32_VARS else np.float16, shape
        )
        for name in [*model.variables, *model.derived]
    }
    for a in arrays.values():
        a[:] = np.nan
    started = time.monotonic()
    if hasattr(model, "prepare"):
        model.prepare(http, get, run)

    def one(i_step):
        i, step = i_step
        got = fetch_step(http, model, run, step)
        for name, values in got.items():
            arrays[name][i] = fit(arrays[name], values)
        return set(got)  # not got.keys(): a keys view keeps every step's decoded grids alive

    with ThreadPoolExecutor(8) as pool:
        found = list(pool.map(one, enumerate(steps)))
    missing = {
        name: sum(name not in f for f, s in zip(found, steps) if s >= var.from_step)
        for name, var in model.variables.items()
    }
    derive(model, arrays, steps)

    problems = check(model, arrays, missing)
    for a in arrays.values():
        a.flush()
    if problems:
        log.error("%s %s rejected: %s", model.id, rid, "; ".join(problems))
        shutil.rmtree(tmp)
        return False

    manifest = {
        "schema": 1,
        "model": model.id,
        "name": model.name,
        "provider": model.provider,
        "run": run.isoformat(),
        "ingested": datetime.now(UTC).isoformat(timespec="seconds"),
        "valid_times": [(run.timestamp() + s * 3600) * 1000 for s in steps],
        "steps_hours": steps,
        "grid": {
            "north": config.NORTH,
            "south": config.SOUTH,
            "west": config.WEST,
            "east": config.EAST,
            "step": config.STEP,
            "ny": len(LATS),
            "nx": len(LONS),
            "order": "north-first",
        },
        "variables": {
            **{name: {"unit": v.unit, "missing_steps": missing[name]} for name, v in model.variables.items()},
            **{name: {"unit": unit, "derived": True} for name, unit in model.derived.items()},
        },
        "attribution": model.attribution,
        "licence": model.licence,
        "disclaimer": "Not for navigation.",
    }
    (tmp / "manifest.json").write_text(json.dumps(manifest, indent=1))
    final = model_dir(model) / rid
    store.publish(tmp, final)
    log.info("%s %s published in %.0fs", model.id, rid, time.monotonic() - started)
    for old in published(model)[: -config.KEEP_RUNS]:
        shutil.rmtree(model_dir(model) / old)
    return True


def pass_once(ids=None, force=False):
    now = datetime.now(UTC)
    h = health.read()
    order = list(ids or MODELS)
    # A model still marked as being ingested means the last process died during it (killed, out of memory).
    # It goes last this pass so it can't hold up the others, and counts as a failure.
    if (dead := h.pop("attempting", None)) in order:
        log.error("%s: the previous ingest died mid-run; trying it last", dead)
        health.note(h, dead, False, "ingest process died mid-run")
        order.remove(dead)
        order.append(dead)
    health.write(h)
    try:
        _pass(order, force, now, h)
    finally:
        h.pop("attempting", None)
        h["checked_at"] = time.time()
        health.write(h)


def _pass(order, force, now, h):
    with client() as http:
        for model in (MODELS[i] for i in order):
            h["attempting"] = model.id
            health.write(h)
            have = published(model)
            for run in model.latest_cycles(now):
                if have and (run_id(run) < have[-1] or (run_id(run) == have[-1] and not force)):
                    break  # nothing newer than what is live
                try:
                    if available(http, model, run):
                        log.info("%s %s available, ingesting", model.id, run_id(run))
                        ok = ingest(http, model, run)
                        health.note(h, model.id, ok, "" if ok else f"run {run_id(run)} failed its checks")
                        break
                except Exception as e:
                    log.exception("%s %s failed", model.id, run_id(run))
                    health.note(h, model.id, False, f"run {run_id(run)}: {type(e).__name__}: {e}")
                    break


def main(argv):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    loop = "--loop" in argv
    ids = [a for a in argv if not a.startswith("-")] or None
    while True:
        pass_once(ids, force="--force" in argv)
        if not loop:
            return
        time.sleep(600)


if __name__ == "__main__":
    main(sys.argv[1:])
