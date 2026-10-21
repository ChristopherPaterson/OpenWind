"""Ingest health: what each pass found, and problems by model. The ingest writes health.json after every
pass; /v1/health reads it."""

import json
import time

from . import config, store

STALE_PASS_S = 30 * 60  # the loop runs every 10 minutes


def path():
    return config.DATA_DIR / "health.json"


def read(p=None) -> dict:
    try:
        return json.loads((p or path()).read_text())
    except (OSError, ValueError):
        return {"models": {}}


def write(h: dict, p=None):
    p = p or path()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(h, indent=1))
    tmp.replace(p)


def note(h: dict, model_id: str, ok: bool, message: str = ""):
    m = h["models"].setdefault(model_id, {"failures": 0})
    now = time.time()
    if ok:
        m.update(last_ok=now, failures=0)
    else:
        m.update(last_error=message[:300], last_error_at=now, failures=m.get("failures", 0) + 1)


def problems(h: dict, now: float) -> dict:
    """Model id -> reason, for models that are late or failing repeatedly."""
    out = {}
    for s in store.models_status(now):
        m = h["models"].get(s["id"], {})
        if m.get("failures", 0) >= 2:
            out[s["id"]] = f"{s['name']}: ingest failing ({m.get('last_error', 'unknown error')})"
        elif s["status"] in ("late", "no data"):
            last = f", last run {s['run'][:13]}Z" if s.get("run") else ""
            out[s["id"]] = f"{s['name']}: {s['status']}{last}"
    return out


def summary(now: float) -> dict:
    """ok, or degraded with the problems. Model names and times only: error text stays in the logs."""
    h = read()
    checked = h.get("checked_at")
    current = problems(h, now)
    if checked is None or now - checked >= STALE_PASS_S:
        current["ingest"] = "ingest loop has not checked in for over 30 minutes"
    return {
        "status": "ok" if not current else "degraded",
        "problems": sorted(current),
        "ingest_checked_at": checked,
        "models": store.models_status(now),
    }
