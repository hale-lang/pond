# pond/sqlite — SQLite adapter (BLOCKED on stdlib primitive)

Connection + query surface around SQLite. Per CONTRACTS.md the
intent is a Service-locus `Db` (birth opens the connection,
dissolve closes it) and a small fallible(DbError) query surface
covering exec / query_one / query_all / prepare-bind-step-finalize.

## Status (2026-05-16): BLOCKED

This lib does **not** currently call SQLite. The stdlib
(`runtime/stdlib/`) ships no `std::db::sqlite::*` primitive and no
generic FFI surface; AGENTS.md's `Don't edit crates/` rule
forbids adding one here. The shape below is the contract;
every `fallible(DbError)` call returns
`fail DbError { kind: "unsupported", ... }` today. The same
source recompiles against a real implementation once the stdlib
primitive lands — see [`FRICTION.md`](./FRICTION.md) for the
proposed `std::db::sqlite::*` surface that would unblock this.

The library type-checks and builds as stubs so consumers
(`pond/jobs/`, `pond/migrations/`, a future SqliteStore lib,
app code) can write against the surface today and pick up the
real engine for free when it ships.

## Suggested alias

```hale
import "vendor/pond/sqlite" as db;
```

The bare `db` alias matches `pond/CONTRACTS.md`'s suggestion and
the `pond/README.md` catalog entry.

## Surface (as built)

```hale
type DbError    { kind: String; sqlite_code: Int; detail: String; }
type Row        { data: String; }                // tab-separated columns
type Rows       { csv:  String; }                // newline-separated rows
type ExecResult { rows_affected: Int; last_insert_rowid: Int; }

locus Db {
    params { path: String = ":memory:"; conn_handle: Int = -1; }
    birth()   { /* open conn — stub stamps 0 */ }
    dissolve()/* close conn — stub no-ops    */ }

    // bind/finalize live on the locus (see "Deviations" below).
    fn bind_text(stmt: Int, idx: Int, val: String) -> Int;  // 0 = OK
    fn bind_int (stmt: Int, idx: Int, val: Int)    -> Int;  // 0 = OK
    fn finalize(stmt: Int) -> Int;                          // 0 = OK
}

// Naturally-fallible query surface lives as free fns:
fn exec(db: Db, sql: String) -> ExecResult fallible(DbError);
fn query_one(db: Db, sql: String) -> Row    fallible(DbError);
fn query_all(db: Db, sql: String) -> Rows   fallible(DbError);
fn prepare(db: Db, sql: String) -> Int      fallible(DbError);
fn step(stmt: Int) -> Row                   fallible(DbError);
```

### Deviations from CONTRACTS.md

Three independent forcing functions land the shape above:

1. **Two-channel rule (pre-v0.8.1)** (`spec/semantics.md`
   § "Where each channel lives"). CONTRACTS.md lists the eight
   SQL ops as locus methods on `Db` with `fallible(DbError)`
   returns. Under the pre-v0.8.1 rule that declaration shape was
   type-illegal; the implementation migrated the fallible SQL
   surface to free fns taking a `Db` ref — call sites read
   `db::exec(conn, sql)` instead of `conn.exec(sql)`. → **v0.8.1
   #24 v0.2 narrows the rule**; the contract surface is now
   type-legal again and folds back into `Db` methods on the F.1
   unblock pass.

2. **Codegen v0 can't lower `() fallible(E)` (pre-v0.8.1).** Three of
   CONTRACTS.md's eight ops return unit (`bind_text` /
   `bind_int` / `finalize`); the `() fallible(E)` shape hits a
   codegen-v0 limitation (`tuple type must have at least 2
   elements; got 0`). Even decl-only triggers it. Workaround:
   return `Int` status code (0 = SQLITE_OK), same pattern as
   pre-2026-05-16 `std::io::fs::mkdir`.

3. **Codegen v0 can't lower non-fallible cross-seed path calls
   in expression position (pre-A3).** `let n = db::bind_text(...)`
   from a consumer file failed with `unsupported in codegen v0:
   path call db::bind_text in expression position`. Locus methods
   on imported loci DO codegen, so bind/finalize migrated from
   free fns to Db methods. → **Closed 2026-05-17 (A3,
   `f9068fa`)**; the historic workaround stays in source until
   the F.1 unblock pass.

The three combine to put `exec` / `query_one` / `query_all` /
`prepare` / `step` as free fns (fallible, codegen accepts those
cross-seed) and `bind_text` / `bind_int` / `finalize` as Db
methods (non-fallible Int-status, codegen accepts those cross-
seed). **As of v0.8.1 the F.5 + F.6 codegen restrictions both
lifted** — `() fallible(E)` lowers (`6beb1be`), and cross-seed
non-fallible path-calls work (A3 closed pre-window). The F.2
two-channel deviation is also type-legal again post-#24 v0.2. The
entire SQL surface collapses back into `Db` methods declaring
`fallible(DbError)` on the F.1 unblock pass; the deviation
described above is the still-shipped source shape, not a forward
constraint. See FRICTION.md § F.2, § F.5 (both tagged CLOSABLE
on F.1) and the Resolution checklist.

The Service-locus shape of `Db` (params + birth + dissolve) is
preserved; only the SQL surface migrates.

## Files

- `types.hl` — `DbError`, `Row`, `Rows`, `ExecResult` (pattern 5).
- `db.hl` — the `Db` service locus (pattern 3, stub
  birth/dissolve).
- `query.hl` — the eight free fns (pattern 6, every body stubs
  with `fail DbError { kind: "unsupported", ... }`).
- `examples/kv-demo/main.hl` — create-table + insert + select
  demonstration. Exercises every fallible call shape via the
  styleguide § 7 error-check fn pattern.

## Verification

```bash
hale build \
    pond/sqlite/
```

The library type-checks today against the stubbed bodies. The
example builds independently and runs end-to-end; today every
db::* call hits the stub branch and prints
`[kv-demo] db error (...): unsupported — ...`. The same example
will run a real CREATE/INSERT/SELECT once the stdlib primitive
lands.

## When this unblocks

Once `std::db::sqlite::*` (proposed in FRICTION.md § F.1) ships:

1. `db.hl`'s `birth()` stub becomes `self.conn_handle =
   std::db::sqlite::open(self.path);`, `dissolve()` calls
   `std::db::sqlite::close(self.conn_handle);` on the `>0`
   branch.
2. `query.hl`'s five free-fn bodies replace the
   `fail DbError { kind: "unsupported", ... }` lines with the
   real primitive call + result translation. The signatures stay
   identical.
3. `db.hl`'s three `bind_text` / `bind_int` / `finalize` method
   bodies replace `return -1;` with the matching
   `return std::db::sqlite::...;` call.
4. `examples/kv-demo/main.hl`'s `or self.handle_*(err)` paths
   stop firing and the happy-path `println` lines carry real
   data.

Once codegen v0 grows `() fallible(E)` lowering AND cross-seed
non-fallible path-call lowering (FRICTION.md § F.5 / § F.6):

5. `bind_text` / `bind_int` / `finalize` graduate from Db methods
   back to free fns in `query.hl` with the original
   `-> () fallible(DbError)` signatures. Consumers update from
   `conn.bind_text(...)` to `db::bind_text(conn, ...)`.

Once both stdlib AND codegen unblock, `FRICTION.md` collapses to
resolved-entries linking the relevant changelog stamps.
