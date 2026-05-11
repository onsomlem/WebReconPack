// WebReconPack — background service worker.
// Authoritative session state, capture buffers, redaction, ZIP assembly,
// summary generation, and download triggering. Spec §7.3, §10, §24, §25,
// §26, §15. JSZip is vendored at lib/jszip.min.js (Phase 4 dependency).

importScripts("lib/jszip.min.js");

const SCHEMA_VERSION = "0.1";
const TOOL_VERSION = "0.1.2";

// ---- Default settings (spec §10) -----------------------------------------
const DEFAULT_SETTINGS = {
  capture_preset: "standard",
  redact_secrets: true,
  capture_request_bodies: true,
  capture_response_bodies: true,
  capture_binary_bodies: false,
  capture_idb_records: false,
  capture_user_event_metadata: true,
  capture_input_values: false,
  capture_clipboard_values: false,
  capture_file_contents: false,
  capture_cache_storage_urls: true,
  max_inline_body_bytes: 262144,
  max_sidecar_body_bytes: 5242880,
  max_total_body_bytes: 52428800,
  max_console_arg_bytes: 32768,
  max_storage_value_bytes: 102400,
  max_global_blob_bytes: 262144,
  dom_mutation_summary_interval_ms: 1000,
  stop_grace_period_ms: 500,
};

// ---- Capture presets (spec §10) -----------------------------------------
// Each preset is a partial settings object — applied as an override on top
// of the current settings. Switching preset preserves user toggles that
// aren't part of that preset's domain.
const CAPTURE_PRESETS = {
  light: {
    capture_preset: "light",
    capture_request_bodies: false,
    capture_response_bodies: false,
    max_inline_body_bytes: 16384,
    max_total_body_bytes: 5242880, // 5 MB
    max_global_blob_bytes: 32768,
    max_storage_value_bytes: 8192,
    capture_idb_records: false,
  },
  standard: {
    capture_preset: "standard",
    capture_request_bodies: true,
    capture_response_bodies: true,
    max_inline_body_bytes: 262144,
    max_total_body_bytes: 52428800, // 50 MB
    max_global_blob_bytes: 262144,
    max_storage_value_bytes: 102400,
    capture_idb_records: false,
  },
  deep: {
    capture_preset: "deep",
    capture_request_bodies: true,
    capture_response_bodies: true,
    capture_binary_bodies: true,
    capture_idb_records: true,
    max_inline_body_bytes: 1048576, // 1 MB
    max_total_body_bytes: 209715200, // 200 MB
    max_global_blob_bytes: 1048576,
    max_storage_value_bytes: 524288,
  },
};

// ---- Redaction (spec §24) ------------------------------------------------
const REDACT_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-auth-token",
  "x-api-key",
  "proxy-authorization",
]);
const REDACT_BODY_FIELD_RE =
  /(password|passwd|pwd|api[_-]?key|secret|token|access[_-]?token|refresh[_-]?token|sapisid|authuser|session|jwt)/i;

// ---- Module state --------------------------------------------------------
let settings = { ...DEFAULT_SETTINGS };
let firstRunAcknowledged = false;
let session = null; // current session, or null

// Active-tab tracking (popup uses this).
let activeTabId = null;
let activeWindowId = null;

// Long-lived ports keyed by `${tabId}:${frameId}`. Each frame's isolated.js
// holds one open while the page lives — this also keeps the SW alive.
const ports = new Map();

// ---- Toolbar badge -----------------------------------------------------
// Set globally so the user sees "REC" no matter which tab they're on.
function setRecordingBadge(recording) {
  try {
    if (recording) {
      chrome.action.setBadgeText({ text: "REC" });
      chrome.action.setBadgeBackgroundColor({ color: "#e6452f" });
      chrome.action.setTitle({ title: "WebReconPack — recording" });
    } else {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "WebReconPack" });
    }
  } catch (_) {}
}

// ---- Session shape -------------------------------------------------------

function newSession(tabId, startUrl) {
  return {
    schema_version: SCHEMA_VERSION,
    tool_version: TOOL_VERSION,
    session_id: crypto.randomUUID(),
    state: "recording",
    tab_id: tabId,
    start_url: startUrl || null,
    end_url: null,
    started_at: new Date().toISOString(),
    started_perf: Date.now(),
    ended_at: null,
    settings: { ...settings },
    counts: {
      network: 0,
      fetch: 0,
      xhr: 0,
      beacon: 0,
      form: 0,
      navigation: 0,
      user_event: 0,
      script: 0,
      download: 0,
      clipboard: 0,
      file_input: 0,
      worker: 0,
      ws_open: 0,
      ws_frame: 0,
      sse_open: 0,
      sse_event: 0,
      console: 0,
      error: 0,
      mutation_summary: 0,
      timeline: 0,
    },
    bytes: { bodies_total: 0 },
    body_cap_hit: false,
    redaction: { headers: 0, cookies: 0, bodyFields: 0 },
    warnings: [],
    // Buffers
    networkById: new Map(),
    networkOrder: [],
    beacons: [],
    forms: [],
    navigation: [],
    userEvents: [],
    scripts: [],
    downloads: [],
    clipboard: [],
    files: [],
    workers: [],
    websockets: new Map(),
    websocketOrder: [],
    sse: new Map(),
    sseOrder: [],
    consoleEvents: [],
    timeline: [],
    mutationSummaries: [],
    // Snapshots
    snapshots: {
      dom: [],            // [{ frameUrl, html }]
      iframeHtml: [],     // [{ parentFrame, src, html }]
      iframes: [],        // [{ frameUrl, iframes:[] }]
      scriptsByFrame: [], // [{ frameUrl, scripts: [] }]
      stylesByFrame: [],  // [{ frameUrl, styles: [] }]
      globals: [],        // [{ frameUrl, keys, bootstrap }]
      storage: [],        // [{ frameUrl, localStorage, sessionStorage, cookies }]
      runtime: [],
      performance: [],
      idb: [],
      cacheStorage: [],
      storageEstimate: [],
    },
    framesSeen: new Set(),
    framesSnapshotted: new Set(),
  };
}

function snapshotForPopup() {
  return {
    state: session ? session.state : "idle",
    session: session
      ? {
          session_id: session.session_id,
          tab_id: session.tab_id,
          start_url: session.start_url,
          started_at: session.started_at,
          counts: session.counts,
          bytes: session.bytes,
          body_cap_hit: session.body_cap_hit,
          warnings: session.warnings.slice(-5),
          redaction: session.redaction,
        }
      : null,
    settings,
    firstRunAcknowledged,
    activeTab: null,
  };
}

// ---- Persisted bits ------------------------------------------------------
async function persistSessionMeta() {
  try {
    await chrome.storage.session.set({
      sessionMeta: session
        ? {
            state: session.state,
            session_id: session.session_id,
            tab_id: session.tab_id,
            started_at: session.started_at,
          }
        : null,
    });
  } catch (_) {}
}

async function loadPersisted() {
  try {
    const local = await chrome.storage.local.get(["settings", "firstRunAcknowledged"]);
    if (local.settings) settings = { ...DEFAULT_SETTINGS, ...local.settings };
    firstRunAcknowledged = local.firstRunAcknowledged === true;
    const sess = await chrome.storage.session.get(["sessionMeta"]);
    if (sess.sessionMeta && sess.sessionMeta.state === "recording") {
      // SW died mid-recording — buffers were lost. Surface as a warning by
      // clearing meta; we do not try to resume buffer-less recording.
      await chrome.storage.session.set({ sessionMeta: null });
    }
  } catch (_) {}
}

// ---- Active tab tracking -------------------------------------------------
async function resolveActiveTab() {
  try {
    if (activeTabId != null) {
      const t = await chrome.tabs.get(activeTabId).catch(() => null);
      if (t && t.id != null) return t;
    }
    const win = await chrome.windows
      .getLastFocused({ populate: true, windowTypes: ["normal"] })
      .catch(() => null);
    if (win && Array.isArray(win.tabs)) {
      const t = win.tabs.find((x) => x.active);
      if (t) {
        activeTabId = t.id;
        activeWindowId = win.id;
        return t;
      }
    }
  } catch (_) {}
  return null;
}

chrome.tabs.onActivated.addListener((info) => {
  activeTabId = info.tabId;
  activeWindowId = info.windowId;
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const win = await chrome.windows.get(windowId, { populate: true });
    if (win.type && win.type !== "normal") return;
    const t = (win.tabs || []).find((x) => x.active);
    if (t) {
      activeTabId = t.id;
      activeWindowId = win.id;
    }
  } catch (_) {}
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTabId === tabId) activeTabId = null;
  if (session && session.tab_id === tabId && session.state === "recording") {
    session.warnings.push("recording tab closed before stop");
    // Best effort: leave the session in 'recording' so user can stop+download.
  }
});

// ---- Redaction helpers (spec §24) ---------------------------------------
function redactHeaders(h) {
  if (!h || typeof h !== "object") return h;
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (REDACT_HEADERS.has(String(k).toLowerCase())) {
      out[k] = "[REDACTED]";
      session && session.redaction.headers++;
    } else {
      out[k] = v;
    }
  }
  return out;
}
function redactCookies(cookieStr) {
  if (typeof cookieStr !== "string" || !cookieStr) return cookieStr;
  return cookieStr
    .split(";")
    .map((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return p;
      const name = p.slice(0, eq).trim();
      session && session.redaction.cookies++;
      return `${name}=[REDACTED]`;
    })
    .join("; ");
}
function redactDeep(v) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(redactDeep);
  if (typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (REDACT_BODY_FIELD_RE.test(k)) {
        out[k] = "[REDACTED]";
        session && session.redaction.bodyFields++;
      } else {
        out[k] = redactDeep(val);
      }
    }
    return out;
  }
  return v;
}
function redactBodyRecord(b) {
  if (!b || typeof b !== "object") return b;
  const out = { ...b };
  if (b.entries && Array.isArray(b.entries)) {
    out.entries = b.entries.map((e) =>
      e && REDACT_BODY_FIELD_RE.test(e.key || "")
        ? { ...e, value: "[REDACTED]" }
        : e
    );
  }
  if (b.decoded && typeof b.decoded === "object") {
    out.decoded = redactDeep(b.decoded);
  }
  return out;
}

// ---- Body cap tracking --------------------------------------------------
function consumeBodyBudget(size) {
  if (!session) return false;
  if (session.body_cap_hit) return false;
  if (size <= 0) return true;
  const next = session.bytes.bodies_total + size;
  if (next > settings.max_total_body_bytes) {
    session.body_cap_hit = true;
    addTimeline("cap_reached", null, `Total body cap reached at ${session.bytes.bodies_total} bytes`);
    return false;
  }
  session.bytes.bodies_total = next;
  return true;
}
function maybeStripLargeBody(b) {
  if (!b || typeof b !== "object") return b;
  if (session && session.body_cap_hit) {
    if (b.captured) {
      const stripped = { ...b, captured: false, reason: "body cap reached", inline: undefined, decoded: undefined };
      delete stripped.inline;
      delete stripped.decoded;
      return stripped;
    }
  }
  return b;
}

// ---- Timeline -----------------------------------------------------------
function addTimeline(kind, ref, summary) {
  if (!session) return;
  const ev = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    t: new Date().toISOString(),
    kind,
    ref: ref || null,
    summary: summary || null,
  };
  session.timeline.push(ev);
  session.counts.timeline++;
}

// ---- Observation routing -------------------------------------------------
function handleObservation(obs, sender) {
  if (!session) return;
  if (session.state !== "recording" && session.state !== "finalizing") return;
  if (sender && sender.tab && session.tab_id != null && sender.tab.id !== session.tab_id) {
    // Observation came from a tab other than the recording target. Ignore.
    return;
  }
  const t = obs.t || new Date().toISOString();
  const data = obs.data || {};
  const type = obs.obsType;
  try {
    switch (type) {
      case "frame_started":
        if (data.frameUrl) session.framesSeen.add(data.frameUrl);
        break;

      case "network_start":
        onNetworkStart(data, t);
        break;
      case "network_end":
        onNetworkEnd(data, t);
        break;
      case "network_error":
        onNetworkError(data, t);
        break;

      case "beacon":
        onBeacon(data, t);
        break;

      case "form_submit":
        onFormSubmit(data, t);
        break;

      case "nav":
        onNav(data, t);
        break;

      case "user_event":
        onUserEvent(data, t);
        break;

      case "script_added":
        onScriptAdded(data, t);
        break;

      case "object_url_create":
      case "object_url_revoke":
      case "download_trigger":
        onDownloadEvent(type, data, t);
        break;

      case "clipboard":
        onClipboard(data, t);
        break;

      case "file_input":
        onFileInput(data, t);
        break;

      case "worker_create":
        onWorkerCreate(data, t);
        break;

      case "ws_open":
        onWsOpen(data, t);
        break;
      case "ws_frame":
        onWsFrame(data, t);
        break;
      case "ws_close":
        onWsClose(data, t);
        break;
      case "ws_error":
        onWsError(data, t);
        break;

      case "sse_open":
        onSseOpen(data, t);
        break;
      case "sse_event":
        onSseEvent(data, t);
        break;
      case "sse_error":
        onSseError(data, t);
        break;

      case "console":
        onConsole(data, t);
        break;
      case "error":
      case "unhandledrejection":
        onPageError(type, data, t);
        break;

      case "dom_mutation_summary":
        onMutationSummary(data, t);
        break;

      case "snapshot_chunk":
        onSnapshotChunk(data);
        break;
      case "snapshot_done":
        onSnapshotDone(data);
        break;

      case "hook_install_error":
        session.warnings.push("hook install error: " + JSON.stringify(data));
        break;
    }
  } catch (e) {
    session.warnings.push("handler error " + type + ": " + (e && e.message));
  }
}

// ---- Network ------------------------------------------------------------
function onNetworkStart(d, t) {
  const id = d.id;
  if (!id) return;
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    id,
    source: d.source,
    method: d.method,
    url: d.url,
    url_parts: d.url_parts || null,
    status: null,
    statusText: null,
    requestHeaders: settings.redact_secrets ? redactHeaders(d.requestHeaders || {}) : d.requestHeaders || {},
    responseHeaders: {},
    requestBody: d.requestBody ? maybeStripLargeBody(processIncomingBody(d.requestBody)) : null,
    responseBody: null,
    responseMime: null,
    timing: d.timing || {},
    initiator: d.initiator || null,
    frameUrl: d.frameUrl || null,
    errors: [],
    started_at: t,
    ended_at: null,
  };
  session.networkById.set(id, rec);
  session.networkOrder.push(id);
  session.counts.network++;
  if (d.source === "fetch") session.counts.fetch++;
  else if (d.source === "xhr") session.counts.xhr++;
  addTimeline(d.source === "xhr" ? "xhr_start" : "request_start", id, `${d.method} ${shortUrl(d.url)}`);
}
function onNetworkEnd(d, t) {
  const rec = session.networkById.get(d.id);
  if (!rec) {
    // Late end (no start seen) — create stub.
    const stub = {
      schema_version: SCHEMA_VERSION,
      session_id: session.session_id,
      id: d.id,
      source: "unknown",
      method: null,
      url: null,
      status: d.status,
      statusText: d.statusText,
      responseHeaders: settings.redact_secrets ? redactHeaders(d.responseHeaders || {}) : d.responseHeaders || {},
      responseBody: d.responseBody ? maybeStripLargeBody(processIncomingBody(d.responseBody)) : null,
      responseMime: d.responseMime || null,
      timing: d.timing || {},
      ended_at: t,
      errors: ["end without start"],
    };
    session.networkById.set(d.id, stub);
    session.networkOrder.push(d.id);
    return;
  }
  rec.status = d.status;
  rec.statusText = d.statusText;
  rec.responseHeaders = settings.redact_secrets ? redactHeaders(d.responseHeaders || {}) : d.responseHeaders || {};
  rec.responseMime = d.responseMime || null;
  rec.responseBody = d.responseBody ? maybeStripLargeBody(processIncomingBody(d.responseBody)) : null;
  rec.timing = d.timing || rec.timing || {};
  rec.ended_at = t;
  const dur = rec.timing && rec.timing.durationMs != null ? rec.timing.durationMs.toFixed(1) : "?";
  addTimeline(rec.source === "xhr" ? "xhr_end" : "request_end", rec.id, `${rec.method || "?"} ${shortUrl(rec.url)} ${rec.status || "?"} ${dur}ms`);
}
function onNetworkError(d, t) {
  const rec = session.networkById.get(d.id);
  if (rec) {
    rec.errors.push(d.error || { message: "unknown" });
    rec.ended_at = t;
  }
  addTimeline("request_error", d.id, `error ${d.error && d.error.name}`);
}
function processIncomingBody(b) {
  if (!b) return b;
  // Apply redaction + body budget; mark sidecar candidacy.
  let body = settings.redact_secrets ? redactBodyRecord(b) : { ...b };
  if (body.captured && typeof body.size === "number") {
    consumeBodyBudget(body.size);
  }
  return body;
}
function shortUrl(u) {
  try {
    const p = new URL(u);
    return p.pathname + (p.search || "");
  } catch (_) {
    return String(u || "");
  }
}

// ---- sendBeacon ---------------------------------------------------------
function onBeacon(d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    id: d.id || crypto.randomUUID(),
    url: d.url,
    url_parts: d.url_parts || null,
    body: d.body ? maybeStripLargeBody(processIncomingBody(d.body)) : null,
    returnValue: d.returnValue,
    timestamp: t,
    frameUrl: d.frameUrl || null,
    initiator: d.initiator || null,
    errors: [],
  };
  session.beacons.push(rec);
  session.counts.beacon++;
  addTimeline("beacon", rec.id, `beacon ${shortUrl(rec.url)}`);
}

// ---- Forms --------------------------------------------------------------
function onFormSubmit(d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    id: crypto.randomUUID(),
    timestamp: t,
    action: d.action,
    method: d.method,
    enctype: d.enctype,
    target: d.target,
    fields: d.fields || [],
    submitter: d.submitter || null,
    frameUrl: d.frameUrl || null,
  };
  session.forms.push(rec);
  session.counts.form++;
  addTimeline("form_submit", rec.id, `${rec.method} ${shortUrl(rec.action || "(no action)")}`);
}

// ---- Navigation ---------------------------------------------------------
function onNav(d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    id: crypto.randomUUID(),
    timestamp: t,
    ...d,
  };
  session.navigation.push(rec);
  session.counts.navigation++;
  addTimeline(navKindToTimeline(d.kind), rec.id, `${d.kind} ${shortUrl(d.to || d.from || "")}`);
}
function navKindToTimeline(kind) {
  if (kind === "pushState" || kind === "replaceState" || kind === "popstate" || kind === "hashchange") {
    return "history_change";
  }
  return "navigation";
}

// ---- User events --------------------------------------------------------
function onUserEvent(d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    timestamp: t,
    ...d,
  };
  session.userEvents.push(rec);
  session.counts.user_event++;
  if (d.kind === "click") addTimeline("user_click", null, describeShort(d.target));
  else if (d.kind === "input" || d.kind === "change") addTimeline("user_input", null, describeShort(d.target));
  else if (d.kind === "scroll") addTimeline("user_scroll", null, `scroll x=${d.x} y=${d.y}`);
}
function describeShort(t) {
  if (!t) return null;
  if (t.text) return `${t.tag || "?"}: ${t.text}`;
  return t.selector || t.tag || "?";
}

// ---- Scripts ------------------------------------------------------------
function onScriptAdded(d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    timestamp: t,
    ...d,
  };
  session.scripts.push(rec);
  session.counts.script++;
  addTimeline("script_added", null, `${d.kind} ${shortUrl(d.src || d.href || "(inline)")}`);
}

// ---- Downloads / object URLs --------------------------------------------
function onDownloadEvent(type, d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    timestamp: t,
    eventType: type,
    ...d,
  };
  session.downloads.push(rec);
  session.counts.download++;
  if (type === "object_url_create") addTimeline("object_url_created", null, `${d.type || "?"} ${d.size || "?"}B`);
  else if (type === "download_trigger") addTimeline("download_trigger", null, d.filename || shortUrl(d.href || ""));
}

// ---- Clipboard ----------------------------------------------------------
function onClipboard(d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    timestamp: t,
    ...d,
  };
  session.clipboard.push(rec);
  session.counts.clipboard++;
  addTimeline("clipboard", null, d.op);
}

// ---- File inputs --------------------------------------------------------
function onFileInput(d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    timestamp: t,
    ...d,
  };
  session.files.push(rec);
  session.counts.file_input++;
  addTimeline("file_input", null, `${d.count || 0} file(s)`);
}

// ---- Workers ------------------------------------------------------------
function onWorkerCreate(d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    timestamp: t,
    ...d,
  };
  session.workers.push(rec);
  session.counts.worker++;
  addTimeline("worker_created", d.id, `${d.kind} ${shortUrl(d.scriptURL)}`);
}

// ---- WebSocket ----------------------------------------------------------
function onWsOpen(d, t) {
  const id = d.id;
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    id,
    url: d.url,
    protocols: d.protocols || null,
    open_at: t,
    close: null,
    frames: [],
    errors: [],
    frameUrl: d.frameUrl || null,
  };
  session.websockets.set(id, rec);
  session.websocketOrder.push(id);
  session.counts.ws_open++;
  addTimeline("ws_open", id, shortUrl(d.url));
}
function onWsFrame(d, t) {
  const ws = session.websockets.get(d.id);
  if (!ws) return;
  if (d.size && typeof d.size === "number") consumeBodyBudget(d.size);
  if (ws.frames.length < 5000) {
    ws.frames.push({
      t,
      dir: d.dir,
      type: d.type,
      size: d.size || 0,
      inline: d.inline || null,
      mime: d.mime || null,
    });
  }
  session.counts.ws_frame++;
  addTimeline("ws_frame", d.id, `${d.dir} ${d.type} ${d.size || "?"}B`);
}
function onWsClose(d, t) {
  const ws = session.websockets.get(d.id);
  if (!ws) return;
  ws.close = { t, code: d.code, reason: d.reason, wasClean: d.wasClean };
  addTimeline("ws_close", d.id, `code=${d.code}`);
}
function onWsError(d) {
  const ws = session.websockets.get(d.id);
  if (!ws) return;
  ws.errors.push({ t: new Date().toISOString() });
}

// ---- EventSource --------------------------------------------------------
function onSseOpen(d, t) {
  const id = d.id;
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    id,
    url: d.url,
    withCredentials: !!d.withCredentials,
    open_at: t,
    events: [],
    errors: [],
    frameUrl: d.frameUrl || null,
  };
  session.sse.set(id, rec);
  session.sseOrder.push(id);
  session.counts.sse_open++;
  addTimeline("sse_open", id, shortUrl(d.url));
}
function onSseEvent(d, t) {
  const sse = session.sse.get(d.id);
  if (!sse) return;
  if (d.size) consumeBodyBudget(d.size);
  if (sse.events.length < 5000) {
    sse.events.push({ t, event: d.event, size: d.size, inline: d.inline, lastEventId: d.lastEventId });
  }
  session.counts.sse_event++;
  addTimeline("sse_event", d.id, `${d.event} ${d.size || 0}B`);
}
function onSseError(d) {
  const sse = session.sse.get(d.id);
  if (!sse) return;
  sse.errors.push({ t: new Date().toISOString() });
}

// ---- Console / errors ---------------------------------------------------
function onConsole(d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    timestamp: t,
    level: d.level,
    args: d.args,
    stack: d.stack || null,
    frameUrl: d.frameUrl || null,
  };
  session.consoleEvents.push(rec);
  session.counts.console++;
  addTimeline("console", null, `${d.level}: ${summarizeArgs(d.args)}`);
}
function onPageError(type, d, t) {
  const rec = {
    schema_version: SCHEMA_VERSION,
    session_id: session.session_id,
    timestamp: t,
    type,
    ...d,
  };
  // Build a useful display string — cross-origin errors often have empty
  // `message` ("Script error.") so fall back to filename:lineno + stack.
  let display = (d && d.message) || "";
  if (d && d.filename) display += (display ? " " : "") + `(${d.filename}:${d.lineno || 0}:${d.colno || 0})`;
  if (d && d.error && d.error.stack) display += (display ? "\n" : "") + d.error.stack;
  if (d && d.reason) {
    if (typeof d.reason === "object" && d.reason.value) display += (display ? "\n" : "") + d.reason.value;
    else if (typeof d.reason === "string") display += (display ? "\n" : "") + d.reason;
  }
  if (!display) display = `(empty ${type} event)`;
  session.consoleEvents.push({ ...rec, level: type, args: [{ kind: "error", value: display }] });
  session.counts.error++;
  addTimeline(type, null, display.split("\n")[0].slice(0, 200));
}
function summarizeArgs(args) {
  if (!Array.isArray(args)) return "";
  return args
    .map((a) => {
      if (a == null) return "";
      if (typeof a.value === "string") return a.value;
      return a.kind || "";
    })
    .join(" ")
    .slice(0, 200);
}

// ---- Mutation summaries -------------------------------------------------
function onMutationSummary(d, t) {
  session.mutationSummaries.push({ t, ...d });
  session.counts.mutation_summary++;
}

// ---- Snapshot collection ------------------------------------------------
let snapshotResolver = null;
let snapshotTimeout = null;

function onSnapshotChunk(d) {
  if (!session) return;
  const k = d.kind;
  const p = d.payload || {};
  switch (k) {
    case "dom":
      session.snapshots.dom.push({ frameUrl: p.frameUrl, html: p.html });
      break;
    case "iframe_html":
      if (p.frames) {
        for (const fr of p.frames) {
          session.snapshots.iframeHtml.push({ parentFrame: p.frameUrl, src: fr.src, html: fr.html });
        }
      }
      break;
    case "iframes":
      session.snapshots.iframes.push({ frameUrl: p.frameUrl, iframes: p.iframes });
      break;
    case "loaded_scripts":
      session.snapshots.scriptsByFrame.push({ frameUrl: p.frameUrl, scripts: p.scripts });
      break;
    case "loaded_styles":
      session.snapshots.stylesByFrame.push({ frameUrl: p.frameUrl, styles: p.styles });
      break;
    case "globals":
      session.snapshots.globals.push({ frameUrl: p.frameUrl, keys: p.keys, bootstrap: p.bootstrap });
      break;
    case "storage":
      // Redact cookies on the fly per spec §24.3.
      const cookies = settings.redact_secrets ? redactCookies(p.cookies) : p.cookies;
      session.snapshots.storage.push({
        frameUrl: p.frameUrl,
        localStorage: p.localStorage,
        sessionStorage: p.sessionStorage,
        cookies,
      });
      break;
    case "runtime":
      session.snapshots.runtime.push(p);
      break;
    case "performance":
      session.snapshots.performance.push(p);
      break;
    case "idb":
      session.snapshots.idb.push(p);
      break;
    case "cache_storage":
      session.snapshots.cacheStorage.push(p);
      break;
    case "storage_estimate":
      session.snapshots.storageEstimate.push(p);
      break;
  }
}
function onSnapshotDone(d) {
  if (!session) return;
  const fu = d.frameUrl || "(unknown)";
  session.framesSnapshotted.add(fu);
  addTimeline("snapshot", null, `frame ${fu} snapshot complete`);
  // If all known frames are done, resolve early.
  if (snapshotResolver && session.framesSeen.size > 0) {
    let allDone = true;
    for (const f of session.framesSeen) {
      if (!session.framesSnapshotted.has(f)) {
        allDone = false;
        break;
      }
    }
    if (allDone) {
      const r = snapshotResolver;
      snapshotResolver = null;
      if (snapshotTimeout) {
        clearTimeout(snapshotTimeout);
        snapshotTimeout = null;
      }
      r();
    }
  }
}

function broadcastCommand(msg, tabIdFilter) {
  for (const [key, port] of ports) {
    if (tabIdFilter != null) {
      const [tabIdStr] = key.split(":");
      if (parseInt(tabIdStr, 10) !== tabIdFilter) continue;
    }
    try {
      port.postMessage(msg);
    } catch (_) {}
  }
}

// ---- Lifecycle: start / stop / cancel -----------------------------------
async function startSession(tabId) {
  if (session && session.state === "recording") {
    return { ok: false, reason: "already_recording", tab_id: session.tab_id };
  }
  let url = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab.url;
  } catch (_) {}
  session = newSession(tabId, url);
  await persistSessionMeta();
  setRecordingBadge(true);
  broadcastCommand(
    {
      type: "start_session",
      data: {
        session_id: session.session_id,
        settings,
      },
    },
    tabId
  );
  return { ok: true, session_id: session.session_id };
}

async function stopSession() {
  if (!session) return { ok: false, reason: "no_active_session" };
  if (session.state === "finalizing") return { ok: false, reason: "already_finalizing" };
  if (session.state === "ready") return { ok: false, reason: "already_ready" };
  session.state = "finalizing";
  await persistSessionMeta();
  // Tell page to stop emitting + start collecting snapshots.
  broadcastCommand({ type: "stop_session" }, session.tab_id);
  // Wait grace period for in-flight events.
  await new Promise((r) => setTimeout(r, settings.stop_grace_period_ms || 500));
  broadcastCommand({ type: "collect_snapshot" }, session.tab_id);

  // Wait for snapshots — bounded by 5s.
  await new Promise((resolve) => {
    snapshotResolver = resolve;
    snapshotTimeout = setTimeout(() => {
      const r = snapshotResolver;
      snapshotResolver = null;
      snapshotTimeout = null;
      if (r) r();
    }, 5000);
    // If no frames seen at all, resolve immediately.
    if (session.framesSeen.size === 0) {
      const r = snapshotResolver;
      snapshotResolver = null;
      if (snapshotTimeout) clearTimeout(snapshotTimeout);
      snapshotTimeout = null;
      if (r) r();
    }
  });

  // Capture end URL if we still can.
  try {
    const tab = await chrome.tabs.get(session.tab_id);
    session.end_url = tab.url;
  } catch (_) {}
  session.ended_at = new Date().toISOString();

  let downloadResult;
  try {
    downloadResult = await assembleAndDownload();
    session.state = "ready";
  } catch (e) {
    session.state = "error";
    session.warnings.push("ZIP assembly failed: " + (e && e.message));
    downloadResult = { ok: false, reason: String((e && e.message) || e) };
  }
  setRecordingBadge(false);
  await persistSessionMeta();
  return { ok: session.state === "ready", ...downloadResult };
}

async function cancelSession() {
  if (!session) return { ok: false, reason: "no_active_session" };
  broadcastCommand({ type: "stop_session" }, session.tab_id);
  session = null;
  setRecordingBadge(false);
  await persistSessionMeta();
  return { ok: true };
}

// ---- ZIP assembly + download (spec §25, §26) ----------------------------
async function assembleAndDownload() {
  const zip = new JSZip();
  const lines = (records) => records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  const networkRecords = session.networkOrder
    .map((id) => session.networkById.get(id))
    .filter(Boolean);
  const wsRecords = session.websocketOrder.map((id) => session.websockets.get(id)).filter(Boolean);
  const sseRecords = session.sseOrder.map((id) => session.sse.get(id)).filter(Boolean);

  // Bundle manifest
  const bundleManifest = {
    format_version: SCHEMA_VERSION,
    tool: "WebReconPack",
    tool_version: TOOL_VERSION,
    session_id: session.session_id,
    started_at: session.started_at,
    ended_at: session.ended_at,
    duration_ms: session.ended_at ? Date.parse(session.ended_at) - Date.parse(session.started_at) : null,
    start_url: session.start_url,
    end_url: session.end_url,
    settings,
    counts: session.counts,
    limits: {
      max_inline_body_bytes: settings.max_inline_body_bytes,
      max_total_body_bytes: settings.max_total_body_bytes,
    },
    body_cap_hit: session.body_cap_hit,
    redaction: session.redaction,
    warnings: session.warnings,
    frames_seen: Array.from(session.framesSeen),
    frames_snapshotted: Array.from(session.framesSnapshotted),
  };

  zip.file("manifest.json", JSON.stringify(bundleManifest, null, 2));
  zip.file("network.jsonl", lines(networkRecords));
  zip.file("beacons.jsonl", lines(session.beacons));
  zip.file("forms.jsonl", lines(session.forms));
  zip.file("navigation.jsonl", lines(session.navigation));
  zip.file("user-events.jsonl", lines(session.userEvents));
  zip.file("scripts.jsonl", lines(session.scripts));
  zip.file("downloads.jsonl", lines(session.downloads));
  zip.file("clipboard.jsonl", lines(session.clipboard));
  zip.file("files.jsonl", lines(session.files));
  zip.file("workers.jsonl", lines(session.workers));
  zip.file("websockets.jsonl", lines(wsRecords));
  zip.file("sse.jsonl", lines(sseRecords));
  zip.file("console.jsonl", lines(session.consoleEvents));
  zip.file("timeline.jsonl", lines(session.timeline));

  // Snapshots — prefer the snapshot taken from the tab's current URL (SPAs
  // navigate away from start_url), then start_url, then first available.
  const topDom =
    session.snapshots.dom.find((d) => d.frameUrl === session.end_url) ||
    session.snapshots.dom.find((d) => d.frameUrl === session.start_url) ||
    session.snapshots.dom[0];
  zip.file("dom.html", topDom ? topDom.html : "<!-- no dom snapshot captured -->");
  // Iframe HTML goes under dom-iframes/
  let iframeIdx = 0;
  for (const f of session.snapshots.iframeHtml) {
    zip.file(`dom-iframes/${iframeIdx++}-${slug(f.src || "frame")}.html`, f.html || "");
  }

  zip.file("loaded-scripts.json", JSON.stringify(session.snapshots.scriptsByFrame, null, 2));
  zip.file("loaded-styles.json", JSON.stringify(session.snapshots.stylesByFrame, null, 2));
  zip.file("globals.json", JSON.stringify(session.snapshots.globals, null, 2));
  zip.file(
    "storage.json",
    JSON.stringify(
      {
        perFrame: session.snapshots.storage,
        idb: session.snapshots.idb,
        cacheStorage: session.snapshots.cacheStorage,
        storageEstimate: session.snapshots.storageEstimate,
      },
      null,
      2
    )
  );
  zip.file(
    "runtime.json",
    JSON.stringify({ perFrame: session.snapshots.runtime, mutationSummaries: session.mutationSummaries }, null, 2)
  );
  zip.file("performance.json", JSON.stringify(session.snapshots.performance, null, 2));

  // Summary last so it can reference anything.
  zip.file("summary.md", buildSummary(networkRecords, wsRecords, sseRecords, bundleManifest));

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const filename = buildFilename();

  // Try blob URL first; fall back to data URL if not supported in SW.
  let url;
  try {
    url = URL.createObjectURL(blob);
  } catch (_) {
    const buf = await blob.arrayBuffer();
    url = "data:application/zip;base64," + arrayBufferToBase64(buf);
  }
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
  // Revoke the blob URL after a delay so the download can read it.
  if (url.startsWith("blob:")) {
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }, 60000);
  }
  return { ok: true, downloadId, filename };
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function buildFilename() {
  const host = (() => {
    try {
      return new URL(session.start_url).hostname || "unknown";
    } catch (_) {
      return "unknown";
    }
  })();
  const dt = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}-${pad(dt.getHours())}${pad(
    dt.getMinutes()
  )}${pad(dt.getSeconds())}`;
  return `recon-${host}-${stamp}.zip`;
}
function slug(s) {
  try {
    return String(s)
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 80);
  } catch (_) {
    return "frame";
  }
}

// ---- Summary + pattern intelligence (spec §15, §26) ---------------------
function normalizePath(pathname) {
  if (!pathname) return pathname;
  return pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "{uuid}";
      if (/^\d{4,}$/.test(seg)) return "{id}";
      if (/^[A-Za-z0-9+/=_-]{32,}$/.test(seg)) return "{encoded}";
      return seg;
    })
    .join("/");
}
function clusterEndpoints(records) {
  const clusters = new Map();
  for (const r of records) {
    if (!r.url) continue;
    let parts = null;
    try {
      const p = new URL(r.url);
      parts = { origin: p.origin, pathname: p.pathname, search: p.search, query: Array.from(p.searchParams.keys()) };
    } catch (_) {
      continue;
    }
    const norm = `${r.method || "?"} ${normalizePath(parts.pathname)}`;
    if (!clusters.has(norm)) {
      clusters.set(norm, {
        key: norm,
        method: r.method,
        normalizedPath: normalizePath(parts.pathname),
        origin: parts.origin,
        count: 0,
        statuses: {},
        queryKeys: new Set(),
        examples: [],
      });
    }
    const c = clusters.get(norm);
    c.count++;
    const st = r.status || "?";
    c.statuses[st] = (c.statuses[st] || 0) + 1;
    for (const k of parts.query) c.queryKeys.add(k);
    if (c.examples.length < 3) c.examples.push(r.url);
  }
  return Array.from(clusters.values()).sort((a, b) => b.count - a.count);
}
function detectPatterns(records, beacons) {
  const detections = [];
  const evidence = (name, conf, ev, examples, suggestion) => detections.push({ name, confidence: conf, evidence: ev, examples, suggested_next: suggestion });

  const graphqlOps = new Map();
  let xssiCount = 0;
  let formUrlencCount = 0;
  let multipartCount = 0;
  let ndjsonCount = 0;
  let sseCount = 0;
  let protobufCount = 0;
  let trpcCount = 0;
  let jsonRpcCount = 0;
  let nextDataCount = 0;
  let batchExecuteCount = 0;
  let htmxCount = 0;

  for (const r of records) {
    const url = r.url || "";
    const ct = (r.responseMime || "").toLowerCase();
    const reqCt = ((r.requestHeaders && (r.requestHeaders["content-type"] || r.requestHeaders["Content-Type"])) || "").toLowerCase();
    const reqBody = r.requestBody;
    const respBody = r.responseBody;

    // GraphQL
    const reqDecoded = reqBody && reqBody.decoded;
    const isGraphqlPath = /\/graphql\b/i.test(url);
    const isGraphqlBody = reqDecoded && (
      (typeof reqDecoded === "object" && (reqDecoded.query || reqDecoded.operationName || reqDecoded.variables)) ||
      (Array.isArray(reqDecoded) && reqDecoded[0] && reqDecoded[0].query)
    );
    if (isGraphqlPath || isGraphqlBody) {
      const ops = Array.isArray(reqDecoded) ? reqDecoded : [reqDecoded].filter(Boolean);
      for (const op of ops) {
        if (!op || typeof op !== "object") continue;
        const name = op.operationName || (op.query && (op.query.match(/(query|mutation|subscription)\s+(\w+)/) || [])[2]) || "(anonymous)";
        const type = op.query ? (op.query.match(/^\s*(query|mutation|subscription)/) || [])[1] || "query" : "unknown";
        const key = `${name}|${type}`;
        if (!graphqlOps.has(key)) graphqlOps.set(key, { name, type, count: 0, endpoints: new Set() });
        const g = graphqlOps.get(key);
        g.count++;
        try { g.endpoints.add(new URL(url).origin + new URL(url).pathname); } catch (_) {}
      }
    }
    // XSSI prefix
    if (respBody && respBody.inline && /^\)\]\}'/.test(respBody.inline)) xssiCount++;
    // Form-urlencoded request
    if (/x-www-form-urlencoded/.test(reqCt)) formUrlencCount++;
    // Multipart request
    if (/multipart\/form-data/.test(reqCt)) multipartCount++;
    // NDJSON response
    if (respBody && respBody.inline && /\n\{/.test(respBody.inline) && /^\{/.test(respBody.inline.trim())) ndjsonCount++;
    // SSE
    if (respBody && respBody.type === "sse") sseCount++;
    // Protobuf-looking
    if (/protobuf|grpc/i.test(ct) || (respBody && respBody.type === "binary")) protobufCount++;
    // tRPC
    if (/\/trpc\//i.test(url) || (reqDecoded && reqDecoded[0] && reqDecoded[0].method === undefined && reqDecoded[0].id !== undefined && reqDecoded[0].params !== undefined)) trpcCount++;
    // JSON-RPC
    if (reqDecoded && (reqDecoded.jsonrpc === "2.0" || (Array.isArray(reqDecoded) && reqDecoded[0] && reqDecoded[0].jsonrpc === "2.0"))) jsonRpcCount++;
    // Next.js data routes
    if (/\/_next\/data\//.test(url) || /__NEXT_DATA__/.test((respBody && respBody.inline) || "")) nextDataCount++;
    // Google batchexecute
    if (/batchexecute/.test(url) || /^\)\]\}'/.test((respBody && respBody.inline) || "")) batchExecuteCount++;
    // htmx
    const reqHeaders = r.requestHeaders || {};
    if (reqHeaders["HX-Request"] || reqHeaders["hx-request"]) htmxCount++;
  }

  if (graphqlOps.size > 0) {
    const ops = Array.from(graphqlOps.values()).map((g) => ({
      operation: g.name,
      type: g.type,
      count: g.count,
      endpoints: Array.from(g.endpoints),
    }));
    evidence("GraphQL", "high", `${graphqlOps.size} unique operations`, ops, "Inspect variables in network.jsonl for pagination/auth cursors.");
  }
  if (xssiCount > 0) evidence("XSSI/XSRF JSON prefix `)]}'`", "high", `${xssiCount} response(s) with XSSI prefix`, [], "Strip the `)]}'` prefix before JSON parsing.");
  if (formUrlencCount > 0) evidence("form-urlencoded requests", "medium", `${formUrlencCount} request(s)`, [], "Decode entries to understand state.");
  if (multipartCount > 0) evidence("multipart/form-data uploads", "medium", `${multipartCount} request(s)`, [], "Inspect file uploads in network.jsonl + files.jsonl.");
  if (ndjsonCount > 0) evidence("NDJSON responses", "medium", `${ndjsonCount} response(s)`, [], "Parse line-by-line; likely streaming/list endpoints.");
  if (sseCount > 0) evidence("SSE (text/event-stream)", "high", `${sseCount} response(s)`, [], "Check sse.jsonl for live event streams.");
  if (protobufCount > 0) evidence("Binary/protobuf-looking responses", "medium", `${protobufCount} response(s)`, [], "Body capture is text-only; consider proto schema discovery.");
  if (trpcCount > 0) evidence("tRPC", "medium", `${trpcCount} match(es)`, [], "tRPC procedures live under /trpc/<procedure>; inspect input/output JSON.");
  if (jsonRpcCount > 0) evidence("JSON-RPC", "high", `${jsonRpcCount} request(s) with jsonrpc:2.0`, [], "method/params are in request bodies.");
  if (nextDataCount > 0) evidence("Next.js data route", "high", `${nextDataCount} match(es)`, [], "Server-rendered Next.js — check __NEXT_DATA__ in dom.html.");
  if (batchExecuteCount > 0) evidence("Google WIZ batchexecute", "high", `${batchExecuteCount} match(es)`, [], "Body is `f.req=…` JSON; XSSI-prefixed response.");
  if (htmxCount > 0) evidence("htmx requests", "high", `${htmxCount} request(s) with HX-Request header`, [], "htmx swaps DOM fragments; check responseBody for HTML partials.");
  return detections;
}

function classifyInitiator(records, userEvents, navigation) {
  // Naive proximity-based classification: for each network start, find the
  // closest preceding user_event/nav within 750ms.
  const classified = [];
  const ueByT = userEvents
    .map((u) => ({ t: Date.parse(u.timestamp), kind: u.kind, target: u.target }))
    .sort((a, b) => a.t - b.t);
  const navByT = navigation.map((n) => ({ t: Date.parse(n.timestamp), kind: n.kind })).sort((a, b) => a.t - b.t);
  for (const r of records) {
    if (!r.started_at) continue;
    const t = Date.parse(r.started_at);
    let cls = "unknown";
    let nearestUe = null;
    for (let i = ueByT.length - 1; i >= 0; i--) {
      if (ueByT[i].t <= t && t - ueByT[i].t < 750) {
        nearestUe = ueByT[i];
        break;
      }
    }
    let nearestNav = null;
    for (let i = navByT.length - 1; i >= 0; i--) {
      if (navByT[i].t <= t && t - navByT[i].t < 750) {
        nearestNav = navByT[i];
        break;
      }
    }
    if (nearestNav) cls = "route_change";
    else if (nearestUe) {
      if (nearestUe.kind === "click") cls = "user_click";
      else if (nearestUe.kind === "input" || nearestUe.kind === "change") cls = "user_input";
      else if (nearestUe.kind === "scroll") cls = "scroll/lazy-load";
      else cls = "user_event";
    } else if (r.timing && r.timing.start && r.timing.start < 5000) {
      cls = "page_bootstrap";
    }
    classified.push({ id: r.id, classification: cls, url: r.url, method: r.method, status: r.status });
  }
  return classified;
}

function topByCount(records, keyFn, n) {
  const map = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (k == null) continue;
    map.set(k, (map.get(k) || 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function buildSummary(networkRecords, wsRecords, sseRecords, bundleManifest) {
  const host = (() => {
    try {
      return new URL(session.start_url).hostname;
    } catch (_) {
      return "unknown";
    }
  })();
  const clusters = clusterEndpoints(networkRecords);
  const patterns = detectPatterns(networkRecords, session.beacons);
  const initiators = classifyInitiator(networkRecords, session.userEvents, session.navigation);
  const initiatorCounts = initiators.reduce((m, i) => {
    m[i.classification] = (m[i.classification] || 0) + 1;
    return m;
  }, {});
  const methods = topByCount(networkRecords, (r) => r.method, 10);
  const origins = topByCount(networkRecords, (r) => (r.url_parts && r.url_parts.origin) || null, 10);
  const mimes = topByCount(networkRecords, (r) => r.responseMime || "(none)", 10);

  const lines = [];
  const fmtTbl = (rows, headers) => {
    if (rows.length === 0) return "_none_\n";
    let out = "| " + headers.join(" | ") + " |\n";
    out += "|" + headers.map(() => "---").join("|") + "|\n";
    for (const r of rows) out += "| " + r.join(" | ") + " |\n";
    return out;
  };

  lines.push(`# Recon Pack: ${host}`);
  lines.push("");
  lines.push(`- **Captured:** ${session.started_at} → ${session.ended_at}`);
  lines.push(`- **Tab:** ${session.tab_id}`);
  const dur = bundleManifest.duration_ms ? (bundleManifest.duration_ms / 1000).toFixed(1) + "s" : "?";
  lines.push(`- **Duration:** ${dur}`);
  const ua = (session.snapshots.runtime[0] && session.snapshots.runtime[0].userAgent) || "(unknown)";
  lines.push(`- **User agent:** ${ua}`);
  lines.push(`- **Settings preset:** ${settings.capture_preset}`);
  lines.push(`- **Schema version:** ${SCHEMA_VERSION}`);
  lines.push("");

  lines.push("## At a glance");
  lines.push("");
  lines.push(fmtTbl(
    Object.entries(session.counts).map(([k, v]) => [k, String(v)]),
    ["Counter", "Value"]
  ));
  if (session.body_cap_hit) {
    lines.push(`> **Body cap reached** at ${session.bytes.bodies_total} bytes — metadata continued, bodies dropped.`);
    lines.push("");
  }
  lines.push("");

  lines.push("## Top endpoints by request count");
  lines.push("");
  lines.push(
    fmtTbl(
      clusters.slice(0, 25).map((c) => [
        c.method || "?",
        c.normalizedPath || "/",
        String(c.count),
        Array.from(c.queryKeys).slice(0, 8).join(", ") || "—",
        Object.entries(c.statuses).map(([s, n]) => `${s}×${n}`).join(", "),
      ]),
      ["Method", "Path", "Count", "Query keys", "Statuses"]
    )
  );

  lines.push("## Top origins");
  lines.push("");
  lines.push(fmtTbl(origins.map(([k, v]) => [k, String(v)]), ["Origin", "Count"]));

  lines.push("## User action timeline (first 30)");
  lines.push("");
  const ueRows = session.userEvents.slice(0, 30).map((u) => [
    u.timestamp.replace("T", " ").replace(/\..*/, ""),
    u.kind,
    describeShort(u.target) || "—",
  ]);
  lines.push(fmtTbl(ueRows, ["When", "Kind", "Target"]));

  lines.push("## Navigation events");
  lines.push("");
  lines.push(
    fmtTbl(
      session.navigation.slice(0, 30).map((n) => [
        n.timestamp.replace("T", " ").replace(/\..*/, ""),
        n.kind,
        n.from || "—",
        n.to || "—",
      ]),
      ["When", "Kind", "From", "To"]
    )
  );

  lines.push("## Forms and beacons");
  lines.push("");
  lines.push(`- Form submits: ${session.forms.length}`);
  for (const f of session.forms.slice(0, 10)) {
    lines.push(`  - \`${f.method} ${f.action || "(no action)"}\` — ${f.fields.length} field(s)`);
  }
  lines.push(`- Beacons: ${session.beacons.length}`);
  for (const b of session.beacons.slice(0, 10)) {
    lines.push(`  - \`${b.url}\` (${b.body && b.body.type})`);
  }
  lines.push("");

  lines.push("## Methods observed");
  lines.push("");
  lines.push(fmtTbl(methods.map(([k, v]) => [k, String(v)]), ["Method", "Count"]));

  lines.push("## Response content types");
  lines.push("");
  lines.push(fmtTbl(mimes.map(([k, v]) => [k, String(v)]), ["Mime", "Count"]));

  lines.push("## Initiator classification");
  lines.push("");
  lines.push(
    fmtTbl(
      Object.entries(initiatorCounts).map(([k, v]) => [k, String(v)]),
      ["Class", "Count"]
    )
  );

  lines.push("## Detected response/request patterns");
  lines.push("");
  if (patterns.length === 0) {
    lines.push("_No high-signal patterns detected._");
  } else {
    for (const p of patterns) {
      lines.push(`- **${p.name}** _(confidence: ${p.confidence})_ — ${p.evidence}`);
      if (p.suggested_next) lines.push(`  - _Next:_ ${p.suggested_next}`);
    }
  }
  lines.push("");

  // GraphQL operation table
  const gqlPattern = patterns.find((p) => p.name === "GraphQL");
  if (gqlPattern && Array.isArray(gqlPattern.examples)) {
    lines.push("## GraphQL operations observed");
    lines.push("");
    lines.push(
      fmtTbl(
        gqlPattern.examples.map((g) => [g.operation, g.type, String(g.count), g.endpoints.join(", ")]),
        ["Operation", "Type", "Count", "Endpoint"]
      )
    );
  }

  lines.push("## Bootstrap globals");
  lines.push("");
  const bootstrapAll = session.snapshots.globals.flatMap((g) =>
    Object.entries(g.bootstrap || {}).map(([name, info]) => ({ frame: g.frameUrl, name, info }))
  );
  if (bootstrapAll.length === 0) {
    lines.push("_None of the well-known bootstrap globals were present._");
  } else {
    lines.push(
      fmtTbl(
        bootstrapAll.slice(0, 20).map((b) => [b.frame || "—", b.name, b.info.type || "?", b.info.size != null ? String(b.info.size) : "?", b.info.truncated ? "yes" : "no"]),
        ["Frame", "Name", "Type", "Size", "Truncated"]
      )
    );
  }

  lines.push("## Storage overview");
  lines.push("");
  for (const s of session.snapshots.storage) {
    const lk = s.localStorage && Object.keys(s.localStorage).length;
    const sk = s.sessionStorage && Object.keys(s.sessionStorage).length;
    lines.push(`- \`${s.frameUrl}\` — localStorage: ${lk}, sessionStorage: ${sk}`);
  }
  lines.push("");

  lines.push("## Console / error overview");
  lines.push("");
  const byLevel = {};
  for (const c of session.consoleEvents) byLevel[c.level] = (byLevel[c.level] || 0) + 1;
  lines.push(fmtTbl(Object.entries(byLevel).map(([k, v]) => [k, String(v)]), ["Level", "Count"]));

  lines.push("## CSP & Trusted Types");
  lines.push("");
  for (const r of session.snapshots.runtime) {
    const csp = (r.cspMetaTags || []).join("; ") || "(no <meta CSP>)";
    lines.push(`- **${r.url || r.frameUrl}** — Trusted Types: ${r.trustedTypesPresent ? "yes" : "no"}; CSP meta: ${csp}`);
  }
  lines.push("");
  lines.push("> Main-document HTTP CSP response headers are not captured in v0.1 (no `webRequest` permission).");
  lines.push("");

  lines.push("## Service workers");
  lines.push("");
  const swRows = [];
  for (const r of session.snapshots.runtime) {
    for (const s of r.serviceWorkers || []) swRows.push([s.scope, s.activeUrl || "—"]);
  }
  lines.push(fmtTbl(swRows, ["Scope", "Active script"]));

  lines.push("## Redaction report");
  lines.push("");
  lines.push(`- Redaction enabled: ${settings.redact_secrets}`);
  lines.push(`- Header values redacted: ${session.redaction.headers}`);
  lines.push(`- Cookie values redacted: ${session.redaction.cookies}`);
  lines.push(`- Body fields redacted: ${session.redaction.bodyFields}`);
  lines.push("");

  lines.push("## Limits and truncation");
  lines.push("");
  lines.push(`- max_inline_body_bytes: ${settings.max_inline_body_bytes}`);
  lines.push(`- max_total_body_bytes: ${settings.max_total_body_bytes}`);
  lines.push(`- Total body bytes captured: ${session.bytes.bodies_total}`);
  lines.push(`- Body cap hit: ${session.body_cap_hit}`);
  if (session.warnings.length > 0) {
    lines.push("");
    lines.push("**Warnings:**");
    for (const w of session.warnings) lines.push(`- ${w}`);
  }
  lines.push("");

  lines.push("## Suggested next steps");
  lines.push("");
  const nextSteps = buildSuggestedNextSteps(networkRecords, patterns, clusters);
  for (const s of nextSteps) lines.push(`- ${s}`);

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Generated by WebReconPack " + TOOL_VERSION + " — local-only browsing recon.");

  return lines.join("\n");
}

function buildSuggestedNextSteps(records, patterns, clusters) {
  const out = [];
  if (clusters[0]) {
    out.push(
      `Top endpoint \`${clusters[0].method} ${clusters[0].normalizedPath}\` was hit ${clusters[0].count}× — inspect query keys [${Array.from(clusters[0].queryKeys || []).join(", ")}] and response shape in network.jsonl.`
    );
  }
  if (patterns.find((p) => p.name === "GraphQL")) {
    out.push("GraphQL detected — inspect operation variables in network.jsonl for pagination cursors / auth tokens.");
  }
  if (session.forms.length > 0) {
    out.push(`${session.forms.length} HTML form submit(s) detected — fetch/XHR hooks won't fully explain these flows; inspect forms.jsonl.`);
  }
  if (session.beacons.length > 0) {
    out.push(`${session.beacons.length} sendBeacon call(s) — telemetry/analytics; inspect beacons.jsonl.`);
  }
  if (session.downloads.some((d) => d.eventType === "object_url_create")) {
    out.push("Blob URLs created — likely client-side export; check downloads.jsonl for filenames and MIME types.");
  }
  if (patterns.find((p) => p.name === "XSSI/XSRF JSON prefix `)]}'`")) {
    out.push("XSSI-prefixed responses detected — strip the `)]}'` prefix before JSON parsing.");
  }
  if (session.websockets.size > 0) {
    out.push(`${session.websockets.size} WebSocket connection(s) — inspect outbound/inbound frames in websockets.jsonl.`);
  }
  if (session.navigation.length > 0 && records.length > 0) {
    out.push("Route changes preceded API calls — inspect navigation.jsonl alongside timeline.jsonl to map route → API.");
  }
  if (session.body_cap_hit) {
    out.push("Body cap was hit — increase max_total_body_bytes in settings if you need full captures.");
  }
  if (out.length === 0) {
    out.push("No high-signal patterns; consider running again on a more interactive flow (form submit, search, login).");
  }
  return out;
}

// ---- Message handling ---------------------------------------------------
// safeRespond suppresses errors from sending to a popup that has already
// closed (very common — the popup polls every 1s).
function safeRespond(sendResponse, value) {
  try {
    sendResponse(value);
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  switch (msg.type) {
    case "popup:getState": {
      resolveActiveTab().then((tab) => {
        const snap = snapshotForPopup();
        snap.activeTab = tab
          ? { id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId }
          : null;
        safeRespond(sendResponse, snap);
      });
      return true;
    }
    case "popup:acknowledgeFirstRun":
      firstRunAcknowledged = true;
      chrome.storage.local.set({ firstRunAcknowledged: true });
      safeRespond(sendResponse, { ok: true });
      return false;

    case "popup:updateSettings":
      if (msg.settings && typeof msg.settings === "object") {
        settings = { ...settings, ...msg.settings };
        chrome.storage.local.set({ settings });
      }
      safeRespond(sendResponse, { ok: true, settings });
      return false;

    case "popup:setPreset": {
      const name = String(msg.preset || "").toLowerCase();
      const preset = CAPTURE_PRESETS[name];
      if (!preset) {
        safeRespond(sendResponse, { ok: false, reason: "unknown_preset" });
        return false;
      }
      settings = { ...settings, ...preset };
      chrome.storage.local.set({ settings });
      safeRespond(sendResponse, { ok: true, settings });
      return false;
    }

    case "popup:start": {
      (async () => {
        const tab = await resolveActiveTab();
        if (!tab || tab.id == null) {
          safeRespond(sendResponse, { ok: false, reason: "no_active_tab" });
          return;
        }
        if (session && session.state === "recording" && session.tab_id !== tab.id) {
          safeRespond(sendResponse, {
            ok: false,
            reason: "already_recording_other_tab",
            existingTabId: session.tab_id,
          });
          return;
        }
        const r = await startSession(tab.id);
        safeRespond(sendResponse, r);
      })();
      return true;
    }

    case "popup:stop": {
      (async () => {
        const r = await stopSession();
        safeRespond(sendResponse, r);
      })();
      return true;
    }

    case "popup:cancel": {
      (async () => {
        const r = await cancelSession();
        safeRespond(sendResponse, r);
      })();
      return true;
    }

    case "popup:resolveConflict": {
      (async () => {
        if (!session || session.state !== "recording") {
          safeRespond(sendResponse, { ok: false, reason: "no_active_session" });
          return;
        }
        if (msg.action === "stop_existing") {
          await stopSession();
        } else if (msg.action === "cancel_existing") {
          await cancelSession();
        }
        safeRespond(sendResponse, { ok: true });
      })();
      return true;
    }

    case "popup:resetReady": {
      if (session && (session.state === "ready" || session.state === "error")) {
        session = null;
        persistSessionMeta();
      }
      safeRespond(sendResponse, { ok: true });
      return false;
    }
  }
  return false;
});

// ---- Long-lived ports from isolated.js ----------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "webreconpack") return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  const frameId = port.sender && port.sender.frameId;
  const key = `${tabId}:${frameId}`;
  ports.set(key, port);

  // If a session is currently recording in this tab, push start to the new
  // frame so late-loaded iframes get instrumented.
  if (session && session.state === "recording" && session.tab_id === tabId) {
    try {
      port.postMessage({
        type: "start_session",
        data: { session_id: session.session_id, settings },
      });
    } catch (_) {}
  }

  port.onDisconnect.addListener(() => {
    // Read lastError so Chrome doesn't log "Unchecked runtime.lastError"
    // for normal disconnects (page navigation, bfcache eviction, tab close).
    const _ = chrome.runtime.lastError;
    ports.delete(key);
  });

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "frame_hello") {
      if (session && session.state === "recording" && tabId === session.tab_id && msg.url) {
        session.framesSeen.add(msg.url);
      }
      return;
    }
    if (msg.type === "observation") {
      handleObservation(msg, port.sender);
    }
  });
});

// ---- Boot ---------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  await loadPersisted();
  await resolveActiveTab();
});
chrome.runtime.onStartup.addListener(async () => {
  await loadPersisted();
  await resolveActiveTab();
});
loadPersisted();
