// One smoke check for the live status API. Run: node worker/check.mjs
// Passes on the documented degraded state too (HTTP 503 + fallback body), since
// that is the Worker's designed behavior when UptimeRobot is unreachable.
// Requires the CORS allowlist version of the Worker to be deployed.
const STATUS_API = "https://keydir-status-api.keydir.in/status";
const STATUSES = new Set(["operational", "degraded", "outage", "paused", "unknown"]);
const STATES = new Set(["up", "down", "paused", null]);
const RANGES = ["24h", "7d", "30d", "90d"];
const BUCKETS = { "24h": 24, "7d": 7, "30d": 30, "90d": 90 };
const DEV_ORIGINS = ["http://127.0.0.1:5500", "http://localhost:5500", "https://status.keydir.in"];

let pass = true;
const check = (name, ok) => { if (!ok) { pass = false; console.log("FAIL:", name); } };

// CORS: allowlisted dev + prod origins get their Origin echoed back; others get none.
for (const origin of DEV_ORIGINS) {
  const res = await fetch(STATUS_API, { cache: "no-store", headers: { Origin: origin } });
  check(`${origin} GET -> ACAO echoed`, res.headers.get("access-control-allow-origin") === origin);
}
const evil = await fetch(STATUS_API, { cache: "no-store", headers: { Origin: "https://evil.example" } });
check("disallowed origin -> no ACAO", evil.headers.get("access-control-allow-origin") === null);

// Preflight: OPTIONS returns 204 with the CORS headers for an allowed origin.
const pre = await fetch(STATUS_API, { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:5500", "Access-Control-Request-Method": "GET" } });
check("OPTIONS -> 204", pre.status === 204);
check("OPTIONS ACAO echoed", pre.headers.get("access-control-allow-origin") === "http://127.0.0.1:5500");
check("OPTIONS ACAM present", /GET/.test(pre.headers.get("access-control-allow-methods") || ""));
check("OPTIONS ACAH present", /Content-Type/.test(pre.headers.get("access-control-allow-headers") || ""));

// Response shape.
const res = await fetch(STATUS_API, { cache: "no-store", headers: { Origin: "http://127.0.0.1:5500" } });
console.log("GET " + STATUS_API + " -> HTTP " + res.status);
check("HTTP status is 200 or documented 503 fallback", res.status === 200 || res.status === 503);

const body = await res.json().catch(() => null);
check("body parses as JSON", body !== null);

if (res.status === 200 && body?.lastUpdated) {
  const ageMs = Date.now() - new Date(body.lastUpdated).getTime();
  check("lastUpdated is recent (< 5 min)", ageMs < 5 * 60 * 1000);
}

check("overall.status is known", STATUSES.has(body?.overall?.status));
check("overall.message is a string", typeof body?.overall?.message === "string");
check("lastUpdated is a string or null", body?.lastUpdated == null || typeof body.lastUpdated === "string");
check("services is an array", Array.isArray(body?.services));

const services = Array.isArray(body?.services) ? body.services : [];
for (const svc of services) {
  const id = svc.id ?? "?";
  check(`service ${id} has status`, STATUSES.has(svc.status));
  check(`service ${id} has url`, typeof svc.url === "string" && svc.url.length > 0);
  check(`service ${id} has uptime keys`, RANGES.every((r) => r in svc.uptime));
  check(`service ${id} uptime values are numbers or null`, RANGES.every((r) => svc.uptime[r] == null || typeof svc.uptime[r] === "number"));
  check(`service ${id} has history keys`, RANGES.every((r) => r in svc.history));
  for (const r of RANGES) {
    const h = svc.history[r];
    check(`service ${id} history.${r} has exactly ${BUCKETS[r]} entries`, Array.isArray(h) && h.length === BUCKETS[r]);
    if (Array.isArray(h)) check(`service ${id} history.${r} states are valid`, h.every((s) => STATES.has(s)));
  }
}

// incidents: top-level array, newest first, each incident is well-formed.
check("incidents is an array", Array.isArray(body?.incidents));
const incidents = Array.isArray(body?.incidents) ? body.incidents : [];
for (let i = 0; i < incidents.length; i++) {
  const inc = incidents[i];
  check(`incident ${i} has id`, typeof inc.id === "string" && inc.id.length > 0);
  check(`incident ${i} has serviceId`, typeof inc.serviceId === "string");
  check(`incident ${i} has serviceName`, typeof inc.serviceName === "string");
  check(`incident ${i} has url`, typeof inc.url === "string");
  check(`incident ${i} type is outage`, inc.type === "outage");
  check(`incident ${i} status is resolved|ongoing`, inc.status === "resolved" || inc.status === "ongoing");
  check(`incident ${i} startedAt is a date`, typeof inc.startedAt === "string" && !Number.isNaN(new Date(inc.startedAt).getTime()));
  if (inc.status === "resolved") {
    check(`incident ${i} endedAt is a date`, typeof inc.endedAt === "string" && !Number.isNaN(new Date(inc.endedAt).getTime()));
    check(`incident ${i} duration is a non-negative number`, typeof inc.duration === "number" && inc.duration >= 0);
  } else {
    check(`incident ${i} ongoing has no end time`, inc.endedAt == null);
  }
  if (i > 0) {
    check("incidents sorted newest first", new Date(incidents[i - 1].startedAt) >= new Date(inc.startedAt));
  }
}
check("at most 20 incidents returned", incidents.length <= 20);

const overall = body?.overall?.status;
const statuses = services.map((s) => s.status);
if (overall === "outage") check("outage implies an outage service", statuses.includes("outage"));
if (overall === "degraded") check("degraded implies an outage/degraded service", statuses.includes("degraded") || statuses.includes("outage"));
if (overall === "operational" && services.length) check("operational implies all services operational", statuses.every((s) => s === "operational"));

console.log(pass ? "ALL CHECKS PASS" : "FAILURES PRESENT");
process.exit(pass ? 0 : 1);
