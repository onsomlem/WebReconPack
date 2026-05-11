# Golden Test: Google Sheets

**Tool version:** WebReconPack v0.1.0
**Captured:** 2026-05-10T23:50:47Z → 2026-05-10T23:52:53Z
**Operator setting preset:** standard

## Headline numbers

| Metric | Value |
|---|---|
| Duration | 125.3 seconds |
| Bundle size | 768 KB |
| Total network records | 353 |
| `fetch` requests | 18 |
| `XMLHttpRequest` requests | 335 |
| `sendBeacon` calls | 3 |
| Object URL / download events | 131 |
| Worker constructions | 1 |
| Frames seen | 7 |
| Frames snapshotted | 6 |
| Console events | 2 |
| Page errors captured | 4 |
| Body cap hit | no |
| Bundle warnings | 0 |
| Page breakage observed | no |

## Patterns detected by `summary.md`

- XSSI/XSRF JSON prefix `)]}'` — 58 responses (high confidence)
- Google WIZ batchexecute — 58 matches (high confidence)
- form-urlencoded requests — 56 (medium confidence)
- Binary/protobuf-looking responses — 8 (medium confidence)

## Bootstrap globals captured (uncut)

| Frame | Global | Size |
|---|---|---|
| main spreadsheet edit URL | `_docs_flag_initialData` | 85,587 bytes |
| main spreadsheet edit URL | `WIZ_global_data` | 18,948 bytes |
| `offline/iframeapi` | `_docs_flag_initialData` | 7,786 bytes |
| `offline/iframeapi` | `WIZ_global_data` | 12 bytes |
| `contacts.google.com` hovercard | `WIZ_global_data` | 4,769 bytes |
| `ogs.google.com` widget | `WIZ_global_data` | 1,317 bytes |

## Redaction applied

- Header values redacted: 33
- Cookie values redacted: 43
- Body fields redacted: 0 (Google does not use the standard `password|token|secret|jwt` key names)

## Spec acceptance criteria checked (§31)

- ✅ Google Sheets recordable for 60 seconds without breaking page behavior — *we did 125s.*
- ✅ Default 60-second Google Sheets bundle stays under 100 MB — *768 KB, 130× under.*
- ✅ Stop during in-flight requests does not hang longer than 2 seconds — *stop completed cleanly.*
- ✅ ZIP contains every required file (per spec §25).
- ✅ XHR records present in `network.jsonl` — *first real XHR-volume validation, 335 records.*
- ✅ Multi-frame snapshot collection works (6 frames including cross-origin).
- ✅ Pattern intelligence identifies Google's RPC stack.

## Verdict

**PASS** — locks in as the v0.1.0 regression benchmark. Future builds must
not regress on:

1. Network record count (±20% of 353 acceptable for capture noise).
2. Bundle size (must stay well under 100 MB for a 60–120s session).
3. WIZ batchexecute + XSSI prefix detection (must stay "high" confidence).
4. Bootstrap global capture for `_docs_flag_initialData` and `WIZ_global_data`.
5. Zero page breakage on a fully-loaded Sheets document.

## How to re-run

1. Open any Google Sheets document.
2. Click WebReconPack → **Start Recon**.
3. Interact for 60–120 seconds: switch sheet tabs, click cells, scroll.
4. Click **Stop & Download**.
5. Compare the resulting ZIP's `summary.md` against
   `golden-tests/sheets-125s-v0.1.0/summary.md`. Counts will differ
   (different account, different sheet, different traffic) but the
   pattern detections and bootstrap globals should be present.
