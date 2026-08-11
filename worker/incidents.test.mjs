// Unit test for buildIncidents. Run: node worker/incidents.test.mjs
import { buildIncidents } from "./keydir-status-api.js";

const svc = { id: "803634381", name: "app.keydir.in", url: "https://app.keydir.in" };
const t = 1754890000; // arbitrary base epoch

let pass = true;
const check = (name, ok) => { if (!ok) { pass = false; console.log("FAIL:", name); } };

// DOWN then UP -> one resolved incident, duration = diff.
let incs = buildIncidents([
  { type: 1, datetime: t },
  { type: 2, datetime: t + 28 }
], svc);
check("DOWN+UP -> exactly one incident", incs.length === 1);
check("DOWN+UP -> resolved", incs[0].status === "resolved");
check("startedAt = DOWN time", new Date(incs[0].startedAt).getTime() === t * 1000);
check("endedAt = UP time", new Date(incs[0].endedAt).getTime() === (t + 28) * 1000);
check("duration = 28", incs[0].duration === 28);
check("id is deterministic", incs[0].id === "803634381-" + t);
check("has service fields", incs[0].serviceId === "803634381" && incs[0].serviceName === "app.keydir.in" && incs[0].url === "https://app.keydir.in");

// DOWN with no UP -> ongoing, no invented end.
incs = buildIncidents([{ type: 1, datetime: t }], svc);
check("DOWN only -> one incident", incs.length === 1);
check("DOWN only -> ongoing", incs[0].status === "ongoing");
check("DOWN only -> endedAt null", incs[0].endedAt === null);
check("DOWN only -> duration null", incs[0].duration === null);

// Multiple DOWN/UP pairs -> multiple incidents, oldest first.
incs = buildIncidents([
  { type: 1, datetime: t },
  { type: 2, datetime: t + 10 },
  { type: 1, datetime: t + 100 },
  { type: 2, datetime: t + 130 }
], svc);
check("two pairs -> two incidents", incs.length === 2);
check("pair order preserved", incs[0].duration === 10 && incs[1].duration === 30);

// UP with no preceding DOWN is ignored.
incs = buildIncidents([{ type: 2, datetime: t }], svc);
check("UP only -> no incident", incs.length === 0);

// PAUSED logs are ignored, never become incidents.
incs = buildIncidents([{ type: 90, datetime: t }], svc);
check("PAUSED only -> no incident", incs.length === 0);

// Trailing DOWN after a resolved pair -> ongoing.
incs = buildIncidents([
  { type: 1, datetime: t },
  { type: 2, datetime: t + 5 },
  { type: 1, datetime: t + 50 }
], svc);
check("resolved + ongoing", incs.length === 2 && incs[1].status === "ongoing");

// Unsorted / duplicate logs are handled.
incs = buildIncidents([
  { type: 2, datetime: t + 10 },
  { type: 1, datetime: t },
  { type: 1, datetime: t + 3 },
  { type: 2, datetime: t + 10 }
], svc);
check("duplicate DOWN ignored, sorts correctly", incs.length === 1 && incs[0].duration === 10);

console.log(pass ? "ALL INCIDENT CHECKS PASS" : "FAILURES PRESENT");
process.exit(pass ? 0 : 1);
