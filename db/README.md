# pond/db — backend-neutral relational store

Suggested import alias: **`db`**

```hale
import "vendor/pond/db" as db;
```

The Go `database/sql` split for Hale: this seed declares the
`DbDriver` interface plus the result shapes every driver speaks.
Concrete drivers live in sibling seeds — `pond/pq` (Postgres over
TCP), `pond/sqlite` (libsqlite3) — and **structurally** satisfy
`DbDriver` (F.20, no `impl I for L`). Apps program against the
interface and inject a driver into a `db::DbDriver`-typed slot, so a
backend swap is a one-line change.

## Errors travel as values, not channels

F.20 interface methods can't declare `fallible(E)` (the grammar has
no fallible clause on `interface_method_sig`), and that's the right
shape here — it lands the Go `(result, error)` idiom. Every result
type carries `ok: Bool` + `err: DbError`. A driver's member fn does
the fallible protocol work internally (calling fallible free fns with
`or`), catches failure, and packs it into the returned struct.
Callers branch on `result.ok` / inspect `result.err`.

```hale
let rows = self.store.query_all("SELECT id, symbol FROM contract");
if !rows.ok {
    log::error("db", rows.err.kind, rows.err.detail);
} else {
    // rows.csv: newline-separated rows, each tab-separated columns
}
```

## Surface

- `interface DbDriver` — `backend / open / close / exec / query_one /
  query_all / exec_params / query_params / begin / commit / rollback /
  tx_status`. See `db.hl`.
- Result shapes — `DbError`, `Status`, `ExecResult`, `Row`, `Rows`
  (`types.hl`). Columns are stringly-typed in v0: `Row.data` is
  tab-separated columns, `Rows.csv` newline-separated rows.
- Bind params — `db::Args` (`add` / `add_null` / `count` / `val_at` /
  `null_at`) for the `$1`/`$2` extended-query path (`args.hl`). The
  safe path for any externally-sourced value — escaping/injection is
  the protocol's job, not string interpolation.

See [`../CONTRACTS.md`](../CONTRACTS.md) for the locked surface.

## No transitive deps (v1)

A consumer that uses `pond/pq` (which vendors `pond/db`) must vendor
both explicitly.
