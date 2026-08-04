# pond/tracing — span tree mirroring the locus tower

Suggested import alias: **`trace`**

```hale
import "vendor/pond/tracing" as trace;
```

One Tracer per app; spans nest naturally with locus instantiation
(the parent span is the enclosing span). End-of-span fires the
`SpanCompleted` topic; sinks subscribe and project — print as a
tree, batch and export to OTLP, fan out to multiple backends, etc.

## Surface

```hale
type SpanId { id: String; }
type Span   { id: SpanId; parent: SpanId; name: String;
              start_ns: Int; end_ns: Int; attrs: String; }
type TraceError { kind: String; detail: String; }

locus Tracer {
    params { service_name: String = "pond-tracing"; }
    fn start_span(name: String, parent: SpanId) -> SpanId;
    fn end_span(id: SpanId);
    fn add_attr(id: SpanId, key: String, val: String);
    fn export_otlp(endpoint: String) -> () fallible(TraceError);
}

// Topic — declared beside its publisher in tracer.hl
// (co-located while the upstream hale-check divergence is
// open; see the FRICTION log), wire subject
// "trace.span.completed". Subscribers use the qualified ident:
//
//   bus { subscribe trace::SpanCompleted as on_span; }
topic SpanCompleted { payload: Span; subject: "trace.span.completed"; }
```

## Start + end usage

```hale
import "vendor/pond/tracing" as trace;

locus App {
    run() {
        let tr = trace::Tracer { service_name: "my-service" };

        // Root span — parent.id == "" flags it as a root.
        let outer = tr.start_span("request.handle",
                                  trace::SpanId { id: "" });
        tr.add_attr(outer, "http.method", "GET");

        // Nested span — pass `outer` as the parent.
        let inner = tr.start_span("db.query", outer);
        tr.add_attr(inner, "db.statement", "SELECT * FROM widgets");
        tr.end_span(inner);

        tr.end_span(outer);
    }
}
```

The recursive-locus principle says spans naturally nest with
locus instantiation — every span declares the SpanId of the
enclosing scope. v1 requires the user to thread `parent`
explicitly through `start_span`; a future runtime-injection pass
(see `FRICTION.log`) would walk the locus tower at birth /
dissolve and emit start / end_span automatically, dropping the
explicit-parent argument.

## SpanCompleted subscriber

`Tracer.end_span(id)` finalizes the span, publishes a `Span`
record on the wire subject `"trace.span.completed"`, and stashes
the row in an internal export buffer. Downstream subscribers wire
up exactly like any other typed bus subscriber:

```hale
import "vendor/pond/tracing" as trace;

locus TracePrinter {
    bus {
        subscribe trace::SpanCompleted as on_span;
    }

    fn on_span(s: trace::Span) {
        let dur_ns = s.end_ns - s.start_ns;
        println(s.name, "  parent=", s.parent.id,
                "  dur=", to_string(dur_ns), "ns");
    }
}

fn main() {
    // Bus ordering rule (AGENTS.md): subscriber FIRST.
    TracePrinter { };
    // Then the Tracer + producer.
    let tr = trace::Tracer { service_name: "demo" };
    // ... start_span / end_span calls ...
}
```

Multiple subscribers are fine — each gets its own copy of every
`Span`. A JSON-line logger, an OTLP exporter, and an in-process
tree printer can coexist on the same Tracer.

## OTLP export

`end_span` also stashes each completed span in an internal export
buffer; `export_otlp(endpoint)` assembles the buffer into a JSON
batch and POSTs it as `application/json` via the stdlib client
(`std::http::post`, since 2026-08-04; live since 2026-06-12 on
the pond client the stdlib one was promoted from — see
`FRICTION.log`, the "export_otlp doesn't actually POST" entry,
closed).

```hale
tr.export_otlp("http://collector:4318/v1/traces") or handle_export(err);
```

- Success (2xx) clears the export buffer; an empty buffer is a
  no-op success.
- `TraceError { kind: "io" }` — transport failure (the underlying
  `std::http::HttpError` is folded into `detail`); the buffer is
  kept, so a retry re-sends the same batch.
- `TraceError { kind: "non_2xx" }` — the collector answered
  outside 200..299; buffer kept.

The body is a *simplified* OTLP shape (flattened
`{service, spans[]}` with OTLP's per-span field names) —
permissive collectors ingest it; protocol-perfect nesting is a
v1.x followup (see `FRICTION.log` "span counts and trace ids").

**Vendoring:** since 2026-08-04 the transport is the stdlib
client, so `pond/http` is NOT needed — vendor `pond/tracing`
(plus `pond/_util`) alone. (Before that date the lib imported
`../http/client` and consumers had to vendor `pond/http` too.)

## Files

| File | What it holds |
|------|---------------|
| `types.hl`  | `SpanId` + `Span` + `TraceError` shape records. |
| `tracer.hl` | `topic SpanCompleted` decl + `Tracer` locus + `__build_otlp_json` / `__raise_transport` helpers (row/duration helpers live in `pond/_util/{rowbuf,duration_int}`). |
| `examples/trace-tree/main.hl` | Demo: outer span + nested inner span + tree printer subscriber. |

## Catalog placement

- `SpanId`, `Span`, `TraceError` — pattern 5 (shape type).
- `Tracer` — pattern 3 (service locus, bus publisher, long-lived
  state-bearing).
- `__build_otlp_json`, `__raise_transport` — pattern 6 (free fn).
  The former row/duration helpers were lifted into
  `pond/_util/rowbuf` and `pond/_util/duration_int`.

## Verification

```bash
hale build \
    pond/tracing/
```

The library type-checks cleanly. The bare-lib build fails at
codegen with "program has no `fn main()`" (same outcome
`pond/subprocess/`, `pond/http/client/`, `pond/math/stats/` etc.
see — Hale's codegen-v0 doesn't ship a `--lib` mode). The
end-to-end verification path is the example build:

```bash
hale build \
    pond/tracing/examples/trace-tree/

pond/tracing/examples/trace-tree/trace-tree
```

Expected output:

```
--- trace tree (2 spans) ---
* request.handle (<dur>ns) id=1
  * db.query (<dur>ns) id=2
trace-tree: OK
```

Exit code 0; a non-zero exit means a structural failure (count
mismatch, sub-span never observed by the sink, etc.) and the
demo prints a `FAIL:` line before exiting.

## Cross-cutting

- Span timestamps use `std::time::monotonic()` per the assignment.
  Duration is stored as `Int` ns in the public `Span` record (the
  contract type); the lib bridges the Duration → Int gap via
  `pond/_util/duration_int`.
- Two-channel rule (v0.8.1 #24 v0.2): `start_span` / `end_span` /
  `add_attr` are infallible per contract; `export_otlp` carries
  `fallible(TraceError)` directly. The pre-v0.8.1 `last_error_*`
  accessor workaround is retired (`FRICTION.log`, closed
  2026-06-08).
- Six-pattern catalog: the entire lib stays inside patterns 3 / 5
  / 6. No invented categories.
