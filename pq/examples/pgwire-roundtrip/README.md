# pgwire-roundtrip — live pq auth + query gate

Opens a real `pq::PgConn`, authenticates, runs a query, prints the
result. Covers both auth paths:

- **SCRAM-SHA-256** — when a password is supplied.
- **trust** — when the password is empty.

This is the live gate for the SCRAM work (the offline crypto/codec is
covered by `pq/tests/scram_test.hl` + `pq/tests/wire_test.hl`). It is
**not** wired into `hale run pq/tests/...` because it needs a server
and pond's test runner has no skip mechanism — per repo convention,
live cases live in `examples/`.

## Why the vendor tree

`pq` imports `vendor/pond/db`, which only resolves inside a vendored
consumer tree whose root has a `hale.toml` (FRICTION.log § pond/pq,
"In-repo build vs check"). So this example ships `main.hl` +
`hale.toml` and materializes `vendor/` at run time (git-ignored).
Symlinks into the live seeds keep it tracking local edits:

```sh
cd pq/examples/pgwire-roundtrip
mkdir -p vendor/pond
ln -sfn ../../../../../db vendor/pond/db
ln -sfn ../../../../../pq vendor/pond/pq
```

## Run

Bring up a SCRAM postgres (and a trust one for the regression check):

```sh
docker run -d --name pond-scram-test -p 55433:5432 \
  -e POSTGRES_PASSWORD=testpass \
  -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
  -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 postgres:18

docker run -d --name pond-trust-test -p 55434:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18
```

Build and exercise all three paths:

```sh
hale build .

# 1. SCRAM, correct password -> OPEN OK + row
./pgwire-roundtrip 127.0.0.1 55433 postgres testpass postgres

# 2. SCRAM, wrong password -> clean auth_failed, fast (no retry storm)
./pgwire-roundtrip 127.0.0.1 55433 postgres WRONGPW postgres

# 3. trust (empty password) -> OPEN OK + row (regression gate)
./pgwire-roundtrip 127.0.0.1 55434 postgres "" postgres
```

`argv`: `[host] [port] [user] [password] [database] [sql]`. With no
args it defaults to the SCRAM container above.

Clean up:

```sh
docker rm -f pond-scram-test pond-trust-test
```

## Expected output

```
# 1. correct SCRAM password
connect 127.0.0.1:55433 db=postgres user=postgres auth=SCRAM-SHA-256
OPEN OK  tx_status=idle
QUERY OK  1 row(s)
pgwire-roundtrip-ok	postgres
CLOSED — roundtrip complete

# 2. wrong password (fails closed, ~1 attempt, no hang)
connect 127.0.0.1:55433 db=postgres user=postgres auth=SCRAM-SHA-256
OPEN FAILED [auth_failed]: auth: password authentication failed for user "postgres"

# 3. trust
connect 127.0.0.1:55434 db=postgres user=postgres auth=trust
OPEN OK  tx_status=idle
QUERY OK  1 row(s)
pgwire-roundtrip-ok	postgres
CLOSED — roundtrip complete
```
