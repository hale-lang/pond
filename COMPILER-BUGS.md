# Compiler bugs found by pond

Actionable defects only — every entry below is reproduced against a
current compiler, with a self-contained program, an expected result,
and an observed result. Nothing here is a design note, a triage
record, or a workaround log; that material lives in `FRICTION.log`.

**Compiler under test:** `hale 0.16.0`, `hale-lang/hale` @ `37914e5`
(2026-08-12), release build.
**Last-known-good reference:** `hale 0.13.0` @ `16b227e`.
**Date of this pass:** 2026-08-12 (third pass — both entries below
re-run verbatim against `37914e5` and **both still reproduce**).

Every repro is a complete seed: drop `main.hl` into a directory and
run `hale build <dir>/ && <dir>/<dir>`. No imports, no stdlib beyond
`println` / `to_string`.

**Two open bugs**, unchanged since they were filed at `3c05dad`. The
six reported in the first pass are fixed and re-verified; see the tail
of this file. What remains is one surviving shape of the same GH #402
regression `3c05dad` targeted, plus a lint escape hatch that does not
work.

> **Note for whoever picks these up.** The 20-commit batch between
> `3c05dad` and `37914e5` did not touch either one, and neither is
> mentioned in `CHANGELOG.md` — so this is a re-report, not a
> regression. Pond is otherwise fully green on `37914e5` with no
> source changes: 30/30 seeds check clean, 49/49 tests, 38/38 examples
> build and run. That batch's own handler-signature soundness fix
> records being "verified against the full downstream corpus (pond,
> native suites) with zero false positives" — confirmed here
> independently.

| # | Bug | Severity | Kind |
|---|-----|----------|------|
| 1 | A `let`-bound locus forwarded through a call and returned is reclaimed early | **high** | regression (v0.16.0), partially fixed by `3c05dad` |
| 2 | The hot-path allocation advisory ignores the `@unbounded` it tells you to use | medium | lint / diagnostic |

---

## 1. A `let`-bound locus forwarded through a call and returned is reclaimed early — **high**

The last surviving shape of the v0.16.0 GH #402 temporary-reclaim
regression. `3c05dad` fixed rebinding (`a = …`) and the direct
`return <binding>` path; this is the **forwarding** path.

When a `let`-bound locus is passed as an argument to a free fn that
**returns that same locus**, and the caller returns the result, the
binding's frame-scoped dissolve still runs — so the value is reclaimed
even though it escaped through the return. The caller receives a locus
whose `capacity` heap buffer is gone, with its `params` intact, so the
type still looks correct and every element read silently fails.

Same silent-wrong-answer signature as the original report: no crash,
exit 0.

### Repro

```hale
@form(vec)
locus Buf {
    params { n: Int; }
    capacity { heap data of Float; }
}

fn make(n: Int, seed: Float) -> Buf {
    let b = Buf { n: n };
    let mut i = 0;
    while i < n { b.push(seed); i = i + 1; }
    return b;
}

fn passthru(a: Buf) -> Buf { return a; }

// works: the argument is an unbound temporary
fn via_temp(n: Int) -> Buf { return passthru(make(n, 1.0)); }

// broken: the argument is let-bound
fn via_let(n: Int) -> Buf {
    let x = make(n, 2.0);
    return passthru(x);
}

fn show(l: String, b: Buf) {
    println(l, " len=", to_string(b.len()), " [0]=", to_string(b.get(0) or -999.0));
}

fn main() {
    show("via_temp", via_temp(3));
    show("via_let ", via_let(3));
}
```

**Expected** (and what `hale 0.13.0` prints):

```
via_temp len=3 [0]=1
via_let  len=3 [0]=2
```

**Observed at `3c05dad` and again at `37914e5`:**

```
via_temp len=3 [0]=1
via_let  len=0 [0]=-999
```

### Discriminator matrix

One program, `Buf` / `make` / `passthru` as above; `Pair` is a
params-only locus with no `capacity` block.

| # | shape | v0.13.0 | `3c05dad` |
|---|---|---|---|
| 1 | unbound temp as arg, callee returns it, caller returns result | ok | ok |
| 2 | **`let`-bound as arg, callee returns it, caller returns result** | ok | **empty** |
| 3 | `let`-bound as arg, callee returns a *different* locus | ok | ok |
| 4 | `let`-bound as arg, callee's result read locally, not returned | ok | ok |
| 5 | `let`-bound as arg to a **locus method** callee | ok | ok |
| 6 | `let`-bound returned directly, no callee (`return x;`) | ok | ok |
| 7 | plain locus (no `capacity` block) through shape 2 | ok | ok |
| 8 | as 2, but the binding is also read before the call | ok | **empty** |

Reading the matrix:

- **Rows 2 and 8 are the bug**; everything else is correct.
- **Row 3 is the discriminator.** The same `let`-bound argument is
  fine when the callee returns something else, so the defect is
  specifically the escape path — the callee handing its own argument
  back out to the caller's caller.
- **Row 6 is what `3c05dad` fixed.** `return x;` suppresses the
  binding's reclamation; `return f(x);` does not, even though the
  value escapes identically.
- **Row 5 narrows it to free-fn callees.** A locus-method callee is
  already correct.
- **Row 7 confirms a `capacity` block is required**, which is what
  makes the loss invisible in the type.

`3c05dad`'s rule set decides the owner for a `let` RHS, a `return`
expression, and an `=` into a locus-typed slot. A binding **passed as
an argument** is none of those: its dissolve slot is still frame
scoped, and no rule notices that the callee's return type re-exports
it. Rule 2 of that commit — "a binding on either side of a bare-local
`=` is disqualified from frame-scoped reclamation" — is the shape that
applies; it just doesn't reach arguments that flow out through a
return.

### Impact in this repo

None currently: pond is fully green at `3c05dad` (30/30 seeds check
clean, 49/49 tests pass, all 38 examples build and run). This was
found by probing rather than by a failing lib. It is filed because it
is a **silent** wrong answer in the same family that produced last
pass's critical bug, and the natural spelling of an accumulate-and-
forward helper walks straight into it.

---

## 2. The hot-path allocation advisory ignores the `@unbounded` it tells you to use — medium

The `hot-path allocation` advisory ends with:

> …or acknowledge an intentional shape with `@unbounded` on the
> enclosing fn/hook.

`@unbounded` on the enclosing fn does not suppress it. The sibling
`unbounded allocation` advisory, whose message offers the same escape
hatch, *is* suppressed — so the two classes disagree about whether the
annotation means anything.

This matters because `@unbounded` is the documented path to adopting
`hale verify` (which fails on any finding) as a CI gate. A finding
that cannot be acknowledged blocks that gate with no recourse other
than `--no-warn-unbounded-alloc`, which disables the whole analysis.

### Repro

```hale
@form(vec)
locus Buf {
    params { n: Int; }
    capacity { heap data of Float; }
}

fn make(n: Int) -> Buf {
    let b = Buf { n: n };
    b.push(1.0);
    return b;
}

// CLASS A — "unbounded allocation" (vec-insert in a loop).
// @unbounded IS honored: silent.
@unbounded
fn fill(n: Int) -> Buf {
    let b = Buf { n: n };
    let mut i = 0;
    while i < n { b.push(0.0); i = i + 1; }
    return b;
}

// CLASS B — "hot-path allocation" (let-bound factory call in a loop).
// @unbounded is NOT honored: still warns.
@unbounded
fn loops(rounds: Int) -> Int {
    let mut total = 0;
    let mut k = 0;
    while k < rounds {
        let b = make(3);
        total = total + b.len();
        k = k + 1;
    }
    return total;
}

fn main() {
    println("fill=", to_string(fill(3).len()), " loops=", to_string(loops(3)));
}
```

**Expected:** both fns silent — each carries the acknowledgment its
own advisory names.
**Observed at `3c05dad` and again at `37914e5`:** `fill` is silent; `loops` still emits
`warning: hot-path allocation: `make` returns the locus `Buf` …`.

### Where it is

`crates/hale-types/src/check.rs`, the `Stmt::Let` arm of
`hot_walk_expr` (~line 1751). The emit is guarded only by
`cx.loop_depth > 0 || cx.in_handler` plus a `hot_factory_locus`
match — there is no consultation of an `@unbounded` flag anywhere on
that path, while the message it emits (~line 1771) promises one.
Either the guard should honour the annotation, or the message should
stop offering it.

### Impact in this repo

This is the **only** thing standing between pond and a clean
allocation-advisory run. A triage pass took the repo from 78
advisories to 18 by acknowledging 60 of them across 29 enclosing fns.
All 18 survivors are this class — `ml/neural/model.hl` (15, in
`train_step`/`forward`), `pq/pool.hl` (2), `http/client/wire.hl` (1) —
and **every one already carries a correct `@unbounded`**. They go
silent the moment the lint honours it; no downstream change is
pending. Until then `hale verify` (any-finding-fails) cannot be
adopted as a CI gate.

---

## Verified fixed by `3c05dad` — do not re-report

All six from the first pass, re-run against `3c05dad` with the exact
programs published then:

1. **Free-fn locus rebinding hands out reclaimed memory** — the
   rebinding shapes are fixed. `rebind(false)`/`rebind(true)` now
   return `len=3` with the right elements, and the local-only variant
   exits 0 instead of SIGTRAP. Full discriminator matrix re-run: 16 of
   16 shapes correct, including the loop, `if`, ident-rebind,
   rebind-to-literal, method-frame and plain-locus rows. *(The
   forwarding shape above is the one residue.)*
2. **Block-tail return** — `fn double(n: Int) -> Int { let d = n * 2; d }`
   builds and prints `double(4)=8`.
3. **Sibling-file `topic`** — `hale check` is now clean on the
   three-file seed, and the program still builds and prints
   `got ping n=1`. check and build agree.
4. **`err` in an `or fail E { … }` payload** — compiles; ok path `1`,
   fail path `-1`.
5. **`-> ()` on a non-fallible locus method** — compiles; `n=2`.
6. **`or <substitute>` LocusRef→Interface for `@form` methods** —
   `list.get(5) or NoopTool { }` compiles and yields `noop`.

Also confirmed still fixed from the prior pass: GH #375
(factory-after-caught-failure segfault) and GH #381 (zero-reads).

`ml/neural` is back to full correctness with **no source change** —
the `xor-trainer` demo trains to the same `loss=0.000264721` and now
gets the truth table right (`f(0,1) = 0.983393`, `f(1,0) = 0.983591`),
where before every prediction read `0`.
