# pond/logfmt — drop-in log sinks for `std::log`

Alternative `std::log` sinks that wear the `std::text::Sink` shape
(F.20-structural — no `impl I for L`) and subscribe to `log.**` the
same way `std::log::StdoutSink` does. Use these in place of the
stdlib sink when you want events to land somewhere other than
stdout/stderr.

## Suggested alias

```hale
import "vendor/pond/logfmt" as logfmt;
```

The bare alias `logfmt` matches `pond/CONTRACTS.md` and
`pond/README.md` § Tier 2.

## Sinks

| Locus | Destination | Status |
|------|-----------|--------|
| `FileSink`  | Appends to a path; size-based rotation | shipped |
| `OtlpSink`  | Batches + POSTs to an OTLP/HTTP endpoint | shipped (transport live since 2026-06-12; **vendor `pond/http` too**, see below) |
| `ConsoleSink` | Colored, aligned human-facing console lines (stdout; WARN/ERROR → stderr) | shipped |

Both loci satisfy `std::text::Sink` structurally (`write(s) -> ()`,
`line(s) -> ()`, `newline() -> ()`) AND carry the
`subscribe "log.**"` bus declaration that turns them into log-event
listeners. The dual surface means one locus drop-in-replaces the
StdoutSink at the log-routing layer AND the StdoutSink at the
text-rendering layer.

## Drop-in replacement for `std::log::StdoutSink`

Before:

```hale
fn main() {
    std::log::StdoutSink { };
    let log = std::log::Logger { name: "app" };
    log.info("hello");          // → "[INFO app] hello" on stdout
}
```

After (file destination):

```hale
import "vendor/pond/logfmt" as logfmt;

fn main() {
    logfmt::FileSink {
        path: "/var/log/myapp.log",
        max_size_bytes: 10000000,
        keep_files: 5
    };
    let log = std::log::Logger { name: "app" };
    log.info("hello");          // → appended to /var/log/myapp.log
}
```

Either sink may be paired with `std::log::StdoutSink` — both
subscribe to `log.**` so events fan out to every live subscriber.
Subscribers must be instantiated **before** any `Logger` publishes
(per AGENTS.md's bus-ordering rule); put the sink construction at
the top of `main` or the top of the app locus's `run()`.

## `FileSink` — file with rotation

```hale
locus FileSink {
    params { path: String;
             max_size_bytes: Int = 10000000;
             keep_files:     Int = 5; }

    // std::text::Sink-shape methods
    fn write(s: String);
    fn line(s: String);
    fn newline();

    // log.** subscriber
    fn on_event(e: std::log::LogEvent);

    // last-error accessors (see "two-channel deviation" below)
    fn last_error_kind() -> String;
    fn last_error_errno() -> Int;
    fn last_error_path() -> String;
}
```

Each log event renders to `[LEVEL path] msg\n` (same format
`std::log::StdoutSink` uses) and is appended via
`std::io::fs::write_file_append`. After every append, the locus
calls `std::io::fs::file_size`; if the active path is now larger
than `max_size_bytes`, the chain shifts:

```
path.{keep_files-1} → path.{keep_files}   (oldest is overwritten)
...
path.1              → path.2
path                → path.1
path                ← absent; next append recreates it
```

Each shift is one `std::io::fs::rename` (atomic overwrite on
Linux), so rotation cost is constant — no read-into-memory
round-trip. After the final shift the active path is absent until
the next append recreates it (`write_file_append`'s `O_CREAT`).

## `ConsoleSink` — colored console lines

```hale
locus ConsoleSink {
    params { color: Bool = true;        // true = auto (tty probe at birth)
             show_time: Bool = true; }  // dim HH:MM:SS (UTC) prefix

    // std::text::Sink-shape methods (plain passthrough)
    fn write(s: String);
    fn line(s: String);
    fn newline();

    // log.** subscriber — the colored rendering path
    fn on_event(e: std::log::LogEvent);
}
```

Renders each event as `HH:MM:SS LEVEL path msg` with a colored
width-5 level badge (cyan INFO, bold-yellow WARN, bold-red
ERROR, dim DEBUG/TRACE), dim timestamp + path, plain message.
WARN/ERROR go to **stderr** — the same lane split
`std::log::StdoutSink` uses.

Color policy (auto since hale #108): `color: true` (default)
keeps color only when stderr is a tty (`std::term::is_tty(2)`,
probed at birth) or FORCE_COLOR / CLICOLOR_FORCE is set;
`NO_COLOR` always wins; `color: false` means never.

Demo: `examples/console/` emits one event per level from a
root + child logger; run with `NO_COLOR=1` to see the plain
rendering, `2>/dev/null` to see the lane split.

## `OtlpSink` — OTLP/HTTP batch shipper

```hale
locus OtlpSink {
    params { endpoint:     String;
             service_name: String = "hale-app";
             batch_size:   Int    = 32; }

    // std::text::Sink-shape methods (every call enqueues at INFO)
    fn write(s: String);
    fn line(s: String);
    fn newline();

    // log.** subscriber — preserves the source severity
    fn on_event(e: std::log::LogEvent);

    fn flush();                          // explicit drain (also fired at dissolve)
    fn pending_payload() -> String;      // OTLP/JSON the next flush will POST
    fn batches_count()    -> Int;        // flushes (POST attempts) so far
    fn pending_event_count() -> Int;
    fn last_error_kind() -> String;      // "" = last flush delivered (2xx)
    fn last_error_status() -> Int;
    fn last_error_detail() -> String;
}
```

The full pipeline is live: batching, severity mapping
(`std::log::LogEvent.level` → OTLP `severityNumber`), OTLP/JSON
payload assembly via `std::json::Builder`, and the HTTP POST
itself (`http::post(endpoint, body, "application/json")` via
`pond/http/client`, since 2026-06-12 — see FRICTION.log
`otlp-transport-stubbed`, closed).

Delivery semantics: a batch flushes when `pending_count` reaches
`batch_size`, on `flush()`, and at `dissolve()`. The `last_error_*`
triple is reset per flush and reflects the most recent one — `""`
means the collector answered 2xx; an `http::HttpError` kind
(`"connect_failed"`, ...) means the transport failed; `"non_2xx"`
means the collector rejected the batch. The pending buffer clears
either way (best-effort shipping); callers needing delivery
confirmation check `last_error_kind()` after `flush()`.

**Vendoring:** consumers using `OtlpSink` must vendor `pond/http`
alongside `pond/logfmt` (pond design rule 4 — no transitive deps;
this lib imports `../http/client` internally, so the relative path
must exist in your vendor tree). You do NOT need your own
`import "vendor/pond/http/client"` line unless your code names
`http::*` types itself.

## Two-channel rule — interface-binding EXEMPTION

`pond/CONTRACTS.md` (2026-06-08 status note) records this lib as
EXEMPT from the v0.8.1 `fallible(E)` flip: `write`/`line`/`newline`
exist to structurally satisfy `std::text::Sink`, whose methods are
**non-fallible** — a `fallible(E)` signature would break interface
satisfaction at every consumer that passes a sink where a
`std::text::Sink` is expected. The methods stay non-fallible and
surface value-channel failures through the `last_error_*` capture
triple (`or self.__handle_io(err)` / `or self.__handle_http(err)`
inside the bodies). See FRICTION.log `fallible-on-locus-method`.

## Files

- `file_sink.hl` — `FileSink` locus + rotation.
- `otlp_sink.hl` — `OtlpSink` locus (live OTLP/HTTP transport via
  `pond/http/client`).
- `console_sink.hl` — `ConsoleSink` locus (colored console lines).
- `examples/rotated-file/main.hl` — App-locus demo: log 100 events
  with `max_size_bytes: 512`, then walk the rotated chain and
  verify `.1` exists.
- `examples/console/main.hl` — App-locus demo: one event per
  level through ConsoleSink; exhibits badge colors, NO_COLOR
  fallback, and the stdout/stderr lane split.

## Verification

```bash
# library typechecks (codegen complains about no `fn main()`,
# which is expected for a lib seed)
hale build \
    pond/logfmt/

# rotation demo — build then run
hale build \
    pond/logfmt/examples/rotated-file/
pond/logfmt/examples/rotated-file/rotated-file
```

Expected demo output:

```
--- rotated chain state ---
  active log (/tmp/logfmt-rotated.log): absent
  rotation .1 (/tmp/logfmt-rotated.log.1): exists, size=530
  rotation .2 (/tmp/logfmt-rotated.log.2): exists, size=530
  rotation .3 (/tmp/logfmt-rotated.log.3): exists, size=530
rotated-file: rotation verified
```

(The active log is absent at end-of-run because the final
rotation renamed it to `.1` and no further events were emitted —
exactly the post-rotation steady state; the next append would
recreate it.)
