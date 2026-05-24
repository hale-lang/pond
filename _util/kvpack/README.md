# pond/_util/kvpack — tab-separated key=value walker

Suggested alias: `kv`.

Consolidates the `get_value` / `set_value` lookup pattern on a
`k1=v1\tk2=v2\t...` packed String that several pond libs converged
on for `@form(hashmap)`-friendly cell shapes.

## Surface

```hale
locus KvPack {
    params { }
    fn get(data: String, key: String) -> String;     // "" if absent
    fn set(data: String, key: String, val: String) -> String;  // upsert
    fn has(data: String, key: String) -> Bool;       // present (even if val="")
}
```

## Pre-cleanup consumers

- `pond/sessions/values.hl` — `__get_value`, `__set_value` on
  `Session.data`.
- `pond/router/` — `RouteParams.path_kv` accessors.
- `pond/metrics/` — `Labels.kv` parsing.

The shape operates on plain `String`, so each consumer's user-
facing wrapping type (`Session`, `RouteParams`, `Labels`) stays
private; only the underlying String is passed through.

## Use

```hale
import "vendor/pond/_util/kvpack" as kv;
let k = kv::KvPack { };
let v = k.get(session.data, "user_id");
let session2 = Session { id: session.id, data: k.set(session.data, "role", "admin") };
```

See `examples/smoke/` for the minimal exercising demo.

## v1 codegen limitation

Cannot be imported from inside an existing pond lib that gets
cross-seed-imported by an app (two-hop import, KNOWN_GOTCHAS G34).
End-apps and `_util` libs can consume directly.
