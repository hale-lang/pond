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
