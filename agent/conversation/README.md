# pond/agent/conversation — alias `conv`

Chat-history locus for AI-agent pipelines. Holds an ordered
stream of `Message` records bounded by `max_messages`, and
surfaces the state as a tab-separated string for direct hand-off
to an LLM request.

```hale
import "vendor/pond/agent/conversation" as conv;

let c = conv::Conversation {
    system_prompt: "You are terse.",
    max_messages:  10,
};

c.append(conv::Message {
    role:    "user",
    content: "hello",
    ts:      `2026-05-16T00:00:00Z`,
});

let hist = c.history();          // "user\thello"
```

## Public surface

Per `pond/CONTRACTS.md § pond/agent/conversation/`.

| Member                | Shape                                                  |
|-----------------------|--------------------------------------------------------|
| `Message`             | type — `{ role: String; content: String; ts: Time; }` |
| `Conversation`        | locus — see below                                      |
| `ConversationUpdated` | topic — wire subject `"conv.updated"`, payload `Message` |

### `Conversation` locus

```hale
locus Conversation {
    params {
        system_prompt: String = "";
        max_messages:  Int    = 100;
        // ...internal state fields (see conversation.hl)
    }
    bus { publish ConversationUpdated; }

    fn append(m: Message);                 // record + fire topic
    fn history() -> String;                // tab-separated dump
}
```

## Cross-process state-mirroring is out of scope for v1

Earlier drafts shipped a `version()` / `snapshot_bytes()` /
`apply_delta()` surface on this locus so a remote mirror could
resync via snapshots + deltas (the "Memory Owner Architecture"
shape). That design is on hold — the substrate work it needs
(durable version chain, gap-detect, resync protocol) wasn't
load-bearing for v1, and the wire-format split between owner-
local serialization and consumer-friendly framing pulled the
implementation in two directions.

Consumers that need cross-process bus delivery should bind the
`ConversationUpdated` topic in `main`'s `bindings` block — that
goes through the bus substrate without the conversation having
to own a snapshot format.

## Wire shapes

### `Conversation.history()` and `Message.content`

`history()` returns `"role1\tcontent1\trole2\tcontent2\t..."` —
tab-separated `role\tcontent` pairs flattened into one stream.
Same convention as `pond/agent/llm::LlmRequest.messages` and
`pond/router::RouteParams.path_kv`; a Conversation's `history()`
output drops straight into an `LlmRequest`:

```hale
let req = llm::LlmRequest {
    model:    "claude-opus-4-7",
    system:   c.system_prompt,
    messages: c.history(),
    // ...
};
```

Callers MUST NOT embed `\t` in `Message.content` — there is no
escaping at v1. (Logged in FRICTION.md as duplicate-suspected
with the same constraint in `pond/router` and `pond/agent/llm`.)

## Pattern-catalog mapping

`Conversation` is a **Service locus** (pattern 3 in the
six-pattern catalog) — state-bearing, exposes a method surface
that mutates `self`, fires bus events on mutation. No explicit
`birth()` / `run()` / `dissolve()` because every param has a
default; state is usable immediately.

`drop_front_messages` (in `apply.hl`) is a **free fn**
(pattern 6) — pure-data eviction helper called from `append`
when `max_messages` is exceeded.

## Examples

```bash
hale build pond/agent/conversation/examples/two-turn/
./examples/two-turn/two-turn
```

The example constructs a `Conversation`, appends "hello",
"hi there", "how are you", and prints the history.

## Cross-references

- `pond/CONTRACTS.md` — the binding surface this lib targets.
- `pond/agent/conversation/FRICTION.md` — deviations + gaps.
- `pond/agent/llm/README.md` — the natural downstream consumer
  of `history()`.
