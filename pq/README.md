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

> **Pin `sslmode` in production.** `prefer`'s plaintext fallback is
> silent by design (it just logs — see below) so it's the right default
> for a library that must not break existing plaintext-only callers, but
> it also means a `prefer` connection against a load-balanced/proxied
> endpoint that doesn't speak TLS on every hop will quietly downgrade.
> Production consumers should pin `sslmode` explicitly rather than rely
> on the default — `require` for RDS-class deployments. When a `prefer`
> connection *does* fall back to plaintext, `PgConn`/`PgPool` print a
> one-line `[pq] tls: sslmode=prefer negotiated PLAINTEXT ...` notice so
> the downgrade is observable, not silent.

> **Hostname vs IP literal.** Pass a DNS hostname (not an IP literal) as
> `host` under `require`/`verify-full` — TLS SNI
> (`SSL_set_tlsext_host_name`) is sent for both, and `verify-full`'s
> hostname check (`SSL_set1_host`) has DNS-name semantics; an IP literal
> skips SNI's benefit and can behave unexpectedly under hostname
> verification.

> **Pool homogeneity.** `PgPool` assumes every pooled connection
> negotiates the same transport (it derives one `pool_tls` from
> connection 0 and threads it into every pooled op). `disable` /
> `require` / `verify-full` guarantee that structurally; only `prefer`
> against a non-uniform backend (e.g. a load-balanced/proxied endpoint)
> could violate it — `open()` detects a mismatch on any connection after
> the first and fails the whole pool closed rather than risk driving a
> connection's handle through the wrong transport.

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
