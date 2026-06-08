# pond — public surface contracts

This document locks the public API surface of every `pond/` library
so downstream agents can write code against contracts even before
upstream libs are merged. **If you implement a lib, the surface
below is your binding contract. If you consume a lib, the surface
below is what you may import.**

Updates to this document during the build-out must be flagged in
the relevant lib's `FRICTION.md` and recorded as a deviation here.

Suggested import aliases are recommendations only — consumers
choose their own aliases per F.25.

---

## 2026-06-08 status note — up-to-date / idiomatic review pass

A repo-wide review against the current Hale compiler. Every seed now
`hale check`s clean. Changes that affect this document:

- **v0.8.1 fallible(E) migrations DONE.** The "non-fallible method +
  `last_error` accessor + paired fallible free fn" workaround is
  retired in: `http/client` (`Client.{get,post,request}`),
  `sessions` (`SessionStore.read`), `tracing` (`Tracer.export_otlp`,
  now `fallible(TraceError)`, not `IoError`), `agent/llm`
  (`{Anthropic,OpenAi}Client.complete`), `agent/tools`
  (`Registry.dispatch` — the paired free fn collapsed into the
  method), `agent/embeddings` (`Store.{add,search,remove}` — the
  `*_checked` free fns collapsed in), `agent/sandbox`, `ml/neural`
  (`Trainer.fit`, `Model.{forward,train_step,apply_delta}`), and
  `websocket` (`Ws{Client,ServerConn}.{send_*,close}`; blocking
  owner-driven pumps `read_msg`/`handshake`/`open` stay Bool +
  `last_error` so run-loop predicates don't each need an `or`).
- **`logfmt` is EXEMPT, not pending.** Its `FileSink`/`OtlpSink`
  `write`/`line`/`newline` structurally satisfy the **non-fallible**
  `std::text::Sink` interface (there is no `std::log::Sink`), so they
  CANNOT be `fallible(E)` without breaking interface satisfaction.
  They keep the structural channel. The 2026-05-27 note's plan to
  flip logfmt is retracted.
- **CQRS no-locus-return enforced.** `math/matrix`'s factories +
  `transpose` and `metrics`'s `counter`/`gauge`/`histogram` are now
  **free fns** (a method may not return a locus). Surfaces below
  updated. `heron`'s `Parser.parse` is likewise a free fn now.
- **`: schedule` annotation removed (F.31).** `jobs`'s `Worker` and
  the `websocket` echo example dropped it; placement is a consuming
  app's `placement { }` concern.
- **Bus topic decls are file-local.** `bus { publish T; }` / `T <- v`
  only resolve a `topic T` declared in the SAME `.hl` file as the
  publishing locus. Single-publisher libs co-locate the topic
  (`subprocess`, `ml/neural`); the two-publisher `agent/llm` uses
  literal subjects (`"agent.llm.chunk"`) with the topic decls kept
  for the cross-seed subscriber contract.
- **New libs documented below:** `pond/db` (backend-neutral
  `DbDriver` interface), `pond/pq` (Postgres pgwire-v3 driver +
  pool), `pond/websocket` (client + server upgrade). `pond/sqlite`
  query ops and `pond/migrations` (`Migrator`, now on `db::DbDriver`)
  surfaces updated to match source.
- **`pond/tower` removed** — unused, superseded by F.31 `placement`.

---

## 2026-05-27 status note — v0.8.1 closables

Upstream Hale shipped v0.8.1 on the 2026-05-18 → 2026-05-27
window. The release narrows several rules pond was authored
against and adds primitives that retire pond friction. The
contract surfaces below are still the binding declarations; per-lib
FRICTION.md tracks the source-side migration status.

### v0.8.1 ships that affect pond contracts

- **`fallible(E)` on user-declared locus member fns** (open-question
  #24 v0.2, commits `d565d6f` + `98910b9`). The blanket "locus
  methods can't be fallible" rule narrowed to "substrate-facing
  surfaces can't" — lifecycle (`birth` / `run` / `accept` / `drain`
  / `dissolve` / `on_failure`), mode (`bulk` / `harmonic` /
  `resolution`), closure assertions, and bus-subscribed handlers.
  Everything else (user-declared `fn` member fns) carries
  `fallible(E)` with value + heap-bearing payloads and the full `or
  raise` / `or <substitute>` / `or handler(err)` / `or discard`
  disposition surface. See `spec/semantics.md § "Where each channel
  lives"`.
- **`() fallible(E)` lowering** (commit `6beb1be`, FUv0.8.2 #6).
  Unit-return fallible signatures now compile. The pre-`6beb1be`
  workaround of returning `Int` status codes (sqlite F.5, jobs item
  12, migrations item 3) is no longer needed.
- **`@locality(L1|L2|L3|any)` annotation** (F.32-2 v0.2). Per-locus
  cache-tier budget pin against the working-set estimator;
  `--target-cache lN [--strict]` builds gate on it. Pond does not
  currently annotate any loci; opportunistic uptake is per-lib.
- **Bus routing keys** (commits `7a12dc4` → `2dcc51d`). `keyed_by
  FIELD` on topic decls + `where key == EXPR` on bus_subscribe +
  `on_unmatched: swallow|fail|fallback` disposition + synthesized
  `BusUnmatchedKey` type. Replaces fanout-and-filter-in-userspace
  patterns with per-symbol routing.
- **UDP bus transport** (commit `b820c76` + jumbo-aware `dee2342`).
  Unified `udp://addr:port:listen` scheme covering unicast +
  multicast; payloads spill to heap past 512 B with `LOTUS_PAYLOAD_MAX`
  bumped to 64 KB.
- **`std::io::tcp::set_recv_timeout` / `set_send_timeout`** (commit
  `1ab9f71`). Closes pond/websocket's pong-deadline gap.
- **`std::crypto::crc32`** (commit `48f5b5c`). Available for
  frame-level checksums alongside sha256 / hmac.
- **Bus-routed http / tcp observability** (commits `5ca8beb` +
  `4afbc34`). `std::http::Server` and `std::io::tcp::Stream` now
  publish `io.tcp.**` / `io.http.**` `LogEvent`s when given a
  `log_subject`. Pond/tracing + pond/metrics can subscribe to these
  instead of wrapping their own observability layer.

### Newly-closable contract deviations (source migration pending)

> **Superseded by the 2026-06-08 note above** — these migrations are
> DONE (and `logfmt` is exempt, not migrated). Kept for history.

The following libs ship a "non-fallible method + `last_error_*`
accessor + paired fallible free fn" workaround that v0.8.1's
narrowed two-channel rule retires. Source migrations are not yet
performed; FRICTION.md tracks each lib individually. We're going for
clean breaking changes — no transitional shape, the next source pass
flips each lib's methods to `fallible(E)`.

- `pond/http/client/` — `Client.{get, post, request, send_*}` will
  carry `fallible(HttpError)` directly.
- `pond/sessions/` — `SessionStore.read` to `fallible(SessError)`.
- `pond/logfmt/` — `FileSink` / `OtlpSink` `write`/`line`/`newline`
  to `fallible(LogError)`.
- `pond/tracing/` — `Tracer.export_otlp` to `fallible(TraceError)`.
- `pond/agent/llm/` — `AnthropicClient` / `OpenAiClient` request
  methods to `fallible(LlmError)`.
- `pond/agent/tools/` — `Registry.dispatch_call` to
  `fallible(ToolError)`; the parallel free fn `tools::dispatch`
  collapses into the method.
- `pond/agent/sandbox/` — `Sandbox.run_*` to
  `fallible(SandboxError)`; the paired `_at` free fns collapse.
- `pond/agent/embeddings/` — `Store.{add, search, remove}` to
  `fallible(EmbError)`; the `_checked` free-fn pairs collapse.
- `pond/ml/neural/` — `Trainer.forward` / `apply_delta` to
  `fallible(NnError)`.
- `pond/websocket/` — `WsClient.send_*` / `close` to
  `fallible(WsError)`.

### Sqlite chain — hold

`pond/sqlite/`, `pond/jobs/`, `pond/migrations/` remain on stub
bodies pending `std::db::sqlite::*` from the compiler team
(`sqlite/FRICTION.md § F.1`). Their *other* deviations are
mechanically closable today:

- F.5 (`() fallible(E)` not lowering) — closed by `6beb1be`. F.6
  (cross-seed non-fallible path-call in expression position) — was
  closed by A3 (2026-05-17). Both retire from the chain's deviation
  list. The "bind methods return Int" workaround in sqlite + the
  matching workarounds in jobs / migrations flip back to
  `() fallible(E)` in the F.1 unblock pass.
- The contract surfaces for `pond/sqlite/`'s `Db` member fns can be
  declared as `fallible(DbError)` again (matching the original
  CONTRACTS.md text) when F.1 lands, without the free-fn shadowing
  the methods.

### Still blocked

Carry-forward inventory of friction with no upstream movement:

- **F.1** — `std::db::sqlite::*` primitive. Gates the sqlite chain.
- **Cross-seed qualified types in struct / locus fields** — affects
  `agent/embeddings/Store`, `ml/neural/{Layer, Trainer}`,
  `jobs/Pool`, `migrations/Runner`. Workaround: flatten cross-seed
  locus refs to scalar fields (`db_path: String`,
  `weights_offset: Int`).
- **G34 two-hop `_util` imports** — `_util/*` libs are consumable
  from end-apps and other `_util` libs but not from inside the
  tier-0..5 pond libs. Tier libs keep local copies of helpers.
- **G3 / G4 `@form(vec)` factory must be namespace-lotus method**
  — free fns can't return `LocusRef`. See `math/matrix/` Mat
  namespace lotus.
- **`or discard` on Unit-return fallible** — accepts only at parse
  level; codegen rejects the disposition for `() fallible(E)`.
- **`or <substitute>` LocusRef → Interface coercion** — see
  `agent/tools/FRICTION.md § or-fallback-no-locus-to-interface-coerce`.
- **No transitive imports in v1** — pond's architectural rule, not a
  compiler block. `pond/logfmt::OtlpSink` and `pond/tracing` cannot
  POST OTLP because they can't import `pond/http/client`. Workaround
  ships the assembled OTLP/JSON bytes via `pending_payload()` for an
  outboard exporter.

Contract surfaces below are the original v1 declarations. Active
deviations from those surfaces in source are catalogued in each
lib's FRICTION.md.

---

## Conventions

- Every lib lives at `pond/<path>/<lib>/` and is a single seed
  (F.19 per-directory).
- Every lib exports its public surface from its top-level `.hl`
  files; consumers reference it via the suggested import alias.
- Error payload types named in fallible returns are declared in
  the producing lib's own seed unless noted otherwise.
- Topic declarations live in the producing lib's seed; subscriber
  libs reference them via the topic's qualified name.

---

## Tier 0 internals — `pond/_util/*`

Small single-file utility libs that consolidate duplicate
helpers. Every util is a namespace lotus operating on
primitives only (so cross-seed import works at v1).

**Important (KNOWN_GOTCHAS G34).** These utils are consumable
from end-apps and from other `_util` libs; they are NOT usable
from inside the existing tier-0/1/2/3/4/5 pond libs because of
a two-hop codegen breakage. Tier libs keep their local copies
and flag the duplication in their FRICTION.md.

### `pond/_util/intfloat/` — alias `intf`

```hale
locus IntFloat {
    params { }
    fn to_float(n: Int) -> Float;       // ASCII roundtrip
    fn from_float(f: Float) -> Int;     // truncate toward zero
}
```

### `pond/_util/decimal_float/` — alias `decf`

```hale
locus DecimalFloat {
    params { }
    fn to_float(d: Decimal) -> Float;     // ASCII roundtrip
    fn from_float(f: Float) -> Decimal;   // coarse 0.001-step staircase
    fn abs(d: Decimal) -> Decimal;
}
```

### `pond/_util/duration_int/` — alias `durint`

```hale
locus DurationInt {
    params { }
    fn to_ns(d: Duration) -> Int;         // strip "ns" + parse
    fn to_seconds(d: Duration) -> Int;
    fn now_ns() -> Int;                   // monotonic clock
    fn now_seconds() -> Int;
}
```

### `pond/_util/kvpack/` — alias `kv`

```hale
locus KvPack {
    params { }
    fn get(data: String, key: String) -> String;     // "" if absent
    fn set(data: String, key: String, val: String) -> String;
    fn has(data: String, key: String) -> Bool;
}
```

### `pond/_util/rowbuf/` — alias `rb`

```hale
locus RowBuf {
    params { }
    fn nth_field(row: String, n: Int) -> String;
    fn row_count(buf: String) -> Int;
    fn nth_row(buf: String, idx: Int) -> String;
    fn remove_row(buf: String, target_first_field: String) -> String;
}
```

---

## Tier 0 — Infrastructure

### `pond/http/client/` — alias `http`

```hale
type Url      { scheme: String; host: String; port: Int; path: String; }
type Request  { method: String; url: Url; headers: String; body: Bytes; }
type Response { status: Int; headers: String; body: Bytes; }
type HttpError { kind: String; status: Int; detail: String; }

fn parse_url(s: String) -> Url fallible(HttpError);
fn get(url: String) -> Response fallible(HttpError);
fn post(url: String, body: Bytes, content_type: String) -> Response fallible(HttpError);
fn request(req: Request) -> Response fallible(HttpError);

locus Client {                          // pooled-connection client
    params { user_agent: String = "pond/http 0.1"; timeout_ms: Int = 30000;
             max_retries: Int = 3; }
    fn get(url: String) -> Response fallible(HttpError);
    fn post(url: String, body: Bytes, content_type: String) -> Response fallible(HttpError);
    fn request(req: Request) -> Response fallible(HttpError);
}
```

### `pond/crypto/` — alias `crypto`

```hale
fn hmac_sha256(key: Bytes, message: Bytes) -> Bytes;
fn sha256(input: Bytes) -> Bytes;
fn random_bytes(n: Int) -> Bytes;       // CSPRNG via getrandom(2)
fn constant_time_eq(a: Bytes, b: Bytes) -> Bool;
fn hex_encode(b: Bytes) -> String;
fn hex_decode(s: String) -> Bytes fallible(HexError);

type HexError { kind: String; }         // "odd_length" | "invalid_char"
```

### `pond/subprocess/` — alias `sub`

```hale
type SpawnOpts { cmd: String; args: String; cwd: String;
                 env: String; stdin: Bytes; timeout_ms: Int; }
type ExitStatus { code: Int; signaled: Bool; signal: Int; }
type Output { status: ExitStatus; stdout: Bytes; stderr: Bytes; }
type SpawnError { kind: String; detail: String; errno: Int; }

fn spawn(opts: SpawnOpts) -> Output fallible(SpawnError);
fn run(cmd: String, args: String) -> Output fallible(SpawnError);  // convenience

locus Process {                          // long-lived, streaming
    params { cmd: String; args: String = ""; cwd: String = "";
             pid: Int = -1; }
    bus { publish StdoutLine; publish StderrLine; publish ProcessExit; }
    fn send_stdin(b: Bytes) -> () fallible(SpawnError);
    fn signal(sig: Int) -> () fallible(SpawnError);
    fn wait() -> ExitStatus fallible(SpawnError);
}
topic StdoutLine  { payload: String; }
topic StderrLine  { payload: String; }
topic ProcessExit { payload: ExitStatus; }
```

### `pond/math/matrix/` — alias `mat`

**Updated 2026-06-08 — CQRS no-locus-return.** Factories, binary
ops, `transpose`, and the sentinel helpers are **free fns**: a
locus method may not return a locus value (`Matrix` is a locus), so
the `Mat` namespace-lotus methods were extracted to free fns
(hale v0.8.2 m90 / commit `04657b1`). Bind to the lib's alias
(`mat::zeros(...)`, etc.). Non-fallible ops use sentinel-predicate
pairs; bounds-checked variants are fallible free fns.

```hale
@form(vec)
locus Matrix {                           // row-major dense
    params { rows: Int; cols: Int; }
    capacity { heap data of Float; }
    // synthesized: len, get, set, push, pop, sort_*
    // user-added on top (data-returning, allowed as methods):
    fn at(r: Int, c: Int) -> Float;              // returns 0.0 on OOB
    fn set_at(r: Int, c: Int, v: Float) -> ();   // no-op on OOB
}

// Factories + binary ops + sentinels are FREE FNS (return a locus,
// which methods may not):
fn zeros(rows: Int, cols: Int) -> Matrix;
fn eye(n: Int) -> Matrix;
fn from_rows(rows: Int, cols: Int, data: String) -> Matrix;
fn matmul(a: Matrix, b: Matrix) -> Matrix;       // error_matrix on mismatch
fn add(a: Matrix, b: Matrix) -> Matrix;          // error_matrix on mismatch
fn scale(a: Matrix, k: Float) -> Matrix;
fn dot(a: Matrix, b: Matrix) -> Float;           // nan_sentinel on mismatch
fn transpose(m: Matrix) -> Matrix;

fn error_matrix() -> Matrix;                     // rows=-1 sentinel
fn is_error(m: Matrix) -> Bool;
fn nan_sentinel() -> Float;
fn is_nan(f: Float) -> Bool;

// Fallible bounds-checked variants (also free fns):
fn at_checked(m: Matrix, r: Int, c: Int) -> Float fallible(IndexError);
fn set_at_checked(m: Matrix, r: Int, c: Int, v: Float) -> Float fallible(IndexError);
fn index_of(rows: Int, cols: Int, r: Int, c: Int) -> Int fallible(IndexError);
fn check_matmul_shapes(a_rows: Int, a_cols: Int, b_rows: Int, b_cols: Int) -> () fallible(MatrixError);
fn check_same_shape(a_rows: Int, a_cols: Int, b_rows: Int, b_cols: Int) -> () fallible(MatrixError);
fn check_dot_shapes(a_rows: Int, a_cols: Int, b_rows: Int, b_cols: Int) -> () fallible(MatrixError);

type MatrixError { kind: String; }       // "shape_mismatch" | "empty"
// `locus Mat { }` remains as a vestigial empty namespace lotus.
```

**Consumer pattern:**
```hale
import "vendor/pond/math/matrix" as mat;
let z = mat::zeros(3, 3);
let i = mat::eye(3);
let p = mat::matmul(i, z);
if mat::is_error(p) { /* shape mismatch */ }
```

### `pond/math/stats/` — alias `stats`

```hale
fn mean(xs: Matrix) -> Float;            // operates on row-vec Matrix
fn variance(xs: Matrix) -> Float;
fn stddev(xs: Matrix) -> Float;
fn quantile(xs: Matrix, q: Float) -> Float fallible(StatsError);
fn min_max(xs: Matrix) -> Matrix;        // 1x2 [min, max]

locus OnlineMoments {                    // Welford's running mean/var
    params { n: Int = 0; mean: Float = 0.0; m2: Float = 0.0; }
    fn observe(x: Float) -> ();
    fn current_mean() -> Float;
    fn current_var() -> Float;
}

type StatsError { kind: String; }        // "empty" | "out_of_range"
```


## Tier 1 — Rails-shape web stack

### `pond/db/` — alias `db`

Backend-neutral relational store, Go `database/sql` shape (added
2026-06; commit `f8e2c62`). Declares the `DbDriver` interface + the
result shapes every driver speaks; concrete drivers (`pond/pq`,
`pond/sqlite`) structurally satisfy it (F.20 — no `impl`). Apps
program against the interface and inject a driver, so a backend swap
is a one-line change. **Errors travel as values**, not channels:
F.20 interface methods can't be `fallible(E)`, so every result
carries `ok: Bool` + `err: DbError` (the driver does the fallible
protocol work internally and packs the outcome).

```hale
interface DbDriver {
    fn backend() -> String;                       // "postgres" | "sqlite" | ...
    fn open() -> Status;
    fn close();
    fn exec(sql: String) -> ExecResult;           // INSERT/UPDATE/DELETE/DDL
    fn query_one(sql: String) -> Row;             // ok=false, err.kind="no_row" on empty
    fn query_all(sql: String) -> Rows;
    fn exec_params(sql: String, args: Args)  -> ExecResult;   // $1/$2 bind — safe path
    fn query_params(sql: String, args: Args) -> Rows;
    fn begin() -> Status; fn commit() -> Status; fn rollback() -> Status;
    fn tx_status() -> String;                     // "idle" | "in_tx" | "aborted"
}

type DbError    { kind: String; engine_code: Int; detail: String; }  // kind=="" → success
type Status     { ok: Bool; err: DbError; }
type ExecResult { ok: Bool; err: DbError; rows_affected: Int; last_insert_rowid: Int; }
type Row        { ok: Bool; err: DbError; data: String; }            // tab-separated columns
type Rows       { ok: Bool; err: DbError; csv: String; n: Int; }     // newline rows

type ArgVal { val: String; is_null: Bool; }
@form(vec)
locus Args {                                      // ordered bind params for $1/$2/...
    params { n: Int = 0; }
    capacity { heap data of ArgVal; }
    fn add(s: String) -> ();
    fn add_null() -> ();
    fn count() -> Int;
    fn val_at(i: Int) -> String;
    fn null_at(i: Int) -> Bool;
}
```

### `pond/pq/` — alias `pq`

Postgres driver speaking the pgwire v3 protocol over TCP (added
2026-06; commits `d0f8123`, `f23c27b`, `6945294`). Satisfies
`db::DbDriver`. Vendors `pond/db`.

```hale
import "vendor/pond/db" as db;

locus PgConn {                                     // single connection
    params { host = "127.0.0.1"; port = 55432; user = "fathom";
             database = "fathom"; sock = -1; connected = false;
             txn_state = "idle"; recv_chunk = 8192; /* + rx_buf BytesBuilder */ }
    // satisfies db::DbDriver: backend/open/close/exec/query_one/query_all/
    // exec_params/query_params/begin/commit/rollback/tx_status
}

locus PgPool {                                     // fixed-size connection pool
    params { host; port; user; database; size: Int = 4; }
    // satisfies db::DbDriver; round-robin acquire over `size` PgConns.
    // begin/commit/rollback are no-ops (tx_status: "n/a (pool)") — use a
    // single PgConn for transactions.
}
```

### `pond/sqlite/` — alias `sqlite`

> Suggested alias changed `db` → `sqlite` to avoid colliding with the
> new `pond/db` driver interface.

```hale
type DbError { kind: String; sqlite_code: Int; detail: String; }
type Row { data: String; }                // tab-separated columns, v0
type Rows { csv: String; }                // newline-separated rows, v0
type ExecResult { rows_affected: Int; last_insert_rowid: Int; }

locus Db {
    params { path: String = ":memory:"; conn_handle: Int = -1; }
    fn exec(sql: String) -> ExecResult fallible(DbError);
    fn query_one(sql: String) -> Row fallible(DbError);
    fn query_all(sql: String) -> Rows fallible(DbError);
    fn prepare(sql: String) -> Int fallible(DbError);  // returns stmt handle
    fn bind_text(stmt: Int, idx: Int, val: String) -> () fallible(DbError);
    fn bind_int(stmt: Int, idx: Int, val: Int) -> () fallible(DbError);
    fn step(stmt: Int) -> Row fallible(DbError);
    fn finalize(stmt: Int) -> () fallible(DbError);
}
```

> **Current source shape (BLOCKED chain).** Pending `std::db::sqlite::*`
> (F.1), `Db` ships stub bodies and the query ops are **free fns**
> (`sqlite::exec(db, sql)`, `query_one`, `query_all`, `prepare`,
> `step` — all `fallible(DbError)`), not methods. Migrating them onto
> the `db::DbDriver` method set (so `sqlite::Db` satisfies the
> interface like `pq::PgConn` does) is part of the F.1 unblock pass.

### `pond/router/` — alias `router`

```hale
type RouteParams { qs: String; path_kv: String; }  // tab-separated
type Context { req: Request; params: RouteParams; }

interface Handler {
    fn handle(ctx: Context) -> Response;
}

interface Middleware {
    fn before(ctx: Context) -> Context;
    fn after(ctx: Context, resp: Response) -> Response;
}

locus Router {
    params { not_found: fn(Context) -> Response = default_404; }
    fn add(method: String, pattern: String, h: Handler) -> ();
    fn use(m: Middleware) -> ();
    fn dispatch(req: Request) -> Response;
}

fn path_param(p: RouteParams, name: String) -> String;  // "" if missing
fn query_param(p: RouteParams, name: String) -> String; // "" if missing
```

### `pond/sessions/` — alias `sess`

```hale
type Session { id: String; data: String; }  // data is tab-separated kv
type SessionError { kind: String; }         // "tampered" | "expired" | "missing"

locus SessionStore {
    params { secret: Bytes; ttl_seconds: Int = 86400; }
    fn read(cookie_header: String) -> Session fallible(SessionError);
    fn write(s: Session) -> String;        // returns Set-Cookie value
    fn invalidate(id: String) -> String;
}

fn get_value(s: Session, key: String) -> String;
fn set_value(s: Session, key: String, val: String) -> Session;
```

### `pond/jobs/` — alias `jobs`

```hale
type Job { kind: String; payload: String; attempt: Int; max_attempts: Int; }
type JobResult { ok: Bool; detail: String; }
type JobError { kind: String; detail: String; }

interface JobHandler {
    fn invoke(j: Job) -> JobResult;
}

locus Queue {                              // sqlite-backed
    params { db: Db; table: String = "pond_jobs"; }
    fn enqueue(kind: String, payload: String, max_attempts: Int) -> Int fallible(JobError);
    fn dequeue() -> Job fallible(JobError); // empty → fail kind="empty"
    fn ack(job_id: Int) -> () fallible(JobError);
    fn fail(job_id: Int, retry: Bool) -> () fallible(JobError);
}

locus Pool {                               // worker pool
    params { queue: Queue; workers: Int = 4; handler: JobHandler; }
    birth() { /* spawn workers */ }
    drain() { /* finish in-flight */ }
}
```

### `pond/migrations/` — alias `migs`

**Updated 2026-06-08 — rewritten onto `db::DbDriver`** (commit
`7e00f37`): backend-neutral (runs against `pq` or `sqlite`),
forward-only + idempotent. Errors ride the db `ok`/`err` value shape
(the injected driver's interface methods are non-fallible per F.20),
not a `fallible(MigrationError)` method surface.

```hale
import "vendor/pond/db" as db;

locus Migrator {
    params {
        driver:   db::DbDriver;          // injected: pq::PgConn / pq::PgPool / sqlite::Db
        applied:  Int    = 0;            // count applied this run
        failed:   Bool   = false;        // sticky: once one fails, skip the rest
        last_err: String = "";
    }
    fn ensure() -> Bool;                 // create the tracking table if absent
    fn current_version() -> Int;
    fn apply(version: Int, name: String, up_sql: String) -> Bool;  // idempotent
    fn ok() -> Bool;
}
```

---

## Tier 2 — Observability + supervision

### `pond/logfmt/` — alias `logfmt`

```hale
// Implements std::log's Sink interface; consumers reference Sink as
// std::log::Sink. These loci satisfy that structurally.

locus FileSink {
    params { path: String; max_size_bytes: Int = 10000000;
             keep_files: Int = 5; }
    fn write(s: String) -> () fallible(IoError);
    fn line(s: String) -> () fallible(IoError);
    fn newline() -> () fallible(IoError);
}

locus OtlpSink {                          // OTLP over HTTP
    params { endpoint: String; service_name: String; }
    fn write(s: String) -> () fallible(IoError);
    fn line(s: String) -> () fallible(IoError);
    fn newline() -> () fallible(IoError);
}
```

### `pond/metrics/` — alias `metrics`

**Updated 2026-06-08 — CQRS no-locus-return.** `counter` / `gauge` /
`histogram` return loci, so they are **free fns** (a method may not
return a locus). `Registry` keeps `render()` (data return).
`MetricsEndpoint.handle` takes `std::http::Request` directly (it
satisfies `std::http::Handler`, not `router::Handler`).

```hale
type Labels { kv: String; }              // "k1=v1\tk2=v2"

locus Registry {                         // single instance per app
    params { namespace: String = ""; store: MetricMap; histograms: HistogramList; }
    fn render() -> String;               // Prometheus exposition format
}

// Factories are FREE FNS (return a locus):
fn counter(reg: Registry, name: String, labels: Labels) -> Counter;
fn gauge(reg: Registry, name: String, labels: Labels) -> Gauge;
fn histogram(reg: Registry, name: String, buckets: mat::Matrix, labels: Labels) -> Histogram;

// Label builders (no String[] in v1):
fn labels_empty() -> Labels;
fn labels_one(k: String, v: String) -> Labels;
fn labels_two(k1: String, v1: String, k2: String, v2: String) -> Labels;
fn labels_append(l: Labels, k: String, v: String) -> Labels;

locus Counter   { fn inc() -> (); fn add(v: Float) -> (); }
locus Gauge     { fn set(v: Float) -> (); fn inc() -> (); fn dec() -> (); }
locus Histogram { fn observe(v: Float) -> (); }

locus MetricsEndpoint {                  // HTTP handler (std::http::Handler)
    params { registry: Registry; }
    fn handle(req: std::http::Request) -> std::http::Response;
}
```

`MetricMap` is opted into `@form(hashmap, sync = serialized)` so a
metrics-endpoint pool can read counters that producer pools write
(commit `b8745bf`).

### `pond/supervisor/` — alias `sup`

```hale
type SupStrategy { kind: String; }       // "one_for_one" | "rest_for_one" |
                                         // "one_for_all" | "escalate"
type ChildSpec { name: String; restart: String; }  // restart: "permanent" |
                                                   //   "transient" | "temporary"

locus Supervisor {
    params { strategy: SupStrategy; max_restarts: Int = 3;
             window_seconds: Int = 60; }
    fn add_child(spec: ChildSpec, child: LocusRef) -> ();
    // on_failure machinery routes through the strategy
}
```

### `pond/tracing/` — alias `trace`

```hale
type SpanId { id: String; }
type Span { id: SpanId; parent: SpanId; name: String;
            start_ns: Int; end_ns: Int; attrs: String; }

locus Tracer {                           // one per app; mirrors locus tower
    params { service_name: String; }
    fn start_span(name: String, parent: SpanId) -> SpanId;
    fn end_span(id: SpanId) -> ();
    fn add_attr(id: SpanId, key: String, val: String) -> ();
    fn export_otlp(endpoint: String) -> () fallible(TraceError);
}

type TraceError { kind: String; detail: String; }
topic SpanCompleted { payload: Span; }   // declared in tracer.hl (same file as publisher)
```


## Tier 3 — Realtime

### `pond/websocket/` — alias `ws`

RFC 6455 WebSocket client + server-side upgrade (added 2026-05; was
listed as backlog). Owner-driven recv model: blocking pumps
(`open`/`read_msg`/`handshake`) return `Bool` and stash failure on
`self.last_error` so run-loop predicates stay clean; the outbound
send surface (`send_*`/`close`) is `fallible(WsError)` (v0.8.1).

```hale
type WsMessage  { kind: String; text: String; data: Bytes; }  // kind: text|binary|close|...
type WsError    { kind: String; detail: String; }
type WsLogEvent { phase: String; detail: String; ... }
interface WsLogger { fn log(e: WsLogEvent); }                  // NoopWsLogger / StderrWsLogger

locus WsClient {
    params { url: String; extra_headers = ""; auto_reconnect = true;
             max_retries: Int = -1; reconnect_initial = 1s; reconnect_max = 30s; }
    fn open() -> Bool;                         // connect + handshake; last_error on fail
    fn read_msg() -> Bool;                     // pump one message into self (Bool: got one)
    fn send_text(s: String) -> () fallible(WsError);
    fn send_bytes(b: Bytes) -> () fallible(WsError);
    fn close() -> () fallible(WsError);
}

locus WsServerConn {                           // per-connection server side
    fn handshake() -> Bool;                    // consume the HTTP Upgrade, send 101
    fn read_msg() -> Bool;
    fn send_text(s: String) -> () fallible(WsError);
    fn send_binary(b: Bytes) -> () fallible(WsError);
    fn close() -> () fallible(WsError);
}

// Frame + handshake free fns (build_request / parse_response /
// compute_accept / parse_request / build_101_response / emit_frame /
// peek_header / parse_url, ...) are the lower-level surface.
```


## Tier 5 — AI agent orchestration

### `pond/agent/llm/` — alias `llm`

```hale
type LlmRequest  { model: String; system: String; messages: String;
                   max_tokens: Int; temperature: Float; }
type LlmResponse { text: String; stop_reason: String;
                   input_tokens: Int; output_tokens: Int; }
type LlmError    { kind: String; status: Int; detail: String; }

locus AnthropicClient {
    params { api_key: String; base_url: String = "https://api.anthropic.com";
             default_model: String = "claude-opus-4-7"; }
    fn complete(req: LlmRequest) -> LlmResponse fallible(LlmError);
    fn stream(req: LlmRequest) -> ();    // emits Chunk topic
    bus { publish LlmChunk; publish LlmDone; }
}

locus OpenAiClient {
    params { api_key: String; base_url: String = "https://api.openai.com";
             default_model: String = "gpt-4o"; }
    fn complete(req: LlmRequest) -> LlmResponse fallible(LlmError);
    fn stream(req: LlmRequest) -> ();
    bus { publish LlmChunk; publish LlmDone; }
}

topic LlmChunk { payload: String; }
topic LlmDone  { payload: LlmResponse; }
```

### `pond/agent/tools/` — alias `tools`

```hale
type ToolSpec  { name: String; description: String; input_schema: String; }
type ToolCall  { name: String; args_json: String; call_id: String; }
type ToolResult { call_id: String; content: String; is_error: Bool; }
type ToolError  { kind: String; detail: String; }

interface Tool {
    fn spec() -> ToolSpec;
    fn invoke(call: ToolCall) -> ToolResult;
}

locus Registry {
    params { }
    fn register(t: Tool) -> ();
    fn dispatch(call: ToolCall) -> ToolResult fallible(ToolError);
    fn list() -> String;                  // JSON array of specs
}
```

### `pond/agent/conversation/` — alias `conv`

```hale
type Message { role: String; content: String; ts: Time; }

locus Conversation {                      // bounded chat history
    params { system_prompt: String = ""; max_messages: Int = 100; }
    fn append(m: Message) -> ();
    fn history() -> String;                // tab-separated messages
    bus { publish ConversationUpdated; }
}

topic ConversationUpdated { payload: Message; }
```

### `pond/agent/sandbox/` — alias `sandbox`

```hale
type SandboxResult { exit_code: Int; stdout: String; stderr: String; }
type SandboxError { kind: String; }       // "timeout" | "oom" | "spawn_failed"

locus Sandbox {
    params { runtime: String = "python3"; timeout_ms: Int = 30000;
             memory_limit_mb: Int = 512; }
    fn run_code(code: String) -> SandboxResult fallible(SandboxError);
    fn run_file(path: String) -> SandboxResult fallible(SandboxError);
}
```

### `pond/agent/embeddings/` — alias `emb`

```hale
type Embedding { id: String; vector: Matrix; metadata: String; }
type SearchHit { id: String; score: Float; metadata: String; }
type EmbError { kind: String; }

@form(vec)
locus Store {                            // vector store
    params { dim: Int; }
    capacity { heap items of Embedding; }
    fn add(e: Embedding) -> () fallible(EmbError);
    fn search(query: Matrix, k: Int) -> Rows fallible(EmbError);  // top-k
    fn remove(id: String) -> () fallible(EmbError);
    fn count() -> Int;
}
```

### `pond/ml/neural/` — alias `nn`

```hale
type Layer { name: String; weights: Matrix; biases: Matrix;
             activation: String; }
type TrainStep { loss: Float; epoch: Int; step: Int; }
type NnError { kind: String; }

locus Model {
    params { name: String; }
    fn add_dense(input_dim: Int, output_dim: Int, activation: String) -> ();
    fn forward(x: Matrix) -> Matrix fallible(NnError);
}

locus Trainer {
    params { model: Model; lr: Float = 0.01; batch_size: Int = 32; }
    fn fit(xs: Matrix, ys: Matrix, epochs: Int) -> () fallible(NnError);
    bus { publish TrainStep; }
}

topic TrainStep { payload: TrainStep; }
```

---

## Cross-cutting conventions

- **Bytes vs String**: prefer `Bytes` for binary I/O (HTTP bodies,
  TCP framing, JSON wire), `String` for human-readable text and
  for stdlib paths.
- **Rows / Matrix as collection-returns**: per stdlib precedent
  (`list_dir_count` + `list_dir_at`), avoid invented parametric
  collections. Use the index-API pair or a `Matrix` of values.
- **Error payload types are per-lib**: each lib declares its own
  `LibError` shape; cross-lib `or` chains compose normally because
  every payload sits in its own scope.
- **Bus subjects via topic decls** (not literal strings) when the
  topic is internal to one lib; literal-string subjects only for
  wildcard subscriptions or runtime-computed paths.
- **No `panic` / `assert`** — every failure routes through
  `fallible(E)` (value channel) or closure violation (structural
  channel). Bridging value→structural uses the
  `closure NAME { captures: ...; epoch inline; } / violate NAME;`
  pattern from `spec/styleguide.md § 7. Error-check fn`.
