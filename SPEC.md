# WebReconPack — Build Specification

**Version:** 0.1.0
**Status:** Ready to build
**Audience:** A fresh Claude Code (or human) session implementing this from scratch with no prior context.

---

## 1. Purpose

A Chrome MV3 browser extension that produces a **comprehensive context pack** of a website's runtime behavior — network surface, DOM state, JS globals, storage, console output — packaged as a downloadable ZIP. The output is meant to inform the design of targeted automation, scraping, or extraction tools by giving the developer full visibility into how a site actually works, without trial-and-error reverse engineering.

**Mental model:** the user opens an unfamiliar webapp, clicks "Start Recon", interacts naturally for a few minutes, clicks "Stop & Download". They get a single ZIP that answers: *what endpoints exist, what shapes do they have, what state is in the page, what events fire when?*

## 2. Non-goals

- Not a debugger, security scanner, or HAR replacement.
- **Never transmits data anywhere.** All output is local downloads via `chrome.downloads.download()`.
- Not a substitute for DevTools — complementary.
- Not a generic web scraper. Produces *context*, not extracted data.

## 3. High-level architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Tab page (any origin)                 │
│ ┌────────────────────┐    ┌────────────────────────────┐ │
│ │  MAIN-world CS     │    │   Isolated-world CS        │ │
│ │  (main-world.js)   │◄──►│   (isolated.js)            │ │
│ │                    │ ↕  │                            │ │
│ │  • fetch/XHR hooks │ msg│  • chrome.runtime bridge   │ │
│ │  • WS/SSE hooks    │    │  • Receives observations   │ │
│ │  • Console capture │    │  • Forwards to SW          │ │
│ │  • Globals/DOM     │    │                            │ │
│ │    snapshot        │    │                            │ │
│ └────────────────────┘    └────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
                                       │
                                  chrome.runtime
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────┐
│   Service worker (background.js)                         │
│   • Session state (chrome.storage.session)               │
│   • Bundle assembly (JSZip)                              │
│   • Triggers chrome.downloads.download()                 │
└──────────────────────────────────────────────────────────┘
                          ▲
                          │
                    chrome.runtime
                          │
                  ┌───────────────┐
                  │  Popup UI     │
                  │  (popup.html) │
                  └───────────────┘
```

**Why three layers:**
- MAIN world is the only place fetch/XHR/WS hooks see the real `window`. It has no access to `chrome.*` APIs.
- Isolated world has `chrome.runtime` and is on the same DOM, so it bridges MAIN ↔ extension.
- Service worker holds session state (survives popup close) and assembles the final bundle.

## 4. Manifest (manifest.json)

```json
{
  "manifest_version": 3,
  "name": "WebReconPack",
  "version": "0.1.0",
  "description": "Capture a comprehensive context pack of any website's runtime behavior.",
  "permissions": ["activeTab", "scripting", "storage", "downloads", "tabs"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html", "default_icon": "assets/icon-128.png" },
  "icons": { "16": "assets/icon-16.png", "48": "assets/icon-48.png", "128": "assets/icon-128.png" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["isolated.js"],
      "run_at": "document_start",
      "all_frames": true
    },
    {
      "matches": ["<all_urls>"],
      "js": ["main-world.js"],
      "world": "MAIN",
      "run_at": "document_start",
      "all_frames": true
    }
  ],
  "web_accessible_resources": []
}
```

Notes:
- `document_start` is critical — must hook *before* page scripts run so we don't miss bootstrap requests.
- `all_frames: true` so iframes are also covered (many SPAs do work in iframes).
- Both content scripts always loaded; they sit dormant until session starts.

## 5. File structure

```
WebReconPack/
├── manifest.json
├── background.js              Service worker. Session state, bundle assembly, downloads.
├── isolated.js                Content script (isolated world). chrome.runtime bridge.
├── main-world.js              Content script (MAIN world). All hooks live here.
├── popup.html
├── popup.js
├── popup.css
├── options.html               (Optional, can defer to v0.2)
├── options.js
├── lib/
│   └── jszip.min.js           Vendored JSZip 3.10.1. Used in service worker.
├── ui/
│   └── panel.js               (Optional floating panel, off by default)
├── assets/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── README.md                  Build & usage instructions.
└── SPEC.md                    This document.
```

## 6. What gets captured

### 6.1 Network — fetch & XHR
For each request, capture:
- `id` — UUID assigned at start
- `url`, `method`, `status`, `statusText`
- `requestHeaders` — only those visible to JS (set via `headers:`); document the limitation
- `requestBody` — see body capture rules below
- `responseHeaders` — same-origin or CORS-exposed only
- `responseBody` — see body capture rules
- `responseMime` from `Content-Type`
- `timing.start`, `timing.end`, `timing.durationMs`
- `initiator` — caller's stack trace, captured via `new Error().stack` at hook entry. Trim extension frames.
- `source` — `'fetch'` or `'xhr'`
- `frameUrl` — `window.location.href` at time of request (helps when in iframes)

**Body capture rules** (apply to both request and response bodies):

| Body type | Treatment |
|---|---|
| `string` | Inline if ≤ size cap. Detect form-urlencoded (regex `^[A-Za-z][\w.-]*=` + contains `&`) and decode into params. |
| `FormData` | Iterate entries, store as `{type: 'FormData', entries: [[k,v]…]}`. Files: store filename + size. |
| `URLSearchParams` | Iterate entries. |
| `Blob` | Store metadata `{type: 'Blob', size, mime}`; if ≤ size cap, base64-encode. |
| `ArrayBuffer` / typed array | Same — try UTF-8 decode first, fall back to base64. |
| `ReadableStream` | **Do not consume.** Mark `{type: 'ReadableStream', captured: false}` and skip. Consuming would break the request. |
| `null` / `undefined` | Mark `{type: 'none'}`. |

**Body size policy**:
- Inline if ≤ **256 KB**
- Sidecar file if ≤ **50 MB** (`network-bodies/{id}-{req|res}.bin` + reference in JSONL)
- Larger than 50 MB: store first 100 KB + last 100 KB + total size + sha256 of full content

**Critical:** always `response.clone()` before reading. Reading the original consumes the stream and breaks the page.

### 6.2 WebSocket
- Override `window.WebSocket` constructor.
- Capture: URL, subprotocols, frames in (via `addEventListener('message')` on the wrapped instance), frames out (via `send()` interception).
- For each frame: `direction`, `opcode` ('text'|'binary'), `payload` (sampled like bodies above), `timestamp`, `connectionId`.

### 6.3 EventSource (SSE)
- Override `window.EventSource` constructor.
- Capture: URL, each event (`type`, `data`, `lastEventId`, timestamp).

### 6.4 DOM (snapshotted at "stop")
- `documentElement.outerHTML` → `dom.html`
- For each iframe in the tree: src + (if same-origin) recursive content → `dom-iframes/iframe-{n}.html`
- Shadow roots: walk `document.querySelectorAll('*')`, check `.shadowRoot`, capture content (open shadow roots only — closed ones are unreachable).
- All `<script src=>` URLs → `loaded-scripts.json` (deduped, with `async`/`defer`/`type` attributes).
- All `<link rel=stylesheet>` URLs.
- All `<meta>` tags.

### 6.5 JS globals (snapshotted at "stop")
- `Object.keys(window)`
- Subtract a baseline list of standard browser globals — maintain a `STD_GLOBALS` set in code (~500 names: `document`, `console`, `fetch`, `Array`, etc.). Generate this once by running `Object.keys(window)` in a fresh `about:blank` and saving.
- For each remaining global:
  - `name`
  - `type` (typeof)
  - For objects/arrays: a **shape descriptor** — recursive `{key: type|"shape({...})"}` to depth 4, max 6 keys per level
  - **Do NOT capture full values by default** — values may contain secrets
- **Exception: known bootstrap globals get full content** (with size cap):
  - `_docs_flag_initialData`, `WIZ_global_data` (Google)
  - `__INITIAL_STATE__`, `__PRELOADED_STATE__` (Redux/SSR)
  - `__NEXT_DATA__` (Next.js)
  - `__NUXT__` (Nuxt)
  - `__APOLLO_STATE__` (Apollo)
  - `_sharedData` (older Instagram-style)
  - Maintain this list as `BOOTSTRAP_GLOBALS` in code; user can extend via options.

### 6.6 Storage (snapshotted at "stop")
- `localStorage`: all keys + values, value cap 100 KB each
- `sessionStorage`: same
- `document.cookie`: full string (note: HttpOnly cookies are invisible to JS — document this)
- `indexedDB.databases()` → list of `{name, version}`. For each: open and list `objectStoreNames`. **Do not dump records by default** — privacy/size. Add a setting "include IDB record samples" (default off).

### 6.7 Console feed (during session)
Wrap `console.{log, info, warn, error, debug}`:
- Forward to original
- Capture `{level, args (best-effort serialized), timestamp, source: 'console'}`

Add window listeners:
- `addEventListener('error', e => …)` — uncaught errors
- `addEventListener('unhandledrejection', e => …)` — promise rejections

### 6.8 Runtime metadata
- `userAgent`, `platform`, `languages`
- Page `URL`, `referrer`, `title`
- CSP: parse from response headers of main document (capture during the very first navigation request) **and** `<meta http-equiv="content-security-policy">` tags
- Trusted Types: presence of `window.trustedTypes`, list of policy names attempted to register (we can only see these if we hook `trustedTypes.createPolicy` early)
- Service workers: `navigator.serviceWorker.getRegistrations()` → scope + scriptURL of each
- Performance: capture `performance.getEntriesByType('navigation')`, `'resource'`, `'paint'`, `'longtask'`

### 6.9 Timeline
A unified, chronological log of every event for replay/analysis. One JSONL line per event with `{t, kind, ref}` where `kind` ∈ `{request_start, request_end, ws_open, ws_frame, console, dom_mutation_summary, navigation}` and `ref` is an ID into the relevant detail file.

DOM mutations: don't capture every mutation (overwhelming). Use a `MutationObserver` on `document.body` and emit summary events every 1000 ms: `{nodesAdded, nodesRemoved, attributesChanged, characterDataChanged}`.

## 7. Output bundle

Single ZIP downloaded to user's downloads folder.

**Filename:** `recon-{hostname}-{YYYYMMDD-HHMMSS}.zip`

**Contents:**
```
summary.md              Human-readable overview (template below).
manifest.json           Session metadata: start/end, URL, settings, counts.
network.jsonl           One JSON object per line, one per request.
network-bodies/         Sidecar files for large bodies.
  {id}-req.bin
  {id}-res.bin
websockets.jsonl        One per connection (frames inline, capped).
sse.jsonl               One per EventSource.
dom.html                Full snapshot at stop time.
dom-iframes/
  iframe-{n}.html       Same-origin iframe contents.
loaded-scripts.json     All <script src=>.
loaded-styles.json      All <link rel=stylesheet>.
globals.json            Window keys + shape descriptors + bootstrap blobs.
storage.json            localStorage, sessionStorage, cookies, IDB names.
console.jsonl           Console feed.
runtime.json            UA, CSP, TT, SW, page metadata.
performance.json        Navigation/resource/paint/longtask entries.
timeline.jsonl          Unified event stream.
```

**Format choice:** JSONL (newline-delimited JSON) over single JSON for: streamability during capture, append-friendliness, easier diffing with standard tools (`grep`, `jq -s`).

### 7.1 `summary.md` template

The implementer should generate this from the captured data. Use this as a guide:

```markdown
# Recon Pack: example.com
**Captured:** 2026-05-10 14:23:00 → 14:25:33 (153s, 2m33s)
**Tab:** https://example.com/dashboard
**User agent:** Mozilla/5.0 ...
**Settings:** {auto_stop: off, redact_secrets: on, capture_idb_records: off}

## At a glance
- **187** network requests across **12** distinct endpoints
- **4** WebSocket connections, **1,432** frames
- **2,341** console messages (12 errors, 47 warnings)
- **312** window globals (87 likely site-specific)
- **6** bootstrap blobs detected

## Top endpoints by request count
| Endpoint | Method | Count | Avg req size | Avg res size |
|---|---|---|---|---|
| /api/data | POST | 47 | 245 B | 12 KB |
| /track | POST | 23 | 1.2 KB | 0 B |
...

## Detected response patterns
For each, list endpoints where it was detected:
- `)]}'` XSRF prefix → JSON: `/api/data`, `/api/list`
- WIZ batchexecute frames `[["wrb.fr",...]]`: `/_/MyApp/data/batchexecute`
- Length-prefixed streaming `<seq>&<len>&<json>`: `/streamrows`
- Form-urlencoded request bodies: `/api/auth`, `/track`

## Bootstrap globals
- `__INITIAL_STATE__` — object, ~120 KB, top keys: user, prefs, routes, ...
- `_docs_flag_initialData` — object, ~8 KB
- ...

## CSP & Trusted Types
- CSP: `default-src 'self'; script-src 'self' 'unsafe-inline' …`
- Trusted Types: enforced. Policies registered: `goog#html`, `default`.

## Service workers
- Scope `/`, script `/sw.js`

## Suggested next steps
[Tool generates 3-5 hypotheses based on captured patterns. Examples:]
- "47 POSTs to /api/data with form-urlencoded bodies. Inspect a body in network.jsonl to see if it contains a row range / filter / pagination param."
- "/streamrows uses non-JSON chunk framing. Parser will need to read `<seq>&<len>&<json>` segments."
- "`__INITIAL_STATE__.user.id` exists — likely contains the auth context."
```

## 8. UI

### Popup (`popup.html`)
States: `idle`, `recording`, `finalizing`, `ready_to_download`.

**Idle:**
- Title and version
- "Start recon on this tab" (primary button)
- Settings disclosure: auto-stop time, body size cap, secret redaction toggle, include IDB records

**Recording:**
- Live counters (poll service worker every 1s):
  - Requests captured
  - WebSocket frames
  - Console messages
  - Estimated bundle size
- "Stop & Download" (primary)
- "Cancel" (discards session)

**Finalizing:**
- Progress message ("Assembling bundle…")
- Spinner

**Ready to download:**
- "Download Pack" (primary)
- Stats summary
- "Start new session"

**Important:** popup may close while session is recording. State lives in service worker. On popup reopen, query SW for current state and re-render.

## 9. Behavior specs

### 9.1 Lifecycle
1. **Idle** — content scripts loaded but inert. No buffering.
2. **Recording** — `recording: true` flag in `chrome.storage.session`. All hooks active. Observations forwarded to SW. SW writes to in-memory ring buffer (with byte cap) and periodically flushes large items to `chrome.storage.session`.
3. **Finalizing** — stop signal received. SW asks content scripts for final snapshots (DOM, globals, storage). All data collected. JSZip assembles bundle. `chrome.downloads.download()` triggers.
4. **Ready** — bundle downloaded. SW retains stats for the popup; user can clear / start new session.

### 9.2 Reentrancy
- MAIN-world hooks must be idempotent: check `window.__WebReconPack_loaded` flag before installing.
- SPA navigation (no full reload) — content scripts stay loaded. Hooks continue. Note navigation as a timeline event.
- Full page reload — content scripts re-inject at `document_start`. New hooks installed. Continue session if `recording: true` is set in `chrome.storage.session`.

### 9.3 Cross-tab
**v0.1: single active session at a time.**
- Starting on tab B while tab A is recording → confirm dialog → stop A's session (download partial), start B.
- Track active tab in `chrome.storage.session.activeReconTab`.

### 9.4 Stop during in-flight requests
- Stop signal flushes pending observations.
- Requests that complete *after* stop are discarded — except if they're the very last batch within 500 ms grace period.

### 9.5 Privacy & redaction
- **Default redaction list** (when `redact_secrets: true`):
  - Header: `Authorization`, `Cookie`, `X-Auth-Token`, `X-API-Key` → replace value with `[REDACTED]`
  - Request body params matching `/(password|api[_-]?key|secret|token|sapisid|authuser)=([^&]+)/i` → redact value
  - Cookies in `document.cookie` capture: redact values, keep names
- Show capture summary on stop: "Captured X requests from Y origins. {count} secrets redacted." User confirms before download.

## 10. Critical implementation gotchas

These will bite the implementer. Read carefully before coding.

### 10.1 Trusted Types (CRITICAL)
Many sites enforce `require-trusted-types-for 'script'` CSP. This blocks `innerHTML = '...'` everywhere — **including** the extension's own injected UI on the page.

**Mitigations:**
- Build all on-page UI with `document.createElement` + `textContent` + property assignments. Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write` for assignment.
- The extension popup is in its own document (extension origin) and is NOT subject to the host's CSP. innerHTML there is fine.
- If absolutely needed, `trustedTypes.createPolicy('webreconpack', {createHTML: s => s})` may work — but the host's `trusted-types <list>` directive may block unlisted policies. Test and have a DOM-construction fallback.

### 10.2 MAIN world isolation
- `chrome.runtime` is **undefined** in MAIN world. Use `window.postMessage` or `dispatchEvent(new CustomEvent(...))` to talk to isolated world.
- The page can also `postMessage` — filter by a known `type` field and ignore everything else.
- For the inverse direction (isolated → MAIN), use `CustomEvent` on a known target.

### 10.3 Response body cloning
**Always:**
```js
const cloned = response.clone();
cloned.text().then(processBody);
return response; // unchanged
```
Reading `response.body` directly consumes the stream and breaks the page.

### 10.4 Request body — ReadableStream
`init.body` may be a ReadableStream (rare but real, e.g. file upload streams). It's consume-once. To capture safely you'd `tee()` and feed one branch back to fetch — complex and bug-prone. **For v0.1, skip with `{type: 'ReadableStream', captured: false}`.**

### 10.5 Headers visibility
- Request headers set explicitly via `init.headers` are visible.
- Browser-set headers (Cookie, User-Agent, Origin, etc.) are **not visible to JS** at all.
- Response headers visible only for same-origin or via `Access-Control-Expose-Headers`.
- Document this in `summary.md` so users don't think we missed something.

### 10.6 Console output truncation in DevTools
Chrome DevTools truncates strings > ~100 chars in tables and ~10 KB in arrays. Do not rely on `console.log` for surfacing capture data to users — go through downloads. Console hooks are for *capturing* the page's console, not displaying ours.

### 10.7 WebSocket constructor wrapping
```js
const NativeWS = window.WebSocket;
window.WebSocket = function(url, protocols) {
  const ws = new NativeWS(url, protocols);
  // hook events on ws here, intercept ws.send via property override
  return ws;
};
window.WebSocket.prototype = NativeWS.prototype;
window.WebSocket.CONNECTING = 0; // also CLOSING, OPEN, CLOSED
```

### 10.8 EventSource
Same pattern as WebSocket.

### 10.9 Memory pressure
A 5-minute session on a busy site can produce hundreds of MB of body data. Mitigations:
- Hard cap on total bytes captured per session (default 200 MB; configurable). On hit: stop capturing bodies, keep capturing metadata.
- Stream large bodies to `chrome.storage.session` (limited to 10 MB total — too small) — better: keep in SW memory but flush old items if cap approached.
- Consider using `OffscreenDocument` for very large session data, but probably not needed for v0.1.

### 10.10 Service worker lifecycle
MV3 service workers are short-lived (terminate after ~30s idle). Use `chrome.runtime.onConnect` long-lived ports from content scripts to keep SW alive during recording. Or: have content script ping every 20s to reset the timer.

### 10.11 Hook timing
`document_start` fires before page scripts. But if the user enables recording *after* the page loaded, you've missed bootstrap requests. Recording always installs hooks; the *recording flag* gates whether observations are forwarded to SW. So hooks run from page load even when not recording — minimal overhead, but means: starting a session mid-page captures ongoing activity, not history.

### 10.12 Cookies / HttpOnly
Cookies marked `HttpOnly` are invisible to `document.cookie`. We can't capture them. Document this clearly.

## 11. Build & run instructions

For the implementer:

1. `cd /path/to/WebReconPack`
2. Download JSZip 3.10.1 from `https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js` to `lib/jszip.min.js` (≈100 KB). **Vendor it; don't load from CDN at runtime** (CSP would block on many sites).
3. Generate placeholder PNG icons (16/48/128) — any solid color is fine for dev. A simple Python script with `zlib`+`struct` can produce a valid PNG without dependencies.
4. Implement files per spec.
5. Open `chrome://extensions` → enable "Developer mode" → "Load unpacked" → select project directory.
6. Pin the icon to the toolbar.
7. Open any site, click the icon, **Start**, interact, **Stop & Download**.

## 12. Definition of done (acceptance criteria)

The extension is "v0.1 complete" when, after running it on `https://docs.google.com/spreadsheets/d/{any-sheet}/edit` for 60 seconds with normal interaction (scroll, click cells, switch tabs):

- [ ] The downloaded ZIP contains every file type listed in §7.
- [ ] `network.jsonl` has at least one entry per `/renderdata`, `/streamrows`, `batchexecute` URL with full request body and response body (or sidecar reference if large).
- [ ] At least one `/streamrows` entry has a request body that, when URL-decoded, shows `chunks=[…]` and `snapshotAt=…` parameters in human-readable form.
- [ ] `globals.json` includes `_docs_flag_initialData` with both shape descriptor and content.
- [ ] `summary.md` correctly identifies:
  - The `)]}'` XSRF prefix on JSON responses
  - The `<seq>&<len>&<json>` chunk pattern on `/streamrows`
- [ ] `dom.html` opens in a browser and renders the captured page structure (best-effort; styling won't all work without the asset URLs).
- [ ] No errors thrown by extension code on the page (Trusted Types compliance verified).
- [ ] The host page still works normally during recording (sheets loads, scrolls, switches tabs without breakage).
- [ ] Stop button works while requests are in flight (no hang > 2s).
- [ ] Bundle size for a 60-second sheets session is < 100 MB with default caps.
- [ ] Popup correctly reflects state across close/reopen cycles.

## 13. Stretch features (out of scope for v0.1)

- HAR (HTTP Archive) export compatibility
- Multi-tab parallel sessions
- Continuous sessions across full-page navigations
- Time-travel replay UI
- Diff between two recon packs
- Auto-generated Postman collection / OpenAPI sketch
- Source map fetching for un-minified function names
- Capture of `Worker` / `SharedWorker` / `ServiceWorker` internal traffic
- Filter rules during capture (only capture URLs matching X)
- "Recipe" generation — given a recon pack, suggest a reverse-engineering script

## 14. Testing notes

Useful test sites for shakedown:
- **Google Sheets** (`docs.google.com/spreadsheets/d/.../edit`) — Trusted Types, MAIN-world critical, complex chunked formats. Best stress test.
- **GitHub** (`github.com/anthropics/anthropic-sdk-typescript`) — TT enforced, lots of GraphQL, modern SPA.
- **Twitter/X** — heavy WebSocket usage.
- **A simple static site** — control case to confirm no false positives.
- A site you control where you can inspect what *should* be captured vs what was.

Edge cases to verify:
- Same-page anchor navigation doesn't reset session
- Closing popup mid-recording doesn't lose data
- Page that does a `window.fetch` reassignment after our hook (we should still see calls if we `Object.defineProperty` correctly)
- Page that uses `navigator.sendBeacon` (wrap that too if observed; document if not)
- Page in incognito (extension must declare incognito mode in manifest if needed)

## 15. Out-of-band concerns

- **Permissions UX**: `<all_urls>` is a broad permission. The extension store will warn users. Document why it's needed in README.
- **Performance**: hook overhead should be < 1 ms per request in steady state. Use no-op fast paths when `recording: false`.
- **Versioning the bundle format**: include a `format_version: "0.1"` field in `manifest.json` of the bundle. Future tools that consume packs can branch on it.

---

**End of spec.** The implementer should read this once end-to-end, then build incrementally: manifest + skeleton → fetch hook → output bundle (text-only) → XHR → bodies → DOM/globals snapshot → WebSocket → SSE → console → polish UI → test against §12 acceptance criteria.

When in doubt, prefer correctness over completeness. A pack that captures 80% of network with 100% fidelity is more useful than one that captures 100% of network with garbage encoding.
