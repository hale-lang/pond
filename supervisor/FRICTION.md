# pond/supervisor — FRICTION

Gaps, suspicions, and deviations from CONTRACTS.md surfaced while
building this lib.

## deviation: ChildSpec.restart → ChildSpec.policy

CONTRACTS.md spells the per-child restart-policy field
`restart: String`. `restart` is a reserved keyword (one of the
recovery primitives — `restart`, `restart_in_place`, `quarantine`,
`reorganize`, `bubble` per `spec/tokens.md` § Recovery primitives)
and is rejected in field-name position by the parser:

```
types.hl:
  52:5: parse error: expected member name, got Restart
```

The field is renamed `policy: String`. The set of legal values is
unchanged (`"permanent"` / `"transient"` / `"temporary"`).

**Spec ask:** allow recovery-primitive keywords post-`.` and in
field-decl position (same F.10-style narrowing the mode keywords
already use; spec/design-rationale.md § F.10 names the precedent).
Recovery primitives are only meaningful at statement position via
the `recovery_stmt` production — they have no business clashing
with struct-field identifiers.

## deviation: add_child(spec, child: LocusRef) → add_child(spec, child_name: String)

`LocusRef` is not a user-typeable parameter in Hale v1 — it's the
internal C-ABI shape for the single-pointer locus value the
runtime threads through `self.children` iteration, the `c`
parameter of `on_failure(c, err)`, and the `c` argument to recovery
ops (`restart(c)` / `quarantine(c)`). No user-level type spells
"any locus, opaquely"; the grammar's type-expression production
admits only concrete locus names, interface names, primitives, and
built-in containers.

Two consequences:

1. **The contract's `add_child(spec: ChildSpec, child: LocusRef)`
   cannot be written verbatim.** The lib renames the second
   parameter to `child_name: String` and threads only the name
   through the spec table; the actual child registration happens
   via the substrate-level `accept(c: Worker)` path.

2. **The supervisor needs a `spawn_worker(...)` companion method**
   (added as a non-contract API) because a Worker literal sitting
   in *consumer* code wouldn't be a child of the Supervisor — per
   `spec/semantics.md` § "Locus instantiation", a child only
   attaches to the parent whose lifecycle method body contains
   the literal. `spawn_worker(name, kind, payload, fail_on_birth)`
   instantiates Worker inside the supervisor's own method body,
   so `accept(c: Worker)` fires on the supervisor.

**Spec ask:** an `AnyLocus` / `LocusHandle` / `LocusRef` type
visible at user level that admits any locus pointer, with the
caveat that no methods are callable on it (it's only meaningful
as a recovery-op target). Would let the contract's `add_child`
signature compile as-written. Adjacent need: `accept(c: Interface)`
or `accept<T>(c: T)` for multi-type supervision children — without
it, supervisors are restricted to a single concrete Worker shape.

## deviation: ChildSpec field cannot also be named `restart`

(Same root as the first deviation — listed separately because
agents searching for "restart" in this doc will land here.)

## gap: rest_for_one + one_for_all degraded to one_for_one

The natural body for `rest_for_one` is:

```hale
// In on_failure(c: Worker, err: ClosureViolation):
let fail_order = c.birth_order;
for sib in self.children {
    if sib.birth_order >= fail_order {
        restart(sib);
    }
}
```

…and for `one_for_all`:

```hale
for sib in self.children {
    restart(sib);
}
```

Two blockers prevent both:

1. **Cross-locus field write from `accept()`.** The supervisor
   wants to assign `c.birth_order = self.children_seen;` in
   `accept(c: Worker)` so rest_for_one can compute "later
   siblings." Codegen rejects:

   ```
   codegen error: unsupported in codegen v0: non-self field/index
                  assignment target
   ```

   `accept` runs before the child's region is allocated (per F.7);
   the substrate ought to permit writing through `c.field` because
   the child hasn't yet committed any state, but v0 codegen treats
   any non-`self.X` assignment as an error.

2. **`restart(sib)` where sib is bound by a `for` over
   `self.children`** is untested in the v1 fixture set. Spec says
   self.children is "typed iterable" of the child type (F.11),
   and recovery primitives accept that child type as the `c` arg.
   The combination should work but isn't exercised by any
   `crates/hale-codegen/tests/fixtures/examples/*/main.hl`, so
   the lib doesn't claim it.

Both strategy branches in `supervisor.hl` log a "degraded — see
FRICTION.md" line and fall through to one_for_one's
single-child restart. The strategies remain selectable so consumer
code that already specifies `kind: "one_for_all"` continues to
compile and route through on_failure — the strategy just behaves
like one_for_one until the language fills in.

**Spec ask:** confirm or document that the cross-locus field write
from `accept` (specifically: a slot mutation on the child BEFORE
its birth() runs, when the supervisor wants to seed a per-child
field) is supportable; ship a fixture that uses
`for sib in self.children { restart(sib); }` so libraries can
depend on the combination.

## gap: `violate` rejected in lifecycle method bodies (codegen)

`spec/semantics.md` § "Inline closure violation" → § "Rejection
contexts" explicitly lists lifecycle methods (`birth()`,
`dissolve()`, `drain()`) as allowed sites for `violate`. v0
codegen disagrees:

```
codegen error: unsupported in codegen v0: `violate` outside a user fn
```

Worker's `birth()` wanted to fire `violate failed;` directly when
`fail_on_birth` was true. Workaround: factor the violate into a
member fn (`fail_now()`) and call it from birth. The observable
behavior is identical (last_error set, violate fires, drain
requested, on_failure routes to parent) but the styleguide-shape
"violate inside the lifecycle body" is unrepresentable.

**Spec ask:** align codegen with the documented allowance, OR
update spec/semantics.md to list lifecycle bodies in the rejection
contexts.

## gap: `-> ()` on locus methods triggers codegen tuple-arity error

Reproduced the existing pond/KNOWN_GOTCHAS.md G2 ("`-> () fallible(E)`
codegens an error") with a non-fallible variant: `fn foo(...) -> ()
{ ... }` on a locus method fails with

```
codegen error: unsupported in codegen v0: tuple type must have at
least 2 elements; got 0
```

Identical to the G2 workaround: omit the `-> ()` clause. The lib's
methods (`add_child`, `spawn_worker`, `fail`, `fail_now`,
`route_by_strategy`) all drop the explicit unit return. CONTRACTS.md
spells some signatures with `-> ()` (e.g. `fn add_child(spec, child:
LocusRef) -> ();`); the lib's signatures match the contract's
arg-shape but elide the unit return.

**Spec ask:** extend G2's fix (whatever codegen change closes the
fallible variant) to the non-fallible variant too. Both should
codegen to a void return without tripping the tuple-arity check.

## gap: `return` rejected inside `on_failure` / lifecycle bodies

`on_failure` and lifecycle methods (`birth`, `run`, `dissolve`,
`drain`, `accept`) reject `return value;` and `return;`:

```
codegen error: unsupported in codegen v0: `return` outside a user fn
```

This is the documented "lifecycle bodies reject return" rule from
`spec/styleguide.md § Current language gaps`, but on_failure isn't
called out by name there. The rule extends: short-circuit
"absorb this case" branches inside on_failure cannot use `return;`
to early-out; they have to chain through `if/else if` ladders or
factor into a helper fn.

The supervisor's `on_failure(c, err)` body uses a two-level
if/else ladder and dispatches the strategy switch to a helper fn
`route_by_strategy(c, err)`. The helper IS a regular `fn` so it
could use early `return;`, but the dispatch is uniformly
divergent (`restart()` / `bubble()` are `Never`-typed) so no
explicit return is needed.

**Spec ask:** add `on_failure` to the styleguide's
"lifecycle bodies reject return" enumeration so the surprise lands
on agents at brief-read time, not at first-build time.

## design-question: Worker as the single supervised child type

The supervisor's `accept(c: Worker)` is restricted to one concrete
locus type per F.11 "single-accept-type only." Real Erlang
supervisors hold heterogeneous children. The library punts:
applications specialize the supervisor by branching on
`Worker.kind` inside `run()`, or by spawning a sibling locus that
subscribes to a per-kind bus topic.

Two alternatives worth flagging if a workload pushes back:

1. **Per-app supervisor subclass.** Each app writes its own
   supervisor locus that mirrors this lib's `on_failure` body but
   declares `accept(c: ItsOwnChildType)`. This lib's
   `supervisor.hl` is then more template than library. Honest but
   defeats the "library you import" framing.

2. **Multi-accept syntax** (`accept(c: A) { ... } accept(c: B) {
   ... }`) — listed as deferred in F.11. Until it ships, the
   single-Worker-type shape is the only one that compiles.

Sticking with single-Worker-type for v1.

## design-question: max_restarts intensity counter persists across windows

When the supervisor's restart-intensity check opens a fresh window
(no window open OR previous window has elapsed), the lib resets
`restart_count` to 1 and stamps `window_start_ns` to now. Erlang
OTP's MaxR/MaxT semantics match: each new MaxT-bounded window is
independent.

What's NOT modeled: a "soft" sliding window (where the count
decays as old failures age out rather than resetting all at once).
That's a richer Erlang OTP variant from later releases and
deferred until a workload distinguishes the two.

## design-question: `transient` policy equals `permanent` under v1

`ChildSpec.policy = "transient"` says "restart only on abnormal
exit." In Hale v1 the supervisor's `on_failure` ONLY runs on
ClosureViolation (a clean collapse never invokes the handler per
F.11). So every on_failure entry is by definition an abnormal
exit, and `"transient"` reduces to `"permanent"`.

The branch is documented in `supervisor.hl`'s on_failure body and
the README's ChildSpec.policy table. When Hale adds a clean-
exit failure type (or routes normal dissolve through on_failure
under some opt-in flag), the transient branch will diverge.

## blocked-on-language: birth_order field unused

`Worker.params.birth_order` exists in the type but is never set by
the supervisor (the cross-locus field write from accept() is
blocked — see "rest_for_one + one_for_all degraded" above). The
field is left in place so:

1. The captures clause shape `closure failed { captures: name,
   last_error; }` documents the eventual field set.
2. The day the cross-locus write becomes legal, the supervisor's
   `accept(c: Worker) { c.birth_order = self.children_seen; ... }`
   can flip without churning the Worker's param shape.

Worker instances see `birth_order = 0` for every child today.
