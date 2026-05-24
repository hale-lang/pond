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

## 2026-05-18 status note — contract deviations now closable

The following contract deviations (flagged across pond FRICTION
logs) are **closable** with the 2026-05-17 stdlib ships and the
2026-05-18 F.20 Phase B landing. Source has not been migrated
yet for all of them; cleanup is per-lib in subsequent passes.

- **`pond/router/Router.add(h: Handler)` and `use(m: Middleware)`**
  — F.20 Phase B (G20) close lets the interface storage land.
  The lib currently ships `fn(Context) -> Response` cells; the
  `use_mw(before, after)` two-half deviation can fold back to
  the original `use(m: Middleware)` shape (modulo the `use`
  reserved-keyword question — G22 still applies).
- **`pond/agent/tools/Registry.register(t: Tool)`** — G20 close
  lets the interface storage land. The lib currently uses an
  `Entry { spec, invoke_fn }` wrapper + fn-pointer storage.
- **`pond/jobs/Pool.params.handler: JobHandler`** — G20 close
  lets the interface storage land. The lib currently uses
  `fn(Job) -> JobResult`. (Cleanup gated on the sqlite-stub
  unwrap.)
- **`pond/subprocess/`** — stdlib `std::process::run` +
  `std::process::Child` shipped 2026-05-17; the lib bodies
  remain on `"unsupported"` pending the v1 implementation pass.
- **`pond/agent/sandbox/`** — transitive on subprocess; same
  shape.
- **`pond/crypto/`** — `std::crypto::sha256` /
  `hmac_sha256` (C3) and `std::os::getrandom` (C4) shipped
  2026-05-17; the lib delegates to them.

Contract surfaces below are the original v1 declarations.
Active deviations from those surfaces in implementation are
catalogued in each lib's FRICTION.md.

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

**Updated 2026-05-16 — see KNOWN_GOTCHAS G3 + G4.** Factories
moved to methods on `Mat` namespace lotus because free fns can't
return LocusRef. Binary ops are namespace-lotus methods (not
fallible per two-channel rule); use sentinel-predicate pairs.

```hale
@form(vec)
locus Matrix {                           // row-major dense
    params { rows: Int; cols: Int; }
    capacity { heap data of Float; }
    // synthesized: len, get, set, push, pop, sort_*
    // user-added on top (NOT fallible per two-channel rule):
    fn at(r: Int, c: Int) -> Float;              // returns 0.0 on OOB
    fn set_at(r: Int, c: Int, v: Float) -> ();   // no-op on OOB
    fn transpose() -> Matrix;
}

// Namespace lotus for factories and binary ops:
locus Mat {
    params { }
    fn zeros(rows: Int, cols: Int) -> Matrix;
    fn eye(n: Int) -> Matrix;
    fn from_rows(rows: Int, cols: Int, data: String) -> Matrix;
    fn matmul(a: Matrix, b: Matrix) -> Matrix;       // returns error_matrix on mismatch
    fn add(a: Matrix, b: Matrix) -> Matrix;          // returns error_matrix on mismatch
    fn scale(a: Matrix, k: Float) -> Matrix;
    fn dot(a: Matrix, b: Matrix) -> Float;           // returns nan_sentinel on mismatch

    // sentinel predicates
    fn error_matrix() -> Matrix;                    // rows=-1
    fn is_error(m: Matrix) -> Bool;
    fn nan_sentinel() -> Float;
    fn is_nan(f: Float) -> Bool;
}

// Fallible bounds-checked variants live as free fns:
fn at_checked(m: Matrix, r: Int, c: Int) -> Float fallible(IndexError);
fn set_at_checked(m: Matrix, r: Int, c: Int, v: Float) -> () fallible(IndexError);
fn check_matmul_shapes(a: Matrix, b: Matrix) -> () fallible(MatrixError);
fn check_add_shapes(a: Matrix, b: Matrix) -> () fallible(MatrixError);
fn check_dot_shapes(a: Matrix, b: Matrix) -> () fallible(MatrixError);

type MatrixError { kind: String; }       // "shape_mismatch" | "empty"
```

**Consumer pattern:**
```hale
let mat = std::path::to::Mat { };
let z = mat.zeros(3, 3);
let i = mat.eye(3);
let p = mat.matmul(i, z);
if mat.is_error(p) { /* shape mismatch */ }
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

### `pond/sqlite/` — alias `db`

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

```hale
type MigrationError { kind: String; detail: String; version: Int; }

locus Runner {
    params { db: Db; dir: String = "migrations"; }
    fn current_version() -> Int fallible(MigrationError);
    fn pending() -> Rows fallible(MigrationError);  // version,filename per row
    fn migrate_up(target_version: Int) -> () fallible(MigrationError);
    fn migrate_down(target_version: Int) -> () fallible(MigrationError);
}

// CLI entry point: `migrate up`, `migrate down N`, `migrate status`.
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

```hale
type Labels { kv: String; }              // "k1=v1\tk2=v2"

locus Registry {                         // single instance per app
    params { namespace: String = ""; }
    fn counter(name: String, labels: Labels) -> Counter;
    fn gauge(name: String, labels: Labels) -> Gauge;
    fn histogram(name: String, buckets: Matrix, labels: Labels) -> Histogram;
    fn render() -> String;               // Prometheus exposition format
}

locus Counter   { fn inc() -> (); fn add(v: Float) -> (); }
locus Gauge     { fn set(v: Float) -> (); fn inc() -> (); fn dec() -> (); }
locus Histogram { fn observe(v: Float) -> (); }

locus MetricsEndpoint {                  // HTTP handler, mounts on router
    params { registry: Registry; }
    fn handle(ctx: Context) -> Response;  // implements router::Handler
}
```

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
    fn export_otlp(endpoint: String) -> () fallible(IoError);
}

topic SpanCompleted { payload: Span; }
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
