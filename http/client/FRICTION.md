# FRICTION — pond/http/client

Log of language / stdlib gaps, duplication suspicions, and
contract deviations encountered while building this lib.

## Contract deviations vs CONTRACTS.md

### `Client` methods cannot be `fallible(HttpError)`

The contract surface lists:

```hale
locus Client {
    fn get(url: String) -> Response fallible(HttpError);
    fn post(url: String, body: Bytes, content_type: String) -> Response fallible(HttpError);
    fn request(req: Request) -> Response fallible(HttpError);
}
```

This conflicts with the v1 two-channel rule
(`hale/spec/semantics.md` § "Fallible call semantics" §
"Where each channel lives"): user-declared locus methods CANNOT
declare `fallible(E)`. The typechecker rejects it.

**Workaround.** `Client.get` / `.post` / `.request` return
`Response` directly (no `fallible` marker). On failure they
write the error into `self.last_kind` / `self.last_status` /
`self.last_detail` and return a sentinel `Response { status: 0
}`. Callers check `r.status > 0` and consult
`c.last_error_kind()` / `.last_error_status()` /
`.last_error_detail()` if status is 0.

Agents that want value-channel `or raise` propagation should
use the free-fn surface (`http::get`, `http::post`,
`http::request`) — those are `fallible(HttpError)` per the
contract.

**Recommended CONTRACTS.md update:** drop the `fallible(HttpError)`
marker from `Client` methods; document the `last_error_*()`
accessors. Will hold off on editing CONTRACTS.md per the lib
rules ("STOP and log it in your FRICTION.md").

## Language / stdlib gaps

### ~~`b""` / `b"..."` bytes literals don't lex~~

**closed 2026-05-17** by upstream `894f393` (C10). `b"..."`
now lexes as a Bytes literal with the same escape set as
String literals (NUL-safe, `\xNN` over the full 0x00..0xFF
range). The `std::bytes::from_string("...")` workaround in
`client.hl` (3 sites — `__empty_response`, free-fn `get`,
`__client_get_fallible`) collapsed to `b""` on 2026-05-18; the
single residual site in `wire.hl` (`__parse_response`'s empty-
body sentinel) was flipped at the same time. Original entry
retained below for context.

`spec/grammar.ebnf` § 15 lists `BYTES_LIT` as
`?b"..."?` but the lexer
(`crates/hale-syntax/src/lexer.rs`) never emits `BytesLit` — the
parser handles the token (`parser.rs:2825`) but no lex path
produces it. Source like `let x: Bytes = b"";` parses as ident
`b` followed by string literal `""`, which is a parse error.

**Workaround.** Use `std::bytes::from_string("")` for empty
Bytes (and `std::bytes::from_string(s)` for non-empty). Worked
fine for our needs; cost is one path-call per literal.

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

### ~~No DNS resolution in `std::io::tcp::connect`~~

**closed 2026-05-17** by upstream `937393f` (C6).
`std::io::tcp::connect(host, port)` now falls back to
`getaddrinfo` (AF_INET) when the host isn't a numeric IPv4
literal. Hostnames like `"httpbin.org"` resolve directly; the
demo's numeric-IP restriction no longer applies. Original entry
retained below for context.

`lotus_tcp_connect` only accepts IPv4 dotted-quad hosts (uses
`inet_pton(AF_INET, ...)`). A hostname like `"httpbin.org"`
fails with `errno = EINVAL` and the diagnostic
`lotus_tcp_connect: invalid host httpbin.org`.

This is a serious limitation for an HTTP client — most real-
world URLs use hostnames. The demo is restricted to numeric
IPs as a result.

Path forward (compiler-level): `lotus_tcp_connect` could
fall back to `getaddrinfo(host, port_str, hints={AF_INET,
SOCK_STREAM})` when `inet_pton` fails. Outside the bounds of
this lib (`crates/` is compiler territory).

### ~~No TLS / HTTPS~~

**closed 2026-05-18** by upstream `e9a99df` (TLS client surface +
m105 adapter inbound dispatch). `std::io::tls::*` ships with
`connect(host, port) -> Int fallible(IoError)` (SNI set
internally from `host`), plus `send_bytes` / `recv_bytes` /
`close`. Wired on 2026-05-18: `client.hl` branches on
`u.scheme == "https"` between `std::io::tcp::connect` and
`std::io::tls::connect`; the new `__HttpConn` wrapper locus in
`wire.hl` dispatches `send_bytes` / `recv_bytes` to the right
substrate and routes `dissolve()` to the matching close. The
old `unsupported_scheme` guards on the free-fn surface now
gate only on "scheme is neither http nor https".

### ~~No Bytes-concat / Bytes-builder primitive~~

**closed 2026-05-17** by upstream `894f393` (C10).
`std::bytes::builder_new` / `builder_append` (Bytes chunk) /
`builder_finish` shipped. Flipped in `wire.hl` on 2026-05-18:
`__recv_response_bytes` now accumulates raw Bytes chunks
directly (no str-builder round-trip, no `from_bytes` NUL-
truncation risk). Original entry retained below for context.

We accumulate response bytes via `std::str::builder_*`, then
convert to Bytes at the boundary with
`std::bytes::from_string(builder_finish(buf))`. This works for
HTTP bodies that are eventually-text or that fit in one
recv chunk, but it round-trips through a NUL-truncation surface
(`from_bytes` → `builder_append`) for every chunk.

For binary HTTP responses with embedded NUL bytes (common in
images, gRPC frames, etc.), the current shape may lose bytes.
A `std::bytes::builder_new` / `builder_append_bytes` /
`builder_finish_bytes` primitive (mirroring the String builder
shape) would close this. The body slicing at the end uses
`std::bytes::slice` on the original raw blob, so the body half
DOES survive — only chunked-stream-with-embedded-NULs is at
risk.

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
