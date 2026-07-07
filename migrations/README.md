# pond/migrations — schema migrations over `db::DbDriver`

Suggested import alias: **`migs`**

```hale
import "vendor/pond/migrations" as migs;
import "vendor/pond/db"         as db;       // the driver interface Migrator runs on
import "vendor/pond/sqlite"     as sqlite;   // if injecting the sqlite::Driver adapter
```

## Status (2026-07-06): v2 — registration-then-run, WORKING

Respelled to the golang-migrate / ezdb shape (CONTRACTS.md
§ pond/migrations; deviation record FRICTION.log § pond/migrations
entry 13). The v1 call-at-a-time `apply()` + sticky-latch surface
is gone. This seed imports only `pond/db` — pure Hale, so
`hale test migrations/` runs with no @ffi link shims (the sqlite
adapter it used to bundle lives in `pond/sqlite` as
`sqlite::Driver` since 2026-07-06).

## Model

The app **registers** its migrations — `(version, name, up_sql[,
down_sql])`, strictly ascending versions — into a `Migrations` set
and injects the set plus a driver into a `Migrator`; then it calls
run verbs:

| Verb | Meaning |
|------|---------|
| `up()` | apply every pending migration, ascending; returns count |
| `down(n)` | revert the `n` most recent, descending |
| `steps(n)` | signed: `+n` applies next n, `-n` reverts last n (ezdb `MigrateSteps`) |
| `goto(v)` | migrate up or down to exactly `v` (0 or a registered version) |
| `force(v)` | repair hatch: reset the *record* to `v`, clear dirty; schema untouched |
| `ensure()` | tracking-table bringup (run ops call it themselves) |
| `current_version()` / `pending()` / `dirty()` | introspection |

Data-driven, not directory-scanning: registrations are embedded in
app code (no fs access, no embed step), and everything runs
against ANY backend the `db::DbDriver` interface covers — postgres
via `pq`, sqlite via `sqlite::Driver`. Versions already recorded
in `schema_migrations` are skipped; re-running `up()` is a no-op.

**Atomicity.** Every step (apply or revert) is ONE explicit driver
transaction: `begin` → step SQL → tracking write → `commit`, with
rollback on failure. Both pond backends have transactional DDL, so
a failed migration leaves the schema untouched — including on
sqlite, whose v1 half-applied hazard this closes (FRICTION item 7).

**Errors.** Every run verb is `fallible(MigrationError)` — kinds
`bad_set`, `ensure_failed`, `dirty`, `lock_failed`, `not_found`,
`irreversible`, `migration_failed`, `rollback_failed`,
`force_failed` (vocabulary documented in `types.hl`). The set is
validated up front (`bad_set` before any SQL runs).

**Dirty state.** Normal failures roll back cleanly. Only a failure
whose *rollback also fails* marks the tracking table dirty; every
later run op then refuses with kind `dirty` until an operator
reconciles the schema by hand and calls `force(v)` —
golang-migrate's dirty/force protocol, reachable only on that
narrow path.

**Locking.** On postgres, run ops hold `pg_advisory_lock` for the
duration (concurrent deploys serialize; a crashed process releases
on disconnect). On sqlite the per-step write transaction already
excludes other writers. `force()` takes no lock.

**Down migrations are opt-in.** `add()` registers an irreversible
migration; `add_rev()` supplies `down_sql`. Reverting across an
irreversible migration fails `irreversible` *before running
anything*. Forward-only remains the recommended operating stance
against a live authority DB — reversal there is best expressed as
a new forward migration; `down`/`goto` earn their keep in dev
loops and staging.

## Usage

```hale
// Build the set in a fn main() / lifecycle frame (see caveat below).
let conn = sqlite::Db { path: "/var/lib/app/app.db" };   // caller owns lifecycle
let s = migs::Migrations { };
s.add(1, "create_posts", "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)");
s.add_rev(2, "add_comments",
    "CREATE TABLE comments (id INTEGER PRIMARY KEY, post_id INTEGER, body TEXT)",
    "DROP TABLE comments");

let m = migs::Migrator { driver: sqlite::Driver { conn: conn }, set: s };
let applied = m.up() or handle(err);      // fallible(MigrationError)
```

Against postgres, swap the injection for a `pq::PgConn` — nothing
else changes.

### Caveats that shape consumer code

- **Build `Migrations` sets inline in a `fn main()` / lifecycle
  frame.** A free-fn factory that builds-and-grows a set, called
  *after* a caught Migrator failure, segfaults at current hale
  HEAD — a new manifestation of the open method-frame
  heap-corruption family. Deterministic repro + probe matrix:
  FRICTION.log § pond/migrations entry 14.
- **Tracking writes interpolate via `__quote()` ('' doubling), not
  `exec_params`** — deliberate while the same upstream family is
  open (entry 15). Migration names are developer constants, so
  this is correctness (apostrophes), not injection defense.
- `verbose: true` (default) prints one `[migrate] applied/reverted
  vN` line per step — the operator surface. Construct with
  `verbose: false` for silence (that's how the unit tests run).

## Files

| File | Role |
|------|------|
| `types.hl` | `Migration`, `MigrationError` (kind vocabulary) |
| `migrate.hl` | `Migrations` (@form(vec) set) + `locus Migrator` |
| `tests/migrator_test.hl` | pure-Hale FakeDriver tests — every verb + every error kind |
| `examples/blog-schema/` | full verb walk against real sqlite |

## Build & verify

The lib itself is pure Hale:

```bash
hale check migrations/    # ok: 2 files (4 alloc warnings — triaged, FRICTION entry 13)
hale test migrations/     # FakeDriver unit tests, no @ffi shims needed
```

The example injects the real sqlite adapter, so its build needs
libsqlite3 dev files (and the app vendors pond/sqlite + pond/db
directly, per the no-transitive-deps rule):

```bash
C_INCLUDE_PATH=$HOME/.local/include LIBRARY_PATH=$HOME/.local/lib \
  hale build migrations/examples/blog-schema/
./migrations/examples/blog-schema/blog-schema
```

Expected output (abridged):

```
[migrate] applied v1 create_posts
[migrate] applied v2 add_comments
[migrate] applied v3 add_tags
[blog-schema] up          : applied=3 current_version=3
[blog-schema] up (re-run) : applied=0 current_version=3
[migrate] reverted v3 add_tags
[migrate] reverted v2 add_comments
[blog-schema] goto(1)     : reverted=2 current_version=1
[blog-schema] steps(2)    : applied=2 current_version=3
[migrate] forced version to 2
[blog-schema] up (post-force): applied=1 current_version=3
[blog-schema] OK — up x3, no-op re-run, goto/steps round-trip, force+replay, all tables exist
```

Reruns are idempotent (the demo drops its tables at start).
