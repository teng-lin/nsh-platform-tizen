# SQLite on the TV: chunk-tracking VFS probe

A memory VFS on `rsqlite-vfs` 0.2 (under rusqlite 0.42's `sqlite-wasm-rs`
backend) that records which 64 KB chunks of the database file each commit
changed, so the page writes only those to IndexedDB; plus a guide publish in
slices on a copy of the database while queries continue on the original.

Build for Tizen 5.5 (MVP WebAssembly with sign-extension):

```sh
export CFLAGS_wasm32_unknown_unknown="-mcpu=mvp -msign-ext -mmutable-globals"
RUSTFLAGS="-C target-cpu=mvp -C target-feature=+sign-ext,+mutable-globals" \
  cargo +nightly-2026-10-24 build -Zbuild-std=std,panic_abort --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/sqlite_wasm_probe.wasm app/probe.wasm   # then package app/ with tizen
node desk.mjs target/wasm32-unknown-unknown/release/sqlite_wasm_probe.wasm       # desktop run
```

The first launch builds a 22.7 MB guide-like database, saves every chunk,
toggles a favorite and saves, publishes a new guide in slices and saves;
later launches restore from the chunks. Results are in
`localStorage['vfs.results']`. Results on the 2020 TV are in Patina's
`docs/plans/2026-11-21-browser-tv-architecture.md`.
