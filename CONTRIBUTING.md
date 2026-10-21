# Contributing

## Setting up

```sh
uv sync                    # Python 3.13 and dependencies, including dev tools
cd web && npm ci           # Node 22
```

See the [README](README.md) for running the API and the map locally.

## Before every commit

Run `scripts/check.sh` (or `--fast` while iterating) and fix anything it reports. It runs Ruff, pytest, and
the web type check, lint, formatting check, unit tests, build and a browser smoke test. `uv run ruff format`
and `npm run format` (in `web/`) fix layout. The smoke test needs Playwright's browser once:
`cd web && npx playwright install chromium`.

## Code standards

- **Keep it small.** Prefer the standard library and what is already in the codebase over new
  dependencies. No abstractions for one use, no options nobody asked for.
- **Comments say why**, not what. Module docstrings explain a file's job, its sources and its limits.
- **Validate at the edges.** Anything from a request or a download is checked (types, ranges, finite
  numbers, sizes) before it is used.
- **Write files atomically:** to a temporary name, then rename (or `store.publish` for run folders), so
  readers never see half a file.
- **Units are SI** in data and the API; conversion happens only for display.
- **Tests.** Logic with branches or numbers gets a test in `tests/test_core.py` or `web/src/*.test.ts`. A
  bug fix comes with a test that would have caught it.
- **Frontend:** React function components and hooks; effects clean up their timers, listeners and requests
  (an `AbortController` for fetches that can be superseded); heavy per-frame work avoided.
- **Writing:** plain and direct.

## Data and licences

Adding or changing a data source means updating [docs/data-sources.md](docs/data-sources.md),
`web/public/credits.html` and, if the map shows it, the footer in `web/src/App.tsx`. Check the source's
licence allows display on a free public site first. OpenWind needs no accounts or keys; a source that does
belongs in a fork.

## Security

Never commit secrets. Read [SECURITY.md](SECURITY.md) before changing anything at a trust boundary (the API,
the Caddyfile, `compose.yaml`).

## Commits

One logical change per commit, with a message that says what changed and why. Record notable changes in
[CHANGELOG.md](CHANGELOG.md).
