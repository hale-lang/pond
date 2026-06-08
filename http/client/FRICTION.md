# FRICTION — pond/http/client

Log of language / stdlib gaps, duplication suspicions, and
contract deviations encountered while building this lib.

## Contract deviations vs CONTRACTS.md

### `Client` methods cannot be `fallible(HttpError)` — [CLOSED 2026-06-08]

**2026-06-08 resolution.** Migrated to the v0.8.1 two-channel rule
(#24 v0.2, commits `d565d6f` + `98910b9`). `Client.get` / `.post` /
`.request` now declare `fallible(HttpError)` directly and match the
free-fn surface in CONTRACTS.md verbatim. Removed the entire
workaround: the `last_kind` / `last_status` / `last_detail` scratch
params, the `last_error_kind()` / `last_error_status()` /
`last_error_detail()` accessors, the `__record_err` bridge, and the
`__client_{get,post,request}_fallible` free-fn mirrors (their bodies
folded straight into the methods). No deviation remains; the as-built
surface equals the contract. Callers address the value channel with
`or raise` / `or <substitute>` / an error-check fn.

**2026-05-27 (historical).** Upstream v0.8.1 narrowed the two-channel
rule so user-declared `fn` member fns can carry `fallible(E)` with
heap-bearing payloads; this entry tracked the pending source pass that
the 2026-06-08 migration above completed.

## Language / stdlib gaps

### `or` clause needs an expression, not a statement; can't `fail`

`spec/grammar.ebnf`:
`or_clause = "or" , ( "raise" | "discard" | or_disposition_expr ) ;`

So `or fail SomeError { ... }` doesn't parse — `fail` is a
statement. To translate from one fallible-payload type to
another (e.g. `IoError` from `std::io::tcp::connect` to
`HttpError`), the idiom is:

```hale
fn __raise_connect(e: IoError, host: String, port: Int) -> Int fallible(HttpError) {
    fail HttpError { kind: "connect_failed", ... };
}

fn __dial(host: String, port: Int) -> Int fallible(HttpError) {
    let fd = std::io::tcp::connect(host, port)
        or (__raise_connect(err, host, port) or raise);
    return fd;
}
```

A `fail`-as-expression (or `or fail X { ... }` sugar) would let
the helper fn collapse to one line.

### Cross-seed `const` lookups don't resolve at codegen

Declaring `const FOO: String = "...";` in the lib seed and
referencing `http::FOO` from a consumer fails at codegen:

```
codegen error: unsupported in codegen v0: unknown identifier
  `__lib_http_client_DEFAULT_USER_AGENT`
```

The mangler renames the const symbol but the codegen ident
resolver doesn't look it up. Worked around by inlining the
literal at every use site. Untested whether intra-seed
references work; we didn't need them.

### `len()` overload across String and Bytes

`len()` works on both String (strlen-style) and Bytes (length-
prefix). The dispatch happens at the typechecker. This is
fine but worth noting — agents reaching for `b.length` or
`std::bytes::len(b)` won't find them.

## Duplicate-suspected helpers

### `__find_header` (wire.hl)

Duplicates `__http_request_header` from
`hale/runtime/stdlib/http.hl`. Same packed-CRLF block
shape, same case-insensitive lookup, same trim-leading-
whitespace logic. The stdlib version operates on
`std::http::Request.headers`; ours operates on a free String.

duplicate-suspected: `__find_header` — may belong in a shared
http-header util (perhaps `std::http::find_header(headers: String,
name: String) -> String` as a path-call sibling to
`std::http::header(req: Request, name: String)`).

### URL parsing (url.hl)

`parse_url` is self-contained but generally useful — any other
pond lib that needs to address resources by URL (`pond/agent/llm`,
webhook receivers, `pond/sessions` for redirect-back, etc.)
will want the same Url shape.

duplicate-suspected: `parse_url` + the `Url` type — may belong
in a shared `pond/url/` or `pond/util/` lib so multiple HTTP-
adjacent libs don't each redeclare it.

### Connection-pool LRU (client.hl)

The fixed-cap parallel-array LRU in `Client` is a hand-rolled
shape. Any lib that holds a small set of long-lived resources
(file handles, DB connections, websockets) will want the same
shape.

duplicate-suspected: LRU pool — may belong in a future
`@form(lru_cache, max = N)` form or a `pond/util/lru/` lib.
The hand-rolled shape works at v1 but doesn't compose.

## Out-of-scope notes

### Connection pooling is mostly cosmetic at v1

Because we send `Connection: close` (matching the stdlib's
`std::http::write_response` shape), the server closes the
socket after every response. The cached fd in our pool would be
a dead fd — actual reuse needs `Connection: keep-alive` plus a
post-response read-eof check before re-using a cached fd. Left
as v1.x work; the param slots are wired so flipping it doesn't
need a params-block change.

### Retry backoff is fixed at 50ms doubling

`std::time::sleep` takes a `Duration`, and Duration arithmetic
at runtime (`backoff_ms * 2` and then turning that back into a
Duration literal) is awkward — Hale doesn't have an
`int_to_duration(ns)` primitive that I could find. We loop with
a hardcoded `50ms` sleep at v1; the `backoff_ms` field is
updated for diagnostic visibility only. A future revision should
either thread `Duration` arithmetic or expose
`std::time::sleep_ns(n: Int)` for parametric backoff.
