# pond/jobs — SQLite-backed background job queue

Suggested import alias: **`jobs`**

```hale
import "vendor/pond/jobs"   as jobs;
import "vendor/pond/sqlite" as sqlite;   // jobs' backing store — vendor it too
```

## Status (2026-06-12): WORKING — real queue over the real pond/sqlite driver

The stub era is over. pond/sqlite is a real `@ffi` SQLite driver,
and this lib's queue ops run real SQL: enqueue inserts a row
(with bind parameters), dequeue claims the oldest ready row with
a raced-update check, ack/fail drive the row state machine, and
the Pool/Worker pair drains the queue through a user handler.
`examples/email-worker/` round-trips 11 real jobs end-to-end.

## Surface (as built)

Matches CONTRACTS.md § pond/jobs, with one shape deviation —
`Job.id` (see FRICTION.log item 6) — and two additive Pool params
(item 5).

```hale
type Job       { id: Int; kind: String; payload: String;
                 attempt: Int; max_attempts: Int; }   // id: deviation, see below
type JobResult { ok: Bool; detail: String; }
type JobError  { kind: String; detail: String; }      // "empty" | "db" | "not_found"

interface JobHandler {
    fn invoke(j: Job) -> JobResult;
}

locus Queue {                              // sqlite-backed
    params { db: sqlite::Db; table: String = "pond_jobs"; }
    fn enqueue(kind: String, payload: String, max_attempts: Int) -> Int fallible(JobError);
    fn dequeue() -> Job fallible(JobError);            // empty → fail kind="empty"
    fn ack(job_id: Int) -> () fallible(JobError);
    fn fail(job_id: Int, retry: Bool) -> () fallible(JobError);
}

locus Pool {                               // worker pool
    params {
        queue: Queue;
        workers: Int = 4;
        handler: JobHandler;
        max_jobs_per_worker: Int = 0;      // additive: bounded-exit shape
        exit_on_empty: Bool = false;       // additive: batch-exit shape
    }
    birth() { /* spawn workers */ }
    drain() { /* finish in-flight */ }
}
```

Call shape:

```hale
let conn = sqlite::Db { path: "/tmp/app.db" };   // caller owns the connection
let q    = jobs::Queue { db: conn };             // birth() runs CREATE TABLE IF NOT EXISTS

let id = q.enqueue("send_email", "to=a@example.com", 3) or self.handle(err);

locus EmailHandler {
    params { delivered: Int = 0; }
    fn invoke(j: jobs::Job) -> jobs::JobResult { ... }   // satisfies JobHandler
}

jobs::Pool { queue: q, workers: 2, handler: EmailHandler { }, exit_on_empty: true };
```

### Semantics worth knowing

- **`Job.id`** is the queue row id, stamped by `dequeue()` so the
  worker can `ack(j.id)` / `fail(j.id, retry)`. CONTRACTS.md omits
  it (its own ack/fail surface is uncallable without it) — the
  amendment is proposed in FRICTION.log item 6.
- **Row state machine** — `ready` → (dequeue) → `in_flight` →
  (ack) → `done`, or (fail retry=true) → `ready` with
  `attempt + 1`, or (fail retry=false) → `failed` (dead-letter;
  the row stays for audit). Workers compute
  `retry = attempt + 1 < max_attempts`.
- **Claim race** — dequeue's UPDATE carries `AND state = 'ready'`;
  losing the race rescans (bounded at 100) instead of surfacing an
  error.
- **Queue.birth() can't be fallible** (lifecycle): a schema
  bringup failure stamps an internal `schema_error` and every op
  fails `kind="db"` until fixed — the same first-call reporting
  pattern pond/sqlite uses for open failures.
- **Worker exit** — there is no parent→worker stop signal yet
  (FRICTION.log item 14). Bound the loop with
  `max_jobs_per_worker > 0` and/or `exit_on_empty: true`
  (batch shape); defaults poll forever (daemon shape).
- **Payload caveat** — `kind` must not contain tab/newline;
  `payload` may contain tabs (it's parsed as the row remainder)
  but not newlines.
- **Reentrancy** — the old stash-bridge caveat is gone (hale
  400ac68 allows fallible `or` handlers; FRICTION.log item 16,
  closed 2026-07-04): queue ops no longer write shared error
  state. The only remaining shared mutable is `schema_error`,
  written once at birth.

## Files

- `types.hl` — `Job`, `JobResult`, `JobError` (pattern 5).
- `interfaces.hl` — `interface JobHandler` (structural, F.20).
- `queue.hl` — the `Queue` service locus: schema bringup + the
  four queue ops (+ fallible DbError→JobError bridge helpers).
- `pool.hl` — `Pool` (cooperative parent) + `Worker` (child
  running the dequeue → invoke → ack/fail loop).
- `examples/email-worker/` — end-to-end demo (below).

## Build & verify

Anything that links pond/sqlite needs libsqlite3 dev headers
(`apt install libsqlite3-dev`; on a host with only the runtime
`.so`, point the toolchain at local shims via `C_INCLUDE_PATH` /
`LIBRARY_PATH`). The end app must import pond/sqlite DIRECTLY —
hale.toml `[ffi]` auto-pickup scans only direct imports, and
pond's no-transitive-deps rule requires the explicit vendor
anyway (verified: an app importing only pond/jobs fails at link
with `undefined reference to lotus_sqlite_...`).

```bash
hale check jobs/                            # typecheck the lib (no main)
hale build jobs/examples/email-worker/      # [ffi] picked up via the demo's direct sqlite import
./jobs/examples/email-worker/email-worker
```

Expected output: 10 `sent: #<id> to=user<n>@example.com` lines,
two `bounce: #11 ...` lines (the poison job, attempt 0 then 1),
then

```
[email-worker] table states: done=10 failed=1 ready=0
[email-worker] OK — 10 delivered + acked, 1 dead-lettered after retry
```

Reruns are idempotent (the demo drops + recreates its table). The
db file (`/tmp/pond-jobs-email-demo.db`) is a normal SQLite
database, readable by any external client.
