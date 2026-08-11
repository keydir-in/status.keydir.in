"use strict";

const STATUS_API = "https://keydir-status-api.keydir.in/status";
const REFRESH_MS = 30000;
const RETRY_MS = 5000;
const DEBUG = new URLSearchParams(location.search).has("debug");

const STATUS_META = {
  operational: { label: "Operational",                overallTitle: "All Systems Operational" },
  degraded:    { label: "Degraded Performance",       overallTitle: "Degraded Performance" },
  outage:      { label: "Major Outage",               overallTitle: "Major Outage" },
  maintenance: { label: "Maintenance",                overallTitle: "Maintenance" },
  paused:      { label: "Paused",                     overallTitle: "Monitoring Paused" },
  unknown:     { label: "Unable to determine status", overallTitle: "Unable to determine status" }
};

const UPTIME_RANGES = ["24h", "7d", "30d", "90d"];
const UPTIME_BUCKETS = { "24h": 24, "7d": 7, "30d": 30, "90d": 90 };

const $ = (sel) => document.querySelector(sel);

const esc = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

const pctColor = (pct) =>
  pct >= 99.9 ? "fill" : pct >= 99.5 ? "fill-warn" : "fill-bad";

const formatPct = (pct) => {
  const n = Number(pct);
  return Number.isFinite(n) ? n.toFixed(2) : "—";
};

// Seconds -> "28 seconds", "2m 18s", "1h 5m".
const formatDuration = (sec) => {
  const s = Math.floor(Number(sec));
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return s + " seconds";
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return h + "h " + (m % 60) + "m";
  return m + "m " + (s % 60) + "s";
};

const formatIncidentDate = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit"
  });
};

const formatUpdated = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return "Last updated " + d.toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
};

function renderOverallStatus(statusData) {
  const status = STATUS_META[statusData.status] || STATUS_META.unknown;
  $("#overall").innerHTML = `
    <span class="status-dot" aria-hidden="true"></span>
    <div>
      <h1>${esc(status.overallTitle)}</h1>
      <p class="overall-message">${esc(statusData.message || "")}</p>
      <p class="updated">${formatUpdated(statusData.lastUpdated)}</p>
    </div>`;
  $("#overall").className = "card overall status-" + (statusData.status || "unknown");
}

function renderServices(services) {
  const list = $("#services-list");
  if (!services || services.length === 0) {
    list.innerHTML = '<div class="empty">No services configured.</div>';
    $("#services-count").textContent = "";
    return;
  }
  list.innerHTML = services.map((svc) => {
    const meta = STATUS_META[svc.status] || STATUS_META.unknown;
    return `
      <div class="service">
        <span class="service-dot is-${esc(svc.status || "unknown")}" aria-hidden="true"></span>
        <div class="service-info">
          <h3>${esc(svc.name)}</h3>
          <p>${esc(svc.url || svc.description || "")}</p>
        </div>
        <div class="service-status">
          ${esc(meta.label)}
          <small>${esc(svc.status || "unknown")}</small>
        </div>
      </div>`;
  }).join("");
  $("#services-count").textContent = (services.length || 0) + " services";
}

// Human-readable label for a single history block, e.g. "Aug 11, 3 PM — Operational".
const STATE_LABEL = { up: "Operational", down: "Down", paused: "Paused" };
function blockLabel(range, idxFromEnd, lastUpdatedIso, state) {
  const status = STATE_LABEL[state] || "No data";
  if (!lastUpdatedIso) return status;
  const ms = new Date(lastUpdatedIso).getTime();
  if (Number.isNaN(ms)) return status;
  const stepMs = range === "24h" ? 3600000 : 86400000;
  const d = new Date(ms - idxFromEnd * stepMs);
  const when = range === "24h"
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${when} — ${status}`;
}

// Renders the real per-interval timeline from service.history[range]:
//   "up"    -> green
//   "down"  -> red
//   "paused"-> muted amber
//   null    -> muted gray (no positive monitoring proof for that interval)
// The Worker always returns exactly UPTIME_BUCKETS[range] values, and this
// always renders exactly that many blocks — never more, never fewer.
function uptimeColHtml(range, svc, lastUpdatedIso) {
  const raw = svc.uptime ? svc.uptime[range] : null;
  const pct = raw != null ? Number(raw) : null;
  const valid = pct != null && Number.isFinite(pct);
  const value = valid ? formatPct(pct) + "%" : "—";
  const cls = valid ? " is-" + pctColor(pct) : "";
  const count = UPTIME_BUCKETS[range] || 10;
  const history = svc.history && Array.isArray(svc.history[range]) ? svc.history[range] : [];
  const label = `${range} uptime ${valid ? formatPct(pct) + "%" : "unknown"}`;
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const state = history[i];
    const fill =
      state === "down" ? " is-fill-bad"
      : state === "up" ? " is-fill"
      : state === "paused" ? " is-paused"
      : "";
    const title = esc(blockLabel(range, count - 1 - i, lastUpdatedIso, state));
    blocks.push(`<span class="ub${fill}" title="${title}" aria-hidden="true"></span>`);
  }
  return `
    <div class="uptime-col">
      <span class="uptime-range">${esc(range)}</span>
      <span class="uptime-value${cls}">${value}</span>
      <span class="ub-row" style="--n:${count}" role="img" aria-label="${label}">${blocks.join("")}</span>
      ${range === "24h" ? '<span class="ub-now">now</span>' : ""}
    </div>`;
}

function renderUptime(services, lastUpdatedIso) {
  const wrap = $("#uptime-list");
  if (!services || services.length === 0) {
    wrap.innerHTML = '<div class="empty">No uptime data available.</div>';
    return;
  }
  wrap.innerHTML = `<div class="uptime">${services.map((svc) => `
    <div class="uptime-service">
      <h3 class="uptime-name">${esc(svc.name)}</h3>
      <div class="uptime-cols">${UPTIME_RANGES.map((range) => uptimeColHtml(range, svc, lastUpdatedIso)).join("")}</div>
    </div>`).join("")}</div>`;
}

function incidentCard(inc) {
  const ongoing = inc.status === "ongoing";
  const resolved = inc.status === "resolved";
  const label = ongoing ? "ONGOING" : resolved ? "RESOLVED" : esc(String(inc.status || "unknown")).toUpperCase();
  const when = ongoing ? "Started " + formatIncidentDate(inc.startedAt) : formatIncidentDate(inc.startedAt);
  const duration = ongoing
    ? `<span class="live-duration" data-start="${esc(inc.startedAt)}">${formatDuration((Date.now() - new Date(inc.startedAt).getTime()) / 1000)}</span>`
    : formatDuration(inc.duration);
  return `
    <div class="incident is-${esc(ongoing ? "ongoing" : resolved ? "resolved" : "unknown")}">
      <div class="incident-head">
        <span class="incident-dot" aria-hidden="true"></span>
        <div class="incident-body">
          <h4>${esc(inc.serviceName)}</h4>
          <span class="incident-kind">Service Outage</span>
        </div>
        <span class="incident-status is-${esc(ongoing ? "ongoing" : resolved ? "resolved" : "unknown")}">${label}</span>
      </div>
      <div class="incident-times">
        <span>${esc(when)}</span>
        <span>Duration: ${duration}</span>
      </div>
    </div>`;
}

function renderIncidents(incidents) {
  const wrap = $("#incidents-list");
  const list = incidents || [];
  $("#incidents-count").textContent = list.length
    ? list.length + (list.length === 1 ? " INCIDENT" : " INCIDENTS")
    : "";
  if (list.length === 0) {
    wrap.innerHTML = '<div class="empty"><strong>✓</strong> NO INCIDENTS REPORTED.</div>';
    return;
  }

  // Worker already sorts newest-first; sort defensively so the newest
  // incident always sits at the top.
  const sorted = [...list].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  wrap.innerHTML = sorted.map(incidentCard).join("");
}

// Live duration for ongoing incidents: re-compute from wall-clock every second
// without a re-render. Not stored, never faked.
setInterval(() => {
  document.querySelectorAll(".live-duration[data-start]").forEach((el) => {
    const t = new Date(el.dataset.start).getTime();
    if (!Number.isNaN(t)) el.textContent = formatDuration((Date.now() - t) / 1000);
  });
}, 1000);

function renderMaintenance(maintenance) {
  const wrap = $("#maintenance-list");
  if (!maintenance || maintenance.length === 0) {
    wrap.innerHTML = '<div class="empty">No scheduled maintenance.</div>';
    return;
  }
  wrap.innerHTML = maintenance.map((m) => `
    <div class="incident">
      <div class="incident-head">
        <h4>${esc(m.title)}</h4>
        <span class="incident-status is-${esc(m.status || "identified")}">${esc(m.status === "resolved" ? "Completed" : "Scheduled")}</span>
      </div>
      <div class="incident-times">
        <span>Date: ${esc(m.date || "—")}</span>
        <span>Start: ${esc(m.start || "—")}</span>
        <span>End: ${esc(m.end || "—")}</span>
        <span>Duration: ${esc(m.duration || "—")}</span>
      </div>
    </div>`).join("");
}

function renderAll(data) {
  renderOverallStatus(data.overall || {});
  renderServices(data.services || []);
  renderUptime(data.services || [], data.lastUpdated);
  renderIncidents(data.incidents || []);
  renderMaintenance(data.maintenance || []);
}

function renderUnavailable() {
  $("#overall").innerHTML = `
    <span class="status-dot" aria-hidden="true"></span>
    <div>
      <h1>Unable to retrieve live status</h1>
      <p class="overall-message">Live status data is temporarily unavailable. We're retrying automatically.</p>
    </div>`;
  $("#overall").className = "card overall status-unknown";
  const empties = ["#services-list", "#uptime-list", "#incidents-list", "#maintenance-list"];
  empties.forEach((sel) => { $(sel).innerHTML = '<div class="empty">Status data unavailable.</div>'; });
}

function setBadge(mode) {
  const badge = $("#live-badge");
  if (mode === "live") {
    badge.className = "live-badge";
    badge.textContent = "LIVE";
    badge.hidden = false;
  } else if (mode === "stale") {
    badge.className = "live-badge is-stale";
    badge.textContent = "SYNCED";
    badge.hidden = false;
  } else {
    badge.hidden = true;
    badge.textContent = "";
  }
}

function setStaleNote() {
  const note = $("#live-note");
  if (!lastSyncAt) {
    note.hidden = true;
    note.textContent = "";
    return;
  }
  const mins = Math.max(1, Math.round((Date.now() - lastSyncAt) / 60000));
  note.textContent = "LAST SYNC: " + mins + " MIN AGO";
  note.hidden = false;
}

let currentData = null;
let lastSyncAt = null;
let fetching = false;
let retryTimer = null;

async function loadStatus() {
  if (fetching) return;
  fetching = true;
  try {
    const res = await fetch(STATUS_API, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (DEBUG) console.log("[KEYDIR status] API response:", data);
    currentData = data;
    lastSyncAt = Date.now();
    renderAll(data);
    setBadge("live");
    $("#live-note").hidden = true;
  } catch (err) {
    console.error("KEYDIR status API unavailable:", err);
    if (currentData) {
      setBadge("stale");
      setStaleNote();
    } else {
      setBadge(null);
      renderUnavailable();
    }
    if (!retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; loadStatus(); }, RETRY_MS);
    }
  } finally {
    fetching = false;
  }
}

loadStatus();
setInterval(loadStatus, REFRESH_MS);