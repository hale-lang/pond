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

## Two-hop import status — G34 CLOSED (2026-06-12)

The two-hop codegen break (KNOWN_GOTCHAS G34) that kept pond
tier libs from importing `_util` libs is closed upstream (WS3.4,
2026-06-11) and re-verified in pond on 2026-06-12: an
`app -> lib -> _util` chain using a qualified `kv::KvPack { }`
literal in expression position inside the intermediate lib
builds and runs clean (this lib was the probe's far hop).
End-apps, `_util` libs, and pond tier libs can all consume this
lib directly. Tier libs still carrying local copies of these
helpers collapse them in their own cleanup passes (tracked
per-lib in FRICTION.log).
