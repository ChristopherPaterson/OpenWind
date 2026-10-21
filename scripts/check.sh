#!/bin/sh
# Every check before a commit or release. Run from anywhere.
#   scripts/check.sh          everything
#   scripts/check.sh --fast   skip the Python tests and the web build
set -eu
cd "$(dirname "$0")/.."
fast=$([ "${1:-}" = --fast ] && echo 1 || true)
echo "== python"
uv run ruff check . && uv run ruff format --check .
[ -n "$fast" ] || uv run pytest -q
echo "== web"
(cd web && npx tsc && npx eslint src && npx prettier --check src e2e && npm test --silent)
[ -n "$fast" ] || (cd web && npx vite build >/dev/null && npx playwright test --reporter=line)
echo "all checks passed"
