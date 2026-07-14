# pond/pq — Postgres driver

Suggested import alias: **`pq`**

```hale
import "vendor/pond/db" as db;     // vendor both — no transitive deps in v1
import "vendor/pond/pq" as pq;
```

A Postgres driver speaking the **pgwire v3** wire protocol directly
over TCP (no libpq). Structurally satisfies `db::DbDriver`, so it
drops into any consumer written against the interface.

**Auth:** trust and **SCRAM-SHA-256** (RFC 5802 / 7677, no channel
binding). Pass a non-empty `password` to authenticate with SCRAM; an
empty `password` uses trust. MD5 is not supported. See
`examples/pgwire-roundtrip/` for a live round-trip against both.

**TLS:** a `sslmode` param negotiates TLS via the pgwire SSLRequest
before the auth handshake:

| `sslmode`     | behaviour                                              |
|---------------|--------------------------------------------------------|
| `disable`     | never negotiate; dial plaintext                        |
| `prefer` (default) | TLS if the server offers it, else plaintext       |
| `require`     | encrypt, **no** cert verification; fail if TLS refused |
| `verify-full` | encrypt **and** verify hostname + chain vs system CAs  |

The default `prefer` is opportunistic (libpq's default): existing
plaintext consumers keep working, TLS-capable servers get encryption
automatically. `require` is the sorcery-fleet posture against AWS RDS
(whose CA is not in system trust stores). `verify-full` requires the
server's CA to be installed in the container's system trust store
(`SSL_CTX_set_default_verify_paths` only — no pond-side CA pinning); it
is an operational prerequisite, not needed for `require`. An unknown
`sslmode` is rejected at `open()`.

> **Scheduler note.** hale's TLS recv does a blocking `SSL_read` with no
> async_io park, so a TLS `PgConn`/`PgPool` must **not** be placed on an
> async_io pool (it would starve sibling coroutines) until hale grows
> non-blocking TLS reads. This is fine on ordinary cooperative pools —
> where pq's recv already blocks — which is pq's documented placement.

## Surface

- `pq::PgConn` — a single connection. Dials in `open()`, does the
  auth handshake (trust or SCRAM), speaks the startup → query →
  terminate flow, tracks transaction state from the backend
  `ReadyForQuery` indicator (`idle` / `in_tx` / `aborted`).
  Satisfies the full `db::DbDriver` method set including
  `begin`/`commit`/`rollback` and the parameterized `exec_params` /
  `query_params` ($1/$2 bind via `db::Args`).
- `pq::PgPool` — a fixed-size pool of `PgConn`s with round-robin
  acquire. Satisfies `db::DbDriver` for the per-statement ops;
  `begin`/`commit`/`rollback` are no-ops (`tx_status: "n/a (pool)"`)
  because a transaction must pin one connection — use a `PgConn`
  directly for transactional work.

```hale
let pool = pq::PgPool { host: "db.internal", port: 5432,
                        user: "app", password: "secret",  // "" = trust
                        database: "app", sslmode: "require", size: 8 };
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
