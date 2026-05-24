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

## substrate gap: pong-deadline wall-clock tracking

`pong_timeout` is in the public surface (default 10s) but the
recv loop doesn't enforce it yet. The pump counts inbound pongs
but doesn't track wall-clock time since last ping; a stale
connection (peer never responds to ping) hangs the recv until
the underlying TCP recv times out (could be minutes on a poor
network).

Three substrate primitives would close this:

1. `std::time::now() -> Int` wall-clock — same gap pond/sessions
   + pond/agent/conversation flagged.
2. `std::io::tcp::recv_bytes_timeout(sock, n, ms)` — a
   timeout-aware recv variant. Currently `recv_bytes` blocks
   indefinitely.
3. Or: a way to inject a "ping tick" deadline closure on the
   pinned recv loop.

Until one lands, `pong_timeout` is documentary. Logged as
v1.1 follow-up.

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

## deviation from CONTRACTS.md: no `fallible(WsError)` on locus methods

Per AGENTS.md's two-channel rule (locus methods can't declare
fallible(E)), `send_text` / `send_bytes` / `close` are
Bool-returning rather than fallible. Failure surfaces via the
value channel:

```hale
let ok = client.send_text("hello");
if !ok {
    let e = client.last_error;
    println("send failed: kind=", e.kind, " detail=", e.detail);
}
```

A free-fn wrapper `send_text_checked(c: WsClient, s: String)
-> Bool fallible(WsError)` could re-encode this for `or raise`
ergonomics; not provided in v1 (the apic reference Go uses
`(bool, error)` so the Bool-plus-last_error shape is
intentional).

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

## substrate gap: per-frame Bytes allocations accumulate

**Observation**: with the post-2026-05-19 owner-driven shape (no
auto-loop, no bus dispatch, Tap owns WsClient as a child locus,
recv loop in Tap's `run()` body), RSS still grows linearly under
load. Measured against a high-volume exchange feed with the dual-channel benchmark channel mix
channels and a heartbeat:

    elapsed=200s  rss=20MB→86MB  rate ≈ 336 KB/s

That's ~1.3 GB/hour — the same order of magnitude as the
pre-refactor shape (~220 KB/s) which had bus-dispatch memcpy on
top. Removing the bus path did NOT flatten memory. The leak is
upstream of the bus.

**Suspected mechanism**: every inbound frame triggers several
fresh Bytes allocations inside the recv loop:

```hale
// client.hl, read_msg()
self.rx_buf = std::bytes::concat(self.rx_buf, chunk);   // new alloc
// try_peel_one()
self.rx_buf = std::bytes::slice(self.rx_buf, pf.total, total); // new alloc
self.frag_buf = pf.payload;                              // (slice ref)
self.last_message = WsMessage { ... };                   // new struct
self.frag_buf = std::bytes::from_string("");             // new alloc
```

Each replaced field's prior allocation appears to stick in the
WsClient locus's arena until the locus dissolves. With ~50 msg/s
on exchange book feed, the ~5-6 fresh allocations per frame compound
at the rate observed. The hypothesis matches what an arena-bump
allocator would do with no per-iteration reset hook.

**Why this is substrate not library**: the library is already
doing the right thing — reusing field names, structuring the loop
so the maximum live-set is one frame's worth of state. There's no
library-level rewrite that avoids fresh allocations as long as
`std::bytes::concat` / `slice` / `from_string` return freshly
allocated Bytes and field-replacement doesn't reclaim the prior
value.

**Substrate primitives that would close this**:

1. **In-place Bytes ops**: `std::bytes::append_into(&mut buf,
   chunk)`, `std::bytes::shift_front(&mut buf, n)` (memmove the
   tail to the head, truncate), `std::bytes::clear(&mut buf)`.
   With these, the recv loop reuses a single rx_buf allocation
   that stabilizes at max-frame-size.
2. **Per-iteration scratch arena**: a way for a locus to declare
   a region that resets at the top of each iteration of its run()
   body. Allocations made inside that region are reclaimed on the
   next iteration regardless of where they were stored.
3. **Reference-counted Bytes with explicit reclamation**: when
   `self.rx_buf = X` overwrites the prior buffer, the prior
   allocation's refcount drops; if zero, it's reclaimed
   immediately. Standard refcount model.

(1) is the most surgical — it can be added without changing the
allocator. (2) is the most powerful but requires runtime
support. (3) changes the global allocation model.

**Repro**:
```bash
cd <consumer-app>
./apps/ws-spike/ws-spike crypto pair 60
# poll /proc/$pid/status VmRSS in another shell
```

See `apps/ws-spike/mem-NEW-owner-driven.tsv` and
`apps/ws-spike/mem-OLD-prerefactor-burn.tsv` for the two TSV
traces. Both grow linearly; the new shape is actually slightly
faster (336 vs 220 KB/s) because the bus-memcpy back-pressure
is gone.

**Implication for mdgw stability target**: 48h of uninterrupted
ingest requires either a substrate fix here OR a process-recycle
escape hatch (kill + respawn the gateway every N minutes) — both
unattractive. Flagging as a Phase-0 blocker for HYPERLOOP-MDGW.

**Phase-0 follow-up (2026-05-19)**: compiler session shipped the
four in-place builder ops (`builder_shift_front` / `_clear` /
`_snapshot` / `_free` — commit `a4d3862`). I refactored
client.hl to use them: rx_buf + frag_buf are now long-lived
builders, allocated in `birth()`, freed in `dissolve()`. The
concat/slice/from_string churn in the locus arena is gone.

**But the burn is still leaking**: with the new builder API,
RSS grows at ~486 KB/s on the high-throughput benchmark feed — same
order of magnitude as before, sometimes slightly worse. Trace
in `apps/ws-spike/mem-BUILDER-api.tsv`.

**Why**: the leak moved from the locus arena to the **bus
payload arena**. Every per-frame materialization lands there
and the spec explicitly calls it "program-lifetime":

```
- self.rx_buf snapshot before parse_frame  → 1 bus-arena alloc
- parse_frame's internal builder_finish    → 1 bus-arena alloc
- last_message frag_buf snapshot on FIN    → 1 bus-arena alloc
```

≈3 allocs × ~50 frames/s × frame payload sizes = ~500 KB/s,
matching observed.

**Attempted optimization**: tried passing the builder handle
directly to `parse_frame` (skipping the rx_buf snapshot, since
the builder and Bytes share `cap/len/buf` layout per the commit
msg). **Runaway: RSS blew to 5.7 GB → 8.3 GB in 5 seconds.**
Either `std::bytes::at` or `len` against a builder handle reads
the wrong struct field. Builder ABI is NOT call-site compatible
with regular Bytes ops. Reverted; staying with `builder_snapshot`
as the documented materialization step.

**What the substrate still needs (substrate gap 2 — Phase-1)**:

The Phase-0 in-place builders fix the *accumulator* case
(long-lived buffer that recycles its allocation). They do not
fix the *materialization* case (per-frame payload bytes that
need to be a real Bytes value for the consumer to read). For
a recv loop to be memory-flat, every per-frame `Bytes` value
needs a reclamation path:

1. **Refcounted Bytes in the payload arena** — when no live
   reference exists, reclaim. Most general. Requires runtime
   plumbing on every Bytes-typed slot in user-defined types
   (`last_message.bytes`, `last_message.text`, `pf.payload`,
   etc.).
2. **Per-iteration reclaim scope** — a user-controlled
   "release point" the locus calls at the top of each
   `read_msg` body. Bus-payload allocations made since the
   last release point are freed. Lighter-weight than (1) but
   requires the consumer's reads to not outlive the iteration.
3. **In-place last_message slot** — WsClient's `last_message`
   field owns a single Bytes blob in its own arena; per frame
   the runtime overwrites the buffer in place, reusing the
   allocation. Consumer reads through the F.14 contract, which
   is the existing zero-copy view. Closest to the "vertical
   contract" mental model. Requires runtime support for
   "in-place Bytes-field assignment with reused storage".

Option (3) most directly matches the "owner-drives, library
shares memory via vertical contract" idiom we've been
designing toward. With it the recv path has *zero*
per-frame allocations: rx_buf in-place via builder,
frag_buf in-place via builder, last_message in-place via
field-swap. Substrate work isolated to the field-assignment
codegen.

This is a Phase-1 ask back to the compiler session.

**Phase-1 follow-up (2026-05-19)**: compiler session shipped the
`recv_into` family (commit `4ec2f1f`) and lifted the
`std::bytes::builder_*` free-fn surface into a `BytesBuilder`
locus (commit `6fe6925`). Refactored pond/websocket and ws-spike
to the new shape:

- `WsClient` no longer stores `rx_buf` / `frag_buf` — locus-typed
  fields aren't supported in codegen v0 (matches the `Db`-field
  deviation note in `pond/migrations/runner.hl`). Buffers are
  caller-owned `BytesBuilder` let-bindings in the owner's `run()`,
  threaded through `open(rx_buf)` and
  `read_msg(rx_buf, frag_buf)`. This is also the architecturally
  correct shape — libraries don't allocate on the I/O hot path;
  callers do.
- Recv path uses `std::io::tcp::recv_into(sock, rx_buf,
  recv_chunk)` / `std::io::tls::recv_into(...)`. Zero allocation
  at the syscall layer.
- `parse_frame` / `emit_frame` migrated to the BytesBuilder locus
  method surface (`b.append`, `b.finish`, etc.).

**Result**: ~135 KB/s sustained on the high-throughput benchmark feed
over 160s. **72% reduction** from the Phase-0 baseline (486
KB/s), matching the compiler-session commit message's ~80%
projection. Trace at
`<consumer-app>/<file>`.

**Still not flat**. 48h projection: ~23 GB. The residual leak
splits into three identified sites, all depositing into
`g_bus_payload_arena`:

1. `parse_frame`'s internal `bldr.finish()` —
   `pond/websocket/frame.hl:163`. One payload-sized blob per
   frame.
2. `rx_buf.snapshot()` per peel attempt —
   `pond/websocket/client.hl:297` (and `:451` for handshake
   accumulation). Needed because `parse_frame` reads via
   `std::bytes::at` + `len`, which fail at typecheck on a
   `BytesBuilder`. One rx_buf-sized blob per peel.
3. `frag_buf.snapshot()` on FIN —
   `pond/websocket/client.hl:337`. Needed to materialize
   `last_message.bytes` as a real Bytes for the consumer's F.14
   contract read. One payload-sized blob per delivered message.

**Phase-2 substrate ask** (in `<consumer-app>/<file>`):

- `BytesBuilder.view() -> Bytes` — non-owning Bytes pointing at
  the builder's `buf`/`len`. Kills site #2.
- In-place storage for locus Bytes/String fields (the "vertical
  contract / DMA" idiom). Kills site #3.
- Either builder read methods (`.at(i)`) OR a `peek_header +
  unmask_into` split in `parse_frame`. Kills site #1.

With all three, the recv hot path against `g_bus_payload_arena`
goes to zero allocs per frame. Projected: ~50 MB steady-state,
flat indefinitely.

**Phase-2 follow-up (2026-05-19 PM)**: compiler session shipped
commits `4b01e24` (`BytesBuilder.view()`) and `388f1d9` (locus-
typed param fields via F.29, plus follow-ups `04c16d0` and
`ede0826`). Refactored pond/websocket:

- `WsClient` now holds `rx_buf`, `frag_buf`, and a new
  `scratch_buf` (for control-frame payloads) as
  `BytesBuilder` child loci. Method signatures dropped the
  buffer params; `conn.open()` / `conn.read_msg()` again.
- `client.hl` swapped `snapshot()` → `view()` at the rx_buf
  and frag_buf sites, and deferred the `frag_buf.clear()`
  from post-FIN to the next data-frame branch so
  `last_message.bytes` (a view) survives the consumer's
  read window.
- `frame.hl` replaced `parse_frame` with `peek_header`
  (header-only parse, no allocation on incomplete-frame
  returns either) + `unmask_into(dest, b, off, len, masked,
  mk0..3)` (caller-provided destination builder). The
  unmasked-fast-path is `std::bytes::slice` + `dest.append`
  (one slice alloc per data frame); the masked-slow-path
  retains the byte-by-byte XOR + `from_int` loop (RFC 6455
  § 5.3 makes this path cold for client-side recv —
  servers don't mask client-bound frames).
- `try_peel_one` routes by opcode: control frames unmask
  into `scratch_buf` (small, recycled per ping); data
  frames unmask directly into `frag_buf`. Sites #1 and #3
  from above are closed entirely.

**Result**: ~25 KB/s sustained on the high-throughput benchmark feed
book(10) over 355s, 10170 frames received. **14x reduction
from session start** (340 KB/s); per-frame allocation dropped
from 4.22 KB to 0.87 KB (79%). Trace at
`<consumer-app>/<file>`.

**Remaining residual** (~0.87 KB/frame, two sites):

1. `std::bytes::slice` inside `unmask_into`'s unmasked
   fast path — one ~payload-size alloc in
   `g_bus_payload_arena` per data frame.
2. `std::str::from_bytes` inside `bytes_as_text` — one
   ~payload-size String alloc per delivered message
   (FIN data frames).

**Phase-3 substrate asks** (handed back at this point):

- `BytesBuilder.append_slice(src: Bytes, lo: Int, hi: Int)` —
  copy `src[lo..hi)` into the builder's tail without
  materializing an intermediate Bytes wrapper. Kills site #1
  entirely; the unmask_into fast path becomes
  `dest.append_slice(b, payload_off, payload_off + payload_len)`
  — zero payload-arena alloc.
- `String.view()` analog — either a `BytesBuilder.text_view()
  -> String` that returns a non-owning String aliasing the
  builder's bytes, or a way for `WsMessage.text` to be
  derived lazily from `.bytes` instead of materialized at
  construction. Kills site #2.

48h projection at current rate: ~4.3 GB. With Phase-3, would
go to genuine steady-state flat memory.

**Phase-3 follow-up (2026-05-20)**: compiler session shipped
commit `226d3bc` (`BytesBuilder.append_slice` +
`BytesBuilder.text_view`). Two surgical pond changes:

- `frame.hl::unmask_into` fast path collapsed from
  `slice + append` to `dest.append_slice(b, lo, hi)` — zero
  payload-arena alloc on the unmasked path.
- `client.hl::try_peel_one` FIN branch swapped
  `bytes_as_text(...)` for an inline `self.frag_buf.text_view()`
  when `frag_kind == "text"`. Zero payload-arena alloc on the
  delivered-message path.

**Result**: ~4.2 KB/s sustained over 511s on the benchmark feed
the dual-channel benchmark, 6300 frames received. Per-frame allocation
dropped to 0.34 KB. Trace at
`<consumer-app>/<file>`.

**81x reduction from session start** (340 KB/s → 4.2 KB/s).
48h projection: ~730 MB — practical for HYPERLOOP-MDGW's
stability target.

**Hot-path lib audit**: sweep of `pond/websocket/*.hl` confirms
no per-frame allocations against `g_bus_payload_arena` in
steady state:

- `peek_header` — stack-only, no allocation on success or
  incomplete-frame paths (replaces the `parse_frame` shape
  that allocated on every short-buffer return).
- `unmask_into` (unmasked fast path) — `append_slice` only,
  zero alloc.
- `text_view` / `view` — non-owning, zero alloc.
- `recv_into` — caller-provided destination, zero alloc.
- `send_text` / `send_bytes` / `emit_frame` — outbound, called
  only at startup (subscription frames) and on rare pings.
  Not steady-state.

The residual 0.34 KB/frame is **app-level**, not library:
ws-spike `println`s the full book payload on every data frame
(format buffer allocates per call), and the recv loop pulls
`std::time::monotonic()` once per iteration. Neither is a
pond/websocket concern; a production mdgw consumer with bus
publish + structured log emission would not hit them.

The library is **structurally zero-alloc** on the recv hot
path. Mission accomplished for the substrate work; pond's
done.

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
