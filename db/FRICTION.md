# pond/db — friction log

No open contract deviations. The seed is interface + value-shape
types only and `hale check`s clean.

## Notes / forward work

- **F.20 interfaces are non-fallible by design.** `DbDriver` methods
  can't declare `fallible(E)` (the grammar has no fallible clause on
  interface method signatures). This is intentional — errors ride the
  result structs' `ok` / `err` fields (the Go `(result, error)`
  shape). Not a deviation; the canonical pattern for a driver
  abstraction in Hale.
- **`pond/sqlite` does not yet satisfy `DbDriver`.** sqlite is on the
  BLOCKED chain (`std::db::sqlite::*`, F.1) and still ships its query
  ops as free fns rather than the `DbDriver` method set. Bringing
  `sqlite::Db` onto the interface is part of the F.1 unblock pass.
  `pond/pq`'s `PgConn` / `PgPool` already satisfy it.
- **examples/ pending.** Per pond design rule #2 a lib ships a
  runnable demo; db's demo is naturally combined with a driver, so it
  lives with `pond/pq` (a bare-interface demo has nothing to dial).
