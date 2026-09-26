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
  ui: { tab: "portfolio", range: 36, trend: "total", alloc: "account", historyAll: false, cfMonth: null, ...store.get(K.ui, {}) },
};
const saveUI = () => store.set(K.ui, { tab: state.ui.tab, range: state.ui.range, trend: state.ui.trend, alloc: state.ui.alloc });

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
  if (!hasEncrypted) return showLock("create", "Choose a passphrase for this device. It locks the copy saved in this browser, and the GitHub copy too if you turn on sync.");

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
  state.data = normalise(useCache ? (remoteData ? mergeAdditions(cacheData, remoteData) : cacheData) : remoteData || emptyData());
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

/**
 * Local edits win, but pick up what the data file added since: new settings on
 * existing assets (DCA, account, units pricing), units/price on months whose value
 * is unchanged, and months after this device's latest month.
 */
function mergeAdditions(local, remote) {
  const assets = Object.fromEntries(local.assets.map((a) => [a.id, a]));
  for (const ra of remote.assets || []) {
    const la = assets[ra.id];
    if (!la) continue;
    for (const [k, v] of Object.entries(ra)) if (la[k] === undefined) la[k] = v;
  }
  // Cash-flow plans: add missing months; replace a plan the file has updated more recently.
  for (const rb of remote.budgets || []) {
    const i = (local.budgets ||= []).findIndex((b) => b.month === rb.month);
    if (i < 0) local.budgets.push(rb);
    else if ((rb.updatedAt || "") > (local.budgets[i].updatedAt || "")) local.budgets[i] = rb;
  }
  if (!local.loans?.length && remote.loans?.length) local.loans = remote.loans;
  for (const rl of remote.loans || []) {
    const ll = local.loans.find((l) => l.id === rl.id);
    if (ll) for (const [k, v] of Object.entries(rl)) if (ll[k] === undefined) ll[k] = v;
  }
  const byMonth = Object.fromEntries(local.months.map((m) => [m.month, m]));
  const latest = local.months.reduce((mx, m) => (m.month > mx ? m.month : mx), "");
  for (const rm of remote.months || []) {
    const lm = byMonth[rm.month];
    if (!lm) {
      if (rm.month > latest) local.months.push(rm);
      continue;
    }
    for (const [id, rec] of Object.entries(rm.loans || {})) if (!lm.loans?.[id]) (lm.loans ||= {})[id] = rec;
    if (rm.cpf && !lm.cpf) lm.cpf = rm.cpf;
    for (const id of Object.keys(rm.units || {})) {
      if (lm.units?.[id] == null && Math.abs((lm.values?.[id] ?? NaN) - rm.values[id]) < 0.02) {
        (lm.units ||= {})[id] = rm.units[id];
        (lm.price ||= {})[id] = rm.price?.[id];
      }
    }
  }
  return local;
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
  d.loans ||= [];
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

/**
 * Chart entities: an account group (e.g. all IBKR funds) or a standalone asset,
 * in asset-list order. Colour is fixed by entity position (colour follows the entity);
 * entities past the 7th share the "Other" colour.
 */
function entities() {
  const list = [];
  const byKey = {};
  for (const a of state.data.assets) {
    const key = a.group ? `g:${a.group}` : a.id;
    if (!byKey[key]) list.push((byKey[key] = { key, name: a.group || a.name, group: a.group || null, ids: [], index: list.length }));
    byKey[key].ids.push(a.id);
  }
  return list;
}
const entityColor = (e) => cssVar(`--s${e && e.index < 7 ? e.index + 1 : 8}`);
const assetColor = (id) => entityColor(entities().find((e) => e.ids.includes(id)));

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
  const full = fullNetWorth();
  $("#hero-full").replaceChildren(
    full.extra
      ? h(
          "div",
          {},
          h("span", { class: "muted" }, "Full net worth "),
          h("b", {}, money(full.total)),
          h("div", { class: "muted small" }, full.parts.join(" · ")),
        )
      : "",
  );

  // Tiles
  const tracked = Object.entries(last.m.values).filter(([id]) => amap[id]?.costTracked && last.m.invested?.[id] != null);
  const invested = sum(tracked.map(([id]) => last.m.invested[id]));
  const trackedValue = sum(tracked.map(([, v]) => v));
  const last12 = all.slice(-12);
  const passive12 = sum(last12.map((s) => s.passive));
  const tile = (label, value, sub, cls) => h("div", { class: `tile ${cls || ""}` }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);
  $("#tiles").replaceChildren(
    tile("Invested", money(invested), "Excludes cash & RSU"),
    tile("Total gain", h("span", { class: trackedValue - invested >= 0 ? "up" : "down" }, signed(trackedValue - invested)), signedPct((trackedValue - invested) / invested)),
    tile("Dividends & interest", money(passive12), "Last 12 months"),
  );

  renderTrend(view);
  renderChange(view);
  renderAllocation(last);
  renderHoldings(last, prev);
  renderPassive(view);
  renderCpf();
  renderLoans();
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
    $("#trend-sub").textContent = "Market value stacked by account or holding. Accounts like IBKR are one band; smaller ones past the 7th are grouped as Other.";
    const valueOf = (e, m) => sum(e.ids.map((id) => m.values[id]));
    const active = entities().filter((e) => view.some((s) => valueOf(e, s.m)));
    const main = active.filter((e) => e.index < 7);
    const other = active.filter((e) => e.index >= 7);
    const groups = main.map((e) => ({ label: e.name, color: entityColor(e), get: (m) => valueOf(e, m) }));
    if (other.length) groups.push({ label: "Other", color: cssVar("--s8"), get: (m) => sum(other.map((e) => valueOf(e, m))) });
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
  const byAccount = state.ui.alloc !== "holding";
  $$("#alloc-mode button").forEach((b) => b.setAttribute("aria-checked", String((b.dataset.alloc === "holding") !== byAccount)));
  const rows = (
    byAccount
      ? entities().map((e) => ({ name: e.name, color: entityColor(e), v: sum(e.ids.map((id) => last.m.values[id])) }))
      : Object.entries(last.m.values).map(([id, v]) => {
          const a = amap[id];
          return { name: a?.group ? `${a.name}` : a?.name || id, color: assetColor(id), v };
        })
  )
    .filter((r) => r.v > 0)
    .sort((a, b) => b.v - a.v);
  const max = rows[0]?.v || 1;
  $("#alloc-sub").textContent = `Share of ${money(t)} at ${monthLabel(last.month, true)}${byAccount ? "" : " · account colours"}.`;
  $("#alloc").replaceChildren(...rows.map((r) => barRow({ name: r.name, color: r.color, value: r.v, frac: r.v / max, right: pct(r.v / t), sub: compact(r.v) })));
}

function renderHoldings(last, prev) {
  const amap = assetMap();
  const est = new Set(last.m.estimated || []);
  const head = h("thead", {}, h("tr", {}, h("th", {}, "Asset"), ...["Value", "Invested", "Gain", "Gain %", "vs last month", "Share"].map((t) => h("th", { class: "num" }, t))));
  const cls = (g) => `num ${g == null ? "" : g >= 0 ? "up" : "down"}`;
  // One row of numbers; `inv`/`pv` null means "no cost basis" / "not held last month".
  const cells = (v, inv, pv) => {
    const g = inv != null ? v - inv : null;
    return [
      h("td", { class: "num" }, money(v)),
      h("td", { class: "num" }, inv != null ? money(inv) : "–"),
      h("td", { class: cls(g) }, g != null ? signed(g) : "–"),
      h("td", { class: cls(g) }, g != null && inv ? signedPct(g / inv) : "–"),
      h("td", { class: "num" }, pv != null ? signed(v - pv) : "new"),
      h("td", { class: "num" }, pct(v / last.total)),
    ];
  };
  const line = (id) => {
    const v = last.m.values[id];
    const a = amap[id] || { name: id };
    return { id, a, v, inv: a.costTracked ? last.m.invested?.[id] ?? null : null, pv: prev?.m.values[id] ?? null };
  };
  let tv = 0, ti = 0, tg = 0, tm = 0;
  const rows = [];
  const blocks = entities()
    .map((e) => ({ e, lines: e.ids.filter((id) => last.m.values[id]).map(line).sort((a, b) => b.v - a.v) }))
    .filter((b) => b.lines.length)
    .sort((a, b) => sum(b.lines.map((l) => l.v)) - sum(a.lines.map((l) => l.v)));
  for (const { e, lines } of blocks) {
    for (const l of lines) {
      tv += l.v;
      if (l.inv != null) (ti += l.inv), (tg += l.v - l.inv);
      if (l.pv != null) tm += l.v - l.pv;
    }
    const swatch = h("span", { class: "swatch", style: { background: entityColor(e) } });
    if (e.group) {
      // Account subtotal; its gain covers only the holdings that have a cost basis.
      const v = sum(lines.map((l) => l.v));
      const withCost = lines.filter((l) => l.inv != null);
      const inv = withCost.length ? sum(withCost.map((l) => l.inv)) + sum(lines.filter((l) => l.inv == null).map((l) => l.v)) : null;
      const pv = lines.some((l) => l.pv != null) ? sum(lines.map((l) => l.pv ?? 0)) : null;
      rows.push(h("tr", { class: "group-row" }, h("td", {}, h("div", { class: "asset-name" }, swatch, e.name, h("span", { class: "muted small" }, ` · ${lines.length} holdings`))), ...cells(v, inv, pv)));
      for (const l of lines) rows.push(h("tr", { class: "child-row" }, h("td", {}, h("div", { class: "asset-name" }, l.a.name, est.has(l.id) ? h("span", { class: "est", title: "Estimated" }, "~") : null)), ...cells(l.v, l.inv, l.pv)));
    } else {
      const l = lines[0];
      const u = last.m.units?.[l.id];
      const unitNote = u != null ? h("span", { class: "muted small" }, ` ${nf0.format(u)} × ${nf2.format(last.m.price?.[l.id])}${l.a.factor && l.a.factor !== 1 ? ` · after ${Math.round((1 - l.a.factor) * 100)}% tax` : ""}`) : null;
      rows.push(h("tr", {}, h("td", {}, h("div", { class: "asset-name" }, swatch, l.a.name, unitNote, est.has(l.id) ? h("span", { class: "est", title: "Estimated" }, "~") : null)), ...cells(l.v, l.inv, l.pv)));
    }
  }
  const body = h("tbody", {}, rows);
  const foot = h(
    "tfoot",
    {},
    h("tr", {}, h("td", {}, "Total"), h("td", { class: "num" }, money(tv)), h("td", { class: "num" }, money(ti)), h("td", { class: `num ${tg >= 0 ? "up" : "down"}` }, signed(tg)), h("td", { class: `num ${tg >= 0 ? "up" : "down"}` }, signedPct(tg / ti)), h("td", { class: "num" }, signed(tm)), h("td", { class: "num" }, "100%")),
  );
  $("#holdings").replaceChildren(head, body, foot);
}

/* CPF: tracked on its own (locked until retirement), not added to net worth. */
const CPF_ACCOUNTS = [
  { id: "oa", name: "Ordinary (OA)" },
  { id: "sa", name: "Special (SA)" },
  { id: "ma", name: "MediSave (MA)" },
];
const cpfTotal = (c) => sum(CPF_ACCOUNTS.map((a) => c?.[a.id]));

function renderCpf() {
  const recs = state.data.months.filter((m) => m.cpf).map((m) => ({ month: m.month, ...m.cpf }));
  $("#cpf-card").hidden = !recs.length;
  if (!recs.length) return;
  const last = recs.at(-1);
  const prev = recs.at(-2);
  const yearAgo = recs.find((r) => r.month === addMonths(last.month, -12));
  const tile = (label, value, sub) => h("div", { class: "tile" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);
  const delta = (a, b) => (b != null ? `${signed(a - b)} vs ${monthLabel(prev.month)}` : `as of ${monthLabel(last.month, true)}`);
  const tiles = h(
    "div",
    { class: "tiles" },
    tile("CPF total", money(cpfTotal(last)), yearAgo ? `${signed(cpfTotal(last) - cpfTotal(yearAgo))} in 12 months` : `as of ${monthLabel(last.month, true)}`),
    ...CPF_ACCOUNTS.map((a) => tile(a.name, money(last[a.id]), delta(last[a.id], prev?.[a.id]))),
  );
  const head = h("thead", {}, h("tr", {}, h("th", {}, "Month"), ...[...CPF_ACCOUNTS.map((a) => a.name), "Total"].map((t) => h("th", { class: "num" }, t))));
  const body = h(
    "tbody",
    {},
    [...recs].reverse().slice(0, 12).map((r) =>
      h("tr", {}, h("td", {}, monthLabel(r.month, true)), ...CPF_ACCOUNTS.map((a) => h("td", { class: "num" }, r[a.id] != null ? money(r[a.id]) : "–")), h("td", { class: "num" }, money(cpfTotal(r)))),
    ),
  );
  $("#cpf-body").replaceChildren(
    h("div", { class: "card-head" }, h("div", {}, h("h2", {}, "CPF"), h("p", { class: "muted small" }, "Not included in net worth. Update balances each month in + Add month."))),
    tiles,
    recs.length > 1 ? h("div", { class: "table-wrap loan-table" }, h("table", { class: "table" }, head, body)) : "",
  );
}

/* Loans: tracked on their own (balance, interest, repayments), not subtracted from net worth. */
function monthsUntil(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth();
}

/** Investments + CPF + property − loans, from the latest figures of each. */
function fullNetWorth() {
  const months = state.data.months;
  const inv = months.length ? total(months.at(-1)) : 0;
  const cpf = [...months].reverse().find((m) => m.cpf)?.cpf;
  const parts = [`investments ${compact(inv)}`];
  let t = inv, extra = false;
  if (cpf) (t += cpfTotal(cpf)), parts.push(`CPF ${compact(cpfTotal(cpf))}`), (extra = true);
  for (const loan of state.data.loans || []) {
    const bal = [...months].reverse().find((m) => m.loans?.[loan.id]?.balance != null)?.loans[loan.id].balance;
    const share = (loan.sharePct ?? 100) / 100;
    const yours = share < 1 ? " (your half)" : "";
    if (loan.propertyValue) (t += loan.propertyValue * share), parts.push(`flat${yours} ${compact(loan.propertyValue * share)}`), (extra = true);
    if (bal != null && loan.propertyValue) (t -= bal * share), parts.push(`loan${yours} −${compact(bal * share)}`);
  }
  return { total: t, parts, extra };
}

function renderLoans() {
  const loans = state.data.loans || [];
  const card = $("#loan-card");
  card.hidden = !loans.length;
  if (!loans.length) return;
  const months = state.data.months;
  const blocks = loans.map((loan) => {
    const recs = months.filter((m) => m.loans?.[loan.id]).map((m) => ({ month: m.month, ...m.loans[loan.id] }));
    const last = [...recs].reverse().find((r) => r.balance != null);
    const interest12 = sum(recs.slice(-12).map((r) => r.interest));
    const lockIn = loan.lockInEnds ? monthsUntil(loan.lockInEnds) : null;
    const share = (loan.sharePct ?? 100) / 100;
    const tile = (label, value, sub, cls) => h("div", { class: `tile ${cls || ""}` }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);
    const lockLabel = loan.lockInEnds ? new Date(loan.lockInEnds).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" }) : null;
    const tiles = h(
      "div",
      { class: "tiles" },
      tile("Outstanding", last ? money(last.balance) : "–", last ? (share < 1 ? `your ${Math.round(share * 100)}%: ${money(last.balance * share)}` : `as of ${monthLabel(last.month, true)}`) : "Add it in + Add month"),
      tile(
        "Interest rate",
        loan.rate != null ? `${loan.rate}%` : "–",
        lockLabel ? (lockIn < 0 ? `Lock-in ended ${lockLabel}` : `Lock-in ends ${lockLabel} · ${lockIn <= 0 ? "this month" : `in ${lockIn} mo`}`) : null,
        lockIn != null && lockIn >= 0 && lockIn <= 3 ? "warn" : "",
      ),
      tile("Monthly instalment", loan.instalment != null ? money(loan.instalment) : "–", [share < 1 && loan.instalment != null && `your share ${money(loan.instalment * share)}`, loan.paidFrom && `from ${loan.paidFrom}`, loan.dueDay && `due on the ${loan.dueDay}th`].filter(Boolean).join(" · ") || null),
      tile("Interest paid", money(interest12), recs.length >= 12 ? "last 12 months" : `last ${recs.length} month${recs.length === 1 ? "" : "s"}`),
      loan.propertyValue && last ? tile("Home equity", money(loan.propertyValue - last.balance), share < 1 ? `your ${Math.round(share * 100)}%: ${money((loan.propertyValue - last.balance) * share)}` : `${money(loan.propertyValue)} value − loan`) : null,
    );
    const head = h("thead", {}, h("tr", {}, h("th", {}, "Month"), ...["Balance", "Repaid", "Interest", "Principal paid"].map((t) => h("th", { class: "num" }, t))));
    const body = h(
      "tbody",
      {},
      [...recs].reverse().slice(0, 12).map((r) =>
        h(
          "tr",
          {},
          h("td", {}, monthLabel(r.month, true)),
          h("td", { class: "num" }, r.balance != null ? money(r.balance) : "–"),
          h("td", { class: "num" }, r.repaid != null ? money(r.repaid) : "–"),
          h("td", { class: "num" }, r.interest != null ? money(r.interest) : "–"),
          h("td", { class: "num" }, r.repaid != null && r.interest != null ? money(r.repaid - r.interest) : "–"),
        ),
      ),
    );
    return h(
      "div",
      { class: "loan-block" },
      h("div", { class: "card-head" }, h("div", {}, h("h2", {}, loan.name || "Loan"), h("p", { class: "muted small" }, loan.propertyValue ? "Counted in full net worth together with the property value. Update the balance each month in + Add month." : "Not subtracted from net worth. Update the balance each month in + Add month."))),
      tiles,
      recs.length ? h("div", { class: "table-wrap loan-table" }, h("table", { class: "table" }, head, body)) : null,
    );
  });
  $("#loan-body").replaceChildren(...blocks);
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
  let lastGroup = null;
  for (const a of state.data.assets) {
    if (a.archived && !src?.values[a.id]) continue;
    if (a.group && a.group !== lastGroup)
      body.append(
        h(
          "tr",
          { class: "group-row", "data-group": a.group },
          h("td", { colspan: "3" }, h("div", { class: "asset-name" }, h("span", { class: "swatch", style: { background: assetColor(a.id) } }), a.group, h("span", { class: "grp-added" }))),
        ),
      );
    lastGroup = a.group || null;
    const prevVal = prev?.values[a.id];
    const value = src ? src.values[a.id] : prevVal;
    let added = null;
    if (a.costTracked) {
      const prevInv = prev?.invested[a.id] ?? 0;
      if (src) added = src.invested[a.id] != null ? src.invested[a.id] - prevInv : null;
      else if (a.dca != null) added = a.dca; // default monthly amount (Settings → Assets)
      else if (prev?.invested[a.id] != null) added = prev.invested[a.id] - (prev2?.invested[a.id] ?? 0);
    }
    // Unit-priced holdings (e.g. RSUs): value = units × price × after-tax factor.
    const unitsMode = a.valuation === "units" && (src ? src.units?.[a.id] != null : true);
    const factor = a.factor ?? 1;
    const valInput = h("input", { type: "text", inputmode: "decimal", name: `v_${a.id}`, value: money2(value), placeholder: "0", readOnly: unitsMode, class: unitsMode ? "computed" : null, "aria-label": `${a.name} market value`, oninput: updateMonthTotal });
    const hint = h("div", { class: "hint" });
    const setHint = () => {
      const v = parseAmount(valInput.value);
      const tax = unitsMode && factor !== 1 ? ` · after ${Math.round((1 - factor) * 100)}% tax` : "";
      if (prevVal == null) hint.textContent = "new" + tax;
      else if (v == null || isNaN(v)) hint.textContent = `last ${compact(prevVal)}${tax}`;
      else hint.textContent = `last ${compact(prevVal)} · ${signedPct((v - prevVal) / prevVal)}${tax}`;
    };
    valInput.addEventListener("input", setHint);
    let unitInputs = null;
    if (unitsMode) {
      const from = src || prev;
      const recompute = () => {
        const u = parseAmount(uIn.value);
        const p = parseAmount(pIn.value);
        valInput.value = u != null && p != null && !isNaN(u) && !isNaN(p) ? money2(Math.round(u * p * factor * 100) / 100) : "";
        setHint();
        updateMonthTotal();
      };
      const uIn = h("input", { type: "text", inputmode: "decimal", name: `u_${a.id}`, value: from?.units?.[a.id] ?? "", placeholder: "Units", "aria-label": `${a.name} units`, oninput: recompute });
      const pIn = h("input", { type: "text", inputmode: "decimal", name: `pr_${a.id}`, value: from?.price?.[a.id] ?? "", placeholder: "Price", "aria-label": `${a.name} price per unit`, oninput: recompute });
      unitInputs = h("div", { class: "units-row" }, uIn, h("span", { class: "muted" }, "×"), pIn);
    }
    setHint();
    body.append(
      h(
        "tr",
        {},
        h("td", { class: a.group ? "child" : "" }, h("div", { class: "asset-name" }, a.group ? null : h("span", { class: "swatch", style: { background: assetColor(a.id) } }), a.name)),
        h("td", { "data-label": "Market value" }, unitInputs, valInput, hint),
        h("td", { "data-label": "Added this month" }, a.costTracked ? h("input", { type: "text", inputmode: "decimal", name: `c_${a.id}`, value: money2(added), placeholder: "0", "aria-label": `${a.name} added this month`, oninput: updateMonthTotal }) : h("div", { class: "hint" }, "no cost basis")),
      ),
    );
  }
  table.replaceChildren(head, body);

  $("#mf-passive").replaceChildren(
    ...state.data.passiveTypes.map((t) =>
      h("label", { class: "field" }, h("span", {}, t.name), h("input", { type: "text", inputmode: "decimal", name: `p_${t.id}`, value: money2(src?.passive?.[t.id]), placeholder: "0" })),
    ),
  );
  const lastCpf = [...state.data.months].reverse().find((m) => m.month < key && m.cpf)?.cpf;
  const curCpf = src ? src.cpf : lastCpf;
  $("#mf-cpf").replaceChildren(
    ...(state.data.months.some((m) => m.cpf)
      ? [
          h("h3", {}, "CPF balances"),
          h(
            "div",
            { class: "field-grid" },
            CPF_ACCOUNTS.map((a) =>
              h("label", { class: "field" }, h("span", {}, a.name), h("input", { type: "text", inputmode: "decimal", name: `cpf_${a.id}`, value: money2(curCpf?.[a.id]), placeholder: lastCpf?.[a.id] != null ? `last ${money(lastCpf[a.id])}` : "0" })),
            ),
          ),
        ]
      : []),
  );
  $("#mf-loans").replaceChildren(
    ...(state.data.loans || []).map((loan) => {
      const cur = src?.loans?.[loan.id];
      const prevBal = [...state.data.months].reverse().find((m) => m.month < key && m.loans?.[loan.id]?.balance != null)?.loans[loan.id].balance;
      const field = (label, name, value, hint) =>
        h("label", { class: "field" }, h("span", {}, label), h("input", { type: "text", inputmode: "decimal", name, value: money2(value), placeholder: hint || "0" }));
      return h(
        "div",
        {},
        h("h3", {}, loan.name || "Loan"),
        h(
          "div",
          { class: "field-grid" },
          field("Outstanding balance", `l_bal_${loan.id}`, cur?.balance, prevBal != null ? `last ${money(prevBal)}` : "from your bank app"),
          field("Interest charged", `l_int_${loan.id}`, cur?.interest),
          field(`Repaid${loan.paidFrom ? ` (${loan.paidFrom})` : ""}`, `l_rep_${loan.id}`, cur ? cur.repaid : loan.instalment),
        ),
      );
    }),
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
  // Money added = every holding's "added" + change in account cash (no-cost holdings inside
  // an account, e.g. IBKR cash). Standalone cash and RSUs aren't counted: their changes
  // are spending/saving or price moves, not investing.
  const addedFor = (assets) => {
    let add = 0;
    for (const a of assets) {
      const ci = $(`#mf-assets input[name="c_${a.id}"]`);
      const vi = $(`#mf-assets input[name="v_${a.id}"]`);
      if (ci) add += parseAmount(ci.value) || 0;
      else if (vi && !a.costTracked && a.group) add += (parseAmount(vi.value) || 0) - (prev?.values[a.id] ?? 0);
    }
    return add;
  };
  $$("#mf-assets tr.group-row").forEach((row) => {
    row.querySelector(".grp-added").textContent = `Added this month ${signed(addedFor(state.data.assets.filter((x) => x.group === row.dataset.group)))}`;
  });
  const addedAll = addedFor(state.data.assets);
  $("#mf-summary").textContent = `Added ${signed(addedAll)} · Total ${money(t)}`;
  const pt = prev ? total(prev) : null;
  $("#mf-total").replaceChildren(
    h("span", {}, "Added this month ", h("b", {}, signed(addedAll))),
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
    const ui = $(`#mf-assets input[name="u_${a.id}"]`);
    if (ui && v) {
      (m.units ||= {})[a.id] = parseAmount(ui.value);
      (m.price ||= {})[a.id] = parseAmount($(`#mf-assets input[name="pr_${a.id}"]`).value);
    }
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
  if ($("#mf-cpf input")) {
    const cpf = {};
    for (const a of CPF_ACCOUNTS) {
      const v = parseAmount($(`#mf-cpf input[name="cpf_${a.id}"]`).value);
      if (Number.isNaN(v)) bad = `CPF ${a.name}`;
      else if (v != null) cpf[a.id] = v;
    }
    if (Object.keys(cpf).length) m.cpf = cpf;
  } else if (existing?.cpf) m.cpf = existing.cpf;
  for (const loan of state.data.loans || []) {
    const f = (k) => parseAmount($(`#mf-loans input[name="l_${k}_${loan.id}"]`)?.value);
    const rec = { balance: f("bal"), interest: f("int"), repaid: f("rep") };
    if (Object.values(rec).some((v) => Number.isNaN(v))) bad = loan.name || "Loan";
    const clean = Object.fromEntries(Object.entries(rec).filter(([, v]) => v != null && !Number.isNaN(v)));
    if (Object.keys(clean).length) (m.loans ||= {})[loan.id] = clean;
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
    b.updatedAt = new Date().toISOString();
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
  const copy = last ? JSON.parse(JSON.stringify({ ...last, month, updatedAt: new Date().toISOString() })) : { month, income: [{ name: "Salary", amount: 0 }], deductions: [{ name: "CPF (employee)", amount: 0 }], expenses: [], investments: [] };
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
  if (state.data) renderAssetList(), renderLoanList();
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
        h("input", { class: "mv", value: a.group || "", placeholder: "Account", title: "Account (groups holdings, e.g. IBKR)", "aria-label": `${a.name} account`, onchange: (e) => ((a.group = e.target.value.trim() || undefined), changed()) }),
        h("label", { title: "Track purchase cost for gain/loss" }, h("input", { type: "checkbox", checked: a.costTracked, onchange: (e) => ((a.costTracked = e.target.checked), changed()) }), "cost"),
        h("input", {
          class: "mv dca",
          type: "text",
          inputmode: "decimal",
          value: a.dca != null ? String(a.dca) : "",
          placeholder: a.costTracked ? "DCA /mo" : "",
          disabled: !a.costTracked,
          title: "Default 'Added this month' for new months",
          "aria-label": `${a.name} default monthly amount`,
          onchange: (e) => {
            const v = parseAmount(e.target.value);
            if (Number.isNaN(v)) return toast("Not a number");
            if (v == null) delete a.dca;
            else a.dca = v;
            changed();
          },
        }),
        h(
          "label",
          { class: "mv", title: "Enter as units × price (value = units × price × (1 − tax))" },
          h("input", {
            type: "checkbox",
            checked: a.valuation === "units",
            onchange: (e) => {
              if (e.target.checked) a.valuation = "units";
              else delete a.valuation, delete a.factor;
              changed();
            },
          }),
          "units",
          a.valuation === "units"
            ? h("input", {
                class: "tax",
                type: "text",
                inputmode: "decimal",
                value: a.factor != null ? String(Math.round((1 - a.factor) * 1000) / 10) : "",
                placeholder: "tax %",
                title: "Tax / haircut % taken off units × price",
                "aria-label": `${a.name} tax percent`,
                onchange: (e) => {
                  const t = parseAmount(e.target.value);
                  if (Number.isNaN(t) || (t != null && (t < 0 || t >= 100))) return toast("Enter a % between 0 and 99");
                  if (t) a.factor = Math.round((1 - t / 100) * 10000) / 10000;
                  else delete a.factor;
                  changed();
                },
              })
            : null,
        ),
        h("label", { class: "mv", title: "Hide from the Add month form" }, h("input", { type: "checkbox", checked: !!a.archived, onchange: (e) => ((a.archived = e.target.checked), changed()) }), "hide"),
        h("button", { class: "btn mv", type: "button", "aria-label": `Move ${a.name} up`, onclick: () => move(i, -1) }, "↑"),
        inUse(a.id)
          ? h("button", { class: "btn", type: "button", "aria-label": `Move ${a.name} down`, onclick: () => move(i, 1) }, "↓")
          : h("button", { class: "btn danger", type: "button", title: "Remove (never used)", onclick: () => (assets.splice(i, 1), changed()) }, "✕"),
      ),
    ),
  );
}

function renderLoanList() {
  const loans = (state.data.loans ||= []);
  const changed = () => {
    renderAll();
    persist();
  };
  const num = (loan, key, label, width) =>
    h("label", { class: "field" }, h("span", {}, label), h("input", {
      type: "text",
      inputmode: "decimal",
      value: loan[key] ?? "",
      style: width ? { width } : null,
      onchange: (e) => {
        const v = parseAmount(e.target.value);
        if (Number.isNaN(v)) return toast("Not a number");
        if (v == null) delete loan[key];
        else loan[key] = v;
        changed();
      },
    }));
  $("#loan-list").replaceChildren(
    ...loans.map((loan, i) =>
      h(
        "div",
        { class: "loan-edit" },
        h("div", { class: "field-grid" },
          h("label", { class: "field" }, h("span", {}, "Name"), h("input", { value: loan.name || "", onchange: (e) => ((loan.name = e.target.value.trim() || "Loan"), changed()) })),
          num(loan, "rate", "Interest rate %"),
          num(loan, "instalment", "Monthly instalment"),
          num(loan, "dueDay", "Due day of month"),
          num(loan, "propertyValue", "Property value"),
          num(loan, "sharePct", "Your share %"),
          h("label", { class: "field" }, h("span", {}, "Lock-in ends"), h("input", { type: "date", value: loan.lockInEnds || "", onchange: (e) => ((loan.lockInEnds = e.target.value || undefined), changed()) })),
          h("label", { class: "field" }, h("span", {}, "Paid from"), h("input", { value: loan.paidFrom || "", placeholder: "CPF / cash", onchange: (e) => ((loan.paidFrom = e.target.value.trim() || undefined), changed()) })),
        ),
        h("button", {
          class: "btn ghost danger",
          type: "button",
          onclick: () => {
            if (!confirm(`Remove ${loan.name || "this loan"}? Its monthly history stays in your data but won't be shown.`)) return;
            loans.splice(i, 1);
            renderLoanList();
            changed();
          },
        }, "Remove loan"),
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
    // Non-destructive by default: Cancel keeps your data and only adds what's new in the file.
    const replace =
      state.data &&
      confirm(
        `Import ${data.months.length} months from this file.\n\n` +
          `OK — replace ALL your data (${state.data.months.length} months) with the file\n` +
          `Cancel — keep your data and just add what's new (settings, newer months, RSU units, updated cash-flow plans)`,
      );
    if (!state.data) {
      // Imported from the lock screen: treat it as the copy to open.
      state.remote = { payload: isEncrypted(obj) ? obj : data, sha: state.remote?.sha ?? null, source: "import" };
      if (!isEncrypted(obj)) return showLock("create", `Loaded ${data.months.length} months. Choose a passphrase to encrypt them.`);
      await unlock(usedPass, false);
      return persist({ touch: false });
    }
    state.data = normalise(replace ? data : mergeAdditions(state.data, data));
    renderAll();
    await persist();
    $("#settings-dialog").close();
    toast(replace ? "Replaced with the imported file" : "Added what's new from the file");
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
   Semi-retire planner (a calculator on the user's own numbers, not advice)
   ===================================================================== */
const INSURANCE_DEFAULTS = [
  ["Hospital plan", 1150],
  ["Term death & disability (group)", 216.48, 0, "Group cover usually ends when you leave your employer."],
  ["Accident (Aviva)", 12.84],
  ["Multi-critical illness", 920],
  ["Accident (Sompo)", 196.2],
  ["Term death & disability (individual)", 911.6],
  ["Dad's health insurance", 1150],
];

const PLAN_DEFAULTS = { partTime: 0, cpfInflow: 0, returnPct: 5, inflationPct: 2.5, age: 35, horizon: 40, cpfPayout: 0, includeRsu: true, buffer: 30000, rsuGrowthPct: 5, rsuLeaverPrice: true };

function defaultPlan() {
  const b = state.data.budgets.at(-1);
  const cut = { mum: 200, personal: 700, tax: 50 };
  const notes = { mum: "Parents' allowance reduced", personal: "Food & fun reduced", tax: "Much lower income tax on part-time pay" };
  const items = [];
  for (const l of b?.expenses || []) {
    if (!l.amount) continue;
    const key = Object.keys(cut).find((k) => l.name.toLowerCase().includes(k));
    items.push({ name: l.name, group: "Monthly spending", per: "mo", now: l.amount, semi: key ? cut[key] : l.amount, keep: true, note: key ? notes[key] : "" });
  }
  items.push({ name: "Travel", group: "Monthly spending", per: "yr", now: 5000, semi: 2500, keep: true, note: "Estimate — edit to your real yearly travel spend" });
  for (const [name, now, semi, note] of INSURANCE_DEFAULTS) items.push({ name, group: "Insurance (yearly premiums)", per: "yr", now, semi: semi ?? now, keep: true, note: note || "" });
  return { items, ...PLAN_DEFAULTS };
}

const monthly = (it, key) => (it.keep ? (it.per === "yr" ? it[key] / 12 : it[key]) : 0);

/** Latest buyback prices for a units-priced asset (e.g. RSUs): { current, former } in its own currency. */
function latestBuyback(asset) {
  const b = [...(asset?.buybacks || [])].sort((x, y) => x.when.localeCompare(y.when)).at(-1);
  return b || null;
}

function simulate(plan, returnPct) {
  const months = state.data.months;
  const last = months.at(-1);
  const units = state.data.assets.filter((a) => a.valuation === "units");
  const rsuNow = units.reduce((t, a) => t + (last?.values[a.id] || 0), 0);
  // Leaving the company: former-employee buyback price instead of the current-employee one.
  const lb = latestBuyback(units[0]);
  const leaver = plan.rsuLeaverPrice !== false && lb?.former && lb?.current ? lb.former / lb.current : 1;
  let rsu = plan.includeRsu ? rsuNow * leaver : 0;
  const investable = (last ? total(last) : 0) - rsuNow - (plan.buffer || 0);
  const cpf = [...months].reverse().find((m) => m.cpf)?.cpf || {};
  const loan = (state.data.loans || [])[0];
  const share = (loan?.sharePct ?? 100) / 100;
  let loanBal = (loan ? [...months].reverse().find((m) => m.loans?.[loan.id]?.balance != null)?.loans[loan.id].balance ?? 0 : 0) * share;
  const loanRate = (loan?.rate ?? 0) / 100;
  const instalment = (loan?.instalment ?? 0) * share;
  const r = returnPct / 100, inf = (plan.inflationPct || 0) / 100, rg = (plan.rsuGrowthPct ?? returnPct) / 100;
  const spendMo = sum(plan.items.map((it) => monthly(it, "semi")));
  const years = plan.age ? Math.max(1, 95 - plan.age) : plan.horizon || 40;
  let bal = investable, oa = cpf.oa || 0, depletedAt = null, oaOutYear = null, loanOffYear = null;
  const rows = [];
  for (let y = 0; y < years; y++) {
    const grow = (1 + inf) ** y;
    const spend = spendMo * 12 * grow;
    const income = (plan.partTime || 0) * 12 * grow + (plan.age && plan.age + y >= 65 ? (plan.cpfPayout || 0) * 12 : 0);
    const due = loanBal > 0 ? Math.min(instalment * 12, loanBal * (1 + loanRate)) : 0;
    loanBal = Math.max(0, loanBal * (1 + loanRate) - due);
    if (loanBal === 0 && due > 0 && loanOffYear == null) loanOffYear = y + 1;
    oa = oa * 1.025 + (plan.cpfInflow || 0) * 12;
    const fromOa = Math.min(oa, due);
    oa -= fromOa;
    const cashMortgage = due - fromOa;
    if (cashMortgage > 0 && oaOutYear == null) oaOutYear = y;
    const need = spend + cashMortgage - income;
    // Spend from investments first; sell RSUs at buyback only once those run out.
    bal = bal * (1 + r) - need;
    rsu *= 1 + rg;
    if (bal < 0) (rsu += bal), (bal = 0);
    if (rsu < 0 && depletedAt == null) depletedAt = y + 1;
    rows.push({ y, real: Math.max(bal + Math.max(rsu, 0), 0) / (1 + inf) ** (y + 1), need, cashMortgage });
  }
  const start = investable + (plan.includeRsu ? rsuNow * leaver : 0);
  return { investable: start, rsuStart: plan.includeRsu ? rsuNow * leaver : 0, leaver, spendMo, instalment, share, rows, depletedAt, oaOutYear, loanOffYear, years, oaStart: cpf.oa || 0 };
}

function rsuNote(plan) {
  const a = state.data.assets.find((x) => x.valuation === "units" && x.buybacks?.length);
  if (!a) return null;
  const b = [...a.buybacks].sort((x, y) => x.when.localeCompare(y.when));
  const first = b[0], last = b.at(-1);
  const yrs = (new Date(last.when + "-01") - new Date(first.when + "-01")) / (365.25 * 864e5);
  const cagr = yrs > 0 ? (last.current / first.current) ** (1 / yrs) - 1 : null;
  return h(
    "li",
    {},
    `${a.name} buyback price rose from US$${first.current} (${monthLabel(first.when)}) to US$${last.current} (${monthLabel(last.when)}), about ${pct(cagr, 0)} a year. ` +
      `If you leave, you get the former-employee price (US$${last.former}, ${pct(1 - last.former / last.current, 0)} lower)${plan.rsuLeaverPrice !== false ? ", which is what this plan uses" : ""}. ` +
      `The plan assumes ${plan.rsuGrowthPct}%/yr from here; past buyback growth isn't guaranteed.`,
  );
}

let retireSaveTimer;
function renderRetire({ table = true } = {}) {
  const plan = (state.data.plan ||= defaultPlan());
  for (const [k, v] of Object.entries(PLAN_DEFAULTS)) if (plan[k] === undefined) plan[k] = v;
  const save = () => {
    clearTimeout(retireSaveTimer);
    retireSaveTimer = setTimeout(() => persist(), 700);
  };
  const base = simulate(plan, plan.returnPct);
  const low = simulate(plan, plan.returnPct - 2);
  const nowMo = sum(plan.items.map((it) => (it.keep ? (it.per === "yr" ? it.now / 12 : it.now) : 0)));
  const yr1 = base.rows[0]?.need ?? 0;
  const afterOa = base.oaOutYear != null ? base.spendMo * 12 + base.instalment * 12 - (plan.partTime || 0) * 12 : null;
  const rate = (x) => (base.investable > 0 ? x / base.investable : Infinity);
  const needFor4 = Math.max(0, base.spendMo + base.instalment - (0.04 * base.investable) / 12);
  const lastsText = (sim) => (sim.depletedAt == null ? (plan.age ? "Lasts past age 95" : `Lasts ${sim.years}+ years`) : plan.age ? `Runs out around age ${plan.age + sim.depletedAt}` : `Runs out in ~${sim.depletedAt} years`);
  const tile = (label, value, sub, cls) => h("div", { class: `tile ${cls || ""}` }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);
  const rateCls = (x) => (x <= 0.04 ? "" : "warn");
  $("#rt-tiles").replaceChildren(
    tile("Semi-retired spending", `${money(base.spendMo)}/mo`, `vs ${money(nowMo)}/mo now`),
    tile("Invested money to draw on", money(base.investable), `after a ${money(plan.buffer || 0)} cash buffer${plan.includeRsu ? ` · RSU ${money(base.rsuStart)}${base.leaver < 1 ? " at leaver price" : ""}` : " · excl. RSU"}`),
    tile("Draw while CPF OA pays the loan", pct(rate(Math.max(0, yr1))), `${money(Math.max(0, yr1))}/yr · 4% is a common rule of thumb`, rateCls(rate(yr1))),
    afterOa != null ? tile("Draw once the loan moves to cash", pct(rate(afterOa)), `${money(afterOa)}/yr from year ${base.oaOutYear + 1}`, rateCls(rate(afterOa))) : "",
    tile(`At ${plan.returnPct}% return`, lastsText(base), `At ${plan.returnPct - 2}%: ${lastsText(low).toLowerCase()}`, base.depletedAt ? "warn" : ""),
    tile("Part-time income for a 4% draw", `${money(needFor4)}/mo`, "after the loan moves to cash"),
  );

  const labels = base.rows.map((r) => (plan.age ? `Age ${plan.age + r.y + 1}` : `Year ${r.y + 1}`));
  $("#rt-chart-sub").textContent = `Invested money in today's dollars, after spending and loan payments. ${plan.returnPct}% vs ${plan.returnPct - 2}% yearly return, ${plan.inflationPct}% inflation.`;
  const s1 = cssVar("--s1"), s2 = cssVar("--s2");
  const opts = baseOptions();
  drawChart("chart-retire", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: `${plan.returnPct}% return`, data: base.rows.map((r) => r.real), borderColor: s1, _key: s1, backgroundColor: alpha(s1, 0.1), fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 },
        { label: `${plan.returnPct - 2}% return`, data: low.rows.map((r) => r.real), borderColor: s2, _key: s2, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 },
      ],
    },
    options: opts,
  });

  const loan = (state.data.loans || [])[0];
  const oaMonths = base.instalment ? Math.floor(base.oaStart / Math.max(1, base.instalment - (plan.cpfInflow || 0))) : null;
  const group = plan.items.find((it) => /group/i.test(it.name));
  $("#rt-notes").replaceChildren(
    h(
      "ul",
      {},
      loan && base.share < 1 ? h("li", {}, `You pay ${Math.round(base.share * 100)}% of the mortgage: ${money(base.instalment)} of the ${money(loan.instalment)} instalment. Your wife pays the rest; if her situation changes, so does yours.`) : null,
      loan && oaMonths != null ? h("li", {}, `Your CPF OA (${money(base.oaStart)}) covers your ${money(base.instalment)} share for roughly ${oaMonths} months without new contributions. After that, the loan is paid from cash. That's the biggest jump in what you'd need.`) : null,
      base.loanOffYear ? h("li", {}, `At today's instalment and rate, the loan is paid off in about ${base.loanOffYear} years. The rate can change after your lock-in ends${loan?.lockInEnds ? ` (${loan.lockInEnds})` : ""}.`) : null,
      rsuNote(plan),
      h("li", {}, "Part-time work helps twice: it covers spending and adds CPF contributions to your OA, keeping the loan on CPF for longer."),
      group ? h("li", {}, "Group term cover is usually tied to your employer and ends when you leave, so it's set to S$0 here.") : null,
      h("li", {}, "Insurance: term life mainly protects people who depend on your income and any co-borrower on the loan. Critical illness pays a lump sum if you're diagnosed, which can matter more without a salary or sick leave. Cancelling is hard to undo: buying cover again later costs more and may exclude conditions. Worth reviewing with a licensed adviser before dropping either."),
      h("li", {}, "Not modelled: market ups and downs year to year, big one-off costs (renovation, medical, supporting parents more), CPF withdrawal rules. Keep a cash buffer for those."),
    ),
  );

  if (!table) return;
  // Assumptions
  const field = (label, key, { suffix, hint, int } = {}) =>
    h(
      "label",
      { class: "field" },
      h("span", {}, label),
      h("input", {
        type: "text",
        inputmode: "decimal",
        value: plan[key] ?? "",
        placeholder: hint || "",
        oninput: (e) => {
          const v = parseAmount(e.target.value);
          e.target.setAttribute("aria-invalid", String(Number.isNaN(v)));
          if (Number.isNaN(v)) return;
          plan[key] = v == null ? null : int ? Math.round(v) : v;
          renderRetire({ table: false });
          save();
        },
      }),
    );
  $("#rt-assumptions").replaceChildren(
    field("Part-time take-home (S$/mo)", "partTime", { hint: "0" }),
    field("CPF OA from part-time (S$/mo)", "cpfInflow", { hint: "0" }),
    field("Expected return (%/yr)", "returnPct"),
    field("Inflation (%/yr)", "inflationPct"),
    field("Cash buffer kept aside (S$)", "buffer"),
    field("Your age (optional)", "age", { hint: "e.g. 35", int: true }),
    field("CPF payout from 65 (S$/mo)", "cpfPayout", { hint: "check CPF LIFE estimator" }),
    field("Years to plan for (if no age)", "horizon", { int: true }),
    field("RSU growth (%/yr)", "rsuGrowthPct"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: plan.includeRsu, onchange: (e) => ((plan.includeRsu = e.target.checked), renderRetire({ table: false }), save()) }), "Count TikTok RSU as investable"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: plan.rsuLeaverPrice !== false, onchange: (e) => ((plan.rsuLeaverPrice = e.target.checked), renderRetire({ table: false }), save()) }), "Value RSU at former-employee buyback price"),
    h("button", { class: "btn ghost", type: "button", onclick: () => { if (confirm("Reset the semi-retire plan to the starting scenario?")) { state.data.plan = defaultPlan(); renderRetire(); save(); } } }, "Reset to starting scenario"),
  );

  // Spending table
  const head = h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Item"), h("th", { class: "num" }, "Now"), h("th", { class: "num" }, "Semi-retired"), h("th", { class: "num" }, "Per month")));
  const rows = [];
  let lastGroup = null;
  const perMo = new Map();
  for (const it of plan.items) {
    if (it.group !== lastGroup) rows.push(h("tr", { class: "group-row" }, h("td", { colspan: "5" }, it.group)));
    lastGroup = it.group;
    const pm = h("td", { class: "num" }, money(monthly(it, "semi")));
    perMo.set(it, pm);
    const inp = (key) =>
      h("input", {
        type: "text",
        inputmode: "decimal",
        value: it[key],
        "aria-label": `${it.name} ${key}`,
        oninput: (e) => {
          const v = parseAmount(e.target.value);
          e.target.setAttribute("aria-invalid", String(Number.isNaN(v)));
          if (Number.isNaN(v)) return;
          it[key] = v || 0;
          pm.textContent = money(monthly(it, "semi"));
          renderRetire({ table: false });
          save();
        },
      });
    rows.push(
      h(
        "tr",
        { class: it.keep ? "" : "dropped" },
        h("td", {}, h("input", { type: "checkbox", checked: it.keep, "aria-label": `Keep ${it.name}`, onchange: (e) => { it.keep = e.target.checked; e.target.closest("tr").classList.toggle("dropped", !it.keep); pm.textContent = money(monthly(it, "semi")); renderRetire({ table: false }); save(); } })),
        h("td", {}, h("div", {}, it.name, h("span", { class: "muted small" }, it.per === "yr" ? " · per year" : "")), it.note ? h("div", { class: "hint", style: { textAlign: "left" } }, it.note) : null),
        h("td", {}, inp("now")),
        h("td", {}, inp("semi")),
        pm,
      ),
    );
  }
  if (loan) rows.push(h("tr", { class: "group-row" }, h("td", { colspan: "5" }, "Housing")), h("tr", {}, h("td", {}), h("td", {}, h("div", {}, `${loan.name || "Loan"} instalment`), h("div", { class: "hint", style: { textAlign: "left" } }, "Paid from CPF OA until it runs low, then from cash (modelled above)")), h("td", { class: "num" }, money(base.instalment)), h("td", { class: "num" }, money(base.instalment)), h("td", { class: "num muted" }, base.share < 1 ? `your ${Math.round(base.share * 100)}%` : "CPF → cash")));
  $("#rt-spend").replaceChildren(head, h("tbody", {}, rows));
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
  $("#tab-retire").hidden = state.ui.tab !== "retire";
  $("#btn-add-month").hidden = state.ui.tab !== "portfolio";
  // Charts in a hidden panel measure 0px, so only draw the visible tab.
  if (state.ui.tab === "portfolio") renderPortfolio();
  else if (state.ui.tab === "retire") renderRetire();
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
  $$("#alloc-mode button").forEach((b) =>
    b.addEventListener("click", () => {
      state.ui.alloc = b.dataset.alloc;
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
  $("#add-loan").addEventListener("click", () => {
    const loans = (state.data.loans ||= []);
    let id = "loan";
    while (loans.some((l) => l.id === id)) id += "_2";
    loans.push({ id, name: loans.length ? "Loan" : "Home loan" });
    renderLoanList();
    renderAll();
    persist();
  });
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
