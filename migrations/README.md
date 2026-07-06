# pond/migrations — forward-only schema migrations

Suggested import alias: **`migs`**

```hale
import "vendor/pond/migrations" as migs;
import "vendor/pond/db"         as db;       // the driver interface Migrator runs on
import "vendor/pond/sqlite"     as sqlite;   // if using the sqlite::Driver adapter
```

## Status (2026-07-06): WORKING — backend-neutral; adapter promoted to pond/sqlite

The `SqliteDriver` adapter this lib used to bundle now lives in
its natural home as `sqlite::Driver` (see CONTRACTS.md
§ pond/sqlite and FRICTION.log § pond/migrations item 11). This
seed imports only `pond/db` — pure Hale, so `hale test
migrations/` needs no @ffi link shims.

## Status (2026-06-12): WORKING — backend-neutral, real sqlite path

Rewritten 2026-05-29 onto the `pond/db` `DbDriver` interface
(data-driven, forward-only, idempotent); this pass wired the
sqlite backend for real. `examples/blog-schema/` applies two
migrations to an actual SQLite file, prints the
`schema_migrations` rows, and proves the re-run no-op.

## Model

Migrations are supplied by the caller as `(version, name,
up_sql)` triples, applied in ascending version order. `apply()`
records each in `schema_migrations` and skips any `version <=`
the recorded max — re-running the full set is a no-op. Data-driven
rather than directory-scanning: the app embeds its ordered
migration calls (no fs access, no embed step), and it works
against ANY backend the DbDriver covers (postgres via pq, sqlite
via the bundled adapter).

**Forward-only.** No down migrations — reversal is a new forward
migration.

**Atomicity.** Each migration travels as one multi-statement
exec (`<up_sql>; INSERT INTO schema_migrations ...`). Postgres
runs that as a single implicit transaction (mid-failure rolls the
whole migration back); sqlite's `sqlite3_exec` is per-statement
autocommit, so sqlite consumers wanting file-level atomicity put
`BEGIN`/`COMMIT` inside their own `up_sql` (see FRICTION.log
item 7).

## Surface (as built)

`Migrator` matches CONTRACTS.md § pond/migrations verbatim.

```hale
locus Migrator {
    params {
        driver:   db::DbDriver;   // injected: pq::PgConn / pq::PgPool / sqlite::Driver
        applied:  Int    = 0;     // count applied this run
        failed:   Bool   = false; // sticky: once one fails, skip the rest
        last_err: String = "";
    }
    fn ensure() -> Bool;                 // create the tracking table if absent
    fn current_version() -> Int;
    fn apply(version: Int, name: String, up_sql: String) -> Bool;  // idempotent
    fn ok() -> Bool;
}
```

Errors ride the db `ok`/`err` value shape (interface methods
can't be fallible per F.20), not a `fallible(MigrationError)`
surface: a failed migration prints a `[migrate] FAILED ...` line,
latches `failed`, and `apply()` returns `false` for the rest of
the sequence.

### The sqlite adapter

`sqlite::Db`'s locked contract surface is fallible-method shaped
and cannot structurally satisfy the non-fallible, `ok`/`err`-packed
`db::DbDriver` (sqlite FRICTION § F.7). The `sqlite::Driver`
adapter — born in this lib, promoted to pond/sqlite 2026-07-06 —
wraps a caller-owned `sqlite::Db` and repacks every `DbError` into
the `db::*` result shapes.

## Usage

```hale
let conn = sqlite::Db { path: "/var/lib/app/app.db" };  // caller owns lifecycle
let m = migs::Migrator { driver: sqlite::Driver { conn: conn } };

let _ = m.ensure();
let _ = m.apply(1, "create_posts",  "CREATE TABLE posts (...)");
let _ = m.apply(2, "add_comments",  "CREATE TABLE comments (...)");
if !m.ok() { println("migration failed: ", m.last_err); }
```

Against postgres, swap the driver injection for a `pq::PgConn` —
nothing else changes.

## Files

| File               | Role                                                  |
|--------------------|-------------------------------------------------------|
| `migrate.hl`       | `locus Migrator` over `db::DbDriver`                  |
| `examples/blog-schema/` | Two-migration end-to-end demo against real sqlite |

## Build & verify

The sqlite path needs libsqlite3 dev headers on the build host
(`apt install libsqlite3-dev`; or `C_INCLUDE_PATH`/`LIBRARY_PATH`
shims). The end app must import pond/sqlite DIRECTLY — hale.toml
`[ffi]` auto-pickup scans only direct imports (and pond's
no-transitive-deps rule requires the explicit vendor of pond/db
and pond/sqlite anyway).

```bash
hale check migrations/                          # typecheck the lib (no main)
hale build migrations/examples/blog-schema/
./migrations/examples/blog-schema/blog-schema
```

Expected output:

```
[migrate] applied v1 create_posts
[migrate] applied v2 add_comments
[blog-schema] first run: applied=2 ok=true current_version=2
[blog-schema] re-run   : applied=0 ok=true current_version=2
[blog-schema] schema_migrations rows (n=2):
1	create_posts	2026-06-12T...Z
2	add_comments	2026-06-12T...Z
[blog-schema] OK — 2 applied, re-run no-op, both tables exist
```

Reruns of the binary are idempotent (the demo drops its tables at
start, then proves the no-op with a second Migrator round in the
same run).
