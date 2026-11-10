#!/usr/bin/env python3
"""
Build Stremio v4.4 for VIDAA.

  python build.py            # build docs/ (downloads upstream once, then cached)
  python build.py --refresh  # re-download upstream shell-v4.4
  python build.py --serve    # build, then serve docs/ on http://0.0.0.0:8044

Upstream (Stremio's own v4.4 shell) is NOT modified apart from making its
root-absolute "/images/..." paths relative, so the build works from any
sub-path (e.g. GitHub Pages). All VIDAA behaviour lives in src/.
"""
import hashlib
import os
import re
import shutil
import sys
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
UPSTREAM_URL = "https://app.strem.io/shell-v4.4/"
CACHE = os.path.join(ROOT, "upstream", "shell-v4.4")
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "docs")  # GitHub Pages serves /docs from main
UA = {"User-Agent": "Mozilla/5.0 (build script)"}

ASSET_RE = re.compile(
    r"/?((?:images|fonts)/[A-Za-z0-9_./-]+\.(?:png|jpe?g|svg|ico|woff2?|ttf|gif|webp))"
)


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def cached(rel, refresh, bases=(UPSTREAM_URL,)):
    path = os.path.join(CACHE, rel.replace("/", os.sep))
    if refresh or not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data, last = None, None
        for base in bases:
            try:
                data = fetch(base + rel)
                break
            except Exception as e:  # noqa: BLE001
                last = e
        if data is None:
            raise last
        with open(path, "wb") as f:
            f.write(data)
    with open(path, "rb") as f:
        return f.read()


def main():
    refresh = "--refresh" in sys.argv
    print("[1/4] upstream: " + UPSTREAM_URL + (" (refresh)" if refresh else " (cached if present)"))
    html = cached("index.html", refresh).decode("utf-8")

    m_js = re.search(r'src="(blob\.js[^"]*)"', html)
    m_css = re.search(r'href="(blob\.css[^"]*)"', html)
    if not m_js or not m_css:
        sys.exit("ERROR: blob.js / blob.css not found in upstream index.html; layout changed?")
    js = cached("blob.js", refresh)
    css = cached("blob.css", refresh)
    print("      blob.js %d KB, blob.css %d KB" % (len(js) // 1024, len(css) // 1024))

    if b"WebAssembly" in js:
        print("      WARNING: upstream now references WebAssembly - may not run on VIDAA")

    print("[2/4] assets")
    text = html + js.decode("utf-8", "replace") + css.decode("utf-8", "replace")
    assets = sorted(set(ASSET_RE.findall(text)))
    ok, missing = [], []
    for rel in assets:
        try:
            # root-absolute refs (/images/addons/...) live on the main site
            cached(rel, refresh, (UPSTREAM_URL, "https://www.strem.io/"))
            ok.append(rel)
        except Exception as e:  # noqa: BLE001
            missing.append((rel, str(e)))
    print("      %d mirrored, %d unavailable upstream" % (len(ok), len(missing)))
    for rel, err in missing:
        print("        - " + rel + ": " + err)

    print("[3/4] docs")
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(os.path.join(DIST, "vidaa"))
    for rel in ok:
        dst = os.path.join(DIST, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(CACHE, rel.replace("/", os.sep)), dst)

    layer_js = open(os.path.join(SRC, "vidaa-v4.js"), "rb").read()
    layer_css = open(os.path.join(SRC, "vidaa-v4.css"), "rb").read()
    version = hashlib.sha1(js + css + layer_js + layer_css).hexdigest()[:8]
    layer_js = layer_js.replace(b"__VIDAA_V4_VERSION__", version.encode())

    # root-absolute asset paths -> relative (works under any sub-path)
    js_out = re.sub(rb"([\"'])/((?:images|fonts)/)", rb"\1\2", js)
    with open(os.path.join(DIST, "blob.js"), "wb") as f:
        f.write(js_out)
    with open(os.path.join(DIST, "blob.css"), "wb") as f:
        f.write(css)
    with open(os.path.join(DIST, "vidaa", "vidaa-v4.js"), "wb") as f:
        f.write(layer_js)
    with open(os.path.join(DIST, "vidaa", "vidaa-v4.css"), "wb") as f:
        f.write(layer_css)

    head_early = (
        '<meta http-equiv="Cache-Control" content="no-cache">'
        '<link rel="dns-prefetch" href="//torbox.app">'
        '<link rel="dns-prefetch" href="//api.strem.io">'
        '<link rel="dns-prefetch" href="//v3-cinemeta.strem.io">'
        '<link rel="dns-prefetch" href="//images.metahub.space">'
        '<link rel="dns-prefetch" href="//torrentio.strem.fun">'
        '<script src="vidaa/vidaa-v4.js?v=' + version + '"></script>'
    )
    head_late = '<link rel="stylesheet" href="vidaa/vidaa-v4.css?v=' + version + '">'
    out = html.replace("<head>", "<head>" + head_early, 1)
    out = out.replace("</head>", head_late + "</head>", 1)
    out = out.replace('<link rel="icon" href="images/stremio.ico" type="image/x-icon">',
                      '<link rel="icon" href="icon.png" type="image/png">', 1)
    if "vidaa/vidaa-v4.js" not in out or "vidaa/vidaa-v4.css" not in out:
        sys.exit("ERROR: failed to inject VIDAA layer into index.html")
    with open(os.path.join(DIST, "index.html"), "w", encoding="utf-8") as f:
        f.write(out)

    shutil.copyfile(os.path.join(SRC, "worker.js"), os.path.join(DIST, "worker.js"))

    icon = os.path.join(SRC, "icon.png")
    if os.path.exists(icon):
        shutil.copyfile(icon, os.path.join(DIST, "icon.png"))
    open(os.path.join(DIST, ".nojekyll"), "w").close()

    print("[4/4] done: docs/ (layer version " + version + ")")

    if "--serve" in sys.argv:
        import functools
        import http.server
        port = 8044
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIST)
        print("serving http://0.0.0.0:%d/  (Ctrl+C to stop)" % port)
        http.server.ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()


if __name__ == "__main__":
    main()
