"""Forecast models: where each run lives, which steps it has and which messages we take.

Each variable maps a canonical name to the GRIB index entry that carries it, plus a
function bringing the value to SI (fractions for cloud, kg m-2 s-1 for rain rate).
"""

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta


def ident(x):
    return x


def percent(x):
    return x / 100.0


@dataclass(frozen=True)
class Var:
    key: str  # how the message is named in the source index; "a|b" takes the first present
    unit: str
    to_si: Callable = ident
    from_step: int = 0  # maxima and means over the previous step have no value at step 0


@dataclass(frozen=True)
class Model:
    id: str
    name: str
    provider: str
    attribution: str
    licence: str
    cycle_hours: int  # runs every N hours
    lag_hours: float  # typical delay from run time until the last step is published
    variables: dict = field(default_factory=dict)
    derived: dict = field(default_factory=dict)  # name -> unit, computed after download (see ingest.derive)

    def steps(self, run: datetime) -> list[int]:
        raise NotImplementedError

    def file_url(self, run: datetime, step: int) -> str:
        raise NotImplementedError

    def index_url(self, run: datetime, step: int) -> str:
        raise NotImplementedError

    def parse_index(self, text: str) -> dict[str, tuple[int, int | None]]:
        """Map index key -> (offset, length or None for 'to end of file')."""
        raise NotImplementedError

    def latest_cycles(self, now: datetime, count=4) -> list[datetime]:
        base = now.replace(minute=0, second=0, microsecond=0)
        base -= timedelta(hours=base.hour % self.cycle_hours)
        return [base - timedelta(hours=self.cycle_hours * i) for i in range(count)]


def wanted_keys(model) -> set[str]:
    return {k for v in model.variables.values() for k in v.key.split("|")}


def parse_wgrib2_idx(text: str, wanted: set[str]) -> dict[str, tuple[int, int | None]]:
    """NOAA .idx lines are `n:offset:d=run:VAR:LEVEL:time:`; length runs to the next offset.

    Keys are `VAR:LEVEL:time-kind` where time-kind keeps averages ("0-6 hour ave fcst")
    apart from instantaneous fields ("6 hour fcst" -> "fcst").
    """
    lines = [ln.split(":") for ln in text.strip().splitlines()]
    out = {}
    for i, parts in enumerate(lines):
        kind = "ave" if " ave " in parts[5] else "acc" if " acc " in parts[5] else "fcst"
        key = f"{parts[3]}:{parts[4]}:{kind}"
        if key in wanted and key not in out:
            start = int(parts[1])
            end = int(lines[i + 1][1]) if i + 1 < len(lines) else None
            out[key] = (start, None if end is None else end - start)
    return out


class Gfs(Model):
    bucket = "https://storage.googleapis.com/global-forecast-system"

    def steps(self, run):
        return list(range(0, 121)) + list(range(123, 241, 3))

    def file_url(self, run, step):
        return f"{self.bucket}/gfs.{run:%Y%m%d}/{run:%H}/atmos/gfs.t{run:%H}z.pgrb2.0p25.f{step:03d}"

    def index_url(self, run, step):
        return self.file_url(run, step) + ".idx"

    def parse_index(self, text):
        return parse_wgrib2_idx(text, wanted_keys(self))


class GfsWave(Gfs):
    def file_url(self, run, step):
        return (
            f"{self.bucket}/gfs.{run:%Y%m%d}/{run:%H}/wave/gridded/"
            f"gfswave.t{run:%H}z.global.0p25.f{step:03d}.grib2"
        )


class Ecmwf(Model):
    # Google Cloud mirror of data.ecmwf.int: ECMWF asks bulk users to prefer the mirrors,
    # and the AWS one throttles range requests with 503 Slow Down.
    bucket = "https://storage.googleapis.com/ecmwf-open-data"
    stream = "oper"

    def steps(self, run):
        if run.hour in (0, 12):
            return list(range(0, 145, 3)) + list(range(150, 241, 6))
        return list(range(0, 145, 3))

    def file_url(self, run, step):
        return (
            f"{self.bucket}/{run:%Y%m%d}/{run:%H}z/ifs/0p25/{self.stream}/"
            f"{run:%Y%m%d%H}0000-{step}h-{self.stream}-fc.grib2"
        )

    def index_url(self, run, step):
        return self.file_url(run, step).removesuffix(".grib2") + ".index"

    def parse_index(self, text):
        wanted = wanted_keys(self)
        out = {}
        for line in text.strip().splitlines():
            j = json.loads(line)
            # Surface fields by name; pressure-level fields as "param@level", e.g. "u@250".
            key = j["param"] if j.get("levtype") == "sfc" else f"{j['param']}@{j.get('levelist')}"
            if key in wanted:
                out[key] = (j["_offset"], j["_length"])
        return out


class EcmwfWave(Ecmwf):
    stream = "wave"


class Gwam(Model):
    """DWD's global wave model (GWAM), regular 0.25 deg to 85S, one bzip2'd file per field and step."""

    base = "https://opendata.dwd.de/weather/maritime/wave_models/gwam/grib"

    def steps(self, run):
        return list(range(0, 175, 3))

    def file_url(self, run, step, param="swh"):
        return f"{self.base}/{run:%H}/{param}/GWAM_{param.upper()}_{run:%Y%m%d%H}_{step:03d}.grib2.bz2"

    def index_url(self, run, step):
        return self.file_url(run, step)  # a run is complete once its last wave height file exists

    def fetch_step(self, http, get, run, step):
        import bz2

        from .grib import decode

        out = {}
        for name, var in self.variables.items():
            r = http.get(self.file_url(run, step, var.key))
            if r.status_code == 404:
                continue
            r.raise_for_status()
            out[name] = var.to_si(decode(bz2.decompress(r.content)))
        return out


class Icon(Model):
    """DWD ICON global, regridded to the served grid (see icon.py). 3-hourly to keep a run near
    1.4 GB of downloads; 00 and 12 UTC runs go to 180 h."""

    def steps(self, run):
        return list(range(0, 181 if run.hour in (0, 12) else 121, 3))

    def index_url(self, run, step):
        from . import icon

        return icon.file_url(run, step, "pmsl")  # a run is complete once its last pressure file exists

    def prepare(self, http, get, run):
        from . import icon

        self._nearest = icon.nearest_map(http, get, run)

    def fetch_step(self, http, get, run, step):
        from . import icon

        out = {}
        for name, var in self.variables.items():
            if step < var.from_step:
                continue
            r = http.get(icon.file_url(run, step, var.key))
            if r.status_code == 404:
                continue
            r.raise_for_status()
            out[name] = var.to_si(icon.values(r.content)[self._nearest])
        return out


NOAA = "NOAA/NCEP. Public domain; no endorsement implied."
ECMWF = "Contains modified ECMWF open data, licensed CC BY 4.0."
DWD = "Deutscher Wetterdienst (DWD) ICON, CC BY 4.0; regridded."

MODELS: dict[str, Model] = {
    m.id: m
    for m in [
        Gfs(
            id="gfs",
            name="GFS",
            provider="NOAA",
            attribution=NOAA,
            licence="public-domain",
            cycle_hours=6,
            lag_hours=5.5,
            derived={"precip_24h": "kg m-2"},
            variables={
                "wind_u": Var("UGRD:10 m above ground:fcst", "m s-1"),
                "wind_v": Var("VGRD:10 m above ground:fcst", "m s-1"),
                "gust": Var("GUST:surface:fcst", "m s-1"),
                "mslp": Var("PRMSL:mean sea level:fcst", "Pa"),
                "precip_rate": Var("PRATE:surface:fcst", "kg m-2 s-1"),
                "temp_2m": Var("TMP:2 m above ground:fcst", "K"),
                "cloud": Var("TCDC:entire atmosphere:fcst", "1", percent),
                "cape": Var("CAPE:surface:fcst", "J kg-1"),
                "visibility": Var("VIS:surface:fcst", "m"),
                "wind250_u": Var("UGRD:250 mb:fcst", "m s-1"),
                "wind250_v": Var("VGRD:250 mb:fcst", "m s-1"),
            },
        ),
        GfsWave(
            id="gfs-wave",
            name="GFS-Wave",
            provider="NOAA",
            attribution=NOAA,
            licence="public-domain",
            cycle_hours=6,
            lag_hours=5.5,
            variables={
                "wave_height": Var("HTSGW:surface:fcst", "m"),
                "wave_period": Var("PERPW:surface:fcst", "s"),
                "wave_dir": Var("DIRPW:surface:fcst", "degree_from"),
                "windwave_height": Var("WVHGT:surface:fcst", "m"),
                "windwave_period": Var("WVPER:surface:fcst", "s"),
                "windwave_dir": Var("WVDIR:surface:fcst", "degree_from"),
                **{
                    f"swell{n}_{k}": Var(f"{code}:{n} in sequence:fcst", unit)
                    for n in (1, 2, 3)
                    for k, code, unit in (
                        ("height", "SWELL", "m"),
                        ("period", "SWPER", "s"),
                        ("dir", "SWDIR", "degree_from"),
                    )
                },
            },
        ),
        Ecmwf(
            id="ecmwf",
            name="ECMWF IFS",
            provider="ECMWF",
            attribution=ECMWF,
            licence="CC-BY-4.0",
            cycle_hours=6,
            lag_hours=8,
            derived={"precip_24h": "kg m-2"},
            variables={
                "wind_u": Var("10u", "m s-1"),
                "wind_v": Var("10v", "m s-1"),
                "gust": Var(
                    "10fg|10fg3", "m s-1", from_step=1
                ),  # max gust over the step; name varies by step
                "mslp": Var("msl", "Pa"),
                "precip_rate": Var("tprate", "kg m-2 s-1"),
                "temp_2m": Var("2t", "K"),
                "cloud": Var("tcc", "1"),
                "current_u": Var("sve", "m s-1"),
                "current_v": Var("svn", "m s-1"),
                "cape": Var("mucape", "J kg-1"),
                "wind250_u": Var("u@250", "m s-1"),
                "wind250_v": Var("v@250", "m s-1"),
            },
        ),
        Icon(
            id="icon",
            name="DWD ICON",
            provider="DWD",
            attribution=DWD,
            licence="CC-BY-4.0",
            cycle_hours=12,
            lag_hours=4,
            derived={"precip_rate": "kg m-2 s-1", "precip_24h": "kg m-2"},
            variables={
                "wind_u": Var("u_10m", "m s-1"),
                "wind_v": Var("v_10m", "m s-1"),
                "gust": Var("vmax_10m", "m s-1", from_step=1),  # max over the previous hour
                "mslp": Var("pmsl", "Pa"),
                "temp_2m": Var("t_2m", "K"),
                "cloud": Var("clct", "1", percent),
                "cape": Var("cape_ml", "J kg-1"),
                "precip_total": Var("tot_prec", "kg m-2"),  # accumulated since the run started
            },
        ),
        Gwam(
            id="icon-wave",
            name="DWD GWAM",
            provider="DWD",
            attribution=DWD,
            licence="CC-BY-4.0",
            cycle_hours=12,
            lag_hours=4,
            variables={
                "wave_height": Var("swh", "m"),
                "wave_dir": Var("mwd", "degree_from"),
                "wave_period": Var("tm10", "s"),
                "swell1_height": Var("shts", "m"),  # total swell (GWAM gives one combined swell)
                "swell1_dir": Var("mdts", "degree_from"),
            },
        ),
        EcmwfWave(
            id="ecmwf-wave",
            name="ECMWF WAM",
            provider="ECMWF",
            attribution=ECMWF,
            licence="CC-BY-4.0",
            cycle_hours=6,
            lag_hours=8,
            variables={
                "wave_height": Var("swh", "m"),
                "wave_period": Var("mwp", "s"),
                "wave_peak_period": Var("pp1d", "s"),
                "wave_dir": Var("mwd", "degree_from"),
            },
        ),
    ]
}
