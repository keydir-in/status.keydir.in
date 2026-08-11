# KEYDIR System Status

Static status page for KEYDIR, hosted on GitHub Pages at **status.keydir.in**.

HTML + CSS + vanilla JavaScript only. No backend, no build step, no dependencies.
All status and uptime data is fetched live from the Cloudflare Worker API:

```
https://keydir-status-api.keydir.in/status
```

The Worker holds the UptimeRobot API key (never exposed to the browser), fetches
real monitor data, and returns clean JSON. The page polls that endpoint every 30
seconds and re-renders in place.

## Run locally

Any static file server works. From this directory:

```bash
python3 -m http.server 8080
# or
npx serve .
```

Then open http://localhost:8080.

> Opening `index.html` directly via `file://` is not supported — `fetch()` to
> the API is blocked from `file://` origins. Use a local server (or the GitHub
> Pages deployment). If the API is unreachable, the page shows a graceful
> "Unable to retrieve live status" state instead of breaking.

## Deploy to GitHub Pages

1. Push this folder to its own repository (e.g. `keydir-in/status.keydir.in`).
2. In **Settings → Pages**, under **Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: `main` / `master`, folder: `/ (root)`
3. Set the custom domain `status.keydir.in` in **Settings → Pages → Custom domain**
   (and add the matching CNAME record at your DNS provider, pointing
   `status.keydir.in` to `<user>.github.io`).

A recommended alternative for this subdomain setup is a
[separate GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages#types-of-github-pages-sites)
which is exactly what this repo is. This is also why the theme
(`styles.css`, `assets/js/theme.js`) is copied into this repo instead of
referenced from the keydir.in repo — the status site deploys standalone.

## How the page works

- `index.html` — page skeleton and sections (overall, services, uptime, incidents, maintenance).
- `assets/styles.css` — KEYDIR NeoBrutalist design system: light/dark themes, Space Grotesk +
  JetBrains Mono fonts, hard borders and offset shadows (tokens match `keydir.in/assets/css/style.css`).
- `assets/js/theme.js` — light/dark theme manager (same as keydir.in). Toggle via the button in the header; respects the system preference by default.
- `assets/js/app.js` — fetches the status API and renders everything:
  - `loadStatus()` — `fetch()`es the Worker endpoint, then dispatches to the render functions. Runs on load and every 30 s (retries after 5 s on failure).
  - `renderOverallStatus()` — big status card (`data.overall.status` + `data.overall.message`).
  - `renderServices()` — one row per service returned by the API (name, status, indicator, URL).
  - `renderUptime()` — per-service panel with a 180-degree uptime gauge reading `service.uptime`;
    the 24h / 7d / 30d / 90d tabs swap the needle/readout client-side from the values already in the
    DOM (no refetch). Unknown values render as `—`.
  - `renderIncidents()` — incident history from `incidents[]`, newest first ("✓ NO INCIDENTS REPORTED."
    if the API sends none; ongoing outages show a live duration computed client-side).
  - `renderMaintenance()` — scheduled maintenance list (renders "No scheduled maintenance." if empty).
  - `renderUnavailable()` — full error state, only when there is no previously valid data.
  - Append `?debug` to the URL to log the full API response to the console.
- `worker/keydir-status-api.js` — Cloudflare Worker source (deploy to `keydir-status-api.keydir.in`).
  Caches the UptimeRobot response for 60 s via the Cache API so the browser's 30 s polling never
  hammers UptimeRobot; serves the last good cached data if UptimeRobot returns 429/5xx, else a
  503 `unknown` state (never a fake `operational`). CORS is an allowlist: `https://status.keydir.in`
  plus the dev origins `http://127.0.0.1:5500` and `http://localhost:5500`; any other origin gets
  no CORS headers, never `*`. OPTIONS preflight returns 204 with the same headers. The UptimeRobot key
  lives in the Worker secret `UPTIMEROBOT_API_KEY` and is never exposed.
- `worker/check.mjs` — smoke test for the live API (`node worker/check.mjs`). Fetches
  `https://keydir-status-api.keydir.in/status`, asserts the CORS allowlist (echoed ACAO for
  dev/prod origins, none for others), checks OPTIONS preflight, and validates the response shape
  including the documented 503 `unknown` fallback. Requires the allowlist Worker to be deployed.

There is **no `data/status.json`** — the API is the only data source, so no mock
or hard-coded uptime values exist anywhere in this repo.

## API response structure

The Worker returns JSON in this shape (mirrors the UptimeRobot monitors it wraps):

```json
{
  "overall": {
    "status": "operational",
    "message": "All KEYDIR services are operating normally."
  },
  "lastUpdated": "2026-08-11T03:55:24.821Z",
  "services": [
    {
      "id": "803634381",
      "name": "app.keydir.in",
      "url": "https://app.keydir.in",
      "status": "operational",
      "uptime": { "24h": 100, "7d": 100, "30d": 100, "90d": 100 },
      "history": { "24h": [...24 values...], "7d": [...7 values...], "30d": [...30 values...], "90d": [...90 values...] }
    }
  ],
  "incidents": [
    {
      "id": "803634381-1754890000",
      "serviceId": "803634381",
      "serviceName": "app.keydir.in",
      "url": "https://app.keydir.in",
      "type": "outage",
      "status": "resolved",
      "startedAt": "2026-08-11T12:24:10.000Z",
      "endedAt": "2026-08-11T12:24:38.000Z",
      "duration": 28
    }
  ]
}
```

### Field reference

| Field | Notes |
| --- | --- |
| `overall.status` | `operational`, `degraded`, `outage`, `paused`, `unknown` |
| `overall.message` | Shown under the overall status title |
| `services[].name` | Display name of the monitor (from UptimeRobot) |
| `services[].url` | Target URL, shown as the service subtitle |
| `services[].status` | Same status set as `overall.status` |
| `services[].uptime` | Real UptimeRobot percentages per period: `24h`, `7d`, `30d`, `90d` |
| `services[].history` | Conservative per-interval timeline per period, oldest first, **always exactly** 24 / 7 / 30 / 90 entries. `24h` is hourly (24 intervals), `7d`/`30d`/`90d` daily. Each element is `"down"` / `"paused"` when a real UptimeRobot log overlaps it, `"up"` only when an up-log provably covers the whole interval, or `null` when there is no positive monitoring proof (rendered as a muted gray block — never as a fake green/red). Built from UptimeRobot state-transition logs, never from the aggregate percentage, and deliberately more conservative than UptimeRobot's own timeline — absence of a DOWN event is not treated as UP. |
| `incidents[]` | Outage history built from the same UptimeRobot logs: a DOWN (type 1) + matching UP (type 2) becomes one resolved incident (`duration` = UP − DOWN); a DOWN with no UP is an `ongoing` incident with `endedAt: null` (no invented end time). Newest first, capped at 20. PAUSED logs are not incidents. The frontend renders this section from this field only — never derived from `history[]` or uptime percentages. |
| `maintenance[]` | Optional — rendered by the page if present |

### Status → UI mapping

| API status | Shown as |
| --- | --- |
| `operational` | All Systems Operational (green) |
| `degraded` | Degraded Performance (yellow) |
| `outage` | Major Outage (red) |
| `paused` | Paused (gray) |
| `maintenance` | Maintenance (yellow) |
| `unknown` / anything else | Unable to determine status (neutral) |

> **History coverage:** UptimeRobot logs are state-transition events (not every
> check), and the free tier only exposes the last ~24 hours (max 50 events per
> monitor). Buckets are only marked where a log provably covers them, so on the
> free plan `7d` / `30d` / `90d` are mostly unproven and render as muted gray
> blocks — never fabricated green. The array length is always exact regardless;
> only the states are conservative. The aggregate percentages remain real.
> Granular history beyond 24 h requires an UptimeRobot Pro plan
> (via `logs_start_date` / `logs_end_date`).

## Adding a service

Add a new monitor in UptimeRobot. The Worker forwards it, the API returns it in
`services[]`, and the page renders it automatically. No changes to this repo are
needed — the API is the source of truth and service names are never hard-coded.

## UptimeRobot key security

The UptimeRobot API key lives **only** inside the Cloudflare Worker. It never
appears in this repository or in any request the browser makes. The frontend
only ever talks to `https://keydir-status-api.keydir.in/status`.
