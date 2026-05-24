# pond/agent/llm — FRICTION

Gaps, suspicions, and deviations from CONTRACTS.md surfaced while
building this lib.

## ~~blocked-on-stdlib: no TLS substrate~~

**closed 2026-05-18** by upstream `e9a99df` (TLS client surface +
m105 adapter inbound dispatch). `std::io::tls::*` ships:
`connect(host, port) -> Int fallible(IoError)` (TLS 1.2+ with
SNI + system trust store), `send_bytes(handle, b)`,
`recv_bytes(handle, max)`, `close(handle)`. Lib-level wire-up
landed same day:

- `__parse_base_url` now accepts both `http` and `https`
  schemes; only unknown schemes fail with a `bad_url` /
  "unsupported scheme" diagnostic.
- `__connect_or_llm_err` takes the parsed scheme and routes
  `https` → `std::io::tls::connect`, anything else →
  `std::io::tcp::connect`. Returns an `__LlmStream` wrapper
  carrying the transport kind + the right handle.
- New `__stream_send` / `__stream_recv_bytes` /
  `__stream_close` helpers dispatch on `__LlmStream.kind`.
  `__drain_stream` was reshaped to take `__LlmStream` (was:
  `std::io::tcp::Stream`).
- The `"unsupported_scheme"` LlmError kind is gone; URL parse
  rejects pre-connect with `"bad_url"` if anything other than
  `http` / `https` is given.

Public surface unchanged — both clients accept the
`https://api.{anthropic,openai}.com` default base_urls without
config changes. `LlmError.kind` documentation in `types.hl`
was updated to reflect the dropped `"unsupported_scheme"`.

## two-channel-rule: locus methods can't declare fallible(E)

CONTRACTS.md lists the public surface as:

```hale
fn complete(req: LlmRequest) -> LlmResponse fallible(LlmError);
fn stream(req: LlmRequest) -> ();
```

The `complete` shape is type-illegal under v1 — locus methods
cannot declare `fallible(E)` per `spec/semantics.md §
Fallible call semantics`. The implementation deviates in the
exact same way pond/subprocess, pond/sqlite, pond/http/client
already do:

- Method declared non-fallible. Body wraps a fallible free fn
  via `or self.__record(err)` — the error-check-fn pattern
  from `spec/styleguide.md § 7`.
- Errors surface through `last_error_kind()` /
  `last_error_status()` / `last_error_detail()` accessors.
- The fallible free fns (`anthropic_complete`,
  `openai_complete`) are public for consumers that want the
  value-channel `fallible(LlmError)` path directly.

**duplicate-suspected**: this same deviation now lives in
pond/sqlite (db.hl), pond/http/client (client.hl),
pond/subprocess (process.hl), and pond/agent/llm (here). Four
hits = strong signal CONTRACTS.md needs a sweep: either
- flip every such method to a free fn, or
- accept the wrapper pattern as the v1 canonical shape and
  lift it into the catalog as pattern 7 ("fallible-method
  wrapper").

Logged here as the fourth datapoint; the lift-or-flip decision
is upstream.

## ~~topic-rename-asymmetry: publish-side topic refs don't survive cross-seed import~~

**closed 2026-05-17** by upstream `f9068fa` (A1 + A7). The
publish-side topic-ident mangle is wired, and `bus_subject`
admits qualified names. **Source-level cleanup landed
2026-05-18** alongside the TLS wire-up:

- `wire_topics.hl` now declares `topic LlmChunk` /
  `topic LlmDone` with `subject: "agent.llm.chunk"` /
  `subject: "agent.llm.done"` (canonical topic-decl form per
  spec/semantics.md § Topic declarations).
- Bus payloads stay wrapped in a user-defined `type` (codegen
  still rejects raw String payloads); the wrappers were
  renamed to `LlmChunkMsg` / `LlmDoneMsg` to avoid colliding
  with the topic-ident names in the same namespace.
- Both clients' bus blocks now read `publish LlmChunk;
  publish LlmDone;` and publish sites are `LlmChunk <-
  LlmChunkMsg { payload: delta };` / `LlmDone <- LlmDoneMsg
  { payload: resp };`.

Subscribers wire up via `subscribe llm::LlmChunk as h;` (no
`of type T` — the topic carries the payload type, which is the
wrapper struct `llm::LlmChunkMsg`). Original entry retained
below for context.

CONTRACTS.md declares:

```hale
locus AnthropicClient {
    bus { publish LlmChunk; publish LlmDone; }
}

topic LlmChunk { payload: String;      }
topic LlmDone  { payload: LlmResponse; }
```

When this lib is imported via `import ".." as llm;`, the seed-
rename map rewrites `topic LlmChunk { }` in `topics.hl` to
`__lib_llm_topics_LlmChunk` but leaves the publish-side ident
inside the AnthropicClient locus untouched — `publish LlmChunk;`
resolves to "unknown topic" at consumer build time:

```
type error: publish references unknown topic `LlmChunk`
  (no `topic LlmChunk` declaration in scope)
```

Identical to the rename-asymmetry pond/subprocess hit (see
`pond/subprocess/process.hl`'s bus block comment). Worked
around the same way:

```hale
bus {
    publish "agent.llm.chunk" of type LlmChunk;
    publish "agent.llm.done"  of type LlmDone;
}

// Inside the run body:
"agent.llm.chunk" <- LlmChunk { payload: delta };
"agent.llm.done"  <- LlmDone  { payload: resp  };
```

Literal-string subjects + explicit `of type T` work because
the subject is data (a String) not a name that needs
resolution against the renamed topic-decl table.

**duplicate-suspected**: this is the second pond lib hitting
this exact issue with the same workaround. A fix in the
compiler's seed-rename pass that ALSO rewrites publish-side
topic-ref idents would let CONTRACTS.md ship as-written.

## topic-vs-type-duality: bus payload can't be raw String

`topic LlmChunk { payload: String; }` is the CONTRACTS.md
shape. The codegen rejects raw String at a bus send site:

```
codegen error: unsupported in codegen v0: bus send payload
  must be a user-type or has-payload enum value; got String
```

This is the v1 bus-send contract — every payload must be a
user-defined type so the bus can lay it out as a known record
(field-by-field copy). Wrap the String in a single-field
`type LlmChunk { payload: String; }` and the send becomes
`"agent.llm.chunk" <- LlmChunk { payload: delta };`. We do
that — `LlmChunk` / `LlmDone` are declared as `type`s rather
than `topic`s in `wire_topics.hl`.

The CONTRACTS.md `topic` keyword does double duty (subject
declaration + payload type binding). We dropped the
publish-side `topic` form on account of the rename-asymmetry
issue above, so the `topic` keyword does no useful work for
us either way — the `type` form is strictly more flexible.

## codegen-file-order: type forward-refs fail in topic-decl files

Files in a seed are processed in alphabetical order. The
`type LlmDone { payload: LlmResponse; }` decl in topics.hl
references `LlmResponse` declared in `types.hl`. With files
named `topics.hl` + `types.hl`, alphabetical order processes
`topics.hl` first and codegen fails:

```
codegen error: unsupported in codegen v0: unknown type name
  `__lib_llm_types_LlmResponse` in signature
```

Worked around by renaming the file to `wire_topics.hl` so it
sorts AFTER `types.hl` and `wire.hl`. Ugly — the F.19 seed
model promises name resolution is order-free
("the typechecker flattens before name lookup"). Type
resolution at codegen is *not* order-free under the same
promise. Two-pass codegen would fix this.

Logged as a compiler issue, not lifted further because the
workaround (one-character filename change) is cheap.

## eager-buffering: streaming path drains the whole response first

`AnthropicClient.stream` and `OpenAiClient.stream` send the
request with `stream: true` in the body + `Accept:
text/event-stream`, but the implementation drains the entire
HTTP response off the socket via `__drain_stream` BEFORE
walking the SSE frames and firing per-chunk `LlmChunk` topics.

A true low-latency client would feed each `recv_bytes` chunk
into the SSE buffer and publish chunks as they arrive:

```hale
// Aspirational shape:
while !stream_done {
    let chunk = s.recv_bytes(8192);
    if len(chunk) == 0 { break; }
    sse_buf = sse::feed_chunk(sse_buf, chunk);
    while {
        let line = sse::next_data_line(sse_buf);
        if !line.has_line { break; }
        sse_buf = line.remaining;
        // publish delta + accumulate text
    }
}
```

The v1 shape sacrifices that for a simpler control flow (one
round-trip drain, then one pass over the body) because:

- HTTP/1.1 with `Connection: close` means the server closes
  the socket after the response, so draining to EOF gives us
  the whole response cleanly.
- Interleaving send + recv on the same fd with mid-recv
  publish doesn't bend naturally to the current
  `std::io::tcp::Stream` surface; we'd need a `Stream` mode
  that yields between recv calls so the bus can drain its
  mailbox.
- Short prompts (the typical agent-orchestration case) fit
  in one or two recv chunks anyway — the difference is
  invisible.

**Future**: a chunked-recv mode + an `on_chunk: fn(Stream)
-> Bool` callback on `__drain_stream` would let the streaming
loop publish per-chunk without changing the public surface.

## duplicate-suspected: SSE framing

The SSE-frame buffer + `data:` extractor in `sse.hl` is
duplicate-suspected. The Anthropic streaming format, the
OpenAI streaming format, and (as workloads materialize) any
other LLM vendor's streaming format all use the same
`\n\n`-separated frame shape with `data:` payload prefix.
A second pond consumer + this lib + the hypothetical third
LLM vendor = 3 hits, the moment for a lift into `pond/sse/`
as a dedicated lib.

Held off because:
- Only one current consumer (this lib).
- `sse::next_data_line` carries vendor-specific end-of-stream
  sentinels (`[DONE]` for OpenAI, `event: message_stop` for
  Anthropic). Lifting needs a hook for per-vendor sentinels.
- The whole module is 100 lines — cheap to copy until the
  third consumer.

## duplicate-suspected: JSON request shaping

`wire.hl`'s `__build_anthropic_body` and `__build_openai_body`
share a tab-separated message walker (`__next_field`) plus
the boilerplate `b.begin_object()` / `b.string_field()` etc.
Two adapters today; a third vendor (Gemini, Mistral, etc.)
would push the shared pieces up.

The walker (`__next_field` over tab-separated strings) is the
broader duplicate — `pond/router` does the same over its
`RouteParams.path_kv`, `pond/agent/conversation` does it over
history. A `std::iter::TabFields` (or `std::str::split_tab`)
would lift the pattern. Stays inlined here.

## duplicate-suspected: __extract_field_raw is a copy of stdlib internal

`__extract_field_raw` in `wire.hl` does the same job as
`std::json`'s internal `__json_find_field_raw` — find a
top-level field and return its raw token (preserving brace /
bracket / quote nesting). We need this for the *nested*
object case (Anthropic's `usage`, OpenAI's `choices[0].
message`) that the flat `find_string_field` / `find_int_field`
helpers don't descend into. The stdlib helper isn't exported.

**Fix path** (in stdlib): export
`std::json::find_object_field(json, name) -> String` and
`std::json::find_array_field(json, name) -> String` so the
nested case has a typed surface. Same code, exported name.

## ~~dependency-on-http-client: pond/http/client doesn't currently build~~

**closed 2026-05-17.** `pond/http/client` builds clean now —
the parse errors below were artefacts of an older snapshot.
The lib still inlines the URL parse / dial / drain helpers
rather than importing `pond/http/client`, but that's a
no-transitive-import architectural choice (every consumer of
`pond/agent/llm` would also need to vendor `pond/http/client`),
not a build-failure workaround. The fold-back to importing
`pond/http/client` remains the suggested v1.x cleanup if the
no-transitive-import rule relaxes. Original entry retained below
for context.

Per the assignment, this lib *should* depend on
`pond/http/client` for URL parsing + the
`Request` / `Response` / `HttpError` shapes. As of the build
attempt:

```
$ hale build pond/http/client/
http/client/client.hl: 42:56: parse error: expected ;, got Ident("HttpError")
http/client/client.hl: 147:16: parse error: expected }, got StringLit("")
http/client/types.hl:  30:20: parse error: expected ;, got StringLit("")
...
```

`pond/http/client` is a parallel build. It uses `or fail
HttpError { ... }` as a disposition, which the parser doesn't
accept (`spec/semantics.md § or disposition` lists
`or raise`, `or <value>`, `or handler(err)`, `or discard` —
no `or fail`). It also uses `Bytes = b""` as a default value,
which the parser also doesn't accept.

We deviated by inlining what we need:

- A minimal `__parse_base_url` in `anthropic.hl` (same
  algorithm as `pond/http/client/url.hl`'s `parse_url`).
- Direct `std::io::tcp::connect` + `Stream.send` for the
  HTTP exchange — no `http::request(req)` indirection.
- An inline `__connect_or_llm_err` translator from `IoError`
  to `LlmError`.

Once `pond/http/client` builds cleanly, the inline pieces here
should fold back into:

```hale
import "../../http/client" as http;

// __parse_base_url → http::parse_url
// __dial + __drain → http::request(http::Request { ... })
```

That's a future cleanup pass; not breaking anything today.

## design-question: LlmRequest.messages encoding

CONTRACTS.md declares `LlmRequest.messages: String` with no
specified encoding. This lib chose tab-separated
"role\tcontent\trole\tcontent\t..." pairs because:

- Mirrors `pond/router::RouteParams.path_kv` ("k1\tv1\tk2\tv2")
  and `pond/agent/conversation::Conversation.history` (per
  CONTRACTS.md "tab-separated messages").
- Keeps `LlmRequest` constructable from a struct literal with
  no per-message allocation.
- Round-trips through `__next_field` cleanly at the wire-
  format-build step.

Alternatives considered:

1. **JSON string** — `messages: String` carries `[{"role":...},
   ...]` ready for inline-quote into the wire body. Forces
   callers to escape strings themselves and re-parses our own
   output. Heavier for the common case.
2. **Newline-separated** — same shape with `\n` instead of
   `\t`. Conflicts with the v1 `read_line` family.
3. **Repeat fields** — `LlmRequest { messages_0_role: "user",
   messages_0_content: "...", ... }`. Hard cap on count;
   ugly.

Sticking with tab-separated for v1; the shape is documented
in the README + in `LlmRequest`'s field comment.

## design-question: Anthropic's mandatory max_tokens

The Anthropic API REQUIRES `max_tokens` in the request body
(non-optional). CONTRACTS.md's `LlmRequest.max_tokens` defaults
to `0` (meaning "use vendor default"). We resolve by inserting
a fallback of 1024 when `max_tokens <= 0` at the wire-build
step (`__build_anthropic_body`):

```hale
let mut max_tok = req.max_tokens;
if max_tok <= 0 { max_tok = 1024; }
b.int_field("max_tokens", max_tok);
```

OpenAI's `max_tokens` IS optional — we omit the field when
`<= 0`. The asymmetry surfaces a CONTRACTS.md design choice:
either bump the default to 1024 (or some other reasonable
value) at the type-decl site, or document the per-vendor
behavior (current state).

## design-question: streaming surface returns Unit

`fn stream(req: LlmRequest);` returns Unit per CONTRACTS.md —
the implication is that all output flows through the bus
(`LlmChunk` + `LlmDone`). We honor that. Two open questions:

1. **Synchronous or async?** Today the method blocks on the
   recv-drain loop, then publishes everything inline. A
   future "real" streaming impl (see "eager-buffering" above)
   would still be synchronous-from-the-caller's-perspective
   — the bus is the async piece.
2. **Where do errors surface?** The bus emits `LlmDone` even
   on failure (with empty `LlmResponse` payload). The
   actually-failed nature of the call surfaces only through
   `client.last_error_kind() != ""`. Subscribers can't
   distinguish "success with empty response" from "failed
   call" without polling the client's `last_error`. A
   future `LlmFailed` topic carrying the LlmError would let
   subscribers tell them apart on the bus directly.
