# pond/pq — friction log

No open contract deviations. Satisfies `db::DbDriver`; `hale check`
clean in-repo.

## Notes / forward work

- **Pool transactions are no-ops.** `PgPool.{begin,commit,rollback}`
  return a "n/a (pool)" `Status` and `tx_status()` is `"n/a (pool)"`.
  A transaction must pin a single connection across statements, which
  the round-robin pool doesn't guarantee — use a `PgConn` directly for
  transactional work. Lifting this needs a checkout/checkin handle
  that holds one `PgConn` for the transaction's span; deferred until a
  workload needs pooled transactions.
- **In-repo build vs check.** `hale check pq` typechecks standalone.
  `hale build` of a *consumer* resolves `import "vendor/pond/db"`
  against a vendored tree (F.26); inside this repo there is no
  `vendor/` dir, so build a consumer that has vendored both seeds
  rather than building `pq` in place.
- **examples/ pending.** A demo needs a reachable Postgres; add a
  docker-compose-backed `examples/pgwire-roundtrip/` when the harness
  for ephemeral-pg-in-CI lands.
