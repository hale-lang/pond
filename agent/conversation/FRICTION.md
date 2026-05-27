# pond/agent/conversation — friction log

Gaps in the language/stdlib substrate, deviations from
`pond/CONTRACTS.md`, and suspicions that surfaced while
building `pond/agent/conversation/`.

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

## Substrate gap: per-conversation topic subjects share one wire — [CLOSABLE]

**2026-05-27 update.** v0.8.1 shipped bus routing keys (commits
`7a12dc4` → `2dcc51d`): `keyed_by FIELD` on the topic decl +
`where key == EXPR` on subscribers. The next source pass declares
`topic ConversationUpdated { ..., keyed_by conversation_id }` and
subscribers filter by id; one-wire-shared-subject goes away.
Clean breaking change for any cross-process subscriber that was
filtering in userspace.

**Current source shape (still in place).** `ConversationUpdated`
is a single topic decl; two distinct `Conversation` instances
publishing on it share a single wire subject. Every subscriber
sees every conversation's traffic. Workaround pre-v0.8.1 was
"bind owner+consumer 1:1".
