# Security

OpenWind is a read-only map of public data: it has no accounts, no user data, no secrets and no write
endpoints. The controls below keep it that way and keep one visitor from tying up the server. They follow
the OWASP Top 10 (2021), the OWASP API Security Top 10 (2023), the CIS Docker benchmark and the OWASP Secure
Headers project.

## Reporting a problem

Please report security problems privately to the repository's owner (on GitHub, use "Report a
vulnerability" under the Security tab) rather than in a public issue. If you run a public copy, publish your
own contact in `web/public/.well-known/security.txt`.

## Web server (Caddy, `infra/Caddyfile`)

- Content Security Policy: this site only, plus the NASA GIBS satellite tiles; no inline scripts.
  X-Frame-Options DENY and `frame-ancestors 'none'`, nosniff, Referrer-Policy, Permissions-Policy, COOP,
  no Server header.
- Request bodies are capped at 16 KB (nothing legitimate sends one).
- Only `/v1/*` and `/healthz` reach the API; run files and tiles are static, from read-only mounts.
- HTTPS is the deployer's choice (docs/operations.md); add HSTS once it is on.

## API (`openwind/api.py`)

- Only GET endpoints: the model list, point forecasts, map frames and health. No public docs or OpenAPI
  schema, no CORS (same origin only), no keys or credentials to steal.
- Point forecasts: at most 60 a minute per address, and every point request shares a CPU budget (6 at once;
  others wait up to 20 seconds, then get a 503).
- Input bounds: coordinates range-checked and finite, query strings length-capped, model ids from a fixed
  list, frame boxes on a 10-degree grid with a fixed set of strides. File paths are built only from a known
  model id, an all-digit run id and a variable name the run's manifest lists, so a request can't reach any
  other file.
- Validation errors never echo submitted values. Health lists model names only, not error text.
- No access log; the client address is used only in memory for the rate limit.

## Ingest (`openwind/ingest.py`)

- Fetches only from the fixed provider URLs in `openwind/sources.py`; nothing a visitor sends is fetched.
- Every decoded field is checked against physical bounds and for completeness before a run is published; a
  run that fails keeps the previous one live.
- Run folders are written under a temporary name and swapped in whole.

## Containers (`compose.yaml`)

- Images pinned by tag and digest; non-root users; read-only root filesystems; all capabilities dropped (Caddy
  keeps NET_BIND_SERVICE in its bounding set only so its setcap binary can exec); no-new-privileges; memory
  and process limits; rotated logs.
- The API port is never published: only the web server can reach it, so its `X-Forwarded-For` is trusted.
- The web server is published on 127.0.0.1 by default; exposing it is a deliberate choice.

## Supply chain

- `uv.lock` and `web/package-lock.json` pin every dependency. Check them with `uvx pip-audit` (after
  `uv export --no-dev > requirements.txt`) and `npm audit` (in `web/`).

## Known and accepted

- Image scan (trivy): ECMWF's eckitlib wheel bundles AlmaLinux 8 builds of pcre2 10.32 and openldap 2.4.46
  with four critical CVEs. Debian's own packages are current; OpenWind makes no LDAP queries and decodes GRIB
  only from NOAA, ECMWF and DWD. Accepted in `.trivyignore.yaml` until 2027-01-17, or until eckitlib is rebuilt.
- Per-address limits treat everyone behind one shared address (mobile carriers, a reverse proxy without
  `trusted_proxies`) as one caller.
- Rate counters live in memory in the single API process and reset on restart.
- Model downloads are over HTTPS from the providers' public mirrors; their integrity rests on TLS (the
  providers publish no signatures).
