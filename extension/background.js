// YouTube Time Tracker — MV3 service worker.
//
// Counting rule: accrue seconds while ANY open window's active tab is a
// youtube.com URL, independent of which window (or app) holds OS focus.
// Time is measured with timestamps (not setInterval) so that
// suspension of the MV3 service worker never loses time: the in-progress start
// timestamp and per-day accumulators live in chrome.storage.local.
//
// Storage shape (key "state"):
//   {
//     session: { active: bool, startTs: <ms epoch> },
//     days: { "YYYY-MM-DD": { countedMs: <int>, unsentMs: <int> } }
//   }
// countedMs = all counted time for that day (for display).
// unsentMs  = delta not yet acknowledged by the backend (retained until 200 OK).
//
// Config key "config": { workerUrl, secret }. No POSTs happen until both set.

const ALARM_NAME = "flush";
const FLUSH_PERIOD_MIN = 1.5; // 90 s cadence (chrome.alarms minimum-period workaround).
const YT_RE = /^https?:\/\/([^/]*\.)?youtube\.com\//;

// ---- serialize all mutations to avoid load/save races ----
let queue = Promise.resolve();
function serial(fn) {
  const run = () => fn();
  queue = queue.then(run, run);
  return queue;
}

// ---- storage helpers ----
async function loadState() {
  const { state } = await chrome.storage.local.get("state");
  if (state && state.session && state.days) return state;
  return { session: { active: false, startTs: 0 }, days: {} };
}
async function saveState(s) {
  await chrome.storage.local.set({ state: s });
}
async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return config || { workerUrl: "", secret: "" };
}

// ---- date helpers (local time) ----
function dateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function nextMidnight(ts) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// Fold the elapsed interval [startTs, now) into per-day accumulators, splitting
// across local midnight boundaries. Leaves session.startTs untouched (caller sets it).
function foldElapsed(s, now) {
  let start = s.session.startTs;
  if (!start || start >= now) return;
  while (start < now) {
    const boundary = nextMidnight(start);
    const end = Math.min(boundary, now);
    const key = dateKey(start);
    const day = s.days[key] || (s.days[key] = { countedMs: 0, unsentMs: 0 });
    const dur = end - start;
    day.countedMs += dur;
    day.unsentMs += dur;
    start = end;
  }
}

// ---- state evaluation ----
async function isYouTubeActiveAnywhere() {
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    return wins.some((w) =>
      (w.tabs || []).some((t) => t.active && t.url && YT_RE.test(t.url))
    );
  } catch (e) {
    return false;
  }
}

// Apply the current counting state, recording transitions.
async function evaluate() {
  const counting = await isYouTubeActiveAnywhere();
  const s = await loadState();
  const now = Date.now();
  if (counting && !s.session.active) {
    s.session = { active: true, startTs: now };
    await saveState(s);
  } else if (!counting && s.session.active) {
    foldElapsed(s, now);
    s.session = { active: false, startTs: 0 };
    await saveState(s);
  }
  // (counting && active) or (!counting && !active): no transition, nothing to persist.
}

// ---- backend flush ----
async function postIngest(cfg, date, seconds, reportNow) {
  const resp = await fetch(cfg.workerUrl.replace(/\/+$/, "") + "/ingest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ingest-Secret": cfg.secret,
    },
    body: JSON.stringify({ date, seconds, report_now: reportNow }),
  });
  return resp.ok;
}

// Send unsent deltas. Checkpoints in-progress time first (so today's delta is
// current) without stopping the session.
async function flush(reportNow) {
  const cfg = await getConfig();
  if (!cfg.workerUrl || !cfg.secret) return;

  const s = await loadState();
  const now = Date.now();
  if (s.session.active) {
    foldElapsed(s, now);
    s.session.startTs = now; // checkpoint: keep counting from here
  }
  await saveState(s);

  const today = dateKey(now);
  const dates = Object.keys(s.days);
  // Ensure today is included for a report_now trigger even if delta is 0.
  if (reportNow && !dates.includes(today)) dates.push(today);

  for (const date of dates) {
    const day = s.days[date] || { countedMs: 0, unsentMs: 0 };
    const seconds = Math.floor(day.unsentMs / 1000);
    const isToday = date === today;
    const wantReport = reportNow && isToday;
    if (seconds <= 0 && !wantReport) continue;

    let ok = false;
    try {
      ok = await postIngest(cfg, date, seconds, wantReport);
    } catch (e) {
      ok = false;
    }
    if (ok) {
      // Re-load to fold in any time that accrued during the network round-trip,
      // then subtract exactly what we sent (keeping sub-second remainder).
      const cur = await loadState();
      const d = cur.days[date] || (cur.days[date] = { countedMs: 0, unsentMs: 0 });
      d.unsentMs -= seconds * 1000;
      if (d.unsentMs < 0) d.unsentMs = 0;
      await saveState(cur);
    }
    // On failure: retain unsent, retry next flush.
  }

  // Prune past days that are fully acknowledged (keep today + anything still unsent).
  const cur = await loadState();
  const t = dateKey(Date.now());
  let changed = false;
  for (const date of Object.keys(cur.days)) {
    if (date < t && cur.days[date].unsentMs <= 0) {
      delete cur.days[date];
      changed = true;
    }
  }
  if (changed) await saveState(cur);
}

// ---- event wiring ----
function ensureAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: FLUSH_PERIOD_MIN });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  serial(evaluate);
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  serial(evaluate);
});

chrome.tabs.onActivated.addListener(() => serial(evaluate));
chrome.windows.onFocusChanged.addListener(() => serial(evaluate));

chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    // Navigation may have moved off YouTube: re-evaluate, then flush.
    serial(async () => {
      await evaluate();
      await flush(false);
    });
  }
});

chrome.tabs.onRemoved.addListener(() => {
  serial(async () => {
    await evaluate();
    await flush(false);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  serial(async () => {
    await evaluate();
    await flush(false);
  });
});

// Popup → "Report now" and config-changed triggers.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "reportNow") {
    serial(() => flush(true)).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  if (msg && msg.type === "configChanged") {
    serial(evaluate);
  }
  return false;
});

// Make sure an alarm exists even on a bare wake-up.
ensureAlarm();
