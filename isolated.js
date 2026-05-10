// WebReconPack — isolated-world content script.
// Per spec §7.2: validate every page message, forward observations to the
// service worker over a long-lived port, reconnect on disconnect, and relay
// commands from the SW back to the MAIN-world script.

(() => {
  const MARKER = "__WebReconPack__";
  const EVENT_OUT = "webreconpack:obs"; // MAIN -> isolated
  const EVENT_IN = "webreconpack:cmd"; // isolated -> MAIN

  let port = null;
  let reconnectTimer = null;
  // Buffer observations that arrive while the port is down (e.g. SW restart
  // mid-recording). Bounded to avoid runaway memory in catastrophic cases.
  const pendingQueue = [];
  const MAX_PENDING = 5000;

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: "webreconpack" });
    } catch (_) {
      port = null;
      return;
    }
    try {
      port.postMessage({
        type: "frame_hello",
        url: location.href,
        isTop: window.top === window,
        t: new Date().toISOString(),
      });
    } catch (_) {}

    // Drain any queued observations.
    if (pendingQueue.length) {
      const drain = pendingQueue.splice(0, pendingQueue.length);
      for (const m of drain) {
        if (!safePost(m)) {
          // If we couldn't post, push the rest back and stop.
          pendingQueue.unshift(...drain.slice(drain.indexOf(m)));
          break;
        }
      }
    }

    port.onDisconnect.addListener(() => {
      // ALWAYS read lastError — leaving it unread causes Chrome to log
      // "Unchecked runtime.lastError" warnings. The most common cause here
      // is bfcache eviction ("page moved into back/forward cache") which is
      // expected, not an error condition.
      const _ = chrome.runtime.lastError;
      port = null;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          // If the page is currently bfcached, document is hidden + frozen.
          // chrome.runtime.connect would still work but produce another
          // immediate disconnect. Defer reconnect until the page resumes.
          if (document.visibilityState === "hidden" && document.wasDiscarded) {
            // Page is essentially gone; do nothing.
            return;
          }
          connectPort();
        }, 1000);
      }
    });

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      // SW commands like start_session / stop_session / collect_snapshot are
      // forwarded to MAIN via the strict CustomEvent bridge.
      relayToPage(msg);
    });
  }

  function safePost(msg) {
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (_) {
      port = null;
      return false;
    }
  }

  function enqueue(msg) {
    if (pendingQueue.length >= MAX_PENDING) {
      // Drop oldest to bound memory.
      pendingQueue.shift();
    }
    pendingQueue.push(msg);
  }

  function send(msg) {
    if (!safePost(msg)) enqueue(msg);
  }

  function isValidPageMessage(detail) {
    return (
      detail &&
      typeof detail === "object" &&
      detail.marker === MARKER &&
      typeof detail.type === "string"
    );
  }

  // ---- MAIN -> SW --------------------------------------------------------
  window.addEventListener(
    EVENT_OUT,
    (e) => {
      const detail = e.detail;
      if (!isValidPageMessage(detail)) return;
      send({
        type: "observation",
        obsType: detail.type,
        data: detail.data,
        t: detail.t || new Date().toISOString(),
        frameUrl: location.href,
      });
    },
    false
  );

  // ---- SW -> MAIN --------------------------------------------------------
  function relayToPage(msg) {
    try {
      const evt = new CustomEvent(EVENT_IN, {
        detail: { marker: MARKER, type: msg.type, data: msg.data || null },
      });
      window.dispatchEvent(evt);
    } catch (_) {}
  }

  // bfcache: reconnect on page resume.
  document.addEventListener("resume", () => {
    if (!port && !reconnectTimer) connectPort();
  });
  // pageshow with persisted=true means we just came back from bfcache.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && !port && !reconnectTimer) connectPort();
  });

  // ---- Boot --------------------------------------------------------------
  connectPort();
})();
