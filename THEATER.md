# Theater build (what `docs/` serves now)

`docs/` holds Stremio's own TV interface, **Theater 1.10.0** (Stremio's
Hisense/VIDAA app), with the VIDAA patch layer from
[NoobyGains/stremio-vidaa-tv](https://github.com/NoobyGains/stremio-vidaa-tv).
It runs on a **stremio-core-web 0.65.1 engine rebuilt as plain (MVP) WebAssembly**.

## Why the rebuild

The npm build of `@stremio/stremio-core-web` is compiled with WebAssembly
reference types. The VIDAA browser engine is too old for them, and fails with:

```
WebAssembly.instantiateStreaming(): invalid value type 'externref',
enable with --experimental-wasm-reftypes
```

The rebuild produces the same engine without that requirement.

## How the engine was built

Source: `Stremio/stremio-core` at **c4806e8** ("bump: release 0.65.1",
the npm package's `gitHead`), directory `stremio-core-web`.

```bash
# toolchain: rustup (x86_64-pc-windows-gnu host), nightly + rust-src + wasm32 target
RUSTFLAGS="-C target-cpu=mvp" cargo +nightly build --release --lib \
  --target wasm32-unknown-unknown -Z build-std=std,panic_abort
wasm-bindgen --target web --no-typescript --out-dir wasm_build \
  ../target/wasm32-unknown-unknown/release/stremio_core_web.wasm     # 0.2.121, as pinned in Cargo.lock
wasm-opt --mvp-features -O2 --strip-debug wasm_build/stremio_core_web_bg.wasm -o stremio_core_web_bg.wasm   # binaryen 123
# then build.sh's babel steps, and esbuild-bundle worker.js -> v5-worker.js
# (same as NoobyGains' scripts/sync-core.mjs)
```

Checks:
- `wasm-opt --mvp-features` validates the module: no reference types,
  multivalue, bulk memory or sign-ext, and no `target_features` section.
- `worker.js` and `bridge.js` are byte-identical to npm 0.65.1. Only the wasm
  and its wasm-bindgen glue differ.

The site itself is NoobyGains' `scripts/build.mjs` output (`app/`), from local
branch `vidaa-mvp-core` of the stremio-vidaa-tv clone, copied into `docs/`.

## Going back to the v4 build

The v4.4 build is tagged **`v4-stable`** (also on branch `backup/v4-stable`).

```bash
git checkout v4-stable -- docs
git commit -m "Back to v4" && git push
```

Or rebuild it from source: `python build.py` writes `v4-build/`, then copy
that over `docs/`.
