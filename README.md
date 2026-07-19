# pond — Hale contrib libraries

The "non-std std lib." Opinionated, domain-shaped Hale libraries
that any app can vendor and reuse inline. Sits between
`runtime/stdlib/` (substrate-floor, always-loaded) and one-off
app code.

## Vendoring

```toml
# in your app's hale.toml
[deps]
pond = { git = "https://github.com/hale-lang/pond", tag = "v0.8.0" }
```

```bash
hale fetch
```

```hale
// in your .hl files
import "vendor/pond/sqlite" as db;
import "vendor/pond/router" as router;
import "vendor/pond/agent/llm" as llm;
```

You vendor the whole pond repo, then import only the libs you
use. Each lib lives at its own path under `vendor/pond/`.

> pond HEAD tracks a recent hale release (v0.9.2+). See
> [`CONTRACTS.md`](./CONTRACTS.md) for the exact upstream commit
> each refresh pass builds against.

## Catalog

### Tier 0 internals — `pond/_util/*` (shared helpers)

Small single-file utility libs consolidating duplicate helpers
surfaced across the main tier libs. Each is a namespace lotus
operating on primitives only. Importable from anywhere — end
apps, other `_util` libs, and tier libs — since upstream WS3.4
(2026-06-11) closed the old G34 two-hop codegen break.

| Path | What it is | Suggested alias |
|------|------------|------|
| `_util/intfloat/` | Int ↔ Float bridge — **deprecated** (use `std::math::{int_to_float,float_to_int,round,trunc}`) | `intf` |
| `_util/decimal_float/` | Decimal ↔ Float bridge (matrix emission + wire-format) | `decf` |
| `_util/duration_int/` | `Duration → Int` ns + monotonic-seconds helpers | `durint` |
| `_util/kvpack/` | Tab-separated `k1=v1\tk2=v2` walker (get/set/has) | `kv` |
| `_util/rowbuf/` | Tab+newline row-buffer iteration (nth_field, remove_row, ...) | `rb` |

### Tier 0 — Infrastructure (foundation for everything else)

| Path | What it is | Suggested alias |
|------|------------|------|
| `http/client/` | HTTP/1.1 client (pool, retry, fallible(IoError)) | `http` |
| `crypto/` | HMAC-SHA256/512, SHA-256/512, CSPRNG, hex | `crypto` |
| `subprocess/` | fork/exec wrapper with pipes + timeout | `sub` |
| `math/matrix/` | Dense matrix + matmul + linalg primitives | `mat` |
| `math/stats/` | Mean, var, quantile, online moments | `stats` |
| `term/` | Terminal control: color profiles + styled output (auto-downgrade), ANSI escapes, raw mode — pure Hale over `std::term` | `term` |

### Tier 1 — Rails-shape web stack

| Path | What it is | Suggested alias |
|------|------------|------|
| `db/` | Backend-neutral `DbDriver` interface (Go database/sql shape) | `db` |
| `pq/` | Postgres driver (pgwire v3 over TCP) + connection pool; satisfies `DbDriver` | `pq` |
| `sqlite/` | SQLite driver — pure `@ffi` over system `libsqlite3` (Db locus, fallible(DbError); needs `libsqlite3-dev` to build) + `Driver` adapter satisfying `db::DbDriver` | `sqlite` |
| `router/` | HTTP router with path params + middleware | `router` |
| `sessions/` | HMAC-signed cookie sessions | `sess` |
| `jobs/` | Background job queue + worker pool (sqlite-backed) | `jobs` |
| `migrations/` | Schema migration runner (`Migrator` on `db::DbDriver`: registered set + up/down/steps/goto/force, per-step txns; the sqlite adapter is `sqlite::Driver` in `sqlite/`) | `migs` |

### Tier 2 — Observability + supervision

| Path | What it is | Suggested alias |
|------|------------|------|
| `logfmt/` | Structured log sinks (file/OTLP/colored console) for `std::log`; OTLP POSTs via `pond/http` | `logfmt` |
| `metrics/` | Prometheus-format exposition (counter/gauge/histogram) | `metrics` |
| `supervisor/` | Erlang-style restart strategies on `on_failure` | `sup` |
| `tracing/` | Span tree mirroring the locus tower | `trace` |

### Tier 3 — Realtime

| Path | What it is | Suggested alias |
|------|------------|------|
| `websocket/` | RFC 6455 WebSocket client + server-side upgrade, ping/pong liveness deadlines | `ws` |

### Tier 5 — AI / agent orchestration

| Path | What it is | Suggested alias |
|------|------------|------|
| `agent/llm/` | Anthropic / OpenAI clients with SSE streaming | `llm` |
| `agent/tools/` | Tool registry (Tool interface, F.20 dispatch) | `tools` |
| `agent/conversation/` | Conversation locus (bounded chat history + bus events) | `conv` |
| `agent/sandbox/` | Subprocess-based code-execution sandbox | `sandbox` |
| `agent/embeddings/` | Vector store with top-k search | `emb` |
| `ml/neural/` | Tiny NN trainer (MNIST-class problems) | `nn` |

### Tier 8 — DevX

| Path | What it is | Suggested alias |
|------|------------|------|
| `tui/` | Elm-shaped full-screen TUI runtime: App/Program loop, typed input events (keys/mouse/paste), cell-grid diff renderer, widgets | `tui` |

### Tier 6, 7, 8 — backlog (not yet built)

Messaging (`realtime/pubsub`, `realtime/nats`, `realtime/cron`);
game/sim (`game/ecs`, `game/tick`, `game/spatial`); data formats
(`data/csv`, `data/timeseries`, `data/pipeline`); DevX (`dev/lsp`,
`dev/docgen`, `dev/asserts`, `dev/bench`). Picked up when a workload
demands.

### Editor tooling — moved

The tree-sitter grammar (**heron**) moved to its own repo,
[hale-lang/tree-sitter-hale](https://github.com/hale-lang/tree-sitter-hale)
(2026-07-19, full history), so editors and linguist can pin it by
URL. The language server ships in the `hale` binary itself
(`hale lsp`).

## Design rules

1. Each lib is one Hale seed (one directory of `.hl` files;
   F.19 per-directory model).
2. Each lib ships `README.md`, source files, a section in the
   root [`FRICTION.log`](./FRICTION.log) (single consolidated
   log since 2026-06-12), `tests/*_test.hl` unit tests (run with
   `hale test <lib>/`, or `hale test .` for the whole repo), and
   `examples/<demo>/` with an agent-runnable demo.
3. Public surface is locked in [`CONTRACTS.md`](./CONTRACTS.md).
   Implementations must match the contract; deviations get
   logged in the lib's `FRICTION.log` section and reflected back
   in `CONTRACTS.md`.
4. No transitive deps in v1 — at the vendoring level: a consumer
   that uses `pond/jobs` (which uses `pond/sqlite`) must vendor
   both. Lib-from-lib imports themselves are fine.
5. Every lib matches the six-pattern catalog (App locus /
   Namespace lotus / Service / Spawned child / Shape type /
   Free fn). Things outside the catalog get logged as friction,
   not coded around.

## What lives elsewhere

- **`std::*` substrate** — JSON, HTTP server, logging, cli,
  file I/O, tcp, text, test. Always loaded; no `import` needed.
  See `hale/spec/stdlib.md`.
- **Per-app code** — your app's specific business logic lives
  in your app's repo, not here.
- **Cloud SDKs, GUI frameworks, codecs** — third-party
  territory; not bundled.
