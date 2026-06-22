#!/usr/bin/env python3
"""Convert + PRUNE a mitmproxy .mitm capture into a tiny JSONL of just the
Articulate authoring traffic — the shape the analysis expects:

    {"method","url","status","req","resp","reqh"}   one flow per line

Why: a raw .mitm haul is mostly binary upload bytes (fonts/images) + analytics
noise (datadog/google/launchdarkly/braze/osano/gtm). This keeps only
*.articulate.com + the S3 upload host, drops `track/TRACK` / socket.io / growth
telemetry, decodes JSON/text bodies in full (theme/blocks payloads matter), and
replaces binary bodies with `<N bytes ctype>`. 38 MB → tens of KB.

Zero dependencies (no mitmproxy needed). Runs on the operator's machine:

    python3 scripts/mitm-to-jsonl.py haul.mitm            # → haul.pruned.jsonl
    python3 scripts/mitm-to-jsonl.py haul.mitm out.jsonl

Implements mitmproxy's tnetstring flow format (note its `;` unicode-string type).
"""

import json
import sys
from urllib.parse import urlparse

# Hosts to KEEP (substring match). Everything else (datadog, google, launchdarkly,
# braze, osano, googletagmanager, analytics) is dropped.
KEEP_HOSTS = ("articulate.com", "articulateusercontent.eu", "amazonaws.com")
# Noise paths dropped even on kept hosts.
DROP_PATHS = ("/track/TRACK", "/socket.io", "/growth/", "/analytics", "/engagement")
# Bodies with these content-types are binary → replaced with a size placeholder.
TEXTUAL = ("application/json", "text/", "application/xml", "+json", "application/x-www-form")
MAX_REQ = 400_000  # keep WRITE request payloads in full (theme/blocks JSON)
MAX_RESP = 16_000  # responses just confirm — cap so huge GET_COURSE reads don't bloat


def parse(data, off):
    colon = data.index(b":", off)
    length = int(data[off:colon])
    start = colon + 1
    payload = data[start : start + length]
    t = data[start + length : start + length + 1]
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


def headers_map(h):
    out = {}
    if isinstance(h, list):
        for pair in h:
            if isinstance(pair, list) and len(pair) == 2:
                k = pair[0].decode() if isinstance(pair[0], bytes) else str(pair[0])
                v = pair[1].decode() if isinstance(pair[1], bytes) else str(pair[1])
                out[k.lower()] = v
    return out


def body(content, ctype, cap):
    if content is None:
        return None
    if isinstance(content, str):
        return content[:cap]
    if isinstance(content, bytes):
        is_text = any(t in (ctype or "").lower() for t in TEXTUAL)
        if is_text:
            try:
                return content.decode("utf-8")[:cap]
            except Exception:
                pass
        return f"<{len(content)} bytes {ctype or 'binary'}>"
    return content


def dec(v):
    return v.decode() if isinstance(v, bytes) else v


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else (
        src.rsplit(".", 1)[0] + ".pruned.jsonl"
    )

    data = open(src, "rb").read()
    flows, off = [], 0
    while off < len(data):
        if data[off : off + 1] in (b"\n", b"\r", b" "):
            off += 1
            continue
        try:
            f, off = parse(data, off)
        except Exception:
            break
        flows.append(f)

    kept, dropped = 0, 0
    hosts = {}
    with open(out, "w") as fh:
        for f in flows:
            if not isinstance(f, dict):
                continue
            req = f.get("request")
            if not isinstance(req, dict):
                continue
            rh = headers_map(req.get("headers"))
            scheme = dec(req.get("scheme"))
            method = dec(req.get("method"))
            path = dec(req.get("path")) or ""
            host = rh.get("host") or dec(req.get("host")) or ""
            if not any(k in host for k in KEEP_HOSTS) or any(p in path for p in DROP_PATHS):
                dropped += 1
                continue
            resp = f.get("response")
            status = resp.get("status_code") if isinstance(resp, dict) else None
            resp_ct = headers_map(resp.get("headers")).get("content-type") if isinstance(resp, dict) else None
            row = {
                "method": method,
                "url": f"{scheme}://{host}{path}",
                "status": status,
                "req": body(req.get("content"), rh.get("content-type"), MAX_REQ),
                "resp": body(resp.get("content"), resp_ct, MAX_RESP) if isinstance(resp, dict) else None,
                # Minimal headers: content-type + presence of the S3 ACL header
                # (the EU SigV4 question). Authorization is intentionally omitted.
                "reqh": {
                    k: v
                    for k, v in rh.items()
                    if k in ("content-type", "x-amz-acl") or k.startswith("x-amz-")
                },
            }
            fh.write(json.dumps(row) + "\n")
            kept += 1
            hosts[urlparse(row["url"]).netloc] = hosts.get(urlparse(row["url"]).netloc, 0) + 1

    print(f"flows: {len(flows)}  kept: {kept}  dropped(noise/binary host): {dropped}")
    print(f"wrote: {out}")
    for h, c in sorted(hosts.items(), key=lambda x: -x[1]):
        print(f"  {c:4d} {h}")


if __name__ == "__main__":
    main()
