# pond/realtime/nats

A NATS client — core protocol and JetStream — and a `std::bus`
adapter built on it, so a program's topics can travel over a NATS
server. Suggested alias `nats`.

```hale
import "vendor/pond/realtime/nats" as nats;
```

## Carrying a program's bus over NATS

```hale
type Order { id: Int = 0; }
topic Orders { payload: Order; subject: "orders.new"; }
topic Fills { payload: Order; subject: "orders.filled"; }

// The adapter `bindings` names (hale#1034: a binding cannot name an
// adapter through an import alias yet, so it is spelled here).
locus Nats {
    bus { publish nats::NatsOutbound; }
    fn send(subject: String, bytes: Bytes) { nats::NatsOutbound <- nats::Outbound { subject: subject, data: bytes }; }
}

main locus App {
    params { nats: nats::NatsConn = nats::NatsConn { url: "nats://127.0.0.1:4222", subjects: "orders.filled" }; }
    placement { nats: pinned; }
    bindings { Orders: Nats { }; }
    bus { publish Orders; subscribe Fills as on_fill; }
    fn on_fill(o: Order) { ... }
    on_failure(c: nats::NatsConn, err: ClosureViolation) { ... c.last_error ... }
}
```

- **Outbound.** Every publish of a bound topic calls the adapter's
  `send`, which puts the message on the internal `NatsOutbound` topic.
  `NatsConn`, placed `pinned`, receives it on its own thread and writes
  it to the server. Every socket write happens on that one thread.
- **Inbound.** `NatsConn.run()` is the receive loop. Each message on
  one of `subjects` (comma-separated, wildcards allowed) is handed to
  `std::bus::__local_dispatch` under its NATS subject, so the local
  subscribers of the topic with that subject receive it.
- The connection sends `echo: false`, so what a program publishes
  reaches its own subscribers once, locally, and is not sent back.
- The payload bytes are the bus's own encoding, so the other end of a
  subject is another Hale program with the same topic.

Why two loci: a bound adapter's subscriptions run on the publishing
thread, not the adapter's (hale#1032), so an adapter that owned the
socket would write it from every publisher's thread. The conn must
also be declared as the owner's param default, not built in `main()`
and passed in: a child passed in loses its owner's `on_failure`
(hale#1035).

### Delivery

At least once. `send` cannot fail, so the conn keeps every message
until the server has it:

- **Core mode:** the PONG of a PING written after the message.
- **`jetstream: true`:** the PubAck of the stream that takes its
  subject.

A message still unacknowledged `ack_window_ms` (default 10 s) after
`send` handed it over violates the conn's `delivery` closure. That
collapses the conn to its owner, and `c.last_error` says which message
and why (for example `message 7 on orders.new unacknowledged after
10000 ms: jetstream refused message 7: no stream takes it (503)`).
Silence is a violation, not a stall.

A lost connection is retried with backoff (50 ms doubling to
`reconnect_max_ms`). After it reconnects, the conn subscribes again,
re-attaches the durable consumer, and writes everything still
unacknowledged again.

An inbound message waits at most about 10 ms for the receive loop (its
read timeout) plus however long the receiving locus takes to reach a
yield point.

### Receiving from JetStream

```hale
nats: nats::NatsConn = nats::NatsConn {
    url: "nats://127.0.0.1:4222",
    jetstream: true,                        // outbound acked by the stream
    stream: "ORDERS",                       // the stream must exist (js_stream_create)
    consumer: nats::ConsumerSpec { durable: "app", deliver: "all" }
};
```

With `stream` and `consumer.durable` set, the conn creates (or
re-attaches) that durable pull consumer and pulls from it, `pull_batch`
at a time. It dispatches each message and then acks it. `deliver` is
where a new durable starts:

- `"all"`;
- `"new"`;
- `"last"`;
- `"by_start_sequence"` with `start_seq`;
- `"by_start_time"` with `start_time` (RFC 3339).

A durable keeps its place across restarts. The program's own publishes
come back through the stream too; `echo: false` does not apply to what
a stream stores.

### Ending

`run_for_ms` (> 0) ends the conn's loop after that long. Tests and the
example use it, because a pinned loop never sees a drain: neither the
end of the main locus's `run()` nor SIGTERM reaches it
(`COMPILER-BUGS.md` § 3). Without it, the program runs until killed,
and messages not yet acknowledged at that moment are not audited.

## NatsClient — one connection, owner-driven

```hale
let c = nats::NatsClient { url: "nats://user:pass@127.0.0.1:4222" };
if !c.open() { println(c.last_error); }
let sid = c.sub_to("orders.>", "") or raise;
c.pub_msg("orders.new", "", payload) or raise;
c.flush() or raise;                          // PING/PONG: the server has it all
if c.read_msg(2s) { ... c.last.subject, c.last.data ... }
let reply = c.request("svc.echo", payload, 2s) or raise;   // kind "no_responders" if nobody answers
c.close();
```

(`publish` and `subscribe` are reserved words, hence `pub_msg`,
`sub_to` and `unsub`.)

- **URLs.** `nats://host[:port]` is plain TCP. `tls://host[:port]`
  reads the server's INFO, then upgrades the socket to TLS and checks
  the certificate against the system trust store (so name the host by
  its DNS name, not an IP); a `nats://` server whose INFO says
  `tls_required` is upgraded the same way. The live tests do not cover
  TLS: that needs a server whose certificate the system trusts.
- **Credentials.** `user`/`pass` or `token`, as params or in the URL
  (`nats://user:pass@host`, `nats://token@host`). NKey and JWT
  credentials are not supported: they need ed25519, which neither
  hale's stdlib nor `pond/crypto` has (`FRICTION.log`).
- **Frames.** `next_frame()` returns one frame into `framer.frame`,
  answering server PINGs itself. `last_error` says why the last
  operation failed; every `NatsError` has a stable `kind`.

`NatsFramer` (`proto.hl`) is the framing state machine by itself:
bytes in, whole frames out, with a partial frame kept until the rest
arrives.

## JetStream calls

Free fns over a client you own:

| Call | What it does |
|---|---|
| `js_stream_create(c, name, subjects)` | a file-backed stream over comma-separated subjects (again unchanged: not an error) |
| `js_stream_delete(c, name)` | |
| `js_consumer_create(c, stream, spec: ConsumerSpec)` | a durable pull consumer, explicit acks, `deliver` as above, optional `filter` and `ack_wait_ms` (again unchanged: re-attaches, keeping its place) |
| `js_publish(c, subject, data) -> PubAck` | publish and wait for the stream to store it (`kind: "jetstream"` if no stream takes the subject) |
| `js_next(c, stream, consumer, wait_ms) -> NatsMsg` | the next message, or `kind: "no_messages"` |
| `js_ack(c, msg)` | acknowledge it; unacknowledged, it comes again after the ack wait |

## NatsFake — no broker

`NatsFake` takes `NatsConn`'s place. It subscribes to the same queue,
so the adapter and bindings stay as they are.

- **Outbound.** Everything sent is kept, and acknowledged at once. With
  `ack: false` nothing is acknowledged, and the same `delivery` closure
  fires once a message is older than `ack_window_ms`.
- **Inbound.** Messages come from `inject(subject, bytes)`, or from
  `replay(from, to)`, which re-delivers what was sent on one subject
  under another.
- **Placement.** Those are direct calls, so the fake shares its owner's
  pool. A test that expects the audit to fire places it `pinned`
  instead (hale#1036).

## Tests

```sh
hale test realtime/nats/
```

Without a server, `proto_test` (framing), `fake_test` and
`fake_audit_test` run, and the `*_live_test`s say "skipped" on stderr
and pass. To run those against a real server:

```sh
docker run --rm -p 4222:4222 nats:2 -js
NATS_URL=nats://127.0.0.1:4222 hale test realtime/nats/
```

| Test | What it proves |
|---|---|
| `client_live_test` | pub/sub, a binary payload intact, unsub, request/reply, no-responders |
| `jetstream_live_test` | streams, PubAcks, durable consumers under all five deliver policies, a filter, re-creating a durable without losing its place, redelivery of what was never acked |
| `adapter_live_test` | the bus both ways: 50 messages out through the adapter, back in through a relay, whole and in order |
| `adapter_js_live_test` | JetStream mode: each message stored once and delivered back through the durable consumer |
| `adapter_audit_live_test` | a publish no stream takes collapses the conn to its owner, naming the message and the reason |

**Soak.** 100,000 messages out through the adapter and 100,000 back in
through the conn, in five rounds. The process grows by the same amount
as with the conn replaced by a subscriber that does nothing: about
47 B per publish, which is the compiler's bound-publish path
(hale#1038). The conn's own storage stays flat. It keeps queued
messages in `NatsMsgLog` (one reused BytesBuilder), because a vec of
Bytes-bearing values keeps every payload it held (hale#1037).

## Example

`examples/bridge/`: five ticks go out over NATS, a mirror client sends
them back, and the program prints each round trip. With no server it
says how to start one and exits.

```sh
docker run --rm -p 4222:4222 nats:2 -js
hale build realtime/nats/examples/bridge/ && ./realtime/nats/examples/bridge/bridge
```

## When this unblocks

- **hale#1032** (an adapter's subscriptions on its own thread): fold
  `NatsConn` into `NatsAdapter`. The adapter subscribes to its own
  queue, and its `run()` becomes the receive loop; programs lose the
  `placement` line and the second param.
- **hale#1034** (a binding may name an adapter through an alias):
  programs bind `nats::NatsAdapter { … }` directly and drop their local
  `Nats` locus.
- **pond COMPILER-BUGS § 3** (a drain reaches a pinned loop): nothing
  changes here. The loop already ends on `self.draining`; `run_for_ms`
  becomes optional.
- **hale#1037, hale#1033** (vec and field retire): `NatsMsgLog` could
  become a vec of `Outbound`. There is no hurry, since it is also the
  cheaper shape.
