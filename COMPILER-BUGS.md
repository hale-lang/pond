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

**Nine open bugs.** Entries 3–9 were found on 2026-09-24 while building
`realtime/nats`, against `hale 0.21.0`, and each carries its own
commit. Entries 1–2 are unchanged since they were filed at `3c05dad`. The
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
| 3 | SIGTERM does not drain: a pinned `while !self.draining` loop never sees it, and the process dies with 143 | medium | runtime vs spec |
| 4 | A child passed into its parent's literal from `fn main` is not routed to the parent's `on_failure` (hale#1035) | medium | runtime |
| 5 | A self field alternating between a heap value and an empty one never retires the heap value (hale#1033) | medium | memory |
| 6 | A bound bus adapter's subscriptions run on the publishing thread, not the adapter's own (hale#1032) | medium | runtime |
| 7 | `@form(vec)` `pop` never frees a String/Bytes cell, and `set` never frees replaced Bytes (hale#1037) | medium | memory |
| 8 | Use-after-free at exit: a collapsed child with a `@form(vec)` is reclaimed twice after violating in an adapter-relayed handler (hale#1036) | **high** | memory safety |
| 9 | Publishing a topic bound to an adapter leaks the encoded payload in the publisher's region (hale#1038) | medium | memory |

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

## 3. SIGTERM does not drain: a pinned loop never sees `self.draining` — medium

Found 2026-09-24 against `hale 0.21.0`, `hale-lang/hale` @ `bb0a2c55`,
release build.

`spec/semantics.md` § "Drain cascade (whole-process)": on SIGINT or
SIGTERM the root drains, depth-first, leaves first, and the process
exits 0; a draining locus reads `self.draining` as true. A pinned child
whose `run()` loops on `!self.draining` is the canonical shape that
relies on it.

### Repro

```hale
locus Loop {
    run() {
        let mut i = 0;
        while !self.draining { if i % 10 == 0 { println("child tick " + to_string(i)); } std::time::sleep(100ms); i = i + 1; }
        println("child run sees drain");
    }
    dissolve() { println("child dissolve"); }
}

main locus App {
    params { l: Loop = Loop { }; }
    placement { l: pinned; }
    run() { std::time::sleep(1200ms); println("app run ends"); }
}

fn main() { App { }; }
```

Run it, and send SIGTERM after a second:
`./pin & p=$!; sleep 1.5; kill -TERM $p; wait $p; echo $?`

- **Expected:** `child run sees drain`, `child dissolve`, exit 0.
- **Observed:** the ticks stop, neither line prints, exit 143 (killed
  by the signal). Without a signal the program never exits: the main
  locus's `run()` ends and the process waits on the pinned loop.

### Impact in this repo

`realtime/nats`'s receive loop is `NatsConn.run()`, a pinned child with
this shape: it cannot be ended gracefully, so publishes the server has
not yet acknowledged are lost at SIGTERM. Its `run_for_ms` bound is how
tests and the example end it (`FRICTION.log § pond/realtime/nats`).

## 4. A child passed into its parent's literal from `fn main` is not routed to the parent's `on_failure` — medium

Found 2026-09-24 against `hale 0.21.0` @ `6a866b9a`; filed as
hale-lang/hale#1035.

### Repro

```hale
locus Boom {
    params { why: String = ""; }
    closure fuse { captures: why; epoch inline; }
    fn check() { self.why = "lit"; violate fuse; }
    @unbounded
    run() { let mut i = 0; while i < 50 { std::time::sleep(10ms); if i == 10 { self.check(); } i = i + 1; } }
}
main locus App {
    params { b: Boom = Boom { }; seen: String = ""; }
    placement { b: pinned; }
    on_failure(c: Boom, err: ClosureViolation) { self.seen = err.closure + " " + c.why; }
    run() { std::time::sleep(400ms); println("seen=[" + self.seen + "]"); }
}
fn main() { App { b: Boom { why: "x" } }; }
```

- **Expected:** `seen=[fuse lit]`, which is what `fn main() { App { }; }` prints.
- **Observed:** `runtime error: ClosureViolation: locus `Boom` closure
  `fuse` (inline, no parent handler)`.

### Impact in this repo

`realtime/nats`'s delivery audit collapses `NatsConn` to its owner. A
program that builds the conn in `main()` (to hand it a URL from the
environment) loses that supervision; build it in the owner's param
default instead (`tests/adapter_audit_live_test.hl`).

## 5. A self field alternating between a heap value and an empty one never retires the heap value — medium

Found 2026-09-24 against `hale 0.21.0` @ `6a866b9a`; filed as
hale-lang/hale#1033.

### Repro

```hale
locus H {
    params { s: String = ""; }
    fn heap() { self.s = std::str::upper("hello"); }
    fn empty() { self.s = ""; }
}
fn main() {
    let h = H { };
    let mut i = 0;
    while i < 1000000 { h.heap(); h.empty(); i = i + 1; }
}
```

- **Expected:** flat memory, as with `h.heap(); h.heap();` (4.5 MB).
- **Observed:** 35.7 MB VmRSS at the end, about 32 bytes kept per cycle.
  "Empty" includes any literal and a zero-length heap slice; `Bytes`
  fields and fields of a struct-typed field behave the same.

### Impact in this repo

`realtime/nats`'s framer writes only the fields each frame's op
defines, so a PING does not blank the subject a MSG left. What remains
is a message whose reply subject or payload is empty between ones where
it is not: each such alternation keeps one value until the connection
ends.

## 6. A bound bus adapter's subscriptions run on the publishing thread, not the adapter's own — medium

Found 2026-09-24 against `hale 0.21.0` @ `bb0a2c55`; filed, with its
repro, as hale-lang/hale#1032. A bound adapter's `run()` runs on a
thread of its own, but a handler it subscribes runs synchronously on
whichever thread published, while an ordinary pinned child's handlers
run on the child's thread.

### Impact in this repo

`realtime/nats` cannot keep the socket inside the adapter: every
publisher's thread would write it. The adapter is split in two, with
`NatsAdapter` (bound) handing messages to `NatsConn` (pinned) over an
internal topic. They fold back into one when this closes.

## 7. `@form(vec)` `pop` never frees a String/Bytes cell, and `set` never frees replaced Bytes — medium

Found 2026-09-24 against `hale 0.21.0` @ `6a866b9a`; filed as
hale-lang/hale#1037.

### Repro

```hale
type B1 { b: Bytes = b""; }
@form(vec) locus VB { capacity { heap items of B1; } }
@form(vec) locus VStr { capacity { heap items of String; } }
locus H {
    params { vb: VB = VB { }; vstr: VStr = VStr { }; }
    fn set_b(x: Bytes) { if self.vb.len() == 0 { self.vb.push(B1 { b: x }); } self.vb.set(0, B1 { b: x }) or discard; }
    fn pp_str(x: String) { self.vstr.push(x); let g = self.vstr.pop() or ""; }
}
fn main() {
    let h = H { };
    let x = std::str::upper("some string of forty characters or so...");
    let b = std::bytes::from_string(x);
    let mut i = 0;
    while i < 300000 { h.set_b(b); h.pp_str(x); i = i + 1; }
}
```

- **Expected:** flat memory, as with an `Int` vec or a String-only
  struct under `set`.
- **Observed:** about 47 bytes kept per Bytes `set`, and about 40 per
  String push+pop (62 for a struct with a String field).

### Impact in this repo

`realtime/nats` keeps queued messages in `NatsMsgLog` (`log.hl`), one
reused BytesBuilder with Int vecs beside it, because a vec of
`Outbound` used as a queue grew by one payload per message.

## 8. Use-after-free at exit: a collapsed child with a `@form(vec)` is reclaimed twice — **high**

Found 2026-09-24 against `hale 0.21.0` @ `6a866b9a`; filed as
hale-lang/hale#1036.

### Repro

```hale
type Note { n: Int = 0; }
type Wire { subject: String = ""; data: Bytes = b""; }
topic Lost { payload: Note; subject: "lost"; }
topic Q { payload: Wire; subject: "q"; }
locus Fwd {
    bus { publish Q; }
    fn send(subject: String, bytes: Bytes) { Q <- Wire { subject: subject, data: bytes }; }
}
@form(vec)
locus Ints { capacity { heap items of Int; } }
locus Child {
    params { why: String = ""; v: Ints = Ints { }; }
    bus { subscribe Q as on_q; }
    closure fuse { captures: why; epoch inline; }
    fn on_q(w: Wire) { self.why = "got " + w.subject; violate fuse; }
}
main locus App {
    params { c: Child = Child { }; seen: String = ""; }
    bindings { Lost: Fwd { }; }
    bus { publish Lost; }
    on_failure(c: Child, err: ClosureViolation) { self.seen = err.closure + " " + c.why; }
    run() { Lost <- Note { n: 1 }; std::time::sleep(20ms); println("seen=[" + self.seen + "]"); }
}
fn main() { App { }; }
```

`LOTUS_ASAN=1 hale build` it and run.

- **Expected:** `seen=[fuse got lost]`, clean exit.
- **Observed:** `seen=[fuse got lost]`, then AddressSanitizer
  heap-use-after-free in `lotus_vec_destroy` at exit (freed earlier by
  `__reclaim_Child`'s `lotus_arena_destroy`). Without ASan the pond
  version crashes with SIGSEGV. Clean without the vec child, without
  the adapter hop, or with `placement { c: pinned; }`.

### Impact in this repo

`NatsFake` collapses to its owner when its audit fails.
`tests/fake_audit_test.hl` places it `pinned`, and `fake.hl` says so.

## 9. Publishing a topic bound to an adapter leaks the encoded payload — medium

Found 2026-09-24 against `hale 0.21.0` @ `6a866b9a`; filed as
hale-lang/hale#1038.

### Repro

```hale
type Note { n: Int = 0; text: String = ""; }
topic Out { payload: Note; subject: "out"; }
locus Sink { fn send(subject: String, bytes: Bytes) { } }
main locus App {
    bindings { Out: Sink { }; }
    bus { publish Out; }
    @unbounded
    run() {
        let mut i = 0;
        while i < 500000 { Out <- Note { n: i, text: "fixed payload text" }; i = i + 1; }
    }
}
fn main() { App { }; }
```

- **Expected:** flat memory, as with the `bindings` line removed
  (4.7 MB).
- **Observed:** 28.5 MB, about 47 bytes kept per publish.

### Impact in this repo

A program publishing through `realtime/nats` grows by this much per
message on the publisher's side. Once it is subtracted, the NATS
connection itself stays flat over 100k messages each way (the soak is
described in `realtime/nats/README.md`).

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
