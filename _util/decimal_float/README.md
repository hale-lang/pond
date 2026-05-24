# pond/_util/decimal_float — Decimal ↔ Float bridge

Suggested alias: `decf`.

Consolidates the `decimal_to_float` / `float_to_decimal`
representation bridge that duplicates across every numeric pond
lib mixing Decimal money fields with Float math. See KNOWN_GOTCHAS
G26.

## Surface

```hale
locus DecimalFloat {
    params { }
    fn to_float(d: Decimal) -> Float;       // ASCII roundtrip
    fn from_float(f: Float) -> Decimal;     // coarse 0.001-step staircase
    fn abs(d: Decimal) -> Decimal;          // |d| via subtract-from-zero
}
```

## Caveats (inherited from the originals)

- `to_float` round-trips through ASCII; fine for matrix emission,
  lossy at the full Decimal precision.
- `from_float` uses a coarse 0.001-step staircase for the
  fractional part (3 decimal places). Acceptable for the wire-
  format payloads the original sites used.

## Pre-cleanup consumers

- `downstream-consumer/library-a.hl` — `decimal_to_float`
  (matrix emission in `bulk` mode) and `float_to_decimal`
  (`parse_decimal_field` wire-format).
- `downstream-consumer/harness.hl` — `float_to_decimal`.
- `downstream-consumer/library-b.hl` — `decimal_to_float`.
- `downstream-consumer/feed.hl` — `float_to_decimal`.
- `downstream-consumer/library-d.hl` — `float_to_decimal_qty` and
  related `decimal_abs_add` shape.

## Use

```hale
import "vendor/pond/_util/decimal_float" as decf;
let df = decf::DecimalFloat { };
let f = df.to_float(170.25d);
let d = df.from_float(170.25);
```

See `examples/smoke/` for the minimal exercising demo.

## v1 codegen limitation

Cannot be imported from inside an existing pond lib that gets
cross-seed-imported by an app (two-hop import, KNOWN_GOTCHAS G34).
End-apps and `_util` libs can consume directly.
