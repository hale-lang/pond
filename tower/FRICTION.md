# pond/tower — FRICTION

v1 friction notes. Each entry: what hit, where it shows up,
what we did to ship around it, and what would close the gap.

## v1-cross-seed-method-arg-coerce-missing

**Hit:** A user-declared locus method with an `Interface`-typed
parameter doesn't coerce a `LocusRef` argument to the interface
at the call site.

```hale
locus Holder {
    fn use(t: Tower) { println(t.name()); }   // Tower is an interface
}
let r = Router { name: "x" };
let h = Holder { };
h.use(r);
// codegen error: unsupported in codegen v0:
//   Holder.use arg 0 type mismatch:
//   expected Interface("Tower"), got LocusRef("Router")
```

The synthesized `@form(vec).push` / `.set` DO coerce (A10 / G20
landed). The gap is specifically user-declared locus method arg
sites. Free fn arg sites work — locus → interface coercion
fires at `coerce_to_interface` via the standard F.20 Phase B
path.

**Worked around by:** Surfacing every public registry operation
that takes a `Tower` arg as a *free fn* over `Registry`, not a
locus method. Pond house style for fallible accessors (see
`pond/jobs::{enqueue, dequeue, ack}`) already does this; we
adopt the same convention for non-fallible Tower-arg ops.

**Closes when:** Codegen extends `lower_user_method_call`'s
arg-prep to apply `coerce_to_interface` on `LocusRef → Interface`
mismatches the same way `lower_user_fn_call` does. Same A10
extension, different lowering site.

## v1-cross-seed-fail-payload-not-mangled

**Hit:** A bare struct/locus type name appearing as the head of
a literal under a `fail` statement or `or fail` clause inside an
imported library's body is not rewritten by the cross-seed
mangler. The typechecker then reports "unknown type" for the
unmangled name.

```hale
// inside vendor/pond/tower/registry.hl
fn lookup(...) -> Tower fallible(RegistryError) {
    let t = r.get(i) or fail RegistryError { kind: "bug" };  // <-- rejected
    fail RegistryError { kind: "not_found" };                 // <-- rejected
}
// 50:1: type error: unknown type `RegistryError` in struct/locus literal
```

The first attempted workaround (extract to a helper:
`or fail err_bug(name)`) hit the same gap one level deeper —
the bare fn call under `or fail` also doesn't resolve:

```
codegen error: unsupported in codegen v0:
  call to `err_bug`: no free fn / generic fn / fn-pointer
  binding with that name is in scope
```

So both struct-literal type-name resolution and bare-fn-call
name resolution are missing under `fail` / `or fail` positions
when the lib is cross-seed-imported. Single-file form works
fine — the lib's typecheck-in-isolation passes; the failure is
specifically at the merged-program typecheck after the cross-
seed import + mangle pass.

**Worked around by:** Restricting the v1 cross-seed-importable
API to *non-fallible* operations only. `lookup` becomes
`find_or(r, name, fallback: Tower)` — caller supplies an
explicit fallback Tower value, no `fail`/`or fail` involved.
The `has` predicate covers branch-first-then-look-up uses.
`RegistryError` is elided from v1 entirely.

**Closes when:** The cross-seed mangler's `mangle_with_renames`
walk visits expressions under `Stmt::Fail(expr)` and
`OrClause::Fail(expr)` the same way it visits expressions under
`Return` / `Let` / `Assign`. Likely a single missing match arm.

## v1-cross-seed-struct-field-interface-coerce

**Hit:** A struct/locus literal field declared as an interface
type doesn't accept a concrete locus argument at the literal
init site.

```hale
type TowerEntry { name: String; t: Tower; }
let r = Router { name: "x" };
TowerEntry { name: "x", t: r }
// codegen error: unsupported in codegen v0:
//   type `TowerEntry` field `t` type mismatch:
//   declared Interface("Tower"), got LocusRef("Router")
```

Same shape as the method-arg gap above; struct-literal field
init is another `LocusRef → Interface` coercion site that
isn't wired.

**Worked around by:** Holding towers in `@form(vec) of Tower`
directly rather than a wrapper struct with a Tower-typed
field. The synthesized `push` (A10) is the only entry point
that coerces, and we route every add through it. Doesn't bite
in the v1 surface because there's no public TowerEntry type.

**Closes when:** Codegen extends struct-literal field-init
lowering to apply `coerce_to_interface` on interface-typed
fields receiving LocusRef args. Same A10 extension as the
method-arg case.

## binary-name-equals-seed-file-not-dir

**Hit:** `hale build <dir>/` produces a binary whose name is
the first `.hl` file's stem (e.g. `main`), not the directory
basename (e.g. `multi-tower-demo`).

We expected `./multi-tower-demo` per the F.19 doc comment
("directory's basename becomes the binary name"); got `./main`.

**Worked around by:** Running `./main` instead. Documentation
update opportunity for spec/projects.md if this is the actual
shipped behavior.

**Closes when:** Either codegen flips to use the dir basename
(matches docs), or the docs flip to acknowledge the file stem
behavior. Either way is fine; current friction is the doc/impl
mismatch, not the binary name itself.
