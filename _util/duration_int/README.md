# pond/_util/duration_int — Duration → Int conversion

Suggested alias: `durint`.

Consolidates the `to_string(Duration) → strip "ns" → parse_int`
pattern that duplicates across every pond lib that needs to
stash an elapsed Duration in an Int field.

## Surface

```hale
locus DurationInt {
    params { }
    fn to_ns(d: Duration) -> Int;         // strip "ns" suffix + parse
    fn to_seconds(d: Duration) -> Int;    // to_ns / 1_000_000_000
    fn now_ns() -> Int;                   // monotonic clock as Int ns
    fn now_seconds() -> Int;              // monotonic clock as Int seconds
}
```

## Pre-cleanup consumers

- `pond/tracing/tracer.hl::__duration_to_int`
- `pond/sessions/clock.hl::__ns_to_seconds` + `__now_seconds`
- `pond/supervisor/supervisor.hl::__mono_seconds`
- `downstream-consumer/library-d.hl::__mono_seconds`

## Use

```hale
import "vendor/pond/_util/duration_int" as durint;
let di = durint::DurationInt { };
let now = di.now_seconds();
let elapsed_ns = di.to_ns(std::time::monotonic());
```

See `examples/smoke/` for the minimal exercising demo.

## v1 codegen limitation

Cannot be imported from inside an existing pond lib that gets
cross-seed-imported by an app (two-hop import, KNOWN_GOTCHAS G34).
End-apps and `_util` libs can consume directly.
