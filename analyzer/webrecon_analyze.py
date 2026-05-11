#!/usr/bin/env python3
"""webrecon-analyze — analyze a WebReconPack recon pack.

Consumes a WebReconPack v0.1+ ZIP and produces a structured analysis
report (markdown + JSON sibling) covering:

  - top endpoints with classification
  - auth/session clue extraction
  - pagination signal detection
  - likely data endpoints (high-volume JSON returning record-like arrays)
  - extraction strategy hints per cluster
  - sample jq + curl recipes per cluster
  - parser warnings (XSSI prefix, base64 fields, protobuf bodies, NDJSON)

Single-file, stdlib-only, Python 3.8+. No external dependencies.

Usage:
  webrecon-analyze <bundle.zip>                         # writes <stem>.report.md + .report.json next to ZIP
  webrecon-analyze <bundle.zip> --stdout                # prints markdown to stdout
  webrecon-analyze <bundle.zip> --out report.md         # custom output path
  webrecon-analyze <bundle.zip> --json report.json      # custom JSON path
  webrecon-analyze --version
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter, OrderedDict, defaultdict
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qsl, urlparse

VERSION = "0.2.0"

# ---------------------------------------------------------------------------
# Heuristics — kept as module-level constants so they're discoverable + tunable.
# ---------------------------------------------------------------------------

AUTH_HEADER_NAMES = {
    "authorization",
    "cookie",
    "x-auth-token",
    "x-api-key",
    "x-csrf-token",
    "x-csrftoken",
    "x-xsrf-token",
    "x-fetch-nonce",
    "x-requested-with",
    "github-verified-fetch",
    "x-github-token",
    "x-amz-security-token",
    "x-firebase-appcheck",
    "x-goog-authuser",
    "x-google-auth-token",
}

CSRF_FIELD_NAMES = {
    "authenticity_token",
    "csrf_token",
    "csrf-token",
    "csrfmiddlewaretoken",
    "_csrf",
    "_token",
    "xsrf_token",
}

AUTH_QUERY_PARAM_NAMES = {
    "token",
    "auth_token",
    "access_token",
    "id_token",
    "refresh_token",
    "api_key",
    "apikey",
    "key",
    "sid",
    "session_id",
    "jwt",
    "code",
    "state",
    "client_id",
    "code_verifier",
    "code_challenge",
}

AUTH_COOKIE_NAME_RE = re.compile(
    r"(session|sid|jwt|auth|token|csrf|xsrf|sso|oauth|sapisid|hsid|ssid|apisid)",
    re.I,
)

PAGINATION_PARAM_NAMES = {
    "cursor",
    "after",
    "before",
    "page",
    "p",
    "offset",
    "skip",
    "limit",
    "size",
    "perpage",
    "per_page",
    "pagesize",
    "page_size",
    "pagetoken",
    "page_token",
    "continuation",
    "continuation_token",
    "next",
    "next_token",
    "starting_after",
    "ending_before",
    "since",
    "until",
    "from",
    "to",
    "marker",
}

PAGINATION_RESPONSE_KEYS = {
    "next",
    "next_cursor",
    "nextpage",
    "next_page",
    "next_page_token",
    "nextpagetoken",
    "endcursor",
    "end_cursor",
    "hasnextpage",
    "has_next_page",
    "has_more",
    "hasmore",
    "_links",
    "links",
    "pageinfo",
    "page_info",
    "continuation_token",
    "continuationtoken",
    "next_offset",
}

LIST_RESPONSE_KEYS = {
    "items",
    "data",
    "results",
    "records",
    "entries",
    "edges",
    "nodes",
    "rows",
    "list",
    "values",
    "objects",
    "elements",
    "documents",
    "messages",
    "events",
}

TELEMETRY_PATH_RE = re.compile(
    r"/(collect|log|logs?|metric|metrics|track|tracking|telemetry|"
    r"pixel|beacon|stats|analytic|analytics|ping|heartbeat|errors?|"
    r"crash|measure|insight|insights)\b",
    re.I,
)

AUTH_PATH_RE = re.compile(
    r"/(login|logout|auth|authn|authentication|signin|sign-in|sign_in|"
    r"signup|sign-up|register|token|oauth|oauth2|sso|sessions?|csrf|"
    r"verify|2fa|mfa|otp|whoami|me|account|userinfo|jwks|openid)\b",
    re.I,
)

ASSET_MIME_PREFIXES = ("image/", "font/", "video/", "audio/", "text/css")

# Patterns that suggest a payload field is base64-encoded data.
BASE64_FIELD_RE = re.compile(r"^[A-Za-z0-9+/]{40,}={0,2}$")

# WIZ batchexecute marker.
WIZ_BATCHEXECUTE_PATH_RE = re.compile(r"/batchexecute\b", re.I)

# XSSI/XSRF prefix used by Google + GitHub (sometimes).
XSSI_PREFIX_RE = re.compile(r"^\)\]\}',?\n?")

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)
LONG_NUMERIC_RE = re.compile(r"^\d{4,}$")
ENCODED_SEGMENT_RE = re.compile(r"^[A-Za-z0-9+/=_-]{32,}$")


def normalize_path(pathname: str | None) -> str:
    """Replace UUIDs / long numeric IDs / base64-ish segments in a URL path."""
    if not pathname:
        return pathname or ""
    out = []
    for seg in pathname.split("/"):
        if not seg:
            out.append(seg)
            continue
        if UUID_RE.match(seg):
            out.append("{uuid}")
        elif LONG_NUMERIC_RE.match(seg):
            out.append("{id}")
        elif ENCODED_SEGMENT_RE.match(seg):
            out.append("{encoded}")
        else:
            out.append(seg)
    return "/".join(out)


def safe_url_parts(url: str | None) -> tuple[str | None, str | None, list[tuple[str, str]]]:
    """Return (origin, normalized_path, query_pairs) or (None, None, []) on parse failure."""
    if not url:
        return None, None, []
    try:
        p = urlparse(url)
    except ValueError:
        return None, None, []
    if not p.scheme or not p.netloc:
        # Likely a relative URL recorded as-is by the extension. Fall back to
        # the path as the only identity we can recover.
        path = normalize_path(p.path or url)
        query = parse_qsl(p.query, keep_blank_values=True) if p.query else []
        return None, path, query
    origin = f"{p.scheme}://{p.netloc}"
    return origin, normalize_path(p.path or "/"), parse_qsl(p.query, keep_blank_values=True)


# ---------------------------------------------------------------------------
# Bundle loader
# ---------------------------------------------------------------------------


class Bundle:
    """Lazy-ish loader for a WebReconPack ZIP. Parses everything at construction."""

    JSONL_FILES = (
        "network.jsonl",
        "beacons.jsonl",
        "forms.jsonl",
        "navigation.jsonl",
        "user-events.jsonl",
        "scripts.jsonl",
        "downloads.jsonl",
        "clipboard.jsonl",
        "files.jsonl",
        "workers.jsonl",
        "websockets.jsonl",
        "sse.jsonl",
        "console.jsonl",
        "timeline.jsonl",
    )
    JSON_FILES = (
        "manifest.json",
        "globals.json",
        "storage.json",
        "runtime.json",
        "performance.json",
        "loaded-scripts.json",
        "loaded-styles.json",
    )

    def __init__(self, zip_path: str | os.PathLike[str]) -> None:
        self.zip_path = Path(zip_path)
        if not self.zip_path.exists():
            raise FileNotFoundError(self.zip_path)
        self.data: dict[str, Any] = {}
        with zipfile.ZipFile(self.zip_path, "r") as zf:
            names = set(zf.namelist())
            for name in self.JSONL_FILES:
                self.data[name] = self._load_jsonl(zf, name) if name in names else []
            for name in self.JSON_FILES:
                self.data[name] = self._load_json(zf, name) if name in names else None

    @staticmethod
    def _load_jsonl(zf: zipfile.ZipFile, name: str) -> list[dict]:
        out: list[dict] = []
        with zf.open(name) as f:
            for raw in io.TextIOWrapper(f, encoding="utf-8"):
                line = raw.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return out

    @staticmethod
    def _load_json(zf: zipfile.ZipFile, name: str) -> Any:
        with zf.open(name) as f:
            return json.load(f)

    # Convenience accessors --------------------------------------------------
    @property
    def manifest(self) -> dict:
        return self.data["manifest.json"] or {}

    @property
    def network(self) -> list[dict]:
        return self.data["network.jsonl"]

    @property
    def beacons(self) -> list[dict]:
        return self.data["beacons.jsonl"]

    @property
    def forms(self) -> list[dict]:
        return self.data["forms.jsonl"]

    @property
    def navigation(self) -> list[dict]:
        return self.data["navigation.jsonl"]

    @property
    def user_events(self) -> list[dict]:
        return self.data["user-events.jsonl"]

    @property
    def scripts(self) -> list[dict]:
        return self.data["scripts.jsonl"]

    @property
    def downloads(self) -> list[dict]:
        return self.data["downloads.jsonl"]

    @property
    def workers(self) -> list[dict]:
        return self.data["workers.jsonl"]

    @property
    def websockets(self) -> list[dict]:
        return self.data["websockets.jsonl"]

    @property
    def console(self) -> list[dict]:
        return self.data["console.jsonl"]

    @property
    def timeline(self) -> list[dict]:
        return self.data["timeline.jsonl"]

    @property
    def globals_(self) -> Any:
        return self.data["globals.json"] or []

    @property
    def storage(self) -> Any:
        return self.data["storage.json"] or {}

    @property
    def runtime(self) -> Any:
        return self.data["runtime.json"] or {}

    @property
    def loaded_scripts(self) -> Any:
        return self.data["loaded-scripts.json"] or []


# ---------------------------------------------------------------------------
# Endpoint cluster
# ---------------------------------------------------------------------------


class Cluster:
    """An aggregate over network records sharing (method, normalized_path)."""

    __slots__ = (
        "method",
        "norm_path",
        "origin",
        "count",
        "statuses",
        "query_keys",
        "query_keys_required",
        "request_mimes",
        "response_mimes",
        "request_body_samples",
        "response_body_samples",
        "response_inline_samples",  # raw text — needed for XSSI prefix detection
        "url_examples",
        "auth_headers_present",
        "rate_limit_headers",
        "ids",
    )

    def __init__(self, method: str, norm_path: str, origin: str | None) -> None:
        self.method = method or "?"
        self.norm_path = norm_path or "/"
        self.origin = origin
        self.count = 0
        self.statuses: Counter[int | str] = Counter()
        self.query_keys: Counter[str] = Counter()
        self.query_keys_required = 0  # incremented per-record presence; compared to count
        self.request_mimes: Counter[str] = Counter()
        self.response_mimes: Counter[str] = Counter()
        self.request_body_samples: list[Any] = []  # decoded
        self.response_body_samples: list[Any] = []  # decoded
        self.response_inline_samples: list[str] = []  # raw text (pre-decode)
        self.url_examples: list[str] = []
        self.auth_headers_present: Counter[str] = Counter()
        self.rate_limit_headers: Counter[str] = Counter()
        self.ids: list[str] = []

    @property
    def key(self) -> str:
        return f"{self.method} {self.norm_path}"

    def required_query_keys(self) -> list[str]:
        """Query keys that appear on every record in this cluster."""
        return sorted(k for k, v in self.query_keys.items() if v == self.count)

    def optional_query_keys(self) -> list[str]:
        return sorted(k for k, v in self.query_keys.items() if 0 < v < self.count)


def cluster_network(records: Iterable[dict]) -> dict[str, Cluster]:
    clusters: dict[str, Cluster] = {}
    for r in records:
        method = (r.get("method") or "?").upper()
        url = r.get("url") or ""
        url_parts = r.get("url_parts") or {}
        origin = url_parts.get("origin")
        pathname = url_parts.get("pathname")
        # Fall back to URL parser if recorder didn't supply parts (e.g. relative URLs).
        if origin is None or pathname is None:
            o, p, _ = safe_url_parts(url)
            origin = origin or o
            pathname = pathname or p
        norm = normalize_path(pathname)
        key = f"{method} {norm}"
        c = clusters.get(key)
        if c is None:
            c = Cluster(method, norm, origin)
            clusters[key] = c
        c.count += 1
        c.ids.append(str(r.get("id") or ""))
        status = r.get("status")
        c.statuses[status if status is not None else "?"] += 1
        # query
        try:
            qpairs = parse_qsl((url_parts.get("search") or "").lstrip("?"), keep_blank_values=True)
        except ValueError:
            qpairs = []
        seen_keys: set[str] = set()
        for k, _v in qpairs:
            if k not in seen_keys:
                c.query_keys[k] += 1
                seen_keys.add(k)
        # mimes
        req_h = {(k or "").lower(): v for k, v in (r.get("requestHeaders") or {}).items()}
        resp_h = {(k or "").lower(): v for k, v in (r.get("responseHeaders") or {}).items()}
        if "content-type" in req_h:
            c.request_mimes[str(req_h["content-type"]).split(";")[0].strip()] += 1
        resp_mime = r.get("responseMime") or resp_h.get("content-type")
        if resp_mime:
            c.response_mimes[str(resp_mime).split(";")[0].strip()] += 1
        # auth headers
        for h in req_h:
            if h in AUTH_HEADER_NAMES or h.startswith(("x-auth", "x-api", "x-csrf", "x-xsrf")):
                c.auth_headers_present[h] += 1
        # rate-limit headers
        for h in resp_h:
            if h.startswith(("x-ratelimit", "ratelimit-", "x-rate-limit", "retry-after")):
                c.rate_limit_headers[h] += 1
        # bodies (decoded form preferred; fall back to inline string)
        rb = r.get("requestBody") or {}
        if rb.get("decoded") is not None and len(c.request_body_samples) < 3:
            c.request_body_samples.append(rb["decoded"])
        sb = r.get("responseBody") or {}
        # Always keep the raw inline text up to a small cap — needed for XSSI
        # prefix detection (the decoded form has the prefix already stripped).
        if sb.get("inline") and len(c.response_inline_samples) < 3:
            c.response_inline_samples.append(str(sb["inline"])[:512])
        if sb.get("decoded") is not None and len(c.response_body_samples) < 3:
            c.response_body_samples.append(sb["decoded"])
        elif sb.get("inline") and len(c.response_body_samples) < 3 and sb.get("type") == "json":
            try:
                c.response_body_samples.append(json.loads(sb["inline"]))
            except (json.JSONDecodeError, TypeError):
                pass
        # url examples
        if len(c.url_examples) < 3:
            c.url_examples.append(url)
    return clusters


# ---------------------------------------------------------------------------
# Classification + heuristics
# ---------------------------------------------------------------------------


def classify_cluster(c: Cluster) -> str:
    """Return one of: telemetry, auth, asset, rpc, data_write, data_fetch, unknown."""
    path = c.norm_path or ""
    # Asset by mime
    if any(m.startswith(ASSET_MIME_PREFIXES) for m in c.response_mimes):
        return "asset"
    if TELEMETRY_PATH_RE.search(path):
        return "telemetry"
    if AUTH_PATH_RE.search(path):
        return "auth"
    if WIZ_BATCHEXECUTE_PATH_RE.search(path):
        return "rpc"
    if "/graphql" in path.lower() or "/$rpc/" in path.lower() or "/trpc/" in path.lower():
        return "rpc"
    if c.method in {"POST", "PUT", "PATCH", "DELETE"}:
        return "data_write"
    if c.method == "GET":
        return "data_fetch"
    return "unknown"


def shape_of(value: Any, depth: int = 2) -> Any:
    """Tiny structural descriptor — type names + array lengths + key sets."""
    if depth < 0:
        return "..."
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return {
            "_type": "array",
            "length": len(value),
            "sample": [shape_of(v, depth - 1) for v in value[:1]],
        }
    if isinstance(value, dict):
        out: dict[str, Any] = {"_type": "object"}
        for k in sorted(value.keys())[:20]:
            try:
                out[k] = shape_of(value[k], depth - 1)
            except Exception:
                out[k] = "[unreadable]"
        return out
    return type(value).__name__


def merge_shapes(samples: Iterable[Any]) -> Any:
    """Union the top-level keys/types across multiple sample bodies."""
    shapes = [shape_of(s, depth=2) for s in samples]
    if not shapes:
        return None
    if len(shapes) == 1:
        return shapes[0]
    # Merge object shapes by key union
    if all(isinstance(s, dict) and s.get("_type") == "object" for s in shapes):
        merged: dict[str, Any] = {"_type": "object"}
        keys: set[str] = set()
        for s in shapes:
            keys.update(k for k in s if k != "_type")
        for k in sorted(keys):
            types = sorted({_type_label_of(s.get(k)) for s in shapes if k in s})
            merged[k] = " | ".join(types)
        return merged
    return shapes[0]


def _type_label_of(v: Any) -> str:
    if isinstance(v, dict):
        return v.get("_type", "object")
    if isinstance(v, str):
        return v
    return type(v).__name__


def detect_pagination(c: Cluster) -> dict[str, Any]:
    """Look for cursor/offset/page/Link signals in query keys + response shape."""
    indicators: list[str] = []
    for q in (c.query_keys.keys() if c.query_keys else ()):
        if q.lower() in PAGINATION_PARAM_NAMES:
            indicators.append(f"query:{q}")
    # Response shape signals
    response_keys: set[str] = set()
    list_field: str | None = None
    for sample in c.response_body_samples:
        if isinstance(sample, dict):
            for k in sample:
                response_keys.add(k.lower())
                if list_field is None and k.lower() in LIST_RESPONSE_KEYS and isinstance(sample[k], list):
                    list_field = k
    for k in response_keys & PAGINATION_RESPONSE_KEYS:
        indicators.append(f"response:{k}")
    return {
        "indicators": sorted(set(indicators)),
        "list_field": list_field,
        "is_paginated": bool(indicators),
    }


def detect_xssi(c: Cluster) -> bool:
    """Look for the )]}' / )]}', / )]}'\\n prefix in raw response bodies."""
    for raw in c.response_inline_samples:
        if XSSI_PREFIX_RE.match(raw):
            return True
    return False


def detect_wiz_batchexecute(c: Cluster) -> bool:
    """WIZ batchexecute can appear in the path or in any URL example."""
    if WIZ_BATCHEXECUTE_PATH_RE.search(c.norm_path):
        return True
    for u in c.url_examples:
        if WIZ_BATCHEXECUTE_PATH_RE.search(u or ""):
            return True
    return False


def detect_base64_fields(samples: Iterable[Any]) -> list[str]:
    """Return field paths whose values look base64-encoded."""
    found: list[str] = []
    for s in samples:
        _walk_for_base64(s, "", found)
    return sorted(set(found))[:5]


def _walk_for_base64(v: Any, path: str, found: list[str]) -> None:
    if isinstance(v, str) and len(v) > 40 and BASE64_FIELD_RE.match(v):
        found.append(path or "<root>")
    elif isinstance(v, dict):
        for k, sub in list(v.items())[:30]:
            _walk_for_base64(sub, f"{path}.{k}" if path else k, found)
    elif isinstance(v, list):
        for i, sub in enumerate(v[:3]):
            _walk_for_base64(sub, f"{path}[{i}]", found)


def is_data_endpoint(c: Cluster, classification: str) -> bool:
    """Heuristic: looks like a real data fetch worth recipe-izing."""
    if classification != "data_fetch":
        return False
    if not any(("json" in (m or "").lower()) for m in c.response_mimes):
        return False
    if c.statuses:
        most_common = c.statuses.most_common(1)[0][0]
        if not (200 <= int(most_common) < 300 if isinstance(most_common, int) else False):
            return False
    # Response is either an array or contains a list field
    for s in c.response_body_samples:
        if isinstance(s, list):
            return True
        if isinstance(s, dict):
            for k, v in s.items():
                if k.lower() in LIST_RESPONSE_KEYS and isinstance(v, list):
                    return True
    return False


# ---------------------------------------------------------------------------
# Auth surface extraction
# ---------------------------------------------------------------------------


def extract_auth_signals(b: Bundle) -> dict[str, Any]:
    headers = Counter()
    custom_auth = Counter()
    cookies = set()
    csrf_form_fields = set()
    query_params = Counter()
    bearer_observed = False

    for r in b.network:
        for h_name, h_val in (r.get("requestHeaders") or {}).items():
            low = (h_name or "").lower()
            if low in AUTH_HEADER_NAMES:
                headers[h_name] += 1
            elif low.startswith(("x-auth", "x-api", "x-csrf", "x-xsrf", "x-token", "x-fetch-")):
                custom_auth[h_name] += 1
            if low == "authorization" and isinstance(h_val, str) and "bearer" in h_val.lower():
                bearer_observed = True
        url = r.get("url") or ""
        url_parts = r.get("url_parts") or {}
        try:
            qpairs = parse_qsl((url_parts.get("search") or "").lstrip("?"), keep_blank_values=True)
        except ValueError:
            qpairs = []
        for k, _v in qpairs:
            if k.lower() in AUTH_QUERY_PARAM_NAMES:
                query_params[k] += 1

    for f in b.forms:
        for field in f.get("fields") or []:
            name = (field.get("name") or "").lower()
            if name in CSRF_FIELD_NAMES:
                csrf_form_fields.add(field.get("name"))

    storage = b.storage or {}
    per_frame = storage.get("perFrame") or []
    for frame in per_frame:
        cookies_raw = frame.get("cookies") or ""
        if isinstance(cookies_raw, str):
            for piece in cookies_raw.split(";"):
                name = piece.split("=", 1)[0].strip()
                if name and AUTH_COOKIE_NAME_RE.search(name):
                    cookies.add(name)

    return {
        "header_names": _counter_to_sorted(headers),
        "custom_auth_header_names": _counter_to_sorted(custom_auth),
        "auth_query_params": _counter_to_sorted(query_params),
        "auth_cookie_names": sorted(cookies),
        "csrf_form_fields": sorted(csrf_form_fields),
        "bearer_token_observed": bearer_observed,
    }


def _counter_to_sorted(c: Counter) -> list[dict]:
    return [
        {"name": k, "count": v}
        for k, v in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


# ---------------------------------------------------------------------------
# Recipes
# ---------------------------------------------------------------------------


def jq_recipe_for(c: Cluster, list_field: str | None) -> str:
    """Build a one-liner jq recipe to extract data from this cluster's responses."""
    # Use the path pattern, escaped for jq's `test()` regex.
    path_re = re.escape(c.norm_path).replace(r"\{uuid\}", "[0-9a-f-]+").replace(
        r"\{id\}", r"\\d+"
    ).replace(r"\{encoded\}", "[A-Za-z0-9+/=_-]+")
    if c.method == "GET":
        method_filter = ""
    else:
        method_filter = f' and .method=="{c.method}"'
    if list_field:
        body_path = f".responseBody.decoded.{list_field}[]?"
    else:
        body_path = ".responseBody.decoded // .responseBody.inline"
    return (
        f"jq -c 'select(.url|test(\"{path_re}\"){method_filter}) | "
        f"{body_path}' network.jsonl"
    )


def curl_recipe_for(c: Cluster, auth_headers: list[str]) -> str:
    """Suggest a curl invocation. Auth headers are included as REDACTED placeholders."""
    if not c.url_examples:
        return f"# (no example URL captured for {c.key})"
    sample_url = c.url_examples[0]
    # If the URL is relative (no origin), prepend the cluster origin if known.
    if sample_url.startswith("/") and c.origin:
        sample_url = c.origin + sample_url
    parts = ["curl -s", f"  -X {c.method}", f"  '{sample_url}'"]
    for h in auth_headers[:4]:
        parts.append(f"  -H '{h}: <REDACTED>'")
    return " \\\n".join(parts)


# ---------------------------------------------------------------------------
# Report builder
# ---------------------------------------------------------------------------


def build_report(b: Bundle) -> dict[str, Any]:
    """Compute the structured report. Returns the JSON form; markdown is rendered from it."""
    clusters = cluster_network(b.network)
    sorted_clusters = sorted(clusters.values(), key=lambda c: (-c.count, c.key))

    auth_signals = extract_auth_signals(b)

    cluster_reports: list[dict[str, Any]] = []
    for c in sorted_clusters:
        classification = classify_cluster(c)
        pagination = detect_pagination(c)
        is_data = is_data_endpoint(c, classification)
        b64 = detect_base64_fields(c.response_body_samples)
        request_shape = merge_shapes(c.request_body_samples)
        response_shape = merge_shapes(c.response_body_samples)
        auth_headers_in_cluster = sorted(c.auth_headers_present.keys())
        cr = {
            "key": c.key,
            "method": c.method,
            "normalized_path": c.norm_path,
            "origin": c.origin,
            "count": c.count,
            "classification": classification,
            "is_data_endpoint": is_data,
            "statuses": dict(
                sorted(
                    ((str(k), v) for k, v in c.statuses.items()),
                    key=lambda kv: (-kv[1], kv[0]),
                )
            ),
            "required_query_keys": c.required_query_keys(),
            "optional_query_keys": c.optional_query_keys(),
            "request_mimes": _counter_to_sorted(c.request_mimes),
            "response_mimes": _counter_to_sorted(c.response_mimes),
            "request_body_shape": request_shape,
            "response_body_shape": response_shape,
            "pagination": pagination,
            "base64_response_fields": b64,
            "auth_headers_used": auth_headers_in_cluster,
            "rate_limit_headers": sorted(c.rate_limit_headers.keys()),
            "url_examples": c.url_examples,
            "recipes": {
                "jq": jq_recipe_for(c, pagination.get("list_field")),
                "curl": curl_recipe_for(c, auth_headers_in_cluster),
            },
        }
        cluster_reports.append(cr)

    parser_warnings = _detect_parser_warnings(b, sorted_clusters)
    bootstrap_globals = _summarize_bootstrap_globals(b)
    likely_data_endpoints = [c for c in cluster_reports if c["is_data_endpoint"]]
    extraction_strategy = _build_extraction_strategy(likely_data_endpoints)

    return {
        "schema_version": "0.1",
        "analyzer_version": VERSION,
        "tool_version": (b.manifest or {}).get("tool_version"),
        "session_id": (b.manifest or {}).get("session_id"),
        "bundle": {
            "filename": b.zip_path.name,
            "size_bytes": b.zip_path.stat().st_size,
            "started_at": (b.manifest or {}).get("started_at"),
            "ended_at": (b.manifest or {}).get("ended_at"),
            "duration_ms": (b.manifest or {}).get("duration_ms"),
            "start_url": (b.manifest or {}).get("start_url"),
            "end_url": (b.manifest or {}).get("end_url"),
            "counts": (b.manifest or {}).get("counts"),
            "frames_seen": (b.manifest or {}).get("frames_seen"),
            "redaction": (b.manifest or {}).get("redaction"),
        },
        "auth_surface": auth_signals,
        "endpoint_clusters": cluster_reports,
        "likely_data_endpoints": [c["key"] for c in likely_data_endpoints],
        "extraction_strategy": extraction_strategy,
        "parser_warnings": parser_warnings,
        "bootstrap_globals": bootstrap_globals,
        "form_submits": [
            {
                "action": f.get("action"),
                "method": f.get("method"),
                "enctype": f.get("enctype"),
                "field_names": [fld.get("name") for fld in (f.get("fields") or [])],
                "submitter_text": (f.get("submitter") or {}).get("text"),
            }
            for f in b.forms
        ],
        "beacons_summary": {
            "count": len(b.beacons),
            "unique_destinations": sorted(
                {(b_.get("url_parts") or {}).get("origin") or "" for b_ in b.beacons} - {""}
            )[:20],
        },
        "websockets_summary": {
            "count": len(b.websockets),
            "urls": [w.get("url") for w in b.websockets][:10],
        },
        "navigation_summary": {
            "count": len(b.navigation),
            "kinds": _counter_to_sorted(Counter(n.get("kind") for n in b.navigation)),
        },
    }


def _detect_parser_warnings(b: Bundle, clusters: list[Cluster]) -> list[dict]:
    warnings: list[dict] = []
    xssi_count = sum(1 for c in clusters if detect_xssi(c))
    if xssi_count:
        warnings.append({
            "kind": "xssi_prefix",
            "evidence": f"{xssi_count} cluster(s) emit responses prefixed with )]}}'",
            "action": "Strip the leading )]}\\n before parsing JSON. Common at Google.",
        })
    base64_clusters = [c for c in clusters if detect_base64_fields(c.response_body_samples)]
    if base64_clusters:
        warnings.append({
            "kind": "base64_fields",
            "evidence": f"{len(base64_clusters)} cluster(s) emit response fields that look base64-encoded",
            "action": "Decode with base64; could be opaque tokens, signed payloads, or compressed data.",
        })
    binary_clusters = [c for c in clusters if any("octet" in (m or "") or "protobuf" in (m or "") or "grpc" in (m or "") for m in c.response_mimes)]
    if binary_clusters:
        warnings.append({
            "kind": "binary_responses",
            "evidence": f"{len(binary_clusters)} cluster(s) return binary content (protobuf/grpc/octet-stream)",
            "action": "WebReconPack does not decode binary bodies. Inspect headers for encoding clues.",
        })
    ndjson_clusters = [c for c in clusters
                       if any("ndjson" in (m or "") or "jsonlines" in (m or "") or "stream+json" in (m or "") for m in c.response_mimes)]
    if ndjson_clusters:
        warnings.append({
            "kind": "ndjson_streams",
            "evidence": f"{len(ndjson_clusters)} cluster(s) return NDJSON streams",
            "action": "Parse line-by-line; each line is an independent JSON document.",
        })
    # Detect WIZ batchexecute
    wiz_clusters = [c for c in clusters if detect_wiz_batchexecute(c)]
    if wiz_clusters:
        warnings.append({
            "kind": "wiz_batchexecute",
            "evidence": f"{len(wiz_clusters)} cluster(s) use Google's WIZ batchexecute RPC mechanism",
            "action": "Request body is a form-urlencoded `f.req` blob; response is XSSI-prefixed; both are nested JSON.",
        })
    return warnings


def _summarize_bootstrap_globals(b: Bundle) -> list[dict]:
    out: list[dict] = []
    for frame in (b.globals_ or []):
        for name, info in (frame.get("bootstrap") or {}).items():
            out.append({
                "frame_url": frame.get("frameUrl"),
                "name": name,
                "type": info.get("type"),
                "size": info.get("size"),
                "truncated": info.get("truncated"),
                "shape": info.get("shape"),
            })
    return sorted(out, key=lambda r: (-(r.get("size") or 0), r.get("name") or ""))


def _build_extraction_strategy(data_endpoints: list[dict]) -> list[dict]:
    """Per likely-data endpoint, hint at how to extract records."""
    out: list[dict] = []
    for c in data_endpoints[:25]:
        list_field = (c.get("pagination") or {}).get("list_field")
        notes: list[str] = []
        if list_field:
            notes.append(f"Records live under `.{list_field}` in the response.")
        if (c.get("pagination") or {}).get("is_paginated"):
            indicators = c["pagination"]["indicators"]
            notes.append(f"Paginated — indicators: {', '.join(indicators)}")
        if c.get("auth_headers_used"):
            notes.append(f"Requires auth — headers: {', '.join(c['auth_headers_used'])}")
        if c.get("rate_limit_headers"):
            notes.append(f"Rate-limited — headers: {', '.join(c['rate_limit_headers'])}")
        if c.get("base64_response_fields"):
            notes.append(f"Base64 fields present at: {', '.join(c['base64_response_fields'])}")
        out.append({
            "endpoint": c["key"],
            "origin": c["origin"],
            "count": c["count"],
            "notes": notes,
            "jq": c["recipes"]["jq"],
            "curl": c["recipes"]["curl"],
        })
    return out


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------


def render_markdown(report: dict[str, Any]) -> str:
    L: list[str] = []
    add = L.append
    bundle = report["bundle"]
    host = _hostname(bundle.get("start_url") or "")
    add(f"# Recon Pack Analysis: {host}")
    add("")
    add(f"- **Bundle:** `{bundle['filename']}` ({_human_bytes(bundle['size_bytes'])})")
    add(f"- **Session:** `{report['session_id']}`")
    add(f"- **Captured:** {bundle['started_at']} → {bundle['ended_at']} ({_human_ms(bundle['duration_ms'])})")
    add(f"- **Tool / analyzer:** WebReconPack {report['tool_version']} / webrecon-analyze {report['analyzer_version']}")
    add(f"- **Start URL:** `{bundle.get('start_url')}`")
    if bundle.get("end_url") and bundle["end_url"] != bundle.get("start_url"):
        add(f"- **End URL:** `{bundle['end_url']}`")
    add("")

    # Counts
    add("## Counts")
    add("")
    counts = bundle.get("counts") or {}
    add(_render_table(["Counter", "Value"], [(k, str(v)) for k, v in counts.items()]))

    # Auth surface
    add("## Auth surface")
    add("")
    auth = report["auth_surface"]
    if auth["bearer_token_observed"]:
        add("- **Bearer token observed** in `Authorization` header.")
    if auth["header_names"]:
        rows = [(h["name"], str(h["count"])) for h in auth["header_names"]]
        add("")
        add("**Auth-flagged request headers:**")
        add("")
        add(_render_table(["Header", "Requests"], rows))
    if auth["custom_auth_header_names"]:
        rows = [(h["name"], str(h["count"])) for h in auth["custom_auth_header_names"]]
        add("**Custom auth-looking headers:**")
        add("")
        add(_render_table(["Header", "Requests"], rows))
    if auth["auth_cookie_names"]:
        add(f"**Auth-looking cookies:** `{', '.join(auth['auth_cookie_names'])}`")
        add("")
    if auth["csrf_form_fields"]:
        add(f"**CSRF form fields detected:** `{', '.join(auth['csrf_form_fields'])}`")
        add("")
    if auth["auth_query_params"]:
        add(f"**Auth-flagged query params:** `{', '.join(p['name'] for p in auth['auth_query_params'])}`")
        add("")
    if not any([auth["header_names"], auth["custom_auth_header_names"], auth["auth_cookie_names"], auth["csrf_form_fields"], auth["auth_query_params"], auth["bearer_token_observed"]]):
        add("_No standard auth signals detected. The site may be unauthenticated, use opaque cookies only, or use techniques outside the heuristic set._")
        add("")

    # Top endpoints by classification
    add("## Endpoint clusters by classification")
    add("")
    by_class: dict[str, list[dict]] = defaultdict(list)
    for c in report["endpoint_clusters"]:
        by_class[c["classification"]].append(c)
    for cls in ("data_fetch", "data_write", "rpc", "auth", "telemetry", "asset", "unknown"):
        items = by_class.get(cls) or []
        if not items:
            continue
        total = sum(c["count"] for c in items)
        add(f"### {cls} ({len(items)} cluster(s), {total} request(s))")
        add("")
        rows = []
        for c in items[:25]:
            statuses = ", ".join(f"{s}×{n}" for s, n in c["statuses"].items())
            rows.append([
                c["method"],
                c["normalized_path"],
                str(c["count"]),
                statuses,
                "yes" if c["is_data_endpoint"] else "",
                ", ".join(c["required_query_keys"]) or "—",
            ])
        add(_render_table(
            ["Method", "Path", "Count", "Statuses", "Data?", "Required query keys"],
            rows,
        ))

    # Likely data endpoints with extraction strategy
    add("## Likely data endpoints — extraction strategy")
    add("")
    if not report["extraction_strategy"]:
        add("_No high-confidence data endpoints. Either the session didn't exercise list-returning APIs, or responses were not JSON arrays/objects-with-arrays._")
        add("")
    for s in report["extraction_strategy"]:
        add(f"### `{s['endpoint']}` ({s['count']}× from `{s.get('origin') or 'unknown'}`)")
        add("")
        for note in s["notes"]:
            add(f"- {note}")
        if not s["notes"]:
            add("- _No special notes detected — should be straightforward JSON extraction._")
        add("")
        add("**jq recipe:**")
        add("")
        add("```sh")
        add(s["jq"])
        add("```")
        add("")
        add("**curl skeleton:**")
        add("")
        add("```sh")
        add(s["curl"])
        add("```")
        add("")

    # Parser warnings
    add("## Parser warnings")
    add("")
    if report["parser_warnings"]:
        for w in report["parser_warnings"]:
            add(f"- **{w['kind']}** — {w['evidence']}")
            add(f"  - _Action:_ {w['action']}")
        add("")
    else:
        add("_No parser warnings — captured responses look standards-compliant._")
        add("")

    # Bootstrap globals
    add("## Bootstrap globals (per-frame initial state)")
    add("")
    if report["bootstrap_globals"]:
        rows = [(g["frame_url"] or "—", g["name"], g["type"] or "?", str(g["size"]) if g["size"] is not None else "?", "yes" if g["truncated"] else "no") for g in report["bootstrap_globals"]]
        add(_render_table(["Frame", "Global", "Type", "Size (bytes)", "Truncated"], rows))
    else:
        add("_None of the well-known bootstrap globals were present in any frame._")
        add("")

    # Form submits
    if report["form_submits"]:
        add("## Form submits")
        add("")
        rows = [(f["action"] or "—", f["method"], f["enctype"] or "—", f["submitter_text"] or "—", ", ".join(n for n in f["field_names"] if n) or "—") for f in report["form_submits"]]
        add(_render_table(["Action", "Method", "Enctype", "Submitter", "Field names"], rows))

    # Realtime / beacons
    if report["beacons_summary"]["count"]:
        add("## Beacons (sendBeacon)")
        add("")
        add(f"- **Count:** {report['beacons_summary']['count']}")
        if report["beacons_summary"]["unique_destinations"]:
            add(f"- **Origins:** {', '.join(report['beacons_summary']['unique_destinations'])}")
        add("")
    if report["websockets_summary"]["count"]:
        add("## WebSockets")
        add("")
        add(f"- **Count:** {report['websockets_summary']['count']}")
        for u in report["websockets_summary"]["urls"]:
            add(f"  - `{u}`")
        add("")

    # Navigation summary
    add("## Navigation events")
    add("")
    add(f"- **Total:** {report['navigation_summary']['count']}")
    if report["navigation_summary"]["kinds"]:
        add("- **By kind:** " + ", ".join(f"{k['name']}×{k['count']}" for k in report["navigation_summary"]["kinds"]))
    add("")

    add("---")
    add("")
    add(f"_Generated by webrecon-analyze v{report['analyzer_version']} — local-only browsing recon._")
    return "\n".join(L) + "\n"


def _render_table(headers: list[str], rows: list[Iterable[str]]) -> str:
    if not rows:
        return "_(empty)_\n"
    L: list[str] = []
    L.append("| " + " | ".join(headers) + " |")
    L.append("|" + "|".join(["---"] * len(headers)) + "|")
    for r in rows:
        L.append("| " + " | ".join(str(c) for c in r) + " |")
    L.append("")
    return "\n".join(L)


def _hostname(url: str) -> str:
    try:
        return urlparse(url).hostname or "unknown"
    except ValueError:
        return "unknown"


def _human_bytes(n: int | None) -> str:
    if n is None:
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}" if isinstance(n, float) else f"{n} {unit}"
        n = n / 1024
    return f"{n:.1f} TB"


def _human_ms(ms: int | None) -> str:
    if not ms:
        return "?"
    s = ms / 1000
    if s < 60:
        return f"{s:.1f}s"
    m = int(s // 60)
    rs = s - m * 60
    return f"{m}m {rs:.1f}s"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="webrecon-analyze",
        description="Analyze a WebReconPack recon pack ZIP and emit a structured report.",
    )
    parser.add_argument("zip_path", nargs="?", help="Path to the recon pack ZIP")
    parser.add_argument("--out", help="Write markdown report to this path")
    parser.add_argument("--json", dest="json_out", help="Write JSON report to this path")
    parser.add_argument("--stdout", action="store_true", help="Print markdown report to stdout")
    parser.add_argument("--version", action="version", version=f"webrecon-analyze {VERSION}")
    args = parser.parse_args(argv)

    if not args.zip_path:
        parser.error("zip_path is required")

    bundle = Bundle(args.zip_path)
    report = build_report(bundle)
    md = render_markdown(report)

    # Default output paths sit next to the ZIP if no --out / --stdout / --json given.
    if args.stdout:
        sys.stdout.write(md)
        return 0

    zip_path = Path(args.zip_path).resolve()
    md_path = Path(args.out) if args.out else zip_path.with_suffix("").with_suffix(".report.md")
    json_path = Path(args.json_out) if args.json_out else zip_path.with_suffix("").with_suffix(".report.json")

    md_path.write_text(md, encoding="utf-8")
    json_path.write_text(json.dumps(report, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")

    print(f"wrote {md_path}")
    print(f"wrote {json_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
