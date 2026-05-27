# pond/tracing — FRICTION

Gaps, suspicions, and deviations surfaced while building this lib.

## design-question: can the runtime auto-inject spans on locus birth / dissolve?

The recursive-locus principle says spans should nest with locus
instantiation: a child locus's first span has the parent locus's
current span as its parent. v1 has the user thread the parent
`SpanId` through every `start_span(name, parent)` call — fine
for short call paths, awkward for deep towers.

What runtime auto-injection would need (sketched, not built):

1. **Locus-tower-traversal hook in the lifecycle dispatcher.**
   The runtime already walks `birth → run → drain → dissolve`
   per locus per `spec/runtime.md § Lifecycle`. Adding two
   callbacks — `on_birth(locus_id, parent_locus_id)` and
   `on_dissolve(locus_id)` — exposed to a pluggable
   `TracingHook` interface would let the Tracer subscribe
   without touching the language surface. The Tracer would
   maintain a `locus_id → SpanId` map and synthesize one span
   per locus lifetime.
2. **Locus-local "current span" reading.** Inside a member fn,
   reaching `self.__current_span` (the span the runtime opened
   at this locus's birth) so user-written `start_span(...)`
   calls can default `parent` to "the enclosing locus's span"
   when omitted. Today the user has to capture the SpanId in a
   field and thread it; with a synthetic `__current_span`
   accessor, child loci would inherit automatically.
3. **A `tracing { enabled: Bool }` capacity-slot-ish locus
   declaration.** Per-locus opt-in so the runtime isn't paying
   the span-emit cost on every locus instantiation. The Design
   already has `: schedule cooperative` / `: schedule pinned`
   as similar locus-level discipline markers; `: traced` would
   slot in alongside.
4. **A subject-binding `tracer:` field on the runtime root.**
   Today the Tracer is instantiated in `main` like any other
   locus. With auto-injection, the runtime would need a stable
   handle to the active Tracer (or accept that there can be N
   tracers, each subscribing to the same `on_birth` hook). The
   "one global Tracer" assumption is convenient but reductive;
   the Design's bus shape suggests multiple tracers should be
   the natural form, each filtering on subject.

v1 keeps the explicit-`parent` discipline. None of the above
hooks ship. The contract surface is built around explicit
threading so the auto-injection arc, when it lands, can be a
strict extension (default `parent` to current-span, not
require it).

## blocked-on-compiler-gap: topic decl + cross-file publish mangling

Even WITHIN one seed (lib's `tracer.hl` + lib's `topics.hl`),
moving the `topic SpanCompleted { ... }` decl into a sibling file
hits a related gap: the file-stem prefix differs between the
topic decl's mangled name (`__lib_trace_topics_SpanCompleted`) and
the publish-site's mangled name (`__lib_trace_tracer_SpanCompleted`).
Per `spec/projects.md § Mangling scheme`, the rename map is
supposed to be unified across the whole library, but the bus-
block walking gap above means the publish-site never goes
through the rename map at all.

This forced collapsing topics + locus into a single file
(`tracer.hl`). The CONTRACTS surface plus the natural pond
convention (separate `topics.hl` like `pond/subprocess/`) would
keep them apart; deviation flagged.

## deviation: export_otlp fallibility (two-channel rule) — [CLOSABLE]

**2026-05-27 update.** v0.8.1 narrowed the two-channel rule (#24
v0.2, commits `d565d6f` + `98910b9`); user-declared `fn` member
fns now carry `fallible(E)`. The next source pass restores
`Tracer.export_otlp` to `() fallible(IoError)`; the
`last_error_kind_str()` / `last_error_detail_str()` accessors
collapse. Clean breaking change. The transport stub (next entry
below) remains the blocker on whether the method does real work.

**Current source shape (still in place).** CONTRACTS.md declares
`export_otlp(endpoint: String) -> () fallible(IoError)`. Under
the old (pre-v0.8.1) rule, the lib returned `()` and surfaced
failure via `last_error_kind_str()` / `last_error_detail_str()`.

## deviation: export_otlp doesn't actually POST (transitive import gap)

`pond/http/client/` exists in the same `pond/` tree; the natural
expression of `export_otlp` is `import "../http/client" as http;`
and call `http::post(endpoint, body_bytes, "application/json")`.

`spec/projects.md § Strict barrier: no re-exports` documents the
rule: "If library A imports library B, B's decls are NOT visible
to A's importers. Each importer must declare its own dependencies
at its own top level." When `pond/tracing` imports `pond/http/
client` internally, a downstream app that imports only
`pond/tracing` cannot see `http::HttpError` / `http::Response`
types referenced inside `tracing`'s source — the codegen path
trips on `qualified type \`http::HttpError\` not in stdlib
path-renames table`.

**Workaround applied:** strip the http import entirely. The
`export_otlp` method assembles the OTLP/HTTP JSON batch into
`self.last_export_body` and reports
`self.last_error_kind = "transport_unsupported"`. The
`completed_buf` is NOT cleared in stub mode so a retry after the
unblock picks up the same batch.

**Fix shape (architectural, not done here):** any of
1. relax the no-re-exports rule; allow imports of imported libs
   to thread through;
2. promote a `pond/http/types` (or eventually `std::http::client`)
   to a stable lower-tier that both `pond/http/client` and
   `pond/tracing` import without conflict;
3. accept that observability libs ship transport plugins as
   *consumer-instantiated children*: the consumer instantiates
   the `OtlpExporter` locus alongside the Tracer, the exporter
   subscribes to `trace.span.completed`, and the http import
   only lives in the consumer's tree.

Option 3 is the cleanest for the Design (exporters are sinks
like any other; the Tracer doesn't need to know its transport)
and matches the `pond/logfmt` `OtlpSink` shape declared at the
top of CONTRACTS.md Tier-2. The v1.x tracing followup is
"deprecate `export_otlp` from Tracer, ship a sibling
`OtlpExporter` locus that subscribes to the bus topic and
ferries spans across the http boundary in the consumer's own
import graph." This deviation logs the shape; the cut hasn't
landed in CONTRACTS.md yet.

## duplicate-suspected: __row_field in trace-tree example

The example's `__row_field(row, n)` is structurally identical to
`tracer.hl`'s `__nth_field(row, n)` — separately re-derived
because example seeds can't easily call lib-private helpers
(by spec/projects.md § Cross-seed imports, `__`-prefixed names
ARE exported as ordinary names, but the example reaching into
the parent lib's internals would couple the example to the lib's
private surface). Same rowbuf-lift candidate as above.

## design-question: silent no-op on double end_span / unknown id

`end_span(id)` is silent if the id isn't found in the open
buffer — same shape `add_attr(id, k, v)` uses. The reasoning:
mis-paired calls are user error, but turning them into a hard
structural failure (closure violation that drains the host
locus) is heavy for a tracing-instrumentation primitive that
should never take down its host. The empty-buffer-no-op
convention is consistent with `pond/math/stats`'s "empty input
returns 0.0" choice.

A future closure-test would assert the open-buffer is empty at
locus dissolve (every started span got ended). That's the right
shape for closure violation; not built at v1.

## design-question: completed_buf grows unbounded between exports

`export_otlp` is the only thing that clears `completed_buf` (and
in stub mode it doesn't — see "deviation: export_otlp doesn't
actually POST"). A long-lived Tracer in an app that never calls
`export_otlp` will accumulate forever. That's the same shape
`pond/metrics/Registry` lives with for its accumulating counters,
and the same shape pure-bus-publish loses (the SpanCompleted
topic publication is the consumer's responsibility to drain).

Possible disciplines if a workload pulls on this:
1. A `max_completed_spans` param that drops oldest on overflow.
2. Tracer.flush() that clears the buffer without exporting.
3. A separate "the Tracer is the bus publisher; the exporter is a
   subscriber; the buffer lives on the exporter not the Tracer"
   refactor — same shape "deviation: export_otlp doesn't actually
   POST" sketches.

v1 keeps the simplest shape; the friction-fix is the v1.x
refactor toward (3).

## suspicion: span counts and trace ids

CONTRACTS.md's `SpanId { id: String; }` carries a single id —
no `trace_id` separate from `span_id`. OTLP / W3C-tracecontext
distinguish "trace" (the whole request) from "span" (one
operation within it). v1 collapses both: every span is its own
"trace" because there's no per-request grouping. For the
demo-tree shape that's fine; for cross-service propagation it
isn't.

When the contract grows a `trace_id` (probably alongside the
`OtlpExporter` extraction above), the natural shape is:

```hale
type SpanId  { id: String; trace_id: String; }
type Span    { ... trace_id: String; }
```

Plus a `Tracer.start_root_span(name) -> SpanId` that mints a
fresh trace_id, and `Tracer.start_span(name, parent)` that
inherits parent.trace_id. Logged here for the v1.x cleanup.
