# webrecon-analyze

Companion CLI for [WebReconPack](../). Consumes a WebReconPack v0.1+ recon
ZIP and produces a structured analysis report — turning the recorder's
artifact into actionable insight for tool builders.

**v0.2.0** — single-file Python script, stdlib only, Python 3.8+, no install
required.

## What it does (vs the v0.1 `summary.md`)

The recorder's `summary.md` is a per-bundle index — counts, top endpoints,
detected patterns. Useful for scanning. **Not** enough to decide how to
build a tool against the site.

`webrecon-analyze` adds:

| Section | What you get |
|---|---|
| **Auth surface** | Every auth-flagged header (incl. site-specific like `X-Fetch-Nonce`, `X-Goog-AuthUser`), auth cookies, CSRF form fields, bearer-token presence, auth-flagged query params — all aggregated across the session |
| **Endpoint clusters by classification** | Each cluster tagged `data_fetch` / `data_write` / `rpc` / `auth` / `telemetry` / `asset` / `unknown`, with method, normalized path (`{uuid}` / `{id}` / `{encoded}` placeholders), required vs optional query keys, status distribution, MIME types, request/response body shape |
| **Likely data endpoints — extraction strategy** | For each cluster that looks like a data fetch (GET, JSON, list-shaped), one-paragraph notes on pagination / auth / rate limits / base64 fields, plus a runnable `jq` recipe and `curl` skeleton |
| **Parser warnings** | XSSI prefix detected, base64 fields, binary/protobuf responses, NDJSON streams, WIZ batchexecute — each with an explicit *action* the operator should take |
| **Bootstrap globals** | Per-frame inventory of well-known initial-state objects (`__NEXT_DATA__`, `_docs_flag_initialData`, `WIZ_global_data`, `__APOLLO_STATE__`, etc.) with size + truncation status + structural shape |
| **Form submits, beacons, websockets, navigation** | Concise summaries with destinations |

Output is **byte-stable** across runs of the same input — diffable, CI-friendly.

## Install

Nothing to install. Clone the repo and run:

```sh
python3 analyzer/webrecon_analyze.py path/to/recon-bundle.zip
```

## Usage

```sh
# Default: writes <bundle>.report.md and <bundle>.report.json next to the ZIP
python3 webrecon_analyze.py recon-docs.google.com-XXXXXX.zip

# Print markdown to stdout (no files written)
python3 webrecon_analyze.py recon-docs.google.com-XXXXXX.zip --stdout

# Custom output paths
python3 webrecon_analyze.py recon.zip --out report.md --json report.json

# Version
python3 webrecon_analyze.py --version
```

## Validation — runs against the in-repo golden tests

Two acceptance suites exercise the analyzer against the v0.1 golden bundles
at `golden-tests/sheets-125s-v0.1.0/` and `golden-tests/github-repo-120s-v0.1.2/`.

```sh
python3 analyzer/tests/test_acceptance.py
```

19/19 checks pass on v0.2.0:

**Sheets bundle** — XSSI prefix detected, `_docs_flag_initialData` and
`WIZ_global_data` captured, `streamrows` and `bind` endpoints identified,
spreadsheet IDs normalized to `{encoded}`, Google auth cookie family
(`SAPISID`, `SID`, etc.) detected, byte-stable output.

**GitHub bundle** — 89 endpoint clusters, 4 notification endpoints, 12 repo
browsing endpoints, form_submit captured, `authenticity_token` recognized
as CSRF, GitHub-specific auth headers (`X-Fetch-Nonce`,
`GitHub-Verified-Fetch`, `X-Requested-With`) detected, telemetry
classification fires, beacons summarized, byte-stable output.

## Design choices

- **stdlib only** — runs on any machine with Python 3.8+, no `pip install` step. The whole script is one file.
- **Byte-stable output** — `--json` is sorted; `--out` markdown sections are deterministic. Diffable across runs / versions.
- **No network** — the analyzer never makes HTTP requests. It only reads the bundle.
- **Honest pattern detection** — if a pattern isn't actually present, it isn't flagged. The recorder's earlier WIZ batchexecute count was inflated by an OR with XSSI detection; the analyzer separates them.
- **Heuristic, not ML** — every classification is a regex or a structural shape check, all visible in [`webrecon_analyze.py`](webrecon_analyze.py). Easy to audit and tune.

## What's intentionally *not* in v0.2.0

- **Source code analysis** — bundles only contain bundle URLs, not source. Filed as [issue #7](https://github.com/onsomlem/WebReconPack/issues/7).
- **OpenAPI / Postman generation** — separate tool, builds on this analyzer's cluster + shape inference. Filed as [issue #3](https://github.com/onsomlem/WebReconPack/issues/3).
- **Pack-to-pack diffing** — separate command, builds on this analyzer's report JSON. Filed as [issue #4](https://github.com/onsomlem/WebReconPack/issues/4).
- **Code generation / recipe synthesis** — v0.3 territory, currently under discussion.

## Example output (excerpt)

From the Sheets golden bundle:

```md
## Auth surface

**Auth-flagged request headers:**

| Header | Requests |
|---|---|
| Authorization | 33 |
| X-Goog-AuthUser | 32 |
| X-Requested-With | 4 |

**Auth-looking cookies:** APISID, SAPISID, SID, SIDCC, __Secure-1PAPISID, __Secure-3PAPISID

## Endpoint clusters by classification

### data_write (9 cluster(s), 59 request(s))

| Method | Path | Count | Statuses | Data? | Required query keys |
|---|---|---|---|---|---|
| POST | /spreadsheets/d/{encoded}/streamrows | 28 | 200×28 |  | id, includes_info_params, ouid, rpwf, smb, smv, token |
| POST | /spreadsheets/d/{encoded}/renderdata | 24 | 200×24 |  | cros_files, id, includes_info_params, nded, ouid, token |
```

A developer reading this knows in 30 seconds that:

1. Authorization is the auth header (used 33×).
2. `X-Goog-AuthUser` is the user-selector header (used 32×).
3. The live data endpoint is `streamrows` (28× POST).
4. The render endpoint is `renderdata` (24× POST).
5. Both endpoints require an `ouid` (org user ID) and `token`.

That's the analyzer's job: skip the "scroll through 300 records to figure
out the shape of the API" step.

## License

Same as parent repo.
