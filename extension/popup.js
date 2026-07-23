// Popup: live today total, "Report now", and config (Worker URL + secret).

function dateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function fmt(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

// Today's live total = stored countedMs for today + in-progress interval clamped
// to today (so a session started before midnight only counts its today portion).
async function computeToday() {
  const { state } = await chrome.storage.local.get("state");
  const now = Date.now();
  const today = dateKey(now);
  let ms = state && state.days && state.days[today] ? state.days[today].countedMs : 0;
  if (state && state.session && state.session.active) {
    const from = Math.max(state.session.startTs, todayMidnight());
    if (now > from) ms += now - from;
  }
  return ms / 1000;
}

async function render() {
  document.getElementById("total").textContent = fmt(await computeToday());
}

// Live tick.
render();
setInterval(render, 1000);

// Report now.
document.getElementById("report").addEventListener("click", () => {
  const btn = document.getElementById("report");
  const status = document.getElementById("status");
  btn.disabled = true;
  status.textContent = "Reporting…";
  chrome.runtime.sendMessage({ type: "reportNow" }, () => {
    btn.disabled = false;
    status.textContent = chrome.runtime.lastError
      ? "Error: " + chrome.runtime.lastError.message
      : "Sent.";
    setTimeout(() => (status.textContent = ""), 2500);
  });
});

// Load existing config into the form.
(async () => {
  const { config } = await chrome.storage.local.get("config");
  if (config) {
    document.getElementById("url").value = config.workerUrl || "";
    document.getElementById("secret").value = config.secret || "";
  } else {
    document.getElementById("opts").open = true; // prompt setup on first run
  }
})();

// Save config.
document.getElementById("save").addEventListener("click", async () => {
  const workerUrl = document.getElementById("url").value.trim();
  const secret = document.getElementById("secret").value.trim();
  await chrome.storage.local.set({ config: { workerUrl, secret } });
  chrome.runtime.sendMessage({ type: "configChanged" });
  const st = document.getElementById("cfgStatus");
  st.textContent = workerUrl && secret ? "Saved." : "Saved (inert until both set).";
  setTimeout(() => (st.textContent = ""), 2500);
});
