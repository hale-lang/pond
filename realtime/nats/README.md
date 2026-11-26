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

**A build warning every NatsConn program gets.** `hale build` of a
program holding a `NatsConn` warns `bus topic nats::NatsInbound is
published but has no subscriber`, whether it sets `untyped` or not: the
conn declares the publish, and hale has no way to say a library's topic
is optional (`FRICTION.log § pond/realtime/nats`, "NatsInbound warns in
every program that holds a NatsConn"). Without `untyped` it is harmless,
since nothing is ever published there. With `untyped` it is the warning
to heed: subscribe `nats::NatsInbound`, or pulled messages are never
acknowledged and come again. `hale check` and `hale verify` do not show
it (`COMPILER-BUGS.md` § 14).

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

```hale
let spec = nats::StreamSpec {
    name: "WORK", subjects: "work.>",
    retention: "workqueue",           // gone once acked; consumers may not overlap
    max_age_ms: 600000,               // no message older than 10 min
    max_msgs_per_subject: 1024, discard: "new", discard_new_per_subject: true,   // a full subject refuses
    duplicate_window_ms: 120000,      // a Nats-Msg-Id is remembered 2 min
    allow_msg_ttl: true,              // a publish may set its own Nats-TTL (nats-server 2.11)
};
nats::js_stream_create_with(c, spec) or nats::js_stream_update(c, spec);   // create, or bring it up to date
nats::js_consumer_create(c, "WORK", nats::ConsumerSpec { durable: "w_a", filter: "work.a", max_deliver: 5 }) or raise;
```

`StreamSpec` leaves out of the request what is at its default, for the
server to fill in: `retention` "limits", `storage` "file", every limit
0 (none), `discard` "old", `duplicate_window_ms` 0 (the server's 2
minutes). A full subject with `discard: "new"` and
`discard_new_per_subject` refuses the publish (kind `jetstream`, "maximum
messages per subject exceeded"); without `discard_new_per_subject` the
per-subject limit drops the subject's oldest instead.

| Call | What it does |
|---|---|
| `js_stream_create(c, name, subjects)` | a file-backed stream over comma-separated subjects (again unchanged: not an error) |
| `js_stream_delete(c, name)` | |
| `js_stream_create_with(c, spec: StreamSpec)` | a stream with the settings below (again unchanged: not an error; with other settings: refused, see `js_stream_update`) |
| `js_stream_update(c, spec: StreamSpec)` | give an existing stream `spec`'s settings, all of them (one left at its default goes back to it); its messages stay |
| `js_consumer_create(c, stream, spec: ConsumerSpec)` | a durable pull consumer, explicit acks, `deliver` as above, optional `filter`, `ack_wait_ms`, `max_ack_pending` and `max_deliver` (again unchanged: re-attaches, keeping its place) |
| `js_consumer_delete(c, stream, consumer)` | delete a durable, and its place in the stream; the messages stay |
| `js_publish(c, subject, data) -> PubAck` | publish and wait for the stream to store it (`kind: "jetstream"` if no stream takes the subject) |
| `js_publish_id(c, subject, id, data) -> PubAck` | the same, with a `Nats-Msg-Id` header: inside the stream's duplicate window a second publish of `id` is not stored again (`duplicate: true`, the first one's `seq`) |
| `js_publish_headers(c, subject, headers, data) -> PubAck` | the same, with any header block (`with_header`): `Nats-Msg-Id`, `Nats-TTL` (the message's own age, `"30s"`, on a stream with `allow_msg_ttl`), `Nats-Expected-*`, your own |
| `with_header(block, name, value) -> String` | `block` ("" to start one) with one more header; kind `header` for a name that is not a token or a value with a line break |
| `js_stream_info(c, name) -> StreamInfo` | `created_ns` (when the stream was created, ns since the epoch: a stream deleted and created again under the same name has a later one), `messages`, `bytes`, `first_seq`, `last_seq`, `first_ns`, `last_ns` (stored at, ns since the epoch, 0 never), `subjects`, `deleted`, `consumers` |
| `js_consumer_info(c, stream, consumer) -> ConsumerInfo` | `num_pending`, `num_ack_pending`, `num_waiting` (pulls open), `num_redelivered`, `delivered_consumer_seq`/`_stream_seq`, `ack_floor_consumer_seq`/`_stream_seq`, `last_active_ns` |
| `js_stream_msg_get(c, stream, seq) -> StoredMsg` | a stored message, read without a consumer: `subject`, `seq`, `headers`, `data`, `time_ns` (kind `no_messages` if the stream does not hold it) |
| `js_stream_msg_next(c, stream, subject, seq) -> StoredMsg` | the first on `subject` (wildcards allowed) at or after `seq`; `seq` 0 is the oldest |
| `js_stream_msg_delete(c, stream, seq)` | remove one at once (kind `jetstream`, code 10043 if it is already gone, 10057 past the stream's end) |

A refusal from the JetStream API fails with kind `jetstream` and the
API's `err_code` in `NatsError.code`: 10077 is a publish to a subject at
its `max_msgs_per_subject` on a stream that discards new, 10059 no such
stream, 10014 no such consumer, 10037 no such message for
`js_stream_msg_get`/`_next` (kind `no_messages`). These were observed
on nats-server 2.11.17.
| `js_next(c, stream, consumer, wait_ms) -> NatsMsg` | the next message, or `kind: "no_messages"` |
| `js_ack(c, msg)` | acknowledge it; unacknowledged, it comes again after the ack wait |
| `js_nak(c, msg, delay_ms)` | hand it back: delivered again after `delay_ms` (0: at once) |
| `js_term(c, msg)` | give up on it: never delivered again |
| `js_meta(msg.reply) -> JsMeta` | the delivery metadata in its reply subject: stream, consumer, `delivered` count, stream and consumer sequence, `timestamp_ns`, `pending`, `domain` (kind `jetstream` if it is not a `$JS.ACK` subject) |
| `header_value(headers, name)` | one header's value from a header block, any case ("" when absent) |

### Pulling without blocking

`js_next` is a request: the client reads nothing else while it waits,
so a program pulling from several consumers would need a connection
(and a thread) for each. A `JsPuller` owns one inbox subscription on a
client you keep, publishes each pull with its reply on that inbox, and
returns at once. What the server sends back arrives through your own
`read_msg` loop, like any other message: hand each one the puller
`owns` to `take`, which says what it is. Several pullers share one
connection and one loop.

```hale
let pa = nats::JsPuller { stream: "WORK", consumer: "w_a" };
let pb = nats::JsPuller { stream: "WORK", consumer: "w_b" };
while running {
    if pa.wants_pull() { pa.fetch(c, 4, 5000, false) or raise; }   // batch 4, expires 5 s
    if pb.wants_pull() { pb.fetch(c, 1, 0, true) or raise; }       // batch 1, no_wait
    if !c.read_msg(250ms) { continue; }
    if pa.owns(c.last) {
        let got = pa.take(c.last);
        if got.kind == "msg" {
            let meta = nats::js_meta(got.msg.reply) or raise;       // delivered, sequences, timestamp
            ... nats::js_ack(c, got.msg) or raise;                  // or js_nak(c, got.msg, 2000) / js_term
        }
    } else if pb.owns(c.last) { ... }
}
```

- `fetch(c, batch, expires_ms, no_wait)` subscribes the inbox the first
  time (or call `open(c)` first), publishes
  `$JS.API.CONSUMER.MSG.NEXT.<stream>.<consumer>` with its reply on
  `<inbox>.<n>`, the n-th pull's own subject, and returns.
- `take(m)` gives a `JsPulled`. Its `kind` is `"msg"` (in `msg`), or the
  status that ended the pull: `"no_messages"` (404, a `no_wait` pull on
  an empty consumer), `"expired"` (408, `expires` passed), `"conflict"`
  (409, the server ended it: `status` says why, e.g. "409 Consumer
  Deleted", "409 Exceeded MaxWaiting"), `"gone"` (503, no such consumer
  or stream; counted in `refused`), `"status"` (anything else). It can
  also be `"heartbeat"` (100), which does not end the pull, or `"stale"`,
  a status for an earlier pull than the current one. `pending` is the
  status's `Nats-Pending-Messages` (on a 408 or 409): how many of the
  pull's batch it did not fill, not the consumer's backlog
  (`js_consumer_info`), else -1.
- `wants_pull()` is true when no pull is open: its batch came, a status
  ended it, or it is 2 s past its expiry with no word from the server.
- The inbox sits under the client's `inbox_prefix`. A `request` on the
  same client meanwhile sets the pullers' messages aside, and `read_msg`
  hands them out after.
- `no_wait` (nats-server 2.11, observed): a batch of n brings what the
  consumer has, up to n, then a 404 if that was fewer than n; nothing
  there is a 404 at once. With `expires_ms` too, a consumer with
  nothing is waited on for up to `expires_ms`, then a 408; one with
  some still ends with a 404 once they are handed out.

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
| `ack_meta_test` | `js_meta` on both forms of `$JS.ACK` subject (with and without a domain, the domain `_`), each malformed subject refused; `header_value` |
| `fake_latest_test` | the fake never audits a latest-value binding, and still audits an at-least-once one |
| `client_live_test` | pub/sub, a binary payload intact, unsub, request/reply, a reply under `inbox_prefix`, no-responders |
| `jetstream_live_test` | streams, PubAcks, durable consumers under all five deliver policies, a filter, re-creating a durable without losing its place, redelivery of what was never acked, `max_ack_pending` holding back the next message |
| `js_settings_live_test` | a work-queue stream: its settings as the server reports them, a full subject refusing a third message while another subject takes one, create refusing other settings and update taking them, an acked message freeing its place, an overlapping consumer refused, a deleted consumer, `max_deliver` 2 delivering an unacked message exactly twice, the duplicate window forgetting an id, a `Nats-TTL` message expiring, and a stream without `allow_msg_ttl` refusing one (nats-server 2.11) |
| `untyped_live_test` | `untyped` over a core subscription and the durable consumer: messages on `NatsInbound` as they arrived, a pulled one acknowledged by its subscriber, and one left unacknowledged coming again |
| `consumer_gone_live_test` | the durable deleted under a live connection: pulls refused and counted in `pull_refused`, the durable created again, the next message delivered, the count back to 0 |
| `js_pull_live_test` | two `JsPuller`s on one connection and one read loop: a 404 at once for `no_wait` on an empty consumer, a batch of two filled, a waiting pull ending in a 408, a request made while both pulls are open, delivery metadata, a `no_wait` batch larger than what is there, a NAK with a delay not redelivered before it and redelivered after (`delivered` 2), a plain NAK, a TERM never redelivered, a 409 when the consumer is deleted under an open pull, a 503 for a consumer that does not exist, a stale status |
| `publisher_live_test` | `NatsPublisher`: each message stored once under its prefix, a publish no stream takes said on `std::log`; with no server, `url` "" publishes nothing |
| `js_state_live_test` | `created_ns` within the minute, to the nanosecond, the same while the stream lives and later once it is deleted and created again; `with_header` and its refusals; through `js_publish_headers`, a `Nats-Msg-Id` kept once and a `Nats-TTL` message gone on its own; stream info empty and with three messages (counts, sequences, times); a stored message by sequence with its headers and time, the oldest on a subject, the first from a sequence on a wildcard, a missing one as `no_messages`; the err_codes 10077, 10059 and 10014; consumer info before and after pulls (pending, ack pending, waiting, delivered, ack floor, last active); a message deleted from the stream (nats-server 2.11) |
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
