# pond/agent/tools — friction log

Format borrows from other pond libs: one entry per gap, with the
smallest reproducer that forced the call.

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

## 2026-05-16 — locus-method-cannot-be-fallible — [CLOSABLE]

**2026-05-27 update.** v0.8.1 narrowed the two-channel rule (#24
v0.2, commits `d565d6f` + `98910b9`); user-declared `fn` member
fns now carry `fallible(E)`. The next source pass restores
`Registry.dispatch(call) -> ToolResult fallible(ToolError)`
directly; the `dispatch_call` non-fallible variant + the
`tools::dispatch` paired free fn collapse into the single
fallible method. Clean breaking change. The shared
`__lookup_invoke` kernel stays — it's the same logic either way.

**Current source shape (still in place).** CONTRACTS.md declares
`Registry.dispatch(call: ToolCall) -> ToolResult fallible(ToolError)`.
Under the old (pre-v0.8.1) rule, locus methods couldn't carry
`fallible(E)`. The split:

1. **Non-fallible locus method** —
   `Registry.dispatch_call(call) -> ToolResult`. Returns a
   ToolResult with `is_error: true` and
   `content == "unknown_tool: <name>"` on miss.
2. **Fallible free fn** —
   `tools::dispatch(reg, call) -> ToolResult fallible(ToolError)`.
   Callers that want hard value-channel error semantics use
   this. ToolError carries `kind: "unknown_tool"` or `"empty_name"`.

Both paths share `__lookup_invoke(entries, call, not_found_marker)`
as the lookup kernel.

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
