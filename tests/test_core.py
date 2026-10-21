import numpy as np

from openwind.grib import LATS, LONS, crop_indices
from openwind.sources import parse_wgrib2_idx
from openwind.store import corners, interpolate, interpolate_direction, wind_from

IDX = """1:0:d=2026101518:PRMSL:mean sea level:6 hour fcst:
2:100:d=2026101518:PRATE:surface:6 hour fcst:
3:250:d=2026101518:PRATE:surface:0-6 hour ave fcst:
4:400:d=2026101518:UGRD:10 m above ground:6 hour fcst:"""


def test_idx_lengths_and_average_kept_apart():
    got = parse_wgrib2_idx(IDX, {"PRATE:surface:fcst", "UGRD:10 m above ground:fcst"})
    assert got == {"PRATE:surface:fcst": (100, 150), "UGRD:10 m above ground:fcst": (400, None)}


def test_crop_gfs_and_ecmwf_grids_hit_same_points():
    # GFS: lon 0..359.75; ECMWF: lon -180..179.75; both north-first from 90. Served: -180..179.75.
    rows, cols = crop_indices(90, 0, 0.25, 1440, 721)
    assert rows[0] == 0 and rows[-1] == 720 and cols[0] == 720 and cols[-1] == 719  # 180W, 179.75E
    rows_e, cols_e = crop_indices(90, -180, 0.25, 1440, 721)
    assert (rows_e == rows).all() and cols_e[0] == 0 and cols_e[-1] == 1439
    assert len(LATS) == 721 and len(LONS) == 1440


def test_bilinear_and_land_gaps():
    grid = {"north": 0.0, "west": 90.0, "step": 0.25, "ny": 241, "nx": 361}
    arr = np.zeros((1, 241, 361), np.float32)
    arr[0, 4, 4], arr[0, 4, 5] = 10, 20
    cells = corners(grid, -1.0, 91.125)  # halfway between columns 4 and 5 on row 4
    assert abs(interpolate(arr, cells)[0] - 15) < 1e-5
    arr[0, 4, 5] = np.nan  # land: drop it, keep the sea value
    assert abs(interpolate(arr, cells)[0] - 10) < 1e-5
    assert corners(grid, 5, 100) is None


def test_direction_average_across_north():
    grid = {"north": 0.0, "west": 90.0, "step": 0.25, "ny": 241, "nx": 361}
    arr = np.zeros((1, 241, 361), np.float32)
    arr[0, 4, 4], arr[0, 4, 5] = 350, 10
    d = interpolate_direction(arr, corners(grid, -1.0, 91.125))[0]
    assert min(d, 360 - d) < 1e-3


def test_wind_from_convention():
    speed, frm = wind_from(np.array([0.0, -5.0]), np.array([-5.0, 0.0]))
    assert list(np.round(frm)) == [0, 90]  # blowing south = from north; blowing west = from east
    assert list(speed) == [5, 5]


def test_quantise_round_trip_and_gaps():
    from openwind.store import quantise

    x = np.array([[0.0, 5.0], [10.0, np.nan]], np.float32)
    b = quantise(x)
    lo, hi = np.frombuffer(b[:8], "<f4")
    assert tuple(np.frombuffer(b[8:16], "<u4")) == (2, 2)
    q = np.frombuffer(b[16:], np.uint8)
    assert (lo, hi) == (0, 10) and q[3] == 255
    assert np.allclose(lo + q[:3] / 254 * (hi - lo), [0, 5, 10], atol=0.03)


def test_global_wrap_and_subsets_across_the_antimeridian():
    from openwind.store import corners, subset

    g = {"north": 90.0, "south": -90.0, "west": -180.0, "east": 179.75, "step": 0.25, "ny": 721, "nx": 1440}
    cells = corners(g, -18.0, 179.875)  # between 179.75E (col 1439) and 180 (col 0)
    assert {c[0][1] for c in cells} == {1439, 0}
    vals = np.arange(721 * 1440, dtype=np.float32).reshape(721, 1440)
    box = subset(g, vals, 170, -20, 190, -10, 4)  # Fiji, crossing 180
    assert box.shape == (11, 21)
    assert box[0, 0] == vals[400, 1400] and box[0, -1] == vals[400, 40]  # 170E and 170W
    regional = {"north": 0.0, "west": 90.0, "step": 0.25, "ny": 241, "nx": 361}
    assert np.isnan(subset(regional, vals[:241, :361], 0, -10, 10, 0, 4)).all()  # outside: no data


def test_ecmwf_index_reads_surface_and_pressure_levels():
    import json

    from openwind.sources import MODELS

    lines = [
        {"param": "10u", "levtype": "sfc", "_offset": 0, "_length": 10},
        {"param": "u", "levtype": "pl", "levelist": "250", "_offset": 10, "_length": 5},
        {"param": "u", "levtype": "pl", "levelist": "500", "_offset": 15, "_length": 5},
    ]
    got = MODELS["ecmwf"].parse_index("\n".join(json.dumps(x) for x in lines))
    assert got["10u"] == (0, 10) and got["u@250"] == (10, 5) and "u@500" not in got


def test_derive_rain_rate_and_next_24h():
    from openwind.ingest import derive
    from openwind.sources import MODELS

    steps = [0, 12, 24, 36]
    shape = (4, 1, 1)
    tot = np.array([0, 6, 12, 30], np.float32).reshape(shape)  # mm since the run started
    arrays = {
        "precip_total": tot,
        "precip_rate": np.full(shape, np.nan, np.float32),
        "precip_24h": np.full(shape, np.nan, np.float32),
    }
    derive(MODELS["icon"], arrays, steps)
    assert np.allclose(arrays["precip_rate"][1, 0, 0] * 3600, 0.5)  # 6 mm over 12 h
    acc = arrays["precip_24h"][:, 0, 0]
    assert np.allclose(acc[:2], [12, 24]) and np.isnan(acc[2])  # no 24 h left after step 24
    rate = np.full(shape, 1 / 3600, np.float32)  # 1 mm/h steady
    a2 = {"precip_rate": rate, "precip_24h": np.full(shape, np.nan, np.float32)}
    derive(MODELS["gfs"], a2, steps)
    assert np.allclose(a2["precip_24h"][0, 0, 0], 24, atol=0.01)


def test_point_with_only_one_wind_component(tmp_path, monkeypatch):
    import json

    from openwind import config, store

    run = tmp_path / "runs" / "gfs" / "2026101600"
    run.mkdir(parents=True)
    grid = {"north": 0.0, "south": -1.0, "west": 150.0, "east": 151.0, "step": 0.25, "ny": 5, "nx": 5}
    (run / "manifest.json").write_text(
        json.dumps(
            {
                "name": "GFS",
                "run": "2026-10-16T00:00:00+00:00",
                "attribution": "",
                "licence": "",
                "valid_times": [0],
                "grid": grid,
                "variables": {"wind_u": {"unit": "m s-1"}, "wind_v": {"unit": "m s-1"}},
            }
        )
    )
    for v in ("wind_u", "wind_v"):
        np.save(run / f"{v}.npy", np.ones((1, 5, 5), np.float32))
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    p = store.point("gfs", -0.5, 150.5, {"wind_u"})
    assert p["series"]["wind_u"] == [1.0] and "wind_speed" not in p["series"]


def test_publish_swaps_a_run_without_a_gap(tmp_path):
    from openwind import store

    final = tmp_path / "2026101600"
    for version in ("one", "two"):
        tmp = tmp_path / f".tmp-{version}"
        tmp.mkdir()
        (tmp / "manifest.json").write_text(version)
        store.publish(tmp, final)
    assert (final / "manifest.json").read_text() == "two"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["2026101600"]  # nothing left aside
    assert store.load_run(tmp_path / "gone") is None  # a pruned run reads as missing, not an error


def test_ingest_moves_a_model_that_died_mid_run_to_the_end(tmp_path, monkeypatch):
    from openwind import health, ingest

    monkeypatch.setattr(health, "path", lambda: tmp_path / "health.json")
    seen = []
    health.write({**health.read(), "attempting": "gfs"})  # what a killed process leaves (no finally runs)
    monkeypatch.setattr(ingest, "_pass", lambda order, *a: seen.append(list(order)))
    ingest.pass_once(["gfs", "ecmwf", "icon"])
    assert seen[-1] == ["ecmwf", "icon", "gfs"]
    h = health.read()
    assert "attempting" not in h and h["models"]["gfs"]["failures"] == 1


def _api(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from openwind import api, config

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    api._recent.clear()
    return TestClient(api.app)


def test_point_requests_are_limited_per_address(tmp_path, monkeypatch):
    from openwind import api

    c = _api(tmp_path, monkeypatch)
    monkeypatch.setattr(api, "POINT_PER_MIN", 3)
    codes = [c.get("/v1/point?lat=-33.8&lon=151.2").status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    assert c.get("/v1/models").status_code == 200  # only point forecasts are limited


def test_api_rejects_bad_input_and_has_no_public_docs(tmp_path, monkeypatch):
    c = _api(tmp_path, monkeypatch)
    assert c.get("/v1/point?lat=-33.8&lon=151.2&models=nope").status_code == 400
    assert c.get("/v1/point?lat=95&lon=151").status_code == 422
    assert c.get("/v1/point?lat=nan&lon=151").status_code == 422
    assert c.get("/v1/frame/gfs/2026101600/wind_u/0?s=3").status_code == 400
    assert c.get("/v1/frame/gfs/2026101600/wind_u/0?b=1,2,3,4").status_code == 400
    assert c.get("/v1/frame/gfs/..%2f..%2fetc/wind_u/0").status_code == 404
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert c.get(path).status_code == 404


def test_health_reports_a_stopped_ingest(tmp_path, monkeypatch):
    c = _api(tmp_path, monkeypatch)
    h = c.get("/v1/health").json()
    assert h["status"] == "degraded" and "ingest" in h["problems"]
