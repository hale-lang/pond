# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`pond` is the Hale language's "non-std std lib" — opinionated, domain-shaped contrib libraries that apps vendor inline. It sits between `runtime/stdlib/` (always-loaded substrate) and one-off app code. Each lib is its own seed (one directory of `.hl` files, per Hale's F.19 per-directory model); consumers vendor the whole pond repo and import only the libs they need:

```hale
import "vendor/pond/sqlite" as db;
import "vendor/pond/agent/llm" as llm;
```

There is no monorepo-level build. Each lib builds independently with `hale build <lib-path>`. Each example builds with `hale build <lib>/examples/<demo>/`. The `hale` CLI binary is produced from the upstream `hale-lang/hale` compiler repo and assumed on PATH.

## Authoritative documents (read these before editing)

- **`README.md`** — catalog of every lib by tier, with suggested aliases.
- **`CONTRACTS.md`** — locked public API surface for every lib. *This is binding.* If you implement a lib, your code must match the surface here. If a constraint forces a deviation, log it in the lib's `FRICTION.md` and reflect it in the dated status note at the top of CONTRACTS.md (currently `## 2026-05-27 status note`).
- **`<lib>/FRICTION.md`** — per-lib log of deviations from the contract, blocking gaps, and proposed stdlib unblocks. The FRICTION log is often the *primary deliverable* of a BLOCKED lib (e.g. `sqlite/FRICTION.md`).
- **`<lib>/README.md`** — the as-built surface for that lib (may differ from CONTRACTS.md while deviations are open) and a "When this unblocks" recipe describing the cleanup pass to perform when an upstream primitive lands.

## Hard rules from the broader Hale workspace

These come from the upstream compiler repo's AGENTS.md and apply here:

- **Don't edit `crates/` in the compiler repo.** If a primitive is missing, work within the existing surface or log it as friction — never reach into compiler territory to add it. `pond/sqlite/` (and transitively `pond/jobs/` + `pond/migrations/`) is the one remaining architecturally BLOCKED chain today, waiting on `std::db::sqlite::*` from the compiler team (see `sqlite/FRICTION.md § F.1`).
- **No `panic` / `assert`.** Every failure routes through `fallible(E)` (value channel) or closure violation (structural channel). Bridge value→structural with the `closure NAME { captures: ...; epoch inline; } / violate NAME;` pattern from `spec/styleguide.md § 7`.
- **Two-channel rule** (`spec/semantics.md § "Where each channel lives"`, narrowed in v0.8.1 / open-question #24). User-declared `fn` member fns on a locus CAN declare `fallible(E)` (value + heap-bearing payloads, full `or raise` / `or <substitute>` / `or handler(err)` / `or discard` disposition surface). What stays rejected: **substrate-facing surfaces** — lifecycle methods (`birth` / `run` / `accept` / `drain` / `dissolve` / `on_failure`), mode methods (`bulk` / `harmonic` / `resolution`), closure assertions, and bus-subscribed handlers (rejection fires at the subscribe site). Pond was authored against the older blanket rule and most libs still ship the free-fn-plus-sentinel shape; per-lib FRICTION.md tracks which methods are scheduled to flip back to `fallible(E)` in the next source pass.

## Codegen-v0 limitations that shape the code

Several non-obvious patterns in this repo exist because codegen v0 (the current Hale lowering) can't express the more natural shape. Don't "fix" these — they are intentional workarounds tracked in FRICTION logs:

- **`@form(vec)` factories must be namespace-lotus methods, not free fns** — free fns can't return `LocusRef`. See KNOWN_GOTCHAS G3 / G4 and the `math/matrix/` Mat namespace lotus pattern in CONTRACTS.md.
- **Two-hop import codegen break (G34).** `_util/*` libs are consumable from end-apps and from other `_util` libs, but **NOT** from inside the tier-0/1/2/3/4/5 pond libs. The lib import succeeds but `util_alias::SomeNamespace { }` literals fail at codegen with `unsupported in codegen v0: qualified-name struct literal in expression position`. Tier libs keep local copies of the helpers and flag the duplication in FRICTION.md; do not try to migrate them yet.
- **File ordering inside a seed matters.** F.19 bundles `.hl` files alphabetically and codegen processes type decls in that order, so a `topic` whose payload type lives in `types.hl` must live in a file lexically ≥ `types.hl`. See `agent/llm/wire_topics.hl` for the canonical "named-around-the-bug" example (literal `topics.hl` would land before `types.hl` and fail).

## Repo structure (high-level)

- **`_util/*`** — Tier 0 internals; single-file namespace-lotus utilities operating on primitives only. Five today: `intfloat`, `decimal_float`, `duration_int`, `kvpack`, `rowbuf`. See the G34 caveat above.
- **`http/`, `crypto/`, `subprocess/`, `math/`** — Tier 0 infrastructure.
- **`sqlite/`, `router/`, `sessions/`, `jobs/`, `migrations/`** — Tier 1 Rails-shape web stack.
- **`logfmt/`, `metrics/`, `supervisor/`, `tracing/`** — Tier 2 observability + supervision.
- **`agent/{llm,tools,conversation,sandbox,embeddings}/`, `ml/neural/`** — Tier 5 AI / agent orchestration.
- **`websocket/`, `tower/`** — partial / WIP libs from the realtime tier.
- **`heron/`** — outlier: tree-sitter grammar for Hale, not a Hale seed. Has its own build chain (npm + Makefile + cargo + tree-sitter CLI). See `heron/README.md`. Generated `src/parser.c` IS checked in so consumers only need `libtree-sitter` at link time, not the tree-sitter CLI.

Backlog tiers (3, 6, 7, 8 — realtime messaging, game/sim, data formats, devx) are listed in `README.md` but not yet built.

## Design rules to enforce when adding/editing libs

1. Each lib is one Hale seed (one directory of `.hl` files; F.19 per-directory model).
2. Each lib ships `README.md`, source files, `FRICTION.md`, and `examples/<demo>/` with an agent-runnable demo. The example is part of the deliverable — if a lib is BLOCKED, the example exercises the stub bodies and prints the diagnostic.
3. Public surface is locked in `CONTRACTS.md`. Deviations require both a `FRICTION.md` entry in the lib and an update to CONTRACTS.md's status note.
4. **No transitive deps in v1.** A consumer that uses `pond/jobs` (which uses `pond/sqlite`) must vendor both explicitly. Don't paper over this.
5. Every lib matches the six-pattern catalog (App locus / Namespace lotus / Service / Spawned child / Shape type / Free fn). Things outside the catalog get logged as friction, not coded around.

## Cross-cutting conventions

- **`Bytes` vs `String`** — prefer `Bytes` for binary I/O (HTTP bodies, TCP framing, JSON wire), `String` for human-readable text and stdlib paths.
- **Tab-separated kv / newline-separated rows** are the v1 collection shape (`Row { data: String }` with tabs; `Rows { csv: String }` with newlines; `RouteParams.path_kv`, `Labels.kv`, etc.). Avoid invented parametric collections — use the index-API pair or a `Matrix` of values, per stdlib precedent (`list_dir_count` + `list_dir_at`).
- **Error payload types are per-lib.** Each lib declares its own `LibError` shape; cross-lib `or` chains compose normally because every payload sits in its own scope.
- **Bus subjects via `topic` decls** when the topic is internal to one lib; literal-string subjects only for wildcard subscriptions or runtime-computed paths.

## Build & verify

```bash
# Type-check / build a single lib (most pond libs):
hale build path/to/lib/

# Build + run a demo:
hale build path/to/lib/examples/<demo>/
./path/to/lib/examples/<demo>/<demo>     # binary lands next to main.hl

# heron only — tree-sitter grammar regen:
cd heron && npx tree-sitter generate && npx tree-sitter test
```

Per `.gitignore`, demo binaries land at `examples/<demo>/<demo>` and `examples/<demo>/main` and must not be committed.

There is no project-wide test runner, no linter, and no CI config in this repo. Verification is per-lib: the lib must type-check under `hale build`, and the demo must build and exhibit the documented behavior (real output on unblocked libs; the `[demo] X error: unsupported — ...` diagnostic on BLOCKED libs).
