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

## Two-hop import status — G34 CLOSED (2026-06-12)

The two-hop codegen break (KNOWN_GOTCHAS G34) that kept pond
tier libs from importing `_util` libs is closed upstream (WS3.4,
2026-06-11) and re-verified in pond on 2026-06-12: an
`app -> lib -> _util` chain using a qualified `alias::Lotus { }`
literal in expression position inside the intermediate lib
builds and runs clean. End-apps, `_util` libs, and pond tier
libs can all consume this lib directly. Tier libs still carrying
local copies of these helpers collapse them in their own cleanup
passes (tracked per-lib in FRICTION.log).
