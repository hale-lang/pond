# pond/pq — Postgres driver

Suggested import alias: **`pq`**

```hale
import "vendor/pond/db" as db;     // vendor both — no transitive deps in v1
import "vendor/pond/pq" as pq;
```

A Postgres driver speaking the **pgwire v3** wire protocol directly
over TCP (no libpq). Structurally satisfies `db::DbDriver`, so it
drops into any consumer written against the interface.

## Surface

- `pq::PgConn` — a single connection. Dials in `open()`, speaks the
  startup → query → terminate flow, tracks transaction state from the
  backend `ReadyForQuery` indicator (`idle` / `in_tx` / `aborted`).
  Satisfies the full `db::DbDriver` method set including
  `begin`/`commit`/`rollback` and the parameterized `exec_params` /
  `query_params` ($1/$2 bind via `db::Args`).
- `pq::PgPool` — a fixed-size pool of `PgConn`s with round-robin
  acquire. Satisfies `db::DbDriver` for the per-statement ops;
  `begin`/`commit`/`rollback` are no-ops (`tx_status: "n/a (pool)"`)
  because a transaction must pin one connection — use a `PgConn`
  directly for transactional work.

```hale
let pool = pq::PgPool { host: "127.0.0.1", port: 5432,
                        user: "app", database: "app", size: 8 };
let st = pool.open();
if !st.ok { /* st.err */ }

let a = db::Args { };
a.add("btc-usd"); a.add("0.1");
let r = pool.exec_params(
    "INSERT INTO contract (symbol, min_tick) VALUES ($1, $2)", a);
```

## Notes

- Parameterized queries (`exec_params` / `query_params`) are the safe
  path for externally-sourced values — binding happens in the
  protocol, not via string interpolation.
- `hale check pq` typechecks in-repo; `hale build` of a consumer
  needs `pond/db` vendored at `vendor/pond/db` (the import path), per
  the standard vendoring model (F.26).

See [`../CONTRACTS.md`](../CONTRACTS.md) for the locked surface.
