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

Bring up three postgres containers — a TLS+SCRAM one (self-signed
cert), a plaintext SCRAM one, and a plaintext trust one:

```sh
# self-signed cert for the TLS server; the key must be 0600 and owned
# by the container's postgres uid (999).
mkdir -p /tmp/pgcerts && cd /tmp/pgcerts
openssl req -x509 -newkey rsa:2048 -nodes -keyout server.key -out server.crt \
  -days 1 -subj "/CN=localhost"
chmod 600 server.key && sudo chown 999:999 server.key server.crt

# 1. TLS + SCRAM (:55435)
docker run -d --name pond-tls-scram -p 55435:5432 \
  -e POSTGRES_PASSWORD=testpass \
  -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
  -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
  -v /tmp/pgcerts/server.crt:/etc/pg/server.crt:ro \
  -v /tmp/pgcerts/server.key:/etc/pg/server.key:ro \
  postgres:18 \
  -c ssl=on -c ssl_cert_file=/etc/pg/server.crt -c ssl_key_file=/etc/pg/server.key

# 2. plaintext SCRAM (:55433)
docker run -d --name pond-scram-plain -p 55433:5432 \
  -e POSTGRES_PASSWORD=testpass \
  -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
  -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 postgres:18

# 3. plaintext trust (:55434)
docker run -d --name pond-trust-plain -p 55434:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18
```

Build and exercise every negotiation path:

```sh
hale build .
Q="SELECT 'ok' AS msg, current_user AS usr"

# --- TLS + SCRAM (:55435) ---
# require + correct pw -> OPEN OK tls=true + row
./pgwire-roundtrip 127.0.0.1 55435 postgres testpass postgres "$Q" require
# require + wrong pw -> clean auth_failed (over TLS), fast
./pgwire-roundtrip 127.0.0.1 55435 postgres WRONGPW postgres "$Q" require
# verify-full vs self-signed CA -> clean tls handshake failure, fast
./pgwire-roundtrip localhost 55435 postgres testpass postgres "$Q" verify-full
# PgPool over TLS: 3 conns, 4 round-robin queries
./pgwire-roundtrip 127.0.0.1 55435 postgres testpass postgres "$Q" require pool

# --- plaintext SCRAM (:55433) ---
# prefer  -> plaintext fallback ('N'), OPEN OK tls=false + row
./pgwire-roundtrip 127.0.0.1 55433 postgres testpass postgres "$Q" prefer
# require -> fail closed (no downgrade), fast
./pgwire-roundtrip 127.0.0.1 55433 postgres testpass postgres "$Q" require
# disable -> no SSLRequest, OPEN OK tls=false + row
./pgwire-roundtrip 127.0.0.1 55433 postgres testpass postgres "$Q" disable

# --- trust regression (:55434) ---
./pgwire-roundtrip 127.0.0.1 55434 postgres "" postgres "$Q" prefer
```

`argv`: `[host] [port] [user] [password] [database] [sql] [sslmode] [mode]`.
`sslmode` defaults to `prefer`; `mode` is `conn` (default) or `pool`.
With no args it defaults to the plaintext SCRAM container above.

Clean up:

```sh
docker rm -f pond-tls-scram pond-scram-plain pond-trust-plain
```

## Expected output

```
# require + correct pw over TLS
connect 127.0.0.1:55435 db=postgres user=postgres auth=SCRAM-SHA-256 sslmode=require mode=conn
OPEN OK  tls=true tx_status=idle
QUERY OK  1 row(s)
ok	postgres
CLOSED — roundtrip complete

# require against a plaintext server -> fail closed (never downgrades)
connect 127.0.0.1:55433 ... sslmode=require mode=conn
OPEN FAILED [tls]: ssl: server does not support TLS but sslmode=require requires it (refusing to downgrade)

# verify-full vs self-signed cert -> handshake fails (verification wired)
connect localhost:55435 ... sslmode=verify-full mode=conn
OPEN FAILED [tls]: ssl: TLS handshake failed to localhost (sslmode=verify-full)

# PgPool over TLS
POOL OPEN OK  n=3 pool_tls=true
POOL QUERY 0 OK  1 row(s): ok	postgres
...
POOL CLOSED — 4 queries over 3 TLS-pooled conns complete
```
