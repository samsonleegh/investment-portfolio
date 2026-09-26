import { encryptJSON, decryptJSON, isEncrypted } from "./crypto.js";

/* =====================================================================
   Helpers
   ===================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny DOM builder. Strings become text nodes, so data never hits innerHTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const CUR = "S$";
const nf0 = new Intl.NumberFormat("en-SG", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + CUR + nf0.format(Math.abs(v)));
const money2 = (v) => (v == null || isNaN(v) ? "" : nf2.format(v));
const signed = (v) => (v == null || isNaN(v) ? "–" : Math.round(v) === 0 ? CUR + "0" : (v > 0 ? "+" : "−") + CUR + nf0.format(Math.abs(v)));
const pct = (v, dp = 1) => (v == null || !isFinite(v) ? "–" : (v * 100).toFixed(dp) + "%");
const signedPct = (v) => (v == null || !isFinite(v) ? "–" : (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + "%");
function compact(v) {
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M" : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K" : nf0.format(a);
  return (v < 0 ? "−" : "") + s;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (key, long = false) => {
  const [y, m] = key.split("-").map(Number);
  return long ? `${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ’${String(y).slice(2)}`;
};
const addMonths = (key, n) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const thisMonth = () => new Date().toISOString().slice(0, 7);
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);

/** Parses "1,234.5" or simple arithmetic like "83536+76735.32" (the way the sheet does it). */
function parseAmount(raw) {
  const s = String(raw ?? "").replace(/,/g, "").trim();
  if (!s) return null;
  if (!/^[\d+\-*/().\s]+$/.test(s)) return NaN;
  try {
    const v = Function(`"use strict"; return (${s});`)();
    return typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : NaN;
  } catch {
    return NaN;
  }
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const alpha = (hex, a) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* =====================================================================
   Local storage (all access guarded: private mode can throw)
   ===================================================================== */
const store = {
  get(key, fallback = null, area = localStorage) {
    try {
      const v = area.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value, area = localStorage) {
    try {
      value == null ? area.removeItem(key) : area.setItem(key, JSON.stringify(value));
    } catch {}
  },
};
const K = { settings: "pf.settings", cache: "pf.cache", pass: "pf.pass", theme: "pf.theme", ui: "pf.ui" };

/* =====================================================================
   GitHub sync (Contents API)
   ===================================================================== */
function ghConfig() {
  const s = store.get(K.settings, {}) || {};
  // Sensible defaults when served from <owner>.github.io/<repo>/
  const onPages = location.hostname.endsWith(".github.io");
  return {
    owner: s.owner || (onPages ? location.hostname.split(".")[0] : ""),
    repo: s.repo || (onPages ? location.pathname.split("/").filter(Boolean)[0] || "" : ""),
    branch: s.branch || "main",
    path: s.path || "data/portfolio.enc.json",
    token: s.token || "",
  };
}
const ghReady = (c = ghConfig()) => Boolean(c.owner && c.repo && c.token);
const ghUrl = (c) => `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${c.path.split("/").map(encodeURIComponent).join("/")}`;

async function ghGet(c = ghConfig()) {
  const res = await fetch(`${ghUrl(c)}?ref=${encodeURIComponent(c.branch)}&t=${Date.now()}`, {
    headers: { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (res.status === 404) return { payload: null, sha: null };
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({}))).message || res.statusText}`);
  const body = await res.json();
  const text = new TextDecoder().decode(Uint8Array.from(atob(body.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0)));
  return { payload: JSON.parse(text), sha: body.sha };
}

async function ghPut(payload, sha, c = ghConfig()) {
  const res = await fetch(ghUrl(c), {
    method: "PUT",
    headers: { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Update portfolio data (${new Date().toISOString().slice(0, 16).replace("T", " ")})`,
      content: btoa(JSON.stringify(payload)),
      branch: c.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.status === 409 || res.status === 422) {
    const err = new Error("conflict");
    err.conflict = true;
    throw err;
  }
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({}))).message || res.statusText}`);
  return (await res.json()).content.sha;
}

/* =====================================================================
   App state, load / save / sync
   ===================================================================== */
const state = {
  data: null,
  pass: null,
  sha: null, // sha of the file on GitHub we last read/wrote
  dirty: false,
  syncing: false,
  remote: null, // { payload, sha, source }
  ui: { tab: "portfolio", range: 36, trend: "total", historyAll: false, cfMonth: null, ...store.get(K.ui, {}) },
};
const saveUI = () => store.set(K.ui, { tab: state.ui.tab, range: state.ui.range, trend: state.ui.trend });

async function fetchRemote() {
  if (ghReady()) {
    try {
      const r = await ghGet();
      if (r.payload) return { ...r, source: "github" };
    } catch (e) {
      console.warn("GitHub fetch failed, falling back", e);
      setSync("error", "Couldn't reach GitHub — showing the last copy available");
    }
  }
  for (const path of ["data/portfolio.enc.json", "data/portfolio.json"]) {
    try {
      const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) return { payload: await res.json(), sha: null, source: path };
    } catch {}
  }
  return null;
}

async function boot() {
  setSync("busy", "Loading…");
  state.remote = await fetchRemote();
  const cache = store.get(K.cache);
  const hasEncrypted = (state.remote && isEncrypted(state.remote.payload)) || cache?.payload;

  if (!state.remote && !cache) return showLock("create", "No data found yet. Choose a passphrase to start fresh, or import a file.");
  if (!hasEncrypted) return showLock("create", "Your data isn't encrypted yet. Choose a passphrase — it protects the file you commit to GitHub.");

  const saved = store.get(K.pass, null, sessionStorage) || store.get(K.pass);
  if (saved) {
    try {
      return await unlock(saved, store.get(K.pass) != null);
    } catch {}
  }
  showLock("unlock");
}

function showLock(mode, msg) {
  $("#app").hidden = true;
  $("#lock").hidden = false;
  $("#lock").dataset.mode = mode;
  $("#lock-msg").textContent = msg || "Enter your passphrase to unlock your data.";
  $("#lock-pass2-wrap").hidden = mode !== "create";
  $("#lock-pass2").required = mode === "create";
  $("#lock-pass").autocomplete = mode === "create" ? "new-password" : "current-password";
  $("#lock-form button[type=submit]").textContent = mode === "create" ? "Encrypt & open" : "Unlock";
  $("#lock-error").textContent = "";
  setSync("idle", "");
  setTimeout(() => $("#lock-pass").focus(), 50);
}

async function unlock(pass, remember) {
  const cache = store.get(K.cache);
  let remoteData = null;
  let cacheData = null;
  const rp = state.remote?.payload;
  if (rp) remoteData = isEncrypted(rp) ? await decryptJSON(rp, pass) : rp;
  if (cache?.payload) {
    try {
      cacheData = await decryptJSON(cache.payload, pass);
    } catch (e) {
      if (!remoteData) throw e; // cache encrypted with an old passphrase: ignore it if we have remote
    }
  }

  // Prefer unsynced local edits if they're newer than what's on the server.
  const useCache = cacheData && (!remoteData || (cache.dirty && (cacheData.updatedAt || "") > (remoteData.updatedAt || "")));
  state.data = normalise(useCache ? cacheData : remoteData || emptyData());
  state.sha = state.remote?.sha ?? cache?.sha ?? null;
  state.dirty = Boolean(useCache && cache.dirty) || !isEncrypted(rp || {});
  state.pass = pass;
  store.set(K.pass, pass, sessionStorage);
  if (remember) store.set(K.pass, pass);

  $("#lock").hidden = true;
  $("#app").hidden = false;
  if (state.dirty) await persist({ touch: false });
  else {
    store.set(K.cache, { payload: isEncrypted(rp || {}) ? rp : await encryptJSON(state.data, pass), dirty: false, sha: state.sha });
    setSync(ghReady() ? "synced" : "local", ghReady() ? "Synced with GitHub" : "Viewing only — add a GitHub token in Settings to save from this device");
  }
  renderAll();
}

function emptyData() {
  return {
    version: 1,
    currency: "SGD",
    updatedAt: new Date().toISOString(),
    assets: [
      { id: "stocks", name: "Stocks & ETFs", costTracked: true },
      { id: "cash", name: "Cash", costTracked: false },
    ],
    passiveTypes: [
      { id: "dividends", name: "Dividends" },
      { id: "interest", name: "Interest" },
    ],
    months: [],
    budgets: [],
  };
}

function normalise(d) {
  d.assets ||= [];
  d.passiveTypes ||= [];
  d.months = (d.months || []).map((m) => ({ values: {}, invested: {}, passive: {}, note: "", ...m })).sort((a, b) => a.month.localeCompare(b.month));
  d.budgets = (d.budgets || []).sort((a, b) => a.month.localeCompare(b.month));
  return d;
}

/** Save locally (encrypted) and push to GitHub when configured. */
async function persist({ touch = true } = {}) {
  if (touch) state.data.updatedAt = new Date().toISOString();
  state.dirty = true;
  const payload = await encryptJSON(state.data, state.pass);
  store.set(K.cache, { payload, dirty: true, sha: state.sha });
  if (ghReady()) scheduleSync(payload);
  else setSync("dirty", "Saved on this device only — add a GitHub token in Settings to sync");
}

let syncTimer;
function scheduleSync(payload) {
  setSync("dirty", "Unsynced changes");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(payload), 1200);
}

async function sync(payload) {
  if (!ghReady() || state.syncing) return;
  state.syncing = true;
  setSync("busy", "Saving to GitHub…");
  try {
    payload ||= await encryptJSON(state.data, state.pass);
    try {
      state.sha = await ghPut(payload, state.sha);
    } catch (e) {
      if (!e.conflict) throw e;
      // Someone (another device) pushed since we loaded.
      const latest = await ghGet();
      const theirs = latest.payload ? await decryptJSON(latest.payload, state.pass).catch(() => null) : null;
      if (theirs && (theirs.updatedAt || "") > (state.data.updatedAt || "")) {
        const keepMine = confirm(
          "Your data on GitHub was changed from another device after this page loaded.\n\n" +
            "OK — overwrite it with this device's version\nCancel — discard this device's changes and load the GitHub version",
        );
        if (!keepMine) {
          state.data = normalise(theirs);
          state.sha = latest.sha;
          state.dirty = false;
          store.set(K.cache, { payload: latest.payload, dirty: false, sha: latest.sha });
          renderAll();
          setSync("synced", "Loaded the latest version from GitHub");
          return;
        }
      }
      state.sha = await ghPut(payload, latest.sha);
    }
    state.dirty = false;
    store.set(K.cache, { payload, dirty: false, sha: state.sha });
    setSync("synced", "Saved to GitHub");
  } catch (e) {
    console.error(e);
    setSync("error", `Sync failed: ${e.message}. Your changes are safe on this device — tap to retry.`);
    toast("Couldn't save to GitHub — tap the status to retry");
  } finally {
    state.syncing = false;
  }
}

function setSync(stateName, title) {
  const el = $("#sync-status");
  el.dataset.state = stateName;
  el.title = title || "";
  el.textContent = { synced: "Synced", dirty: "Unsynced", error: "Sync error", busy: "Saving…", local: "View only", idle: "" }[stateName] ?? "";
  if (stateName === "busy" && title === "Loading…") el.textContent = "Loading…";
}

/* =====================================================================
   Derived numbers
   ===================================================================== */
function assetMap() {
  return Object.fromEntries(state.data.assets.map((a, i) => [a.id, { ...a, index: i }]));
}
const total = (m) => sum(Object.values(m.values));
/** Money you put in: cost basis for cost-tracked assets, face value for the rest. */
function principal(m, amap = assetMap()) {
  let p = 0;
  for (const [id, v] of Object.entries(m.values)) {
    const inv = m.invested?.[id];
    p += amap[id]?.costTracked && inv != null ? inv : v;
  }
  return p;
}
const passiveTotal = (m) => sum(Object.values(m.passive || {}));

function series() {
  const amap = assetMap();
  return state.data.months.map((m, i, arr) => {
    const t = total(m);
    const p = principal(m, amap);
    const prev = arr[i - 1];
    const pt = prev ? total(prev) : null;
    const pp = prev ? principal(prev, amap) : null;
    return {
      m,
      month: m.month,
      total: t,
      principal: p,
      gain: t - p,
      change: prev ? t - pt : null,
      newMoney: prev ? p - pp : null,
      market: prev ? t - p - (pt - pp) : null,
      passive: passiveTotal(m),
    };
  });
}

/** Asset colour: fixed by position in the asset list (colour follows the entity). */
function assetColor(id) {
  const idx = state.data.assets.findIndex((a) => a.id === id);
  return cssVar(`--s${idx >= 0 && idx < 7 ? idx + 1 : 8}`);
}

/* =====================================================================
   Charts
   ===================================================================== */
const charts = {};
const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length || chart.config.type !== "line") return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar("--axis");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function baseOptions({ stacked = false, legend = true } = {}) {
  const ink2 = cssVar("--ink-2");
  const muted = cssVar("--muted");
  const grid = cssVar("--grid");
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: "index", intersect: false },
    layout: { padding: { top: 4 } },
    plugins: {
      legend: {
        display: legend,
        position: "top",
        align: "start",
        labels: {
          color: ink2, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2, padding: 14, font: { size: 12 },
          // Swatch = the series colour (not the 10% area wash or the surface-coloured gap stroke).
          generateLabels: (chart) =>
            chart.data.datasets.map((ds, i) => {
              const c = ds._key || ds.borderColor;
              return { text: ds.label, fillStyle: c, strokeStyle: c, lineWidth: 0, hidden: !chart.isDatasetVisible(i), datasetIndex: i, fontColor: ink2, borderRadius: 2 };
            }),
        },
      },
      tooltip: {
        backgroundColor: cssVar("--surface"),
        titleColor: cssVar("--ink"),
        bodyColor: cssVar("--ink"),
        footerColor: ink2,
        borderColor: cssVar("--border"),
        borderWidth: 1,
        padding: 10,
        boxWidth: 12,
        boxHeight: 2,
        boxPadding: 6,
        usePointStyle: false,
        titleFont: { weight: "600" },
        footerFont: { weight: "500" },
        callbacks: {
          label: (ctx) => ` ${money(ctx.parsed.y)}   ${ctx.dataset.label}`,
          labelColor: (ctx) => ({ borderColor: "transparent", backgroundColor: ctx.dataset._key || ctx.dataset.borderColor }),
        },
      },
    },
    scales: {
      x: {
        stacked,
        grid: { display: false },
        border: { color: cssVar("--axis") },
        ticks: { color: muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 18, font: { size: 11 } },
      },
      y: {
        stacked,
        grid: { color: grid, drawTicks: false },
        border: { display: false },
        ticks: { color: muted, padding: 8, callback: (v) => compact(v), font: { size: 11 }, maxTicksLimit: 6 },
      },
    },
  };
}

function drawChart(id, config) {
  charts[id]?.destroy();
  const canvas = document.getElementById(id);
  charts[id] = new Chart(canvas, { ...config, plugins: [crosshair] });
}

/* =====================================================================
   Portfolio tab
   ===================================================================== */
function renderPortfolio() {
  const all = series();
  if (!all.length) {
    $("#hero-value").textContent = money(0);
    $("#hero-month").textContent = "no data yet";
    $("#tiles").replaceChildren(h("div", { class: "tile" }, h("div", { class: "label" }, "Get started"), h("div", { class: "sub" }, "Add your first month with “+ Add month”.")));
    return;
  }
  const n = state.ui.range ? Math.min(state.ui.range + 1, all.length) : all.length;
  const view = all.slice(-n);
  const last = all.at(-1);
  const prev = all.at(-2);
  const yearAgo = all.at(-13);
  const amap = assetMap();

  // Range buttons + label
  $$("#range button").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.range) === state.ui.range)));
  $("#range-label").textContent = `${monthLabel(view[0].month, true)} – ${monthLabel(last.month, true)}`;

  // Hero
  $("#hero-month").textContent = monthLabel(last.month, true);
  $("#hero-value").textContent = money(last.total);
  const delta = (label, a, b) => {
    if (b == null) return "";
    const d = a - b;
    return h("span", {}, h("b", { class: d >= 0 ? "up" : "down" }, `${signed(d)} (${signedPct(d / b)})`), ` ${label}`);
  };
  $("#hero-mom").replaceChildren(delta("vs last month", last.total, prev?.total));
  $("#hero-yoy").replaceChildren(delta("vs a year ago", last.total, yearAgo?.total));

  // Tiles
  const tracked = Object.entries(last.m.values).filter(([id]) => amap[id]?.costTracked && last.m.invested?.[id] != null);
  const invested = sum(tracked.map(([id]) => last.m.invested[id]));
  const trackedValue = sum(tracked.map(([, v]) => v));
  const last12 = all.slice(-12);
  const passive12 = sum(last12.map((s) => s.passive));
  const rangeGain = sum(view.slice(1).map((s) => s.market));
  const rangeNew = sum(view.slice(1).map((s) => s.newMoney));
  const tile = (label, value, sub, cls) => h("div", { class: `tile ${cls || ""}` }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);
  const rangeName = state.ui.range ? `last ${state.ui.range / 12 === 1 ? "12 months" : state.ui.range / 12 + " years"}` : "all time";
  $("#tiles").replaceChildren(
    tile("Invested (cost)", money(invested), `${tracked.length} holdings with a cost basis`),
    tile("Unrealised gain", h("span", { class: trackedValue - invested >= 0 ? "up" : "down" }, signed(trackedValue - invested)), `${signedPct((trackedValue - invested) / invested)} on cost`),
    tile("Market gain", h("span", { class: rangeGain >= 0 ? "up" : "down" }, signed(rangeGain)), `${rangeName} · plus ${money(rangeNew)} new money`),
    tile("Passive income", money(passive12), `last 12 months · ${money(passive12 / 12)}/mo`),
  );

  renderTrend(view);
  renderChange(view);
  renderAllocation(last);
  renderHoldings(last, prev);
  renderPassive(view);
  renderHistory(all);
}

function renderTrend(view) {
  $$("#trend-mode button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === state.ui.trend)));
  const labels = view.map((s) => monthLabel(s.month));
  const surface = cssVar("--surface");
  if (state.ui.trend === "total") {
    $("#trend-sub").textContent = "Total value vs. the money you put in. The gap between the lines is your investment gain.";
    const s1 = cssVar("--s1");
    const ink2 = cssVar("--muted");
    const opts = baseOptions();
    opts.plugins.tooltip.callbacks.footer = (items) => {
      const i = items[0].dataIndex;
      return `Gain ${signed(view[i].gain)}`;
    };
    drawChart("chart-trend", {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Portfolio value", data: view.map((s) => s.total), borderColor: s1, _key: s1, backgroundColor: alpha(s1, 0.1), fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: surface, pointHoverBackgroundColor: s1, tension: 0.2 },
          { label: "Money put in", data: view.map((s) => s.principal), borderColor: ink2, _key: ink2, borderWidth: 2, borderDash: [], pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: ink2, pointHoverBorderColor: surface, fill: false, tension: 0.2 },
        ],
      },
      options: opts,
    });
  } else {
    $("#trend-sub").textContent = "Market value of each holding, stacked. Smaller holdings past the 7th are grouped as Other.";
    const ids = state.data.assets.map((a) => a.id).filter((id) => view.some((s) => s.m.values[id]));
    const main = ids.filter((id) => state.data.assets.findIndex((a) => a.id === id) < 7);
    const other = ids.filter((id) => !main.includes(id));
    const groups = main.map((id) => ({ label: assetMap()[id].name, color: assetColor(id), get: (m) => m.values[id] || 0 }));
    if (other.length) groups.push({ label: "Other", color: cssVar("--s8"), get: (m) => sum(other.map((id) => m.values[id])) });
    const opts = baseOptions({ stacked: true });
    opts.plugins.tooltip.itemSort = (a, b) => b.datasetIndex - a.datasetIndex;
    opts.plugins.tooltip.callbacks.footer = (items) => `Total ${money(view[items[0].dataIndex].total)}`;
    opts.plugins.tooltip.filter = (item) => item.parsed.y > 0;
    drawChart("chart-trend", {
      type: "line",
      data: {
        labels,
        datasets: groups.map((g, i) => ({
          label: g.label,
          data: view.map((s) => g.get(s.m)),
          borderColor: surface,
          _key: g.color,
          backgroundColor: g.color,
          borderWidth: 1,
          fill: i === 0 ? "origin" : "-1",
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.2,
        })),
      },
      options: opts,
    });
  }
}

function renderChange(view) {
  const rows = view.slice(1);
  const s1 = cssVar("--s1");
  const s2 = cssVar("--s2");
  const opts = baseOptions({ stacked: true });
  opts.interaction = { mode: "index", intersect: false };
  opts.plugins.tooltip.callbacks.footer = (items) => `Net change ${signed(rows[items[0].dataIndex].change)}`;
  opts.plugins.tooltip.callbacks.label = (ctx) => ` ${signed(ctx.parsed.y)}   ${ctx.dataset.label}`;
  const bar = (label, key, color) => ({
    label,
    data: rows.map((s) => s[key]),
    backgroundColor: color,
    _key: color,
    borderColor: cssVar("--surface"),
    borderWidth: 0,
    borderRadius: 2,
    maxBarThickness: 24,
    categoryPercentage: 0.8,
    barPercentage: 0.9,
  });
  drawChart("chart-change", {
    type: "bar",
    data: { labels: rows.map((s) => monthLabel(s.month)), datasets: [bar("New money in", "newMoney", s1), bar("Market gain / loss", "market", s2)] },
    options: opts,
  });
}

function barRow({ name, color, value, frac, right, sub }) {
  return h(
    "div",
    { class: "bar-row", title: `${name}: ${money(value)}` },
    h("div", { class: "name" }, h("span", { class: "swatch", style: { background: color } }), h("span", {}, name)),
    h("div", { class: "track" }, h("div", { class: "fill", style: { width: `${Math.max(0, Math.min(1, frac)) * 100}%`, background: color } })),
    h("div", { class: "val" }, right ?? money(value), sub ? h("small", {}, sub) : null),
  );
}

function renderAllocation(last) {
  const amap = assetMap();
  const t = last.total;
  const rows = Object.entries(last.m.values)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 1;
  $("#alloc-sub").textContent = `Share of ${money(t)} at ${monthLabel(last.month, true)}.`;
  $("#alloc").replaceChildren(
    ...rows.map(([id, v]) => barRow({ name: amap[id]?.name || id, color: assetColor(id), value: v, frac: v / max, right: pct(v / t), sub: compact(v) })),
  );
}

function renderHoldings(last, prev) {
  const amap = assetMap();
  const rows = Object.entries(last.m.values).sort((a, b) => b[1] - a[1]);
  const est = new Set(last.m.estimated || []);
  const head = h("thead", {}, h("tr", {}, h("th", {}, "Asset"), ...["Value", "Invested", "Gain", "Gain %", "vs last month", "Share"].map((t) => h("th", { class: "num" }, t))));
  let tv = 0, ti = 0, tg = 0, tm = 0;
  const body = h(
    "tbody",
    {},
    rows.map(([id, v]) => {
      const a = amap[id] || { name: id };
      const inv = a.costTracked ? last.m.invested?.[id] : null;
      const g = inv != null ? v - inv : null;
      const pv = prev?.m.values[id];
      tv += v;
      if (g != null) (ti += inv), (tg += g);
      if (pv != null) tm += v - pv;
      return h(
        "tr",
        {},
        h("td", {}, h("div", { class: "asset-name" }, h("span", { class: "swatch", style: { background: assetColor(id) } }), a.name, est.has(id) ? h("span", { class: "est", title: "Estimated" }, "~") : null)),
        h("td", { class: "num" }, money(v)),
        h("td", { class: "num" }, inv != null ? money(inv) : "–"),
        h("td", { class: `num ${g == null ? "" : g >= 0 ? "up" : "down"}` }, g != null ? signed(g) : "–"),
        h("td", { class: `num ${g == null ? "" : g >= 0 ? "up" : "down"}` }, g != null && inv ? signedPct(g / inv) : "–"),
        h("td", { class: "num" }, pv != null ? `${signed(v - pv)}` : "new"),
        h("td", { class: "num" }, pct(v / last.total)),
      );
    }),
  );
  const foot = h(
    "tfoot",
    {},
    h("tr", {}, h("td", {}, "Total"), h("td", { class: "num" }, money(tv)), h("td", { class: "num" }, money(ti)), h("td", { class: `num ${tg >= 0 ? "up" : "down"}` }, signed(tg)), h("td", { class: `num ${tg >= 0 ? "up" : "down"}` }, signedPct(tg / ti)), h("td", { class: "num" }, signed(tm)), h("td", { class: "num" }, "100%")),
  );
  $("#holdings").replaceChildren(head, body, foot);
}

function renderPassive(view) {
  const types = state.data.passiveTypes.filter((t) => view.some((s) => s.m.passive?.[t.id]));
  const total12 = sum(series().slice(-12).map((s) => s.passive));
  $("#passive-sub").textContent = `Dividends, payouts and interest received. ${money(total12)} in the last 12 months.`;
  const opts = baseOptions({ stacked: true });
  opts.plugins.tooltip.filter = (item) => item.parsed.y > 0;
  opts.plugins.tooltip.callbacks.footer = (items) => `Total ${money(view[items[0].dataIndex].passive)}`;
  drawChart("chart-passive", {
    type: "bar",
    data: {
      labels: view.map((s) => monthLabel(s.month)),
      datasets: types.map((t, i) => {
        const c = cssVar(`--s${Math.min(i + 1, 8)}`);
        return { label: t.name, data: view.map((s) => s.m.passive?.[t.id] || 0), backgroundColor: c, _key: c, borderColor: cssVar("--surface"), borderWidth: { top: 1 }, borderSkipped: "bottom", borderRadius: 2, maxBarThickness: 24 };
      }),
    },
    options: opts,
  });
}

function renderHistory(all) {
  const rows = [...all].reverse();
  const shown = state.ui.historyAll ? rows : rows.slice(0, 12);
  const head = h("thead", {}, h("tr", {}, h("th", {}, "Month"), ...["Total", "Change", "New money", "Market", "Passive"].map((t) => h("th", { class: "num" }, t)), h("th", {}, "Notes")));
  const body = h(
    "tbody",
    {},
    shown.map((s) =>
      h(
        "tr",
        { tabindex: "0", onclick: () => openMonthDialog(s.month), onkeydown: (e) => e.key === "Enter" && openMonthDialog(s.month) },
        h("td", { style: { whiteSpace: "nowrap" } }, monthLabel(s.month, true), s.m.estimated?.length ? h("span", { class: "est", title: "Some values estimated" }, " ~") : null),
        h("td", { class: "num" }, money(s.total)),
        h("td", { class: `num ${s.change == null ? "" : s.change >= 0 ? "up" : "down"}` }, s.change == null ? "–" : signed(s.change)),
        h("td", { class: "num" }, s.newMoney == null ? "–" : signed(s.newMoney)),
        h("td", { class: `num ${s.market == null ? "" : s.market >= 0 ? "up" : "down"}` }, s.market == null ? "–" : signed(s.market)),
        h("td", { class: "num" }, s.passive ? money(s.passive) : "–"),
        h("td", { class: "note" }, s.m.note || ""),
      ),
    ),
  );
  $("#history").replaceChildren(head, body);
  $("#history-more").hidden = rows.length <= 12;
  $("#history-more").textContent = state.ui.historyAll ? "Show recent only" : `Show all ${rows.length} months`;
}

/* =====================================================================
   Add / edit month dialog
   ===================================================================== */
let editing = null; // { key, isNew }

function openMonthDialog(key = null) {
  const months = state.data.months;
  const isNew = key == null;
  if (isNew) key = months.length ? addMonths(months.at(-1).month, 1) : thisMonth();
  editing = { key, isNew };
  $("#month-title").textContent = isNew ? "Add month" : `Edit ${monthLabel(key, true)}`;
  $("#mf-month").value = key;
  $("#mf-month").disabled = !isNew;
  $("#mf-delete").hidden = isNew;
  buildMonthForm();
  $("#month-dialog").showModal();
}

function neighbours(key) {
  const months = state.data.months;
  const prev = [...months].reverse().find((m) => m.month < key) || null;
  const prev2 = prev ? [...months].reverse().find((m) => m.month < prev.month) || null : null;
  const existing = months.find((m) => m.month === key) || null;
  return { prev, prev2, existing };
}

function buildMonthForm() {
  const key = $("#mf-month").value || editing.key;
  const { prev, prev2, existing } = neighbours(key);
  const src = existing || null;
  const table = $("#mf-assets");
  const head = h("thead", {}, h("tr", {}, h("th", {}, "Holding"), h("th", { class: "num" }, "Market value"), h("th", { class: "num" }, "Added this month")));
  const body = h("tbody", {});
  for (const a of state.data.assets) {
    if (a.archived && !src?.values[a.id]) continue;
    const prevVal = prev?.values[a.id];
    const value = src ? src.values[a.id] : prevVal;
    let added = null;
    if (a.costTracked) {
      const prevInv = prev?.invested[a.id] ?? 0;
      if (src) added = src.invested[a.id] != null ? src.invested[a.id] - prevInv : null;
      else if (prev?.invested[a.id] != null) added = prev.invested[a.id] - (prev2?.invested[a.id] ?? 0);
    }
    const valInput = h("input", { type: "text", inputmode: "decimal", name: `v_${a.id}`, value: money2(value), placeholder: "0", "aria-label": `${a.name} market value`, oninput: updateMonthTotal });
    const hint = h("div", { class: "hint" });
    const setHint = () => {
      const v = parseAmount(valInput.value);
      if (prevVal == null) hint.textContent = "new";
      else if (v == null || isNaN(v)) hint.textContent = `last ${compact(prevVal)}`;
      else hint.textContent = `last ${compact(prevVal)} · ${signedPct((v - prevVal) / prevVal)}`;
    };
    valInput.addEventListener("input", setHint);
    setHint();
    body.append(
      h(
        "tr",
        {},
        h("td", {}, h("div", { class: "asset-name" }, h("span", { class: "swatch", style: { background: assetColor(a.id) } }), a.name)),
        h("td", { "data-label": "Market value" }, valInput, hint),
        h("td", { "data-label": "Added this month" }, a.costTracked ? h("input", { type: "text", inputmode: "decimal", name: `c_${a.id}`, value: money2(added), placeholder: "0", "aria-label": `${a.name} added this month` }) : h("div", { class: "hint" }, "no cost basis")),
      ),
    );
  }
  table.replaceChildren(head, body);

  $("#mf-passive").replaceChildren(
    ...state.data.passiveTypes.map((t) =>
      h("label", { class: "field" }, h("span", {}, t.name), h("input", { type: "text", inputmode: "decimal", name: `p_${t.id}`, value: money2(src?.passive?.[t.id]), placeholder: "0" })),
    ),
  );
  $("#mf-note").value = src?.note || "";
  updateMonthTotal();
}

function updateMonthTotal() {
  const key = $("#mf-month").value || editing.key;
  const { prev } = neighbours(key);
  let t = 0, bad = false;
  $$("#mf-assets input[name^=v_]").forEach((i) => {
    const v = parseAmount(i.value);
    if (Number.isNaN(v)) bad = true;
    else t += v || 0;
  });
  const pt = prev ? total(prev) : null;
  $("#mf-total").replaceChildren(
    h("span", {}, "Total ", h("b", {}, money(t))),
    pt != null ? h("span", { class: t - pt >= 0 ? "up" : "down" }, `${signed(t - pt)} vs ${monthLabel(prev.month)}`) : "",
    bad ? h("span", { class: "error" }, "Check the highlighted numbers") : "",
  );
}

async function saveMonthForm() {
  const key = $("#mf-month").value;
  if (!/^\d{4}-\d{2}$/.test(key)) return toast("Pick a month");
  const { prev, existing } = neighbours(key);
  if (editing.isNew && existing) return toast(`${monthLabel(key, true)} already exists — edit it from the history table`);

  const m = { month: key, values: {}, invested: {}, passive: {}, note: $("#mf-note").value.trim() };
  let bad = null;
  for (const a of state.data.assets) {
    const vi = $(`#mf-assets input[name="v_${a.id}"]`);
    if (!vi) {
      if (existing?.values[a.id] != null) m.values[a.id] = existing.values[a.id];
      continue;
    }
    const v = parseAmount(vi.value);
    const ci = $(`#mf-assets input[name="c_${a.id}"]`);
    const c = ci ? parseAmount(ci.value) : null;
    if (Number.isNaN(v) || Number.isNaN(c)) bad = a.name;
    vi.setAttribute("aria-invalid", String(Number.isNaN(v)));
    ci?.setAttribute("aria-invalid", String(Number.isNaN(c)));
    if (v) m.values[a.id] = v;
    if (a.costTracked && (v || c)) {
      const base = prev?.invested[a.id] ?? 0;
      m.invested[a.id] = Math.round((base + (c || 0)) * 100) / 100;
    }
  }
  for (const t of state.data.passiveTypes) {
    const v = parseAmount($(`#mf-passive input[name="p_${t.id}"]`).value);
    if (Number.isNaN(v)) bad = t.name;
    if (v) m.passive[t.id] = v;
  }
  if (bad) return toast(`“${bad}” isn't a number`);
  // Estimated flags stay only on values the user didn't touch.
  if (existing?.estimated) {
    const kept = existing.estimated.filter((id) => m.values[id] === existing.values[id]);
    if (kept.length) m.estimated = kept;
  }

  // Invested is cumulative: if this edit changed a month's contribution, shift every later month too.
  if (existing) {
    for (const later of state.data.months.filter((x) => x.month > key)) {
      for (const id of Object.keys(m.invested)) {
        if (existing.invested[id] == null) continue;
        const d = m.invested[id] - existing.invested[id];
        if (d && later.invested[id] != null) later.invested[id] = Math.round((later.invested[id] + d) * 100) / 100;
      }
    }
  }
  state.data.months = [...state.data.months.filter((x) => x.month !== key), m].sort((a, b) => a.month.localeCompare(b.month));
  $("#month-dialog").close();
  renderAll();
  toast(`${monthLabel(key, true)} saved`);
  await persist();
}

async function deleteMonth() {
  const key = editing.key;
  if (!confirm(`Delete ${monthLabel(key, true)}? This can't be undone (except from a backup or the GitHub history).`)) return;
  state.data.months = state.data.months.filter((m) => m.month !== key);
  $("#month-dialog").close();
  renderAll();
  await persist();
}

/* =====================================================================
   Cash-flow tab
   ===================================================================== */
const CF_GROUPS = [
  { key: "income", title: "Earnings (gross)", add: "Add income" },
  { key: "deductions", title: "Deductions (CPF, tax at source…)", add: "Add deduction" },
  { key: "expenses", title: "Expenses", add: "Add expense" },
  { key: "investments", title: "Investments & savings", add: "Add investment" },
];

function budgetTotals(b) {
  const gross = sum(b.income.map((l) => l.amount));
  const ded = sum(b.deductions.map((l) => l.amount));
  const takeHome = gross - ded;
  const exp = sum(b.expenses.map((l) => l.amount));
  const inv = sum(b.investments.map((l) => l.amount));
  return { gross, ded, takeHome, exp, inv, left: takeHome - exp - inv };
}

function currentBudget() {
  const bs = state.data.budgets;
  if (!bs.length) return null;
  if (!bs.some((b) => b.month === state.ui.cfMonth)) state.ui.cfMonth = bs.at(-1).month;
  return bs.find((b) => b.month === state.ui.cfMonth);
}

function renderCashflow({ editor = true } = {}) {
  const b = currentBudget();
  const sel = $("#cf-month");
  sel.replaceChildren(...[...state.data.budgets].reverse().map((x) => h("option", { value: x.month, selected: x.month === state.ui.cfMonth }, monthLabel(x.month, true))));
  $("#cf-delete").hidden = !b;
  if (!b) {
    $("#cf-tiles").replaceChildren(h("div", { class: "tile" }, h("div", { class: "label" }, "No months yet"), h("div", { class: "sub" }, "Click “+ New month” to create your first budget.")));
    ["#cf-split", "#cf-split-legend", "#cf-exp", "#cf-inv", "#cf-editor"].forEach((s) => $(s).replaceChildren());
    $("#cf-trend-card").hidden = true;
    return;
  }
  const t = budgetTotals(b);
  const s1 = cssVar("--s1");
  const s2 = cssVar("--s2");
  const neutral = cssVar("--axis");

  // Tiles
  const actual = series().find((s) => s.month === b.month);
  const tile = (label, value, sub, cls) => h("div", { class: `tile ${cls || ""}` }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);
  const saveRate = t.takeHome ? (t.inv + Math.max(t.left, 0)) / t.takeHome : null;
  $("#cf-tiles").replaceChildren(
    tile("Gross earnings", money(t.gross), t.ded ? `${money(t.ded)} deducted` : null),
    tile("Take-home", money(t.takeHome), t.gross ? `${pct(t.takeHome / t.gross)} of gross` : null),
    tile("Expenses", money(t.exp), t.takeHome ? `${pct(t.exp / t.takeHome)} of take-home` : null),
    tile("Investing & saving", money(t.inv), saveRate != null ? `Savings rate ${pct(saveRate)}` : null),
    t.left < 0
      ? tile("Over-allocated", money(-t.left), "Plan spends more than take-home", "warn")
      : tile("Left over", money(t.left), t.takeHome ? `${pct(t.left / t.takeHome)} unassigned` : null),
    actual?.newMoney != null ? tile("Actual new money in", signed(actual.newMoney), `From Portfolio tab, ${monthLabel(b.month)}`) : "",
  );

  // Split bar
  const base = Math.max(t.takeHome, t.exp + t.inv) || 1;
  const segs = [
    { name: "Expenses", v: t.exp, c: s2 },
    { name: "Investments & savings", v: t.inv, c: s1 },
    { name: t.left < 0 ? "Over by" : "Left over", v: Math.abs(t.left), c: neutral, hatch: t.left < 0 },
  ].filter((s) => s.v > 0);
  $("#cf-split-sub").textContent = `${money(t.takeHome)} take-home in ${monthLabel(b.month, true)}.`;
  $("#cf-split").setAttribute("aria-label", segs.map((s) => `${s.name} ${money(s.v)}`).join(", "));
  $("#cf-split").replaceChildren(
    ...segs.map((s) =>
      h("div", {
        title: `${s.name}: ${money(s.v)} (${pct(s.v / (t.takeHome || 1))})`,
        style: { flex: `${s.v / base} 0 0`, background: s.hatch ? `repeating-linear-gradient(45deg, ${cssVar("--danger")} 0 3px, transparent 3px 7px)` : s.c },
      }),
    ),
  );
  $("#cf-split-legend").replaceChildren(
    ...segs.map((s) => h("span", { class: "item" }, h("span", { class: "swatch", style: { background: s.hatch ? cssVar("--danger") : s.c } }), `${s.name} `, h("b", {}, money(s.v)), h("span", { class: "muted" }, ` ${pct(s.v / (t.takeHome || 1), 0)}`))),
  );

  // Item bar lists
  const list = (el, lines, color, of) => {
    const items = lines.filter((l) => l.amount > 0).sort((a, b) => b.amount - a.amount);
    const max = items[0]?.amount || 1;
    el.replaceChildren(...(items.length ? items.map((l) => barRow({ name: l.name || "Untitled", color, value: l.amount, frac: l.amount / max, sub: pct(l.amount / of, 0) })) : [h("div", { class: "empty" }, "Nothing here yet.")]));
  };
  list($("#cf-exp"), b.expenses, s2, t.takeHome || 1);
  list($("#cf-inv"), b.investments, s1, t.takeHome || 1);
  $("#cf-exp-sub").textContent = `${money(t.exp)} a month · ${money(t.exp * 12)} a year`;
  $("#cf-inv-sub").textContent = `${money(t.inv)} a month · ${money(t.inv * 12)} a year`;

  // Trend
  const bs = state.data.budgets;
  $("#cf-trend-card").hidden = bs.length < 2;
  if (bs.length >= 2) {
    const tt = bs.map(budgetTotals);
    const opts = baseOptions({ stacked: true });
    opts.plugins.tooltip.callbacks.footer = (items) => `Take-home ${money(tt[items[0].dataIndex].takeHome)}`;
    const ds = (label, key, c) => ({ label, data: tt.map((x) => Math.max(0, x[key])), backgroundColor: c, _key: c, borderColor: cssVar("--surface"), borderWidth: { top: 2 }, borderSkipped: "bottom", borderRadius: 2, maxBarThickness: 24 });
    drawChart("chart-cf-trend", { type: "bar", data: { labels: bs.map((x) => monthLabel(x.month)), datasets: [ds("Expenses", "exp", s2), ds("Investments & savings", "inv", s1), ds("Left over", "left", neutral)] }, options: opts });
  }

  if (editor) renderCfEditor(b);
}

function renderCfEditor(b) {
  const onChange = () => {
    renderCashflow({ editor: false });
    clearTimeout(renderCfEditor._t);
    renderCfEditor._t = setTimeout(() => persist(), 700);
  };
  $("#cf-editor").replaceChildren(
    ...CF_GROUPS.map((g) => {
      const wrap = h("div", { class: "cf-group" });
      const total = h("span", { class: "muted" });
      const refreshTotal = () => (total.textContent = money(sum(b[g.key].map((l) => l.amount))));
      const lines = h("div", {});
      const addLine = (l) => {
        const name = h("input", { value: l.name, placeholder: "Name", "aria-label": `${g.title} name`, oninput: (e) => ((l.name = e.target.value), onChange()) });
        const amt = h("input", {
          class: "amt",
          type: "text",
          inputmode: "decimal",
          value: l.amount ? String(l.amount) : "",
          placeholder: "0",
          "aria-label": `${l.name || g.title} amount`,
          oninput: (e) => {
            const v = parseAmount(e.target.value);
            e.target.setAttribute("aria-invalid", String(Number.isNaN(v)));
            if (Number.isNaN(v)) return;
            l.amount = v || 0;
            refreshTotal();
            onChange();
          },
        });
        const row = h("div", { class: "cf-line" }, name, amt, h("button", { class: "rm", type: "button", title: "Remove", "aria-label": `Remove ${l.name}`, onclick: () => { b[g.key].splice(b[g.key].indexOf(l), 1); row.remove(); refreshTotal(); onChange(); } }, "×"));
        lines.append(row);
        return name;
      };
      b[g.key].forEach(addLine);
      refreshTotal();
      wrap.append(
        h("h3", {}, h("span", {}, g.title), total),
        lines,
        h("button", { class: "btn ghost", type: "button", onclick: () => { const l = { name: "", amount: 0 }; b[g.key].push(l); addLine(l).focus(); } }, `+ ${g.add}`),
      );
      return wrap;
    }),
  );
}

async function newBudgetMonth() {
  const bs = state.data.budgets;
  const last = bs.at(-1);
  const month = last ? addMonths(last.month, 1) : thisMonth();
  const copy = last ? JSON.parse(JSON.stringify({ ...last, month })) : { month, income: [{ name: "Salary", amount: 0 }], deductions: [{ name: "CPF (employee)", amount: 0 }], expenses: [], investments: [] };
  bs.push(copy);
  state.ui.cfMonth = month;
  renderCashflow();
  toast(last ? `${monthLabel(month, true)} created from ${monthLabel(last.month, true)}` : "Month created");
  await persist();
}

async function deleteBudgetMonth() {
  const b = currentBudget();
  if (!b || !confirm(`Delete the ${monthLabel(b.month, true)} cash-flow plan?`)) return;
  state.data.budgets = state.data.budgets.filter((x) => x !== b);
  state.ui.cfMonth = null;
  renderCashflow();
  await persist();
}

/* =====================================================================
   Settings dialog
   ===================================================================== */
function openSettings() {
  const c = ghConfig();
  $("#gh-owner").value = c.owner;
  $("#gh-repo").value = c.repo;
  $("#gh-branch").value = c.branch;
  $("#gh-path").value = c.path;
  $("#gh-token").value = c.token;
  $("#gh-test-msg").textContent = "";
  $("#settings-unlocked").hidden = !state.data;
  if (state.data) renderAssetList();
  $$("#theme-seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeOpt === store.get(K.theme, "system"))));
  $("#settings-dialog").showModal();
}

function readGhForm() {
  return {
    owner: $("#gh-owner").value.trim(),
    repo: $("#gh-repo").value.trim(),
    branch: $("#gh-branch").value.trim() || "main",
    path: $("#gh-path").value.trim() || "data/portfolio.enc.json",
    token: $("#gh-token").value.trim(),
  };
}

function renderAssetList() {
  const assets = state.data.assets;
  const inUse = (id) => state.data.months.some((m) => m.values[id] != null);
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= assets.length) return;
    [assets[i], assets[j]] = [assets[j], assets[i]];
    changed();
  };
  const changed = () => {
    renderAssetList();
    renderAll();
    persist();
  };
  $("#asset-list").replaceChildren(
    ...assets.map((a, i) =>
      h(
        "div",
        { class: "asset-row" },
        h("span", { class: "swatch", style: { background: assetColor(a.id) } }),
        h("input", { value: a.name, "aria-label": "Asset name", onchange: (e) => ((a.name = e.target.value.trim() || a.name), changed()) }),
        h("label", { title: "Track purchase cost for gain/loss" }, h("input", { type: "checkbox", checked: a.costTracked, onchange: (e) => ((a.costTracked = e.target.checked), changed()) }), "cost"),
        h("label", { class: "mv", title: "Hide from the Add month form" }, h("input", { type: "checkbox", checked: !!a.archived, onchange: (e) => ((a.archived = e.target.checked), changed()) }), "hide"),
        h("button", { class: "btn mv", type: "button", "aria-label": `Move ${a.name} up`, onclick: () => move(i, -1) }, "↑"),
        inUse(a.id)
          ? h("button", { class: "btn", type: "button", "aria-label": `Move ${a.name} down`, onclick: () => move(i, 1) }, "↓")
          : h("button", { class: "btn danger", type: "button", title: "Remove (never used)", onclick: () => (assets.splice(i, 1), changed()) }, "✕"),
      ),
    ),
  );
}

function addAsset() {
  const name = $("#new-asset").value.trim();
  if (!name) return;
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "asset";
  while (state.data.assets.some((a) => a.id === id)) id += "_2";
  state.data.assets.push({ id, name, costTracked: true });
  $("#new-asset").value = "";
  renderAssetList();
  renderAll();
  persist();
}

async function changePassphrase() {
  const p1 = prompt("New passphrase (at least 8 characters):");
  if (p1 == null) return;
  if (p1.length < 8) return toast("Passphrase must be at least 8 characters");
  if (prompt("Repeat the new passphrase:") !== p1) return toast("Passphrases didn't match");
  state.pass = p1;
  store.set(K.pass, p1, sessionStorage);
  if (store.get(K.pass) != null) store.set(K.pass, p1);
  await persist();
  toast("Passphrase changed — use the new one on your other devices");
}

async function importFile(file) {
  try {
    const obj = JSON.parse(await file.text());
    let data = obj;
    let usedPass = state.pass;
    if (isEncrypted(obj)) {
      usedPass = state.pass || prompt("Passphrase for this file:");
      if (!usedPass) return;
      try {
        data = await decryptJSON(obj, usedPass);
      } catch {
        usedPass = prompt("That passphrase didn't work for this file. Passphrase for the file:");
        if (!usedPass) return;
        data = await decryptJSON(obj, usedPass);
      }
    }
    if (!Array.isArray(data.months)) throw new Error("Not a portfolio file");
    if (state.data && !confirm(`Replace your current data (${state.data.months.length} months) with this file (${data.months.length} months)?`)) return;
    if (!state.data) {
      // Imported from the lock screen: treat it as the copy to open.
      state.remote = { payload: isEncrypted(obj) ? obj : data, sha: state.remote?.sha ?? null, source: "import" };
      if (!isEncrypted(obj)) return showLock("create", `Loaded ${data.months.length} months. Choose a passphrase to encrypt them.`);
      await unlock(usedPass, false);
      return persist({ touch: false });
    }
    state.data = normalise(data);
    renderAll();
    await persist();
    $("#settings-dialog").close();
    toast("Imported");
  } catch (e) {
    toast(`Import failed: ${e.message}`);
  }
}

/* =====================================================================
   Theme
   ===================================================================== */
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  $$('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", dark ? "#0d0d0d" : "#f9f9f7"));
}

/* =====================================================================
   Wiring
   ===================================================================== */
function renderAll() {
  if (!state.data || typeof Chart === "undefined") return;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = cssVar("--ink-2");
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === state.ui.tab)));
  $("#tab-portfolio").hidden = state.ui.tab !== "portfolio";
  $("#tab-cashflow").hidden = state.ui.tab !== "cashflow";
  $("#btn-add-month").hidden = state.ui.tab !== "portfolio";
  // Charts in a hidden panel measure 0px, so only draw the visible tab.
  if (state.ui.tab === "portfolio") renderPortfolio();
  else renderCashflow();
}

function wireStatic() {
  $("#lock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pass = $("#lock-pass").value;
    const mode = $("#lock").dataset.mode;
    $("#lock-error").textContent = "";
    if (mode === "create") {
      if (pass.length < 8) return ($("#lock-error").textContent = "Use at least 8 characters.");
      if (pass !== $("#lock-pass2").value) return ($("#lock-error").textContent = "Passphrases don't match.");
    }
    const btn = $("#lock-form button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Unlocking…";
    try {
      await unlock(pass, $("#lock-remember").checked);
      $("#lock-pass").value = $("#lock-pass2").value = "";
    } catch (err) {
      $("#lock-error").textContent = err.message === "Wrong passphrase" ? "That passphrase didn't work." : err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = mode === "create" ? "Encrypt & open" : "Unlock";
    }
  });
  $("#lock-settings").addEventListener("click", openSettings);
  $("#lock-import").addEventListener("click", () => $("#file-input").click());

  $$(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      state.ui.tab = t.dataset.tab;
      saveUI();
      renderAll();
    }),
  );
  $$("#range button").forEach((b) =>
    b.addEventListener("click", () => {
      state.ui.range = Number(b.dataset.range);
      saveUI();
      renderPortfolio();
    }),
  );
  $$("#trend-mode button").forEach((b) =>
    b.addEventListener("click", () => {
      state.ui.trend = b.dataset.mode;
      saveUI();
      renderPortfolio();
    }),
  );
  $("#history-more").addEventListener("click", () => {
    state.ui.historyAll = !state.ui.historyAll;
    renderHistory(series());
  });

  $("#btn-add-month").addEventListener("click", () => openMonthDialog());
  $("#mf-month").addEventListener("change", buildMonthForm);
  $("#month-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveMonthForm();
  });
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $("#mf-delete").addEventListener("click", deleteMonth);

  $("#cf-month").addEventListener("change", (e) => {
    state.ui.cfMonth = e.target.value;
    renderCashflow();
  });
  $("#cf-new").addEventListener("click", newBudgetMonth);
  $("#cf-delete").addEventListener("click", deleteBudgetMonth);

  $("#btn-settings").addEventListener("click", openSettings);
  $("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const before = JSON.stringify(ghConfig());
    store.set(K.settings, readGhForm());
    $("#settings-dialog").close();
    // Opened from the lock screen: reload data from the newly configured repo.
    if (!state.data) return boot();
    if (JSON.stringify(ghConfig()) !== before && ghReady()) {
      try {
        state.sha = (await ghGet()).sha;
      } catch {}
      if (state.dirty) sync();
      else setSync("synced", "Connected to GitHub");
    }
  });
  $("#gh-test").addEventListener("click", async () => {
    const msg = $("#gh-test-msg");
    msg.className = "small muted";
    msg.textContent = "Checking…";
    try {
      const c = readGhForm();
      if (!c.owner || !c.repo || !c.token) throw new Error("Fill in owner, repository and token");
      const r = await ghGet(c);
      msg.className = "small up";
      msg.textContent = r.payload ? "Connected — data file found" : "Connected — the data file will be created on first save";
    } catch (err) {
      msg.className = "small down";
      msg.textContent = err.message;
    }
  });
  $("#add-asset").addEventListener("click", addAsset);
  $("#new-asset").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), addAsset()));
  $("#export-json").addEventListener("click", async () => download(`portfolio-${thisMonth()}.enc.json`, JSON.stringify(await encryptJSON(state.data, state.pass))));
  $("#export-plain").addEventListener("click", () => {
    if (confirm("This file is NOT encrypted. Keep it private and don't commit it. Continue?")) download(`portfolio-${thisMonth()}.json`, JSON.stringify(state.data, null, 1));
  });
  $("#import-json").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) importFile(f);
  });
  $("#change-pass").addEventListener("click", changePassphrase);
  $("#lock-now").addEventListener("click", () => {
    store.set(K.pass, null, sessionStorage);
    store.set(K.pass, null);
    location.reload();
  });
  $$("#theme-seg button").forEach((b) =>
    b.addEventListener("click", () => {
      store.set(K.theme, b.dataset.themeOpt);
      applyTheme(b.dataset.themeOpt);
      $$("#theme-seg button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      renderAll();
    }),
  );
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    applyTheme(store.get(K.theme, "system"));
    renderAll();
  });

  $("#sync-status").addEventListener("click", () => {
    if (!state.data) return;
    if (!ghReady()) return openSettings();
    if (state.dirty || $("#sync-status").dataset.state === "error") sync();
    else toast("Everything is saved to GitHub");
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty && ghReady()) e.preventDefault();
  });
  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 150);
  });
}

applyTheme(store.get(K.theme, "system"));
wireStatic();
boot();
