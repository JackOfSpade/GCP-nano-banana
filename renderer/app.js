// Nano Banana Pro — renderer (chat UI, drop-up settings).

const $ = (id) => document.getElementById(id);
const LS_SETTINGS = "nbp-settings-v3";
const LS_PRESETS  = "nbp-presets-v3";
const MAX_REFS = 14;

// Friendly names for model IDs. Fallback to the raw ID if unknown.
const MODEL_DISPLAY_NAMES = {
  "gemini-3-pro-image-preview": "Nano Banana Pro",
};
const modelDisplay = (id) => MODEL_DISPLAY_NAMES[id] || id;

const VALUE_FIELDS = {
  model: "gemini-3-pro-image-preview",
  output_mime_type: "image/png",
  person_generation: "ALLOW_ALL",
  prominent_people: "",
  output_compression_quality: "",
  media_resolution: "",
  temperature: 1,
  top_p: 0.95,
  top_k: "",
  seed: "",
  candidate_count: 1,
  max_output_tokens: 32768,
  presence_penalty: "",
  frequency_penalty: "",
  stop_sequences: "",
  logprobs: "",
  system_instruction: "",
};
const CHECK_FIELDS = {
  response_logprobs: false,
  google_search: false,
  stream: true,
};
const DEFAULT_MODALITIES = ["TEXT", "IMAGE"];
const DEFAULTS = {
  ...VALUE_FIELDS,
  ...CHECK_FIELDS,
  aspect_ratio: "auto",
  image_size: "1K",
  modalities: DEFAULT_MODALITIES.slice(),
  safety: {},
};

const state = {
  options: null,
  refs: [],            // pending references for next send: [{ name, mime, dataUrl, dataB64, width, height }]
  modalities: DEFAULT_MODALITIES.slice(),
  aspect: "auto",
  imageSize: "1K",
  chats: [],           // [{ id, title, turns, createdAt, updatedAt }]
  currentChatId: null,
  currentStreamId: null,
  cancelled: false,
  busy: false,
  lastPrompt: "",
  lastError: null,
  session: { tokens: 0, count: 0 },
  openPopup: null,
  chatSearch: "",
};

// =====================================================================
// EventLogger — ring-buffer for the bug reporter (500 KB cap).
// =====================================================================
const EventLogger = (() => {
  const MAX_BYTES = 500 * 1024;
  const logs = [];
  let bytes = 0, lastMsg = null, lastCount = 0;

  function safe(o) {
    if (o instanceof Error) return o.message;
    if (typeof o !== "object" || o === null) return String(o);
    try { return JSON.stringify(o); } catch { return "[unserializable]"; }
  }

  function log(message) {
    const now = new Date();
    const hms = now.toLocaleTimeString("en-US", { hour12: false });
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    if (lastMsg === message) {
      lastCount++;
      if (logs.length) {
        const prev = logs[logs.length - 1];
        const updated = prev.replace(/ \(×\d+\)$/, "") + ` (×${lastCount})`;
        bytes -= prev.length;
        logs[logs.length - 1] = updated;
        bytes += updated.length;
      }
      return;
    }
    lastMsg = message; lastCount = 1;
    const entry = `[${hms}.${ms}] ${message}`;
    logs.push(entry);
    bytes += entry.length;
    while (bytes > MAX_BYTES && logs.length) bytes -= logs.shift().length;
  }

  function error(message, ...args) {
    const extras = args.length ? " " + args.map(safe).join(" ") : "";
    const text = `ERROR: ${message}${extras}`;
    log(text);
    state.lastError = { message: `${message}${extras}`, ts: new Date().toISOString() };
  }

  window.addEventListener("error", (e) => {
    const loc = e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : "";
    error(`JS-ERROR: ${e?.message || String(e)}${loc}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    error(`UNHANDLED-PROMISE: ${e.reason?.message || String(e.reason) || "unknown"}`);
  });
  const origErr = console.error;
  console.error = (...a) => { log(`CONSOLE-ERROR: ${a.map(safe).join(" ")}`); origErr.apply(console, a); };
  const origWarn = console.warn;
  console.warn = (...a) => { log(`CONSOLE-WARN: ${a.map(safe).join(" ")}`); origWarn.apply(console, a); };

  log("Application started");
  return { log, error, getLogs: () => logs.slice() };
})();

// =====================================================================
// Bootstrap
// =====================================================================
async function init() {
  state.options = await window.api.getOptions();
  await loadChatsFromDisk();
  buildAuthPill();
  buildModelPopup();
  buildAspectPopup();
  buildSizePopup();
  buildSettingsPopup();
  bindEvents();
  loadSettings();
  renderChatList();
  renderConversation();
  refreshComposerChips();
  refreshModelChip();
}

// =====================================================================
// Auth & header
// =====================================================================
function buildAuthPill() {
  const el = $("auth-mode");
  const m = state.options.auth_mode;
  el.classList.remove("ok", "warn");
  if (m === "api_key") { el.textContent = "API key"; el.classList.add("ok"); }
  else if (m === "adc") { el.textContent = "ADC"; el.classList.add("ok"); }
  else { el.textContent = "no creds"; el.classList.add("warn"); }
  el.title = `Auth mode: ${m}`;
  EventLogger.log(`Auth mode: ${m}`);
}

// =====================================================================
// Settings popup — build static control sets
// =====================================================================
function fillSelect(el, values, { keepFirst = false } = {}) {
  if (!keepFirst) el.innerHTML = "";
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v;
    el.appendChild(opt);
  }
}

function buildSettingsPopup() {
  const o = state.options;
  fillSelect($("output_mime_type"), o.mime_types);
  fillSelect($("person_generation"), o.person_generation);
  fillSelect($("prominent_people"), o.prominent_people || [], { keepFirst: true });
  fillSelect($("media_resolution"), o.media_resolutions || [], { keepFirst: true });

  // Response modalities chips
  const wrap = $("response_modalities");
  wrap.innerHTML = "";
  for (const m of o.response_modalities) {
    const c = document.createElement("span");
    c.className = "tagchip" + (state.modalities.includes(m) ? " active" : "");
    c.textContent = m;
    c.dataset.value = m;
    c.onclick = () => {
      c.classList.toggle("active");
      state.modalities = state.modalities.includes(m)
        ? state.modalities.filter((x) => x !== m)
        : [...state.modalities, m];
      saveSettings();
    };
    wrap.appendChild(c);
  }

  // Safety grid (header + per-category dropdowns)
  const sg = $("safety-grid");
  sg.innerHTML = "";
  const h1 = document.createElement("div");
  h1.className = "head"; h1.textContent = "Category";
  const h2 = document.createElement("div");
  h2.className = "head"; h2.textContent = "Threshold";
  sg.appendChild(h1); sg.appendChild(h2);
  for (const cat of o.harm_categories) {
    const lab = document.createElement("div");
    lab.className = "cat";
    lab.textContent = cat.replace("HARM_CATEGORY_", "").replaceAll("_", " ");
    sg.appendChild(lab);

    const sel = document.createElement("select");
    sel.id = `safety_${cat}`;
    for (const t of o.safety_thresholds) {
      const opt = document.createElement("option");
      opt.value = t; opt.textContent = t;
      sel.appendChild(opt);
    }
    sel.value = "OFF";
    sel.addEventListener("change", saveSettings);
    sg.appendChild(sel);
  }

  // Tabs
  for (const tab of document.querySelectorAll(".popup-tab")) {
    tab.addEventListener("click", () => {
      for (const t of document.querySelectorAll(".popup-tab")) t.classList.toggle("active", t === tab);
      for (const s of document.querySelectorAll("#settings-popup .popup-section")) {
        s.hidden = s.dataset.section !== tab.dataset.tab;
      }
    });
  }
}

function buildModelPopup() {
  const wrap = $("model-list");
  wrap.innerHTML = "";
  for (const id of state.options.models) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.value = id;
    const nameDiv = document.createElement("div");
    nameDiv.className = "row-name";
    nameDiv.textContent = modelDisplay(id);
    const idDiv = document.createElement("div");
    idDiv.className = "row-id";
    idDiv.textContent = id;
    b.appendChild(nameDiv);
    b.appendChild(idDiv);
    b.onclick = () => {
      $("model").value = id;
      saveSettings();
      refreshModelChip();
      paintModelActive();
      closePopup();
    };
    wrap.appendChild(b);
  }
}

function paintModelActive() {
  const cur = $("model").value;
  for (const b of document.querySelectorAll("#model-list button")) {
    b.classList.toggle("active", b.dataset.value === cur);
  }
}

function refreshModelChip() {
  $("model-chip-label").textContent = modelDisplay($("model").value);
}

function buildAspectPopup() {
  const ag = $("aspect-grid");
  ag.innerHTML = "";
  for (const ar of state.options.aspect_ratios) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "aspect-tile";
    tile.dataset.value = ar;
    if (ar === "auto") {
      tile.classList.add("auto");
      tile.innerHTML = `<span class="shape" style="width: 60%; aspect-ratio: 1;"></span><span class="label">auto</span>`;
    } else {
      const [w, h] = ar.split(":").map(Number);
      const wPct = w >= h ? 90 : (w / h) * 90;
      const hPct = h >= w ? 60 : (h / w) * 60;
      tile.innerHTML = `<span class="shape" style="width: ${wPct}%; height: ${hPct}%;"></span><span class="label">${ar}</span>`;
    }
    tile.onclick = () => {
      state.aspect = ar;
      saveSettings();
      refreshComposerChips();
      paintAspectActive();
      closePopup();
    };
    ag.appendChild(tile);
  }
}

function paintAspectActive() {
  for (const t of document.querySelectorAll(".aspect-tile")) {
    t.classList.toggle("active", t.dataset.value === state.aspect);
  }
}

function buildSizePopup() {
  const wrap = $("size-list");
  wrap.innerHTML = "";
  for (const s of state.options.image_sizes) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s;
    b.dataset.value = s;
    b.onclick = () => {
      state.imageSize = s;
      saveSettings();
      refreshComposerChips();
      paintSizeActive();
      closePopup();
    };
    wrap.appendChild(b);
  }
}

function paintSizeActive() {
  for (const b of document.querySelectorAll("#size-list button")) {
    b.classList.toggle("active", b.dataset.value === state.imageSize);
  }
}

function refreshComposerChips() {
  $("aspect-chip-label").textContent = state.aspect;
  $("size-chip-label").textContent = state.imageSize;
}

// =====================================================================
// Settings persistence
// =====================================================================
function readSettings() {
  const s = {
    aspect_ratio: state.aspect,
    image_size: state.imageSize,
    modalities: state.modalities.slice(),
    safety: {},
  };
  for (const id of Object.keys(VALUE_FIELDS)) {
    const el = $(id); if (el) s[id] = el.value;
  }
  for (const id of Object.keys(CHECK_FIELDS)) {
    const el = $(id); if (el) s[id] = el.checked;
  }
  for (const cat of (state.options?.harm_categories || [])) {
    const sel = $(`safety_${cat}`);
    if (sel) s.safety[cat] = sel.value;
  }
  return s;
}

function applySettings(s) {
  if (!s) return;
  state.aspect = s.aspect_ratio ?? DEFAULTS.aspect_ratio;
  state.imageSize = s.image_size ?? DEFAULTS.image_size;
  for (const [id, def] of Object.entries(VALUE_FIELDS)) {
    const el = $(id); if (el) el.value = s[id] ?? def;
  }
  for (const [id, def] of Object.entries(CHECK_FIELDS)) {
    const el = $(id); if (el) el.checked = s[id] ?? def;
  }
  $("temp-val").textContent = parseFloat($("temperature").value).toFixed(2);
  $("topp-val").textContent = parseFloat($("top_p").value).toFixed(2);
  state.modalities = (s.modalities && s.modalities.length) ? s.modalities.slice() : DEFAULT_MODALITIES.slice();
  for (const chip of document.querySelectorAll("#response_modalities .tagchip")) {
    chip.classList.toggle("active", state.modalities.includes(chip.dataset.value));
  }
  for (const cat of (state.options?.harm_categories || [])) {
    const sel = $(`safety_${cat}`);
    if (sel) sel.value = s.safety?.[cat] ?? "OFF";
  }
  paintAspectActive();
  paintSizeActive();
  refreshComposerChips();
  refreshModelChip();
}

function saveSettings() {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(readSettings())); } catch {}
}
function loadSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LS_SETTINGS) || "null"); } catch {}
  applySettings(s || DEFAULTS);
}
function resetDefaults() {
  applySettings(DEFAULTS);
  saveSettings();
  EventLogger.log("Settings reset to defaults");
}

// =====================================================================
// Presets
// =====================================================================
function getPresets() { try { return JSON.parse(localStorage.getItem(LS_PRESETS) || "{}"); } catch { return {}; } }
function setPresets(p) { localStorage.setItem(LS_PRESETS, JSON.stringify(p)); }
function renderPresetList() {
  const sel = $("preset-select");
  const cur = sel.value;
  sel.innerHTML = '<option value="">(no preset)</option>';
  const presets = getPresets();
  for (const name of Object.keys(presets).sort()) {
    const opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = cur in presets ? cur : "";
}
function savePreset() {
  openModal({
    title: "Save preset",
    body: `<label><span>Name</span><input id="preset-name" type="text" placeholder="e.g. cinematic-pro" /></label>`,
    confirmLabel: "Save",
    onConfirm: () => {
      const name = $("preset-name").value.trim();
      if (!name) return false;
      const presets = getPresets();
      presets[name] = readSettings();
      setPresets(presets);
      renderPresetList();
      $("preset-select").value = name;
      EventLogger.log(`Preset saved: ${name}`);
      return true;
    },
  });
  setTimeout(() => $("preset-name")?.focus(), 50);
}
function loadPreset() {
  const name = $("preset-select").value;
  if (!name) return;
  const presets = getPresets();
  if (presets[name]) {
    applySettings(presets[name]);
    saveSettings();
    EventLogger.log(`Preset loaded: ${name}`);
  }
}
function deletePreset() {
  const name = $("preset-select").value;
  if (!name) return;
  if (!confirm(`Delete preset "${name}"?`)) return;
  const presets = getPresets();
  delete presets[name];
  setPresets(presets);
  renderPresetList();
  EventLogger.log(`Preset deleted: ${name}`);
}

// =====================================================================
// Chats — model & disk persistence
// =====================================================================
function newChatId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

async function loadChatsFromDisk() {
  try {
    const res = await window.api.loadChats();
    if (res?.data) {
      state.chats = res.data.chats || [];
      state.currentChatId = res.data.currentChatId || null;
    }
  } catch (e) { EventLogger.error("Load chats failed:", e); }
}

// Fire-and-forget save. Was previously debounced 250ms, but persistChats is
// only called on user actions and at start/end of generation (never during
// streaming) — debouncing added no batching benefit and risked losing data
// if the window closed inside the debounce window.
function persistChats() {
  window.api.saveChats({ chats: state.chats, currentChatId: state.currentChatId })
    .catch(e => EventLogger.error("Save chats failed:", e));
}

// While generation is in progress, mutating the current chat (switch, new,
// delete) would orphan the live streaming UI. Block these actions and flash
// the Stop button to direct the user toward cancellation.
function isBusyAction() {
  if (!state.busy) return false;
  const stop = $("stop");
  if (stop) {
    stop.classList.add("flash");
    setTimeout(() => stop.classList.remove("flash"), 600);
  }
  EventLogger.log("Action blocked: generation in progress");
  return true;
}

function currentChat() {
  return state.chats.find(c => c.id === state.currentChatId) || null;
}

function ensureCurrentChat(prompt) {
  let chat = currentChat();
  if (chat) return chat;
  chat = {
    id: newChatId(),
    title: titleFromPrompt(prompt),
    turns: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.chats.unshift(chat);
  state.currentChatId = chat.id;
  return chat;
}

function titleFromPrompt(p) {
  const t = (p || "").trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  return t.length > 48 ? t.slice(0, 48) + "…" : t;
}

function startNewChat() {
  if (isBusyAction()) return;
  state.currentChatId = null;
  state.refs = [];
  state.lastPrompt = "";
  $("prompt").value = "";
  renderRefStrip();
  renderConversation();
  renderChatList();
  persistChats();
  EventLogger.log("New chat");
}

function switchChat(id) {
  if (id === state.currentChatId) return;
  if (isBusyAction()) return;
  state.currentChatId = id;
  state.refs = [];
  $("prompt").value = "";
  renderRefStrip();
  renderConversation();
  renderChatList();
  persistChats();
  EventLogger.log(`Switched chat: ${id}`);
}

function deleteChat(id) {
  const chat = state.chats.find(c => c.id === id);
  if (!chat) return;
  // Deleting non-current chats is harmless during streaming; only block when
  // the deletion target is the chat being streamed (i.e. the current chat).
  if (state.currentChatId === id && isBusyAction()) return;
  if (!confirm(`Delete chat "${chat.title}"?`)) return;
  state.chats = state.chats.filter(c => c.id !== id);
  if (state.currentChatId === id) {
    state.currentChatId = null;
    state.refs = [];
    renderRefStrip();
    renderConversation();
  }
  renderChatList();
  persistChats();
  EventLogger.log(`Chat deleted: ${id}`);
}

// =====================================================================
// Sidebar render
// =====================================================================
function groupByRecency(chats, now = Date.now()) {
  const t = new Date(now);
  const startOfToday = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const sevenDaysAgo = startOfToday - 7 * 86400000;
  const groups = { Today: [], Yesterday: [], "Last 7 days": [], Older: [] };
  for (const c of chats) {
    if (c.updatedAt >= startOfToday) groups.Today.push(c);
    else if (c.updatedAt >= startOfYesterday) groups.Yesterday.push(c);
    else if (c.updatedAt >= sevenDaysAgo) groups["Last 7 days"].push(c);
    else groups.Older.push(c);
  }
  return groups;
}

function buildChatItem(c) {
  const item = document.createElement("div");
  item.className = "chat-item" + (c.id === state.currentChatId ? " active" : "");
  item.title = `${c.title}\n(double-click to rename)`;
  item.textContent = c.title;
  item.onclick = () => switchChat(c.id);
  item.ondblclick = (e) => { e.stopPropagation(); beginRenameChat(c.id, item); };
  const del = document.createElement("button");
  del.className = "del"; del.textContent = "×"; del.title = "Delete chat";
  del.onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };
  item.appendChild(del);
  return item;
}

function renderChatList() {
  const wrap = $("chat-list");
  wrap.innerHTML = "";

  const q = state.chatSearch.trim().toLowerCase();
  const filtered = q
    ? state.chats.filter(c => (c.title || "").toLowerCase().includes(q))
    : state.chats;

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "chat-list-empty";
    empty.textContent = q ? `No chats matching "${state.chatSearch}"` : "No chats yet";
    wrap.appendChild(empty);
    return;
  }

  const sorted = filtered.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = groupByRecency(sorted);
  for (const [name, items] of Object.entries(groups)) {
    if (!items.length) continue;
    const h = document.createElement("div");
    h.className = "chat-group"; h.textContent = name;
    wrap.appendChild(h);
    for (const c of items) wrap.appendChild(buildChatItem(c));
  }
}

function beginRenameChat(id, itemEl) {
  const chat = state.chats.find(c => c.id === id);
  if (!chat) return;
  const oldTitle = chat.title;
  itemEl.innerHTML = "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = oldTitle;
  input.onclick = (e) => e.stopPropagation();
  itemEl.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    const v = input.value.trim();
    chat.title = v || oldTitle;
    chat.updatedAt = Date.now();
    persistChats();
    renderChatList();
    EventLogger.log(`Chat renamed: ${id} → ${chat.title}`);
  };
  const cancel = () => { renderChatList(); };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", commit);
}

// =====================================================================
// Conversation render — turn builders are pure DOM creators, callable for
// both full re-render and the stream-end live-node replacement.
// =====================================================================
function partsTextAndImages(parts) {
  const list = parts || [];
  const text = list.filter(p => p.text).map(p => p.text).join("");
  const images = list.filter(p => p.inlineData?.data).map(p => p.inlineData);
  return { text, images };
}

function buildTurnRoot(role, label) {
  const block = document.createElement("div");
  block.className = "turn " + (role === "user" ? "turn-user" : "turn-assistant");
  const roleLabel = document.createElement("div");
  roleLabel.className = "turn-role";
  roleLabel.textContent = label;
  block.appendChild(roleLabel);
  return block;
}

function buildSmallImageStrip(images) {
  const strip = document.createElement("div");
  strip.className = "turn-images-strip";
  for (const im of images) {
    const t = document.createElement("div");
    t.className = "ref-thumb-sm";
    const src = `data:${im.mimeType};base64,${im.data}`;
    const img = document.createElement("img");
    img.src = src;
    t.appendChild(img);
    t.onclick = () => openLightbox(src, im.mimeType);
    strip.appendChild(t);
  }
  return strip;
}

function buildTurnText(text, isAssistant) {
  const tx = document.createElement("div");
  tx.className = isAssistant ? "turn-text assistant" : "turn-text";
  tx.textContent = text;
  return tx;
}

function buildTurnGrounding(items) {
  const g = document.createElement("div");
  g.className = "turn-grounding";
  const h = document.createElement("div");
  h.className = "grounding-head";
  h.textContent = "Grounding sources:";
  const ul = document.createElement("ul");
  for (const s of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = s.uri || "#"; a.target = "_blank"; a.rel = "noopener";
    a.textContent = s.title || s.uri || "(unnamed)";
    li.appendChild(a);
    ul.appendChild(li);
  }
  g.appendChild(h); g.appendChild(ul);
  return g;
}

function buildTurnMeta(meta) {
  const m = document.createElement("div");
  m.className = "turn-meta";
  const u = meta.usage || {};
  const pills = [];
  if (meta.elapsedMs != null) pills.push(`${(meta.elapsedMs / 1000).toFixed(1)}s`);
  if (u.totalTokenCount != null) pills.push(`${u.totalTokenCount} tok`);
  if (meta.finishReason) pills.push(meta.finishReason);
  for (const p of pills) {
    const sp = document.createElement("span"); sp.className = "pill"; sp.textContent = p;
    m.appendChild(sp);
  }
  return m;
}

function buildErrorLine(text) {
  const e = document.createElement("div");
  e.className = "error-line";
  e.textContent = text;
  return e;
}

function buildUserTurn(turn, idx) {
  const block = buildTurnRoot("user", "you");
  const { text, images } = partsTextAndImages(turn.parts);
  if (images.length) block.appendChild(buildSmallImageStrip(images));
  if (text)          block.appendChild(buildTurnText(text, false));

  // Edit affordance lives at the end of the user turn so it can sit below the
  // right-aligned bubble on hover without crowding the bubble itself.
  const editBtn = document.createElement("button");
  editBtn.className = "edit-btn";
  editBtn.textContent = "✎ Edit";
  editBtn.title = "Edit and resend (truncates the chat at this turn)";
  editBtn.onclick = () => editUserTurn(idx);
  block.appendChild(editBtn);
  return block;
}

function buildAssistantTurn(turn, idx) {
  const label = modelDisplay(turn.model || $("model").value);
  const block = buildTurnRoot("model", label);
  const { text, images } = partsTextAndImages(turn.parts);
  if (turn.error)       block.appendChild(buildErrorLine(turn.error));
  if (images.length) {
    const grid = document.createElement("div");
    grid.className = "turn-images-grid";
    for (const im of images) buildGenCard(im, grid);
    block.appendChild(grid);
  }
  if (text)             block.appendChild(buildTurnText(text, true));
  if (turn.grounding?.length) block.appendChild(buildTurnGrounding(turn.grounding));
  if (turn.meta)        block.appendChild(buildTurnMeta(turn.meta));

  const actions = document.createElement("div");
  actions.className = "turn-actions";
  const regen = document.createElement("button");
  regen.textContent = "↻ Regenerate";
  regen.title = "Re-run the previous user turn with a new random seed";
  regen.onclick = () => regenerateAt(idx);
  actions.appendChild(regen);
  block.appendChild(actions);
  return block;
}

function renderConversation() {
  const inner = $("conversation-inner");
  inner.innerHTML = "";
  const chat = currentChat();
  if (!chat || !chat.turns.length) {
    renderHero(inner);
    return;
  }
  for (let i = 0; i < chat.turns.length; i++) {
    const turn = chat.turns[i];
    inner.appendChild(turn.role === "user" ? buildUserTurn(turn, i) : buildAssistantTurn(turn, i));
  }
  requestAnimationFrame(scrollToBottom);
}

// Empty-state hero — model-agnostic; prompts the user to start typing or
// drop a reference. Kept intentionally sparse so it stays valid as more
// models are added.
function renderHero(inner) {
  const hero = document.createElement("div");
  hero.className = "hero";
  hero.innerHTML = `
    <p class="hero-tagline">Describe an image to generate, or drop a reference to edit.</p>
    <div class="hero-shortcuts">
      <span><kbd>⌘N</kbd>new chat</span>
      <span><kbd>⌘K</kbd>focus prompt</span>
      <span><kbd>⌘/</kbd>settings</span>
      <span><kbd>⌘↩</kbd>send</span>
    </div>
  `;
  inner.appendChild(hero);
}

// Pull a user turn back into the composer for editing, truncating the chat from
// that turn onwards. If the user hits Send, generate() recreates the turn cleanly.
function editUserTurn(turnIdx) {
  if (state.busy) return;
  const chat = currentChat();
  if (!chat) return;
  const turn = chat.turns[turnIdx];
  if (!turn || turn.role !== "user") return;
  const text = (turn.parts || []).find(p => p.text)?.text || "";
  const imageParts = (turn.parts || []).filter(p => p.inlineData?.data);
  state.refs = imageParts.map(p => ({
    name: "ref",
    mime: p.inlineData.mimeType,
    dataUrl: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
    dataB64: p.inlineData.data,
  }));
  $("prompt").value = text;
  chat.turns = chat.turns.slice(0, turnIdx);
  chat.updatedAt = Date.now();
  renderRefStrip();
  renderConversation();
  renderChatList();
  persistChats();
  $("prompt").focus();
  EventLogger.log(`User turn extracted for edit (idx ${turnIdx})`);
}

function buildGenCard(im, grid) {
  const card = document.createElement("div");
  card.className = "gen-card";
  const src = `data:${im.mimeType};base64,${im.data}`;
  const ext = (im.mimeType || "image/png").split("/")[1] || "png";
  const img = document.createElement("img");
  img.src = src;
  card.appendChild(img);

  const actions = document.createElement("div");
  actions.className = "gen-actions";

  const dl = document.createElement("a");
  dl.href = src; dl.download = `nano-banana-${Date.now()}.${ext}`;
  dl.title = "Download"; dl.textContent = "↓";
  dl.onclick = (e) => e.stopPropagation();
  actions.appendChild(dl);

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy"; copyBtn.title = "Copy image to clipboard";
  copyBtn.onclick = async (e) => {
    e.stopPropagation();
    const ok = await copyImageToClipboard(src, im.mimeType);
    const orig = copyBtn.textContent;
    copyBtn.textContent = ok ? "Copied ✓" : "Failed";
    setTimeout(() => { copyBtn.textContent = orig; }, 1200);
  };
  actions.appendChild(copyBtn);

  const useBtn = document.createElement("button");
  useBtn.textContent = "+ Ref"; useBtn.title = "Add as a reference for the next message";
  useBtn.onclick = (e) => {
    e.stopPropagation();
    if (state.refs.length >= MAX_REFS) {
      EventLogger.log(`Reached max ${MAX_REFS} references`);
      return;
    }
    addRefFromBase64({ name: `gen-${Date.now()}.${ext}`, mime: im.mimeType, data: im.data, dataUrl: src });
  };
  actions.appendChild(useBtn);

  card.appendChild(actions);
  card.onclick = () => openLightbox(src, im.mimeType);
  grid.appendChild(card);
}

// Live placeholder for streaming generation. Single object holds everything
// the stream callbacks mutate so the lifecycle is in one place.
let liveTurn = null;  // { node, text, grid, spinner, status, timer } | null

function startLiveAssistantTurn() {
  const inner = $("conversation-inner");
  // Remove the empty-state hero if it's currently shown.
  for (const h of inner.querySelectorAll(".hero")) h.remove();

  const node = buildTurnRoot("model", modelDisplay($("model").value));
  const status = document.createElement("div");
  status.className = "gen-status";
  status.innerHTML = `<span class="spinner"></span><span class="gen-status-text">Generating… 0.0s</span>`;
  node.appendChild(status);
  const grid = document.createElement("div");
  grid.className = "turn-images-grid"; grid.hidden = true;
  node.appendChild(grid);
  const spinner = document.createElement("div");
  spinner.className = "gen-card pending";
  node.appendChild(spinner);
  const text = document.createElement("div");
  text.className = "turn-text assistant";
  node.appendChild(text);
  inner.appendChild(node);

  const t0 = performance.now();
  const statusText = status.querySelector(".gen-status-text");
  const timer = setInterval(() => {
    statusText.textContent = `Generating… ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);

  liveTurn = { node, text, grid, spinner, status, timer };
  scrollToBottom();
}
function liveAssistantAddImage(im) {
  if (!liveTurn) return;
  liveTurn.grid.hidden = false;
  if (liveTurn.spinner) { liveTurn.spinner.remove(); liveTurn.spinner = null; }
  buildGenCard(im, liveTurn.grid);
  scrollToBottom();
}
function liveAssistantSetText(text) {
  if (!liveTurn) return;
  liveTurn.text.textContent = text;
  scrollToBottom();
}
// Replace the live skeleton with a fully-built assistant turn — avoids the
// full conversation re-render that previously fired at stream end.
function finalizeLiveTurn(assistantTurn, assistantIdx) {
  if (!liveTurn) return;
  if (liveTurn.timer) clearInterval(liveTurn.timer);
  const completed = buildAssistantTurn(assistantTurn, assistantIdx);
  liveTurn.node.replaceWith(completed);
  liveTurn = null;
}

// Smart auto-scroll: only stick to bottom if the user is already near the bottom.
function isNearBottom() {
  const c = $("conversation");
  if (!c) return true;
  return (c.scrollHeight - c.scrollTop - c.clientHeight) < 120;
}
let _wasNearBottomBeforeUpdate = true;
function scrollToBottom() {
  const c = $("conversation");
  if (!c) return;
  if (_wasNearBottomBeforeUpdate) c.scrollTop = c.scrollHeight;
}
function trackScroll() {
  _wasNearBottomBeforeUpdate = isNearBottom();
}

// =====================================================================
// Reference images — single canonical add (`pushRef`); other helpers adapt.
// =====================================================================
function pushRef({ name, mime, dataUrl, dataB64, width, height }) {
  if (state.refs.length >= MAX_REFS) return false;
  const ref = { name, mime, dataUrl, dataB64, width, height };
  state.refs.push(ref);
  renderRefStrip();
  // If dimensions weren't supplied (e.g. came from a generated image), fetch
  // them lazily and re-render once available so the tooltip is accurate.
  if (width == null) {
    imageDimensions(dataUrl).then(d => {
      ref.width = d.width; ref.height = d.height;
      renderRefStrip();
    });
  }
  return true;
}

async function addRefFile(file) {
  if (!file || !file.type.startsWith("image/")) return false;
  if (state.refs.length >= MAX_REFS) return false;
  const dataUrl = await fileToDataURL(file);
  const dataB64 = dataUrl.split(",", 2)[1] || "";
  const dim = await imageDimensions(dataUrl);
  const ok = pushRef({
    name: file.name || "pasted.png",
    mime: file.type || "image/png",
    dataUrl, dataB64,
    width: dim.width, height: dim.height,
  });
  if (ok) EventLogger.log(`Ref added: ${file.name || "pasted"} (${file.type || "?"}, ${dim.width}×${dim.height})`);
  return ok;
}
async function addRefFiles(files) {
  const list = [...(files || [])].filter(f => f && f.type.startsWith("image/"));
  if (!list.length) return;
  let added = 0;
  for (const f of list) {
    if (state.refs.length >= MAX_REFS) break;
    if (await addRefFile(f)) added++;
  }
  const skipped = list.length - added;
  if (skipped) EventLogger.log(`Reached max ${MAX_REFS} references; ignored ${skipped} more`);
}
function addRefFromBase64({ name, mime, data, dataUrl }) {
  pushRef({
    name, mime, dataB64: data,
    dataUrl: dataUrl || `data:${mime};base64,${data}`,
    // No width/height: pushRef will fetch them lazily.
  });
}
function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
function imageDimensions(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ width: im.naturalWidth, height: im.naturalHeight });
    im.onerror = () => resolve({ width: 0, height: 0 });
    im.src = src;
  });
}

function renderRefStrip() {
  const wrap = $("ref-strip");
  wrap.innerHTML = "";
  state.refs.forEach((ref, i) => {
    const t = document.createElement("div");
    t.className = "ref-thumb";
    t.draggable = true;
    t.dataset.idx = String(i);
    t.title = `${ref.name || ""}${ref.width ? ` · ${ref.width}×${ref.height}` : ""} · drag to reorder`;
    const img = document.createElement("img");
    img.src = ref.dataUrl; img.alt = "";
    t.appendChild(img);
    const rm = document.createElement("button");
    rm.className = "rm"; rm.textContent = "×"; rm.title = "remove";
    rm.onclick = (e) => { e.stopPropagation(); state.refs.splice(i, 1); renderRefStrip(); };
    t.appendChild(rm);
    t.onclick = () => openLightbox(ref.dataUrl, ref.mime);

    t.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-nbp-ref-index", String(i));
      t.classList.add("dragging");
    });
    t.addEventListener("dragend", () => {
      t.classList.remove("dragging");
      for (const x of wrap.querySelectorAll(".ref-thumb")) x.classList.remove("drop-before", "drop-after");
    });
    t.addEventListener("dragover", (e) => {
      if (![...e.dataTransfer.types].includes("application/x-nbp-ref-index")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = t.getBoundingClientRect();
      const after = (e.clientX - r.left) > r.width / 2;
      t.classList.toggle("drop-after", after);
      t.classList.toggle("drop-before", !after);
    });
    t.addEventListener("dragleave", () => t.classList.remove("drop-before", "drop-after"));
    t.addEventListener("drop", (e) => {
      const fromStr = e.dataTransfer.getData("application/x-nbp-ref-index");
      if (fromStr === "") return;
      e.preventDefault(); e.stopPropagation();
      const from = parseInt(fromStr, 10);
      const r = t.getBoundingClientRect();
      const after = (e.clientX - r.left) > r.width / 2;
      let to = i + (after ? 1 : 0);
      if (Number.isNaN(from) || from === to || from === to - 1) { renderRefStrip(); return; }
      const [moved] = state.refs.splice(from, 1);
      if (from < to) to -= 1;
      state.refs.splice(to, 0, moved);
      renderRefStrip();
    });

    wrap.appendChild(t);
  });
}

// =====================================================================
// Config / contents — SDK shape
// =====================================================================
function numField(id) {
  const v = $(id).value;
  if (v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function strField(id) { return $(id).value.trim() || undefined; }
function setIfDef(obj, key, v) { if (v !== undefined) obj[key] = v; }

function buildConfig() {
  const cfg = {
    temperature: parseFloat($("temperature").value),
    topP: parseFloat($("top_p").value),
  };
  setIfDef(cfg, "candidateCount", numField("candidate_count"));
  setIfDef(cfg, "maxOutputTokens", numField("max_output_tokens"));
  setIfDef(cfg, "topK", numField("top_k"));
  setIfDef(cfg, "seed", numField("seed"));
  setIfDef(cfg, "presencePenalty", numField("presence_penalty"));
  setIfDef(cfg, "frequencyPenalty", numField("frequency_penalty"));
  setIfDef(cfg, "logprobs", numField("logprobs"));
  setIfDef(cfg, "mediaResolution", strField("media_resolution"));
  setIfDef(cfg, "systemInstruction", strField("system_instruction"));
  if ($("response_logprobs").checked) cfg.responseLogprobs = true;

  const stops = $("stop_sequences").value.split(",").map(s => s.trim()).filter(Boolean);
  if (stops.length) cfg.stopSequences = stops;

  if (state.modalities.length) cfg.responseModalities = state.modalities.slice();

  const ic = {};
  if (state.aspect && state.aspect !== "auto") ic.aspectRatio = state.aspect;
  ic.imageSize = state.imageSize;
  ic.outputMimeType = $("output_mime_type").value;
  ic.personGeneration = $("person_generation").value;
  if ($("prominent_people").value) ic.prominentPeople = $("prominent_people").value;
  setIfDef(ic, "outputCompressionQuality", numField("output_compression_quality"));
  if (Object.keys(ic).length) cfg.imageConfig = ic;

  if ($("google_search").checked) cfg.tools = [{ googleSearch: {} }];

  const ss = [];
  for (const cat of state.options.harm_categories) {
    const sel = $(`safety_${cat}`);
    if (sel) ss.push({ category: cat, threshold: sel.value });
  }
  if (ss.length) cfg.safetySettings = ss;

  return cfg;
}

function buildContents(prompt) {
  // Always include prior turns from the current chat.
  const contents = [];
  const chat = currentChat();
  if (chat) {
    for (const turn of chat.turns) {
      const parts = (turn.parts || []).filter(p => p.text || p.inlineData?.data);
      if (parts.length) contents.push({ role: turn.role || "user", parts });
    }
  }
  const userParts = state.refs
    .filter(r => r.dataB64)
    .map(r => ({ inlineData: { mimeType: r.mime || "image/png", data: r.dataB64 } }));
  if (prompt) userParts.push({ text: prompt });
  if (userParts.length) contents.push({ role: "user", parts: userParts });
  return contents;
}

function buildJsSnippet() {
  const cfg = buildConfig();
  const model = $("model").value;
  const prompt = $("prompt").value.trim() || "Describe your image here.";
  const j = (v) => JSON.stringify(v);
  return [
    `import { GoogleGenAI } from "@google/genai";`,
    `import fs from "node:fs";`,
    ``,
    `const ai = new GoogleGenAI({`,
    `  vertexai: true,`,
    `  project: process.env.GOOGLE_CLOUD_PROJECT,`,
    `  location: process.env.GOOGLE_CLOUD_LOCATION ?? "global",`,
    `});`,
    ``,
    `const contents = [{`,
    `  role: "user",`,
    `  parts: [`,
    ...(state.refs.map((r, i) =>
      `    { inlineData: { mimeType: ${j(r.mime)}, data: fs.readFileSync("ref_${i}.png").toString("base64") } },`)),
    `    { text: ${j(prompt)} },`,
    `  ],`,
    `}];`,
    ``,
    `const stream = await ai.models.generateContentStream({`,
    `  model: ${j(model)},`,
    `  contents,`,
    `  config: ${JSON.stringify(cfg, null, 2).split("\n").join("\n  ")},`,
    `});`,
    ``,
    `for await (const chunk of stream) {`,
    `  for (const cand of chunk.candidates ?? []) {`,
    `    for (const part of cand.content?.parts ?? []) {`,
    `      if (part.inlineData?.data) {`,
    `        fs.writeFileSync("output.png", Buffer.from(part.inlineData.data, "base64"));`,
    `      } else if (part.text) {`,
    `        process.stdout.write(part.text);`,
    `      }`,
    `    }`,
    `  }`,
    `}`,
  ].join("\n");
}

// =====================================================================
// Modal / Lightbox / Popups
// =====================================================================
function openModal({ title, body, confirmLabel = "OK", onConfirm }) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = "";
  if (typeof body === "string") $("modal-body").innerHTML = body;
  else $("modal-body").appendChild(body);
  $("modal-foot").innerHTML = "";
  if (confirmLabel) {
    const c = document.createElement("button");
    c.className = "ghost-btn accent";
    c.textContent = confirmLabel;
    c.onclick = () => {
      const ok = onConfirm ? onConfirm() : true;
      if (ok !== false) closeModal();
    };
    $("modal-foot").appendChild(c);
  }
  const cancel = document.createElement("button");
  cancel.className = "ghost-btn"; cancel.textContent = "Cancel";
  cancel.onclick = closeModal;
  $("modal-foot").appendChild(cancel);
  $("modal").hidden = false;
}
function closeModal() { $("modal").hidden = true; }

function openLightbox(src, mime) {
  $("lightbox-img").src = src;
  $("lightbox-info").textContent = mime || "";
  $("lightbox").hidden = false;
}
function closeLightbox() { $("lightbox").hidden = true; $("lightbox-img").src = ""; }

function openPopup(id, anchorEl) {
  closePopup();
  const popup = $(id);
  if (!popup) return;
  popup.hidden = false;
  // Render off-screen to measure size first.
  popup.style.left = "-9999px";
  popup.style.top  = "0px";
  popup.style.maxHeight = "";  // reset previous clamp
  const rect = anchorEl.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const margin = 8;
  const gap = 6;

  let pw = popup.offsetWidth;
  // Pin to bottom of viewport - composer area, with at most vh - 2*margin height.
  const maxH = vh - 2 * margin;
  if (popup.offsetHeight > maxH) popup.style.maxHeight = maxH + "px";
  const ph = Math.min(popup.offsetHeight, maxH);

  // Horizontal: align with anchor left, clamp to viewport.
  let left = rect.left;
  if (left + pw > vw - margin) left = vw - pw - margin;
  if (left < margin) left = margin;

  // Vertical: prefer above the anchor; if no room, place below; if still no
  // room either way, anchor it to whichever side has more space and let the
  // popup body scroll inside.
  const spaceAbove = rect.top - margin - gap;
  const spaceBelow = vh - rect.bottom - margin - gap;
  let top;
  if (ph <= spaceAbove)      top = rect.top - ph - gap;
  else if (ph <= spaceBelow) top = rect.bottom + gap;
  else if (spaceAbove >= spaceBelow) {
    top = margin;
    popup.style.maxHeight = spaceAbove + "px";
  } else {
    top = rect.bottom + gap;
    popup.style.maxHeight = spaceBelow + "px";
  }

  popup.style.left = left + "px";
  popup.style.top  = top + "px";
  state.openPopup = id;
  anchorEl.classList.add("active");
}
function closePopup() {
  if (!state.openPopup) return;
  $(state.openPopup).hidden = true;
  for (const c of document.querySelectorAll(".chip.active")) c.classList.remove("active");
  state.openPopup = null;
}

// =====================================================================
// Generation flow
// =====================================================================
async function generate() {
  if (state.busy) return;
  const prompt = $("prompt").value;
  if (!prompt && state.refs.length === 0) {
    EventLogger.log("Generate blocked: empty prompt and no references");
    return;
  }

  // Append a new user turn to the chat from the composer.
  const chat = ensureCurrentChat(prompt);
  const userParts = state.refs.map(r => ({ inlineData: { mimeType: r.mime, data: r.dataB64 } }));
  if (prompt) userParts.push({ text: prompt });
  chat.turns.push({ role: "user", parts: userParts });
  if (chat.turns.length === 1) chat.title = titleFromPrompt(prompt);
  chat.updatedAt = Date.now();

  state.lastPrompt = prompt;
  state.refs = [];
  $("prompt").value = "";
  renderRefStrip();
  renderConversation();
  renderChatList();
  persistChats();

  return runGenerationOnChat(chat);
}

// Run the model on whatever the current chat is. Assumes the last turn is a
// user turn (or that there's prior context worth running on). Used by both
// generate() (after appending a fresh user turn) and regenerateAt() (which
// just truncated the prior assistant turn).
async function runGenerationOnChat(chat) {
  const ipcArgs = {
    model: $("model").value,
    contents: buildContents(""),
    config: buildConfig(),
  };

  const useStream = $("stream").checked;
  state.busy = true;
  state.cancelled = false;
  $("generate").disabled = true;
  $("stop").hidden = false;
  $("stop").disabled = !useStream;  // SDK can't cancel non-stream calls mid-flight
  $("stop").title = useStream ? "Stop" : "Cannot interrupt non-streaming generation";
  EventLogger.log(`Generate: stream=${useStream} model=${ipcArgs.model} aspect=${state.aspect} size=${state.imageSize} historyTurns=${chat.turns.length}`);

  const t0 = performance.now();
  // Pin the model on the turn so its role label stays correct even if the
  // user switches models later.
  const assistantTurn = { role: "model", parts: [], grounding: [], meta: null, model: ipcArgs.model };
  chat.turns.push(assistantTurn);

  startLiveAssistantTurn();

  try {
    if (useStream) {
      await runStream(ipcArgs, assistantTurn);
    } else {
      await runOnce(ipcArgs, assistantTurn);
    }
    if (state.cancelled) {
      assistantTurn.error = "Stopped.";
      EventLogger.log("Generate: cancelled");
    } else {
      state.session.count += 1;
      const elapsed = performance.now() - t0;
      assistantTurn.meta = { ...(assistantTurn.meta || {}), elapsedMs: elapsed };
      if (assistantTurn.meta?.usage?.totalTokenCount) {
        state.session.tokens += assistantTurn.meta.usage.totalTokenCount;
        $("session-tokens").textContent = `${state.session.tokens.toLocaleString()} tok`;
      }
      EventLogger.log(`Generate: done in ${elapsed.toFixed(0)} ms`);
    }
  } catch (e) {
    const msg = e?.message || String(e);
    if (state.cancelled || e?.name === "AbortError") {
      assistantTurn.error = "Stopped.";
      EventLogger.log("Generate: aborted");
    } else {
      assistantTurn.error = msg;
      EventLogger.error("Generate failed:", msg);
    }
  } finally {
    chat.updatedAt = Date.now();
    persistChats();
    state.busy = false;
    state.currentStreamId = null;
    $("generate").disabled = false;
    $("stop").hidden = true;
    $("stop").disabled = false;
    // Replace the streaming skeleton with the finalized turn — no full re-render.
    finalizeLiveTurn(assistantTurn, chat.turns.length - 1);
    renderChatList();
  }
}

async function runOnce(args, assistantTurn) {
  const data = await window.api.generate(args);
  if (data.error) throw new Error(data.error);
  if (data.text) assistantTurn.parts.push({ text: data.text });
  for (const im of (data.images || [])) {
    assistantTurn.parts.push({ inlineData: { mimeType: im.mimeType, data: im.data } });
  }
  if (data.grounding?.length) assistantTurn.grounding = data.grounding;
  assistantTurn.meta = {
    finishReason: data.finishReason,
    usage: data.usage,
  };
}

function runStream(args, assistantTurn) {
  return new Promise((resolve, reject) => {
    const streamId = window.api.generateStream(args);
    state.currentStreamId = streamId;
    let textAccum = "";
    let fatal = null;

    const unsubscribe = window.api.subscribeStream(streamId, (ev) => {
      switch (ev.type) {
        case "text":
          textAccum += ev.value;
          liveAssistantSetText(textAccum);
          break;
        case "image": {
          const im = { mimeType: ev.mimeType, data: ev.data };
          assistantTurn.parts.push({ inlineData: im });
          liveAssistantAddImage(im);
          break;
        }
        case "grounding":
          assistantTurn.grounding = assistantTurn.grounding || [];
          assistantTurn.grounding.push({ uri: ev.uri, title: ev.title });
          break;
        case "meta":
          assistantTurn.meta = {
            finishReason: ev.finishReason,
            usage: ev.usage,
          };
          break;
        case "error":
          fatal = ev.message || "Stream error";
          break;
        case "done":
          unsubscribe();
          if (textAccum) {
            // Insert text as the first part for a stable ordering.
            assistantTurn.parts.unshift({ text: textAccum });
          }
          if (fatal) return reject(new Error(fatal));
          resolve();
      }
    });
  });
}

// Regenerate: drop only the assistant turn (keep the user turn intact),
// bump seed, and re-run with the existing conversation context.
function regenerateAt(assistantIdx) {
  if (state.busy) return;
  const chat = currentChat();
  if (!chat) return;
  if (chat.turns[assistantIdx]?.role !== "model") return;

  // Bump seed for variation.
  $("seed").value = Math.floor(Math.random() * 2_147_483_647);
  saveSettings();

  // Drop the assistant turn (and anything after it) but keep the user turn.
  chat.turns = chat.turns.slice(0, assistantIdx);
  chat.updatedAt = Date.now();
  renderConversation();
  persistChats();

  // Run the model on the chat as it stands now (last turn is user).
  runGenerationOnChat(chat);
}

// =====================================================================
// Clipboard & re-encode
// =====================================================================
async function copyImageToClipboard(src, mime) {
  try {
    if (mime !== "image/png") {
      const png = await reEncodeAsPng(src);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    } else {
      const blob = await (await fetch(src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    }
    return true;
  } catch (e) {
    console.warn("clipboard copy failed", e);
    return false;
  }
}
function reEncodeAsPng(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas");
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext("2d").drawImage(im, 0, 0);
      c.toBlob((b) => b ? resolve(b) : reject(new Error("encode failed")), "image/png");
    };
    im.onerror = () => reject(new Error("image decode failed"));
    im.src = src;
  });
}

// =====================================================================
// Bug reporter
// =====================================================================
function buildReportPayload(description) {
  const cfg = buildConfig();
  const refs = state.refs.map(r => ({
    name: r.name, mime: r.mime, w: r.width, h: r.height,
    bytes: r.dataB64 ? Math.floor(r.dataB64.length * 0.75) : 0,
  }));
  const chat = currentChat();
  const historyHasImages = chat?.turns?.some(t => (t.parts || []).some(p => p.inlineData?.data)) || false;
  return {
    description,
    appState: {
      authMode: state.options?.auth_mode || "unknown",
      model: $("model").value,
      config: cfg,
      modalities: state.modalities.slice(),
      refs,
      historyDepth: chat?.turns?.length || 0,
      historyHasImages,
      lastPrompt: state.lastPrompt,
      sessionTokens: state.session.tokens,
      sessionCount: state.session.count,
      currentlyStreaming: !!state.currentStreamId,
    },
    lastError: state.lastError,
    eventLogs: EventLogger.getLogs(),
  };
}

function openIssueReporter() {
  const body = document.createElement("div");
  body.innerHTML = `
    <textarea id="issue-desc" rows="6" placeholder="What went wrong? Steps to reproduce?" style="width:100%;"></textarea>
    <div class="hint" style="margin-top:8px;">
      Includes auth mode, current config, reference image metadata (no data),
      session stats, and the last few minutes of activity. No credentials are included.
    </div>
    <div id="issue-status" class="hint" style="margin-top:8px;color:var(--muted);"></div>
    <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
      <button id="issue-copy" class="ghost-btn">📋 Copy to clipboard</button>
      <button id="issue-save" class="ghost-btn accent">💾 Save to file…</button>
    </div>`;
  openModal({ title: "Report an issue", body, confirmLabel: "" });
  setTimeout(() => $("issue-desc")?.focus(), 50);

  const setBusy = (label) => { $("issue-status").textContent = label; $("issue-copy").disabled = true; $("issue-save").disabled = true; };
  const setIdle = (label = "") => { $("issue-status").textContent = label; $("issue-copy").disabled = false; $("issue-save").disabled = false; };

  $("issue-copy").onclick = async () => {
    const desc = $("issue-desc").value.trim();
    if (!desc) { $("issue-status").textContent = "Please describe the issue first."; return; }
    setBusy("Generating…");
    const res = await window.api.generateBugReportMarkdown(buildReportPayload(desc));
    if (res.error) { setIdle(`Failed: ${res.error}`); return; }
    try {
      await navigator.clipboard.writeText(res.markdown);
      EventLogger.log("Bug report copied to clipboard");
      setIdle("Copied to clipboard ✓");
      setTimeout(closeModal, 700);
    } catch (e) {
      setIdle(`Clipboard failed: ${e?.message || e}`);
    }
  };

  $("issue-save").onclick = async () => {
    const desc = $("issue-desc").value.trim();
    if (!desc) { $("issue-status").textContent = "Please describe the issue first."; return; }
    setBusy("Saving…");
    const res = await window.api.exportBugReport(buildReportPayload(desc));
    if (res.canceled) { setIdle(""); return; }
    if (res.error) { setIdle(`Failed: ${res.error}`); return; }
    EventLogger.log(`Bug report saved: ${res.filePath}`);
    setIdle(`Saved to ${res.filePath}`);
    setTimeout(closeModal, 1200);
  };
}

// =====================================================================
// Events
// =====================================================================
function bindEvents() {
  $("temperature").addEventListener("input", (e) => $("temp-val").textContent = parseFloat(e.target.value).toFixed(2));
  $("top_p").addEventListener("input", (e) => $("topp-val").textContent = parseFloat(e.target.value).toFixed(2));

  // Save settings on any change inside the settings popup. Scoping to the
  // popup avoids firing the listener on every prompt textarea / chat-search
  // keystroke, which used to do redundant settings writes.
  const settingsPopup = $("settings-popup");
  settingsPopup.addEventListener("change", saveSettings);
  settingsPopup.addEventListener("input", debounce(saveSettings, 300));

  // Prompt
  $("prompt").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
      return;
    }
    // ↑ on empty prompt recalls the most recent user prompt from this chat.
    if (e.key === "ArrowUp" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const ta = $("prompt");
      if (ta.value === "" && ta.selectionStart === 0) {
        const chat = currentChat();
        const lastUser = chat?.turns?.slice().reverse().find(t => t.role === "user");
        const lastText = lastUser?.parts?.find(p => p.text)?.text;
        if (lastText) {
          e.preventDefault();
          ta.value = lastText;
          // Move cursor to end
          ta.setSelectionRange(lastText.length, lastText.length);
        }
      }
    }
  });

  // References
  $("ref-input").addEventListener("change", async (e) => {
    await addRefFiles(e.target.files);
    e.target.value = "";
  });
  $("ref-browse").addEventListener("click", () => $("ref-input").click());

  // Drag & drop anywhere
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    $("drag-overlay").hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $("drag-overlay").hidden = true;
  });
  window.addEventListener("drop", async (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    dragDepth = 0;
    $("drag-overlay").hidden = true;
    await addRefFiles(e.dataTransfer.files);
  });
  window.addEventListener("paste", async (e) => {
    if (!e.clipboardData) return;
    const files = [];
    for (const it of e.clipboardData.items || []) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    await addRefFiles(files);
  });

  // Send / stop
  $("generate").addEventListener("click", generate);
  $("stop").addEventListener("click", () => {
    if (!state.currentStreamId) return;
    state.cancelled = true;
    window.api.cancelGeneration(state.currentStreamId);
  });

  // Sidebar
  $("new-chat").addEventListener("click", startNewChat);
  $("chat-search").addEventListener("input", (e) => {
    state.chatSearch = e.target.value;
    renderChatList();
  });

  // Scroll tracking for smart auto-scroll during streaming
  $("conversation").addEventListener("scroll", trackScroll);

  // Drop-up / drop-down triggers (model chip lives in the topbar, opens
  // downward; the others live in the composer toolbar and open upward).
  for (const chip of [$("model-chip"), $("aspect-chip"), $("size-chip"), $("settings-chip")]) {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = chip.dataset.popup;
      if (state.openPopup === id) { closePopup(); return; }
      if (id === "model-popup") paintModelActive();
      if (id === "aspect-popup") paintAspectActive();
      if (id === "size-popup") paintSizeActive();
      if (id === "settings-popup") renderPresetList();
      openPopup(id, chip);
    });
  }
  // Click outside any popup closes it
  document.addEventListener("mousedown", (e) => {
    if (!state.openPopup) return;
    const popup = $(state.openPopup);
    const trigger = document.querySelector(`[data-popup="${state.openPopup}"]`);
    if (popup?.contains(e.target) || trigger?.contains(e.target)) return;
    closePopup();
  });
  // Reposition popup on resize
  window.addEventListener("resize", () => {
    if (state.openPopup) {
      const t = document.querySelector(`[data-popup="${state.openPopup}"]`);
      if (t) openPopup(state.openPopup, t);
    }
  });

  // Settings buttons inside popup
  $("seed-dice").addEventListener("click", () => {
    $("seed").value = Math.floor(Math.random() * 2_147_483_647);
    saveSettings();
  });
  $("preset-load").addEventListener("click", loadPreset);
  $("preset-save").addEventListener("click", savePreset);
  $("preset-delete").addEventListener("click", deletePreset);
  $("reset-defaults").addEventListener("click", () => { if (confirm("Reset all settings to defaults?")) resetDefaults(); });
  $("copy-js").addEventListener("click", () => {
    const code = buildJsSnippet();
    const body = document.createElement("div");
    body.innerHTML = `
      <pre id="js-code"></pre>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button id="js-copy" class="ghost-btn accent">Copy to clipboard</button>
      </div>`;
    closePopup();
    openModal({ title: "Node.js snippet", body, confirmLabel: "" });
    $("js-code").textContent = code;
    $("js-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(code); $("js-copy").textContent = "Copied ✓"; }
      catch { $("js-copy").textContent = "Copy failed"; }
    };
  });

  // Bug reporter
  $("report-issue").addEventListener("click", openIssueReporter);

  // Modal / lightbox close
  $("modal-close").addEventListener("click", closeModal);
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  $("lightbox-close").addEventListener("click", closeLightbox);
  $("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox" || e.target.id === "lightbox-img") closeLightbox(); });

  document.addEventListener("keydown", (e) => {
    // Escape collapses overlays in priority order.
    if (e.key === "Escape") {
      if (!$("lightbox").hidden) { closeLightbox(); return; }
      if (!$("modal").hidden)    { closeModal();    return; }
      if (state.openPopup)       { closePopup();    return; }
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    // ⌘N — new chat. Don't intercept when typing inside a text field unless the
    // user explicitly intended it (combo with cmd is unambiguous).
    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      startNewChat();
      $("prompt").focus();
      return;
    }
    // ⌘K — focus the prompt textarea.
    if (e.key === "k" || e.key === "K") {
      e.preventDefault();
      $("prompt").focus();
      return;
    }
    // ⌘/ — toggle Settings drop-up.
    if (e.key === "/") {
      e.preventDefault();
      const id = "settings-popup";
      if (state.openPopup === id) closePopup();
      else { renderPresetList(); openPopup(id, $("settings-chip")); }
      return;
    }
    // ⌘F — focus chat search.
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      $("chat-search").focus();
      $("chat-search").select();
      return;
    }
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

init();
