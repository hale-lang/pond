# pond/websocket — RFC 6455 client

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

locus EchoTap : schedule pinned {
    run() {
        let conn = ws::WsClient {
            url:            "wss://echo.websocket.events",
            auto_reconnect: true,
            max_retries:    -1,
            ping_interval:  30s,
            pong_timeout:   10s,
            recv_chunk:     4096,
            rx_buf:         std::bytes::from_string(""),
            last_message:   ws::WsMessage { },
            last_error:     ws::WsError { },
        };

        if !conn.open() {
            println("open failed: ", conn.last_error.detail);
        }

        let _ = conn.send_text("hello from pond/websocket");

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

        conn.close();
    }
}

fn main() { EchoTap { }; }
```

## Why this shape

Blocking I/O in Hale belongs on the **owner's** scheduler, not in
a hidden thread inside the library. The owner-Σ:

- declares its schedule class (typically `: schedule pinned` for a
  dedicated thread),
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

| Member       | Shape                                                                  |
|--------------|------------------------------------------------------------------------|
| `WsMessage`  | type — `{ kind, text, bytes }`                                         |
| `WsError`    | type — `{ kind, detail }`                                              |
| `WsClient`   | locus — see below                                                      |

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
    fn send_text(s: String)   -> Bool;
    fn send_bytes(b: Bytes)   -> Bool;
    fn close();
}
```

### `open() -> Bool`

Explicit dial + TLS + WS handshake. Idempotent if already
connected. If `auto_reconnect = true`, internally retries up to
`max_retries` (with `reconnect_initial` delay between attempts —
exponential schedule is a FRICTION item) before giving up.

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

Returns true with `self.last_message` set; false with
`self.last_error` set on fatal error.

### `send_text(s) -> Bool` / `send_bytes(b) -> Bool`

Emit a single frame. Returns true on a clean write; false with
`last_error` set on failure.

### `close()`

Send an RFC 6455 close frame (opcode 0x8) and tear down the
socket. After `close()`, `connected` is false and `read_msg` /
`send_*` will return false unless `open()` is called again.

## URL parsing

Accepts `ws://host[:port]/path` and `wss://host[:port]/path`.
Default ports: 80 for `ws`, 443 for `wss`. `wss` routes through
`std::io::tls::connect`; `ws` through `std::io::tcp::connect`.

IPv6 literal hosts (`[::1]:8080`) are not parsed at v1 — see
FRICTION.md.

## Pattern catalog

`WsClient` is a passive **connection wrapper** — a Service-locus
shape but without `run()`. Methods are synchronous; the owner's
loop drives. The owner is typically a **Service locus** (pattern
3) with `: schedule pinned` so blocking reads don't starve the
cooperative scheduler.

`parse_url` / `parse_frame` / `emit_frame` / `build_request` /
`parse_response` are **free fns** (pattern 6), testable in
isolation without a live socket.

## RFC 6455 compliance

- ✅ Handshake send (`GET … HTTP/1.1 + Upgrade: websocket`)
- ✅ Status-line validation (`HTTP/1.1 101 …`)
- ✅ Frame parse / emit (text / binary / close / ping / pong)
- ✅ Fragmentation reassembly (continuation frames → one
  `WsMessage` after FIN)
- ✅ Client→server masking (mandatory per § 5.3)
- ✅ Ping auto-reply (server pings get a pong with same payload)
- ⚠️ `Sec-WebSocket-Key` / `Sec-WebSocket-Accept` validation
  **stubbed** — needs SHA-1 + base64 stdlib primitives. See
  FRICTION.md.
- ⚠️ Frames > 2³¹ bytes rejected (no Int64 wide math at v1).
- ⚠️ Pong-deadline live-tracking partial; `pong_timeout` accepted
  but not enforced. FRICTION.md § stale-detect.

## Examples

```bash
hale build pond/websocket/examples/echo-client/
./pond/websocket/examples/echo-client/echo-client
```

The example connects to `wss://echo.websocket.events`, sends a
few text frames, prints the echoes, and exits.

## Files

- `types.hl` — `WsMessage`, `WsError`
- `frame.hl` — RFC 6455 frame parse + emit + opcode mapping
- `handshake.hl` — HTTP/1.1 upgrade request + response parse
- `client.hl` — `WsClient` locus + `parse_url`
- `examples/echo-client/main.hl` — runnable echo demo
- `FRICTION.md` — gaps, deviations, substrate asks

## Cross-references

- `pond/http/client/README.md` — sibling lib for one-shot HTTP.
- `std::io::tcp::*` / `std::io::tls::*` — underlying socket
  primitives.
