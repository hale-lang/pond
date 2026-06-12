# pond/_util/rowbuf — tab+newline row buffer iteration

Suggested alias: `rb`.

Consolidates the `__nth_field` / `__row_field` / `__remove_row`
family of helpers for iterating a `\n`-delimited block where each
row carries tab-separated fields. The `Rows.csv` stdlib shape
and several pond libs use this representation.

## Surface

```hale
locus RowBuf {
    params { }
    fn nth_field(row: String, n: Int) -> String;     // strips trailing \n
    fn row_count(buf: String) -> Int;                // \n-delimited
    fn nth_row(buf: String, idx: Int) -> String;
    fn remove_row(buf: String, target_first_field: String) -> String;
}
```

## Pre-cleanup consumers

- `pond/tracing/tracer.hl::__nth_field`, `__remove_row`,
  `__find_open_row`.
- `pond/tracing/examples/trace-tree/main.hl::__row_field`.
- `pond/migrations/` — rowbuf iteration helpers.
- `pond/jobs/` — Queue scan helpers (`__find_open_row`-family).

## Use

```hale
import "vendor/pond/_util/rowbuf" as rb;
let rows = rb::RowBuf { };
let count = rows.row_count(buf);
let mut i = 0;
while i < count {
    let row = rows.nth_row(buf, i);
    let id  = rows.nth_field(row, 0);
    // ...
    i = i + 1;
}
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
