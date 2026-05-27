# pond/sqlite — friction log

This is the **primary deliverable** for this lib. `pond/sqlite/`
is architecturally blocked behind a missing stdlib primitive; the
entries below document what's blocked, what shape the unblocker
should take, and the deviations from CONTRACTS.md the build-out
forced.

Format follows the friction-log convention in
`notes/agent-onboarding/app-dev-brief.md`: one entry per gap, with
a short tag, a description, a reproducer (where applicable), and a
proposed resolution.

---

## F.1 — `no-stdlib-sqlite-primitive` (BLOCKING)

**Tag:** `no-stdlib-sqlite-primitive`
**Severity:** blocking — defines the entire lib's status.

**Description.**
The `pond/sqlite/` contract (CONTRACTS.md § Tier 1 →
`pond/sqlite/`) requires opening a SQLite connection, preparing
statements, binding parameters, stepping rows, finalizing
statements, and closing the connection. None of these can be
expressed in pure Hale v1: stdlib ships `std::io::fs::*`,
`std::io::tcp::*`, `std::io::stdin::*`, `std::env::*`,
`std::process::*`, `std::time::*`, `std::math::*`, `std::json::*`,
`std::log::*`, `std::str::*`, `std::bytes::*`, `std::test::*` —
but no `std::db::*` and no generic libffi / libsqlite3 binding
surface.

AGENTS.md's hard rule **"Don't edit `crates/`. That's compiler
territory. If a primitive you need is missing, work within the
existing surface; don't reach into the compiler."** forbids the
straightforward fix (adding a libsqlite3 FFI binding in
`runtime/stdlib/`). The library is therefore architecturally
blocked on a stdlib primitive that has to be added by the
compiler team.

**Reproducer.**
```bash
grep -r "sqlite\|libsqlite\|sqlite3" \
    hale/crates/hale-codegen/runtime/ \
    hale/spec/
# (no results — neither runtime symbols nor spec mentions)
```

**Workaround in this lib.**
Every fallible(DbError) body returns
`fail DbError { kind: "unsupported", ... }`; the Db locus's
`birth()` stamps `conn_handle = 0` as a "stub-birthed" marker so
the rest of the surface can typecheck. The kv-demo's
error-check-fn paths fire on every call today; the happy-path
output activates the day the stdlib primitive ships.

**Proposed resolution: `std::db::sqlite::*` primitive surface.**

A path-call surface (mirroring `std::io::fs::*`) is the
lowest-friction shape that lets the existing CONTRACTS.md lift
into a working Hale adapter. The exact signatures to ship:

```hale
// Connection lifecycle.
//
// open(path) — `:memory:` for ephemeral, ":file:/abs/path" or a
// bare filesystem path for on-disk. Returns an opaque handle
// (Int address of `sqlite3*`). Failures map to IoError or a new
// SqliteError; either works — the wrapper in pond/sqlite/ will
// convert to its own DbError type.
fn std::db::sqlite::open(path: String) -> Int fallible(SqliteError);
fn std::db::sqlite::close(handle: Int) -> () fallible(SqliteError);

// One-shot statement execution. Returns the SQLITE_* result code
// (0 = SQLITE_OK on success). For multi-statement scripts, the
// wrapper splits on `;` and exec's each — sqlite3_exec is the
// underlying primitive.
fn std::db::sqlite::exec(handle: Int, sql: String) -> Int fallible(SqliteError);

// Statement compilation + parameter binding. `prepare` returns a
// stmt handle (Int address of `sqlite3_stmt*`). Parameters are
// 1-indexed (sqlite3 convention).
fn std::db::sqlite::prepare(handle: Int, sql: String) -> Int fallible(SqliteError);
fn std::db::sqlite::bind_text(stmt: Int, idx: Int, val: String) -> () fallible(SqliteError);
fn std::db::sqlite::bind_int (stmt: Int, idx: Int, val: Int)    -> () fallible(SqliteError);
// Future: bind_double, bind_blob (Bytes), bind_null.

// Row iteration. step() returns SQLITE_ROW (100) or SQLITE_DONE
// (101) on success, anything else through the fallible channel.
// column_count + column_text + column_int read the row's columns
// (0-indexed, opposite convention to bind_*'s 1-indexed — also
// sqlite3 convention).
fn std::db::sqlite::step(stmt: Int) -> Int fallible(SqliteError);
fn std::db::sqlite::column_count(stmt: Int) -> Int;
fn std::db::sqlite::column_text(stmt: Int, col: Int) -> String;
fn std::db::sqlite::column_int (stmt: Int, col: Int) -> Int;
fn std::db::sqlite::finalize(stmt: Int) -> () fallible(SqliteError);

// Connection metadata.
fn std::db::sqlite::changes(handle: Int) -> Int;
fn std::db::sqlite::last_insert_rowid(handle: Int) -> Int;

type SqliteError {
    kind:        String;  // "open_failed" | "prepare_failed" | "step_failed"
                          // | "bind_failed" | "finalize_failed" | "close_failed"
                          // | "busy" | "constraint" | "io"
    sqlite_code: Int;     // raw SQLITE_* result code
    detail:      String;  // sqlite3_errmsg(db) at the moment of failure
}
```

C-runtime symbols follow the `lotus_*` convention per AGENTS.md:
`lotus_sqlite_open`, `lotus_sqlite_close`, `lotus_sqlite_exec`,
`lotus_sqlite_prepare`, `lotus_sqlite_step`,
`lotus_sqlite_column_text`, `lotus_sqlite_finalize`, etc. They
wrap `sqlite3_*` and link the system `libsqlite3` (or vendor
amalgamation in-tree).

**Why path-calls, not a locus.**
`std::io::tcp::Listener` is a locus because a TCP listener is
naturally a Service (birth = `listen()`, run = `accept()` loop,
dissolve = `close()`). A SQLite connection has the same shape —
**but** the application-facing query surface needs to be
`fallible(E)` (every SELECT can syntax-error / busy / lock-fail),
and locus methods can't be fallible. The right factoring is
exactly what this lib does: stdlib exposes the primitive as
path-calls; pond wraps a Service-locus around the lifecycle and
keeps the query surface as free fns reading the locus's handle
field. Stdlib could ship the locus itself, but the path-call
surface is the minimum primitive that lets pond do the layering.

**Why this fits the rolling-the-design test.**
- **Continuity in shape.** `std::db::sqlite::open` / `prepare` /
  `step` mirrors `std::io::tcp::listen_socket` / `accept_one` and
  `std::io::fs::read_file` exactly — opaque handle returned from
  a fallible path-call, lifecycle managed by the caller. A reader
  who knows `std::io::*` recognizes the surface immediately.
- **Interlock in composition.** The handle is an Int that fits
  cleanly into a user-locus's params (the m83 pattern for
  resource handles, used by every existing service locus). The
  String + Int column accessors compose with `to_string` /
  `parse_int` / the tab-joined Row convention the lib already
  uses.
- **No new category.** Same six-pattern catalog; the lib is one
  Service locus + a vocabulary of free fns. The stdlib addition
  is one new sibling under `std::io::*` / `std::db::*` — same
  surface shape, different domain.

---

## F.2 — `contracts-md-locus-methods-fallible` (deviation) — [CLOSABLE on F.1 unblock]

**2026-05-27 update.** v0.8.1 narrowed the two-channel rule (#24
v0.2, commits `d565d6f` + `98910b9`) so user-declared `fn` member
fns now carry `fallible(E)`. CONTRACTS.md's original declaration
(SQL surface as locus methods on `Db`) is now type-legal. The F.1
unblock pass will restore the contract verbatim: drop the free-fn
shim, fold the SQL surface into `Db.exec` / `query_one` /
`query_all` / `prepare` / `bind_*` / `step` / `finalize` methods
that declare `fallible(DbError)` directly. Clean breaking change.

**Current source shape (still in place — gated on F.1).**
- `Db` remains a Service locus with `params`, `birth()`,
  `dissolve()`.
- The eight methods (`exec`, `query_one`, `query_all`, `prepare`,
  `bind_text`, `bind_int`, `step`, `finalize`) are free fns
  taking a `Db` ref (or, for the post-prepare ones, the stmt
  Int handle):

  ```hale
  // CONTRACTS as written:                  // this lib:
  conn.exec(sql) or raise;               // db::exec(conn, sql) or raise;
  conn.query_one(sql) or raise;          // db::query_one(conn, sql) or raise;
  ```

CONTRACTS.md does not need amending: the original surface is
canonical again post-v0.8.1. The implementation just needs to
catch up when F.1 lands.

---

## F.3 — `consider-flat-file-kv-fallback` (considered, declined)

**Tag:** `consider-flat-file-kv-fallback`
**Severity:** advisory.

**Description.**
The prompt suggested considering a file-based fallback storage
(in-memory or flat-file KV) so the lib could ship a working
implementation even without SQLite. The candidate shape would be:

- Store: a single file at `params.path` holding tab/newline-
  separated key=value lines.
- `exec(CREATE TABLE ...)` becomes a no-op (or initializes the
  file).
- `INSERT INTO kv (k,v) VALUES (...)` becomes an append.
- `SELECT v FROM kv WHERE k = ...` becomes a linear scan.

**Decision: declined for the surface, logged as a follow-up.**

The CONTRACTS.md surface speaks SQL — `exec(sql: String)`,
`prepare(sql: String)`, `query_one(sql: String)`. A flat-file KV
that *parses SQL* enough to fake those four operations is a much
larger project than the lib's contract, and a flat-file KV that
*ignores* the SQL string is a different lib (one without a SQL
surface). Either choice silently breaks consumer code the moment
the stdlib primitive lands and the real SQL engine arrives, which
defeats the point of the stubbed-API approach.

**Better follow-up shape (not implemented here).**
A separate `pond/kv/` lib with its own contract:

```hale
type KvError { kind: String; detail: String; }
locus FileKv {
    params { path: String; }
    birth()   { /* ensure file exists, parse into in-mem index */ }
    dissolve(){ /* fsync */ }
}
fn get(s: FileKv, k: String) -> String fallible(KvError);
fn put(s: FileKv, k: String, v: String) -> () fallible(KvError);
fn delete(s: FileKv, k: String) -> () fallible(KvError);
fn keys(s: FileKv) -> Rows fallible(KvError);
```

This sits alongside `pond/sqlite/` rather than inside it — they're
different abstractions (KV vs SQL), even if their use cases
overlap. a future SqliteStore lib could grow a sibling
`FileKvStore` that uses it. Not built today; logged for whoever
picks up the slack while the stdlib primitive is in flight.

---

## F.5 — `codegen-v0-unit-fallible-unlowered` — [CLOSABLE on F.1 unblock]

**2026-05-27 update.** Closed by `6beb1be` (FUv0.8.2 #6, unit-return
normalization for fallible locus method bodies). The next source
pass restores `bind_text` / `bind_int` / `finalize` to
`() fallible(DbError)` — folds together with the F.2 method-fallible
restoration and the F.1 stdlib primitive landing.

**Current source shape (still in place — gated on F.1).** The
three signatures return non-fallible `-> Int` (SQLite result
code; 0 = SQLITE_OK) instead of `() fallible(DbError)`.

---

## F.4 — `duplicate-suspected: tab-separated-row-helpers` (advisory)

**Tag:** `duplicate-suspected`
**Severity:** advisory; surfaces only post-unblock.

**Description.**
Once the stub bodies in `query.hl` get filled in, there will be
two near-duplicate helpers:

1. **Collect a row's columns into a tab-separated `Row.data`
   string** (used by `query_one`, `query_all`, `step`).
2. **Append a row to an accumulating `Rows.csv` string** (used by
   `query_all` only).

The first is the more general primitive; the second is two lines
of glue on top of it. Both are equally useful in `pond/jobs/`
(which will need to walk a job table) and `pond/migrations/`
(which will need to walk a `pending` query). One of three things
should happen:

- Both helpers stay private to `pond/sqlite/` and the duplication
  in `pond/jobs/` / `pond/migrations/` is accepted as a one-line
  cost (the helpers are tiny).
- A small `pond/sqlite/rows.hl` exposes them as exported free fns
  with stable names (`columns_to_tab_row`, `append_row_to_csv`).
- A more general `pond/text/tabular/` lib gets promoted from one
  of the existing tab-separated-row conventions (matches
  `std::io::fs::list_dir_at` + the kv-string convention in
  `pond/sessions/`'s `Session.data`).

Decision: defer until the primitive ships and the duplication
materializes. The pattern is suspected but not proven; the
right scope only becomes visible when there are >1 consumer.

---

## Resolution checklist (track when each blocker lifts)

The F.5 + F.6 codegen items are now closed upstream (`6beb1be` for
F.5, A3 for F.6); the F.2 deviation is type-legal again post-#24
v0.2. The entire chain collapses into a single F.1-driven cleanup
pass:

- [ ] `std::db::sqlite::*` primitive surface lands in
      `runtime/stdlib/` (F.1).
- [ ] `pond/sqlite/db.hl`'s `birth()` / `dissolve()` swap stubs
      for real primitive calls.
- [ ] `pond/sqlite/query.hl`'s free-fn bodies swap stubs for
      real primitive calls — and fold back into `Db` methods
      declared `fallible(DbError)` (per the original CONTRACTS.md
      surface, now type-legal via #24 v0.2).
- [ ] `bind_text` / `bind_int` / `finalize` graduate back to
      `() fallible(DbError)` on `Db` (the `() fallible(E)`
      lowering is closed by `6beb1be`).
- [ ] `pond/sqlite/examples/kv-demo/main.hl` re-run end-to-end;
      stub-branch `println("[kv-demo] db error ...")` lines stop
      firing.
- [ ] `pond/sqlite/rows.hl` exported helpers OR `pond/text/tabular/`
      promotion decision (F.4).
