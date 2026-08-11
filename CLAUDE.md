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
- **`COMPILER-BUGS.md`** (repo root) — the handoff file for the compiler team: *only* live, reproduced compiler defects, each with a self-contained repro, an expected result, an observed result, and the compiler commit it was verified against. Nothing else belongs in it — no design notes, no triage, no workaround logs (those stay in `FRICTION.log`). Re-verify every entry against the pinned CLI when re-baselining, and delete entries as they close.
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
- **Bus topic decls: sibling-file topics now resolve under `check` too.** Upstream WS3.3 (2026-06-11) fixed cross-file topic resolution — `bus { publish T; }` / `T <- v;` resolve a `topic T` from a sibling file under `hale build` and `hale run`. The check-vs-build divergence is **CLOSED at hale `3c05dad`** (2026-08-11): `hale check` now merges a multi-file no-import seed before checking, so a topic declared in one file and subscribed from a sibling resolves under `check` exactly as it already did under `build` (verified with a three-file probe). Co-locating a `topic` decl with its publisher is therefore no longer required — the existing co-location is inertia, not a constraint. When ≥2 files publish the same topic, use the literal-subject form (`publish "wire.subject" of type T;` + `"wire.subject" <- v;`) — `agent/llm` does this across its two client files, and its wire subjects are a compatibility contract (do not rename).
- **`or fail E { ... }` payloads may now reference `err`** — **FIXED at hale `3c05dad`** (2026-08-11); `return src(x) or fail DstError { kind: err.kind };` compiles and runs. The wrap-helper idiom (`fn wrap_x(e: SrcError) -> T fallible(DstError)`) still works and stays where it carries real translation logic, but is no longer forced for a field copy. Also lifted earlier (v0.12.0): reading an error payload's fields in a plain `or { ... }` block works — `parse_int(s) or { println(err.kind); -1 }` compiles and runs (caveat: stdlib `ParseError.kind` carries `"parse_int"`, not the spec-documented `"not_int"`/`"empty"`/`"overflow"` — verify before branching on stdlib kind strings). Since hale `400ac68`, `or` handlers may themselves be `fallible(E2)` with implicit propagation — write `or wrap_x(err)`, no trailing `or raise` (the old `or (wrap_x(err) or raise)` spelling still works but is redundant). Caveat, NARROWED at v0.16.0: a **stdlib path-call** now works directly as a handler (`boom() or std::str::index_of("ab", "b")` compiles and runs — verified 2026-08-11), so only `@form`-synthesized methods still need the explicit nested spelling.
- **`-> ()` on a non-fallible locus method** — **FIXED at hale `3c05dad`** (2026-08-11); `-> ()` normalizes to "no return type" and the old `tuple type must have at least 2 elements; got 0` reject is gone. Omitting the return type is still the house style; both spellings now compile.
- **`or <substitute>` LocusRef→Interface coercion now works for `@form`-synthesized methods too** — **FIXED at hale `3c05dad`** (2026-08-11); `vec_of_iface.get(i) or Concrete { }` gets the same fat-pointer coercion as a plain fallible call. The hoisted let-ascription in `agent/tools/registry.hl` (`let noop: Tool = __NoopTool { }; ... entries.get(i) or noop`) is now optional — it still reads fine, so it is left in place rather than churned.
- **Unbounded-allocation warnings are DEFAULT-ON** (upstream M3 stage 5). Every `hale check` on a bare lib surveys the whole seed and keeps ALL warnings (run-to-exit example binaries warn nothing). They're advisory — never fail the check — but this repo treats them as a triage queue: each warning is either fixed or recorded as triaged (true-by-design / false-positive-shaped) in the lib's `FRICTION.log` section. The analysis got materially smarter in v0.11.12 (const-folded loop ceilings, eager per-iteration children, `vec.set` retire, fail-exits-the-loop) — the 2026-08-03 re-baseline cleared embeddings/crypto/logfmt/migrations/ml-neural to 0 with no source change. The 2026-08-11 triage pass took the repo from **78 sites to 18**. 57 were acknowledged with `@unbounded` on 26 enclosing fns, each carrying a one-line `// @unbounded: <why>` justification directly above it — the justification lives next to the code rather than in a log, so it is reviewed with the code. Every one was verified domain-bounded before annotating (tui's decoders emit one `Event` per input sequence; `ml/neural`'s sweeps are over LAYERS, not samples; `math/matrix`'s fills size the fn's own fresh return value; `jobs`' payloads sit on failure-EXIT paths; `pq`/`tui`'s loops are bounded by pool size and terminal size).

  **All 18 remaining are one blocked class, not un-triaged.** Every one is `hot-path allocation` — `ml/neural/model.hl` (15), `pq/pool.hl` (2), `http/client/wire.hl` (1) — and every one already carries a correct `@unbounded`. They stay visible only because that lint class ignores the annotation its own message tells you to use (`COMPILER-BUGS.md` § 2). They go silent the moment it lands; **no pond change is pending.**

  **`http/client` and `metrics` were UNFROZEN for this** (2026-08-11). They were vendored copies of stdlib-promoted surfaces marked frozen, which meant they could never be made clean and permanently blocked adopting `hale verify` (any-finding-fails) as a CI gate. They are now *maintained, not frozen*: the surface stays closed and behaviour still tracks the stdlib, but hygiene changes — annotations, comments, triage — are allowed so they satisfy the same gates as every other lib. Behavioural divergence from the stdlib is still a bug in the copy. Since v0.12+, advisories from IMPORTED seeds are reported only when that seed is the check target. `@unbounded` on an enclosing fn/hook is the sanctioned acknowledge for intentionally-unbounded shapes (and the path to adopting `hale verify`, which fails on ANY finding, as a CI gate — not adopted here yet). Opt-out flag `--no-warn-unbounded-alloc` exists; don't use it in the verification gate.
- **Green `hale check` does not imply codegen-clean.** Bare libs never reach codegen, so codegen-only breaks (all of the above) hide behind a passing check. The gap NARROWED at v0.12/v0.13 — check now resolves imports (cross-seed analysis), compares types at call boundaries, and rejects unknown `std::` namespaces — but fallibility-disposition enforcement is still codegen-only (an unhandled fallible `Stream.send` checked green for 19 days in agent/llm, 2026-07/08). The two divergences found in the 2026-08-11 pass — the block-tail return (`fn f() -> Int { let d = 1; d }` typechecking `ok` then failing codegen) and the sibling-file topic — are both **FIXED at hale `3c05dad`**, but the class is not closed. Always build and run at least one example after touching a lib, and run `hale test <lib>/`.
- **Intra-pond imports are always relative** (`import "../db"`, `import "../../../sqlite"` from examples). The consumer-style `vendor/pond/…` spelling belongs to end apps only — since v0.12's import-resolving `hale check` it fails the per-lib check gate (this bit pq, the one lib that used it; fixed 2026-08-03).
- **Upstream memory-safety bugs — the whole family is CLOSED (re-probed 2026-08-11 at hale `3c05dad`).** All three previously-open bugs verified fixed: the method-frame heap corruption (closed at v0.13.0), the **zero-reads** manifestation (hale#381 — differential probe now gives an identical `loss=0.16499` for both allocation orders, 5/5, versus the old `0.158267` zero-input signature), and the migrations **factory-after-a-caught-failure** segfault (hale#375 — reconstructed from the real seeds, 5/5 clean). The ordering disciplines those bugs forced are therefore no longer load-bearing; retiring them is a pending cleanup, not a live constraint.

  **The v0.16.0 free-fn locus-rebinding regression is FIXED at hale `3c05dad`** (2026-08-11). It briefly made `ml/neural`'s `forward()` return an empty Matrix (params intact, every `get` failing) and killed two tests; the library was deliberately left uncontorted and is now green again with **no source change**. Bisected to hale `cd75511` (GH #402) and fixed the same day. One residue survives — see `COMPILER-BUGS.md` § 1: a **`let`-bound locus passed as an argument to a free fn that returns it**, where the caller returns that result, is still reclaimed early (`let x = make(); return passthru(x);` hands back an emptied locus, while `return passthru(make());` is fine). Silent, exit 0. No pond lib hits it today; don't write that shape until it closes.

  **The retirement pass is DONE (2026-08-11).** The workarounds those bugs forced are gone: `ml/neural`'s allocation-ordering discipline (tests + xor-trainer demo — the train_step test now builds each model *before* its inputs, the order the discipline forbade), and migrations' inline-set duplication (seven copies collapsed into a `std_set()` factory). `Trainer.fit`'s preallocate + `extract_row_into` was KEPT deliberately — it is the allocation-free hot loop on its own merits, and its comment now argues that rather than citing a fixed segfault. Nothing in this repo is now shaped by a memory bug.

## Repo structure (high-level)

- **`_util/*`** — Tier 0 internals; single-file namespace-lotus utilities operating on primitives only. Five today: `intfloat`, `decimal_float`, `duration_int`, `kvpack`, `rowbuf`. Importable from anywhere since WS3.4 (the old G34 restriction is gone).
- **`http/`, `crypto/`, `subprocess/`, `math/`, `term/`** — Tier 0 infrastructure. (`http/client` PROMOTED to the stdlib `std::http` client surface in hale ≥ v0.11.4 — frozen here for older pins; pond's `Request`/`Response` became stdlib `ClientRequest`/`ClientResponse`.) `term/` is pure Hale over the `std::term` primitives (hale #108-#110).
- **`sqlite/`, `router/`, `sessions/`, `jobs/`, `migrations/`** — Tier 1 Rails-shape web stack. (`router/` PROMOTED to `std::http::Router` in hale ≥ v0.11.4 — the vendored copy is frozen for older pins; new code uses the stdlib surface directly.) **All real since 2026-06-12**: `sqlite/` is a pure-`@ffi` driver over the system `libsqlite3` (needs `libsqlite3-dev` at build time); `jobs/` and `migrations/` run on it (`migrations/` via the `sqlite::Driver` adapter satisfying `db::DbDriver` — promoted from migrations into `sqlite/` 2026-07-06, so `migrations/` itself is pure Hale over `pond/db`).
- **`logfmt/`, `metrics/`, `supervisor/`, `tracing/`** — Tier 2 observability + supervision. (`logfmt/` FileSink+ConsoleSink PROMOTED to `std::log` and `metrics/` PROMOTED wholesale to `std::metrics` in hale ≥ v0.11.8 — vendored copies frozen for older pins; stdlib metrics Registry owns its storage and takes histogram bounds as a space-separated String, not a math Matrix. logfmt's OtlpSink stays in pond.) The OTLP exports (logfmt `OtlpSink`, tracing `export_otlp`) POST via the stdlib client (`std::http::post`) since 2026-08-04 — consumers no longer need to vendor `pond/http` for them.
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

There is no linter and no CI config in this repo. Verification is per-lib, three gates: the lib must type-check under `hale check` (with its allocation warnings triaged — see gotchas), `hale test <lib>/` must pass, and the demo must build and run with the documented behavior. Remember: `hale check` alone does not exercise codegen — the test run and example build/run are the real gates. (`hale fmt --check .` currently reports drift on ~140 of 189 files — pond predates `hale fmt`; adopting the fmt gate would be one big reformat commit and is an open decision, not policy.)

Useful CLI conveniences at current HEAD: `hale build --dev` (O1 pipeline for fast iteration), `HALE_TIME=1` (per-phase build timing), `hale check --json` (NDJSON diagnostics), `hale fmt` / `hale fmt --check`, `hale doc --stdlib` (generated API reference incl. per-fn effect classes), `hale verify` (check + advisories, any finding exits 1 — the CI-shaped gate; not this repo's gate yet), `hale bench` (`*_bench.hl` discovery, ns/op + allocs/op), `hale lsp`, `hale mcp`. Native builds are host-tuned O3 by default — a binary meant to run on other machines needs `--target-cpu baseline`. At v0.16.0 that spelling still works but now names `x86-64-v3` (AVX2/BMI2/FMA), not a true baseline; `--target` also takes canonical triples and `hale --list-targets` prints the support tiers.
