// Cloudflare Worker for https://keydir-status-api.keydir.in
//
// Frontend: https://status.keydir.in  (polls /status every 30s)
// Upstream: UptimeRobot v2 getMonitors
// Secret:   UPTIMEROBOT_API_KEY  (never exposed)
//
// The Worker caches the UptimeRobot response for 60s via the Cache API, so the
// frontend's 30s polling never hits UptimeRobot more than once a minute.

const UPTIMEROBOT_API = "https://api.uptimerobot.com/v2/getMonitors";
// Development origins for local testing (live server on port 5500). Production
// stays locked to status.keydir.in. Never "*".
const ALLOWED_ORIGINS = new Set([
  "https://status.keydir.in",
  "http://127.0.0.1:5500",
  "http://localhost:5500"
]);
const CACHE_TTL = 60;
const CACHE_KEY = "https://keydir-status-api.keydir.in/status";

const STATUS_MAP = {
  0: "paused",
  1: "unknown",
  2: "operational",
  8: "degraded",
  9: "outage"
};

// UptimeRobot custom_uptime_ratio is a dash-delimited string, e.g.
// "100.000-99.850-99.920-99.780", positionally ordered to match the request
// (custom_uptime_ratios=1-7-30-90). Split it positionally — never index the
// string like an object (JS string ["7"] is a character, not a field).
const RATIO_ORDER = ["24h", "7d", "30d", "90d"];

// Timeline buckets: 24h is hourly, the rest are daily. Each bucket is filled
// from real UptimeRobot logs (see buildHistory), never derived from the
// aggregate uptime percentage.
const SEGMENTS = { "24h": 24, "7d": 7, "30d": 30, "90d": 90 };
const HOUR = 3600;
const DAY = 86400;

const MESSAGES = {
  outage: "One or more KEYDIR services are currently experiencing an outage.",
  degraded: "One or more KEYDIR services are experiencing degraded performance.",
  operational: "All KEYDIR services are operating normally.",
  unknown: "Live monitoring data is temporarily unavailable.",
  partial: "Some services are paused or reporting unknown status."
};

const FALLBACK = {
  overall: { status: "unknown", message: MESSAGES.unknown },
  lastUpdated: null,
  services: [],
  incidents: []
};

// Build per-interval states conservatively from UptimeRobot logs.
//
// Logs are state-transition events: type 1 = down, 2 = up, 90 = paused, each
// covering [datetime, datetime + duration]. A bucket is only ever marked:
//   "down"   when a down log overlaps it (real proof),
//   "paused" when a paused log overlaps it (real proof),
//   "up"     only when an up log provably covers the entire bucket.
// Anything without positive proof is null ("history unavailable").
// Absence of a DOWN event is NOT treated as UP — this is deliberately more
// conservative than UptimeRobot's own timeline.
// ponytail: free tier only returns ~24h of logs (max 50), so 7d/30d/90d are
// usually null. That is honest — the API exposes no older per-check data
// without a Pro plan.
function bucketState(events, start, end) {
  let paused = false;
  let up = false;
  for (const e of events) {
    if (e.start < end && e.end > start) {
      if (e.type === 1) return "down";
      if (e.type === 90) paused = true;
      if (e.type === 2 && e.start <= start && e.end >= end) up = true;
    }
  }
  return up ? "up" : paused ? "paused" : null;
}

function buildHistory(logs, now) {
  const events = (logs || []).map((l) => ({
    type: Number(l.type),
    start: Number(l.datetime),
    end: Number(l.datetime) + Number(l.duration || 0)
  }));
  const history = {};
  for (const [range, n] of Object.entries(SEGMENTS)) {
    const step = range === "24h" ? HOUR : DAY;
    const arr = [];
    for (let i = n - 1; i >= 0; i--) {
      const end = now - i * step;
      arr.push(bucketState(events, end - step, end));
    }
    history[range] = arr;
  }
  return history;
}

// Build incident objects from UptimeRobot state-transition logs. A DOWN (type
// 1) followed by an UP (type 2) is ONE resolved incident spanning
// [down, up). A DOWN with no following UP is an ongoing incident — no end
// time is invented. PAUSED (90) logs are not incidents.
function buildIncidents(logs, service) {
  const events = (logs || [])
    .map((l) => ({ type: Number(l.type), time: Number(l.datetime) }))
    .filter((e) => e.type === 1 || e.type === 2)
    .sort((a, b) => a.time - b.time);
  const incidents = [];
  let open = null;
  for (const e of events) {
    if (e.type === 1) {
      if (!open) open = { start: e.time };
    } else if (open) {
      incidents.push({
        id: `${service.id}-${open.start}`,
        serviceId: service.id,
        serviceName: service.name,
        url: service.url,
        type: "outage",
        status: "resolved",
        startedAt: new Date(open.start * 1000).toISOString(),
        endedAt: new Date(e.time * 1000).toISOString(),
        duration: Math.max(0, e.time - open.start)
      });
      open = null;
    }
  }
  if (open) {
    incidents.push({
      id: `${service.id}-${open.start}`,
      serviceId: service.id,
      serviceName: service.name,
      url: service.url,
      type: "outage",
      status: "ongoing",
      startedAt: new Date(open.start * 1000).toISOString(),
      endedAt: null,
      duration: null
    });
  }
  return incidents;
}

function mapService(m, now) {
  const ratios = typeof m.custom_uptime_ratio === "string" ? m.custom_uptime_ratio.split("-") : [];
  const uptime = {};
  RATIO_ORDER.forEach((k, i) => {
    const raw = ratios[i];
    const n = raw !== undefined && raw !== "" ? Number(raw) : null;
    uptime[k] = n != null && Number.isFinite(n) ? n : null;
  });
  return {
    id: String(m.id),
    name: m.friendly_name,
    url: m.url,
    status: STATUS_MAP[m.status] || "unknown",
    uptime,
    history: buildHistory(m.logs, now)
  };
}

// Priority: outage > degraded > paused/unknown > operational. Anything that is
// not a clean "all operational" with real data resolves to unknown rather than
// a fake operational state.
function summarize(services) {
  if (!services.length) return { status: "unknown", message: MESSAGES.unknown };
  const statuses = services.map((s) => s.status);
  if (statuses.includes("outage")) return { status: "outage", message: MESSAGES.outage };
  if (statuses.includes("degraded")) return { status: "degraded", message: MESSAGES.degraded };
  if (statuses.every((s) => s === "operational")) return { status: "operational", message: MESSAGES.operational };
  return { status: "unknown", message: MESSAGES.partial };
}

async function fetchUptimeRobot(env) {
  if (!env.UPTIMEROBOT_API_KEY) throw new Error("UPTIMEROBOT_API_KEY secret is not set");
  const res = await fetch(UPTIMEROBOT_API, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `api_key=${encodeURIComponent(env.UPTIMEROBOT_API_KEY)}&format=json&custom_uptime_ratios=1-7-30-90&logs=1&logs_limit=50`,
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    console.error("UptimeRobot fetch HTTP", res.status);
    throw new Error("UptimeRobot HTTP " + res.status);
  }
  const raw = await res.json();
  if (raw.stat !== "ok") throw new Error("UptimeRobot stat: " + raw.stat + (raw.error ? ": " + raw.error : ""));
  const now = Date.now() / 1000;
  const services = (raw.monitors || []).map((m) => mapService(m, now));
  const incidents = (raw.monitors || [])
    .flatMap((m) => buildIncidents(m.logs, { id: String(m.id), name: m.friendly_name, url: m.url }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 20);
  return {
    overall: summarize(services),
    lastUpdated: new Date().toISOString(),
    services,
    incidents
  };
}

function corsHeaders(request, extra = {}) {
  const origin = request && request.headers.get("Origin");
  const headers = {
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    ...extra
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}

function json(data, status, request, extra) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(request, { "content-type": "application/json", ...extra }) });
}

// Browser-facing headers: no-store so the browser never caches stale data.
// The Worker cache holds its own 60s copy separately, stored WITHOUT CORS
// headers; the requesting origin's ACAO is applied here at serve time so the
// cached copy is never origin-specific.
function toBrowser(res, request) {
  const headers = new Headers(res.headers);
  headers.delete("access-control-allow-origin");
  for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v);
  headers.set("cache-control", "no-store");
  headers.set("vary", "Origin");
  return new Response(res.body, { status: res.status, headers });
}

async function handleStatus(request, env, ctx) {
  const cache = caches.default;
  const cached = await cache.match(CACHE_KEY);
  if (cached) return toBrowser(cached, request);

  try {
    const storeable = json(await fetchUptimeRobot(env), 200, null, { "cache-control": `public, max-age=${CACHE_TTL}` });
    ctx.waitUntil(cache.put(CACHE_KEY, storeable.clone()));
    return toBrowser(storeable, request);
  } catch (err) {
    // UptimeRobot 429/5xx (or any upstream failure): never throw, never fake
    // data. Serve the last good cached copy, else a 503 unknown state.
    console.error("UptimeRobot call failed:", err.message);
    const stale = await cache.match(CACHE_KEY);
    if (stale) return toBrowser(stale, request);
    return json(FALLBACK, 503, request, { "cache-control": "no-store" });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/status") {
      return json({ error: "Not found" }, 404, request, { "cache-control": "no-store" });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, { "access-control-max-age": "86400" }) });
    }
    if (request.method !== "GET") {
      return json({ error: "Not found" }, 404, request, { "cache-control": "no-store" });
    }
    return handleStatus(request, env, ctx);
  }
};

export { buildHistory, buildIncidents, summarize, mapService };
