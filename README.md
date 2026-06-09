# pond — Hale contrib libraries

The "non-std std lib." Opinionated, domain-shaped Hale libraries
that any app can vendor and reuse inline. Sits between
`runtime/stdlib/` (substrate-floor, always-loaded) and one-off
app code.

## Vendoring

```toml
# in your app's hale.toml
[deps]
pond = { git = "https://github.com/hale-lang/pond", tag = "v0.1.0" }
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

## Catalog

### Tier 0 internals — `pond/_util/*` (shared helpers)

Small single-file utility libs consolidating duplicate helpers
surfaced across the main tier libs. Each is a namespace lotus
operating on primitives only. See `_util/README.md` for the
codegen limitation that constrains where they're usable.

| Path | What it is | Suggested alias |
|------|------------|------|
| `_util/intfloat/` | Int ↔ Float ASCII-roundtrip bridge | `intf` |
| `_util/decimal_float/` | Decimal ↔ Float bridge (matrix emission + wire-format) | `decf` |
| `_util/duration_int/` | `Duration → Int` ns + monotonic-seconds helpers | `durint` |
| `_util/kvpack/` | Tab-separated `k1=v1\tk2=v2` walker (get/set/has) | `kv` |
| `_util/rowbuf/` | Tab+newline row-buffer iteration (nth_field, remove_row, ...) | `rb` |

### Tier 0 — Infrastructure (foundation for everything else)

| Path | What it is | Suggested alias |
|------|------------|------|
| `http/client/` | HTTP/1.1 client (pool, retry, fallible(IoError)) | `http` |
| `crypto/` | HMAC-SHA256, SHA-256, CSPRNG, hex | `crypto` |
| `subprocess/` | fork/exec wrapper with pipes + timeout | `sub` |
| `math/matrix/` | Dense matrix + matmul + linalg primitives | `mat` |
| `math/stats/` | Mean, var, quantile, online moments | `stats` |
| `term/` | Terminal control: color profiles + styled output (auto-downgrade), ANSI escapes, raw mode (`@ffi` libc shims) | `term` |

### Tier 1 — Rails-shape web stack

| Path | What it is | Suggested alias |
|------|------------|------|
| `db/` | Backend-neutral `DbDriver` interface (Go database/sql shape) | `db` |
| `pq/` | Postgres driver (pgwire v3 over TCP) + connection pool; satisfies `DbDriver` | `pq` |
| `sqlite/` | SQLite adapter (Db locus, fallible(DbError)) — BLOCKED on `std::db::sqlite::*` | `sqlite` |
| `router/` | HTTP router with path params + middleware | `router` |
| `sessions/` | HMAC-signed cookie sessions | `sess` |
| `jobs/` | Background job queue + worker pool (sqlite-backed) | `jobs` |
| `migrations/` | Forward-only migration runner (`Migrator` on `db::DbDriver`) | `migs` |

### Tier 2 — Observability + supervision

| Path | What it is | Suggested alias |
|------|------------|------|
| `logfmt/` | Structured log sinks (file/OTLP/colored console) for `std::log` | `logfmt` |
| `metrics/` | Prometheus-format exposition (counter/gauge/histogram) | `metrics` |
| `supervisor/` | Erlang-style restart strategies on `on_failure` | `sup` |
| `tracing/` | Span tree mirroring the locus tower | `trace` |

### Tier 3 — Realtime

| Path | What it is | Suggested alias |
|------|------------|------|
| `websocket/` | RFC 6455 WebSocket client + server-side upgrade | `ws` |

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

## Design rules

1. Each lib is one Hale seed (one directory of `.hl` files;
   F.19 per-directory model).
2. Each lib ships `README.md`, source files, `FRICTION.md`, and
   `examples/<demo>/` with an agent-runnable demo.
3. Public surface is locked in [`CONTRACTS.md`](./CONTRACTS.md).
   Implementations must match the contract; deviations get
   logged in the lib's `FRICTION.md` and reflected back in
   `CONTRACTS.md`.
4. No transitive deps in v1: a consumer that uses `pond/jobs`
   (which uses `pond/sqlite`) must vendor both.
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
