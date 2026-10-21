import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("OPENWIND_DATA_DIR", "/data"))

# Whole world, north-first rows like the source grids; columns from 180W, wrapping at the
# antimeridian. Any regular sub-region also works (runs carry their own grid).
NORTH, SOUTH, WEST, EAST, STEP = 90.0, -90.0, -180.0, 179.75, 0.25

# float16 halves the disk for a global run; pressure and temperature stay float32 because
# float16 resolves 100000 Pa only to 64 Pa and 300 K only to 0.25 K.
FLOAT32_VARS = {"mslp", "temp_2m"}

KEEP_RUNS = 2  # per model; the previous run stays live if a new one fails checks
