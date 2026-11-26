# NOVA Cloud Storage — docs

- [`design.md`](design.md) — the full design: why build our own (verified
  free-tier limits, cited), architecture, namespaces, the 24-hour
  retention rule + its O-27 direction history, the MEASURED capacity
  (~4.85 GB headroom at probe time, 24 Nov 2026 — not the 44 GB `df`
  reports), honest limits, and open decisions.

Code: `src/storage/` (engine, local backend, metadata index, namespaces,
retention, hashing, backend interface, errors). Tests:
`test/storage/` (53 tests, plain node:test, zero external dependencies).

Run the storage tests:

```sh
node --test test/storage/*.test.mjs
```

The Stage 1 GPU Manager suite (60/60) is unaffected. `package.json`'s
`test` / `test:all` scripts do not yet include `test/storage/` — the
parent wires them in.
