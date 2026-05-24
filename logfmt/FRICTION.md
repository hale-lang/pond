# pond/logfmt — FRICTION

Gaps, suspicions, and deviations from CONTRACTS.md surfaced while
building this lib.

## deviation: fallible-on-locus-method

`pond/CONTRACTS.md § pond/logfmt/` declares the Sink-shape methods
as `fallible(IoError)`:

```hale
locus FileSink {
    fn write(s: String) -> () fallible(IoError);
    fn line(s: String)  -> () fallible(IoError);
    fn newline()        -> () fallible(IoError);
}
```

AGENTS.md "What's NOT in the language" pins the rule:

> **No `fallible(E)` on locus methods.** Free fns and
> `@form(...)`-synthesized methods are the only fallible surfaces.
> Locus methods communicate failure structurally via the `↑`
> channel (closures + `on_failure`). Two-channel rule, locked.

Per the rule, the surface in CONTRACTS.md cannot be implemented
verbatim. This lib follows the same workaround `pond/http/client`
adopted for its `Client` locus (see that lib's FRICTION.md, same
section title):

- methods declared with `-> ()` (not `fallible(IoError)`)
- the body addresses the value channel from inside via
  `or self.__handle_io(err)`
- the handler captures `e.kind` / `e.errno` / `e.path` into
  `self.last_kind` / `self.last_errno` / `self.last_path`
- public accessors `last_error_kind()`, `last_error_errno()`,
  `last_error_path()` expose the captured state

The shape composes well with the F.27 error-check-fn pattern
(`spec/styleguide.md § 7`) — `__handle_io` is exactly that
shape, sans the `violate` because none of the IO errors here
warrant draining the locus.

Either the contract needs to flip the methods' return shape to
`-> ()` + capture-and-accessor (matching the http::Client
deviation already in the wild), or the language needs to lift
the two-channel rule for stdlib-style Sink-shaped loci. v1
declines to invent either option; this lib follows the existing
http::Client deviation.

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

## ~~blocking: no-rename-no-unlink-in-fs-stdlib~~

**Resolved 2026-05-17** by upstream `cc94a1b` (C9: `std::io::fs::
{rename, unlink, mktemp}`). pond pass C9 swapped `FileSink.__rotate`
from the read-then-write copy shim to atomic `rename`. The eviction
of the oldest backup is now implicit (Linux `rename(2)` overwrites
the destination atomically). `__handle_io_read` deleted; the read
side is no longer touched. Behavioral note: the active log file is
absent briefly between rotation and the next append (the file is
recreated by `write_file_append`'s `O_CREAT` on the following
write). This matches the standard rename-based rotation pattern;
the prior truncate-in-place behavior was the workaround. Original
entry retained below.

## blocking: no-rename-no-unlink-in-fs-stdlib (pre-C9 context)

`FileSink`'s rotation policy is the standard "shift `.N-1` → `.N`,
overwrite the oldest, truncate the active path." On every
filesystem this is normally implemented with `rename(2)` (or
`renameat2`) for the in-place shifts plus `unlink(2)` for the
oldest. `std::io::fs::*` ships neither at v1:

```
$ grep -n "lotus_fs_" crates/hale-codegen/src/codegen.rs | grep -E "rename|unlink|remove"
(no output)
```

Available primitives (per `spec/stdlib.md § "shipped module surface"`):

| primitive | shape |
|-----------|-------|
| `read_file(path) -> String fallible(IoError)` | yes |
| `write_file(path, content) -> () fallible(IoError)` | yes — truncates |
| `write_file_append(path, content) -> () fallible(IoError)` | yes |
| `file_size(path) -> Int fallible(IoError)` | yes |
| `file_exists(path) -> Bool` | yes |
| `rename(src, dst)` | **missing** |
| `remove_file(path)` / `unlink(path)` | **missing** |

The lib's workaround: each shift is a `read_file(src) →
write_file(dst, buf)` pair. The "oldest gets dropped" step is the
natural consequence of the chain — when `.N` is overwritten by
`.N-1`'s content, the previous `.N` is gone. Correctness holds; the
cost is one extra read+write per rotation per shifted slot, and
peak memory is `O(max_size_bytes)` because the read pulls the
whole file into a String before the write goes out.

For a 10 MB cap that's 10 MB resident during the shift — fine for
log rotation, painful if the same trick had to scale further. The
real fix is `std::io::fs::rename(src, dst) -> () fallible(IoError)`
and `std::io::fs::remove_file(path) -> () fallible(IoError)`, both
trivial libc wrappers (`rename(2)` and `unlink(2)` already linked
by the runtime). Filed here for the stdlib backlog.

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
