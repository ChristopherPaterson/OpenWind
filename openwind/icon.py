"""DWD ICON global: one bzip2'd GRIB2 file per variable and step on the icosahedral grid
(~13 km, 2,949,120 cells). Each served grid point takes its nearest ICON cell; the mapping is
built once from DWD's cell-centre coordinates and cached in the data directory.

ponytail: nearest-cell, not conservative remapping. At 13 km into 28 km cells the difference is
smaller than the models disagree; DWD's CDO weights are the upgrade if it ever matters.
"""

import bz2
import logging

import eccodes
import numpy as np

from . import config
from .grib import LATS, LONS

log = logging.getLogger("openwind.icon")
BASE = "https://opendata.dwd.de/weather/nwp/icon/grib"


def file_url(run, step, param):
    return (
        f"{BASE}/{run:%H}/{param}/icon_global_icosahedral_single-level_"
        f"{run:%Y%m%d%H}_{step:03d}_{param.upper()}.grib2.bz2"
    )


def values(blob: bytes) -> np.ndarray:
    h = eccodes.codes_new_from_message(bz2.decompress(blob))
    try:
        v = eccodes.codes_get_values(h).astype(np.float32)
        if eccodes.codes_get(h, "bitmapPresent"):
            v[v == eccodes.codes_get(h, "missingValue")] = np.nan
        return v
    finally:
        eccodes.codes_release(h)


def _xyz(lat_deg, lon_deg):
    la, lo = np.radians(lat_deg), np.radians(lon_deg)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)


def nearest_map(http, get, run) -> np.ndarray:
    """Index of the nearest ICON cell for every served grid point, (ny, nx)."""
    path = config.DATA_DIR / "icon-nearest.npy"
    if path.exists():
        return np.load(path)
    from scipy.spatial import cKDTree

    def invariant(name):
        url = (
            f"{BASE}/{run:%H}/{name}/icon_global_icosahedral_time-invariant_"
            f"{run:%Y%m%d%H}_{name.upper()}.grib2.bz2"
        )
        return values(get(http, url).content).astype(np.float64)

    clat, clon = invariant("clat"), invariant("clon")
    if np.abs(clat).max() <= np.pi + 1e-6:  # radians in some releases
        clat, clon = np.degrees(clat), np.degrees(clon)
    tree = cKDTree(_xyz(clat, clon))
    glat, glon = np.meshgrid(LATS, LONS, indexing="ij")
    _, idx = tree.query(_xyz(glat, glon).reshape(-1, 3))
    idx = idx.astype(np.int32).reshape(len(LATS), len(LONS))
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, idx)
    log.info("built ICON nearest-cell map %s", idx.shape)
    return idx
