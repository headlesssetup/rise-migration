#!/usr/bin/env python3
"""Convert a mitmproxy .mitm capture → JSONL, keeping the FULL picture.

    {"t","method","url","status","req_ct","resp_ct","origin","req","resp"}   one flow/line

Philosophy: keep EVERYTHING by default (all Articulate hosts, S3, usercontent, and
anything not on the denylist) so nothing potentially-relevant is silently stripped.
Only explicit **analytics / telemetry / third-party** noise is dropped — and the
converter PRINTS every dropped URL so the pruning is transparent. Binary bodies are
replaced with a `<N bytes ctype>` placeholder; text/JSON bodies are kept in full.
Request timestamps are included so ordering + gaps are visible.

    python3 scripts/mitm-to-jsonl.py capture.mitm                 # → capture.jsonl
    python3 scripts/mitm-to-jsonl.py capture.mitm out.jsonl

Zero dependencies (implements mitmproxy's tnetstring flow format).
"""

import json
import sys
from urllib.parse import urlparse

# --- Denylist: analytics / telemetry / third-party only --------------------------
# Hosts dropped entirely (substring match). These carry no Rise API/content data.
NOISE_HOSTS = (
    "datadoghq.com",            # browser-intake-datadoghq.com (RUM)
    "launchdarkly.com",         # app./events./clientstream. (feature flags)
    "braze.articulate.com",     # Braze (marketing/analytics)
    "google.com",               # www.google.com / analytics.google.com / accounts.
    "googleapis.com",           # content-autofill / safebrowsing / optimizationguide
    "googletagmanager.com",
    "google-analytics.com",
    "doubleclick.net",
    "fastly-edge.com",          # google safebrowsing relay
    "gstatic.com",
    "usabilla.com",             # survey widget
    "ada.support",              # chat widget
    "privacywall.org",
    "osano.com",                # cookie consent
)
# Paths dropped EVEN on kept (Articulate) hosts — pure analytics/telemetry endpoints.
NOISE_PATHS = (
    "/growth/",                 # api.articulate growth/onboarding/engagement analytics
    "/track/TRACK",
    "/analytics",
    "/api/rise-runtime/analytics",
)
# NOTE: conveyor /socket.io (realtime collab presence) is KEPT — it's part of the
# picture even if noisy; drop it manually if you don't need it.

TEXTUAL = ("application/json", "text/", "application/xml", "+json", "application/x-www-form", "javascript")
MAX_REQ = 1_000_000   # keep write payloads (theme/blocks JSON) in full
MAX_RESP = 200_000    # keep GET_COURSE etc. — large but bounded


def parse(data, off):
    colon = data.index(b":", off)
    length = int(data[off:colon])
    start = colon + 1
    payload = data[start:start + length]
    t = data[start + length:start + length + 1]
    nxt = start + length + 1
    if t == b",":
        return payload, nxt
    if t == b";":
        return payload.decode("utf-8", "replace"), nxt
    if t == b"#":
        return int(payload), nxt
    if t == b"^":
        return float(payload), nxt
    if t == b"!":
        return payload == b"true", nxt
    if t == b"~":
        return None, nxt
    if t == b"}":
        d, o = {}, 0
        while o < len(payload):
            k, o = parse(payload, o)
            v, o = parse(payload, o)
            d[k if isinstance(k, str) else k.decode("utf-8", "replace")] = v
        return d, nxt
    if t == b"]":
        l, o = [], 0
        while o < len(payload):
            v, o = parse(payload, o)
            l.append(v)
        return l, nxt
    raise ValueError(f"bad tnetstring type {t!r} at {start + length}")


def hmap(h):
    out = {}
    if isinstance(h, list):
        for p in h:
            if isinstance(p, list) and len(p) == 2:
                k = p[0].decode() if isinstance(p[0], bytes) else str(p[0])
                v = p[1].decode() if isinstance(p[1], bytes) else str(p[1])
                out[k.lower()] = v
    return out


def dec(v):
    return v.decode() if isinstance(v, bytes) else v


def body(content, ctype, cap):
    if content is None:
        return None
    if isinstance(content, str):
        return content[:cap]
    if isinstance(content, bytes):
        if any(t in (ctype or "").lower() for t in TEXTUAL):
            try:
                return content.decode("utf-8")[:cap]
            except Exception:
                pass
        return f"<{len(content)} bytes {ctype or 'binary'}>"
    return content


def is_noise(host, path):
    if any(h in host for h in NOISE_HOSTS):
        return True
    if any(p in path for p in NOISE_PATHS):
        return True
    return False


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else src.rsplit(".", 1)[0] + ".jsonl"

    data = open(src, "rb").read()
    flows, off = [], 0
    while off < len(data):
        if data[off:off + 1] in (b"\n", b"\r", b" "):
            off += 1
            continue
        try:
            f, off = parse(data, off)
        except Exception:
            break
        flows.append(f)

    rows, dropped = [], {}
    for f in flows:
        if not isinstance(f, dict):
            continue
        req = f.get("request")
        if not isinstance(req, dict):
            continue
        rh = hmap(req.get("headers"))
        method = dec(req.get("method"))
        path = dec(req.get("path")) or ""
        host = rh.get("host") or dec(req.get("host")) or ""
        if is_noise(host, path.split("?")[0]):
            key = f"{method} {host}{path.split('?')[0]}"
            dropped[key] = dropped.get(key, 0) + 1
            continue
        resp = f.get("response")
        rsh = hmap(resp.get("headers")) if isinstance(resp, dict) else {}
        rows.append({
            "t": req.get("timestamp_start"),
            "method": method,
            "url": f"{dec(req.get('scheme'))}://{host}{path}",
            "status": resp.get("status_code") if isinstance(resp, dict) else None,
            "req_ct": rh.get("content-type"),
            "resp_ct": rsh.get("content-type"),
            "origin": rh.get("origin"),
            "req": body(req.get("content"), rh.get("content-type"), MAX_REQ),
            "resp": body(resp.get("content"), rsh.get("content-type"), MAX_RESP) if isinstance(resp, dict) else None,
        })
    rows.sort(key=lambda r: r["t"] or 0)
    with open(out, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")

    kept_hosts = {}
    for r in rows:
        h = urlparse(r["url"]).netloc
        kept_hosts[h] = kept_hosts.get(h, 0) + 1
    print(f"flows={len(flows)}  kept={len(rows)}  dropped={sum(dropped.values())}  → {out}")
    print("KEPT hosts:")
    for h, c in sorted(kept_hosts.items(), key=lambda x: -x[1]):
        print(f"  {c:5d} {h}")
    print("DROPPED (analytics/telemetry) — every distinct URL:")
    for k, c in sorted(dropped.items(), key=lambda x: -x[1]):
        print(f"  {c:5d} {k}")


if __name__ == "__main__":
    main()
