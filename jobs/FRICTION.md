# pond/jobs — friction log

Gaps, suspicions, deviations encountered building pond/jobs/.
Per pond/README.md § Design rules: contract deviations get
logged here and reflected back in CONTRACTS.md.

## 1. BLOCKED (transitive): pond/sqlite

pond/jobs uses pond/sqlite (`db::Db`, `db::exec`, `db::query_one`,
`db::ExecResult`, `db::Row`, `db::DbError`). pond/sqlite is
itself BLOCKED on a stdlib sqlite primitive — every db::* call
today returns `fail DbError { kind: "unsupported", ... }`. The
chain:

- queue.hl `Queue.birth()` → `db::exec(conn, "CREATE TABLE …")`
  → stub fails; we addresses with `or db::ExecResult { }` so
  birth doesn't escalate.
- query.hl's four free fns (`enqueue` / `dequeue` / `ack` /
  `fail`) → call `db::exec` / `db::query_one` → stub fails;
  bridge fns repackage as `JobError { kind: "db", detail:
  "unsupported" }`.
- pool.hl Worker.run() `__run_real` branch → calls `dequeue(q)`
  → always sees JobError.kind="db" → loops on the empty/idle
  path until `max_jobs` is reached. **Real job processing
  never happens in stub mode.**

**Workaround in this lib**: `Pool.params.simulate: Bool = false`.
When the consumer sets it `true`, workers skip `dequeue` and
synthesize a Job per iteration so the handler still fires. The
demo (`examples/email-worker/`) uses this. The switch goes away
when pond/sqlite unblocks.

## 2. Deviation: Locus methods can't declare `fallible(E)`

**CONTRACTS.md sketches:**

```hale
locus Queue {
    params { db: Db; table: String = "pond_jobs"; }
    fn enqueue(...) -> Int fallible(JobError);
    fn dequeue() -> Job fallible(JobError);
    fn ack(id) -> () fallible(JobError);
    fn fail(id, retry) -> () fallible(JobError);
}
```

**Reality (spec/semantics.md § "Where each channel lives"):**
user-declared locus methods may not declare `fallible(E)` — that
channel is reserved for free fns and @form-synthesized methods.
The two-channel rule keeps recovery legible: structural failures
flow through closures + `on_failure`; value errors flow through
`fallible(E)`.

**As built (legal):**

```hale
locus Queue { params { … }; birth(); dissolve(); }
fn enqueue(q: Queue, …) -> Int fallible(JobError);
fn dequeue(q: Queue)    -> Job fallible(JobError);
fn ack(q: Queue, id)    -> () fallible(JobError);
fn fail(q: Queue, id, r) -> () fallible(JobError);
```

Same translation pond/sqlite did (`db::exec(conn, sql)` vs
`conn.exec(sql)`). **Proposed CONTRACTS.md amendment**: move
the four queue methods to free fns to match the type-legal shape
that's actually built.

**duplicate-suspected**: this is exactly the same pattern
pond/sqlite already logged. pond/migrations will hit it too. A
catalog-level resolution (e.g., the CONTRACTS.md style guide
notes "every fallible operation is a free fn, by rule") would
prevent the per-lib relitigation.

## 3. Deviation: Locus refs can't sit in another locus's params

**CONTRACTS.md sketches:**

```hale
locus Queue { params { db: Db; … } }
locus Pool  { params { queue: Queue; … } }
```

**Reality**: I couldn't find direct spec text forbidding this
for params, but:

- spec/types.md § F.20 Phase B explicitly says interface values
  can't sit in struct fields, which is the closest documented
  case.
- spec/semantics.md § "Slot restrictions" says slot element type
  must be a value-shape, not a LocusRef (rationale: loci have
  lifecycle; storing a LocusRef would orphan the lifecycle
  when the holder dissolves).
- a future store pattern's `SqliteStore` already takes `db_path: String`
  rather than `db: Db` — the precedent points the same way.

I treated the lifecycle-orphaning rationale as decisive and
followed the same pattern:

- `Queue.params.db: Db` → `Queue.params.db_path: String`
- `Pool.params.queue: Queue` → `Pool.params.db_path` +
  `Pool.params.table` (the queue identity)

The downstream consequence: each Worker reconstitutes a Queue
locally inside its run() loop (`let q = Queue { db_path:…,
table:… };`). Queue.birth() is idempotent (CREATE TABLE IF NOT
EXISTS), so the reconstitution is wasteful-but-correct.

**Proposed CONTRACTS.md amendment**: same as 2 — surface the
primitive-identity shape rather than the locus-ref shape, with a
forward-compatibility note for when locus refs can sit in
fields.

**duplicate-suspected**: pond/migrations (`Runner.params.db: Db`)
will hit this. pond/metrics (`MetricsEndpoint.params.registry:
Registry`) will hit this. pond/agent/conversation similar. A
catalog-level note in the styleguide would short-circuit the
investigation for the next consumer.

## ~~4. Deviation: Interface values can't sit in locus params/fields~~

**closed 2026-05-18** by F.20 Phase B interface storage landing
in upstream (G20). Interface values are now legal in locus
params/fields. The fn-pointer workaround in `pool.hl`
(`handler: fn(Job) -> JobResult = default_handler`) can collapse
back to the contract surface — see "Source-level cleanup
pending" near the top of this file (TBD). Original entry retained
below for context.

**CONTRACTS.md sketches:**

```hale
locus Pool { params { …; handler: JobHandler; } }
```

**Reality (spec/types.md § F.20 Phase B, 2026-05-11):**
> Returning an interface value from a fn, storing one in a locus
> param/field, or putting interfaces in arrays/tuples is not yet
> supported — deep-copy across arena boundaries for the fat
> pointer is a Phase B follow-up.

**As built**: `handler: fn(Job) -> JobResult = default_handler`.
The `interface JobHandler` declaration stays in `interfaces.hl`
as forward-compat scaffolding (mirrors pond/router/'s `Handler`
/ `Middleware` interface decls used purely for the v1.next
swap-in).

**duplicate-suspected**: pond/router/ already hit this exact
pattern with `Route.handler` and `MwEntry.before`/`after`. Three
consumers running into it is the catalog signal — see
pond/router/'s FRICTION.md for the same entry.

**Source-level cleanup pending (G20 follow-up).** With Phase B
landed, `Pool.params.handler: JobHandler = default_handler`
becomes legal; the fn-pointer field collapses to the interface.
Affects `pool.hl` only — `interfaces.hl`'s `JobHandler` decl is
already real (it just wasn't reachable from storage before).
The cleanup is gated on the broader question of whether
`pond/jobs` keeps the sqlite-stub shape (the lib stays STUB
until sqlite unblocks per the pond plan) — once the
implementation pass lands, the handler flip rides along.

## 5. Stub-mode worker shape

Workers are pinned (per the assignment brief and spec/runtime.md
§ Schedule classes — work that shouldn't share a scheduler with
cooperative siblings). Pinned-class constraints:

- Pinned loci cannot declare `accept()` (spec/runtime.md § m28b
  gating: "children of pinned would need cross-thread
  cascade-dissolve coordination").
- Pinned loci cannot declare closures (spec/runtime.md § m28b
  gating).

Neither constraint costs Worker anything (no children, no
closure-test audit). But it means **Worker has no inline channel
for "stop now"**: the only structured shutdown a pinned locus
gets today is the mailbox-shutdown wire on bus subscribers
(spec/runtime.md § m28b stage 2). Worker doesn't declare `bus`
(no subscribers — it's a polling loop, not event-driven), so
no mailbox exists to signal.

**Workaround**: `Worker.params.max_jobs: Int = 0`. Worker runs
a bounded loop; when `max_jobs > 0` it exits after that many
handler invocations. Pool's dissolve cascade pthread_joins each
worker after its run() returns. This is the only structured-exit
shape that works today.

**Future**: when Pool grows a "stop" bus topic (or a pinned-
locus pull-stop primitive lands), Worker can drop the bounded
shape in favor of `loop until stop_signal`. The contract surface
doesn't change.

## 6. Deviation: Job has no `id` field (CONTRACTS.md)

The contract spells Job as:

```hale
type Job { kind: String; payload: String; attempt: Int; max_attempts: Int; }
```

No `id`. But the queue methods take `job_id: Int`:

```hale
fn ack(job_id: Int) -> () fallible(JobError);
fn fail(job_id: Int, retry: Bool) -> () fallible(JobError);
```

Where does the worker get `job_id` from? CONTRACTS.md leaves
this implicit. As built I parse the id internally (`__ParsedRow.id`
in query.hl) but the public dequeue() returns a Job without an
id, so the worker's `__run_real` body can't issue ack/fail
correctly today.

**Workaround**: the demo never reaches this code path because of
issue 1 (the stub returns "empty"), but it's still a latent gap.

**Proposed CONTRACTS.md amendment**: surface the id on Job
(simplest), or split into `Job` (public) + `ClaimedJob { id: Int;
job: Job }` (dequeue return). I lean simplest: add `id: Int = 0`
to Job.

## 7. duplicate-suspected: `__bridge_db_*` error-wrappers

query.hl has two near-identical bridge fns
(`__bridge_db_exec`, `__bridge_db_row`) whose only difference is
the success-channel return type. Every consumer of pond/sqlite
(this lib, pond/migrations, (another lib)) will write
the same pair (or extend it for `db::Rows` etc.).

A stdlib utility like
`fn wrap_db<T>(e: DbError, kind: String) -> T fallible(MyError)`
would collapse the boilerplate, but pond can't write it today
(no generics over the payload type — `<T: MyError>` constraint
form isn't in scope per spec/types.md § Generics). A pond-level
namespace lotus (`pond/db_err/` or similar) with one bridge fn
per common success type might be the pre-generics interim.

## 8. duplicate-suspected: Pool's on_failure restart-loop

Pool.on_failure (`restart(w)`) is exactly what `pond/supervisor`
will offer as the `one_for_one` strategy. Once supervisor ships,
Pool could vendor it instead of open-coding the call. Logged so
the cleanup pass picks it up.

## 9. SQL string-building (no `db::bind_*` available)

Once pond/sqlite + the codegen gap (item 11) unblock, the
query.hl bodies will use string-concatenation + a `__sql_escape`
helper for value interpolation:

```hale
let stmt = "INSERT INTO " + q.table
    + " (kind, payload, …) VALUES ('"
    + __sql_escape(kind) + "', '"
    + __sql_escape(payload) + "', …)";
```

This is the wrong shape long-term — bind parameters are why
prepare/bind exists — but pond/sqlite's `bind_text` / `bind_int`
are stubbed, so we can't take the parameterized path. When the
upstream stack unblocks, migrate the four bodies to
`prepare → bind_text/bind_int → step → finalize` and delete the
escape helper. Signatures don't change.

## 10. Empty-body language gap

Several lifecycle methods on Pool / Worker have placeholder
`let _ = self.workers;` lines because empty bodies parse-fail
(spec/styleguide.md § Current language gaps). The placeholders
read awkwardly; nothing actionable, just noting per the friction-
log contract.

## 11. **HARD BLOCKER**: codegen v0 rejects qualified type names + qualified struct literals reachable from any binary

The original implementation of `query.hl` had real calls into
pond/sqlite (e.g. `let conn = db::Db { path: q.db_path };` +
`let r = db::exec(conn, stmt) or __bridge_db_exec(err.kind,
err.detail);`). Those compile and typecheck fine but **codegen
v0 refuses to lower them**:

- Qualified type names in fn signatures
  (`fn __bridge(e: db::DbError)` or `-> db::ExecResult`):
    `codegen error: unsupported in codegen v0: qualified type
     `db::DbError` not in stdlib path-renames table`
- Qualified struct literals in expression position
  (`db::Db { path: ... }`):
    `codegen error: unsupported in codegen v0: qualified-name
     struct literal `db::Db` in expression position`

Both fire when an example or app builds the library bundle —
pure-library typecheck passes. Same gap a future store pattern hit; same
gap pond/sqlite hit (which is why pond/sqlite's `bind_*` /
`finalize` ended up as locus methods on `Db` returning Int).

**Workaround taken in this lib**: every `query.hl` body that
would call `db::*` is stubbed to fail directly with
`JobError { kind: "unsupported", ... }`. The schema-bringup in
`__schema_up` is stubbed to a no-op. The `import "../sqlite" as
db;` declaration stays so the surface stays consistent with the
post-unblock implementation.

When the path-renames table grows to cover user libraries (or
some other resolution unfreezes qualified-name access in
codegen), the stubs replace with the documented post-unblock
shapes one-for-one — see the `// Once unblocked the body:`
comment block at every stub site in `query.hl` and `queue.hl`.

This is the **single most impactful friction in the chain**: it
prevents the otherwise straightforward "stub pond/sqlite,
implement everything above honestly against the stubs" approach
from working end-to-end. pond/jobs's body is a layer thinner
than it would otherwise be, almost entirely because of this.

## 12. Codegen v0 rejects `-> () fallible(E)` return type

Original `ack` / `fail_job` signatures (matching CONTRACTS.md):

```hale
fn ack(q: Queue, job_id: Int) -> () fallible(JobError);
fn fail(q: Queue, job_id: Int, retry: Bool) -> () fallible(JobError);
```

Codegen v0:
    `unsupported in codegen v0: tuple type must have at least 2
     elements; got 0`

The fallible-return calling convention needs a non-unit success
slot. As built both return `Bool` (always `true` on success,
divergent on failure). Same workaround a future store pattern's `sqlite_put`
uses (returns `Int` rows-affected). Callers can `or false` to
discard.

**Proposed CONTRACTS.md amendment**: spell ack / fail_job with
a non-unit return that carries a useful signal. `Bool` works;
`Int` (rows_affected, matching the underlying SQL UPDATE) is
arguably more useful.

## 13. `fail` keyword vs `fn fail()` shadowing

CONTRACTS.md spells the dead-letter/retry method as `fail(id,
retry)`. Inside a body named `fn fail(...)` we'd want
`fail JobError { kind: "not_found" }` on the row-not-found
branch — and `fail` there is both the keyword and (potentially)
a recursive self-call. The parser distinguishes them by syntax,
but the readability cost is real and a build-time mistake (typo
that flips the path) would be silent.

As built the public fn is `fail_job` (not `fail`). The example
calls `jobs::fail_job(q, id, true)`. **Proposed CONTRACTS.md
amendment**: rename `fail(id, retry)` → `fail_job(id, retry)`
to avoid the keyword shadow.

## 14a. The brief's verification cmd (`hale build pond/jobs/`) fails for any library

The assignment brief lists:

```bash
hale build \
    pond/jobs/
```

as the verification. That fails with `codegen error: program
has no `fn main()`` — same as every other pond lib (sqlite,
http/client, ...), because `hale build` requires a main fn
and libraries don't have one.

**Workaround**: use `hale check` for the library, `hale
build` for the example:

```bash
hale check pond/jobs/
hale build pond/jobs/examples/email-worker/
```

Both succeed today. Documented in README.md § Verification.

## 14. Pinned-worker shutdown signal is missing

Worker is pinned. There's no built-in way today for a parent
(Pool) to tell a worker "exit now" other than:

- Worker subscribes to a bus topic; Pool publishes a shutdown
  payload; the mailbox-shutdown wire (spec/runtime.md § m28b
  stage 2) handles the wakeup. **But**: Worker doesn't declare
  `bus` today — its loop is polling, not event-driven. Adding
  `bus { subscribe Shutdown as on_shutdown; }` would add a
  per-worker mailbox plus the cross-thread handler routing for
  one bit of "stop" signal, which feels like overkill.
- Worker reads a parent-set field. Cross-thread reads on a
  parent's field are racy without a fence; spec doesn't bless
  this shape.
- Worker exits after a bounded number of iterations (the
  workaround taken — `Worker.max_jobs > 0`).

**Future**: when a pinned-locus pull-stop primitive lands (or
when the mailbox infrastructure picks up a "shutdown bus subject"
sugar that doesn't require declaring a full subscribe), Worker's
loop can drop the bounded shape in favor of `loop until
stop_signal`. The contract surface doesn't change.
