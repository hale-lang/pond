# heron — v0 status

Status as of the initial grammar.js + @ffi wrapper commit
(2026-05-23).

## 2026-07-15 — v0.10 language-surface sync

Brought the grammar current with the June–July additions it had
drifted behind (grammar.js was pinned to a ~May revision). Added:

- **Topology (v0.10 Phase 1):** the `topology { node N { l3 name
  { cores A..B; } } reserve cores ...; }` block, and the
  `pinned(...)` affinity attributes `core = / cores = <range|set>
  / node = / l3 =` plus `replicas = K`; also the `where async_io`
  placement constraint on a `placement` entry.
- **Perspectives hot-swap (v0.10 Phase 2/3):** the `serves P`
  conformance clause (`locus X : serves R, tier 2`), the
  `reperspective self.slot as Impl;` statement, the
  `perspective(P)` handle type, and the perspective-contract
  members that were missing (bodyless `fn` signatures + `bus`
  block).
- **WASM (#152/#153):** the `@export locus` decorator.
- **Per-child `terminate;`** statement (2026-05-30).
- **`resets_per_epoch(...)`** closure clause (F.34).
- `highlights.scm` keyword sync for all of the above.

Validated: 32/32 corpus tests (3 new); all 8 in-tree example
fixtures using these constructs parse ERROR-free; **zero
regressions** (the 8 fixtures still failing — tuples, enum
payloads, some control-flow / fn-arena / mode-default shapes —
fail byte-identically on the pre-change grammar; they are
pre-existing v0 gaps, not v0.10 surface). Reserved-but-
unimplemented keywords (`async`/`await`/`impl`/`macro`/`trait`)
are intentionally not modeled — Hale rejects them as parse
errors, so they have no grammar production to attach to.

## What works

- **`tree-sitter generate`** succeeds cleanly. Parser table
  generated; ships ~133KB grammar.json + ~177KB
  node-types.json + ~974KB parser.c in `src/`.
- **Corpus tests:** 13/13 in `test/corpus/*.txt` pass.
- **Real-world parsing:** 30/30 editor-corpus `.hl` files
  (top-level + `lib/lotus_viz/`) parse cleanly with no
  `ERROR` or `MISSING` nodes.
- **Highlights:** `queries/highlights.scm` loads without
  errors against the generated grammar; covers keywords,
  types, functions, identifiers, literals, operators,
  punctuation, bus subjects, builtins.
- **Hale `@ffi` wrapper:** `heron.hl` exposes Parser /
  Tree / Node + the operations consumers need (kind,
  start_byte, end_byte, start_row/col, child / named_child,
  field, text, walking helpers). `glue.c` is a thin C
  shim that hides tree-sitter's TSNode-by-value shape
  behind pointer returns.
- **Tree-sitter query support:** `heron::Query` locus
  compiles a .scm document at birth, applies against any
  Node via `apply(root) -> String` returning a
  newline-separated `start:end:capture_name` table.
  Powers SourcePane's syntax highlighting + block
  spotlighting consumers — same primitive serves both.
- **lotus_viz adapter:** `lotus_viz_adapter.hl` provides
  `TreeSitterHaleParser` — implements lotus_viz's
  `LocusTreeProvider` by walking heron's AST and extracting
  Petals for locus / type / interface declarations
  (including projection-class detection for locus petals).
- **Example program:** `examples/parse_demo.hl` reads an
  `.hl` file and prints its top-level decls — the
  canonical "hello world" against heron's surface.

## Build dependency

The Hale-side wrapper requires **libtree-sitter** at link
time (declared in `hale.toml` `[ffi]`). Install before
building anything that imports `vendor/pond/heron`:

```
apt:    sudo apt install libtree-sitter-dev
brew:   brew install tree-sitter
source: https://github.com/tree-sitter/tree-sitter
```

The generated `src/parser.c` IS checked in, so the runtime
library is the only system dep — consumers don't need the
tree-sitter CLI.

**Verified end-to-end (2026-05-23):**

```
gcc -Wall -c glue.c -o /tmp/heron_glue.o    # clean, no warnings
gcc -Wall -c src/parser.c -o /tmp/heron_parser.o   # clean
gcc -o smoke smoke.c glue.c src/parser.c -ltree-sitter   # links clean
./smoke
# parses `locus Hello { ... }`; root kind = source_file;
# named children = 1 (the locus_decl). Cleanup runs clean.
```

Query API also verified: queries/highlights.scm compiles
into a TSQuery; apply against a parsed `locus Hello { ... }`
returns coherent capture runs (locus→keyword, Hello→type,
String→type.builtin, birth→keyword.function, println→function.call,
self→both variable.builtin AND keyword — consumer picks most
specific).

## Stdlib coverage — full

**19/19 stdlib files parse cleanly** (was 7/19 at initial
grammar commit). Two grammar additions closed the gap:

1. **`range_expr`** at precedence level 1, left-assoc. Handles
   `expr..expr` and `expr..=expr` (used in slicing throughout
   the stdlib, e.g. `s[from..total]`).
2. **`unit_type`** as `()` — added to `_type_expr` choice list.
   Lets `-> () fallible(IoError)` parse correctly (the
   stdlib uses this shape when an explicit unit-success
   return is paired with a fallible marker).

Half-open ranges (`..end` / `start..`) are not in stdlib
usage today; add when a workload surfaces. Same for
`from..` without end.

## Deferred to scanner.c

Per README § "Deferred to scanner.c", these contextual
keywords are handled by treating them as regular keywords at
v0. Working without context-sensitive lexing means a few
parses fail on ambiguous positions; the consumers fall back
gracefully.

- `mode` (locus-member position only)
- `captures`, `inline` (closure body only)
- `fail`, `or`, `raise`, `discard`, `with` (contextual
  fallible positions)
- `fallible` (after fn return type only)
- `approx`, `within` (closure body only)
- `pool`, `heap` (capacity block only)
- `topic`, `main`, `bindings`, `birth_check` (top-level
  contextual)

## Conflicts declared

The grammar declares these GLR conflicts. Each is
documented inline in `grammar.js`; surfacing here for
discoverability:

| Conflict | Reason |
|---|---|
| `_expression` × `_type_expr` | `qualified_name` appears in both |
| `lvalue` × `self_expr` | `self[i]` could be lvalue or expr+index |
| `lvalue` × `_expression` | `foo.bar` could be lvalue or field_expr |
| `binding_pattern` × `qualified_name` | bare ident in pattern position |
| `if_stmt` × `if_expr` | statement-position vs value-position |
| `qualified_name` × `path_expr` | `Foo::Bar` ambiguity at `{` vs `(` |
| `qualified_name` × `_expression` | qualified-name vs ident expression |
| `named_type` × `_expression` | `<` as generic-args vs comparison |

## Supertypes deferred

Tree-sitter requires supertype symbols to have a single
visible child per alternative. `_type_expr` includes a
parenthesized form `('(' _type_expr ')')` which doesn't
satisfy. Without supertypes, queries still work — we lose
only the "supertype node" walking affordance. Revisit when
grammar stabilizes.

## Known issue — Tree return leaks per parse (M90)

`Parser.parse(source) -> Tree` returns a Tree locus from a
method body. Per spec/semantics.md § "Method-returning-locus
heap allocation (m90)", such returns are program-lifetime
allocated — neither the eager-dissolve nor the deferred-flush
path fires on the returned locus. So each `parse()` call
leaks the previous Tree's TSTree + its owned source copy.

**Impact at editor scale:** ~one Tree per file change. Typical
.hl files are 5-50KB → ~10-100KB leak per parse. A
heavily-used SourcePane could leak ~MB/hr.

**Workarounds available today:**
1. **Manual cleanup at consumer level** — keep the Tree
   handle and explicitly dissolve before re-parsing.
   Awkward; consumers have to manage locus state.
2. **Reuse a single parser-owned Tree slot** — refactor
   Parser to hold `current_tree_handle: Int`, replace on each
   parse, free on dissolve. Cleaner; Tree locus stays for
   external-management use cases. Worth doing once the
   in-flower parsing exercises the leak.

**Real fix lands upstream:** spec/semantics.md notes "A
return-slot ABI (caller passes a struct out-pointer + adopts
the locus into its own deferred-dissolves frame) would
tighten this without leaking — deferred to v1.x." When that
lands, the current heron API works as-is without changes.

## Coverage roadmap — what's still ahead

The grammar handles the full Hale language as exercised by
a real editor corpus + stdlib today. Future polish work:

1. **Scanner.c for contextual keywords** — when treating
   `mode` / `captures` / `inline` / `or` / etc. as plain
   keywords breaks a real parse. None has surfaced yet on
   the editor + stdlib corpus; add reactively.
2. **Half-open ranges** (`..end` / `start..`) — not in
   stdlib today; add when first usage appears.
3. **Better field-shape coverage in `highlights.scm`** —
   currently captures common patterns; iterate as editor
   integrations surface gaps in real workflows.
4. **Tag generation** (`queries/tags.scm`) for ctags-style
   navigation in editors that consume it.
5. **`locals.scm`** for editors that support tree-sitter's
   local-variable scoping (powers goto-def without a
   full LSP).

## How to verify locally

```
cd pond/heron
npm install
npx tree-sitter generate
npx tree-sitter test                 # corpus tests
npx tree-sitter parse path/to/file.hl   # individual file
```

All real-world editor `.hl` files should parse
without `ERROR` or `MISSING`. About 7/19 stdlib files do
today; the rest fail on range or other patterns documented
above.
