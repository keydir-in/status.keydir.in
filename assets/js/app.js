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
const GAUGE_DEFAULT = "24h";

const $ = (sel) => document.querySelector(sel);

const esc = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

const pctColor = (pct) =>
  pct >= 99 ? "fill" : pct >= 95 ? "fill-warn" : "fill-bad";

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
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toUpperCase() + " · " + time;
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

// ──────────────────────────────────────────────
// UPTIME GAUGE
// One 180-degree technical gauge per service. Reads the real per-range
// uptime values from service.uptime[range] — nothing is hardcoded.
// ──────────────────────────────────────────────
const GAUGE_CX = 150, GAUGE_CY = 150, GAUGE_R = 110;

const gaugeValue = (svc, range) => {
  const raw = svc.uptime ? svc.uptime[range] : null;
  const pct = raw != null ? Number(raw) : null;
  return pct != null && Number.isFinite(pct) ? pct : null;
};

// Upper 180-degree semicircle only (0% = left, 50% = top, 100% = right).
// Sweep flag 1 from the left end keeps the arc ABOVE the center line.
// The green/red split is drawn with stroke-dasharray (pathLength="100") on one
// full path; the dash starts at the 0% (left) end.
const GAUGE_ARC = "M40,150 A110,110 0 0 1 260,150";

const gaugePoint = (v, r) => {
  const th = ((180 - v * 1.8) * Math.PI) / 180;
  return [GAUGE_CX + r * Math.cos(th), GAUGE_CY - r * Math.sin(th)];
};

const GAUGE_MINOR = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const GAUGE_MAJOR = [0, 25, 50, 75, 100];

const gaugeTicksHtml = () => {
  const minor = GAUGE_MINOR.map((v) => {
    const [x1, y1] = gaugePoint(v, 102);
    const [x2, y2] = gaugePoint(v, 110);
    return `<line class="tick is-minor" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
  }).join("");
  const major = GAUGE_MAJOR.map((v) => {
    const [x1, y1] = gaugePoint(v, 91);
    const [x2, y2] = gaugePoint(v, 110);
    return `<line class="tick is-major" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
  }).join("");
  const labels = GAUGE_MAJOR.map((v) => {
    const [x, y] = gaugePoint(v, 78);
    return `<text class="tick-label" x="${x.toFixed(2)}" y="${(y + 3).toFixed(2)}">${v}</text>`;
  }).join("");
  return minor + major + labels;
};

const gaugeNeedleDeg = (pct) => (pct != null ? (pct - 50) * 1.8 : -90);

const gaugeClamp = (v) => {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.min(Math.max(v, 0), 100);
};

function gaugeSvgHtml(svc, range, pct, value) {
  const frac = gaugeClamp(pct);
  return `
    <svg class="gauge" viewBox="0 0 300 180" role="img" aria-label="${esc(svc.name)} ${esc(range)} uptime ${esc(value)}">
      <path class="gauge-track" d="${GAUGE_ARC}"/>
      <path class="gauge-arc gauge-arc-red" d="${GAUGE_ARC}" pathLength="100" stroke-dasharray="100 100"/>
      <path class="gauge-arc gauge-arc-green" d="${GAUGE_ARC}" pathLength="100" stroke-dasharray="${frac} 100"/>
      <g class="gauge-ticks">${gaugeTicksHtml()}</g>
      <g class="gauge-needle">
        <line class="g-needle" x1="150" y1="150" x2="150" y2="74" style="transform:rotate(${gaugeNeedleDeg(pct)}deg)"/>
      </g>
      <circle class="gauge-hub" cx="150" cy="150" r="5"/>
    </svg>`;
}

function gaugePanelHtml(svc) {
  const meta = STATUS_META[svc.status] || STATUS_META.unknown;
  const svcCls = "is-" + esc(svc.status || "unknown");
  const pct = gaugeValue(svc, GAUGE_DEFAULT);
  const value = pct != null ? formatPct(pct) + "%" : "—";
  const cls = pct != null ? " is-" + pctColor(pct) : "";
  const valAttr = (r) => {
    const p = gaugeValue(svc, r);
    return p == null ? "" : String(p);
  };
  const rangeBtns = UPTIME_RANGES.map((r) => {
    const p = gaugeValue(svc, r);
    const active = r === GAUGE_DEFAULT;
    return `
      <button type="button" class="g-range${active ? " is-active" : ""}" data-range="${esc(r)}" aria-pressed="${active ? "true" : "false"}">
        <span class="gr-period">${esc(r)}</span>
        <span class="gr-val${p != null ? " is-" + pctColor(p) : ""}">${p != null ? formatPct(p) + "%" : "—"}</span>
      </button>`;
  }).join("");
  return `
    <div class="gauge-panel">
      <div class="gauge-head">
        <span class="gauge-svc-dot ${svcCls}" aria-hidden="true"></span>
        <div class="gauge-svc">
          <h3>${esc(svc.name)}</h3>
          <p>${esc(svc.url || svc.description || "")}</p>
        </div>
        <span class="gauge-svc-status ${svcCls}">${esc(meta.label)}</span>
      </div>
      <div class="gauge-wrap${cls}" data-v24h="${valAttr("24h")}" data-v7d="${valAttr("7d")}" data-v30d="${valAttr("30d")}" data-v90d="${valAttr("90d")}">
        ${gaugeSvgHtml(svc, GAUGE_DEFAULT, pct, value)}
        <div class="gauge-readout">
          <span class="gauge-pct">${value}</span>
          <span class="gauge-cap">Uptime</span>
        </div>
      </div>
      <div class="gauge-ranges">${rangeBtns}</div>
    </div>`;
}

function renderUptime(services) {
  const wrap = $("#uptime-list");
  if (!services || services.length === 0) {
    wrap.innerHTML = '<div class="empty">No uptime data available.</div>';
    return;
  }
  wrap.innerHTML = `<div class="uptime">${services.map(gaugePanelHtml).join("")}</div>`;
}

// Period selector: swap the gauge needle/readout from the values already in
// the DOM. No re-fetch, no page reload.
$("#uptime-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".g-range");
  if (!btn) return;
  const panel = btn.closest(".gauge-panel");
  if (!panel) return;
  const wrap = panel.querySelector(".gauge-wrap");
  const range = btn.dataset.range;
  panel.querySelectorAll(".g-range").forEach((b) => {
    b.classList.toggle("is-active", b === btn);
    b.setAttribute("aria-pressed", b === btn ? "true" : "false");
  });
  const raw = wrap.dataset["v" + range];
  const pct = raw == null || raw === "" ? null : Number(raw);
  const valid = pct != null && Number.isFinite(pct);
  const value = valid ? formatPct(pct) + "%" : "—";
  wrap.classList.remove("is-fill", "is-fill-warn", "is-fill-bad");
  if (valid) wrap.classList.add("is-" + pctColor(pct));
  wrap.querySelector(".gauge-pct").textContent = value;
  wrap.querySelector(".gauge-arc-green").setAttribute("stroke-dasharray", gaugeClamp(pct) + " 100");
  wrap.querySelector(".g-needle").style.transform = "rotate(" + gaugeNeedleDeg(pct) + "deg)";
});

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
    <div class="incident is-${esc(m.status || "identified")}">
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
  renderUptime(data.services || []);
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