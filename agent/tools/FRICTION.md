# pond/agent/tools — friction log

Format borrows from other pond libs: one entry per gap, with the
smallest reproducer that forced the call.

---

## 2026-06-08 — or-fallback-interface-same-name-structural-trap — [CLOSED]

**Status:** [CLOSED — FIXED IN-LIB]

**Root cause of the `type Tool cannot satisfy interface Tool`
build break.** The previous source routed the proof-of-
unreachable `@form(vec).get` fallback through a helper fn whose
return type was the *interface*:

```hale
fn __noop_tool() -> Tool { return __NoopTool { }; }
let t = entries.get(i) or __noop_tool();
```

By 2026-06 the typechecker's `or <substitute>` arm *does* run
LocusRef → Interface coercion (the 2026-05-18 gap below is
closed). But that coercion path also fires a structural-impl
check, and — unlike the fn-arg call-site — the `or <substitute>`
arm has no `rhs_name != iface_name` identity guard
(`hale-types/src/check.rs`, the `interface_satisfied` block in
the `Or::Substitute` checker). When the substitute is *already*
the interface type `Tool`, the checker calls
`check_structural_impl("Tool", "Tool")`, which looks up the
first `Tool` as a *locus*, finds the interface instead, and
emits `type \`Tool\` cannot satisfy interface \`Tool\` — only
loci satisfy interfaces`. The helper-fn indirection was the
direct cause: it made the substitute's success type name
collide with the interface's name.

**Fix taken (smallest correct change).** Drop the `__noop_tool()`
helper and use the locus literal directly:

```hale
let t = entries.get(i) or __NoopTool { };
```

The substitute's type name is now `__NoopTool`, distinct from
the interface `Tool`, so the structural-impl check takes the
intended LocusRef → Interface path and succeeds. This is the
shape the 2026-05-18 entry *wanted* once coercion landed — the
helper was a stale workaround that became actively wrong.

---

## 2026-05-18 — or-fallback-no-locus-to-interface-coerce — [CLOSED]

**Status:** [CLOSED — coercion landed upstream]

`@form(vec).get(i)` returns `T fallible(IndexError)`. When `T`
is an interface (here `Tool`), the natural proof-of-unreachable
shape `let t = entries.get(i) or __NoopTool { };` once failed
because the `or <substitute>` checker didn't fire the standard
LocusRef → Interface coercion. That coercion has since been
plumbed into the `or <substitute>` arm, so the locus literal
now types directly. See the 2026-06-08 entry above for the
follow-on same-name trap that the *workaround* (a
`-> Tool`-returning helper) introduced and how it was removed.

---

## 2026-05-16 — locus-method-cannot-be-fallible — [CLOSED]

**Status:** [CLOSED — migrated 2026-06-08]

v0.8.1 narrowed the two-channel rule (#24 v0.2); user-declared
`fn` member fns now carry `fallible(E)`. The source pass on
2026-06-08 collapsed the old workaround: the non-fallible
`Registry.dispatch_call(call) -> ToolResult` method and the
paired fallible free fn `tools::dispatch(reg, call)` are gone,
replaced by the single
`fn dispatch(call: ToolCall) -> ToolResult fallible(ToolError)`
method on `Registry` (matching CONTRACTS.md verbatim).
"tool not found" / empty name now surface as
`fail ToolError { ... }`; tool-internal failures still ride back
in the returned ToolResult with `is_error: true`. The shared
`__lookup_invoke(entries, call)` kernel stays (its
`not_found_marker` param collapsed away — it always returned the
`__not_found__` sentinel for the one remaining caller).

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

`pond/agent/tools::Registry` does NOT do this — since the
2026-06-08 migration its `dispatch` is a real fallible method
(`fn dispatch(call) -> ToolResult fallible(ToolError)`), so it
has no `last_error_*` cache and no non-fallible-method/fallible-
free-fn split. The Registry's "errors" are a small closed set
(unknown_tool / empty_name) and tool-internal failures still
ride back inline in the ToolResult content.

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

## 2026-05-16 — interface-direct-storage — [RESOLVED]

**Status:** [DESIGN-NOTE — resolved]

The `Tool` interface (`interfaces.hl`) is the storage element
type: the internal `@form(vec) locus ToolList { capacity { heap
items of Tool; } }` stores coerced `Tool` interface values
directly (no Entry / fn-pointer wrapper). `register(t: Tool)`
coerces a Tool-shaped locus at the arg site; `dispatch` /
`list` walk the vec and call `t.spec()` / `t.invoke()` through
the interface fat pointer. The interface is load-bearing at the
storage layer and at every fn/method signature typed `Tool` —
do not delete it as "dead code."
