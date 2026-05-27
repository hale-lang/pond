# pond/metrics — FRICTION

Gaps, suspicions, and deviations from CONTRACTS.md surfaced
while building this lib.

## blocked-on: cross-seed multi-file resolution

Initial design split this lib across seven `.hl` files
(`types.hl`, `storage.hl`, `labels.hl`, `helpers.hl`,
`registry.hl`, `handles.hl`, `endpoint.hl`) per the F.19
per-directory seed model. The intra-seed build worked, but the
moment a downstream consumer imported the lib, every cross-file
type reference inside the lib raised

```
codegen error: unsupported in codegen v0: unknown type name
`__lib_metrics_<file_stem>_<Name>` in signature
```

The mangler produced the name; the symbol existed; but the
importer's codegen pass A0/A1 didn't register cross-file
declarations before signature-resolving them. Symptoms were
identical for both user-declared loci as field types
(`registry: Registry` in `endpoint.hl`, with `Registry` in
`registry.hl`) and `@form(...)` loci as field types
(`store: MetricMap` in `handles.hl`, with `MetricMap` in
`storage.hl`).

**Workaround:** consolidate every source file into one
`metrics.hl`. Single-file seeds dodge the cross-file resolution
gap because the mangler emits `__lib_metrics_metrics_<Name>`
for every public symbol and the codegen pass sees the full
namespace before any signature lookup. The trade-off is the
loss of per-concern source-file decomposition; the lib is
otherwise unchanged.

Fix once the import resolver's pass-A registration walks every
file before signature lookup; the lib should then re-split
without source changes other than the file-stem-affecting
mangled symbol names.

## blocked-on: default-init of locus-typed param field

`params { foo: Foo = Foo { }; }` segfaults at first access to
`self.foo` when `Foo` is a locus (and especially when `Foo` is
a `@form(...)` locus). The struct-literal default doesn't run
the nested locus's heap-init path; subsequent
`self.foo.set(...)` etc. write into uninitialized memory.

**Workaround:** declare locus-typed fields without a default and
require the caller to construct + pass them in. The Registry's
`store: MetricMap` and `histograms: HistogramList` fields are
both required; the canonical ctor is

```hale
let store = metrics::MetricMap { };
let hl    = metrics::HistogramList { };
let reg   = metrics::Registry {
    namespace: "myapp", store: store, histograms: hl
};
```

The existing in-tree shortener example
(`experiments/token-efficiency/workdirs/02-shortener.../main.hl`)
uses `params { codes: CodeMap = CodeMap { }; }` — that pattern
should be flagged as latent (it would segfault on first `set`).

Fix once codegen's locus-field default initialization runs the
nested locus's `birth()` / heap-init machinery.

## blocked-on: `Foo { reg: self, ... }` in a method-returning-locus body

A locus-method body that returns `Foo { reg: self, ... }` (the
"factory returning a child that holds a back-ref to the parent"
shape) raises

```
codegen error: unsupported in codegen v0: expression form Discriminant(3)
```

Per `spec/semantics.md § Method-returning-locus heap allocation
(m90)` the returned locus is heap-allocated and lives for the
program; passing `self` into one of its fields should be the
natural way for the child to call back into the parent's
methods. v0 doesn't support that shape.

**Workaround:** return a child holding *slot references*
(field-of-self) instead of the whole parent. The Counter /
Gauge / Histogram handles in this lib carry
`store: MetricMap` (a Registry field), not
`registry: Registry`. Every mutation routes through the slot
directly. The Registry's high-level operations on the slot
(beyond what the `@form(...)`-synthesized methods provide) live
inline on the handle methods rather than as Registry mutator
methods, because the handles can't call back through `self.reg`.

Fix once `Foo { reg: self, ... }` in a method-returning-locus
body codegens.

## blocked-on: cross-seed `mat::Matrix` resolution chain

Inside `metrics.hl`, `Registry.histogram(name, buckets:
mat::Matrix, labels)` references `mat::Matrix` via the lib's
own `import "../math/matrix" as mat;`. When a consumer
imports `metrics`, the consumer's mangler tries to resolve
`mat::Matrix` against the *consumer's* alias table, which
doesn't include `mat`. Cross-seed import resolution doesn't
follow transitive imports (per `spec/semantics.md § Cross-seed
namespace resolution` "Strict barrier"), so the resolution
fails with

```
codegen error: unsupported in codegen v0:
  qualified type `mat::Matrix` not in stdlib path-renames table
```

if the consumer doesn't *also* declare
`import "vendor/pond/math/matrix" as mat;` with the same alias.
The example demo does declare it; consumers who skip the
matrix import will hit the error.

**No workaround in v1** that doesn't break the contract. Long-
term, transitive-import rewriting (or moving `Matrix` to
`std::math::Matrix`) would close this. The `pond/README.md`
"no transitive deps in v1" rule covers it explicitly; this
just makes it visible at the metrics-consumer boundary.

## duplicate-suspected: Prometheus text-format renderer

The Prometheus text exposition format is well-defined and
reusable: `# TYPE name kind\n`, sample lines with
`{label="value"}` blocks, histogram triple
(`_bucket` / `_sum` / `_count`). The rendering helpers
(`prom_full_name`, `prom_escape_label_value`,
`render_type_line`, `render_sample`, `render_labels`,
`render_histogram`) are likely to surface in a parallel
`pond/observability/...` lib or in a future
`std::text::prometheus` module. Candidate for promotion once a
second consumer materializes; staying inside the metrics seed
for now per the "only edit pond/metrics/" rule.

## duplicate-suspected: tab-separated string accessors

The `nth_tab_token`, `len_floats`, `int_at`, `float_at`,
`int_csv_inc_at` family in `metrics.hl` re-implements a tiny
slice of what a parametric `Vec<T>` API would give for free.
Two parallel uses already live in this lib (bucket-bounds
Floats and cumulative-count Ints); the same shape almost
certainly already lives in `pond/router`'s path-param decode,
in `pond/sessions`' kv block, and elsewhere. Candidate for a
`std::str::csv_split` / `std::str::csv_at_int` /
`std::str::csv_at_float` family, or for a small
`pond/text/csv` lib. Staying inline here pending a second
consumer to confirm the shape.

## design-question: storing locus refs in `@form(...)` cells

`@form(hashmap)` and `@form(vec)` cells must be value-shape
structs per `spec/semantics.md § Slot restrictions (v1)` — no
LocusRef cells. That's why histograms' bucket bounds + counts
live as serialized tab-strings inside the `HistogramData`
struct rather than as embedded Matrix refs. Every observe()
pays a parse + re-serialize cost (O(B) per call where B is the
bucket count). For the contract's "single instance per app"
shape with O(10) buckets per histogram and infrequent observe
rates, this is fine; surface here if a hot-path workload
demands per-bucket integer-array storage. The natural lift is
a per-histogram `@form(vec)` child locus owning the counts
buffer, parented to Registry via `as_parent_for` —
`spec/forms.md` doesn't yet document the composition pattern.

## design-question: histogram monotonicity as an inline closure

The task brief said "encode as a `closure { sum(... bucket >= ...)
~~ ... }` invariant on the Histogram locus." The closure-
assertion grammar (`spec/grammar.ebnf § closure_decl`) is
`expression ~~ expression within expression` — a single
numeric-comparison shape with optional `sum(...)` accumulators
per `crates/hale-codegen/tests/fixtures/examples/41-closure-
accumulator/`. There's no surface that expresses "for every
pair (i, i+1), counts[i+1] >= counts[i]" directly inside the
assertion; the pair-quantifier shape would require either a
new accumulator vocabulary (`all_pairs(...)`, `monotonic(...)`)
or a value-channel computation feeding a single scalar into
the assertion.

This lib chose the latter: a free fn (`count_out_of_order`)
recomputes the invariant in observe() after each update,
folds it into a single `self.out_of_order: Int` field, and
fires `violate buckets_monotonic;` when it's non-zero. The
closure declaration uses `epoch inline` (no auto-fire,
assertion-less) per `spec/grammar.ebnf § closure_decl`
v1.x-VIOLATE and `spec/semantics.md § Inline closure
violation`:

```hale
closure buckets_monotonic {
    captures: out_of_order;
    epoch inline;
}
```

The `captures:` clause makes `out_of_order` part of the audit
snapshot routed to the parent's `on_failure(c, err)`. This is
the closest the v1 closure grammar supports to a "buckets are
monotonic" structural assertion — if a future spec adds a
`pair_sum` or `monotonic` accumulator, this should migrate to
the assertion form.

## deviation: namespace prefix injected at render() time

`Registry.namespace` is consulted only in `render()` (via
`prom_full_name`), not at registration. Two consequences:

1. Changing `namespace` between registrations and a render
   would change the rendered names without re-registering.
   The contract surface ("namespace: String = """) reads as
   set-at-construction, so this matches the spec; the
   render-time application is documented here.
2. Composite keys in `store` use the bare `name` (without
   the namespace), so a counter named "requests" registered
   under namespace "a" collides with one named "requests"
   under namespace "b" on the *same* Registry. Single-
   Registry-per-app is the documented use, so this isn't
   reachable in practice.

## deviation: histogram observe() walks the buckets linearly

`Histogram.observe` walks bounds[] front-to-back looking for
the first bound `>= v`. O(B) per observe. The Prometheus
convention is B in the 5–20 range so linear is the right
shape; if a workload demands large-B histograms, a binary
search would slot in cleanly here.

## design-question: render() doesn't sort metric series

`render()` walks `store` in `@form(hashmap)` hash-table order
(per `spec/forms.md` `key_at`/`entry_at`). Order is
deterministic for a given table state but *not* lexicographic.
Prometheus consumers don't require lex-sorted output (the
exposition format doesn't mandate ordering) but some operators
rely on diff-friendly stable output. Sorting before render
would add an O(N log N) step and a temporary buffer; deferred
until a workload demonstrates the friction.

## deviation: `MetricsEndpoint.handle` ignores `req.path`

The endpoint responds to every request (any method, any path)
with the metrics dump. The CONTRACTS.md surface
(`fn handle(ctx: Context) -> Response`) implies routing-aware
dispatch, but `std::http::Handler` (v1) takes a `Request`, not
a `Context` — there's no `Context` type / `RouteParams` in
stdlib yet (those live in `pond/router`, a separate Tier 1
lib). The natural composition is: mount `MetricsEndpoint` at a
`pond/router` route bound to `GET /metrics`. The endpoint
itself stays unconditional so it works both standalone and
behind a router.
