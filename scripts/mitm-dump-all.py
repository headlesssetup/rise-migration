#!/usr/bin/env python3
"""UNFILTERED mitmproxy .mitm → JSONL. Keeps EVERY flow (all hosts, all paths);
only binary bodies are replaced with a `<N bytes ctype>` placeholder so the file
stays readable. Includes timestamps so request ordering + gaps are visible.

    python3 scripts/mitm-dump-all.py capture.mitm out.jsonl

Zero deps — implements mitmproxy's tnetstring flow format.
"""
import json, sys

TEXTUAL = ("application/json", "text/", "application/xml", "+json", "application/x-www-form", "javascript")


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
    raise ValueError(f"bad tnetstring type {t!r}")


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


def main():
    src, out = sys.argv[1], sys.argv[2]
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
    rows = []
    for f in flows:
        if not isinstance(f, dict):
            continue
        req = f.get("request")
        if not isinstance(req, dict):
            continue
        rh = hmap(req.get("headers"))
        resp = f.get("response")
        rsh = hmap(resp.get("headers")) if isinstance(resp, dict) else {}
        host = rh.get("host") or dec(req.get("host")) or ""
        rows.append({
            "t": req.get("timestamp_start"),
            "method": dec(req.get("method")),
            "url": f"{dec(req.get('scheme'))}://{host}{dec(req.get('path')) or ''}",
            "status": resp.get("status_code") if isinstance(resp, dict) else None,
            "req_ct": rh.get("content-type"),
            "resp_ct": rsh.get("content-type"),
            "origin": rh.get("origin"),
            "req": body(req.get("content"), rh.get("content-type"), 200_000),
            "resp": body(resp.get("content"), rsh.get("content-type"), 40_000) if isinstance(resp, dict) else None,
        })
    rows.sort(key=lambda r: r["t"] or 0)
    with open(out, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    print(f"flows={len(flows)} rows={len(rows)} wrote={out}")


if __name__ == "__main__":
    main()
