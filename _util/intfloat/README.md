# pond/_util/intfloat — Int ↔ Float bridge

Suggested alias: `intf`.

Consolidates the `int_to_float(n: Int) -> Float` helper that
every pond lib mixing Int counters with Float math has had to
write locally because v1's Int→Float widening is under-implemented
(KNOWN_GOTCHAS G30).

## Surface

```hale
locus IntFloat {
    params { }
    fn to_float(n: Int) -> Float;     // ASCII roundtrip
    fn from_float(f: Float) -> Int;   // truncating toward zero
}
```

## Pre-cleanup consumers

- `pond/ml/neural/model.hl::int_to_float` — exact same body.
- (Several downstream consumers implicitly via `Int(g)` casts and ad-hoc
  `let x: Float = i;` workarounds.)

## Use

```hale
import "vendor/pond/_util/intfloat" as intf;
let ifx = intf::IntFloat { };
let f = ifx.to_float(42);
```

See `examples/smoke/` for the minimal exercising demo.
