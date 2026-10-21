"""HTTP API for the map. Values are SI; every model block names its run, licence and attribution.

Only the web app calls it (same origin, through Caddy): there are no API keys, no CORS and no public docs.
"""

import asyncio
import logging
import time
from collections import deque

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from . import health, store
from .sources import MODELS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("openwind.api")

app = FastAPI(title="OpenWind", docs_url=None, redoc_url=None, openapi_url=None)

# Point forecasts read every model's run: a few per click, so this is generous for people and stops a
# script from tying up the server. Past the limit a client waits; past the CPU budget everyone waits briefly.
POINT_PER_MIN = 60
COMPUTE = asyncio.Semaphore(6)
COMPUTE_WAIT_S = 20
# ponytail: per-process, in-memory limits; fine for one API container, use a shared store if you run several.
_recent: dict[str, deque] = {}


@app.exception_handler(RequestValidationError)
async def invalid(_request: Request, exc: RequestValidationError):
    """422 with where and what, but never the submitted values echoed back."""
    return JSONResponse({"detail": [{"loc": e.get("loc"), "msg": e.get("msg")} for e in exc.errors()]}, 422)


def _allowed(ip: str, now: float) -> float:
    """0 if this address may make another point request now, else seconds to wait."""
    q = _recent.setdefault(ip, deque())
    while q and q[0] <= now - 60:
        q.popleft()
    if len(q) >= POINT_PER_MIN:
        return q[0] + 60 - now
    q.append(now)
    if len(_recent) > 10_000:  # forget quiet addresses so the table can't grow without bound
        for k in [k for k, v in _recent.items() if not v or v[-1] <= now - 60]:
            del _recent[k]
    return 0


@app.middleware("http")
async def limits(request: Request, call_next):
    if request.url.path != "/v1/point":
        return await call_next(request)
    # The client address as Caddy saw it (uvicorn's --proxy-headers; the API port is never published).
    ip = request.client.host if request.client else "unknown"
    wait = _allowed(ip, time.time())
    if wait > 0:
        return JSONResponse(
            {"detail": f"Too many requests. Try again in {wait:.0f} s."},
            429,
            headers={"Retry-After": str(max(1, round(wait)))},
        )
    try:
        await asyncio.wait_for(COMPUTE.acquire(), COMPUTE_WAIT_S)
    except TimeoutError:
        return JSONResponse(
            {"detail": "The server is busy. Try again shortly."}, 503, headers={"Retry-After": "10"}
        )
    try:
        return await call_next(request)
    finally:
        COMPUTE.release()


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/v1/health")
def health_check():
    """ok, or degraded with the models that are late or failing, or the ingest loop stopped."""
    return health.summary(time.time())


@app.get("/v1/models")
def models():
    return {"models": store.models_status(time.time()), "disclaimer": "Not for navigation."}


@app.get("/v1/point")
def point(
    lat: float = Query(ge=-90, le=90, allow_inf_nan=False),
    lon: float = Query(ge=-180, le=360, allow_inf_nan=False),
    models: str = Query("gfs,ecmwf,icon,gfs-wave,ecmwf-wave", max_length=200),
    vars: str | None = Query(None, max_length=1000),
):
    """Every chosen model's series at a point. Values are SI: wind and currents in m/s (u east, v north),
    pressure in Pa, waves in m and s. A model with no data there (over land for waves) has no `series`."""
    ids = list(dict.fromkeys(m for m in models.split(",") if m))[: len(MODELS)]
    if any(m not in MODELS for m in ids):
        raise HTTPException(400, "unknown model")
    wanted = set(vars.split(",")) if vars else None
    lon = lon % 360
    return {
        "lat": lat,
        "lon": lon,
        "models": [r for r in (store.point(m, lat, lon, wanted) for m in ids) if r],
        "disclaimer": "Not for navigation.",
    }


@app.get("/v1/frame/{model}/{run}/{var}/{index}")
def frame(
    model: str,
    run: str,
    var: str,
    index: int,
    b: str | None = Query(None, max_length=60, description="W,S,E,N on a 10 degree grid; E may pass 180"),
    s: int = Query(1, description="Every s-th cell: 1 = 0.25 deg, 2 = 0.5, 4 = 1, 8 = 2"),
):
    """One variable at one time step over a box, for drawing on the device.

    Body: float32 lo, float32 hi, uint32 ny, uint32 nx (little-endian), then ny*nx bytes, rows
    north to south; value = lo + b/254*(hi-lo), 255 = no data. Run folders never change, so
    this caches forever.
    """
    if s not in (1, 2, 4, 8):
        raise HTTPException(400, "s must be 1, 2, 4 or 8")
    bbox = None
    if b:
        try:
            w, so, e, n = (float(x) for x in b.split(","))
        except ValueError:
            raise HTTPException(400, "b is west,south,east,north") from None
        if not (-90 <= so < n <= 90 and w < e <= w + 360) or any(v % 10 for v in (w, so, e, n)):
            raise HTTPException(400, "b must be a box on a 10 degree grid")
        bbox = (w, so, e, n)
    q = store.frame(model, run, var, index, bbox, s)
    if q is None:
        raise HTTPException(404, "no such frame")
    return Response(
        q,
        media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
