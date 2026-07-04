# pond/metrics — Prometheus-format exposition

Counter / gauge / histogram metric primitives plus a
Prometheus-compatible text-format renderer and a
`std::http::Handler` mountpoint for `/metrics`.

## Suggested alias

```hale
import "vendor/pond/metrics" as metrics;
```

The bare alias `metrics` matches `pond/CONTRACTS.md`'s
suggestion and the entry in `pond/README.md`.

## Dependence

This lib has a source dependency on `pond/math/matrix` —
`metrics::histogram(reg, name, buckets, labels)` accepts a
`Matrix` of bucket upper bounds. Vendor both libs into your
app per the v1 transitive-dep rule (`pond/README.md` §
"Design rules"). As of upstream HEAD `43300e5` (2026-06-12)
consumers that never register a histogram no longer need
their own `math/matrix` import just to build against this
lib — the import is only required where you construct the
`buckets` Matrix value (see `FRICTION.log`).

## Surface

```hale
type Labels        { kv: String; }                  // "k1=v1\tk2=v2"
type MetricEntry   { ... }                          // hashmap cell
type HistogramData { ... }                          // bucket-vec cell

// labels constructors (bare free fns)
fn labels_empty() -> Labels;
fn labels_one(k: String, v: String) -> Labels;
fn labels_two(k1, v1, k2, v2) -> Labels;
fn labels_append(l: Labels, k: String, v: String) -> Labels;

locus Registry {                                    // single instance per app
    params { namespace: String = "";
             store: MetricMap;
             histograms: HistogramList; }
    fn render() -> String;                          // Prometheus text format
}

// factories are FREE FNS (methods may not return loci — m90):
fn counter(reg: Registry, name: String, labels: Labels) -> Counter;
fn gauge(reg: Registry, name: String, labels: Labels) -> Gauge;
fn histogram(reg: Registry, name: String,
             buckets: mat::Matrix, labels: Labels) -> Histogram;

locus Counter   { fn inc() -> (); fn add(v: Float) -> (); }
locus Gauge     { fn set(v: Float) -> (); fn inc() -> (); fn dec() -> (); }
locus Histogram { fn observe(v: Float) -> (); }    // closure-guarded monotonicity

locus MetricsEndpoint {                             // std::http::Handler
    params { registry: Registry; }
    fn handle(req: Request) -> Response;
}
```

### Registry (pattern 3 — long-lived service-style locus)

The single per-app metrics hub. Holds two `@form(...)` slots
internally:

- `store: MetricMap` (`@form(hashmap)`) — keyed lookup of every
  counter / gauge / histogram series by composite `name{labels}`
  key.
- `histograms: HistogramList` (`@form(vec)`) — parallel storage
  for bucket bounds + cumulative counts + sum + observation
  count per registered histogram series.

Factories (`metrics::counter`, `metrics::gauge`,
`metrics::histogram` — free fns taking the Registry as first
arg) idempotently register the series and return a thin handle
locus. Per AGENTS.md's
two-channel rule (`spec/semantics.md § Where each channel
lives`) the handle methods (`Counter.inc`, `Gauge.set`, ...) are
infallible — failures during the `@form(...)`-synthesized
substrate calls are absorbed locally via `or` clauses; they
don't bubble up the structural channel.

### Counter / Gauge / Histogram (pattern-3 handle loci)

Thin handles returned by the factory free fns. Each carries
direct references to the underlying storage slots
(`store: MetricMap`, plus `histograms: HistogramList` for
`Histogram`) and routes every mutation inline. State lives in
those slots; the handles themselves are stateless modulo their
addressing fields. The factories are free fns (not Registry
methods) because hale v0.8.2's m90 / CQRS rule forbids locus
methods from returning locus values — see `FRICTION.log`.

### Histogram structural invariant

The `Histogram` locus declares an inline closure invariant:

```hale
closure buckets_monotonic {
    captures: out_of_order;
    epoch inline;
}
```

After each `observe(v)`, the locus recomputes
`out_of_order = count of cumulative-bucket pairs where
counts[i+1] < counts[i]` and `violate buckets_monotonic;`s if
the count is non-zero. The substrate's cumulative-increment
shape (`observe` only bumps; never decrements) keeps the
invariant trivially true under normal use; the closure is the
audit-channel guarantee that no future code path violates it
without surfacing in the parent's `on_failure(c, err)`. Per
`spec/styleguide.md § 7. Error-check fn pattern` the captures
clause names `out_of_order` so the `ClosureViolation` payload
routed to the parent carries the violating count.

### Labels constructors

The labels-constructor vocabulary is bare free fns matching
CONTRACTS.md. (Pre-A3 / hale `f9068fa` this lived on a
`Lab` namespace lotus as a workaround for the cross-seed
non-fallible free-fn call gap; that lotus was deleted in pond
pass D3.)

```hale
let labels = metrics::labels_one("method", "GET");
```

## Example

```hale
import "vendor/pond/metrics" as metrics;
import "vendor/pond/math/matrix" as mat;

fn drive(reg: metrics::Registry) {
    let hits = metrics::counter(reg, "http_requests_total",
        metrics::labels_one("method", "GET"));
    let mem  = metrics::gauge(reg, "process_resident_memory_bytes",
        metrics::labels_empty());
    let dur  = metrics::histogram(reg,
        "http_request_duration_seconds",
        mat::from_rows(1, 4, "0.005, 0.05, 0.5, 1.0"),
        metrics::labels_one("method", "GET")
    );

    hits.inc();
    hits.add(2.0);
    mem.set(120000000.0);
    dur.observe(0.012);
    dur.observe(0.4);

    println(reg.render());
    // # TYPE myapp_http_requests_total counter
    // myapp_http_requests_total{method="GET"} 3
    // # TYPE myapp_process_resident_memory_bytes gauge
    // myapp_process_resident_memory_bytes 120000000
    // # TYPE myapp_http_request_duration_seconds histogram
    // myapp_http_request_duration_seconds_bucket{method="GET",le="0.005"} 0
    // myapp_http_request_duration_seconds_bucket{method="GET",le="0.05"} 1
    // myapp_http_request_duration_seconds_bucket{method="GET",le="0.5"} 2
    // myapp_http_request_duration_seconds_bucket{method="GET",le="1"} 2
    // myapp_http_request_duration_seconds_bucket{method="GET",le="+Inf"} 2
    // myapp_http_request_duration_seconds_sum{method="GET"} 0.412
    // myapp_http_request_duration_seconds_count{method="GET"} 2
}

fn main() {
    let store = metrics::MetricMap { };
    let hl    = metrics::HistogramList { };
    let reg   = metrics::Registry {
        namespace: "myapp", store: store, histograms: hl
    };
    drive(reg);

    // Serve /metrics over HTTP:
    // std::http::Server {
    //     port: 9090,
    //     handler: metrics::MetricsEndpoint { registry: reg }
    // };
}
```

## Files

Seven per-concern files (re-split 2026-06-12 after the
upstream cross-file pass-A registration fix; the consolidated
`metrics.hl` is retired — see `FRICTION.log`):

- `types.hl` — `Labels`, `MetricEntry`, `HistogramData` shapes.
- `storage.hl` — `MetricMap` (`@form(hashmap, sync =
  serialized)`) + `HistogramList` (`@form(vec)`).
- `labels.hl` — `labels_*` constructors + `metric_key`.
- `helpers.hl` — label-token + Prometheus-rendering free fns (histogram bucket storage is bounded[T; N] since 2026-07-04; the CSV accessors are gone).
- `registry.hl` — the `Registry` locus (`render()`).
- `handles.hl` — `counter` / `gauge` / `histogram` factory
  free fns + `Counter` / `Gauge` / `Histogram` handle loci.
- `endpoint.hl` — `MetricsEndpoint` (`std::http::Handler`).
- `examples/exposition-demo/main.hl` — registers counter +
  gauge + histogram, mutates them, renders, asserts the body
  contains the expected Prometheus-format lines.

## Verification

```bash
hale check pond/metrics/                 # ok: 7 file(s) typechecked
hale build \
    pond/metrics/examples/exposition-demo/
pond/metrics/examples/exposition-demo/exposition-demo
```

Expected: a dump of the rendered Prometheus body followed by
`exposition-demo: all format checks passed`.

Building the lib alone (`hale build pond/metrics/`) fails
with "program has no `fn main()`" per the v1 single-binary
seed model — use `hale check` for lib-level verification.
