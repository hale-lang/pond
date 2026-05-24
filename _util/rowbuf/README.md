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

## v1 codegen limitation

Cannot be imported from inside an existing pond lib that gets
cross-seed-imported by an app (two-hop import, KNOWN_GOTCHAS G34).
End-apps and `_util` libs can consume directly.
