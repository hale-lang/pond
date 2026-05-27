# pond/migrations — friction log

Gaps, suspicions, and deviations from CONTRACTS.md surfaced while
building this lib.

---

## 1. deviation: fallible-on-locus-methods — [CLOSABLE]

**2026-05-27 update.** v0.8.1 narrowed the two-channel rule (#24
v0.2, commits `d565d6f` + `98910b9`); user-declared `fn` member
fns now carry `fallible(E)` directly. The next source pass
restores `Runner`'s four ops to locus methods. Clean breaking
change. Source migration stays on hold pending sqlite F.1 — the
chain is gated on the stdlib primitive.

**Current source shape (still in place).** The operations live
in `migrate.hl` as free fns whose first argument is the `Runner`:

```hale
fn current_version(r: Runner) -> Int fallible(MigrationError);
fn pending(r: Runner)         -> db::Rows fallible(MigrationError);
fn migrate_up(r: Runner, t: Int) -> Int fallible(MigrationError);
fn migrate_down(r: Runner, t: Int) -> Int fallible(MigrationError);
```

Call sites read `migs::migrate_up(r, -1)` instead of
`r.migrate_up(-1)` — functionally identical.

---

## 2. deviation: `params { db: Db; }` rejected by codegen

CONTRACTS.md declares:

```hale
locus Runner {
    params { db: Db; dir: String = "migrations"; }
    ...
}
```

Declaring a locus-typed field inside another locus's `params` block
trips a codegen sequencing error today:

```
codegen error: unsupported in codegen v0:
qualified type `db::Db` (mangled `__lib_db_db_Db`) declared in
stdlib path-renames table but not registered in user_loci,
user_types, or user_interfaces yet — sequencing issue:
type_expr_to_codegen_ty called before pass A0/A1 populated this name
```

**Adopted shape**: `Runner.params` holds the SQLite path
(`db_path: String`) instead of the Db locus instance, and the
free-fn surface constructs its own Db handle internally:

```hale
fn current_version(r: Runner) -> Int fallible(MigrationError) {
    ...
    let conn = db::Db { path: r.db_path };
    let row = db::query_one(conn, sql) or db::Row { data: "" };
    ...
}
```

Functionally equivalent for the `:memory:` path (every Db handle
points at its own in-memory DB; per-call construction loses no
state) and for file paths (every Db handle opens the same file).
The cost is one Db allocation per top-level operation — negligible.

**duplicate-suspected**: any pond lib whose CONTRACTS.md surface
declares a locus-typed `params` field hits this. Candidates from a
grep of CONTRACTS.md: `pond/jobs::Queue { db: Db; ... }`,
`pond/jobs::Pool { queue: Queue; handler: JobHandler; ... }`,
`pond/metrics::MetricsEndpoint { registry: Registry; }`,
`pond/agent/conversation::Conversation` (none yet, but follows),
`downstream-consumer::ConsumerTypeB { policy: Policy;
gate: ConsumerTypeC; store: ConsumerTypeA; ... }`. The fix is in the codegen
pass ordering, not in each lib; worth a single upstream issue.

---

## 3. codegen quirk: `-> ()` rejected on fallible fns — [CLOSABLE]

**2026-05-27 update.** Closed by `6beb1be` (FUv0.8.2 #6,
unit-return normalization). The next source pass restores
`migrate_up` / `migrate_down` to `-> ()` shape. The `Int`-count
semantic could survive as a useful return signal if we want — the
contract amendment is now elective rather than forced.

**Current source shape (still in place).** Both fns declared
`-> Int` (the count of migrations applied / rolled back) because
the old codegen rejected `-> ()` on fallible fns:

```
codegen error: unsupported in codegen v0:
fn `migrate_up`: v1 requires fallible(E) fns to declare a return type
```

---

## 4. codegen quirk: `or discard` rejected on `-> ()`-fallible fns

A second pass tried `migrate_up(r, t) or discard` at the call site
(per `spec/semantics.md § "or discard"`, which says discard is for
Unit-success calls). Codegen rejects:

```
type error: `or discard` requires the underlying call's success
type to be Unit (so the discard branch produces no value to bind);
got `()`. Use `or <default>` or `or raise` for value-bearing
fallibles.
```

So `-> ()` declared in the source is **not** typechecked as Unit
for the purposes of `or discard`. Combined with entry 3, the
practical conclusion: declare value-bearing fallible fns
(`-> Int`, `-> SomeRecord`, etc.); do not declare `-> ()` on
fallible fns. The same applies if you reach for `or self.method(err)`
where `method` returns `()` — the typechecker rejects with
"fallback type `()` does not match success type `()`" (a fun
diagnostic).

**Adopted shape**: `__log_err_int(e: MigrationError) -> Int` is the
free-fn substitute at the `migrate_up(...) or __log_err_int(err)`
call site in `cli.hl`. The free-fn shape sidesteps the
`or self.method(err)` quirk; the `-> Int` return type matches the
fallible's `-> Int` success type.

---

## 6. duplicate-suspected: `__ends_with` / `__pad3`

`__ends_with(s, suffix)` is the canonical "does this filename end
in .sql / .down.sql" predicate — fits naturally in `std::str` next
to `index_of` / `trim` / `replace`. `__pad3(v)` is a one-off
zero-padder; a generalized `std::str::pad_left(s, width, "0")`
already exists in stdlib (per `spec/stdlib.md`) but takes a String
input; `__pad3` is the Int→String→pad shortcut. Both candidates for
either `std::str` extension or a `pond/str/` namespace lotus, but
"only edit pond/migrations/" forecloses the lift here.

---

## 7. design-question: per-migration transaction wrapping

SQLite supports `BEGIN ... COMMIT` around a migration's body so a
syntactically valid file with a runtime constraint violation rolls
back cleanly. This lib does NOT wrap each migration in a
transaction — every CREATE / ALTER / INSERT in the file executes
in SQLite's default autocommit mode, and a mid-file failure leaves
partial state behind.

The wrap is straightforward (`db::exec(conn, "BEGIN") or raise;` ...
`db::exec(conn, "COMMIT") or rollback_and_raise()`), but:

1. SQLite rejects nested transactions, so if the migration file
   already has its own `BEGIN`/`COMMIT` pair the wrapper conflicts.
2. DDL inside a transaction is non-portable across DB engines
   (Postgres allows DDL in transactions; MySQL silently commits
   pending transactions on DDL).

Sticking with autocommit for v1; revisit when a real migration's
constraint-violation rollback becomes painful. Document the
convention in the README so consumers add their own `BEGIN` /
`COMMIT` if they want atomicity at the file level.

---

## 8. design-question: `applied_at` is always 0

The tracking table has an `applied_at INTEGER NOT NULL DEFAULT 0`
column and `__apply_up_one`'s INSERT writes `0` rather than a
real wall-clock timestamp. Reason: Hale's `std::time::*` surface
isn't called out in CONTRACTS.md and a grep of `runtime/stdlib/`
turned up `std::process::pid` / `std::process::exit` but no
`std::time::now()`-equivalent for "milliseconds since epoch."

A best-guess `unixepoch()` could be wired via SQLite's own
`strftime('%s', 'now')` inside the INSERT — that would write a
real epoch-seconds value without needing an Hale-side time
primitive. Held for v0.1; consumer feedback decides.

---

## 9. design-question: error semantics on "non-conforming filename"

`__list_up_files` silently skips files in the migrations dir whose
name doesn't match the `NNN_description.sql` pattern. The
silently-skip stance keeps the directory friendly to README.md /
.DS_Store / version-control droppings.

A stricter mode that fails with `MigrationError { kind:
"bad_filename" }` on every non-conforming entry would surface
typos (`01_foo.sql` instead of `001_foo.sql`). The
`MigrationError` payload already declares the `bad_filename` kind
in its kind-vocabulary comment; the body currently never produces
it. Easy to flip on demand via a `Runner.params { strict: Bool = false; }`
toggle.

---

## 10. no-bus participation

CONTRACTS.md doesn't declare any topics for `pond/migrations`, and
this implementation doesn't add any. Migration runs are
synchronous and short-lived; the "did it finish" signal flows
back via the return value of `migrate_up` / `migrate_down`, not
through a topic publish.

A future consumer wanting `MigrationApplied { payload: Version }`
to drive a "rebuild the read replicas" downstream could add it
without breaking the contract — the topic decl + `bus { publish
MigrationApplied; }` on `Runner` would be additive. Not added at
v0.1 because no in-tree consumer has surfaced the need.
