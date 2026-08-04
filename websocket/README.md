# pond/websocket — RFC 6455 client + server-side upgrade

> **Upstream unblock (hale > v0.11.9):** `std::http` now ships the
> connection-takeover surface this library's server side was
> waiting on — `req.conn_fd` + `Response { takeover: true }` +
> `Stream.release_fd()`. A handler can answer
> `101 Switching Protocols` behind a plain `std::http::Server` and
> hand the live fd to a session locus; no hand-rolled accept loop
> needed. Stdlib promotion of this library can now follow.
> **Demonstrated (2026-08-04):** `examples/upgrade-server/` runs
> that exact shape end-to-end in one binary — pinned
> `std::http::Server` + takeover handler publishing the fd to a
> pinned `WsServerConn { handshake_done: true }` echo session,
> driven by this lib's own `WsClient`.

Suggested import alias: **`ws`**

```hale
import "vendor/pond/websocket" as ws;
```

A synchronous, owner-driven WebSocket client locus. The library
is a passive wrapper around the socket — your code's `run()` loop
calls `read_msg()` and reads the parsed frame via the exposed
contract; the library never owns a thread, never publishes to the
bus on the inbound path. Configuration surface mirrors
[github.com/rileyr/apic](https://github.com/rileyr/apic) — URL,
headers, auto-reconnect, max retries, backoff, ping/pong cadences —
but the driver is inverted: the consumer drives.

## Quick start

```hale
import "vendor/pond/websocket" as ws;

// Pin the owner on its own thread via the app's main-locus
// `placement { tap: pinned(core = N); }` (F.31); a single-locus
// demo like this just runs on the main thread.
locus EchoTap {
    run() {
        let conn = ws::WsClient {
            url:            "wss://echo.websocket.events",
            auto_reconnect: true,
            max_retries:    -1,
            ping_interval:  30s,
            pong_timeout:   10s,
            recv_chunk:     4096,
        };

        if !conn.open() {
            println("open failed: ", conn.last_error.detail);
        }

        conn.send_text("hello from pond/websocket") or discard;

        // Owner-driven recv loop. Zero copy from conn's arena
        // into the dispatch handler (typed contract read).
        let mut seen = 0;
        while seen < 5 {
            if conn.read_msg() {
                println("got: ", conn.last_message.text);
                seen = seen + 1;
            } else {
                println("err: ", conn.last_error.kind,
                        " ", conn.last_error.detail);
                seen = 99;
            }
        }

        conn.close() or discard;
    }
}

fn main() { EchoTap { }; }
```

## Why this shape

Blocking I/O in Hale belongs on the **owner's** scheduler, not in
a hidden thread inside the library. The owner-Σ:

- gets its thread placement from the app's main-locus
  `placement { }` block (typically `pinned` for a dedicated thread,
  F.31),
- holds the connection locus as a child in its arena,
- drives `read_msg()` synchronously from its own loop,
- reads `conn.last_message` via the F.14 typed contract surface —
  same arena, single-pointer view, **zero copy**,
- decides what (if anything) hits the bus.

The library reuses `rx_buf` per recv and overwrites `last_message`
each `read_msg()` call. Steady-state memory is flat; no per-frame
accumulation. This is The Design's I3 / H4 / H10 applied to
blocking I/O.

## Surface

| Member         | Shape                                                                |
|----------------|----------------------------------------------------------------------|
| `WsMessage`    | type — `{ kind, text, bytes }`                                       |
| `WsError`      | type — `{ kind, detail }`                                            |
| `WsClient`     | locus — see below                                                    |
| `WsServerConn` | locus — server-side per-connection mirror (`server.hl`)              |
| `WsLogger`     | interface — `NoopWsLogger` / `StderrWsLogger` sinks (`loggers.hl`)   |

## `WsClient` locus

```hale
locus WsClient {
    params {
        url:               String;           // required
        extra_headers:     String   = "";
        auto_reconnect:    Bool     = true;
        max_retries:       Int      = -1;
        reconnect_initial: Duration = 1s;
        reconnect_max:     Duration = 30s;
        ping_interval:     Duration = 30s;
        pong_timeout:      Duration = 10s;
        recv_chunk:        Int      = 4096;
        // ... internal state (see client.hl)
    }
    contract {
        expose connected:        Bool;
        expose last_message:     WsMessage;
        expose last_error:       WsError;
        expose frames_received:  Int;
        expose frames_sent:      Int;
        expose reconnects:       Int;
    }

    fn open()                 -> Bool;
    fn read_msg()             -> Bool;
    fn send_text(s: String)   -> () fallible(WsError);
    fn send_bytes(b: Bytes)   -> () fallible(WsError);
    fn close()                -> () fallible(WsError);
}
```

The blocking owner-driven pumps (`open` / `read_msg`) return
`Bool` with details on `self.last_error` so run-loop predicates
stay clean; the owner-called send surface is `fallible(WsError)`
(v0.8.1 two-channel rule — see FRICTION.log).

### `open() -> Bool`

Explicit dial + TLS + WS handshake. Idempotent if already
connected. If `auto_reconnect = true`, internally retries up to
`max_retries` (with `reconnect_initial` delay between attempts —
exponential schedule is a FRICTION item) before giving up.

Generates a fresh `Sec-WebSocket-Key` (16 CSPRNG bytes via
`std::os::getrandom`, base64) per connect and validates the
server's `Sec-WebSocket-Accept` (RFC 6455 § 4.1). The wait for
the handshake response is bounded by `pong_timeout` — a server
that accepts the socket but never completes the upgrade fails the
connect with `last_error.kind = "timeout"`.

Returns true on success; false with `last_error` set on failure.

### `read_msg() -> Bool`

Blocks until either one complete data message lands in
`self.last_message`, or a fatal error is hit. Handles
transparently:

- peer pings → reply with pong, keep looping
- peer pongs → ignore, keep looping
- peer close → if `auto_reconnect`, reconnect + keep looping;
  else return false with kind `"close"`
- transient I/O drop → if `auto_reconnect`, reconnect + keep
  looping; else return false with kind `"io"`
- peer silence → liveness deadlines (below); dead peer either
  reconnects or returns false with kind `"timeout"`

Returns true with `self.last_message` set; false with
`self.last_error` set on fatal error.

### Liveness deadlines (`ping_interval` / `pong_timeout`)

Enforced as of 2026-06-12 via `std::io::{tcp,tls}::set_recv_timeout`
and the `-2` recv-timeout sentinel:

- A recv that sees no bytes for `ping_interval` (default 30s)
  triggers a proactive ping and re-arms the deadline to
  `pong_timeout` (default 10s).
- Any inbound bytes (not just a literal pong) re-arm
  `ping_interval`.
- Silence past the second deadline ⇒ peer presumed dead: socket
  torn down, then reconnect (`auto_reconnect`) or `read_msg`
  returns false with `last_error.kind = "timeout"`.
- Setting either to `0` disables that deadline (recv blocks
  indefinitely — the pre-2026-06-12 behavior).

So a half-open connection or a peer that stops answering can
stall `read_msg` for at most `ping_interval + pong_timeout`.

### `send_text(s)` / `send_bytes(b)` — `() fallible(WsError)`

Emit a single frame. Mask keys are drawn from
`std::os::getrandom(4)` per frame (RFC 6455 § 5.3). Address the
error channel with `or raise` / `or discard` / `or handler(err)`.

### `close() -> () fallible(WsError)`

Send an RFC 6455 close frame (opcode 0x8, best-effort) and tear
down the socket. After `close()`, `connected` is false and
`read_msg` / `send_*` will fail unless `open()` is called again.

## URL parsing

Accepts `ws://host[:port]/path` and `wss://host[:port]/path`.
Default ports: 80 for `ws`, 443 for `wss`. `wss` routes through
`std::io::tls::connect`; `ws` through `std::io::tcp::connect`.

IPv6 literal hosts (`[::1]:8080`) are not parsed at v1 — see
FRICTION.log.

## Pattern catalog

`WsClient` is a passive **connection wrapper** — a Service-locus
shape but without `run()`. Methods are synchronous; the owner's
loop drives. The owner is typically a **Service locus** (pattern
3) placed `pinned` (via the app's main-locus `placement { }` block,
F.31) so blocking reads don't starve the cooperative scheduler.

`parse_url` / `parse_frame` / `emit_frame` / `build_request` /
`parse_response` are **free fns** (pattern 6), testable in
isolation without a live socket.

## RFC 6455 compliance

- ✅ Handshake send (`GET … HTTP/1.1 + Upgrade: websocket`)
- ✅ Status-line validation (`HTTP/1.1 101 …`)
- ✅ Random `Sec-WebSocket-Key` (16 CSPRNG bytes per connect) +
  `Sec-WebSocket-Accept` validation (sha1 + base64; § 4.1)
- ✅ Frame parse / emit (text / binary / close / ping / pong)
- ✅ Fragmentation reassembly (continuation frames → one
  `WsMessage` after FIN)
- ✅ Client→server masking with per-frame CSPRNG keys (§ 5.3)
- ✅ Ping auto-reply (server pings get a pong with same payload)
- ✅ Proactive pings + pong-deadline liveness on both loci
  (`ping_interval` / `pong_timeout`, enforced 2026-06-12)
- ✅ Server-side upgrade + unmasked server-shape framing
  (`WsServerConn`; mirrors the client surface, plus
  `handshake()` and the same liveness cadences)
- ⚠️ Frames > 2³¹ bytes rejected (no Int64 wide math at v1).

## Examples

```bash
hale build pond/websocket/examples/echo-client/
./pond/websocket/examples/echo-client/echo-client
# or against a local server:
./pond/websocket/examples/echo-client/echo-client ws://127.0.0.1:9001/
```

The example connects to `wss://echo.websocket.events` (or the
`ws://` / `wss://` URL passed as argv[1]), sends a few text
frames, prints the echoes, and exits.

## Files

- `types.hl` — `WsMessage`, `WsError`, `WsLogEvent`, `WsLogger`
- `frame.hl` — RFC 6455 frame parse + emit + opcode mapping
- `handshake.hl` — HTTP/1.1 upgrade request/response (client) +
  upgrade parse / accept compute / 101 response (server)
- `client.hl` — `WsClient` locus + `parse_url`
- `server.hl` — `WsServerConn` per-connection server locus
- `loggers.hl` — `NoopWsLogger` / `StderrWsLogger` sinks
- `examples/echo-client/main.hl` — runnable echo demo
- `examples/upgrade-server/main.hl` — server-side upgrade behind
  `std::http::Server` (takeover + bus fd-handoff + echo session +
  in-process client; run-to-exit, prints `demo: OK`)
- `FRICTION.log` — gaps, deviations, substrate asks

## Cross-references

- `pond/http/client/README.md` — sibling lib for one-shot HTTP.
- `std::io::tcp::*` / `std::io::tls::*` — underlying socket
  primitives.
