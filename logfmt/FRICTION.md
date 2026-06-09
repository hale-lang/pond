# pond/logfmt — FRICTION

Gaps, suspicions, and deviations from CONTRACTS.md surfaced while
building this lib.

## deviation: fallible-on-locus-method — [EXEMPT — interface-binding]

**2026-06-08 resolution.** This lib is NOT a pending fallible
migration. It is an **interface-binding exemption** under the
v0.8.1 two-channel rule. The central status note (`## 2026-05-27
status note` in CONTRACTS.md) lists logfmt's
`write`/`line`/`newline` as scheduled to flip to `fallible(E)`;
that scheduling is incorrect for this lib and should be retracted.

**Reason — the satisfied interface is non-fallible.**
`FileSink.write/line/newline` and `OtlpSink.write/line/newline`
exist to *structurally satisfy* `std::text::Sink`. (Note: the
satisfied interface is `std::text::Sink`, NOT `std::log::Sink` —
`std::log` ships no `Sink` interface at all; its sinks are bus
subscribers with an `on_event` method. The text-Sink triple is
what callers thread where a `Sink` param is expected.) The
verbatim stdlib declaration
(`crates/hale-codegen/runtime/stdlib/text.hl`,
`interface __StdTextSink`) is:

```hale
interface __StdTextSink {
    fn write(s: String);   // non-fallible
    fn line(s: String);    // non-fallible
    fn newline();          // non-fallible
}
```

v0.8.1 lets a user `fn` member declare `fallible(E)`, but a method
that must satisfy a non-fallible interface CANNOT — the fallible
signature no longer matches the interface, so coerce-to-interface
(text.hl's F.20 Phase B fat-pointer path) would reject the locus at
every consumer call site that passes a `FileSink`/`OtlpSink` where
a `std::text::Sink` is expected. Flipping these to
`() fallible(IoError)` would BREAK interface satisfaction.

**Therefore the methods STAY non-fallible.** Being interface-bound,
they are effectively a substrate-facing surface and keep the
*structural* channel for failures. The value-channel escape hatch
stays as the correct mechanism for an interface-bound sink:

- methods declared with `-> ()` (matching `std::text::Sink`)
- the body addresses the underlying fallible
  (`std::io::fs::write_file_append`) from inside via
  `or self.__handle_io(err)`
- the handler captures `e.kind` / `e.errno` / `e.path` into
  `self.last_kind` / `self.last_errno` / `self.last_path`
- public accessors `last_error_kind()`, `last_error_errno()`,
  `last_error_path()` expose the captured state

These accessors and the `__handle_io` capture are NOT dead state —
they are the only way an interface-bound (non-fallible) sink can
surface a value-channel IO failure. They are exercised by
`examples/rotated-file/main.hl` and documented in README.md. No
cleanup applies; the contract's `fallible(IoError)` Sink-method
signatures in CONTRACTS.md are themselves unimplementable against
the real `std::text::Sink` and should track this exemption.

## blocking: otlp-transport-stubbed

The `OtlpSink` locus is wired through the bus subscription, the
batch buffer, the OTLP/JSON payload assembly (`std::json::Builder`,
verified), and the severity-number mapping. **The HTTP POST itself
is stubbed.** `__post_batch` clears the buffer and writes
`last_kind = "transport_stub"` instead of calling
`http::post(self.endpoint, body, "application/json")`.

The blocker is the v1 no-transitive-import rule
(`spec/projects.md § "No transitive resolution"`):

> Imports declared in imported libraries are NOT followed by the
> resolver. The lib's own source may have `import` lines (they
> parse fine), but the build does not resolve them transitively.

If `otlp_sink.hl` declares `import "../http/client" as http;` at
the top, every reference inside the lib to `http::HttpError`,
`http::Response`, `http::post` becomes an unresolved qualified
identifier at every downstream importer's build site. The error
fires as:

```
codegen error: unsupported in codegen v0: qualified type
`http::HttpError` not in stdlib path-renames table
```

(reproduced by uncommenting the `import` line, adding the real
`__post_batch` body, and running
`hale build pond/logfmt/examples/rotated-file/`).

The pond design rule already requires consumers to vendor
transitive deps themselves:

> 4. No transitive deps in v1: a consumer that uses `pond/jobs`
>    (which uses `pond/sqlite`) must vendor both.

But "vendor both" isn't enough at the source level — the
consumer also has to `import "vendor/pond/http/client" as http;`
in *every file* that touches a logfmt symbol, so the alias `http`
is bound in the same translation unit logfmt's references
resolve in. That cascades the lib's transport dependency into
every consumer's source files, which is a usability cliff: the
OTLP-sink-aware consumer suddenly owns the http import surface.

Two paths forward, neither in this lib's hands:

1. **Lift the no-transitive-import rule** for the narrow case of
   imports-declared-by-imported-libs. The resolver would walk
   one level deeper and pre-bind the chained alias. This is a
   language-substrate change.
2. **Provide a path-call surface for HTTP in std::http** so the
   transport call doesn't need a `pond/http/client` import.
   Smaller change but locks an HTTP client into stdlib.

Until one of those lands, the stub stays. `pending_payload()`
exposes the OTLP/JSON bytes a real transport *would* ship, so a
consumer with its own HTTP surface can flush externally:

```hale
let s = logfmt::OtlpSink { endpoint: "...", batch_size: 1 };
let log = std::log::Logger { name: "app" };
log.info("hello");          // → enqueued → batch_size=1 hit → assembled
let payload = s.pending_payload();     // returns "" — buf was cleared
                                       // by the stub flush; collect via
                                       // a wrapper subscriber instead
```

The file ends with the exact replacement block needed once the
language gate clears (or the consumer accepts the import
cascade); it's a five-line swap.

## duplicate-suspected: last-error capture triple

The "two-channel deviation" workaround above is now the **third**
pond lib carrying a near-identical `last_kind` / `last_*` triple +
accessor methods + per-error-shape `__handle_*` capture fn:

- `pond/http/client::Client` (`last_kind` / `last_status` / `last_detail`)
- `pond/logfmt::FileSink` (`last_kind` / `last_errno` / `last_path`)
- `pond/logfmt::OtlpSink` (`last_kind` / `last_status` / `last_detail`)

The shape repeats whenever a locus method needs to surface a
value-channel failure that the F.27 closure-violation flow is too
heavy for. Candidates for centralization:

1. **A pond `dev/error-capture/` namespace lotus** with a
   parameterized "capture-and-stash" surface — but a captured
   error's fields are per-error-type, so the namespace would
   have to be generic, and v1 has no generics.
2. **An `@form(error_capture)` annotation** that synthesizes the
   triple + accessors for a declared error type. Would compose
   with `@form(vec)` etc. but adds a new form-library member,
   which is a substrate change.
3. **A stdlib `std::error::Captured(E)` shape** — same generic
   problem, language-level fix.

For now each lib re-implements the triple. Flagged here per
AGENTS.md's "If a helper looks reusable, log
'duplicate-suspected' in FRICTION.md."

## design-question: empty active log post-rotation

After the demo's 100-event run with `max_size_bytes: 512` and
`keep_files: 3`, the active log file ends at size 0 (the final
rotation truncated it, no further events came). The rotation
chain holds the most recent ~30 events; events 0..69 are gone
(evicted past `.3`).

This is correct ring-buffer behavior, but a casual reader
inspecting the active log file post-run sees an empty file and
might assume the demo silently dropped output. The README spells
this out explicitly, and the demo's assertion explicitly checks
that `.1` exists rather than that the active log is non-empty.

An alternative shape — "rotate iff the *new* write would exceed
the cap, not just the post-write size" — would keep the active
log non-empty steady-state. Cleaner UX but requires
pre-counting the bytes, which `write_file_append` doesn't
report. Sticking with the post-write check at v1.

## design-question: OtlpSink::write/line/newline both same severity

The std::text::Sink interface has three methods that differ only
in trailing-newline semantics; `OtlpSink` ignores that distinction
because OTLP logRecords don't have a "partial line" concept — every
record is one body string. Every text-sink call enqueues a
synthetic event at INFO with path `logfmt.text`. The on_event path
preserves the source severity from `std::log::LogEvent.level`.

The shape is fine for the "drop-in for std::log::StdoutSink" use
case (that path doesn't hit write/line/newline at all — it goes
through on_event). It's lossy for the rarer "stream raw text to
OTLP" path; if a workload surfaces that, a follow-up could let the
caller stamp a severity via a params field.

## duplicate-flagged: ansi-helpers-duplicated (G34)

ConsoleSink carries its own SGR escape literals (the `paint` /
`badge` helpers in `console_sink.hl`) instead of importing
`pond/term`'s `Styler`. The G34 two-hop codegen break
(`pond/CLAUDE.md`) keeps tier libs from importing each other —
`term_alias::Style { ... }` literals inside this lib would fail
at codegen with `unsupported in codegen v0: qualified-name
struct literal in expression position`.

The duplication is tiny (six escape strings + a wrap fn) and the
profile machinery is intentionally NOT duplicated: ConsoleSink
exposes a single `color: Bool` knob and lets callers who vendor
`pond/term` pass the real probe (`color: term::is_tty(2)`).
When G34 lifts, the cleanup pass swaps `paint`/`badge` to
`term::Styler` and adds a `profile: Int` param.

Related: there is no FFI-free way to ask "is stderr a tty", so
`color` defaults to `true` and only NO_COLOR forces it off. The
right fix is upstream — see `pond/term/FRICTION.md`
`stdlib-term-primitives` (proposes `std::term::is_tty`).
