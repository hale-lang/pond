# pond/agent/conversation — friction log

Gaps in the language/stdlib substrate, deviations from
`pond/CONTRACTS.md`, and suspicions that surfaced while
building `pond/agent/conversation/`.

---

## Resolved: state-mirroring surface removed (was the future store-pattern lib, now scoped out)

Earlier drafts shipped a `version()` / `snapshot_bytes()` /
`apply_delta()` surface on `Conversation` so a remote mirror
could resync via snapshots + deltas (the "Memory Owner
Architecture" shape). That design is on hold — the substrate
work it needs (durable version chain, gap-detect, resync
protocol) wasn't load-bearing for v1, and the wire-format split
between owner-local serialization and consumer-friendly framing
pulled the implementation in two directions.

Consumers that need cross-process bus delivery should bind
`ConversationUpdated` in `main`'s `bindings` block — that
routes through the bus substrate without the conversation
having to own a snapshot format. The
`apply_conversation_delta` / `decode_delta` free fns + the
`ConversationError` / `DecodedDelta` shapes that lived alongside
the locus method were removed in the same pass.

Earlier FRICTION entries here documented the G4 ("locus methods
can't declare `fallible(E)`") + G23 ("self in arg slot crashes
codegen") interaction that forced a pure-decode-plus-fold shape
on `apply_delta`; that whole branch is gone with the surface.

---

## Suspected duplicate: tab-separated kv stream walker

This is the THIRD lib in pond/ that encodes its public surface
as a tab-separated stream (`role\tcontent\trole\tcontent`):

- `pond/router::RouteParams.path_kv` — `"k1\tv1\tk2\tv2"`
- `pond/agent/llm::LlmRequest.messages` — `"role\tcontent..."`
- `pond/agent/conversation::Conversation.history_buf` — same shape

`pond/agent/llm/wire.hl` already factored its own `__next_field`
+ `__Slice` walker; `pond/router` has its own; this lib has
`drop_front_messages` which walks the bytes once to count tab
boundaries.

**duplicate-suspected** — a stdlib `std::iter::TabFields { value:
String; next: Int; done: Bool; }` with companion
`std::iter::tab_first(s) -> TabFields` /
`std::iter::tab_next(prev) -> TabFields` would let every
consumer drop its bespoke walker. The tab-as-delimiter shape
isn't going away (it's the v1 substitute for parametric
`Vec<(K,V)>`), so the walker is too.

Also flagged: the implicit "callers don't embed tabs in field
values" contract that every tab-stream consumer inherits. A
stdlib walker pair could add an escape convention (`\t` →
literal tab, `\\` → backslash) and centralize it.

---

## Substrate gap: per-conversation topic subjects share one wire

`ConversationUpdated` is a single topic decl; two distinct
`Conversation` instances publishing on it share a single wire
subject in v1. Every subscriber sees every conversation's
traffic.

The intended end-state per `spec/semantics.md` § Phase 2
hierarchical topics is:

```hale
topic SessionA : ConversationUpdated { subject: "session.a"; }
topic SessionB : ConversationUpdated { subject: "session.b"; }
```

so subscribers filter on the materialized subject at the bus
layer. Until that ships, the workaround is "bind owner+consumer
1:1".

---

## Substrate gap: `time::now()` for `Message.ts`

`Message.ts: Time` wants a wall-clock now() to stamp the moment
a message was appended. v1 stdlib has `std::time::monotonic()
-> Duration` only — no wall-clock primitive. Same gap
`pond/sessions/FRICTION.md` already logged.

For this lib's purposes, callers can:

1. Pass the timestamp explicitly into `Message`, sourced from
   wherever the calling layer gets time (e.g. an external HTTP
   request's `Date` header).
2. Leave it as the `1970-01-01T00:00:00Z` default until the
   wall-clock primitive lands.

The example demo (two-turn) uses backtick-literal timestamps
for illustrative purposes.
