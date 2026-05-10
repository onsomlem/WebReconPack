# WebReconPack — Tightened Build Specification

**Version:** 0.1.2  
**Status:** Locked comprehensive v0.1 build spec  
**Audience:** Claude Code, agentic coder, or human implementer building from scratch.

---

## 0. Lock-In Decision

WebReconPack v0.1 is not trying to be a perfect DevTools replacement, security scanner, HAR exporter, or universal website recorder.

**v0.1 mission:**  
Build a reliable Chrome MV3 extension that records a user-controlled browsing session and exports a local ZIP containing enough runtime context to understand how a website works.

The priority order is:

1. Do not break the host page.
2. Capture fetch/XHR/sendBeacon accurately.
3. Capture the user-action timeline that caused runtime behavior.
4. Export a valid ZIP every time.
5. Produce useful summaries and pattern intelligence.
6. Preserve state when popup closes/reopens.
7. Work on complex SPAs such as Google Sheets.
8. Add deeper internal worker capture, HAR export, and recipe generation after the core path is stable.

Correct 80% capture with high fidelity is better than unstable 100% capture.

v0.1 is considered comprehensive when the pack can explain:

- what network calls happened
- what user actions likely triggered them
- what route/navigation changes occurred
- what runtime state existed at stop time
- what scripts/styles/chunks loaded
- what storage/cookies/globals existed
- what console/errors happened
- what realtime channels fired
- what exports/download/object URLs were created
- what major app/framework patterns were detected

---

## 1. Purpose

WebReconPack is a local-first Chrome Manifest V3 browser extension that captures a comprehensive context pack of a website's runtime behavior.

The user flow:

1. User opens a target website.
2. User clicks the WebReconPack extension.
3. User clicks **Start Recon**.
4. User interacts naturally with the page.
5. User clicks **Stop & Download**.
6. Extension downloads a ZIP containing network logs, DOM state, globals, storage, console output, runtime metadata, and a human-readable summary.

The output is meant to help a developer understand how a webapp behaves before building authorized automation, scraping, debugging, or extraction tooling.

---

## 2. Non-Goals

WebReconPack is not:

- a vulnerability scanner
- an exploit tool
- a credential harvester
- a HAR replacement in v0.1
- a generic web scraper
- a remote telemetry system
- a cloud service
- a bypass for authentication, authorization, rate limits, or access controls

It never transmits captured data anywhere.

All output is local and user-triggered through `chrome.downloads.download()`.

---

## 3. Usage Boundary

Recon packs may contain sensitive data, including visible cookies, local/session storage, request bodies, response bodies, user data, account data, app state, and internal endpoint structure.

The extension must show this warning before first use:

```text
Recon packs may contain sensitive page data, visible cookies, storage values, request bodies, response bodies, and account-specific runtime state.

Use only on sites, accounts, and applications you own, administer, or are authorized to inspect.

Keep downloaded ZIPs private unless you review and redact them first.
```

The user must acknowledge before starting the first session.

---

## 4. High-Level Architecture

```text
Tab page
├── MAIN-world content script
│   ├── fetch hook
│   ├── XHR hook
│   ├── WebSocket hook
│   ├── EventSource hook
│   ├── console/error hooks
│   ├── DOM snapshot collector
│   ├── globals collector
│   └── storage/runtime collector
│
├── Isolated-world content script
│   ├── validates page messages
│   ├── bridges MAIN world to extension runtime
│   ├── keeps long-lived port to service worker
│   └── forwards commands from SW to MAIN world
│
└── Service worker
    ├── owns session state
    ├── owns settings
    ├── owns counters
    ├── stores capture buffers with byte caps
    ├── assembles ZIP with JSZip
    └── triggers chrome.downloads.download()

Popup UI
├── renders current state
├── starts/stops/cancels sessions
├── polls stats
└── never owns authoritative state
```

### Why three layers exist

- MAIN world can wrap the real page APIs.
- MAIN world cannot use `chrome.*`.
- Isolated world can use `chrome.runtime`.
- Service worker owns session state and download generation.
- Popup can close at any time and must not own critical state.

---

## 5. File Structure

```text
WebReconPack/
├── manifest.json
├── background.js
├── isolated.js
├── main-world.js
├── popup.html
├── popup.js
├── popup.css
├── README.md
├── SPEC.md
├── lib/
│   └── jszip.min.js
└── assets/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

Optional/deferred:

```text
options.html
options.js
ui/panel.js
```

Do not build optional files in Phase 0 unless the core extension already works.

---

## 6. Manifest

```json
{
  "manifest_version": 3,
  "name": "WebReconPack",
  "version": "0.1.2",
  "description": "Capture a local ZIP context pack of a website's runtime behavior.",
  "permissions": ["activeTab", "scripting", "storage", "downloads", "tabs"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": "assets/icon-128.png"
  },
  "icons": {
    "16": "assets/icon-16.png",
    "48": "assets/icon-48.png",
    "128": "assets/icon-128.png"
  },
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
  ]
}
```

### v0.1 decision

Do **not** add `webRequest` in v0.1.

Reason: it increases permission sensitivity and complexity. Main document CSP response headers will not be fully captured in v0.1 unless visible through fetch/XHR or meta tags.

Add `webRequest` in v0.2 if needed.

---

## 7. Module Responsibilities

### 7.1 main-world.js

Responsibilities:

- Install hooks idempotently.
- Observe runtime behavior.
- Serialize observations safely.
- Emit observations to isolated world.
- Respond to snapshot requests.
- Never call `chrome.*`.
- Never use extension-only APIs.
- Never assume page objects are trustworthy.
- Never break native page behavior.

Rules:

- Check `window.__WebReconPack_loaded` before installing.
- Use `CustomEvent` or `window.postMessage` with strict message shape.
- Do not use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write`.
- Do not consume original request/response streams.
- On capture failure, record an error field and preserve page behavior.

### 7.2 isolated.js

Responsibilities:

- Listen for MAIN-world events.
- Validate all event messages.
- Forward valid observations to service worker.
- Receive SW commands.
- Forward start/stop/snapshot commands to MAIN world.
- Maintain long-lived `chrome.runtime.connect()` port while recording.
- Reconnect the port if disconnected.

Rules:

- Ignore all messages without the exact WebReconPack marker.
- Never trust arbitrary page messages.
- Attach frame identity to observations where possible.

### 7.3 background.js

Responsibilities:

- Own authoritative session state.
- Own settings.
- Own capture buffers.
- Own counters.
- Enforce byte caps.
- Apply redaction.
- Assemble ZIP.
- Trigger downloads.
- Handle popup queries.
- Handle single active session rule.

Rules:

- Use `chrome.storage.session` only for small session metadata, settings, active tab, and state.
- Do not use `chrome.storage.session` as the main body/log storage.
- Keep capture data in memory for v0.1 with hard caps.
- If caps are hit, disable body capture first and continue metadata capture.
- Never allow a failed snapshot from one frame to fail the whole bundle.

### 7.4 popup.js

Responsibilities:

- Render idle/recording/finalizing/ready/error states.
- Start session.
- Stop and download session.
- Cancel session.
- Poll stats every 1 second while open.
- Show first-run sensitive data warning.
- Show redaction/capture settings.

Rules:

- Popup is not authoritative.
- Popup close must not stop recording.
- Popup reopen must recover current state from service worker.

---

## 8. Session Lifecycle

States:

```text
idle
recording
finalizing
ready
error
```

### 8.1 Idle

- Hooks are installed but gated.
- No observations forwarded unless recording flag is true.
- Popup shows Start button.

### 8.2 Recording

- `recording: true`
- `activeReconTab` set.
- Content scripts forward observations.
- Service worker increments counters.
- Long-lived ports keep SW alive.
- Popup shows live stats.

### 8.3 Finalizing

- Stop signal sent.
- 500ms grace period for final in-flight observations.
- SW requests snapshots from all active frames.
- SW assembles ZIP.
- Download starts.

### 8.4 Ready

- Download completed or triggered.
- Stats retained.
- User can start a new session.

### 8.5 Error

- Show the failure reason.
- Preserve partial session if possible.
- Allow user to download partial pack if bundle assembly succeeded enough to produce files.

---

## 9. Single Active Session Rule

v0.1 supports one active session at a time.

If user starts on Tab B while Tab A records:

Default behavior:

1. Prompt: "A recon session is already recording in another tab."
2. Options:
   - Stop & Download existing session, then start new one.
   - Cancel existing session, then start new one.
   - Do nothing.

Do not silently discard an active session.

---

## 10. Default Settings

```json
{
  "capture_preset": "standard",
  "redact_secrets": true,
  "capture_request_bodies": true,
  "capture_response_bodies": true,
  "capture_binary_bodies": false,
  "capture_idb_records": false,
  "capture_user_event_metadata": true,
  "capture_input_values": false,
  "capture_clipboard_values": false,
  "capture_file_contents": false,
  "capture_cache_storage_urls": true,
  "max_inline_body_bytes": 262144,
  "max_sidecar_body_bytes": 5242880,
  "max_total_body_bytes": 52428800,
  "max_console_arg_bytes": 32768,
  "max_storage_value_bytes": 102400,
  "max_global_blob_bytes": 262144,
  "dom_mutation_summary_interval_ms": 1000,
  "stop_grace_period_ms": 500
}
```

### Capture presets

#### Light

- Metadata only.
- No response bodies.
- No storage values.
- Good for first pass on sensitive pages.

#### Standard

- Metadata.
- Small request/response bodies.
- Storage keys and capped values.
- Default mode.

#### Deep

- Larger body caps.
- More bootstrap global content.
- Optional IDB samples.
- Warning shown before start.

Only Standard is required for v0.1. Light and Deep may be implemented as simple setting presets if fast.

---

## 11. Core Data Schema

Every captured record must include enough identity to correlate it.

Base fields:

```json
{
  "schema_version": "0.1",
  "session_id": "uuid",
  "frame_id": "string",
  "tab_id": 123,
  "timestamp": "2026-05-10T14:23:00.123Z",
  "page_url": "https://example.com/path"
}
```

### 11.1 Network Record

```json
{
  "schema_version": "0.1",
  "session_id": "uuid",
  "id": "uuid",
  "source": "fetch",
  "method": "POST",
  "url": "https://example.com/api/data?x=1",
  "url_parts": {
    "origin": "https://example.com",
    "pathname": "/api/data",
    "search": "?x=1"
  },
  "status": 200,
  "statusText": "OK",
  "requestHeaders": {},
  "responseHeaders": {},
  "requestBody": {
    "captured": true,
    "type": "json",
    "encoding": "utf8",
    "size": 1234,
    "inline": "{...}",
    "decoded": {}
  },
  "responseBody": {
    "captured": true,
    "type": "json",
    "encoding": "utf8",
    "size": 12000,
    "inline": "{...}",
    "sidecar": null
  },
  "responseMime": "application/json",
  "timing": {
    "start": 12345.1,
    "end": 12398.8,
    "durationMs": 53.7
  },
  "initiator": "stack trace",
  "frameUrl": "https://example.com/app",
  "errors": []
}
```

### 11.2 Timeline Event

```json
{
  "schema_version": "0.1",
  "session_id": "uuid",
  "t": "2026-05-10T14:23:00.123Z",
  "kind": "request_end",
  "ref": "network-request-uuid",
  "summary": "POST /api/data 200 53.7ms"
}
```

Allowed timeline kinds:

```text
request_start
request_end
request_error
xhr_start
xhr_end
beacon
form_submit
navigation_api
history_change
user_click
user_input
user_scroll
script_added
object_url_created
download_trigger
clipboard
file_input
worker_created
ws_open
ws_close
ws_frame
sse_open
sse_event
console
error
unhandledrejection
dom_mutation_summary
navigation
snapshot
cap_reached
redaction
```

---

## 12. Network Capture

### 12.1 fetch

Capture:

- id
- URL
- method
- status
- statusText
- visible request headers
- visible response headers
- request body where safe
- response body from `response.clone()`
- mime type
- timing
- initiator stack
- frame URL
- capture errors

Rules:

- Always return the original response unchanged.
- Always use `response.clone()` before reading.
- If clone/read fails, record metadata and error.
- Never consume original response body.
- Never modify input args except where required to preserve native behavior.

### 12.2 XHR

Capture:

- URL from `open`
- method from `open`
- request headers from `setRequestHeader`
- body from `send`
- status/statusText
- visible response headers
- response text/body if accessible and within cap
- timing
- errors

Rules:

- Preserve native `XMLHttpRequest` behavior.
- Avoid changing readyState behavior.
- Use event listeners where possible.
- If responseType is unsupported for safe capture, record metadata only.

### 12.3 Headers limitation

Document in `summary.md`:

- Browser-set request headers such as `Cookie`, `User-Agent`, `Origin`, and some auth-related headers are not visible to JavaScript.
- Response headers are visible only if same-origin or CORS-exposed.
- Missing headers do not necessarily mean they were absent on the wire.

---

## 13. Body Capture

### 13.1 Body handling table

| Body type | Treatment |
|---|---|
| string | Inline if under cap. Try JSON parse. Detect form-urlencoded and decode params. |
| FormData | Store entries. Files become metadata only: filename, size, type. |
| URLSearchParams | Store entries and decoded params. |
| Blob | Store metadata. Capture text/base64 only if small and allowed. |
| ArrayBuffer / typed array | Try UTF-8 decode. Otherwise base64 if small and binary capture enabled. |
| ReadableStream | Do not consume in v0.1. Mark captured false. |
| null / undefined | Mark as no body. |

### 13.2 Large body policy

Default v0.1:

- Inline if <= 256 KB.
- Sidecar if <= 5 MB.
- Larger than 5 MB: sample first 100 KB where feasible.
- Total body budget: 50 MB.
- After total body budget is reached:
  - continue metadata capture
  - stop capturing bodies
  - emit timeline `cap_reached`

### 13.3 Hashing decision

Do not compute sha256 of huge bodies by default in v0.1.

Reason: full hashing requires reading the entire cloned body and can damage performance.

Optional:

- hash small captured bodies
- hash sidecar bodies already read into memory

---

## 14. Additional Runtime Surfaces

These surfaces are required to make v0.1 comprehensive beyond basic network recording.

### 14.1 navigator.sendBeacon

`navigator.sendBeacon()` is a v0.1 must-have.

Capture:

- URL
- body where safe
- body type
- body size
- timestamp
- frame URL
- initiator stack if available
- native return value

Rules:

- Always call native `sendBeacon`.
- Never block or delay unload-sensitive beacon behavior.
- If body capture fails, record metadata only.
- Apply redaction to body values.
- Output to `beacons.jsonl`.
- Also emit a `timeline.jsonl` event with kind `beacon`.

Schema:

```json
{
  "schema_version": "0.1",
  "session_id": "uuid",
  "id": "uuid",
  "url": "https://example.com/collect",
  "body": {
    "captured": true,
    "type": "FormData",
    "size": 1234
  },
  "returnValue": true,
  "timestamp": "ISO",
  "frameUrl": "https://example.com/page",
  "initiator": "stack trace",
  "errors": []
}
```

### 14.2 Form submissions

Capture normal HTML form submissions because not all app traffic uses fetch/XHR.

Capture:

- form action
- method
- enctype
- target
- input names
- input types
- redacted values only if `capture_input_values` is enabled
- submitter button text/name/type
- timestamp
- frame URL

Rules:

- Do not prevent default.
- Do not mutate form data.
- Redact sensitive fields by name/type.
- Password field values are never captured, even in Deep mode.
- File inputs capture metadata only.
- Output to `forms.jsonl`.
- Emit timeline kind `form_submit`.

### 14.3 Navigation events

Capture:

- `history.pushState`
- `history.replaceState`
- `popstate`
- `hashchange`
- `beforeunload`
- `pagehide`
- `visibilitychange`
- `location.assign`
- `location.replace`
- best-effort `window.open`

Rules:

- Preserve native behavior.
- Do not interfere with navigation.
- Route changes should be written to `navigation.jsonl`.
- Also emit timeline events.

Capture fields:

- event type
- from URL
- to URL where known
- state shape where applicable
- title where applicable
- timestamp
- stack where available

### 14.4 User interaction metadata

Capture user-action metadata to correlate actions with requests.

Required events:

- click
- input/change
- submit
- keydown metadata
- scroll bursts
- focus/blur

Default privacy behavior:

- Capture selectors/roles/text snippets.
- Do not capture typed input values.
- Do not capture clipboard contents.
- Do not capture password values ever.

Target descriptor should include best effort:

- tag name
- id
- classes
- role
- aria-label
- name
- type
- text snippet capped to 80 chars
- CSS-ish selector path capped to reasonable length

Examples:

```json
{
  "kind": "user_click",
  "target": {
    "tag": "button",
    "text": "Export",
    "ariaLabel": "Export",
    "selector": "button[aria-label='Export']"
  },
  "timestamp": "ISO",
  "frameUrl": "https://example.com/app"
}
```

Scroll behavior:

- Do not log every scroll event.
- Emit summary bursts at most once per 500ms.
- Include scrollX/scrollY and direction.

Output:

```text
user-events.jsonl
```

Also emit timeline events.

### 14.5 Dynamic script and resource injection

At stop time, `loaded-scripts.json` lists the final script set.

During recording, also capture dynamic script activity:

- script elements added to DOM
- script `src` mutations
- inline script elements added
- module scripts
- preload/prefetch links added
- stylesheet links added

Output:

```text
scripts.jsonl
```

Fields:

- event type
- src/href
- script type
- async/defer
- integrity
- crossorigin
- inline size if inline
- timestamp
- frame URL

Rules:

- Do not capture full inline script content by default.
- Capture inline script hash/size/sample only if small and allowed.
- Do not mutate script elements.

### 14.6 Object URLs and download triggers

Capture metadata around browser-side exports/downloads.

Observe:

- `URL.createObjectURL`
- `URL.revokeObjectURL`
- anchor clicks with `download`
- anchor clicks to `blob:` URLs
- anchor clicks to likely file downloads
- programmatic `window.open` downloads where visible

Output:

```text
downloads.jsonl
```

Capture:

- object URL id
- blob size/type where available
- download filename where available
- href
- timestamp
- frame URL
- triggering user event ref if available

Rules:

- Do not capture blob contents by default.
- Do not block downloads.
- Do not revoke object URLs yourself.

### 14.7 Clipboard metadata

Observe:

- `navigator.clipboard.writeText`
- `navigator.clipboard.write`
- `navigator.clipboard.readText`
- `navigator.clipboard.read`
- `document.execCommand("copy")`
- `document.execCommand("cut")`
- `document.execCommand("paste")`

Default:

- Capture operation metadata only.
- Do not capture clipboard values unless `capture_clipboard_values` is explicitly true.
- Never capture clipboard values in Standard mode.

Output:

```text
clipboard.jsonl
```

### 14.8 File input metadata

Capture file input interaction metadata.

Observe:

- input[type=file] change events

Capture:

- input accept attribute
- multiple
- selected file count
- file names
- file sizes
- MIME types
- lastModified timestamps

Rules:

- Do not capture file contents in v0.1.
- Redact filenames if future setting requires it.
- Output to `files.jsonl`.

### 14.9 Worker creation metadata

Capture worker creation but do not hook inside workers in v0.1.

Observe:

- `new Worker(url, options)`
- `new SharedWorker(url, options)`

Capture:

- worker type
- script URL
- options
- timestamp
- frame URL
- initiator stack

Output:

```text
workers.jsonl
```

Rules:

- Preserve native behavior.
- If constructor wrapping risks breakage, record error and restore native constructor.
- Worker internal traffic is deferred to v0.2.

### 14.10 Cache Storage and storage estimate

At stop:

Capture:

- `navigator.storage.estimate()`
- `caches.keys()`
- cache names
- cached request URLs if `capture_cache_storage_urls` is true

Rules:

- Do not dump cached response bodies in v0.1.
- If Cache Storage is unavailable or blocked, record unavailable reason.

Output location:

- Include in `storage.json` under `cacheStorage`.
- Include storage estimate under `storageEstimate`.

### 14.11 Permissions and feature detection

At stop:

Capture safe feature availability and permission states.

Examples:

- notifications permission
- clipboard-read / clipboard-write permission where queryable
- geolocation permission state where queryable
- camera/microphone permission state where queryable
- serviceWorker availability
- pushManager availability
- WebRTC API availability
- File System Access API availability
- Payment Request API availability

Rules:

- Do not request permissions.
- Do not access geolocation/camera/microphone.
- Only query state where safe and non-prompting.
- Store in `runtime.json`.

---

## 15. Pattern Intelligence

The summary generator should not merely count events. It should infer useful patterns from captured data.

### 15.1 GraphQL detection

Detect GraphQL if:

- URL contains `/graphql`
- request JSON has `query`
- request JSON has `operationName`
- request JSON has `variables`
- request body is an array of GraphQL operations

Summary should include:

```md
## GraphQL operations observed

| Operation | Type | Count | Endpoint |
|---|---:|---:|---|
```

Detect operation type from query prefix where possible:

- query
- mutation
- subscription
- unknown

### 15.2 RPC/framework detectors

Best-effort detectors:

- tRPC
- JSON-RPC
- gRPC-web
- WIZ/batchexecute
- Next.js data routes
- Nuxt payloads
- Remix loaders/actions
- Rails Turbo streams
- Phoenix LiveView
- Laravel Livewire
- htmx requests
- protobuf-looking binary responses
- NDJSON
- length-prefixed stream chunks
- XSSI/XSRF-prefixed JSON

Detection does not need to be perfect.

Each detected pattern should include:

- pattern name
- confidence: low/medium/high
- evidence
- matching endpoint examples
- suggested next inspection step

### 15.3 Initiator classification

Classify requests when possible:

- page bootstrap
- user click
- user input
- form submit
- route change
- polling/timer
- scroll/lazy-load
- download/export
- background realtime
- unknown

Use nearby timeline events, stack traces, and timestamps.

### 15.4 Endpoint clustering

Cluster endpoints by normalized method + path.

Rules:

- drop query string for route grouping
- preserve query keys separately
- replace UUIDs with `{uuid}`
- replace long numeric IDs with `{id}`
- replace base64-ish path segments with `{encoded}`
- group same endpoint across different query values

### 15.5 Suggested next steps

`summary.md` should generate 3-7 concrete next steps based on observed data.

Examples:

- "GraphQL operation `GetInventory` was called 18 times after scroll events. Inspect variables in `network.jsonl` for pagination cursors."
- "Normal form submit detected to `/checkout`. Fetch/XHR hooks will not fully explain this flow; inspect `forms.jsonl`."
- "Blob URL created after clicking Export. Check `downloads.jsonl` for the generated filename and blob MIME type."
- "Route changes preceded calls to `/api/search`. Inspect `navigation.jsonl` and nearby timeline events."


## 16. WebSocket Capture

v0.1 should implement after fetch/XHR/ZIP are stable.

Capture:

- connection id
- URL
- protocols
- open timestamp
- close timestamp/code/reason
- outbound frames via `send`
- inbound frames via `message`
- errors

Rules:

- Preserve native prototype.
- Preserve constants:
  - CONNECTING
  - OPEN
  - CLOSING
  - CLOSED
- Do not break `instanceof WebSocket`.
- If wrapping fails, restore native constructor and record error.

---

## 17. EventSource Capture

Capture:

- connection id
- URL
- withCredentials
- event type
- data
- lastEventId
- timestamp
- error/open events

Rules:

- Preserve native behavior.
- Capture data with size caps.
- Do not alter event delivery.

---

## 18. Console and Runtime Error Capture

Wrap:

```text
console.log
console.info
console.warn
console.error
console.debug
```

Rules:

- Always call original console method.
- Best-effort serialize arguments.
- Cap argument size.
- Avoid circular reference crashes.

Also capture:

```text
window.addEventListener("error")
window.addEventListener("unhandledrejection")
```

Output:

```text
console.jsonl
```

---

## 19. DOM Snapshot

At stop:

Capture:

- `document.documentElement.outerHTML` to `dom.html`
- loaded script URLs to `loaded-scripts.json`
- loaded stylesheet URLs to `loaded-styles.json`
- meta tags
- same-origin iframe HTML where accessible
- open shadow roots where accessible

Rules:

- Snapshot failure in one iframe does not fail the bundle.
- Closed shadow roots are unreachable and should be documented.
- `dom.html` is best-effort. It may not fully render offline.

---

## 20. Globals Snapshot

At stop:

Capture:

- `Object.keys(window)`
- likely site-specific globals
- shape descriptors to depth 4
- max 6 keys per object level
- known bootstrap globals with capped content

Do not capture full arbitrary global values by default.

### Bootstrap globals

Capture full capped content for:

```text
_docs_flag_initialData
WIZ_global_data
__INITIAL_STATE__
__PRELOADED_STATE__
__NEXT_DATA__
__NUXT__
__APOLLO_STATE__
_sharedData
```

Each bootstrap global should include:

- name
- type
- size estimate
- shape descriptor
- capped serialized content if under cap
- truncation status

---

## 21. Storage Snapshot

At stop:

Capture:

- localStorage keys and capped values
- sessionStorage keys and capped values
- document.cookie with redacted values by default
- `indexedDB.databases()` names and versions where available
- object store names where safely accessible

Do not dump IndexedDB records by default.

Cookie rule:

- Keep cookie names.
- Redact values when `redact_secrets` is true.
- Document that HttpOnly cookies are invisible to JavaScript.

---

## 22. Runtime Metadata

Capture:

- userAgent
- platform
- languages
- current URL
- referrer
- title
- CSP meta tags
- Trusted Types presence
- service worker registrations
- performance navigation/resource/paint/longtask entries where available

v0.1 limitation:

- Main document HTTP CSP response headers are not guaranteed captured without `webRequest`.

---

## 23. DOM Mutation Summary

During recording:

- Use MutationObserver.
- Summarize every 1000ms.
- Do not store every mutation.

Summary shape:

```json
{
  "nodesAdded": 12,
  "nodesRemoved": 3,
  "attributesChanged": 7,
  "characterDataChanged": 1
}
```

---

## 24. Redaction

Default redaction is on.

### 24.1 Redact headers

Header names matching:

```text
authorization
cookie
x-auth-token
x-api-key
proxy-authorization
```

Replace value with:

```text
[REDACTED]
```

### 24.2 Redact body fields

Field/key names matching:

```regex
/(password|passwd|pwd|api[_-]?key|secret|token|access[_-]?token|refresh[_-]?token|sapisid|authuser|session|jwt)/i
```

### 24.3 Redact cookies

Default:

```text
sessionid=[REDACTED]; theme=[REDACTED]
```

### 24.4 Redaction report

`summary.md` must include:

```md
## Redaction report

- Header values redacted: X
- Cookie values redacted: Y
- Body fields redacted: Z
- Redaction enabled: true
```

---

## 25. Output ZIP

Filename:

```text
recon-{hostname}-{YYYYMMDD-HHMMSS}.zip
```

Required contents:

```text
summary.md
manifest.json
network.jsonl
beacons.jsonl
forms.jsonl
navigation.jsonl
user-events.jsonl
scripts.jsonl
downloads.jsonl
clipboard.jsonl
files.jsonl
workers.jsonl
websockets.jsonl
sse.jsonl
dom.html
dom-iframes/
loaded-scripts.json
loaded-styles.json
globals.json
storage.json
console.jsonl
runtime.json
performance.json
timeline.jsonl
```

If a file has no records, include an empty file or valid empty JSON/JSONL form.

Do not omit expected files silently.

### Bundle manifest

The bundle `manifest.json` must include:

```json
{
  "format_version": "0.1",
  "tool": "WebReconPack",
  "tool_version": "0.1.2",
  "session_id": "uuid",
  "started_at": "ISO timestamp",
  "ended_at": "ISO timestamp",
  "duration_ms": 123000,
  "start_url": "https://example.com",
  "end_url": "https://example.com/app",
  "settings": {},
  "counts": {},
  "limits": {},
  "warnings": []
}
```

---

## 26. Summary Generator

`summary.md` should be generated from captured data.

Required sections:

```md
# Recon Pack: hostname

Captured:
Tab:
Duration:
User agent:
Settings:

## At a glance

## Top endpoints by request count

## Top origins

## User action timeline

## Navigation events

## Forms and beacons

## Methods observed

## Response content types

## Detected response/request patterns

## GraphQL/RPC/framework intelligence

## Bootstrap globals

## Storage overview

## Console/error overview

## CSP & Trusted Types

## Service workers

## Redaction report

## Limits and truncation

## Suggested next steps
```

### Endpoint normalization

For grouping endpoints:

- Drop query string.
- Replace UUIDs with `{uuid}`.
- Replace long numeric IDs with `{id}`.
- Preserve method.
- Preserve query keys separately.

Example:

```text
POST /api/users/123/orders?cursor=abc
POST /api/users/456/orders?cursor=def
```

Normalizes to:

```text
POST /api/users/{id}/orders
query keys: cursor
```

### Pattern detectors

Detect and report:

- JSON
- JSON with XSSI/XSRF prefix `)]}'`
- form-urlencoded requests
- multipart form requests
- GraphQL requests
- NDJSON
- SSE-like frame data
- WIZ/batchexecute frames
- length-prefixed stream patterns
- protobuf-looking binary responses
- base64-looking fields

Suggested next steps should be concrete and based on the captured patterns.

---

## 27. Popup UI

States:

### Idle

Show:

- title/version
- first-run warning if not acknowledged
- Start Recon button
- settings disclosure

### Recording

Show live counters:

- requests
- XHR/fetch split
- WebSocket frames
- SSE events
- console messages
- errors
- estimated body bytes
- body cap status

Buttons:

- Stop & Download
- Cancel

### Finalizing

Show:

- assembling bundle message
- progress text
- no duplicate stop clicks

### Ready

Show:

- download status
- stats
- Start New Session

### Error

Show:

- error message
- download partial pack if available
- clear session

---

## 28. Critical Implementation Gotchas

### Trusted Types

Many sites enforce Trusted Types.

Rules:

- No `innerHTML` in page context.
- No `outerHTML` assignment.
- No `insertAdjacentHTML`.
- No `document.write`.
- Build any page-side UI using `document.createElement` and `textContent`.

The extension popup is extension-origin and not subject to the host page CSP.

### MAIN world isolation

- `chrome.runtime` is unavailable in MAIN.
- Use strict message bridge.
- Page scripts can fake messages.
- Validate all messages.

### Response clone

Always:

```js
const cloned = response.clone();
cloned.text().then(processBody).catch(recordError);
return response;
```

### ReadableStream

Do not consume request ReadableStreams in v0.1.

Mark:

```json
{
  "type": "ReadableStream",
  "captured": false,
  "reason": "stream body skipped to avoid consuming request"
}
```

### Memory pressure

When body budget is reached:

1. emit cap warning
2. disable body capture
3. continue metadata capture
4. keep page working

### Service worker lifecycle

During recording:

- content scripts maintain long-lived port
- isolated script reconnects if disconnected
- fallback heartbeat every 20 seconds

### Hook timing

Hooks install at `document_start`, but recording may begin after page load.

Document:

- Starting mid-page captures future activity, not past activity.
- Reload page after starting for full bootstrap capture.

---

## 29. Build Phases

### Phase 0 — Skeleton

Goal: extension loads without errors.

Deliverables:

- manifest.json
- background.js
- isolated.js
- main-world.js
- popup.html
- popup.css
- popup.js
- README.md
- placeholder icons
- JSZip vendoring instructions

Acceptance:

- Chrome loads unpacked extension.
- Popup opens.
- Content scripts inject.
- No extension console errors.

### Phase 1 — Session lifecycle

Goal: start/stop/cancel state works.

Deliverables:

- `startSession(tabId)`
- `stopSession(tabId)`
- `cancelSession()`
- popup state rendering
- session state in service worker/storage.session

Acceptance:

- Start changes state to recording.
- Popup close/reopen preserves state.
- Stop reaches ready/finalizing.
- Cancel clears session.

### Phase 2 — Message bridge

Goal: MAIN-world can send observations to service worker.

Deliverables:

- MAIN emits test observation.
- isolated validates/forwards.
- background receives/counts.

Acceptance:

- test observation count appears in popup stats.
- invalid page messages ignored.

### Phase 3 — Fetch capture

Goal: capture fetch metadata and small bodies.

Acceptance:

- fetch requests appear in network.jsonl.
- response.clone does not break page.
- request/response bodies captured under cap.
- metadata captured even when body capture fails.

### Phase 4 — ZIP v1

Goal: produce valid downloadable ZIP.

Required ZIP files:

- summary.md
- manifest.json
- network.jsonl
- timeline.jsonl

Acceptance:

- Stop downloads ZIP.
- ZIP opens.
- JSONL is valid.

### Phase 5 — XHR capture

Goal: capture XHR metadata and bodies.

Acceptance:

- XHR requests appear in network.jsonl.
- setRequestHeader headers captured.
- page behavior unchanged.

### Phase 6 — Snapshots

Goal: capture stop-time page state.

Deliverables:

- dom.html
- loaded-scripts.json
- loaded-styles.json
- globals.json
- storage.json
- runtime.json
- performance.json

Acceptance:

- files exist in ZIP.
- snapshot failures are isolated.
- globals include shape descriptors.

### Phase 7 — Console/errors

Goal: capture console and runtime errors.

Acceptance:

- console.jsonl populated.
- original console methods still work.
- circular args do not crash capture.

### Phase 8 — Additional runtime surfaces

Goal: capture the non-fetch/XHR behavior needed for comprehensive recon.

Deliverables:

- sendBeacon capture
- form submit metadata
- navigation events
- user interaction metadata
- dynamic script/resource injection metadata
- object URL/download trigger metadata
- clipboard metadata
- file input metadata
- worker creation metadata
- Cache Storage metadata
- permissions/feature detection

Acceptance:

- beacons appear in `beacons.jsonl`.
- form submits appear in `forms.jsonl`.
- route changes appear in `navigation.jsonl`.
- clicks/inputs/scroll bursts appear in `user-events.jsonl` without typed values by default.
- dynamic script additions appear in `scripts.jsonl`.
- object URLs/download triggers appear in `downloads.jsonl`.
- feature/permission metadata appears in `runtime.json`.
- page behavior is unchanged.

### Phase 9 — Realtime channels

Goal: capture WebSocket and EventSource.

Acceptance:

- WS frames captured on test page.
- SSE events captured where applicable.
- native behavior preserved.

### Phase 10 — Pattern intelligence

Goal: make `summary.md` useful as an analysis artifact.

Deliverables:

- endpoint clustering
- GraphQL detection
- RPC/framework detectors
- initiator classification
- generated suggested next steps

Acceptance:

- summary identifies GraphQL where present.
- summary groups noisy endpoints correctly.
- summary lists concrete next inspection steps.

### Phase 11 — Hardening

Goal: pass complex site test.

Acceptance:

- Google Sheets session completes.
- ZIP under 100 MB with defaults.
- no page-breaking extension errors.
- popup state survives close/reopen.
- stop works during in-flight requests.

---

## 30. v0.1 Scope Lock

### Must-have

- extension skeleton
- popup lifecycle
- single active session
- fetch capture
- XHR capture
- sendBeacon capture
- form submit metadata
- navigation event capture
- user interaction metadata
- dynamic script/resource injection metadata
- object URL and download trigger metadata
- small body capture
- redaction
- ZIP download
- summary.md
- network.jsonl
- timeline.jsonl
- DOM snapshot
- globals shape snapshot
- storage snapshot
- console/error capture
- runtime/performance metadata
- popup close/reopen resilience

### Should-have

- WebSocket capture
- SSE capture
- iframe DOM snapshots
- endpoint clustering
- GraphQL detector
- RPC/framework pattern detectors
- initiator classification
- worker creation metadata
- clipboard metadata
- file input metadata
- Cache Storage metadata
- permissions/feature detection

### Defer to v0.2

- HAR export
- multi-tab sessions
- offscreen document
- IndexedDB record dumping
- source map fetching
- worker internal traffic
- full worker request interception
- full clipboard value capture by default
- file content capture by default
- Postman/OpenAPI generation
- recon pack diffing
- recipe generation
- full CSP header capture via `webRequest`
- floating on-page panel

---

## 31. Acceptance Criteria

v0.1 is complete when:

- Extension loads unpacked in Chrome.
- Start/Stop/Cancel work.
- Popup state survives close/reopen.
- ZIP downloads on Stop.
- ZIP contains every required file.
- network.jsonl contains fetch and XHR records.
- beacons.jsonl contains sendBeacon records when present.
- forms.jsonl contains form submit metadata when present.
- navigation.jsonl contains route/history/hash events when present.
- user-events.jsonl captures clicks/inputs/scroll bursts without typed values by default.
- scripts.jsonl captures dynamic script/resource additions.
- downloads.jsonl captures object URL and download trigger metadata.
- Response body capture does not break the page.
- Metadata continues after body cap is reached.
- Redaction runs by default.
- summary.md contains endpoint counts and redaction report.
- dom.html is generated.
- globals.json includes site-specific shape descriptors.
- storage.json includes local/session storage and redacted cookies.
- console.jsonl captures console and error events.
- timeline.jsonl correlates major events.
- Google Sheets can be recorded for 60 seconds without breaking page behavior.
- Stop during in-flight requests does not hang longer than 2 seconds.
- Default 60-second Google Sheets bundle stays under 100 MB.

---

## 32. Claude Code Build Prompt

Use this prompt to start implementation:

```text
You are implementing WebReconPack from SPEC.md.

Do not build everything at once.

Rules:
1. Read SPEC.md completely.
2. Implement in phases.
3. After each phase, report:
   - files changed
   - what works
   - what is not implemented yet
   - how to manually test it in Chrome
4. Do not introduce a build system unless necessary.
5. Use plain Chrome MV3 JavaScript.
6. Do not load remote CDN scripts at runtime.
7. Do not use innerHTML in page-injected code.
8. Preserve host page behavior above capture completeness.
9. If a capture feature risks breaking the page, skip that specific body/value and record why.
10. Keep v0.1 focused on correctness.

Start with Phase 0 only:
- manifest.json
- background.js
- isolated.js
- main-world.js
- popup.html
- popup.css
- popup.js
- README.md
- placeholder icons
- lib/jszip.min.js placeholder/instructions if not available

Then stop and give me manual test instructions before moving to Phase 1.
```

---

## 33. Build Strategy

Default implementation strategy:

1. Build the minimum extension shell.
2. Prove popup ↔ service worker state.
3. Prove MAIN ↔ isolated ↔ service worker event flow.
4. Capture fetch.
5. Download ZIP.
6. Add XHR.
7. Add snapshots.
8. Add console/errors.
9. Add additional runtime surfaces.
10. Add WebSocket/SSE.
11. Add pattern intelligence.
12. Harden against Google Sheets.

Do not optimize until the full path works.

Do not add v0.2 features until v0.1 acceptance criteria pass.

---

## 34. Final Build Principle

The extension should act like a black box flight recorder for a webpage.

It should observe aggressively but interfere minimally.

When forced to choose:

```text
page still works > capture completeness
clean ZIP > fancy UI
accurate metadata > risky body capture
small stable v0.1 > bloated unstable v0.1
```

End of tightened spec.
