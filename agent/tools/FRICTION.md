# pond/agent/tools — friction log

Format borrows from other pond libs: one entry per gap, with the
smallest reproducer that forced the call.

---

## ~~2026-05-16 — interface-value-in-vec-cell~~

**closed 2026-05-18** by F.20 Phase B interface storage landing
in upstream (G20), and source-level migration to the all-Tool
shape landed same day. `EntryList` (`@form(vec) of Entry`) is
now `ToolList` (`@form(vec) of Tool`); the `Entry` wrapper
struct + `invoke_fn: fn(ToolCall) -> ToolResult` field have
been deleted from `types.hl`; `Registry.register(t: Tool)`
matches the CONTRACTS.md surface verbatim; the free-fn
companion `tools::register(reg, t)` is the cross-seed entry
(user-declared locus method arg coerce `LocusRef → Interface`
isn't yet wired across seeds — see the new
"or-fallback-no-locus-to-interface-coerce" entry below for the
one remaining drag). Original entry retained below for context.

**Status:** ~~[DEVIATION-FROM-CONTRACT — workaround still in source]~~ [resolved]

CONTRACTS.md `pond/agent/tools/` declares:

```hale
interface Tool {
    fn spec() -> ToolSpec;
    fn invoke(call: ToolCall) -> ToolResult;
}

locus Registry {
    fn register(t: Tool) -> ();
    fn dispatch(call: ToolCall) -> ToolResult fallible(ToolError);
    fn list() -> String;
}
```

`register(t: Tool)` is an interface-typed parameter that the
Registry needs to *store* (the dispatch table) for later
lookup — not just call inline.

Per `spec/types.md` § "Interface types (F.20)" Phase B (shipped
2026-05-11):

> Returning an interface value from a fn, storing one in a
> locus param/field, or putting interfaces in arrays/tuples is
> not yet supported — deep-copy across arena boundaries for
> the fat pointer is a Phase B follow-up.

Storing a `Tool` value in a `@form(vec)` heap slot falls under
"interfaces in arrays/tuples." So the literal contract isn't
implementable at v1.

**Workaround taken.** Same shape `pond/router` (Handler /
Middleware) and `pond/jobs` (JobHandler) shipped:

```hale
// types.hl
type Entry {
    spec:      ToolSpec;
    invoke_fn: fn(ToolCall) -> ToolResult;
}

// registry.hl
locus Registry {
    params { entries: EntryList = EntryList { }; }
    fn register(e: Entry) { self.entries.push(e); }
    // ...
}

// convenience free fns — preferred call-site shape
fn register_tool(
    reg: Registry, spec: ToolSpec,
    invoke_fn: fn(ToolCall) -> ToolResult
);
fn register_fns(
    reg: Registry, name: String, description: String,
    input_schema: String, invoke_fn: fn(ToolCall) -> ToolResult
);
```

This compiles because fn pointers are first-class values that
*do* sit inside struct fields / vec cells (per
`stdlib/io_tcp.hl`'s `Listener.on_connection: fn(Stream)` field
— the canonical fn-pointer-in-locus-field shape).

The `Tool` interface declaration stays in `interfaces.hl` —
it's cheap to keep around and it documents the *intended*
method set so a downstream tool author writing a Calculator
locus knows which signatures to expose. Once the F.20 Phase B
follow-up lands, `Registry.register` re-widens to
`register(t: Tool)` and the fn-pointer shadow goes away.

**Reproducer (what fails at compile time today):**

```hale
@form(vec)
locus ToolList {
    capacity { heap items of Tool; }   // not yet supported
}
```

**Suggested upstream resolution.** Land the Phase B follow-up
that lets interface values sit in struct / vec cells. Unblocks
every "register a list of plugins" library (pond/router,
pond/jobs, pond/agent/tools all hit this).

---

## ~~Source-level cleanup pending (G20 follow-up)~~

**closed 2026-05-18.** Migration landed:

- `EntryList` (`@form(vec) of Entry`) is now `ToolList`
  (`@form(vec) of Tool`).
- The `Entry` wrapper struct + `invoke_fn` fn-pointer field is
  deleted from `types.hl`.
- `Registry.register(t: Tool)` matches the CONTRACTS.md surface
  verbatim; pushes `self.entries.push(t)`.
- Companion free fn `tools::register(reg, t: Tool)` is the
  cross-seed-callable surface (free-fn arg-site coercion is the
  wired path; user-declared locus method arg coerce
  `LocusRef → Interface` isn't yet wired across seed
  boundaries).
- `register_tool` and `register_fns` (the v1 convenience fn-
  pointer overloads) are deleted — `register` is the single
  entry now.
- `__lookup_invoke` / `__build_spec_array` dispatch through the
  Tool interface's `spec()` / `invoke()` methods directly. The
  internal `or` fallback for `@form(vec).get(i)` routes through
  a `__noop_tool() -> Tool` returning fn because the `or
  <substitute>` checker doesn't yet do LocusRef → Interface
  coercion at the fallback expression site (see the new entry
  below for the one remaining drag).

The calc-tool demo flipped to:

```hale
let calc = Calculator { };
tools::register(reg, calc);
```

Output is byte-identical to the pre-migration baseline.

---

## 2026-05-18 — or-fallback-no-locus-to-interface-coerce

**Status:** [GAP — WORKAROUND-DOCUMENTED]

`@form(vec).get(i)` returns `T fallible(IndexError)`. When `T`
is an interface (here `Tool`), the natural proof-of-unreachable
shape is

```hale
let t = entries.get(i) or __NoopTool { };
```

but the typechecker rejects with:

```
type error: `or <substitute>`: fallback type
  `__lib_tools_registry___NoopTool` does not match success type
  `__lib_tools_interfaces_Tool`
```

The `or <substitute>` checker (`hale-types/src/check.rs`
around line 2579) calls `success.assignable_from(&rhs_ty)` —
it doesn't fire the standard LocusRef → Interface coercion the
way fn-arg and fn-return sites do.

**Workaround taken.** Route the sentinel through a tiny
returning free fn whose return type is the interface:

```hale
fn __noop_tool() -> Tool { return __NoopTool { }; }
// callers:
let t = entries.get(i) or __noop_tool();
```

The fn-return-site coercion converts the locus to a Tool fat
pointer; the `or` fallback then matches the success type
directly. Cheap, but it's the kind of one-line indirection F.20
Phase B was meant to eliminate.

**Suggested upstream resolution.** Plumb
`coerce_to_interface` (or the typechecker's equivalent) into
the `or <substitute>` arm of the fallible-expr checker — same
pattern fn-arg and return-site coercion already use. Then `or
__NoopTool { }` types directly and the helper fn collapses.

---

## 2026-05-16 — locus-method-cannot-be-fallible

**Status:** [DEVIATION-FROM-CONTRACT]

CONTRACTS.md declares:

```hale
locus Registry {
    fn dispatch(call: ToolCall) -> ToolResult fallible(ToolError);
}
```

Per `KNOWN_GOTCHAS.md` G4 / `spec/semantics.md` § "Where each
channel lives" (the two-channel rule): user-declared locus
methods may NOT declare `fallible(E)`. Locus methods communicate
failure via the closure-violation channel; the value-channel
(`fallible`) is for free fns and `@form`-synthesized methods only.

**Workaround taken.** Split the contract surface into two:

1. **Non-fallible locus method** —
   `Registry.dispatch_call(call) -> ToolResult`. Returns a
   ToolResult with `is_error: true` and
   `content == "unknown_tool: <name>"` on miss. This is the
   common-case ergonomic shape — "tool not found" routing back
   to the LLM as a tool error message rather than a hard error.

2. **Fallible free fn** —
   `tools::dispatch(reg, call) -> ToolResult fallible(ToolError)`.
   Callers that want hard value-channel error semantics use
   this. ToolError carries `kind: "unknown_tool"` or
   `"empty_name"`.

Both paths share `__lookup_invoke(entries, call, not_found_marker)`
as the lookup kernel so behavior stays consistent.

This is the same split `pond/jobs/queue.hl` took (Queue's CRUD
methods migrated to free fns in `query.hl`) and the same shape
`pond/sqlite/Db.exec` will land as. Logged here because it
recurs in *every* CONTRACTS.md entry that declares a fallible
locus method — strong signal CONTRACTS.md needs a sweep.

**Suggested upstream resolution.** Either (a) widen the
two-channel rule to allow fallible locus methods where the
fallibility doesn't cross a closure boundary, or (b) update
CONTRACTS.md to factor every fallible operation as a free fn
from the start. (b) is the smaller change and matches what
every pond lib has independently converged on.

---

## 2026-05-16 — duplicate-suspected: error-check-fn-with-record

**Status:** [GAP — DUPLICATE-SUSPECTED]

Three pond libs now carry the same shape:

```hale
locus Foo {
    params { last_kind: String = ""; last_detail: String = ""; }
    fn last_error_kind()   -> String { return self.last_kind;   }
    fn last_error_detail() -> String { return self.last_detail; }
    fn __record(e: FooError) -> FooResult {
        self.last_kind   = e.kind;
        self.last_detail = e.detail;
        return FooResult { };
    }
    fn public_method(...) -> FooResult {
        self.last_kind = ""; self.last_detail = "";
        return __free_fn_kernel(...) or self.__record(err);
    }
}
```

Seen in: `pond/agent/llm::AnthropicClient` /
`pond/agent/llm::OpenAiClient`, `pond/sqlite::Db` (per its file
header), `pond/subprocess::Process` (per CONTRACTS.md sketch).

`pond/agent/tools::Registry` deliberately does NOT do this — it
takes the second branch of the two-channel-rule workaround
(non-fallible method returns `is_error: true` ToolResult, free
fn is the fallible path) because the Registry's "errors" are a
small closed set (unknown_tool / empty_name) and the LLM-facing
flow naturally wants them inline in the ToolResult content.

But the pattern is clearly the v1 idiom for locus methods that
*want* to wrap a fallible free-fn kernel without exposing
fallible(E). It deserves either:
  - a small generator macro (`@error-check-cache(FooError)`)
    that synthesizes the params + the three helper methods, OR
  - a CONTRACTS.md note declaring "this is the v1 idiom; all
    fallible-locus-method contracts should be read as
    'non-fallible method + last_error_* accessors + fallible
    free-fn kernel'."

**Suggested upstream resolution.** Pick (b) for the v1
documentation pass; (a) is a follow-up if the shape stays
load-bearing for 2-3 more libs.

---

## 2026-05-16 — duplicate-suspected: vec-get-default-literal

**Status:** [GAP — DUPLICATE-SUSPECTED]

`registry.hl`'s `__lookup_invoke` and `__build_spec_array` both
loop over the `EntryList` with `entries.get(i) or Entry { ... }`,
where the `or` branch is provably unreachable (`i < n` was just
checked). The default `Entry { spec: ToolSpec { }, invoke_fn:
__noop_invoke }` is verbose proof-of-unreachable boilerplate.

Seen in: `pond/router::__router_run_chain` (Route + MwEntry
defaults), `pond/jobs::__run_real` (Job sentinel), and now here.
Pond/router's FRICTION.md already logged this under
"locus-method-fallible-routing-mismatch."

The fix is upstream (refinement typing that can prove
`i < self.len() → get(i) always succeeds`, deferred per
`spec/types.md` § "What's deferred"). Until then every consumer
of `@form(vec).get` either writes a default literal at the call
site (this lib) or wraps the call in a free-fn helper that
encapsulates the unreachable-default (also visible in
pond/router::__router_run_chain).

**Suggested upstream resolution.** A small `@form(vec)`-
synthesized method like `unchecked_get(i)` that asserts in debug
and skips the fallible(IndexError) channel; agents would call it
inside loops they've already bounded.

---

## 2026-05-16 — input_schema-as-raw-json-string

**Status:** [DESIGN-NOTE]

`ToolSpec.input_schema` is a `String` carrying raw JSON-shaped
text rather than a parsed schema structure. This is intentional
and matches `spec/stdlib.md` § json's v1 commitment ("JSON is a
wire format, not a tree value type"), but it does mean Tool
authors hand-write their schema strings and the Registry
trusts them — no validation pass before emission.

The `Registry.list()` output uses `Builder.field(name, raw)` (not
`string_field`) on this field so the schema isn't re-quoted into
a JSON string literal. A malformed `input_schema` therefore
breaks the entire `list()` output for the LLM. Tool authors
should treat the input_schema string as production wire format.

If/when stdlib gains a json tree-value type, `ToolSpec` can
re-type the field as `JsonValue` and the Registry validates on
register(). Tracked here so the eventual migration is
mechanical.

---

## ~~2026-05-16 — cross-seed-path-call~~

**closed 2026-05-18.** Both halves shipped: A3 (fallible /
non-fallible free fn dispatch cross-seed) plus the m49-subregion
fix closes the segv path documented under
`cross-seed-locus-arg-segv` below. Original entry retained for
context.

**Status:** ~~[PARTIALLY-RESOLVED]~~ [resolved] — `tools::dispatch(reg, call)
or ...` (fallible) and any non-fallible free fn that takes
primitives both work post-A3 / hale `f9068fa`. The
non-fallible `tools::register_tool(reg, spec, invoke_fn)`
*compiles* but segfaults at runtime when invoked cross-seed
(D3 sweep) — see `cross-seed-locus-arg-segv` below. The
calc-tool demo migrated the dispatch side back to the free-fn
form (`tools::dispatch(reg, call) or err_to_result(err)`) but
retained `reg.register(Entry { ... })` for registration until
the segfault is closed.

The convenience free fns `register_tool(reg, spec, invoke_fn)`
and the fallible-channel `dispatch(reg, call) -> ToolResult
fallible(ToolError)` are declared in `registry.hl` but a
cross-seed caller (e.g. `examples/calc-tool/main.hl` doing
`tools::register_tool(reg, ...)` or `tools::dispatch(reg, call)
or raise;`) hits:

```
codegen error: unsupported in codegen v0: path call `tools::register_tool`
```

**Cause.** `crates/hale-codegen/src/codegen.rs`'s
`lower_path_call` (statement position) and
`lower_path_call_expr` (expression position) only dispatch
`std::*` paths and a small set of magic-path cases (`time::*`,
`enum::variant`). Imported-lib free-fn path calls
(`alias::fn_name(...)`) aren't tried against the
`import_renames` table the way `mangled_for_path` resolves them
inside `lower_fallible_call`. So the fallible-or-bridge case
works (`tools::dispatch(reg, c) or ...`) but the
non-fallible case doesn't (`tools::register_tool(reg, ...)`),
and the value-channel-only case (`let x = tools::list_specs(reg);`)
doesn't either.

**Workaround taken.** Moved every "convenience free fn" use
site cross-seed onto the Registry as a non-fallible locus
method:

```hale
reg.register(tools::Entry {
    spec:      calc_spec(),
    invoke_fn: calc_invoke
});
let r = reg.dispatch_call(call);   // non-fallible, is_error: true on miss
```

The free fns `register_tool` / `register_fns` / `dispatch`
stay declared in `registry.hl` — they're reachable from
in-seed callers and they're the v1-unblock-day public surface
for cross-seed consumers once the path-call dispatcher gains
the `import_renames` lookup that `lower_fallible_call` already
has.

**Reproducer (what fails at compile time today):**

```hale
import "vendor/pond/agent/tools" as tools;
fn main() {
    let reg = tools::Registry { };
    tools::register_tool(reg, ...);   // fails
}
```

**Suggested upstream resolution.** Extend `lower_path_call` /
`lower_path_call_expr` to consult `mangled_for_path(segs)` for
non-`std::` paths, the way `lower_fallible_call` already does.
The mangled symbol is in `user_fns`; the call lowering is
identical to a bare ident call once the name is resolved. Once
landed, the calc-tool example's `reg.register(...)` /
`reg.dispatch_call(...)` lines can be migrated back to the
free-fn form with no source change to the lib.

---

## ~~2026-05-17 — cross-seed-locus-arg-segv~~

**closed 2026-05-18** by the m49-subregion-cross-seed-arg fix in
upstream `codegen.rs` (cited at the m49 / cross-seed-locus-arg-segv
fix comment around codegen.rs:33528). `tools::register_tool(reg,
spec, invoke_fn)` is now safely callable cross-seed; the calc-tool
demo's `reg.register(Entry { ... })` shim can collapse back to the
free-fn form. Original entry retained below for context.

**Status:** ~~[GAP — BLOCKS-CONTRACT-FREE-FN]~~ [resolved]

Surfaced during pond pass D3 (post-A3 free-fn substitution sweep).

`tools::register_tool(reg, spec, invoke_fn)` — a non-fallible
cross-seed free fn whose first arg is the Registry locus —
compiles cleanly post-A3 but segfaults at runtime on the first
mutation of `reg.entries` inside the callee. The fallible
`tools::dispatch(reg, call) or ...` does NOT crash with the same
arg shape; the fallible-`or` codegen path appears to set up the
locus arg differently.

**Repro.**

```hale
import "vendor/pond/agent/tools" as tools;
fn main() {
    let reg = tools::Registry { };
    tools::register_tool(reg, ToolSpec { name: "x", ... }, my_invoke);
    // segfaults at the first reg.entries.push inside register_tool
}
```

The same call via the locus-method form
`reg.register(tools::Entry { ... })` works.

**Workaround taken (D3).** The calc-tool demo migrated dispatch
to the free-fn form (`tools::dispatch(reg, call) or
err_to_result(err)`) but kept `reg.register(tools::Entry { })`
for registration. The lib's free fns `register_tool` /
`register_fns` still exist; they're not yet safely callable
cross-seed pending an upstream fix to the non-fallible cross-seed
locus-arg-passing path.

**Suggested upstream investigation.** Compare the m90 / locus-ref
arg-passing prologue in `lower_path_call_expr` (non-fallible,
post-A3) against `lower_fallible_call` (fallible) — the fallible
path was the pre-A3-working codepath and gets the locus pointer
right; the non-fallible path appears to copy the wrong locus
header / forget to translate the m90 fat-pointer.

---

## 2026-05-16 — @form-vec-cross-file-resolution

**Status:** [GAP — WORKAROUND-DOCUMENTED]

The internal `@form(vec) locus EntryList { capacity { heap
items of Entry; } }` originally lived in `storage.hl` (per the
pond convention of one concern per file). Cross-file reference
from `registry.hl`'s `entries: EntryList = EntryList { }` param
default failed at codegen:

```
codegen error: unsupported in codegen v0:
  unknown type name `__lib_tools_storage_EntryList` in signature
```

even though the mangled name is correctly registered (the
seed-build mangler runs `build_seed_renames` across all
files). Suspect cause: the `@form(vec)` synth pass that
materializes the cell-type struct + the .push / .get / .len
methods runs before the cross-file mangling settles, so the
synthesized methods reference a not-yet-registered type alias.

**Workaround taken.** Moved `EntryList` into `registry.hl`
alongside `Registry`. Same file, same mangling pass, problem
disappears. `storage.hl` keeps a placeholder so the seed
shape is unchanged once the gap closes and the locus migrates
back.

**Reproducer (what fails today):** any `@form(vec)` locus in a
sibling file whose cell type or list locus is referenced in a
locus-param default expression. Confirmed against
`pond/agent/embeddings/embeddings.hl`'s shape (all `@form(vec)`
loci colocated with the `Store` locus in one file — likely the
same reason).

**Suggested upstream resolution.** Order the `@form(vec)` synth
pass after the cross-file mangling pass, OR have the synth pass
register its types through the same name table the mangler
populates.

---

## 2026-05-16 — interface-shape-no-direct-storage

**Status:** [DESIGN-NOTE — forward-compat]

The `Tool` interface declaration in `interfaces.hl` is currently
unused at the storage layer (the Registry stores Entries with
fn-pointers instead). It IS still useful at every fn signature
that accepts a Tool inline:

```hale
// Future helper (not in CONTRACTS.md but obvious next step):
fn invoke_inline(t: Tool, call: ToolCall) -> ToolResult {
    return t.invoke(call);
}
```

Once F.20 Phase B unblocks (see entry 1 above), the Registry
will re-widen `register(t: Tool)` and consumers writing
Calculator-as-locus continue to work without source changes.
Documenting here so future maintainers don't delete the
interface decl as "dead code."
