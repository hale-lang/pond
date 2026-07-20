# pond/http/client

> **Promoted**: this client was promoted into the hale stdlib as
> `std::http` (client + router, 2026-07-17) — new code should use
> `std::http::get` / `std::http::Client` directly, and this copy
> should track the stdlib, not fork from it. (The chunked
> transfer-decoding fix of 2026-07-20 is mirrored in both.)

HTTP/1.1 client built on `std::io::tcp::*` plus
`std::io::tls::*`. Exposes `get` / `post` / `request` free fns
for one-shot calls, plus a `Client` locus with a connection-
pool slot set and retry-with-backoff for callers that want a
stable per-host handle. Every entry point — the free fns AND
the `Client` methods — returns `Response fallible(HttpError)`
per the contract (the pre-v0.8.1 `last_error_*()` accessor
workaround was retired 2026-06-08; the as-built surface equals
CONTRACTS.md).

Both `http://` and `https://` URLs work — the scheme picks
between plain TCP and TLS at connect time, and the
internal `__HttpConn` wrapper dispatches `send_bytes` /
`recv_bytes` to the right substrate. Hostnames resolve via
getaddrinfo (`std::io::tcp::connect`, upstream C6).

Suggested import alias: `http`.

```hale
import "vendor/pond/http/client" as http;

let r = http::get("https://example.com/") or raise;
println("status=", r.status, " body=", std::str::from_bytes(r.body));
```

See [`examples/get-demo/`](./examples/get-demo/) for a runnable
end-to-end demo.
