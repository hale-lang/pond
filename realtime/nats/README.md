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
type Version { version: Int = 0; }
topic Orders { payload: Order; subject: "orders.new"; }
topic Fills { payload: Order; subject: "orders.filled"; }
topic RouteWritten { payload: Version; subject: "route"; }

main locus App {
    params { nats: nats::NatsConn = nats::NatsConn { url: "nats://127.0.0.1:4222", subjects: "orders.filled" }; }
    placement { nats: pinned; }
    bindings {
        Orders: nats::NatsAdapter { };                                         // at least once
        RouteWritten: nats::NatsAdapter { delivery: nats::Delivery::Latest };  // the newest value
    }
    bus { publish Orders; publish RouteWritten; subscribe Fills as on_fill; }
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
- `subject_prefix` namespaces a program on a shared server. With
  `subject_prefix: "acme."`, the topic `orders.new` travels as
  `acme.orders.new`, `subjects` are subscribed with the prefix, and
  inbound messages lose it before dispatch. So the declared subjects
  never change.
- The connection sends `echo: false`, so what a program publishes
  reaches its own subscribers once, locally, and is not sent back.
- The payload bytes are the bus's own encoding, so the other end of a
  subject is another Hale program with the same topic.

Why two loci: a bound adapter's subscriptions run on the publishing
thread, not the adapter's (hale#1032), so an adapter that owned the
socket would write it from every publisher's thread. (Programs written
before hale#1034 closed declare a four-line local adapter that
publishes `nats::NatsOutbound`; it still works, and binds at least
once. A conn built in `main()` and passed in keeps its owner's
`on_failure` now that hale#1035 is closed: `latest_outage_test` does
that.)

### Delivery

Chosen per binding: `NatsAdapter { delivery: nats::Delivery::… }`.
`AtLeastOnce` is the default; `Latest` is for a latest-value signal
(below). One conn carries both.

**At least once.** `send` cannot fail, so the conn keeps every message
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

**Latest value** (`delivery: nats::Delivery::Latest`). For a signal
where only the newest value matters, such as a version number announced
every second. Per subject, the conn keeps only the newest message the
server has not confirmed:

- Connected, each message is written at once, followed by a PING; the
  PONG confirms it.
- While the connection is down, a newer message replaces the one its
  subject held, and the older one is dropped (never written).
- After a reconnect, the newest of each subject is written, unless the
  server already confirmed it.
- Nothing is audited: an outage of any length is no `delivery`
  violation, and the conn never collapses for it. A message over the
  server's `max_payload` is said on `last_error` and not tried again.
- A server that stops answering is noticed. A latest-value write still
  unconfirmed `latest_confirm_ms` (default 2000) after its PING, with no
  PONG of any kind meanwhile, closes the connection. The conn dials
  again after a wait of 1 s, doubling with each such close up to
  `latest_backoff_max_ms` (default 30000), and then writes the newest
  of each subject again. Only a confirmed latest-value write resets the
  wait; a dial alone does not, so a server that takes the connection
  and then goes silent is dialled ever less often, never hammered.
  `latest_drops` counts these closes, and `last_error` says the last
  one. (Before v0.9.1 such a server was written to forever, and the
  newest value never confirmed.)

The conn holds one message per latest-value subject, replaced in place.
`latest_in`, `latest_sent` and `latest_dropped` count what it was
handed, what it wrote, and what was replaced before it was written. In
`jetstream` mode, a latest-value message is a plain publish too: a
stream that takes its subject stores it, but no PubAck is awaited.

**Reconnecting.** The dial and the handshake each wait at most
`timeout` (default 5 s, `std::io::tcp::connect_within`), so an address
that never answers costs that much per attempt, not the kernel's two
minutes of SYN retries, and the attempt is retried with the backoff
above.

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
a stream stores. `ConsumerSpec.max_ack_pending` (> 0) caps how many
messages the server hands out unacknowledged at once (0: the server's
default).

If the durable, or its stream, disappears while the connection holds,
each pull is refused with a 503. The conn counts the refusals in a row in
`pull_refused`, creates the durable again (with `deliver` as given, so a
durable that was deleted starts over), and pulls again at the pull's
deadline rather than at once. `pull_refused` is back to 0 once a pull is
answered.

### Receiving untyped

```hale
nats: nats::NatsConn = nats::NatsConn {
    url: "nats://127.0.0.1:4222",
    subjects: "feeds.>",                    // core: still has to be subscribed
    untyped: "feeds.",                      // a wire subject, with subject_prefix if any
    stream: "FEEDS", consumer: nats::ConsumerSpec { durable: "app" }
};
...
bus { subscribe nats::NatsInbound as on_raw; publish nats::NatsOutbound; }
fn on_raw(m: nats::Inbound) {
    ... m.subject, m.data ...                        // as they arrived on the wire
    if len(m.reply) > 0 { nats::NatsOutbound <- nats::nats_ack(m.reply); }
}
```

A message whose wire subject starts with `untyped` is not dispatched to
a topic. It goes out on `NatsInbound` as `Inbound { subject, data,
reply }`: the whole wire subject, prefix and all, and its bytes, for a
subscriber that reads them itself. This suits a family of subjects the
program does not declare topic by topic, or payloads that are not the
bus's encoding.

- **Core subscriptions.** A message from a core subscription has
  `reply` "", and there is nothing to acknowledge.
- **The durable consumer.** The conn does not acknowledge a message it
  pulls from its durable consumer under `untyped`: its subscriber does,
  once it is done with it, with `NatsOutbound <- nats::nats_ack(m.reply)`.
  The conn writes that acknowledgement once if it is connected. It never
  keeps, audits or writes the acknowledgement again, so a message never
  acknowledged comes again after the consumer's ack wait, and nothing is
  lost if no one subscribes.

A program without `untyped` (the default "") behaves as before.

## NatsPublisher — publish only

```hale
bindings { Audit: nats::NatsPublisher { url: "nats://127.0.0.1:4222", subject_prefix: "acme." }; }
```

`NatsPublisher` is for a program that publishes a little, rarely, and
should not hold a connection for it. Each `send` dials, publishes onto
the JetStream stream that takes the subject, waits for the stream's
PubAck (each step bounded by `timeout`, default 2 s), and hangs up. All
of that happens on the publisher's own thread, with nothing kept between
sends.

- It needs no `NatsConn` and no `placement` line.
- It receives nothing, so the program's topology is exactly what its
  source declares. A `NatsConn` dispatches whatever arrives.
- `send` cannot fail and there is no queue. A message that could not be
  delivered (no connection, or no stream takes the subject) is said as a
  `warn` on `std::log` (logger `nats`) and dropped.
- `url` "" publishes nothing.
- Credentials are as on `NatsClient`: `user`, `pass`, `token`, or a
  sealed `credential`.

A program that publishes much holds a `NatsConn` instead.

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
c.pub_headers("orders.new", "", nats::msg_id_headers("o-17"), payload) or raise;   // HPUB
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
  (`nats://user:pass@host`, `nats://token@host`), or sealed:
  `credential: std::secret::Credential { vault: "nats-password" }` is
  `user`'s password, or with no `user` the token. It is revealed only
  on the line that writes CONNECT; when it names a source, `pass`,
  `token` and a URL's password are not used. `NatsConn` takes the same
  `credential` param and presents it on every (re)connect. NKey and JWT
  credentials are not supported: they need ed25519, which neither
  hale's stdlib nor `pond/crypto` has (`FRICTION.log`).
- **Inboxes.** A `request` waits for its reply on a fresh subject
  under `inbox_prefix` (default `_INBOX`, so `_INBOX.<22 hex>`). Set it
  for an account whose permissions allow replies only under a prefix of
  its own. `new_inbox_under(prefix)` makes one; `NatsConn.inbox_prefix`
  is passed to its client and also places the conn's own reply subjects
  (PubAcks and pulls).
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
| `js_consumer_create(c, stream, spec: ConsumerSpec)` | a durable pull consumer, explicit acks, `deliver` as above, optional `filter`, `ack_wait_ms` and `max_ack_pending` (again unchanged: re-attaches, keeping its place) |
| `js_publish(c, subject, data) -> PubAck` | publish and wait for the stream to store it (`kind: "jetstream"` if no stream takes the subject) |
| `js_publish_id(c, subject, id, data) -> PubAck` | the same, with a `Nats-Msg-Id` header: inside the stream's duplicate window a second publish of `id` is not stored again (`duplicate: true`, the first one's `seq`) |
| `js_next(c, stream, consumer, wait_ms) -> NatsMsg` | the next message, or `kind: "no_messages"` |
| `js_ack(c, msg)` | acknowledge it; unacknowledged, it comes again after the ack wait |

## NatsFake — no broker

`NatsFake` takes `NatsConn`'s place. It subscribes to the same queue,
so the adapter and bindings stay as they are.

- **Outbound.** Everything sent is kept, and acknowledged at once. With
  `ack: false` nothing is acknowledged, and the same `delivery` closure
  fires once a message is older than `ack_window_ms`. A latest-value
  binding's messages are kept (and counted in `latest`) but never
  audited, as on the conn.
- **Inbound.** Messages come from `inject(subject, bytes)`, or from
  `replay(from, to)`, which re-delivers what was sent on one subject
  under another. With `untyped` set, an injected subject under it goes
  out on `NatsInbound`, as on the conn. `inject_reply(subject, reply,
  bytes)` gives it a reply, as though it was pulled from a durable
  consumer. An acknowledgement sent back (`nats_ack`) is counted in
  `acks` (`last_ack` is its subject), and never kept as a message or
  audited.
- **Placement.** Those are direct calls, so the fake shares its owner's
  pool. A test that expects the audit to fire places it `pinned`
  instead (hale#1036).

## Tests

```sh
hale test realtime/nats/
```

Without a server, `proto_test` (framing), the fake's tests and the
loopback tests run, and the `*_live_test`s say "skipped" on stderr and
pass. The loopback tests run against `tests/loopback/`, just enough of
a NATS server on 127.0.0.1 (INFO, CONNECT with a password check,
PING/PONG, PUB) to take one down and bring it back, or make it go
silent after the handshake. To run the live
tests against a real server:

```sh
docker run --rm -p 4222:4222 nats:2 -js
NATS_URL=nats://127.0.0.1:4222 hale test realtime/nats/
```

| Test | What it proves |
|---|---|
| `latest_liveness_test` | loopback, a server that answers the handshake and then goes silent: the connection closed after the confirm window, dialled again after 1 s, 2 s, 2 s (the cap), the newest of each subject delivered once the server answers, and a confirmed write resetting the wait to 1 s; nothing collapses |
| `latest_outage_test` | loopback: across an outage longer than the ack window, a latest-value binding keeps only the newest of each subject, writes it after the reconnect and never the ones it replaced, and collapses nothing; an at-least-once binding on the same conn still collapses it |
| `credential_test` | loopback: a vault credential as `user`'s password and as a token; a wrong or missing one refused; `NatsConn` connecting with its own |
| `dial_test` | the dial gives up within the client's `timeout` on an address that never answers (127.0.0.2: dropped on macOS, refused at once on Linux) |
| `fake_untyped_test` | an injected subject under the fake's `untyped` reaches `NatsInbound` as it arrived, with its reply; the subscriber's `nats_ack` counts as an ack and is never audited |
| `inbox_test` | `new_inbox` and `new_inbox_under`: the prefix, the length, fresh each time |
| `fake_latest_test` | the fake never audits a latest-value binding, and still audits an at-least-once one |
| `client_live_test` | pub/sub, a binary payload intact, unsub, request/reply, a reply under `inbox_prefix`, no-responders |
| `jetstream_live_test` | streams, PubAcks, durable consumers under all five deliver policies, a filter, re-creating a durable without losing its place, redelivery of what was never acked, `max_ack_pending` holding back the next message |
| `untyped_live_test` | `untyped` over a core subscription and the durable consumer: messages on `NatsInbound` as they arrived, a pulled one acknowledged by its subscriber, and one left unacknowledged coming again |
| `consumer_gone_live_test` | the durable deleted under a live connection: pulls refused and counted in `pull_refused`, the durable created again, the next message delivered, the count back to 0 |
| `publisher_live_test` | `NatsPublisher`: each message stored once under its prefix, a publish no stream takes said on `std::log`; with no server, `url` "" publishes nothing |
| `adapter_live_test` | the bus both ways under a `subject_prefix`: 50 messages out through the adapter, back in through a relay, whole and in order |
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
  CLOSED. Programs bind `nats::NatsAdapter { … }` directly, which is
  also how a binding picks its `delivery`.
- **pond COMPILER-BUGS § 3** (a drain reaches a pinned loop): nothing
  changes here. The loop already ends on `self.draining`; `run_for_ms`
  becomes optional.
- **hale#1037, hale#1033** (vec and field retire): `NatsMsgLog` could
  become a vec of `Outbound`. There is no hurry, since it is also the
  cheaper shape.
