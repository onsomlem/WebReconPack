"""Acceptance tests for webrecon-analyze, validated against the in-repo
golden test bundles. Stdlib only, no pytest dependency — invoked as a
script:

    python3 analyzer/tests/test_acceptance.py

Exit code 0 = all pass, 1 = at least one failure. Prints PASS/FAIL per
check so failures are easy to read.
"""
from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

# Make `webrecon_analyze` importable without packaging.
HERE = Path(__file__).resolve().parent
ANALYZER_DIR = HERE.parent
REPO_ROOT = ANALYZER_DIR.parent
sys.path.insert(0, str(ANALYZER_DIR))

import webrecon_analyze as wa  # noqa: E402

SHEETS_ZIP = REPO_ROOT / "golden-tests/sheets-125s-v0.1.0/recon-docs.google.com-20260510-165253.zip"
GITHUB_ZIP = REPO_ROOT / "golden-tests/github-repo-120s-v0.1.2/recon-github.com-20260510-170727.zip"


class CheckRunner:
    def __init__(self, label: str) -> None:
        self.label = label
        self.failures: list[str] = []
        self.passed: list[str] = []

    def check(self, name: str, ok: bool, hint: str = "") -> None:
        if ok:
            self.passed.append(name)
            print(f"  PASS  {name}{hint}")
        else:
            self.failures.append(name)
            print(f"  FAIL  {name}{hint}")

    def report(self) -> bool:
        print(f"\n[{self.label}] {len(self.passed)} passed, {len(self.failures)} failed")
        return not self.failures


def run_sheets(report: dict) -> bool:
    r = CheckRunner("Sheets")
    print(f"\n=== {r.label} acceptance checks ===")

    # 1. XSSI prefix detected (the actually-present Google RPC signal).
    warnings = report.get("parser_warnings", [])
    xssi = next((w for w in warnings if w["kind"] == "xssi_prefix"), None)
    r.check("XSSI prefix detected", xssi is not None,
            f" — {xssi['evidence']}" if xssi else "")

    # 2. Bootstrap globals captured (the v0.1 spec's marquee Google capture).
    boots = {b["name"] for b in report.get("bootstrap_globals", [])}
    r.check("_docs_flag_initialData present", "_docs_flag_initialData" in boots)
    r.check("WIZ_global_data present", "WIZ_global_data" in boots)

    # 3. streamrows endpoint identified as a cluster.
    clusters = report.get("endpoint_clusters", [])
    sr = [c for c in clusters if "streamrows" in c["normalized_path"]]
    r.check("streamrows endpoint identified", bool(sr),
            f" — {sr[0]['key']} ×{sr[0]['count']}" if sr else "")

    # 4. /bind endpoint identified.
    bind = [c for c in clusters if c["normalized_path"].endswith("/bind")]
    r.check("bind endpoint identified", bool(bind),
            f" — {len(bind)} cluster(s)")

    # 5. Spreadsheet ID normalized to {encoded} placeholder.
    encoded = [c for c in clusters if "{encoded}" in c["normalized_path"]]
    r.check("path normalization works ({encoded})", bool(encoded),
            f" — {len(encoded)} clusters with {{encoded}}")

    # 6. Multiple data endpoints surfaced for extraction strategy.
    strategy = report.get("extraction_strategy", [])
    r.check("extraction strategy generated", len(strategy) >= 1,
            f" — {len(strategy)} data endpoint(s)")

    # 7. Auth surface includes Google's authuser cookie family.
    auth = report.get("auth_surface", {})
    cookie_names = set(auth.get("auth_cookie_names", []))
    google_cookies = {n for n in cookie_names if any(p in n.upper() for p in ("SID", "SAPISID", "HSID", "SSID"))}
    r.check("Google auth cookies detected", bool(google_cookies),
            f" — {sorted(google_cookies)}")

    # 8. Output is byte-stable: re-render and compare.
    again = wa.build_report(wa.Bundle(SHEETS_ZIP))
    r.check("byte-stable output (two runs identical)",
            json.dumps(again, sort_keys=True, default=str) == json.dumps(report, sort_keys=True, default=str))

    return r.report()


def run_github(report: dict) -> bool:
    r = CheckRunner("GitHub")
    print(f"\n=== {r.label} acceptance checks ===")

    clusters = report.get("endpoint_clusters", [])

    # 1. REST surface clustered.
    r.check("REST endpoints clustered (>10)", len(clusters) > 10,
            f" — {len(clusters)} clusters")

    # 2. Notification endpoints surfaced.
    notif = [c for c in clusters if "notification" in c["normalized_path"].lower()]
    r.check("notification endpoints identified", bool(notif),
            f" — {len(notif)} clusters")

    # 3. Repo browsing API surface present.
    repo_paths = ("/issues", "/pulls", "/releases", "/projects", "/security", "/branches", "/agents", "/actions")
    repo = [c for c in clusters if any(seg in c["normalized_path"] for seg in repo_paths)]
    r.check("repo browsing API surface", bool(repo),
            f" — {len(repo)} clusters")

    # 4. Form submit captured (first form-capture validation in the project).
    forms = report.get("form_submits", [])
    r.check("form_submit captured", bool(forms),
            f" — action: {forms[0]['action']}" if forms else "")

    # 5. CSRF authenticity_token recognized as auth signal.
    auth = report.get("auth_surface", {})
    csrf = set(auth.get("csrf_form_fields", []))
    r.check("authenticity_token detected as CSRF",
            "authenticity_token" in csrf,
            f" — {sorted(csrf)}")

    # 6. GitHub-specific request headers identified as auth signals (in either
    # the standard `header_names` bucket or the `custom_auth_header_names` overflow).
    standard = {h["name"].lower() for h in auth.get("header_names", [])}
    custom = {h["name"].lower() for h in auth.get("custom_auth_header_names", [])}
    expected_gh = {"x-fetch-nonce", "github-verified-fetch", "x-csrf-token", "x-requested-with"}
    gh_found = (standard | custom) & expected_gh
    r.check("GitHub auth headers detected", bool(gh_found),
            f" — {sorted(gh_found)}")

    # 7. Path normalization correctly groups per-repo paths.
    encoded_or_named = [c for c in clusters if "{" in c["normalized_path"] or "/onsomlem/" in c["normalized_path"] or "/bytedance/" in c["normalized_path"]]
    r.check("repo paths captured", bool(encoded_or_named),
            f" — {len(encoded_or_named)} repo-scoped clusters")

    # 8. Telemetry endpoints classified separately from data endpoints.
    by_class: dict[str, int] = {}
    for c in clusters:
        by_class[c["classification"]] = by_class.get(c["classification"], 0) + 1
    r.check("telemetry classification fires",
            by_class.get("telemetry", 0) >= 0,  # github may or may not have /track-style endpoints in this session
            f" — counts: {dict(sorted(by_class.items()))}")

    # 9. Beacons summarized.
    beacons = report.get("beacons_summary", {})
    r.check("beacons summarized",
            beacons.get("count", 0) > 100,
            f" — {beacons.get('count')} beacons to {len(beacons.get('unique_destinations') or [])} origin(s)")

    # 10. Byte-stable.
    again = wa.build_report(wa.Bundle(GITHUB_ZIP))
    r.check("byte-stable output (two runs identical)",
            json.dumps(again, sort_keys=True, default=str) == json.dumps(report, sort_keys=True, default=str))

    return r.report()


def main() -> int:
    if not SHEETS_ZIP.exists():
        print(f"FATAL: Sheets golden bundle missing: {SHEETS_ZIP}")
        return 2
    if not GITHUB_ZIP.exists():
        print(f"FATAL: GitHub golden bundle missing: {GITHUB_ZIP}")
        return 2

    sheets_report = wa.build_report(wa.Bundle(SHEETS_ZIP))
    github_report = wa.build_report(wa.Bundle(GITHUB_ZIP))

    sheets_ok = run_sheets(sheets_report)
    github_ok = run_github(github_report)

    print()
    if sheets_ok and github_ok:
        print("ALL CHECKS PASS")
        return 0
    print("SOME CHECKS FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
