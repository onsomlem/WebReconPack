# WebReconPack

Local-first Chrome MV3 extension that records a user-controlled browsing
session and exports a local ZIP containing enough runtime context to
understand how a website behaves.

> **Local-only.** Recon packs never leave your machine. The extension uses
> `chrome.downloads.download()` to save the ZIP locally and has no network
> egress of its own.

## Status — v0.2.0 (analyzer shipped)

- **v0.1.0** — first working release; passed spec §31 Sheets acceptance.
- **v0.1.1** — operator polish: toolbar `REC` badge, live duration timer,
  capture-preset selector (Light / Standard / Deep).
- **v0.1.2** — public hygiene; second golden test (GitHub, 120s, form_submit
  + multi-frame validated).
- **v0.2.0** — **[`webrecon-analyze`](analyzer/)** companion CLI. Single-file
  Python, stdlib only. Turns a recon ZIP into structured insight: auth
  surface, endpoint clustering, classification, extraction strategy with
  jq + curl recipes, parser warnings. Validated by 19 acceptance checks
  against both golden bundles.

All v0.1 phases shipped:

| Phase | Scope | Status |
|---|---|---|
| 0 | MV3 skeleton, popup ↔ SW bridge | ✅ |
| 1 | Session lifecycle (Start / Stop / Cancel) + popup-close resilience | ✅ |
| 2 | MAIN ↔ isolated ↔ SW observation bridge with strict marker validation | ✅ |
| 3 | `fetch` capture (req/resp headers, bodies, timing, initiator stack) | ✅ |
| 4 | ZIP assembly + `chrome.downloads.download()` | ✅ |
| 5 | `XMLHttpRequest` capture | ✅ |
| 6 | DOM / globals / storage / runtime / performance / scripts / styles snapshots | ✅ |
| 7 | `console.*` + `error` + `unhandledrejection` capture | ✅ |
| 8 | `sendBeacon`, forms, history/navigation, user events, dynamic scripts, object URLs / downloads, clipboard, file inputs, Worker/SharedWorker, Cache Storage, permissions/feature detection | ✅ |
| 9 | `WebSocket` + `EventSource` capture | ✅ |
| 10 | Endpoint clustering, GraphQL/RPC/framework detection, initiator classification, generated `summary.md` | ✅ |
| 11 | Body caps, redaction, error isolation, port keepalive | ✅ |

Deferred to v0.2 per spec §30 (HAR, multi-tab, IDB record dumping, source maps,
worker internal traffic, Postman/OpenAPI export, recipe generation, full CSP via
`webRequest`).

## Validation

Two production-grade web apps validated end-to-end. Bundles preserved under
[`golden-tests/`](golden-tests/) and locked as the regression benchmark for
future versions.

### Google Sheets

125-second session. [`golden-tests/sheets-125s-v0.1.0/`](golden-tests/sheets-125s-v0.1.0/)

- **768 KB ZIP** (130× under the spec's 100 MB acceptance cap)
- **353 network records** (18 fetch + 335 XHR — first XHR-volume validation)
- **6 frames snapshotted** including cross-origin (`accounts.google.com`,
  `contacts.google.com`, `ogs.google.com`)
- `_docs_flag_initialData` (85 KB) and `WIZ_global_data` (19 KB) bootstrap
  globals captured uncut
- **XSSI prefix `)]}'`** detected on 58 responses (high confidence)
- **Google WIZ batchexecute** detected on 58 requests (high confidence)
- **form-urlencoded RPC** detected on 56 requests
- **protobuf-like binary responses** detected on 8 responses
- 33 header values + 43 cookie values redacted
- Body cap not hit (1.78 MB of bodies captured against a 50 MB budget)
- **No page breakage observed** (Sheets remained fully interactive,
  another extension running on the same page was not interfered with)

### GitHub (logged-in browsing session)

119-second session across dashboard → repo → issues → notifications.
[`golden-tests/github-repo-120s-v0.1.2/`](golden-tests/github-repo-120s-v0.1.2/)

- **1.3 MB ZIP** (75× under the 100 MB cap)
- **232 network records** (226 fetch + 6 XHR — fetch-dominant SPA)
- **313 sendBeacon** calls (GitHub's telemetry stream)
- **1 form_submit captured** (first form-capture validation —
  `dismiss-notice`, `authenticity_token` correctly redacted to type only)
- **6 Worker constructions** captured
- **1857 dynamic script/resource additions** (Turbo lazy-loading)
- **79 navigation events** (heavy SPA route traffic)
- **933 body fields redacted** by the standard regex
- Endpoint clusters correctly normalized: `/{owner}/{repo}/issues`,
  `/notifications/{id}/watch_subscription`, etc.
- Pattern detector reported honestly — GitHub doesn't use GraphQL/WIZ/XSSI
  in this session, so the report says so (no false positives)
- **No page breakage observed**

Combined coverage: XHR-heavy SPAs, fetch-heavy SPAs, form submits, multi-frame
sessions, cross-origin frames, Trusted Types environments, and high-volume
dynamic script injection — all without breaking the host page.

## Analyzing a bundle (v0.2.0+)

For a structured operator-focused report, use the companion analyzer:

```sh
python3 analyzer/webrecon_analyze.py recon-yourdomain-XXX.zip
# writes <bundle>.report.md  (human)
# writes <bundle>.report.json (machine)
```

What you get on top of the recorder's `summary.md`:

- **Auth surface** — every auth-flagged header, auth cookie, CSRF form
  field, bearer-token presence, auth-flagged query params, aggregated
  across the session.
- **Endpoint clusters by classification** — `data_fetch` / `data_write` /
  `rpc` / `auth` / `telemetry` / `asset` / `unknown`, with required vs
  optional query keys, status distribution, and request/response shape.
- **Likely data endpoints + extraction strategy** — per-cluster notes on
  pagination, auth, rate limits, base64 fields, plus a runnable `jq`
  recipe and `curl` skeleton.
- **Parser warnings** — XSSI prefix, base64 fields, binary/protobuf
  responses, NDJSON streams, WIZ batchexecute. Each with an explicit
  *action* the operator should take.
- **Bootstrap globals inventory** — `__NEXT_DATA__`, `_docs_flag_initialData`,
  `WIZ_global_data`, `__APOLLO_STATE__`, etc. with size + structural
  shape.

See [`analyzer/README.md`](analyzer/README.md) for full details and an
example output.

## Reading the bundle

Inspect the ZIP contents in this order:

1. **`summary.md`** — start here. Top endpoints (clustered + normalized),
   detected patterns (GraphQL/RPC/XSSI/etc.), initiator classification,
   redaction report, suggested next steps.
2. **`network.jsonl`** — the meat. One JSON record per request. Headers,
   bodies (capped + decoded as JSON when possible), timing, initiator
   stack, frame URL. Filter with [jq](https://jqlang.github.io/jq/):
   ```sh
   jq -c 'select(.method=="POST")' network.jsonl
   jq -c 'select(.url|test("graphql"))' network.jsonl
   jq -c 'select(.responseBody.decoded != null) | {url, decoded: .responseBody.decoded}' network.jsonl | head -3
   ```
3. **`timeline.jsonl`** — unified time-ordered event stream. Correlate
   user clicks, navigation events, and network calls:
   ```sh
   jq -c '{t,kind,summary}' timeline.jsonl | head -30
   ```
4. **`globals.json`** — bootstrap state objects (`__INITIAL_STATE__`,
   `__NEXT_DATA__`, `__APOLLO_STATE__`, etc.) where present. This is
   where SPAs hide their server-rendered initial state.
5. **`storage.json`** — localStorage / sessionStorage / cookies (redacted)
   per frame, plus IndexedDB metadata and Cache Storage URLs.
6. **`runtime.json`** — userAgent, languages, CSP meta tags, Trusted
   Types presence, service worker registrations, permission states,
   feature-detection (WebRTC, WebAuthn, FileSystemAccess, etc.).
7. **`navigation.jsonl`** — `pushState` / `replaceState` / `popstate` /
   `hashchange` / `beforeunload` / `pagehide` / `visibilitychange`. SPA
   route trace.
8. **`user-events.jsonl`** — clicks, focus/blur, scrolls (throttled),
   keydowns (no values by default), changes. Each has a `target`
   descriptor with selector, role, aria-label, text snippet.
9. **`scripts.jsonl`** — every dynamic `<script>` / `<link>` / `<style>`
   added during recording. Useful for understanding lazy-loading.
10. **`beacons.jsonl`** — `navigator.sendBeacon` calls (telemetry).
11. **`websockets.jsonl` / `sse.jsonl`** — realtime channels with
    open/close + frame data.
12. **`console.jsonl`** — `console.*` + `window.error` +
    `unhandledrejection`. Stack traces with our wrapper frames already
    filtered.
13. **`dom.html`** — top-frame `documentElement.outerHTML` at stop time.
    Open in a browser; it won't render fully without its asset URLs but
    the structure is intact.
14. **`dom-iframes/`** — same-origin iframe HTML where accessible.
15. **`manifest.json`** — bundle metadata (counts, settings used, limits,
    redaction stats, frames seen vs snapshotted, warnings).

### Quick recipes

```sh
# Top 10 unique POST endpoints (normalized)
jq -r 'select(.method=="POST") | .url_parts.pathname' network.jsonl \
  | sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/{uuid}/g' \
  | sort | uniq -c | sort -rn | head -10

# All XSSI-prefixed responses
jq -c 'select(.responseBody.inline != null and (.responseBody.inline | startswith(")]}'")))' network.jsonl

# Map clicks to subsequent network calls (within 1 second)
jq -c 'select(.kind=="user_click" or .kind=="request_start") | {t,kind,summary}' timeline.jsonl
```

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this repo's root directory.
4. Pin the extension to the toolbar so the popup is one click away.

JSZip 3.10.1 is vendored at [`lib/jszip.min.js`](lib/jszip.min.js)
(SHA-256 `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e`).
No build step.

## How to record a session

1. Open the target site in a tab.
2. Click the WebReconPack toolbar icon.
3. First time only: click **I understand** on the sensitive-data warning.
4. Click **Start Recon**.
5. Use the page naturally — clicks, scrolls, form submits, navigation, etc.
6. Click the toolbar icon again, then **Stop & Download**.
7. Chrome saves `recon-<host>-<YYYYMMDD-HHMMSS>.zip` to your Downloads folder.

The popup can be closed and reopened at any time during recording — the
service worker owns state.

### Single active session rule (spec §9)

If you click **Start Recon** while another tab is already recording, the popup
shows a conflict panel with two options:

- **Stop & download** the existing session, then start fresh on the new tab.
- **Cancel** the existing session (no download), then start fresh.

## What's in the ZIP

```
recon-<host>-<YYYYMMDD-HHMMSS>.zip
├── manifest.json          # bundle metadata (counts, settings, limits, redaction stats)
├── summary.md             # human-readable analysis with patterns + suggested next steps
├── network.jsonl          # fetch + XHR records (headers, bodies, timing, initiator)
├── beacons.jsonl          # navigator.sendBeacon
├── forms.jsonl            # native HTML form submits
├── navigation.jsonl       # history.pushState/replaceState/popstate/hashchange/visibilitychange/beforeunload/pagehide
├── user-events.jsonl      # click/input/change/keydown/scroll/focus/blur (no input values by default)
├── scripts.jsonl          # dynamic <script>/<link>/<style> additions during recording
├── downloads.jsonl        # URL.createObjectURL/revoke + anchor[download] clicks
├── clipboard.jsonl        # navigator.clipboard + execCommand copy/cut/paste (metadata only)
├── files.jsonl            # <input type=file> change metadata
├── workers.jsonl          # Worker/SharedWorker constructor calls
├── websockets.jsonl       # WebSocket open/close + frames in/out
├── sse.jsonl              # EventSource open + events
├── console.jsonl          # console.log/info/warn/error/debug + window.onerror + unhandledrejection
├── timeline.jsonl         # unified, time-ordered event timeline (correlates everything else)
├── dom.html               # documentElement.outerHTML at stop time
├── dom-iframes/           # same-origin iframe HTML where accessible
├── loaded-scripts.json    # all <script> at stop time
├── loaded-styles.json     # all <link rel=stylesheet> + inline <style>
├── globals.json           # Object.keys(window) + capped bootstrap globals (__NEXT_DATA__, __APOLLO_STATE__, etc.)
├── storage.json           # localStorage + sessionStorage + cookies (redacted) + IDB names + Cache Storage
├── runtime.json           # userAgent, languages, CSP meta, Trusted Types, SW registrations, permissions, feature flags
└── performance.json       # navigation/resource/paint/longtask entries
```

## Privacy and redaction (spec §24)

By default (toggleable in Settings):

- Header values for `authorization`, `cookie`, `x-auth-token`, `x-api-key`,
  `proxy-authorization` are replaced with `[REDACTED]`.
- Cookie values in `document.cookie` are replaced with `[REDACTED]`.
- JSON body fields whose key matches `password|token|secret|api_key|jwt|…` are
  replaced with `[REDACTED]`.
- Password input values are **never** captured, even with input-value capture
  enabled.
- Clipboard values are **never** captured unless the explicit setting is on.
- File contents are never captured (filenames + sizes + MIME only).

Redaction counts appear in `summary.md` and `manifest.json`.

## Limits (spec §10, §13.2)

- Inline body cap: 256 KB per response.
- Total body cap: 50 MB per session.
- After total cap is reached, body capture stops; metadata continues; a
  `cap_reached` event is added to the timeline.
- HTTP `Cookie`, `User-Agent`, `Origin`, etc. are **not** visible to the
  fetch/XHR hooks (browser-set headers).
- Hooks install at `document_start`, but **starting recording mid-page only
  captures activity from that moment forward**. Reload the page after Start
  for full bootstrap capture (spec §28).

## Known v0.1 limitations

- No `webRequest` permission → main-document HTTP CSP response headers are
  only captured via `<meta http-equiv>` tags or visible fetch/XHR responses.
- ReadableStream request bodies are **not** consumed (would damage the
  request); they are recorded with `captured: false` and a reason.
- Closed shadow roots are unreachable.
- Worker internal traffic is **not** intercepted in v0.1 (only constructor
  calls).
- IndexedDB **records** are not dumped (only DB/store names).
- Snapshots are best-effort per frame; one frame failing does not fail the
  bundle.
- The service worker keeps itself alive via the long-lived port held by the
  page's content scripts. If the page is closed mid-session, captured data
  remains in SW memory until you Stop or Cancel.

## Project layout

```
WebReconPack/
├── manifest.json                       # MV3 manifest
├── background.js                       # SW: state, redaction, ZIP, summary
├── isolated.js                         # isolated-world bridge + port
├── main-world.js                       # MAIN-world hooks (fetch/XHR/WS/SSE/etc.)
├── popup.html / popup.css / popup.js   # toolbar UI
├── lib/jszip.min.js                    # JSZip 3.10.1, vendored
├── assets/icon-{16,48,128}.png         # toolbar icons
├── analyzer/                           # webrecon-analyze companion CLI (v0.2.0+)
│   ├── webrecon_analyze.py             # single-file Python, stdlib only
│   ├── README.md
│   └── tests/test_acceptance.py        # 19 checks against the golden bundles
├── golden-tests/                       # locked regression artifacts
│   ├── sheets-125s-v0.1.0/
│   └── github-repo-120s-v0.1.2/
└── README.md
```

## Manual smoke test

A quick end-to-end check after install:

1. Browse to a site with active fetch/XHR traffic (e.g. github.com).
2. Open the popup → **Start Recon** → interact for ~30 seconds (click around,
   scroll, navigate).
3. Open the popup → **Stop & Download** → wait for the toast/download.
4. Open the ZIP. Check:
   - `summary.md` lists top endpoints and an initiator classification.
   - `network.jsonl` has one JSON-per-line record per request.
   - `timeline.jsonl` shows interleaved `request_start` / `user_click` / `nav` events.
   - `dom.html` opens (it may not render fully without its assets — that's expected).
   - `globals.json` includes any well-known bootstrap globals if the site has them.
5. Check that the page itself still works (no broken JS, no `[WebReconPack]`
   errors in the page console).

## Boundaries (spec §3)

Recon packs may contain sensitive page data. Use only on sites, accounts, and
applications you own, administer, or are authorized to inspect. Keep
downloaded ZIPs private unless you review and redact them first. The
extension is not a vulnerability scanner, exploit tool, or auth bypass.

## License

TBD.
