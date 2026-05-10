# WebReconPack

Local-first Chrome MV3 extension that records a user-controlled browsing
session and exports a local ZIP containing enough runtime context to
understand how a website behaves.

See [`WebReconPack_LOCKED_SPEC_v0.1.2.md`](./WebReconPack_LOCKED_SPEC_v0.1.2.md)
for the full v0.1 spec.

> **Local-only.** Recon packs never leave your machine. The extension uses
> `chrome.downloads.download()` to save the ZIP locally and has no network
> egress of its own.

## Status — v0.1.2 (full build)

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
├── README.md
├── SPEC.md                             # earlier spec draft
└── WebReconPack_LOCKED_SPEC_v0.1.2.md  # locked v0.1 spec (source of truth)
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
