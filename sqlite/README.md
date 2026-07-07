# pond/sqlite — SQLite driver (pure `@ffi`, WORKING)

Connection + query surface around SQLite: a Service-locus `Db`
(birth opens the connection, dissolve closes it) and a
`fallible(DbError)` member-fn surface covering exec / query_one /
query_all / prepare-bind-step-finalize — the CONTRACTS.md
§ pond/sqlite shape, implemented for real. Since 2026-07-06 the
seed also ships `Driver`, the `db::DbDriver` adapter (promoted
from pond/migrations, where it was born as `migs::SqliteDriver`).

## Status (2026-06-12): UNBLOCKED — real driver, no stdlib wait

This lib **calls SQLite**. The long-standing "BLOCKED on
`std::db::sqlite::*`" premise was refuted upstream (WS4 post-audit
pass, `hale/notes/sqlite-via-ffi-recipe.md`): `@ffi("c")` is the
library-author C-binding surface — no stdlib primitive needed, and
none will ship. The driver is a pure pond library:

- `glue.c` — thin `lotus_sqlite_*` shims over `sqlite3_*`
  (handles cross the boundary as `Int` addresses; error sentinels,
  never exceptions).
- `ffi.hl` — the `@ffi("c")` extern declarations.
- `hale.toml` — `[ffi] csrc = ["glue.c"], link = ["sqlite3"]`,
  picked up **automatically** when a program imports this lib
  (spec/ffi.md § hale.toml auto-pickup).
- `db.hl` — the Hale wrapper: sentinel codes →
  `fail DbError { kind, sqlite_code, detail }`; sqlite-owned
  string pointers (`errmsg`, `column_text`) cloned immediately via
  `std::str::clone`.

### Build requirement

The build host needs the **libsqlite3 development package**
(`sqlite3.h` + `-lsqlite3`):

```bash
sudo apt install libsqlite3-dev     # debian/ubuntu
brew install sqlite3                # macos
```

Deploy hosts need only the runtime shared library. This is the
same class of system dep as the existing `-lssl` / `-lcrypto`
usage elsewhere in the workspace. (On a box with the runtime `.so`
but no dev package, point the toolchain at local shims:
`C_INCLUDE_PATH=... LIBRARY_PATH=... hale build ...` — the shipped
`hale.toml` stays canonical.)

## Suggested alias

```hale
import "vendor/pond/sqlite" as sqlite;
```

(`sqlite`, per pond/CONTRACTS.md — the older `db` alias now
belongs to the backend-neutral `pond/db` interface lib.)

## Surface (as built — matches CONTRACTS.md § pond/sqlite exactly)

```hale
type DbError    { kind: String; sqlite_code: Int; detail: String; }
type Row        { data: String; }                // tab-separated columns
type Rows       { csv:  String; }                // newline-separated rows
type ExecResult { rows_affected: Int; last_insert_rowid: Int; }

locus Db {
    params { path: String = ":memory:"; conn_handle: Int = -1; }
    fn exec(sql: String) -> ExecResult fallible(DbError);
    fn query_one(sql: String) -> Row fallible(DbError);   // zero rows → kind="no_row"
    fn query_all(sql: String) -> Rows fallible(DbError);  // zero rows → csv="" (success)
    fn prepare(sql: String) -> Int fallible(DbError);     // returns stmt handle
    fn bind_text(stmt: Int, idx: Int, val: String) -> () fallible(DbError);  // idx 1-indexed
    fn bind_int(stmt: Int, idx: Int, val: Int) -> () fallible(DbError);
    fn step(stmt: Int) -> Row fallible(DbError);          // SQLITE_DONE → kind="no_row"
    fn finalize(stmt: Int) -> () fallible(DbError);
}

locus Driver {                    // db::DbDriver adapter (additive, 2026-07-06)
    params { conn: Db; }          // caller-owned connection
    // satisfies db::DbDriver: backend/open/close/exec/query_one/
    // query_all/exec_params/query_params/begin/commit/rollback/
    // tx_status — every DbError caught on the value channel and
    // repacked into the db::* ok/err result shapes.
}
```

Call sites:

```hale
let conn = sqlite::Db { path: "/tmp/app.db" };       // birth opens; dissolve closes at scope exit
let r    = conn.exec("INSERT INTO kv VALUES ('k','v')") or raise;
let row  = conn.query_one("SELECT v FROM kv WHERE k = 'k'") or self.handle(err);

let stmt = conn.prepare("SELECT v FROM kv WHERE k = ?1") or raise;
conn.bind_text(stmt, 1, "k") or raise;
let one  = conn.step(stmt) or raise;
conn.finalize(stmt) or raise;
```

### Semantics worth knowing

- **`DbError.kind` vocabulary** — `"open_failed"`, `"exec_failed"`,
  `"prepare_failed"`, `"step_failed"`, `"bind_failed"`,
  `"finalize_failed"`, `"no_row"`, plus the cross-cutting engine
  states that override the per-op kind: `"busy"` (SQLITE_BUSY /
  LOCKED), `"constraint"` (19), `"io"` (10). `sqlite_code` is the
  raw SQLITE_* result code; `detail` is `sqlite3_errmsg`.
- **Open failure is reported by the first SQL call**, not by
  `birth()` — lifecycle methods cannot be `fallible(E)` (two-channel
  rule), so a failed `sqlite3_open` stamps `conn_handle = 0` and
  every member fn fails with `kind="open_failed"` carrying the real
  open errmsg. No panic, no structural violation for a recoverable
  condition. Handle sentinels: `-1` never birthed, `0` open failed,
  `>0` live.
- **`dissolve()` cannot fail**: the close rc is dropped in glue.c;
  a SQLITE_BUSY close (statements left unfinalized) leaks the
  handle rather than crashing. Finalize what you prepare.
- **NULL columns read as `""`** — the v0 tab-separated `Row` shape
  has no NULL channel.
- **`Db` itself does not satisfy `db::DbDriver`** — the contract's
  fallible-method surface is signature-incompatible with the
  non-fallible `ok`/`err`-packed interface in `pond/db`
  (FRICTION.log § F.7). Where a `db::DbDriver` is expected, wrap
  the connection: `let drv = sqlite::Driver { conn: conn };` —
  Driver requires the consumer app to also vendor `pond/db` (its
  result shapes are `db::*`), consistent with pond's
  no-transitive-deps vendoring rule. Adapter caveat: its methods
  stash the first error on `self`, so calls are non-reentrant
  across pinned threads — give parallel pinned workers their own
  Driver.

## Files

- `types.hl` — `DbError`, `Row`, `Rows`, `ExecResult` (pattern 5).
- `ffi.hl` — `@ffi("c")` extern decls for the glue shims.
- `glue.c` — C shims over `sqlite3_*` (compiled into consumers via
  hale.toml auto-pickup).
- `hale.toml` — `[ffi]` link surface.
- `db.hl` — the `Db` service locus (pattern 3) carrying the whole
  SQL member-fn surface, plus private helpers.
- `driver.hl` — the `Driver` adapter locus satisfying
  `db::DbDriver` (imports `../db`; promoted from pond/migrations
  2026-07-06).
- `tests/` — `crud_test.hl`, `errors_test.hl`, `driver_test.hl`
  (the adapter's full interface surface). NOTE: `hale test` cannot
  link `@ffi` libs yet (FRICTION.log) — build each test with
  `hale build sqlite/tests/<x>_test.hl` + run (pass = exit 0,
  silent).
- `examples/kv-demo/` — real create/insert/select round-trip
  against `/tmp/pond-sqlite-kv-demo.db`, plus four deliberate
  error paths (bad SQL, constraint violation, zero-row query_one,
  unopenable path) each surfacing a `DbError` value.

## Verification

```bash
hale check sqlite/                       # ok: 4 file(s) typechecked
hale build sqlite/examples/kv-demo/      # picks up [ffi] automatically
./sqlite/examples/kv-demo/kv-demo
```

Expected output (abridged): real `rows_affected` /
`last_insert_rowid`, the selected rows, and then four
`[kv-demo] DbError: kind=...` lines ending with
`done: errors_seen=4 (expected 4)`. Reruns are idempotent (the
demo drops + recreates its table). The produced db file is a
normal SQLite database, readable by any external client.

## When this unblocks → executed-cleanup record (2026-06-12)

This section used to be the "recipe to run when `std::db::sqlite::*`
ships." The premise died (no primitive will ship); the cleanup ran
2026-06-12 against the `@ffi` recipe instead. What was done:

1. **Driver implemented as pure `@ffi`** — added `glue.c`,
   `ffi.hl`, `hale.toml`; no compiler/stdlib change, no `crates/`
   edit (the `@ffi` surface never touches compiler territory).
2. **`birth()` / `dissolve()` un-stubbed** — real
   `lotus_sqlite_open` / `lotus_sqlite_close`; the
   `conn_handle = 0` "stub-birthed" marker was repurposed as the
   "open failed" sentinel.
3. **Free-fn shim deleted** (`query.hl`) — the SQL surface folded
   back into `Db` member fns declared `fallible(DbError)`,
   restoring CONTRACTS.md verbatim (FRICTION § F.2 closed; the
   v0.8.1 two-channel narrowing made it legal).
4. **`bind_text` / `bind_int` / `finalize` flipped** from
   Int-status methods to `() fallible(DbError)` (FRICTION § F.5
   closed; upstream `6beb1be` fixed the lowering).
5. **kv-demo made real** — stub-diagnostic walkthrough replaced
   with a live round-trip + deliberate error paths.

Remaining follow-ups live in FRICTION.log: § F.4 (row-helper
export, deferred). § F.7 (`db::DbDriver` adapter) is resolved —
the adapter is this seed's `Driver` since 2026-07-06.
