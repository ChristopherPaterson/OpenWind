# Operations

## Running

From the repository root on the server:

```sh
(cd web && npm ci && npm run build)   # the web app, into web/dist
infra/basemap/refresh.sh               # basemap tiles (first time, then monthly if you like)
docker compose up -d --build           # ingest, API and web server
```

The web server listens on `127.0.0.1:8080`: only the server itself can reach it until you choose how to
publish it (below). The first model runs arrive within about half an hour.

## Serving it to others, with HTTPS

Pick one:

- **Your own reverse proxy** (nginx, Traefik, a tunnel, a load balancer) terminating HTTPS and forwarding to
  `127.0.0.1:8080`. Nothing in OpenWind changes. If the proxy is on another machine, publish the port on
  the right interface in `compose.yaml` (`ports: ["<address>:8080:8080"]`). The per-address limit on point
  forecasts then sees the proxy's address for everyone, unless you tell Caddy to trust the proxy's
  `X-Forwarded-For` (Caddy's `trusted_proxies` global option).
- **Caddy itself.** Replace `:8080` at the top of `infra/Caddyfile` with your domain name (for example
  `weather.example.org`), publish ports 80 and 443 (`ports: ["80:80", "443:443"]`), add
  `sysctls: {net.ipv4.ip_unprivileged_port_start: 80}` to the `web` service, and give its `/data` a volume
  instead of the tmpfs so certificates survive restarts. Caddy gets and renews the certificate itself. Then
  add `Strict-Transport-Security "max-age=31536000"` to the header block.

## Updating

```sh
git pull
(cd web && npm ci && npm run build)
docker compose up -d --build
```

Pages are served `no-cache`, so browsers pick up a new version on their next visit. Run folders are
rebuilt by the ingest, so no data migration is ever needed.

## Configuration

There are no secrets and nothing is required. Things you may want to change:

| What | Where |
|---|---|
| Models fetched, their variables | `openwind/sources.py` (`MODELS`) |
| Runs kept per model (default 2) | `openwind/config.py` (`KEEP_RUNS`) |
| How often the ingest checks (default 10 minutes) | `openwind/ingest.py` (`main`) |
| Point forecast limit per address (default 60 a minute) | `openwind/api.py` (`POINT_PER_MIN`) |
| Data directory inside the containers | `OPENWIND_DATA_DIR` (set to `/data` by the image) |
| Memory and process limits | `compose.yaml` |
| Default map view | `web/src/WeatherMap.tsx` (`center`, `zoom`); a shared link carries its own |

## Monitoring

- `GET /v1/health` reports `ok` or `degraded` with the reasons: a model late or failing its checks, or the
  ingest loop stopped. It lists model names only; the error details are in the ingest log.
- Logs: `docker compose logs --tail 100 <service>`. The API keeps no access log.
- Disk: up to about 40 GB of model runs (two per model; ECMWF's is about 2 GB, a wave model's about 0.6 GB)
  plus about 10 GB of basemap tiles in some 2.5 million files.

## Scheduled jobs

| Job | When | How |
|---|---|---|
| Model ingest | Continuous (every 10 min) | `ingest` service |
| Basemap from fresh OpenStreetMap data | Monthly, if you like | cron: `0 3 1 * * cd /path/to/openwind && infra/basemap/refresh.sh` |

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| A model shows "next run late" | The provider is late, or the run failed its checks. `docker compose logs ingest`; the previous run stays live. |
| No land on the map | The basemap hasn't been built: run `infra/basemap/refresh.sh`. |
| The map loads but shows no weather | No runs yet (check `/v1/health`), or the web server can't read `data/runs` (it runs as uid 1000). |
| 429 "Too many requests" | One address asked for more than 60 point forecasts in a minute. Behind a proxy, see "Serving it to others". |
| 503 "server is busy" | Every compute slot is in use; requests wait up to 20 seconds first. |
| The ingest is killed | Out of memory: a global run needs about 4 GB while it is assembled. Raise `mem_limit` in `compose.yaml`. |
