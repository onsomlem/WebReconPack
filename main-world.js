// WebReconPack — MAIN-world content script.
// Per spec §7.1, §28 — runs in the page's JS context. Wraps page APIs to
// observe runtime behavior. Strict rules:
//
//   - Idempotent (window.__WebReconPack_loaded).
//   - No innerHTML / outerHTML / insertAdjacentHTML / document.write.
//   - Always preserve native behavior, even on capture failure.
//   - Never consume original request/response bodies.
//   - Never call chrome.* (unavailable in MAIN world).
//   - Never trust page messages; mark all our events with MARKER.
//
// Hooks are installed at document_start regardless of recording state, so
// when a session starts we already have wrappers in place. Each hook gates
// observation emission on `state.recording` to keep idle overhead near zero.

(() => {
  if (window.__WebReconPack_loaded) return;
  try {
    Object.defineProperty(window, "__WebReconPack_loaded", {
      value: true,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch (_) {
    window.__WebReconPack_loaded = true;
  }

  const MARKER = "__WebReconPack__";
  const EVENT_OUT = "webreconpack:obs"; // MAIN -> isolated
  const EVENT_IN = "webreconpack:cmd"; // isolated -> MAIN

  // ---- Native references captured before anything else ------------------
  const N = {
    fetch: window.fetch ? window.fetch.bind(window) : null,
    XHR: window.XMLHttpRequest,
    XHRopen: window.XMLHttpRequest && window.XMLHttpRequest.prototype.open,
    XHRsend: window.XMLHttpRequest && window.XMLHttpRequest.prototype.send,
    XHRsetRequestHeader:
      window.XMLHttpRequest && window.XMLHttpRequest.prototype.setRequestHeader,
    sendBeacon:
      navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null,
    WebSocket: window.WebSocket,
    EventSource: window.EventSource,
    Worker: window.Worker,
    SharedWorker: window.SharedWorker,
    consoleLog: console.log,
    consoleInfo: console.info,
    consoleWarn: console.warn,
    consoleError: console.error,
    consoleDebug: console.debug,
    URLcreateObjectURL: URL.createObjectURL,
    URLrevokeObjectURL: URL.revokeObjectURL,
    historyPushState: history.pushState,
    historyReplaceState: history.replaceState,
    clipboardWriteText:
      navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText.bind(navigator.clipboard)
        : null,
    clipboardWrite:
      navigator.clipboard && navigator.clipboard.write
        ? navigator.clipboard.write.bind(navigator.clipboard)
        : null,
    clipboardReadText:
      navigator.clipboard && navigator.clipboard.readText
        ? navigator.clipboard.readText.bind(navigator.clipboard)
        : null,
    clipboardRead:
      navigator.clipboard && navigator.clipboard.read
        ? navigator.clipboard.read.bind(navigator.clipboard)
        : null,
    execCommand: document.execCommand
      ? document.execCommand.bind(document)
      : null,
  };

  // ---- Recording state (set by SW commands) -----------------------------
  const state = {
    recording: false,
    sessionId: null,
    settings: {
      capture_request_bodies: true,
      capture_response_bodies: true,
      capture_user_event_metadata: true,
      capture_input_values: false,
      capture_clipboard_values: false,
      max_inline_body_bytes: 262144,
      max_console_arg_bytes: 32768,
      dom_mutation_summary_interval_ms: 1000,
    },
    netSeq: 0,
    wsSeq: 0,
    sseSeq: 0,
    workerSeq: 0,
    objectUrls: new Map(), // blobUrl -> { type, size, createdAt }
    mutationSummary: { nodesAdded: 0, nodesRemoved: 0, attributesChanged: 0, characterDataChanged: 0 },
    mutationFlushHandle: null,
    scrollFlushHandle: null,
    lastScroll: null,
  };

  // ---- Helpers -----------------------------------------------------------
  function nowIso() {
    return new Date().toISOString();
  }
  function uid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function shouldEmit() {
    return state.recording === true;
  }
  function frameUrl() {
    try {
      return location.href;
    } catch (_) {
      return null;
    }
  }
  // Names of our wrapper functions — drop these frames from captured stacks
  // so the page's actual call site stays visible within the 12-line cap.
  const OWN_FRAME_RE = /\b(safeStack|wrappedFetch|patchedOpen|patchedSend|patchedSetRequestHeader|patchedSendBeacon|patchedPushState|patchedReplaceState|patchedClipboard\w*|patchedExecCommand|patchedCreateObjectURL|patchedRevokeObjectURL|makeConsoleWrapper|WrappedWebSocket|WrappedEventSource|WrappedWorker|WrappedSharedWorker|emit)\b/;
  function safeStack(err) {
    try {
      const s = (err || new Error()).stack;
      if (!s) return null;
      const lines = s.split("\n");
      const filtered = [];
      for (const line of lines) {
        // Always keep the leading "Error" header line if it's the first.
        if (!filtered.length && /^[A-Za-z]/.test(line)) {
          filtered.push(line);
          continue;
        }
        if (OWN_FRAME_RE.test(line)) continue;
        filtered.push(line);
        if (filtered.length >= 12) break;
      }
      return filtered.join("\n");
    } catch (_) {
      return null;
    }
  }
  function emit(type, data) {
    try {
      const evt = new CustomEvent(EVENT_OUT, {
        detail: { marker: MARKER, type, data, t: nowIso() },
      });
      window.dispatchEvent(evt);
    } catch (_) {
      // Never let our own dispatch break the page.
    }
  }
  function clamp(s, n) {
    if (typeof s !== "string") return s;
    return s.length > n ? s.slice(0, n) : s;
  }
  function tryJsonParse(s, max) {
    if (typeof s !== "string" || s.length === 0 || s.length > max) return undefined;
    const trimmed = s.replace(/^\)\]\}',?\n?/, ""); // strip XSSI prefix
    const c0 = trimmed.charCodeAt(0);
    if (c0 !== 0x7b /* { */ && c0 !== 0x5b /* [ */) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return undefined;
    }
  }
  function urlParts(u) {
    try {
      const p = new URL(u, location.href);
      return { origin: p.origin, pathname: p.pathname, search: p.search };
    } catch (_) {
      return null;
    }
  }
  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof h.forEach === "function") {
        h.forEach((v, k) => {
          out[k] = v;
        });
        return out;
      }
      if (Array.isArray(h)) {
        for (const [k, v] of h) out[k] = v;
        return out;
      }
      if (typeof h === "object") return { ...h };
    } catch (_) {}
    return out;
  }

  // ---- Body classifiers --------------------------------------------------
  async function captureRequestBody(body) {
    const cap = state.settings.max_inline_body_bytes | 0 || 262144;
    if (body == null) return { captured: false, type: "none", size: 0 };
    try {
      if (typeof body === "string") {
        return {
          captured: true,
          type: "string",
          encoding: "utf8",
          size: body.length,
          inline: clamp(body, cap),
          truncated: body.length > cap,
          decoded: tryJsonParse(body, cap),
        };
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const entries = [];
        for (const [k, v] of body.entries()) {
          if (typeof File !== "undefined" && v instanceof File) {
            entries.push({
              key: k,
              type: "file",
              filename: v.name,
              size: v.size,
              mime: v.type,
              lastModified: v.lastModified,
            });
          } else {
            const s = String(v);
            entries.push({
              key: k,
              type: "string",
              size: s.length,
              value: clamp(s, 1024),
              truncated: s.length > 1024,
            });
          }
        }
        return { captured: true, type: "FormData", entries };
      }
      if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        const entries = [];
        for (const [k, v] of body.entries()) entries.push({ key: k, value: v });
        return { captured: true, type: "URLSearchParams", entries };
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) {
        return {
          captured: false,
          type: "Blob",
          size: body.size,
          mime: body.type,
          reason: "blob body not inlined",
        };
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const buf = body instanceof ArrayBuffer ? body : body.buffer;
        const size = buf.byteLength;
        try {
          const txt = new TextDecoder("utf-8", { fatal: true }).decode(buf);
          return {
            captured: true,
            type: "ArrayBuffer",
            encoding: "utf8",
            size,
            inline: clamp(txt, cap),
            truncated: txt.length > cap,
          };
        } catch (_) {
          return { captured: false, type: "ArrayBuffer", size, reason: "binary body not inlined" };
        }
      }
      if (body && typeof body.getReader === "function") {
        return {
          captured: false,
          type: "ReadableStream",
          reason: "stream body skipped to avoid consuming request",
        };
      }
      return { captured: false, type: typeof body, reason: "unknown body type" };
    } catch (e) {
      return { captured: false, error: String((e && e.message) || e) };
    }
  }

  async function captureResponseBodyFromClone(response) {
    const cap = state.settings.max_inline_body_bytes | 0 || 262144;
    if (!response) return { captured: false, reason: "no response" };
    let cloned;
    try {
      cloned = response.clone();
    } catch (e) {
      return { captured: false, error: "clone failed: " + (e && e.message) };
    }
    const ct = (response.headers && response.headers.get("content-type")) || "";
    try {
      // Always read as text — safest path. Binary bodies may decode as
      // mojibake but we never modify the original response.
      const text = await cloned.text();
      const size = text.length;
      const out = {
        captured: true,
        type: "text",
        encoding: "utf8",
        size,
        mime: ct,
        inline: clamp(text, cap),
        truncated: size > cap,
      };
      if (/json/i.test(ct) || /^[\s]*[{[]/.test(text.slice(0, 32))) {
        const decoded = tryJsonParse(text, cap);
        if (decoded !== undefined) {
          out.type = "json";
          if (size <= cap) out.decoded = decoded;
        }
      } else if (/x-www-form-urlencoded/i.test(ct)) {
        out.type = "urlencoded";
      } else if (/event-stream/i.test(ct)) {
        out.type = "sse";
      } else if (/octet-stream|protobuf|grpc/i.test(ct)) {
        out.type = "binary";
      }
      return out;
    } catch (e) {
      return { captured: false, error: "read failed: " + (e && e.message) };
    }
  }

  // ---- Target descriptor for user events --------------------------------
  function describeTarget(el) {
    if (!el || el.nodeType !== 1) return null;
    const out = {
      tag: el.tagName ? el.tagName.toLowerCase() : null,
    };
    try {
      if (el.id) out.id = el.id;
      if (el.classList && el.classList.length) {
        out.classes = Array.from(el.classList).slice(0, 8);
      }
      if (el.getAttribute) {
        const role = el.getAttribute("role");
        const label = el.getAttribute("aria-label");
        const name = el.getAttribute("name");
        const type = el.getAttribute("type");
        if (role) out.role = role;
        if (label) out.ariaLabel = clamp(label, 80);
        if (name) out.name = name;
        if (type) out.type = type;
      }
      if (typeof el.textContent === "string") {
        const t = el.textContent.trim();
        if (t) out.text = clamp(t, 80);
      }
      out.selector = cssSelector(el);
    } catch (_) {}
    return out;
  }
  function cssSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    try {
      if (el.id) return `#${cssEscape(el.id)}`;
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && cur.nodeType === 1 && depth < 6) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) {
          part += `#${cssEscape(cur.id)}`;
          parts.unshift(part);
          break;
        }
        if (cur.classList && cur.classList.length) {
          part += "." + Array.from(cur.classList).slice(0, 2).map(cssEscape).join(".");
        }
        const parent = cur.parentNode;
        if (parent && parent.children && parent.children.length > 1) {
          const idx = Array.prototype.indexOf.call(parent.children, cur);
          part += `:nth-child(${idx + 1})`;
        }
        parts.unshift(part);
        cur = parent;
        depth++;
      }
      return parts.join(" > ").slice(0, 200);
    } catch (_) {
      return null;
    }
  }
  function cssEscape(s) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // ---- fetch hook --------------------------------------------------------
  if (N.fetch) {
    window.fetch = function wrappedFetch(input, init) {
      // Fast pre-call capture so we have request metadata even if the call throws.
      let id = null;
      let started = 0;
      let req = null;
      try {
        if (shouldEmit()) {
          id = uid();
          started = performance && performance.now ? performance.now() : Date.now();
          const url = typeof input === "string"
            ? input
            : input && input.url
              ? input.url
              : String(input);
          const method = (init && init.method) || (input && input.method) || "GET";
          const headers = headersToObject(
            (init && init.headers) || (input && input.headers) || null
          );
          req = {
            id,
            source: "fetch",
            method: method.toUpperCase(),
            url,
            url_parts: urlParts(url),
            requestHeaders: headers,
            timing: { start: started },
            initiator: safeStack(),
            frameUrl: frameUrl(),
          };
          // Body — careful: for Request inputs, init.body is the override; the
          // Request itself owns its body which we must not consume. We capture
          // init.body if present, else mark unavailable.
          if (state.settings.capture_request_bodies && init && init.body !== undefined) {
            captureRequestBody(init.body).then((rb) => {
              if (req) req.requestBody = rb;
            }).catch(() => {});
          } else if (input && input.body && !init) {
            req.requestBody = {
              captured: false,
              type: "Request.body",
              reason: "request body owned by Request object — not consumed",
            };
          } else {
            req.requestBody = { captured: false, type: "none", size: 0 };
          }
          emit("network_start", req);
        }
      } catch (_) {}

      const promise = N.fetch(input, init);

      if (!shouldEmit() || !req) return promise;

      return promise.then(
        (response) => {
          try {
            const ended = performance && performance.now ? performance.now() : Date.now();
            const meta = {
              id,
              status: response.status,
              statusText: response.statusText,
              responseHeaders: headersToObject(response.headers),
              responseMime: (response.headers && response.headers.get("content-type")) || null,
              timing: { start: started, end: ended, durationMs: ended - started },
            };
            if (state.settings.capture_response_bodies) {
              captureResponseBodyFromClone(response)
                .then((rb) => {
                  emit("network_end", { ...meta, responseBody: rb });
                })
                .catch((e) => {
                  emit("network_end", {
                    ...meta,
                    responseBody: { captured: false, error: String(e && e.message) },
                  });
                });
            } else {
              emit("network_end", { ...meta, responseBody: { captured: false } });
            }
          } catch (_) {}
          return response;
        },
        (err) => {
          try {
            emit("network_error", {
              id,
              error: { name: err && err.name, message: err && err.message },
              timing: { start: started, end: performance.now ? performance.now() : Date.now() },
            });
          } catch (_) {}
          throw err;
        }
      );
    };
  }

  // ---- XHR hook ----------------------------------------------------------
  if (N.XHR && N.XHRopen) {
    const proto = N.XHR.prototype;
    proto.open = function patchedOpen(method, url, async, user, pass) {
      try {
        this.__wrp = {
          id: uid(),
          method: String(method || "GET").toUpperCase(),
          url: String(url),
          headers: {},
          started: 0,
        };
      } catch (_) {}
      return N.XHRopen.apply(this, arguments);
    };
    proto.setRequestHeader = function patchedSetRequestHeader(k, v) {
      try {
        if (this.__wrp) this.__wrp.headers[k] = v;
      } catch (_) {}
      return N.XHRsetRequestHeader.apply(this, arguments);
    };
    proto.send = function patchedSend(body) {
      const self = this;
      const ctx = self.__wrp;
      try {
        if (ctx && shouldEmit()) {
          ctx.started = performance && performance.now ? performance.now() : Date.now();
          const startMeta = {
            id: ctx.id,
            source: "xhr",
            method: ctx.method,
            url: ctx.url,
            url_parts: urlParts(ctx.url),
            requestHeaders: ctx.headers,
            timing: { start: ctx.started },
            initiator: safeStack(),
            frameUrl: frameUrl(),
          };
          if (state.settings.capture_request_bodies) {
            captureRequestBody(body).then((rb) => {
              startMeta.requestBody = rb;
              emit("network_start", startMeta);
            });
          } else {
            startMeta.requestBody = { captured: false };
            emit("network_start", startMeta);
          }

          const onLoadEnd = () => {
            try {
              const ended = performance && performance.now ? performance.now() : Date.now();
              const headersText = self.getAllResponseHeaders ? self.getAllResponseHeaders() : "";
              const responseHeaders = parseRawHeaders(headersText);
              const meta = {
                id: ctx.id,
                status: self.status,
                statusText: self.statusText,
                responseHeaders,
                responseMime: (responseHeaders && responseHeaders["content-type"]) || null,
                timing: { start: ctx.started, end: ended, durationMs: ended - ctx.started },
              };
              const rb = captureXHRResponse(self);
              emit("network_end", { ...meta, responseBody: rb });
            } catch (_) {}
            try {
              self.removeEventListener("loadend", onLoadEnd);
              self.removeEventListener("error", onError);
              self.removeEventListener("abort", onError);
              self.removeEventListener("timeout", onError);
            } catch (_) {}
          };
          const onError = (ev) => {
            try {
              emit("network_error", {
                id: ctx.id,
                error: { name: ev && ev.type, message: "xhr " + (ev && ev.type) },
                timing: { start: ctx.started, end: performance.now ? performance.now() : Date.now() },
              });
            } catch (_) {}
          };
          try {
            self.addEventListener("loadend", onLoadEnd);
            self.addEventListener("error", onError);
            self.addEventListener("abort", onError);
            self.addEventListener("timeout", onError);
          } catch (_) {}
        }
      } catch (_) {}
      return N.XHRsend.apply(this, arguments);
    };
  }

  function parseRawHeaders(raw) {
    const out = {};
    if (!raw) return out;
    raw.split(/\r?\n/).forEach((line) => {
      const i = line.indexOf(":");
      if (i > 0) {
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k) out[k] = v;
      }
    });
    return out;
  }
  function captureXHRResponse(xhr) {
    const cap = state.settings.max_inline_body_bytes | 0 || 262144;
    try {
      const rt = xhr.responseType;
      if (!rt || rt === "" || rt === "text") {
        const text = xhr.responseText || "";
        const size = text.length;
        const out = {
          captured: true,
          type: "text",
          encoding: "utf8",
          size,
          inline: clamp(text, cap),
          truncated: size > cap,
        };
        const decoded = tryJsonParse(text, cap);
        if (decoded !== undefined) {
          out.type = "json";
          if (size <= cap) out.decoded = decoded;
        }
        return out;
      }
      if (rt === "json") {
        try {
          const j = xhr.response;
          const s = JSON.stringify(j);
          return {
            captured: true,
            type: "json",
            encoding: "utf8",
            size: s ? s.length : 0,
            inline: s ? clamp(s, cap) : "",
            truncated: s ? s.length > cap : false,
            decoded: j,
          };
        } catch (_) {}
      }
      if (rt === "blob") {
        const b = xhr.response;
        return { captured: false, type: "Blob", size: b ? b.size : 0, mime: b ? b.type : "" };
      }
      if (rt === "arraybuffer") {
        const buf = xhr.response;
        const size = buf ? buf.byteLength : 0;
        try {
          const txt = new TextDecoder("utf-8", { fatal: true }).decode(buf);
          return {
            captured: true,
            type: "ArrayBuffer",
            encoding: "utf8",
            size,
            inline: clamp(txt, cap),
            truncated: txt.length > cap,
          };
        } catch (_) {
          return { captured: false, type: "ArrayBuffer", size, reason: "binary not inlined" };
        }
      }
      if (rt === "document") {
        return { captured: false, type: "Document", reason: "DOM responseType not serialized" };
      }
    } catch (e) {
      return { captured: false, error: String((e && e.message) || e) };
    }
    return { captured: false, type: "unknown" };
  }

  // ---- sendBeacon hook ---------------------------------------------------
  if (N.sendBeacon) {
    navigator.sendBeacon = function patchedSendBeacon(url, body) {
      let ret = false;
      try {
        ret = N.sendBeacon(url, body);
      } catch (e) {
        // Even on native throw, never propagate from our wrapper.
        ret = false;
      }
      if (shouldEmit()) {
        try {
          captureRequestBody(body).then((rb) => {
            emit("beacon", {
              id: uid(),
              url: String(url),
              url_parts: urlParts(url),
              body: rb,
              returnValue: ret,
              frameUrl: frameUrl(),
              initiator: safeStack(),
            });
          });
        } catch (_) {}
      }
      return ret;
    };
  }

  // ---- WebSocket hook ----------------------------------------------------
  if (N.WebSocket) {
    function WrappedWebSocket(url, protocols) {
      const ws = protocols !== undefined ? new N.WebSocket(url, protocols) : new N.WebSocket(url);
      const id = uid();
      try {
        if (shouldEmit()) {
          emit("ws_open", {
            id,
            url: String(url),
            protocols: protocols || null,
            frameUrl: frameUrl(),
          });
        }
      } catch (_) {}
      try {
        ws.addEventListener("message", (ev) => {
          if (!shouldEmit()) return;
          try {
            const data = ev.data;
            const frame = describeWsFrame(data);
            emit("ws_frame", { id, dir: "in", ...frame });
          } catch (_) {}
        });
        ws.addEventListener("close", (ev) => {
          if (!shouldEmit()) return;
          try {
            emit("ws_close", { id, code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
          } catch (_) {}
        });
        ws.addEventListener("error", () => {
          if (!shouldEmit()) return;
          try {
            emit("ws_error", { id });
          } catch (_) {}
        });
        // Wrap send to capture outbound frames.
        const origSend = ws.send.bind(ws);
        ws.send = function patchedSend(data) {
          if (shouldEmit()) {
            try {
              emit("ws_frame", { id, dir: "out", ...describeWsFrame(data) });
            } catch (_) {}
          }
          return origSend(data);
        };
      } catch (_) {}
      return ws;
    }
    WrappedWebSocket.prototype = N.WebSocket.prototype;
    WrappedWebSocket.CONNECTING = N.WebSocket.CONNECTING;
    WrappedWebSocket.OPEN = N.WebSocket.OPEN;
    WrappedWebSocket.CLOSING = N.WebSocket.CLOSING;
    WrappedWebSocket.CLOSED = N.WebSocket.CLOSED;
    try {
      window.WebSocket = WrappedWebSocket;
    } catch (_) {
      // If assigning fails, leave native intact and emit error.
      emit("hook_install_error", { hook: "WebSocket" });
    }
  }
  function describeWsFrame(data) {
    const cap = state.settings.max_inline_body_bytes | 0 || 262144;
    try {
      if (typeof data === "string") {
        return { type: "string", size: data.length, inline: clamp(data, Math.min(cap, 8192)) };
      }
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        return { type: "Blob", size: data.size, mime: data.type };
      }
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const buf = data instanceof ArrayBuffer ? data : data.buffer;
        return { type: "binary", size: buf.byteLength };
      }
      return { type: typeof data };
    } catch (_) {
      return { type: "unknown" };
    }
  }

  // ---- EventSource hook --------------------------------------------------
  if (N.EventSource) {
    function WrappedEventSource(url, init) {
      const es = init !== undefined ? new N.EventSource(url, init) : new N.EventSource(url);
      const id = uid();
      try {
        if (shouldEmit()) {
          emit("sse_open", {
            id,
            url: String(url),
            withCredentials: !!(init && init.withCredentials),
            frameUrl: frameUrl(),
          });
        }
      } catch (_) {}
      try {
        es.addEventListener("message", (ev) => {
          if (!shouldEmit()) return;
          try {
            emit("sse_event", {
              id,
              event: "message",
              size: typeof ev.data === "string" ? ev.data.length : 0,
              inline: typeof ev.data === "string" ? clamp(ev.data, 8192) : null,
              lastEventId: ev.lastEventId,
            });
          } catch (_) {}
        });
        es.addEventListener("error", () => {
          if (!shouldEmit()) return;
          try {
            emit("sse_error", { id });
          } catch (_) {}
        });
      } catch (_) {}
      return es;
    }
    WrappedEventSource.prototype = N.EventSource.prototype;
    WrappedEventSource.CONNECTING = N.EventSource.CONNECTING;
    WrappedEventSource.OPEN = N.EventSource.OPEN;
    WrappedEventSource.CLOSED = N.EventSource.CLOSED;
    try {
      window.EventSource = WrappedEventSource;
    } catch (_) {
      emit("hook_install_error", { hook: "EventSource" });
    }
  }

  // ---- console + error hooks --------------------------------------------
  function serializeArg(v, max) {
    try {
      if (v === null || v === undefined) return { kind: "primitive", value: String(v) };
      const t = typeof v;
      if (t === "string") {
        return { kind: "string", value: clamp(v, max), size: v.length, truncated: v.length > max };
      }
      if (t === "number" || t === "boolean") return { kind: t, value: v };
      if (t === "bigint") return { kind: "bigint", value: String(v) + "n" };
      if (t === "function") return { kind: "function", name: v.name || null };
      if (v instanceof Error) {
        return {
          kind: "error",
          name: v.name,
          message: v.message,
          stack: clamp(v.stack || "", max),
        };
      }
      if (typeof Element !== "undefined" && v instanceof Element) {
        return {
          kind: "element",
          tag: v.tagName ? v.tagName.toLowerCase() : null,
          id: v.id || null,
          classes: v.classList ? Array.from(v.classList).slice(0, 8) : [],
          text: clamp((v.textContent || "").trim(), 80),
        };
      }
      const seen = new WeakSet();
      const j = JSON.stringify(
        v,
        (_k, val) => {
          if (typeof val === "object" && val !== null) {
            if (seen.has(val)) return "[Circular]";
            seen.add(val);
          }
          if (typeof val === "function") return "[Function]";
          if (typeof val === "bigint") return String(val) + "n";
          return val;
        },
        0
      );
      if (typeof j !== "string") return { kind: "object", value: String(v) };
      return { kind: "object", value: clamp(j, max), size: j.length, truncated: j.length > max };
    } catch (e) {
      return { kind: "unserializable", error: String((e && e.message) || e) };
    }
  }
  function makeConsoleWrapper(level, native) {
    return function () {
      try {
        if (shouldEmit()) {
          const max = state.settings.max_console_arg_bytes | 0 || 32768;
          const args = [];
          for (let i = 0; i < arguments.length && i < 16; i++) {
            args.push(serializeArg(arguments[i], max));
          }
          emit("console", {
            level,
            args,
            stack: safeStack(),
            frameUrl: frameUrl(),
          });
        }
      } catch (_) {}
      return native.apply(console, arguments);
    };
  }
  try { console.log = makeConsoleWrapper("log", N.consoleLog); } catch (_) {}
  try { console.info = makeConsoleWrapper("info", N.consoleInfo); } catch (_) {}
  try { console.warn = makeConsoleWrapper("warn", N.consoleWarn); } catch (_) {}
  try { console.error = makeConsoleWrapper("error", N.consoleError); } catch (_) {}
  try { console.debug = makeConsoleWrapper("debug", N.consoleDebug); } catch (_) {}

  window.addEventListener(
    "error",
    (ev) => {
      if (!shouldEmit()) return;
      try {
        emit("error", {
          message: ev.message,
          filename: ev.filename,
          lineno: ev.lineno,
          colno: ev.colno,
          error:
            ev.error && {
              name: ev.error.name,
              message: ev.error.message,
              stack: clamp(ev.error.stack || "", 4096),
            },
          frameUrl: frameUrl(),
        });
      } catch (_) {}
    },
    true
  );
  window.addEventListener(
    "unhandledrejection",
    (ev) => {
      if (!shouldEmit()) return;
      try {
        const r = ev.reason;
        emit("unhandledrejection", {
          reason:
            r instanceof Error
              ? { name: r.name, message: r.message, stack: clamp(r.stack || "", 4096) }
              : serializeArg(r, 4096),
          frameUrl: frameUrl(),
        });
      } catch (_) {}
    },
    true
  );

  // ---- Navigation hooks --------------------------------------------------
  if (N.historyPushState) {
    history.pushState = function patchedPushState(stateObj, title, url) {
      const ret = N.historyPushState.apply(this, arguments);
      if (shouldEmit()) {
        try {
          emit("nav", {
            kind: "pushState",
            from: location.href,
            to: url ? new URL(url, location.href).href : null,
            title: title || null,
            stateShape: shapeOf(stateObj, 2),
            stack: safeStack(),
          });
        } catch (_) {}
      }
      return ret;
    };
  }
  if (N.historyReplaceState) {
    history.replaceState = function patchedReplaceState(stateObj, title, url) {
      const ret = N.historyReplaceState.apply(this, arguments);
      if (shouldEmit()) {
        try {
          emit("nav", {
            kind: "replaceState",
            from: location.href,
            to: url ? new URL(url, location.href).href : null,
            title: title || null,
            stateShape: shapeOf(stateObj, 2),
            stack: safeStack(),
          });
        } catch (_) {}
      }
      return ret;
    };
  }
  window.addEventListener("popstate", () => {
    if (!shouldEmit()) return;
    emit("nav", { kind: "popstate", to: location.href });
  });
  window.addEventListener("hashchange", (ev) => {
    if (!shouldEmit()) return;
    emit("nav", { kind: "hashchange", from: ev.oldURL, to: ev.newURL });
  });
  window.addEventListener("beforeunload", () => {
    if (!shouldEmit()) return;
    emit("nav", { kind: "beforeunload", from: location.href });
  });
  window.addEventListener("pagehide", (ev) => {
    if (!shouldEmit()) return;
    emit("nav", { kind: "pagehide", persisted: !!ev.persisted });
  });
  document.addEventListener("visibilitychange", () => {
    if (!shouldEmit()) return;
    emit("nav", { kind: "visibilitychange", state: document.visibilityState });
  });

  // ---- Form submit hook --------------------------------------------------
  document.addEventListener(
    "submit",
    (ev) => {
      if (!shouldEmit()) return;
      try {
        const f = ev.target;
        if (!f || f.tagName !== "FORM") return;
        const fields = [];
        const inputs = f.querySelectorAll
          ? f.querySelectorAll("input,select,textarea,button")
          : [];
        for (let i = 0; i < inputs.length && i < 64; i++) {
          const el = inputs[i];
          const type = (el.type || "").toLowerCase();
          const name = el.name || null;
          if (type === "password") {
            fields.push({ name, type, redacted: true });
            continue;
          }
          if (type === "file") {
            const files = el.files
              ? Array.from(el.files).map((fl) => ({
                  filename: fl.name,
                  size: fl.size,
                  mime: fl.type,
                }))
              : [];
            fields.push({ name, type, files });
            continue;
          }
          const out = { name, type };
          if (state.settings.capture_input_values) {
            try {
              const v = String(el.value == null ? "" : el.value);
              out.value = clamp(v, 256);
              out.size = v.length;
            } catch (_) {}
          }
          fields.push(out);
        }
        const submitter = ev.submitter ? describeTarget(ev.submitter) : null;
        emit("form_submit", {
          action: f.action || null,
          method: (f.method || "GET").toUpperCase(),
          enctype: f.enctype || null,
          target: f.target || null,
          fields,
          submitter,
          frameUrl: frameUrl(),
        });
      } catch (_) {}
    },
    true
  );

  // ---- User events -------------------------------------------------------
  document.addEventListener(
    "click",
    (ev) => {
      if (!shouldEmit()) return;
      if (!state.settings.capture_user_event_metadata) return;
      try {
        const target = describeTarget(ev.target);
        emit("user_event", { kind: "click", target, frameUrl: frameUrl() });
        // anchor-with-download capture
        const a = (ev.target && ev.target.closest) ? ev.target.closest("a") : null;
        if (a) {
          const dl = a.getAttribute && a.getAttribute("download");
          const href = a.href || "";
          if (dl !== null || href.startsWith("blob:") || href.startsWith("data:")) {
            emit("download_trigger", {
              href,
              filename: dl || null,
              isBlobUrl: href.startsWith("blob:"),
              isDataUrl: href.startsWith("data:"),
              target: describeTarget(a),
              frameUrl: frameUrl(),
            });
          }
        }
      } catch (_) {}
    },
    true
  );
  document.addEventListener(
    "input",
    (ev) => {
      if (!shouldEmit()) return;
      if (!state.settings.capture_user_event_metadata) return;
      try {
        const t = ev.target;
        const target = describeTarget(t);
        const out = { kind: "input", target, frameUrl: frameUrl() };
        if (state.settings.capture_input_values && t && t.type !== "password") {
          try {
            out.value = clamp(String(t.value || ""), 256);
          } catch (_) {}
        }
        emit("user_event", out);
      } catch (_) {}
    },
    true
  );
  document.addEventListener(
    "change",
    (ev) => {
      if (!shouldEmit()) return;
      if (!state.settings.capture_user_event_metadata) return;
      try {
        // File-input change triggers a separate file-input observation.
        const t = ev.target;
        if (t && t.tagName === "INPUT" && t.type === "file") {
          const files = t.files
            ? Array.from(t.files).map((f) => ({
                filename: f.name,
                size: f.size,
                mime: f.type,
                lastModified: f.lastModified,
              }))
            : [];
          emit("file_input", {
            accept: t.accept || null,
            multiple: !!t.multiple,
            count: files.length,
            files,
            target: describeTarget(t),
            frameUrl: frameUrl(),
          });
        }
        emit("user_event", { kind: "change", target: describeTarget(t), frameUrl: frameUrl() });
      } catch (_) {}
    },
    true
  );
  document.addEventListener(
    "keydown",
    (ev) => {
      if (!shouldEmit()) return;
      if (!state.settings.capture_user_event_metadata) return;
      try {
        emit("user_event", {
          kind: "keydown",
          key: ev.key,
          code: ev.code,
          ctrl: ev.ctrlKey,
          meta: ev.metaKey,
          alt: ev.altKey,
          shift: ev.shiftKey,
          target: describeTarget(ev.target),
        });
      } catch (_) {}
    },
    true
  );
  document.addEventListener("focusin", (ev) => {
    if (!shouldEmit()) return;
    if (!state.settings.capture_user_event_metadata) return;
    try {
      emit("user_event", { kind: "focus", target: describeTarget(ev.target) });
    } catch (_) {}
  });
  document.addEventListener("focusout", (ev) => {
    if (!shouldEmit()) return;
    if (!state.settings.capture_user_event_metadata) return;
    try {
      emit("user_event", { kind: "blur", target: describeTarget(ev.target) });
    } catch (_) {}
  });
  // Throttled scroll
  window.addEventListener(
    "scroll",
    () => {
      if (!shouldEmit()) return;
      if (!state.settings.capture_user_event_metadata) return;
      state.lastScroll = { x: window.scrollX, y: window.scrollY, t: Date.now() };
      if (!state.scrollFlushHandle) {
        state.scrollFlushHandle = setTimeout(() => {
          state.scrollFlushHandle = null;
          if (!state.lastScroll) return;
          try {
            emit("user_event", {
              kind: "scroll",
              x: state.lastScroll.x,
              y: state.lastScroll.y,
              frameUrl: frameUrl(),
            });
          } catch (_) {}
          state.lastScroll = null;
        }, 500);
      }
    },
    { passive: true, capture: true }
  );

  // ---- URL.createObjectURL hook -----------------------------------------
  if (N.URLcreateObjectURL) {
    URL.createObjectURL = function patchedCreateObjectURL(obj) {
      const ret = N.URLcreateObjectURL.call(URL, obj);
      try {
        if (shouldEmit()) {
          const meta = {
            url: ret,
            createdAt: nowIso(),
            type: obj && obj.constructor ? obj.constructor.name : typeof obj,
          };
          if (typeof Blob !== "undefined" && obj instanceof Blob) {
            meta.size = obj.size;
            meta.mime = obj.type;
          }
          state.objectUrls.set(ret, meta);
          emit("object_url_create", meta);
        }
      } catch (_) {}
      return ret;
    };
  }
  if (N.URLrevokeObjectURL) {
    URL.revokeObjectURL = function patchedRevokeObjectURL(u) {
      try {
        if (shouldEmit()) {
          emit("object_url_revoke", { url: String(u) });
          state.objectUrls.delete(u);
        }
      } catch (_) {}
      return N.URLrevokeObjectURL.call(URL, u);
    };
  }

  // ---- Clipboard hooks ---------------------------------------------------
  if (N.clipboardWriteText) {
    navigator.clipboard.writeText = function patchedClipboardWriteText(text) {
      try {
        if (shouldEmit()) {
          const out = { op: "writeText", size: typeof text === "string" ? text.length : 0 };
          if (state.settings.capture_clipboard_values && typeof text === "string") {
            out.value = clamp(text, 1024);
          }
          emit("clipboard", out);
        }
      } catch (_) {}
      return N.clipboardWriteText(text);
    };
  }
  if (N.clipboardWrite) {
    navigator.clipboard.write = function patchedClipboardWrite(items) {
      try {
        if (shouldEmit()) {
          emit("clipboard", { op: "write", items: Array.isArray(items) ? items.length : null });
        }
      } catch (_) {}
      return N.clipboardWrite(items);
    };
  }
  if (N.clipboardReadText) {
    navigator.clipboard.readText = function patchedClipboardReadText() {
      const p = N.clipboardReadText();
      try {
        if (shouldEmit()) emit("clipboard", { op: "readText" });
      } catch (_) {}
      return p;
    };
  }
  if (N.clipboardRead) {
    navigator.clipboard.read = function patchedClipboardRead() {
      const p = N.clipboardRead();
      try {
        if (shouldEmit()) emit("clipboard", { op: "read" });
      } catch (_) {}
      return p;
    };
  }
  if (N.execCommand) {
    document.execCommand = function patchedExecCommand(cmd) {
      try {
        if (shouldEmit() && /^(copy|cut|paste)$/i.test(String(cmd))) {
          emit("clipboard", { op: "execCommand:" + String(cmd).toLowerCase() });
        }
      } catch (_) {}
      return N.execCommand.apply(this, arguments);
    };
  }

  // ---- Worker hooks ------------------------------------------------------
  if (N.Worker) {
    function WrappedWorker(scriptURL, options) {
      const w = options !== undefined ? new N.Worker(scriptURL, options) : new N.Worker(scriptURL);
      try {
        if (shouldEmit()) {
          emit("worker_create", {
            id: uid(),
            kind: "Worker",
            scriptURL: String(scriptURL),
            options: options || null,
            frameUrl: frameUrl(),
            initiator: safeStack(),
          });
        }
      } catch (_) {}
      return w;
    }
    WrappedWorker.prototype = N.Worker.prototype;
    try {
      window.Worker = WrappedWorker;
    } catch (_) {
      emit("hook_install_error", { hook: "Worker" });
    }
  }
  if (N.SharedWorker) {
    function WrappedSharedWorker(scriptURL, options) {
      const w =
        options !== undefined
          ? new N.SharedWorker(scriptURL, options)
          : new N.SharedWorker(scriptURL);
      try {
        if (shouldEmit()) {
          emit("worker_create", {
            id: uid(),
            kind: "SharedWorker",
            scriptURL: String(scriptURL),
            options: options || null,
            frameUrl: frameUrl(),
            initiator: safeStack(),
          });
        }
      } catch (_) {}
      return w;
    }
    WrappedSharedWorker.prototype = N.SharedWorker.prototype;
    try {
      window.SharedWorker = WrappedSharedWorker;
    } catch (_) {
      emit("hook_install_error", { hook: "SharedWorker" });
    }
  }

  // ---- MutationObserver: dynamic scripts/styles + summaries -------------
  let mo = null;
  function startMutationObserver() {
    if (mo) return;
    try {
      mo = new MutationObserver((records) => {
        if (!shouldEmit()) return;
        try {
          for (const r of records) {
            // Summary counters
            if (r.type === "childList") {
              state.mutationSummary.nodesAdded += r.addedNodes ? r.addedNodes.length : 0;
              state.mutationSummary.nodesRemoved += r.removedNodes ? r.removedNodes.length : 0;
            } else if (r.type === "attributes") {
              state.mutationSummary.attributesChanged++;
              if (
                r.target &&
                r.target.tagName === "SCRIPT" &&
                r.attributeName === "src"
              ) {
                emit("script_added", {
                  kind: "src_change",
                  src: r.target.src || null,
                  type: r.target.type || null,
                  async: !!r.target.async,
                  defer: !!r.target.defer,
                  integrity: r.target.integrity || null,
                  crossorigin: r.target.crossOrigin || null,
                  frameUrl: frameUrl(),
                });
              }
            } else if (r.type === "characterData") {
              state.mutationSummary.characterDataChanged++;
            }
            // Inspect added nodes for scripts / stylesheets / preloads.
            if (r.addedNodes) {
              for (const node of r.addedNodes) {
                if (!node || node.nodeType !== 1) continue;
                const tn = node.tagName;
                if (tn === "SCRIPT") {
                  emit("script_added", {
                    kind: node.src ? "external" : "inline",
                    src: node.src || null,
                    type: node.type || null,
                    async: !!node.async,
                    defer: !!node.defer,
                    integrity: node.integrity || null,
                    crossorigin: node.crossOrigin || null,
                    inlineSize: node.src ? null : (node.textContent || "").length,
                    frameUrl: frameUrl(),
                  });
                } else if (tn === "LINK") {
                  const rel = (node.rel || "").toLowerCase();
                  if (
                    rel === "stylesheet" ||
                    rel === "preload" ||
                    rel === "prefetch" ||
                    rel === "modulepreload"
                  ) {
                    emit("script_added", {
                      kind: rel,
                      href: node.href || null,
                      as: node.as || null,
                      crossorigin: node.crossOrigin || null,
                      integrity: node.integrity || null,
                      frameUrl: frameUrl(),
                    });
                  }
                } else if (tn === "STYLE") {
                  emit("script_added", {
                    kind: "style",
                    inlineSize: (node.textContent || "").length,
                    frameUrl: frameUrl(),
                  });
                }
              }
            }
          }
        } catch (_) {}
      });
      const root = document.documentElement || document;
      mo.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src"],
        characterData: false,
      });
    } catch (_) {}
  }
  function startMutationFlusher() {
    if (state.mutationFlushHandle) return;
    const interval = state.settings.dom_mutation_summary_interval_ms || 1000;
    state.mutationFlushHandle = setInterval(() => {
      if (!shouldEmit()) return;
      const s = state.mutationSummary;
      if (
        s.nodesAdded === 0 &&
        s.nodesRemoved === 0 &&
        s.attributesChanged === 0 &&
        s.characterDataChanged === 0
      ) {
        return;
      }
      const snap = { ...s };
      state.mutationSummary = {
        nodesAdded: 0,
        nodesRemoved: 0,
        attributesChanged: 0,
        characterDataChanged: 0,
      };
      emit("dom_mutation_summary", snap);
    }, interval);
  }
  function stopMutationFlusher() {
    if (state.mutationFlushHandle) {
      clearInterval(state.mutationFlushHandle);
      state.mutationFlushHandle = null;
    }
  }
  startMutationObserver();

  // ---- Inbound command handler ------------------------------------------
  window.addEventListener(EVENT_IN, async (e) => {
    const d = e.detail;
    if (!d || d.marker !== MARKER || typeof d.type !== "string") return;
    try {
      switch (d.type) {
        case "start_session": {
          state.recording = true;
          state.sessionId = (d.data && d.data.session_id) || null;
          if (d.data && d.data.settings) {
            state.settings = { ...state.settings, ...d.data.settings };
          }
          startMutationFlusher();
          emit("frame_started", { frameUrl: frameUrl() });
          break;
        }
        case "stop_session": {
          state.recording = false;
          stopMutationFlusher();
          break;
        }
        case "collect_snapshot": {
          await collectSnapshots();
          break;
        }
      }
    } catch (_) {}
  });

  // ---- Snapshot collection ----------------------------------------------
  function shapeOf(v, depth, maxKeys) {
    maxKeys = maxKeys || 6;
    if (depth < 0) return "...";
    if (v === null) return "null";
    const t = typeof v;
    if (t !== "object") return t;
    if (Array.isArray(v)) {
      return { _type: "array", length: v.length, sample: v.slice(0, 2).map((x) => shapeOf(x, depth - 1, maxKeys)) };
    }
    try {
      const keys = Object.keys(v).slice(0, maxKeys);
      const out = { _type: v.constructor && v.constructor.name ? v.constructor.name : "object" };
      for (const k of keys) {
        try {
          out[k] = shapeOf(v[k], depth - 1, maxKeys);
        } catch (_) {
          out[k] = "[unreadable]";
        }
      }
      return out;
    } catch (_) {
      return "[opaque]";
    }
  }

  function collectGlobals() {
    const knownBootstrap = [
      "_docs_flag_initialData",
      "WIZ_global_data",
      "__INITIAL_STATE__",
      "__PRELOADED_STATE__",
      "__NEXT_DATA__",
      "__NUXT__",
      "__APOLLO_STATE__",
      "_sharedData",
    ];
    const cap = state.settings.max_global_blob_bytes || 262144;
    let keys = [];
    try {
      keys = Object.keys(window).slice(0, 1000);
    } catch (_) {}
    const bootstrap = {};
    for (const name of knownBootstrap) {
      try {
        if (name in window) {
          const v = window[name];
          let serialized = null;
          let size = null;
          let truncated = false;
          try {
            const j = JSON.stringify(v);
            if (typeof j === "string") {
              size = j.length;
              if (j.length <= cap) {
                serialized = j;
              } else {
                serialized = j.slice(0, cap);
                truncated = true;
              }
            }
          } catch (_) {}
          bootstrap[name] = {
            type: typeof v,
            shape: shapeOf(v, 4),
            size,
            content: serialized,
            truncated,
          };
        }
      } catch (_) {}
    }
    return { keys, bootstrap };
  }

  function collectStorage() {
    const out = { localStorage: {}, sessionStorage: {}, cookies: null };
    const cap = state.settings.max_storage_value_bytes || 102400;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k == null) continue;
        const v = localStorage.getItem(k) || "";
        out.localStorage[k] = { size: v.length, value: clamp(v, cap), truncated: v.length > cap };
      }
    } catch (e) {
      out.localStorage = { error: String((e && e.message) || e) };
    }
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k == null) continue;
        const v = sessionStorage.getItem(k) || "";
        out.sessionStorage[k] = { size: v.length, value: clamp(v, cap), truncated: v.length > cap };
      }
    } catch (e) {
      out.sessionStorage = { error: String((e && e.message) || e) };
    }
    try {
      out.cookies = document.cookie || "";
    } catch (_) {
      out.cookies = null;
    }
    return out;
  }

  async function collectIDBMeta() {
    if (!indexedDB || typeof indexedDB.databases !== "function") return { available: false };
    try {
      const dbs = await indexedDB.databases();
      return { available: true, databases: dbs };
    } catch (e) {
      return { available: false, error: String((e && e.message) || e) };
    }
  }

  async function collectCacheStorageMeta() {
    if (typeof caches === "undefined" || !caches.keys) return { available: false };
    try {
      const names = await caches.keys();
      const out = { available: true, names, urls: {} };
      if (state.settings.capture_cache_storage_urls !== false) {
        for (const name of names.slice(0, 16)) {
          try {
            const c = await caches.open(name);
            const reqs = await c.keys();
            out.urls[name] = reqs.slice(0, 500).map((r) => r.url);
          } catch (_) {}
        }
      }
      return out;
    } catch (e) {
      return { available: false, error: String((e && e.message) || e) };
    }
  }

  async function collectStorageEstimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        return await navigator.storage.estimate();
      }
    } catch (_) {}
    return null;
  }

  function collectScripts() {
    const out = [];
    try {
      const list = document.querySelectorAll("script");
      list.forEach((s) => {
        out.push({
          src: s.src || null,
          type: s.type || null,
          async: !!s.async,
          defer: !!s.defer,
          integrity: s.integrity || null,
          crossorigin: s.crossOrigin || null,
          inlineSize: s.src ? null : (s.textContent || "").length,
        });
      });
    } catch (_) {}
    return out;
  }

  function collectStyles() {
    const out = [];
    try {
      document.querySelectorAll("link[rel=stylesheet]").forEach((l) => {
        out.push({
          kind: "stylesheet",
          href: l.href || null,
          crossorigin: l.crossOrigin || null,
          integrity: l.integrity || null,
          media: l.media || null,
        });
      });
      document.querySelectorAll("style").forEach((s) => {
        out.push({ kind: "inline", size: (s.textContent || "").length });
      });
    } catch (_) {}
    return out;
  }

  async function collectRuntime() {
    const cspMetas = [];
    try {
      document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach((m) => {
        cspMetas.push(m.content);
      });
    } catch (_) {}
    let swRegs = [];
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        const regs = await navigator.serviceWorker.getRegistrations();
        swRegs = regs.map((r) => ({
          scope: r.scope,
          activeUrl: r.active && r.active.scriptURL,
          installingUrl: r.installing && r.installing.scriptURL,
          waitingUrl: r.waiting && r.waiting.scriptURL,
        }));
      }
    } catch (_) {}
    const features = await collectFeatures();
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: Array.from(navigator.languages || []),
      url: location.href,
      referrer: document.referrer,
      title: document.title,
      cspMetaTags: cspMetas,
      trustedTypesPresent: typeof window.trustedTypes !== "undefined",
      serviceWorkers: swRegs,
      features,
    };
  }

  async function collectFeatures() {
    const out = {
      apis: {
        serviceWorker: !!navigator.serviceWorker,
        pushManager:
          !!navigator.serviceWorker &&
          typeof PushManager !== "undefined",
        webRTC: typeof RTCPeerConnection !== "undefined",
        fileSystemAccess: typeof window.showOpenFilePicker === "function",
        paymentRequest: typeof window.PaymentRequest !== "undefined",
        webBluetooth: !!(navigator.bluetooth && navigator.bluetooth.requestDevice),
        webUSB: !!navigator.usb,
        webAuthn: typeof PublicKeyCredential !== "undefined",
        webShare: typeof navigator.share === "function",
        wakeLock: !!navigator.wakeLock,
      },
      permissions: {},
    };
    if (navigator.permissions && navigator.permissions.query) {
      const names = [
        "notifications",
        "geolocation",
        "camera",
        "microphone",
        "clipboard-read",
        "clipboard-write",
        "persistent-storage",
      ];
      for (const name of names) {
        try {
          const r = await navigator.permissions.query({ name });
          out.permissions[name] = r.state;
        } catch (_) {
          out.permissions[name] = "unsupported";
        }
      }
    }
    return out;
  }

  function collectPerformance() {
    const out = { navigation: [], resource: [], paint: [], longtask: [] };
    try {
      out.navigation = performance.getEntriesByType("navigation").map(simplifyEntry);
    } catch (_) {}
    try {
      out.resource = performance.getEntriesByType("resource").slice(0, 1000).map(simplifyEntry);
    } catch (_) {}
    try {
      out.paint = performance.getEntriesByType("paint").map(simplifyEntry);
    } catch (_) {}
    // We deliberately do NOT call performance.getEntriesByType("longtask")
    // — Chrome emits "Deprecated API for given entry type." every time it's
    // called without an active PerformanceObserver. A v0.2 enhancement
    // could install a PerformanceObserver at session start to populate this.
    return out;
  }
  function simplifyEntry(e) {
    const o = {};
    for (const k of Object.keys(e)) {
      try {
        const v = e[k];
        if (typeof v === "function") continue;
        o[k] = v;
      } catch (_) {}
    }
    return o;
  }

  function collectIframeUrls() {
    const out = [];
    try {
      document.querySelectorAll("iframe").forEach((f) => {
        let access = "blocked";
        try {
          // Touching f.contentDocument throws cross-origin.
          if (f.contentDocument) access = "same-origin";
        } catch (_) {
          access = "cross-origin";
        }
        out.push({
          src: f.src || null,
          access,
        });
      });
    } catch (_) {}
    return out;
  }

  function collectSameOriginIframeHTML() {
    const out = [];
    try {
      document.querySelectorAll("iframe").forEach((f) => {
        try {
          if (f.contentDocument && f.contentDocument.documentElement) {
            out.push({
              src: f.src || null,
              html: f.contentDocument.documentElement.outerHTML,
            });
          }
        } catch (_) {}
      });
    } catch (_) {}
    return out;
  }

  async function collectSnapshots() {
    const fu = frameUrl();
    // Synchronous chunks first.
    try {
      emit("snapshot_chunk", {
        kind: "dom",
        payload: { html: document.documentElement.outerHTML, frameUrl: fu },
      });
    } catch (_) {}
    try {
      emit("snapshot_chunk", { kind: "loaded_scripts", payload: { frameUrl: fu, scripts: collectScripts() } });
    } catch (_) {}
    try {
      emit("snapshot_chunk", { kind: "loaded_styles", payload: { frameUrl: fu, styles: collectStyles() } });
    } catch (_) {}
    try {
      emit("snapshot_chunk", { kind: "globals", payload: { frameUrl: fu, ...collectGlobals() } });
    } catch (_) {}
    try {
      emit("snapshot_chunk", { kind: "storage", payload: { frameUrl: fu, ...collectStorage() } });
    } catch (_) {}
    try {
      emit("snapshot_chunk", { kind: "performance", payload: { frameUrl: fu, ...collectPerformance() } });
    } catch (_) {}
    try {
      emit("snapshot_chunk", { kind: "iframes", payload: { frameUrl: fu, iframes: collectIframeUrls() } });
    } catch (_) {}
    try {
      emit("snapshot_chunk", {
        kind: "iframe_html",
        payload: { frameUrl: fu, frames: collectSameOriginIframeHTML() },
      });
    } catch (_) {}

    // Async chunks.
    const [runtime, idb, caches_, estimate] = await Promise.allSettled([
      collectRuntime(),
      collectIDBMeta(),
      collectCacheStorageMeta(),
      collectStorageEstimate(),
    ]);
    try {
      emit("snapshot_chunk", {
        kind: "runtime",
        payload: { frameUrl: fu, ...(runtime.status === "fulfilled" ? runtime.value : { error: String(runtime.reason) }) },
      });
    } catch (_) {}
    try {
      emit("snapshot_chunk", {
        kind: "idb",
        payload: { frameUrl: fu, ...(idb.status === "fulfilled" ? idb.value : { error: String(idb.reason) }) },
      });
    } catch (_) {}
    try {
      emit("snapshot_chunk", {
        kind: "cache_storage",
        payload: { frameUrl: fu, ...(caches_.status === "fulfilled" ? caches_.value : { error: String(caches_.reason) }) },
      });
    } catch (_) {}
    try {
      emit("snapshot_chunk", {
        kind: "storage_estimate",
        payload: { frameUrl: fu, estimate: estimate.status === "fulfilled" ? estimate.value : null },
      });
    } catch (_) {}

    // Done marker — SW uses this to know this frame finished snapshotting.
    emit("snapshot_done", { frameUrl: fu });
  }
})();
