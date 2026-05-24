# pond/_util — shared utility libs (Tier 0 internals)

Small, single-file pond libs that consolidate duplicate helpers
surfaced across the main pond tier libs during the cleanup pass.

Every util is:

- A single `.hl` source (G28 — multi-file libs break cross-seed
  import).
- A namespace lotus (G11 — cross-seed non-fallible free fns don't
  lower in expression position; namespace-lotus methods do).
- Operating on **primitives only** (Int / Float / Decimal /
  Duration / String / Bytes). No exotic types in fn signatures
  (G18 — qualified cross-seed types don't survive two-hop import).

## Available utils

| Path | Surface | Consolidates |
|------|---------|--------------|
| `intfloat/` | `IntFloat.to_float(n: Int) -> Float`, `IntFloat.from_float(f: Float) -> Int` | `int_to_float` ASCII-roundtrip helper (KNOWN_GOTCHAS G30) |
| `decimal_float/` | `DecimalFloat.to_float(d: Decimal) -> Float`, `DecimalFloat.from_float(f: Float) -> Decimal`, `DecimalFloat.abs(d: Decimal) -> Decimal` | The `decimal_to_float` / `float_to_decimal` bridge duplicated across downstream-consumer, downstream-consumer, downstream-consumer, downstream-consumer (KNOWN_GOTCHAS G26) |
| `duration_int/` | `DurationInt.to_ns(d: Duration) -> Int`, `DurationInt.to_seconds(d: Duration) -> Int`, `DurationInt.now_ns() -> Int`, `DurationInt.now_seconds() -> Int` | The `__duration_to_int` / `__mono_seconds` / `__ns_to_seconds` helpers in tracing, sessions, supervisor, downstream-consumer |
| `kvpack/` | `KvPack.get(data: String, key: String) -> String`, `KvPack.set(data, key, val) -> String`, `KvPack.has(data, key) -> Bool` | The tab-separated `k1=v1\tk2=v2\t...` walker pattern in sessions, router::RouteParams, metrics::Labels |
| `rowbuf/` | `RowBuf.nth_field(row, n) -> String`, `RowBuf.row_count(buf) -> Int`, `RowBuf.nth_row(buf, idx) -> String`, `RowBuf.remove_row(buf, target_first_field) -> String` | The `__nth_field` / `__row_field` / `__remove_row` family in tracing, migrations, jobs |

## Consumer model

```hale
import "vendor/pond/_util/decimal_float" as decf;
import "vendor/pond/_util/duration_int" as durint;

fn main() {
    let df = decf::DecimalFloat { };
    let di = durint::DurationInt { };
    let p_f = df.to_float(170.25d);
    let now = di.now_seconds();
    // ...
}
```

## Codegen limitation (KNOWN_GOTCHAS G34)

The `_util` libs are intended for direct consumption by
**applications** (and other `_util` libs). They are **NOT usable
from inside existing pond tier libs** at v1 because of a codegen
breakage along the two-hop import chain `app -> pond/lib ->
pond/_util/lib`. The lib import itself succeeds, but
`util_alias::SomeNamespace { }` literals inside the intermediate
lib's body fail at codegen time with:

```
codegen error: unsupported in codegen v0:
  qualified-name struct literal `util_alias::Type` in expression position
```

(The smoke tests under each util prove direct consumption works;
the cleanup pass also produced minimal repros of the two-hop
failure mode.)

So the existing pond libs keep their local copies for now and
flag the duplication in their FRICTION.md files; new apps and
new pond libs that are NOT meant to be cross-seed-imported can
use these utils freely. When the codegen gap closes, the
existing copies can collapse to imports of these surfaces
mechanically.

## Adding a new util

1. Make `pond/_util/<name>/<name>.hl` with a `<NamespaceName>`
   namespace lotus (params `{ }`, methods only).
2. Add `pond/_util/<name>/README.md`.
3. Add `pond/_util/<name>/examples/smoke/main.hl` that builds
   under `hale build .` and exercises every method.
4. List in the table above.
5. Update `pond/CONTRACTS.md` "Tier 0 internals" section.
