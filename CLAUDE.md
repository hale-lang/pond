# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`pond` is the Hale language's "non-std std lib" — opinionated, domain-shaped contrib libraries that apps vendor inline. It sits between `runtime/stdlib/` (always-loaded substrate) and one-off app code. Each lib is its own seed (one directory of `.hl` files, per Hale's F.19 per-directory model); consumers vendor the whole pond repo and import only the libs they need:

```hale
import "vendor/pond/sqlite" as db;
import "vendor/pond/agent/llm" as llm;
```

There is no monorepo-level build. Each lib type-checks independently with `hale check <lib-path>` (libs have no `fn main()`, so `hale build` on a bare lib dir errors — that's expected). Each example builds with `hale build <lib>/examples/<demo>/`. The `hale` CLI binary is produced from the upstream `hale-lang/hale` compiler repo and assumed on PATH; keep it fresh — a stale CLI silently uses old lowering (the CLI warns; rebuild with `cargo build -p hale-cli --release`).

## Authoritative documents (read these before editing)

- **`README.md`** — catalog of every lib by tier, with suggested aliases.
- **`CONTRACTS.md`** — locked public API surface for every lib. *This is binding.* If you implement a lib, your code must match the surface here. If a constraint forces a deviation, log it in the lib's section of `FRICTION.log` and reflect it in the dated status note at the top of CONTRACTS.md (currently `## 2026-08-03 status note`).
- **`FRICTION.log`** (repo root) — the single consolidated friction log, one section per lib (consolidated 2026-06-12; the per-lib `FRICTION.md` files are gone). Records deviations from the contract, blocking gaps, upstream bug repros, and proposed stdlib unblocks. Closed entries stay in place as the historical record. Cross-reference as `FRICTION.log § pond/<lib>` plus the entry title.
- **`<lib>/README.md`** — the as-built surface for that lib (may differ from CONTRACTS.md while deviations are open) and, where relevant, a "When this unblocks" recipe describing the cleanup pass to perform when an upstream gap closes.

## Hard rules from the broader Hale workspace

These come from the upstream compiler repo's AGENTS.md and apply here:

- **Don't edit `crates/` in the compiler repo.** If a primitive is missing, work within the existing surface or log it as friction — never reach into compiler territory to add it. Note: `@ffi("c")` is a *library-author* surface that never touches `crates/` — binding a system C library (sqlite, etc.) is in-bounds for pond. The former "sqlite chain is BLOCKED on a stdlib primitive" premise was refuted upstream (WS4, 2026-06-11): `pond/sqlite` is now a real `@ffi` driver and no pond lib is architecturally blocked today.
- **No `panic` / `assert`.** Every failure routes through `fallible(E)` (value channel) or closure violation (structural channel). Bridge value→structural with the `closure NAME { captures: ...; epoch inline; } / violate NAME;` pattern from `spec/styleguide.md § 7`. Since 2026-06-12, `violate` is accepted inside lifecycle bodies (the old codegen rejection lifted).
- **Two-channel rule** (`spec/semantics.md § "Where each channel lives"`, narrowed in v0.8.1 / open-question #24). User-declared `fn` member fns on a locus CAN declare `fallible(E)` (value + heap-bearing payloads, full `or raise` / `or <substitute>` / `or handler(err)` / `or discard` disposition surface). What stays rejected: **substrate-facing surfaces** — lifecycle methods (`birth` / `run` / `accept` / `drain` / `dissolve` / `on_failure`), mode methods (`bulk` / `harmonic` / `resolution`), closure assertions, and bus-subscribed handlers (rejection fires at the subscribe site). The repo-wide migration to fallible member fns is DONE (2026-06-08 pass, completed 2026-06-12); `logfmt`'s sinks remain non-fallible by design (they satisfy the non-fallible `std::text::Sink` interface).

## Compiler-shape rules and gotchas

These shape non-obvious code in this repo. The first is a permanent language rule; the rest are current-compiler behaviors with the live workaround:

- **Methods may not return locus values (m90 / #18.6 CQRS rejection — permanent).** Factories that return loci are **free fns** (`mat::zeros(...)`, `metrics::counter(reg, ...)`, `nn::forward(...)`). This is the *inverse* of the old G3/G4 note ("free fns can't return LocusRef") — that gotcha is retired.
- **G34 is CLOSED (upstream WS3.4, 2026-06-11).** Pond libs can import other pond libs — including `_util/*` from tier libs — and instantiate their types/loci by qualified literal (`util::KvPack { }` in expression position works). The **re-export barrier still holds by design**: an end app must import a lib itself to name that lib's types. Existing local-copy duplication may be collapsed opportunistically, but it isn't mandatory — `tui` evaluated importing `term` and declined (per-cell hot-path cost + consumer vendoring weight beat ~25 lines of frozen ANSI fragments; see `FRICTION.log § pond/tui`).
- **Bus topic decls: co-locate with the publisher (for now).** Upstream WS3.3 (2026-06-11) fixed cross-file topic resolution — `bus { publish T; }` / `T <- v;` resolve a `topic T` from a sibling file under `hale build` and `hale run`. BUT `hale check` still resolves topics file-locally (check-vs-build divergence — retested 2026-08-03 at hale v0.13.0, still present even though check now resolves cross-SEED imports; same-seed sibling-file topics are the surviving gap), and `hale check` is this repo's per-lib verification gate — so keep the `topic` decl in the same `.hl` file as its publisher until the divergence closes. When ≥2 files publish the same topic, use the literal-subject form (`publish "wire.subject" of type T;` + `"wire.subject" <- v;`) — `agent/llm` does this across its two client files, and its wire subjects are a compatibility contract (do not rename).
- **`or fail E { ... }` payloads cannot reference `err`** (retested 2026-08-03 at v0.13.0 — still `unknown identifier err` at codegen). Use the wrap-helper idiom instead: a helper `fn wrap_x(e: SrcError) -> T fallible(DstError)` that translates the payload. What DID lift (v0.12.0): reading an error payload's fields in a plain `or { ... }` block works — `parse_int(s) or { println(err.kind); -1 }` compiles and runs (caveat: stdlib `ParseError.kind` carries `"parse_int"`, not the spec-documented `"not_int"`/`"empty"`/`"overflow"` — verify before branching on stdlib kind strings). Since hale `400ac68`, `or` handlers may themselves be `fallible(E2)` with implicit propagation — write `or wrap_x(err)`, no trailing `or raise` (the old `or (wrap_x(err) or raise)` spelling still works but is redundant). Caveat: only free-fn / imported-path / locus-member handlers are classified — a `@form`-synthesized method or stdlib path-call used *as the handler* still needs the explicit nested spelling (now a first-class typecheck diagnostic that says "can't be the handler directly yet", so upstream intends to lift it).
- **`-> ()` on a *non-fallible* locus method fails codegen** (`tuple type must have at least 2 elements; got 0`; retested 2026-08-03 at v0.13.0 — still present) — omit the return type. `-> () fallible(E)` is fine.
- **`or <substitute>` LocusRef→Interface coercion is fixed for plain fallible calls, still broken for `@form`-synthesized methods** (probed 2026-08-03 at v0.13.0, unchanged). `let g: Iface = fallible_fn() or Concrete { };` compiles and runs; but `vec_of_iface.get(i) or Concrete { }` still dies at codegen (`or substitute type mismatch: expected Interface(...), got LocusRef(...)`). For form-vec cells, keep the hoisted let-ascription: `let noop: Tool = __NoopTool { }; ... entries.get(i) or noop` (see `agent/tools/registry.hl`).
- **Unbounded-allocation warnings are DEFAULT-ON** (upstream M3 stage 5). Every `hale check` on a bare lib surveys the whole seed and keeps ALL warnings (run-to-exit example binaries warn nothing). They're advisory — never fail the check — but this repo treats them as a triage queue: each warning is either fixed or recorded as triaged (true-by-design / false-positive-shaped) in the lib's `FRICTION.log` section. The analysis got materially smarter in v0.11.12 (const-folded loop ceilings, eager per-iteration children, `vec.set` retire, fail-exits-the-loop) — the 2026-08-03 re-baseline cleared embeddings/crypto/logfmt/migrations/ml-neural to 0 with no source change; current repo total is 62 sites, all triaged. Since v0.12+, advisories from IMPORTED seeds are reported only when that seed is the check target. `@unbounded` on an enclosing fn/hook is the sanctioned acknowledge for intentionally-unbounded shapes (and the path to adopting `hale verify`, which fails on ANY finding, as a CI gate — not adopted here yet). Opt-out flag `--no-warn-unbounded-alloc` exists; don't use it in the verification gate.
- **Green `hale check` does not imply codegen-clean.** Bare libs never reach codegen, so codegen-only breaks (all of the above) hide behind a passing check. The gap NARROWED at v0.12/v0.13 — check now resolves imports (cross-seed analysis), compares types at call boundaries, and rejects unknown `std::` namespaces — but fallibility-disposition enforcement is still codegen-only (an unhandled fallible `Stream.send` checked green for 19 days in agent/llm, 2026-07/08). Always build and run at least one example after touching a lib, and run `hale test <lib>/`.
- **Intra-pond imports are always relative** (`import "../db"`, `import "../../../sqlite"` from examples). The consumer-style `vendor/pond/…` spelling belongs to end apps only — since v0.12's import-resolving `hale check` it fails the per-lib check gate (this bit pq, the one lib that used it; fixed 2026-08-03).
- **Upstream memory-safety bugs — one FIXED, two still open (retested 2026-08-03 at v0.13.0):** the locus-created-via-free-fn-return-inside-a-method-frame heap corruption is **FIXED** (exact repro 20/20 clean; the xor-trainer demo trains through `Trainer.fit` again and `train_corners` is retired). Still OPEN: (a) the **zero-reads** manifestation — a Matrix allocated after the receiver Model's `@form(vec)` buffer has grown reads as all zeros inside that receiver's method frames (differential probe 5/5 at v0.13.0) — so the matrices-before-first-`add_dense` ordering discipline and `Trainer.fit`'s preallocate + `extract_row_into` shape remain binding (`FRICTION.log § pond/ml/neural`); (b) the SEPARABLE migrations form-vec-factory-after-a-caught-failure segfault (`FRICTION.log § pond/migrations` entry 14; 5/5 at v0.13.0) — inline construction after a caught Migrator failure remains binding.

## Repo structure (high-level)

- **`_util/*`** — Tier 0 internals; single-file namespace-lotus utilities operating on primitives only. Five today: `intfloat`, `decimal_float`, `duration_int`, `kvpack`, `rowbuf`. Importable from anywhere since WS3.4 (the old G34 restriction is gone).
- **`http/`, `crypto/`, `subprocess/`, `math/`, `term/`** — Tier 0 infrastructure. (`http/client` PROMOTED to the stdlib `std::http` client surface in hale ≥ v0.11.4 — frozen here for older pins; pond's `Request`/`Response` became stdlib `ClientRequest`/`ClientResponse`.) `term/` is pure Hale over the `std::term` primitives (hale #108-#110).
- **`sqlite/`, `router/`, `sessions/`, `jobs/`, `migrations/`** — Tier 1 Rails-shape web stack. (`router/` PROMOTED to `std::http::Router` in hale ≥ v0.11.4 — the vendored copy is frozen for older pins; new code uses the stdlib surface directly.) **All real since 2026-06-12**: `sqlite/` is a pure-`@ffi` driver over the system `libsqlite3` (needs `libsqlite3-dev` at build time); `jobs/` and `migrations/` run on it (`migrations/` via the `sqlite::Driver` adapter satisfying `db::DbDriver` — promoted from migrations into `sqlite/` 2026-07-06, so `migrations/` itself is pure Hale over `pond/db`).
- **`logfmt/`, `metrics/`, `supervisor/`, `tracing/`** — Tier 2 observability + supervision. (`logfmt/` FileSink+ConsoleSink PROMOTED to `std::log` and `metrics/` PROMOTED wholesale to `std::metrics` in hale ≥ v0.11.8 — vendored copies frozen for older pins; stdlib metrics Registry owns its storage and takes histogram bounds as a space-separated String, not a math Matrix. logfmt's OtlpSink stays in pond.) The OTLP exports (logfmt `OtlpSink`, tracing `export_otlp`) really POST via `pond/http/client` — consumers of those features must vendor `pond/http` too.
- **`db/`, `pq/`** — backend-neutral `DbDriver` interface + Postgres pgwire driver (the Go `database/sql` split).
- **`agent/{llm,tools,conversation,sandbox,embeddings}/`, `ml/neural/`** — Tier 5 AI / agent orchestration.
- **`websocket/`** — Tier 3 realtime: RFC 6455 client + server-side upgrade, with liveness deadlines (recv-timeout ping/pong) since 2026-06-12.
- **`tui/`** — Tier 8 DevX: Elm-shaped full-screen TUI runtime (App/Program, typed input events, cell-grid diff renderer, widgets) + real apps as examples (logview, metricsdash, procpanel). Self-contained seed *by choice* (import of `term` evaluated and declined — see FRICTION.log).
- **`heron/`** — MOVED to [hale-lang/tree-sitter-hale](https://github.com/hale-lang/tree-sitter-hale) (2026-07-19; full history). pond is Hale seeds only again; the grammar's corpus-sync CI lives with the grammar.

FFI libs: `sqlite/` (`glue.c` + `hale.toml [ffi]`). Everything else is pure Hale. Note the `[ffi]` auto-pickup only scans *direct* imports — an end app using `jobs`/`migrations` over sqlite must also `import` sqlite itself (consistent with the vendoring rule below).

Backlog tiers (6, 7, 8 — game/sim, data formats, devx; plus the rest of tier 3 realtime messaging beyond `websocket/`) are listed in `README.md` but not yet built.

## Design rules to enforce when adding/editing libs

1. Each lib is one Hale seed (one directory of `.hl` files; F.19 per-directory model).
2. Each lib ships `README.md`, source files, a section in the root `FRICTION.log`, `tests/*_test.hl` unit tests, and `examples/<demo>/` with an agent-runnable demo. The tests and the example are part of the deliverable — and they're also the codegen gates (see gotchas above).
3. Public surface is locked in `CONTRACTS.md`. Deviations require both a `FRICTION.log` entry in the lib's section and an update to CONTRACTS.md's status note.
4. **No transitive deps in v1 — at the vendoring level.** Lib-from-lib imports are allowed (`jobs` → `sqlite`, `tracing` → `http/client`), but a consumer app must vendor every lib in the chain explicitly. Don't paper over this.
5. Every lib matches the six-pattern catalog (App locus / Namespace lotus / Service / Spawned child / Shape type / Free fn). Things outside the catalog get logged as friction, not coded around.

## Cross-cutting conventions

- **`Bytes` vs `String`** — prefer `Bytes` for binary I/O (HTTP bodies, TCP framing, JSON wire), `String` for human-readable text and stdlib paths.
- **Collections: `bounded[T; N]` for fixed-capacity data, tab/newline-separated strings for genuinely unbounded data.** Since hale shipped `bounded[T; N]` (2026-07-02), fixed-capacity collections use it directly (`RouteParams.path_keys/path_vals`, `LlmRequest.messages`, conversation history) — the old TSV idiom for those surfaces is retired. Genuinely unbounded row data (query results: `Rows { csv: String }` with newlines, `Row { data: String }` with tabs) stays on the delimited-string shape — a fixed cap would be a lie there. Avoid invented parametric collections — use the index-API pair or a `Matrix` of values, per stdlib precedent (`list_dir_count` + `list_dir_at`).
- **Error payload types are per-lib.** Each lib declares its own `LibError` shape; cross-lib `or` chains compose normally because every payload sits in its own scope.
- **Bus subjects via `topic` decls** when the topic is internal to one lib (decl co-located with the publisher — see gotchas); literal-string subjects for ≥2-publisher topics, wildcard subscriptions, or runtime-computed paths.

## Build & verify

```bash
# Type-check a single lib (libs have no fn main – check, don't build):
hale check path/to/lib/

# Build + run a demo:
hale build path/to/lib/examples/<demo>/
./path/to/lib/examples/<demo>/<demo>     # binary lands next to main.hl

# sqlite (and examples importing it, incl. jobs/migrations demos)
# additionally need sqlite dev files. With libsqlite3-dev installed
# the plain build works; on a box with only the runtime .so.0, use
# user-local shims:
C_INCLUDE_PATH=$HOME/.local/include LIBRARY_PATH=$HOME/.local/lib \
  hale build sqlite/examples/kv-demo/

# Unit tests (hale ≥ 400ac68 ships `hale test`):
hale test path/to/lib/         # discovers <lib>/tests/*_test.hl, compiles + runs each
hale test path/to/lib/ -run substr   # filter by test-file name
hale test .                    # repo root: runs every lib's tests
# @ffi tests (sqlite/jobs/migrations) link under `hale test` too as
# of hale > v0.11.8 (the runner runs the same hale.toml [ffi] pickup
# as `hale build` — FRICTION § pond/sqlite CLOSED 2026-07-18); the
# include/lib shims are still needed when sqlite lives outside the
# default search paths:
C_INCLUDE_PATH=$HOME/.local/include LIBRARY_PATH=$HOME/.local/lib \
  hale test sqlite/

```

Per `.gitignore`, demo binaries land at `examples/<demo>/<demo>` and `examples/<demo>/main` and must not be committed (the ignore rule is generic: extensionless files under `examples/` are ignored).

Unit tests live at `<lib>/tests/*_test.hl` — a separate directory, NOT loose in the lib dir (a test file's `fn main()` would join the seed and break vendoring consumers). Each test file is an ordinary Hale binary: `import ".." as lib;` at the top (one level up from tests/, not the examples' `../..`), `std::test::assert / assert_eq_int / assert_eq_str` in `fn main()`; pass = exit 0 with no stdout. The no-stdout contract means library paths that print by design (Migrator's apply narration, Worker's birth line, tui's flush-to-stdout) are not unit-testable — cover their silent siblings and leave the printing paths to the examples (see the testability notes in FRICTION.log). Because tests build real binaries, `hale test` also exercises codegen — it's a second codegen gate beside the examples, and it caught three real lib bugs on day one (websocket terminal-header drop, agent/llm JSON key shadowing, tracing attr mangling).

There is no linter and no CI config in this repo. Verification is per-lib, three gates: the lib must type-check under `hale check` (with its allocation warnings triaged — see gotchas), `hale test <lib>/` must pass, and the demo must build and run with the documented behavior. Remember: `hale check` alone does not exercise codegen — the test run and example build/run are the real gates.

Useful CLI conveniences at current HEAD: `hale build --dev` (O1 pipeline for fast iteration), `HALE_TIME=1` (per-phase build timing), `hale check --json` (NDJSON diagnostics), `hale fmt` / `hale fmt --check`, `hale doc --stdlib` (generated API reference incl. per-fn effect classes), `hale verify` (check + advisories, any finding exits 1 — the CI-shaped gate; not this repo's gate yet), `hale bench` (`*_bench.hl` discovery, ns/op + allocs/op), `hale lsp`, `hale mcp`. Native builds are host-tuned O3 by default — a binary meant to run on other machines needs `--target-cpu baseline`.
