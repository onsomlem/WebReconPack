// WebReconPack — popup controller. Renders SW state, handles lifecycle
// buttons + conflict resolution + ready/error panels + settings. The popup
// is non-authoritative; it polls the SW every 1s while open and re-queries
// on every reopen (spec §27).

(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    state: $("state"),
    tab: $("tab"),
    durationRow: $("durationRow"),
    duration: $("duration"),
    sessionId: $("sessionId"),
    firstRunWarning: $("firstRunWarning"),
    ackBtn: $("ackBtn"),
    counts: $("counts"),
    countList: $("countList"),
    capRow: $("capRow"),
    startBtn: $("startBtn"),
    stopBtn: $("stopBtn"),
    cancelBtn: $("cancelBtn"),
    settingsToggle: $("settingsToggle"),
    settingsPanel: $("settingsPanel"),
    conflict: $("conflict"),
    conflictTabId: $("conflictTabId"),
    conflictStop: $("conflictStop"),
    conflictCancel: $("conflictCancel"),
    ready: $("ready"),
    readyFilename: $("readyFilename"),
    newSessionBtn: $("newSessionBtn"),
    errorPanel: $("errorPanel"),
    errorMsg: $("errorMsg"),
    clearErrorBtn: $("clearErrorBtn"),
    presetSelect: $("presetSelect"),
    presetHint: $("presetHint"),
    setRedact: $("setRedact"),
    setReqBodies: $("setReqBodies"),
    setRespBodies: $("setRespBodies"),
    setUserMeta: $("setUserMeta"),
    setInputValues: $("setInputValues"),
    setClipboardValues: $("setClipboardValues"),
    setCacheUrls: $("setCacheUrls"),
  };

  let pollHandle = null;
  let pendingConflict = null;

  function send(type, extra) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...(extra || {}) }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(resp);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function safeHostname(url) {
    try {
      return new URL(url).hostname || "—";
    } catch (_) {
      return "—";
    }
  }

  function renderCounts(counts, capHit) {
    if (!counts) {
      els.counts.classList.add("hidden");
      els.countList.replaceChildren();
      return;
    }
    els.counts.classList.remove("hidden");
    els.capRow.classList.toggle("hidden", !capHit);
    const frag = document.createDocumentFragment();
    for (const [k, v] of Object.entries(counts)) {
      const li = document.createElement("li");
      const ks = document.createElement("span");
      ks.className = "k";
      ks.textContent = k;
      const vs = document.createElement("span");
      vs.textContent = String(v);
      li.append(ks, vs);
      frag.appendChild(li);
    }
    els.countList.replaceChildren(frag);
  }

  function applySettings(s) {
    if (!s) return;
    els.setRedact.checked = !!s.redact_secrets;
    els.setReqBodies.checked = !!s.capture_request_bodies;
    els.setRespBodies.checked = !!s.capture_response_bodies;
    els.setUserMeta.checked = !!s.capture_user_event_metadata;
    els.setInputValues.checked = !!s.capture_input_values;
    els.setClipboardValues.checked = !!s.capture_clipboard_values;
    els.setCacheUrls.checked = !!s.capture_cache_storage_urls;
    if (s.capture_preset && els.presetSelect.value !== s.capture_preset) {
      els.presetSelect.value = s.capture_preset;
    }
    const hints = {
      light: "Light: metadata only — no request/response bodies, smallest caps.",
      standard: "Standard: bodies + storage values within 256 KB / 50 MB caps.",
      deep: "Deep: 1 MB inline / 200 MB total caps, IDB records, larger globals.",
    };
    els.presetHint.textContent = hints[s.capture_preset] || "Standard is the spec default.";
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "0s";
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${String(rm).padStart(2, "0")}m ${String(rs).padStart(2, "0")}s`;
  }

  function applyState(snapshot) {
    if (!snapshot) {
      els.state.textContent = "(no service worker)";
      return;
    }
    const state = snapshot.state || "idle";
    els.state.textContent = state;

    const t = snapshot.activeTab;
    els.tab.textContent = t ? `${safeHostname(t.url)} · tab ${t.id}` : "—";
    els.tab.title = t && t.url ? t.url : "";

    els.sessionId.textContent = (snapshot.session && snapshot.session.session_id) || "—";

    if (snapshot.session) {
      renderCounts(snapshot.session.counts, snapshot.session.body_cap_hit);
      // Live duration timer — shown while recording or finalizing.
      const startedMs = Date.parse(snapshot.session.started_at);
      if (Number.isFinite(startedMs) && (state === "recording" || state === "finalizing")) {
        els.durationRow.hidden = false;
        els.duration.textContent = formatDuration(Date.now() - startedMs);
      } else {
        els.durationRow.hidden = true;
      }
    } else {
      renderCounts(null, false);
      els.durationRow.hidden = true;
    }

    if (snapshot.firstRunAcknowledged) {
      els.firstRunWarning.classList.add("hidden");
    } else {
      els.firstRunWarning.classList.remove("hidden");
    }

    applySettings(snapshot.settings);

    // Lifecycle buttons by state
    const ackd = !!snapshot.firstRunAcknowledged;
    els.startBtn.classList.add("hidden");
    els.stopBtn.classList.add("hidden");
    els.cancelBtn.classList.add("hidden");
    els.ready.classList.add("hidden");
    els.errorPanel.classList.add("hidden");
    els.conflict.classList.toggle("hidden", !pendingConflict);

    if (state === "idle") {
      els.startBtn.classList.remove("hidden");
      els.startBtn.disabled = !ackd;
      els.startBtn.title = ackd ? "" : "Acknowledge the warning first.";
    } else if (state === "recording") {
      els.stopBtn.classList.remove("hidden");
      els.cancelBtn.classList.remove("hidden");
    } else if (state === "finalizing") {
      els.stopBtn.classList.remove("hidden");
      els.stopBtn.disabled = true;
      els.stopBtn.textContent = "Assembling bundle…";
    } else if (state === "ready") {
      els.ready.classList.remove("hidden");
    } else if (state === "error") {
      els.errorPanel.classList.remove("hidden");
      const w = snapshot.session && snapshot.session.warnings;
      els.errorMsg.textContent = w && w.length ? w.join("; ") : "Unknown error.";
    }

    // Reset transient stop button label when we're not finalizing.
    if (state !== "finalizing") {
      els.stopBtn.disabled = false;
      els.stopBtn.textContent = "Stop & Download";
    }
  }

  async function refresh() {
    const snapshot = await send("popup:getState");
    applyState(snapshot);
  }

  // ---- Wire events -----------------------------------------------------
  els.ackBtn.addEventListener("click", async () => {
    await send("popup:acknowledgeFirstRun");
    refresh();
  });

  els.startBtn.addEventListener("click", async () => {
    const r = await send("popup:start");
    if (r && r.ok === false && r.reason === "already_recording_other_tab") {
      pendingConflict = r;
      els.conflictTabId.textContent = String(r.existingTabId);
    } else {
      pendingConflict = null;
    }
    refresh();
  });

  els.stopBtn.addEventListener("click", async () => {
    els.stopBtn.disabled = true;
    els.stopBtn.textContent = "Stopping…";
    const r = await send("popup:stop");
    if (r && r.filename) {
      els.readyFilename.textContent = r.filename;
    }
    refresh();
  });

  els.cancelBtn.addEventListener("click", async () => {
    await send("popup:cancel");
    refresh();
  });

  els.newSessionBtn.addEventListener("click", async () => {
    await send("popup:resetReady");
    refresh();
  });

  els.clearErrorBtn.addEventListener("click", async () => {
    await send("popup:resetReady");
    refresh();
  });

  els.conflictStop.addEventListener("click", async () => {
    await send("popup:resolveConflict", { action: "stop_existing" });
    pendingConflict = null;
    // Now retry start.
    await send("popup:start");
    refresh();
  });
  els.conflictCancel.addEventListener("click", async () => {
    await send("popup:resolveConflict", { action: "cancel_existing" });
    pendingConflict = null;
    await send("popup:start");
    refresh();
  });

  els.settingsToggle.addEventListener("click", (e) => {
    e.preventDefault();
    els.settingsPanel.classList.toggle("hidden");
  });

  function bindSettingToggle(el, key) {
    el.addEventListener("change", async () => {
      await send("popup:updateSettings", { settings: { [key]: el.checked } });
      refresh();
    });
  }
  bindSettingToggle(els.setRedact, "redact_secrets");
  bindSettingToggle(els.setReqBodies, "capture_request_bodies");
  bindSettingToggle(els.setRespBodies, "capture_response_bodies");
  bindSettingToggle(els.setUserMeta, "capture_user_event_metadata");
  bindSettingToggle(els.setInputValues, "capture_input_values");
  bindSettingToggle(els.setClipboardValues, "capture_clipboard_values");
  bindSettingToggle(els.setCacheUrls, "capture_cache_storage_urls");

  els.presetSelect.addEventListener("change", async () => {
    await send("popup:setPreset", { preset: els.presetSelect.value });
    refresh();
  });

  // ---- Lifecycle -------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    refresh();
    pollHandle = setInterval(refresh, 1000);
  });
  window.addEventListener("unload", () => {
    if (pollHandle) clearInterval(pollHandle);
  });
})();
