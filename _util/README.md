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

## Codegen limitation (KNOWN_GOTCHAS G34) — CLOSED (2026-06-12)

**Historical:** at v1 the `_util` libs were NOT usable from
inside pond tier libs — the two-hop import chain `app ->
pond/lib -> pond/_util/lib` typechecked, but
`util_alias::SomeNamespace { }` literals inside the intermediate
lib failed at codegen with `unsupported in codegen v0:
qualified-name struct literal in expression position`.

**Closed:** upstream WS3.4 (2026-06-11) fixed qualified
struct/locus literals in expression and return position inside
an intermediate lib, single- and multi-file. Re-verified in pond
on 2026-06-12 at upstream 43300e5 with a two-hop probe: an app
importing a middle lib that imports the real
`pond/_util/kvpack` (plus `pond/term`) and constructs
`kv::KvPack { }` / `term::Styler { profile: 3 }` in expression
position — builds and runs clean, output correct
(`a=1\tb=2`, bold SGR wrap).

So tier libs CAN now import `_util` libs. The existing tier
libs' local helper copies have NOT yet been migrated — each
lib's FRICTION.log flags its duplication, and the collapse
happens in that lib's own cleanup pass, not here. Note the
re-export barrier still holds by design: an app that wants to
name a `_util` type must import that `_util` lib itself.

## Adding a new util

1. Make `pond/_util/<name>/<name>.hl` with a `<NamespaceName>`
   namespace lotus (params `{ }`, methods only).
2. Add `pond/_util/<name>/README.md`.
3. Add `pond/_util/<name>/examples/smoke/main.hl` that builds
   under `hale build .` and exercises every method.
4. List in the table above.
5. Update `pond/CONTRACTS.md` "Tier 0 internals" section.
