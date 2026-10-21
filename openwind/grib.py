"""Decode one GRIB2 message and crop it to the served grid (the whole world by default)."""

import eccodes
import numpy as np

from .config import EAST, NORTH, SOUTH, STEP, WEST

LATS = np.arange(NORTH, SOUTH - STEP / 2, -STEP)
LONS = np.arange(WEST, EAST + STEP / 2, STEP)


def crop_indices(lat_first, lon_first, d, ni, nj, north_first=True):
    """Row and column indices of the served grid in a regular lat/lon source grid. Rows the
    source does not cover (DWD's wave model stops at 85S) come back as -1."""
    rows = np.rint((lat_first - LATS) / d if north_first else (LATS - lat_first) / d).astype(int)
    cols = np.rint(((LONS - lon_first) % 360) / d).astype(int) % ni
    if rows.max() < 0 or rows.min() >= nj:
        raise ValueError("served grid outside source grid")
    rows[(rows < 0) | (rows >= nj)] = -1
    return rows, cols


def decode(message: bytes) -> np.ndarray:
    h = eccodes.codes_new_from_message(message)
    try:
        ni, nj = eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")
        d = eccodes.codes_get(h, "iDirectionIncrementInDegrees")
        if abs(d - STEP) > 1e-6:
            raise ValueError(f"grid step {d} is not {STEP}")
        values = eccodes.codes_get_values(h).astype(np.float32)
        if eccodes.codes_get(h, "bitmapPresent"):
            values[values == eccodes.codes_get(h, "missingValue")] = np.nan
        rows, cols = crop_indices(
            eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees"),
            eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees"),
            d,
            ni,
            nj,
            north_first=not eccodes.codes_get(h, "jScansPositively"),
        )
        out = values.reshape(nj, ni)[np.ix_(np.maximum(rows, 0), cols)]
        out[rows < 0] = np.nan
        return out
    finally:
        eccodes.codes_release(h)
