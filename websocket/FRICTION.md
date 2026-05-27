# pond/websocket — FRICTION

Gaps, suspicions, and deviations from RFC 6455 surfaced while
building this lib.

## stdlib gap: SHA-1 + base64 for handshake validation

RFC 6455 § 4.1 requires the client to validate
`Sec-WebSocket-Accept` matches `base64(sha1(key + GUID))` where
GUID is the literal "258EAFA5-E914-47DA-95CA-C5AB0DC85B11" and
`key` is the random 16-byte value the client sent in
`Sec-WebSocket-Key`.

v1 stdlib has neither primitive:

- `std::crypto::sha1` does not exist (sha256 / hmac-sha256 are
  shipped via `pond/crypto`, but sha1 isn't).
- `std::str::base64_encode` / `base64_decode` don't exist;
  pond/crypto's `hex_encode` covers hex but not base64.

The lib ships with a deterministic `Sec-WebSocket-Key` value
(`"dGhlIHNhbXBsZSBub25jZQ=="` — the example key from RFC 6455
§ 1.3) and DOES NOT validate the server's accept header. The
protocol still functions (the accept value has no further role
once the upgrade completes), but the lib trusts the peer.

Production deployments MUST add `std::crypto::sha1` and
`std::str::base64_encode` upstream, then the handshake validator
becomes a 10-line free fn.

## stdlib gap: CSPRNG-seeded masking key

RFC 6455 § 5.3: "The masking key needs to be unpredictable.
Thus, the masking key MUST be derived from a strong source of
entropy, and the masking key for a given frame MUST NOT make it
simple for a server/proxy to predict the masking key for a
subsequent frame."

The lib's `mask_seed` advances via the same LCG
(`downstream-consumer::SyntheticFeed`) — non-cryptographic.
Real entropy would route through `std::os::getrandom` (shipped
2026-05-17 via upstream C4); a v1.1 polish pass should reseed
`mask_seed` from `getrandom(4)` at every `connect_once()`.

Practically: an attacker on the wire who could predict masks
could mount cache-poisoning attacks against caching proxies
that misinterpret the masked payload as a different protocol.
The threat model isn't load-bearing for an isolated client
talking to a known server; logged for transparency.

## substrate gap: pong-deadline wall-clock tracking — [CLOSABLE]

**2026-05-27 update.** v0.8.1 shipped `std::io::tcp::set_recv_timeout`
+ `set_send_timeout` (commit `1ab9f71`). The next source pass
wires `pong_timeout` to a per-recv-call deadline via
`std::io::tcp::set_recv_timeout(sock, pong_timeout_duration)`
before each `recv_bytes`. The "documentary-only" caveat below
retires.

**Current source shape (still in place).** `pong_timeout` is in
the public surface (default 10s) but the recv loop doesn't
enforce it. The pump counts inbound pongs but doesn't track
wall-clock time since last ping; a stale connection (peer never
responds to ping) hangs the recv until the underlying TCP recv
times out (could be minutes on a poor network).

## substrate gap: IPv6 literal hosts in URL parsing

`parse_url` splits host:port on the LAST `:` so IPv4 literals
(`127.0.0.1:8080`) stay intact, but IPv6 literals
(`[::1]:8080`) trip — the brackets aren't honored and the inner
colons fold into the port-parse failure path.

Resolution: bracket-aware split. Logged as a TODO; the demo
doesn't exercise IPv6.

## codegen gap: Bytes default in params

`params { rx_buf: Bytes; }` — the field has no default literal
because Hale v1 doesn't lex `b""` as a Bytes literal (G5 in
`pond/KNOWN_GOTCHAS.md`). The locus's `birth()` body initializes
`rx_buf` to `std::bytes::from_string("")` instead. Mirrors the
same workaround pond/subprocess and pond/http/client document.

Logged as G5 elsewhere; nothing this lib can do on its own.

## deviation from CONTRACTS.md: no `fallible(WsError)` on locus methods — [CLOSABLE]

**2026-05-27 update.** v0.8.1 narrowed the two-channel rule (#24
v0.2, commits `d565d6f` + `98910b9`); user-declared `fn` member
fns now carry `fallible(E)`. The next source pass restores
`WsClient.send_text` / `send_bytes` / `close` to
`fallible(WsError)` directly; the `last_error` field and the
Bool-return-plus-sentinel pattern collapse. Clean breaking
change — `or raise` / `or handler(err)` addressing is the new
shape.

**Current source shape (still in place).** Per the old (pre-v0.8.1)
two-channel rule, `send_text` / `send_bytes` / `close` are
Bool-returning rather than fallible. Failure surfaces via the
value channel:

```hale
let ok = client.send_text("hello");
if !ok {
    let e = client.last_error;
    println("send failed: kind=", e.kind, " detail=", e.detail);
}
```

## RFC 6455 conformance scope

The lib implements the **client-only** subset. Server-side
features deliberately omitted at v1:

- Server-mode framing (server MUST NOT mask; we always mask)
- Subprotocol negotiation (`Sec-WebSocket-Protocol`)
- Extensions (`Sec-WebSocket-Extensions`, including permessage-
  deflate — which would need an inflate primitive)
- Origin enforcement (server-side anti-CSRF gate)

`pond/websocket` is a client. A future `pond/websocket-server`
would share `frame.hl` (un-masked emit + mask validation) and
add an HTTP/1.1 upgrade router.

## suspected duplicate: arithmetic XOR-byte helper

`pond/_util/intfloat::xor8` is the only place pond computes
byte-wise XOR (v1 has no bitwise XOR in expression position —
G12 in `pond/KNOWN_GOTCHAS.md`). This lib uses it for both
frame mask + unmask. Same shape `pond/crypto::hmac_sha256` will
need if it ever lifts the XOR-byte primitive out of its inline
implementation.

A `std::math::xor8(a: Int, b: Int) -> Int` primitive (or surfacing
bitwise XOR at the language level) would let `_util/intfloat`
collapse. Logged.
