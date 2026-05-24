# pond/sessions — friction log

## Gaps in the language surface

### ~~`time::now()` wall-clock missing~~

**Resolved 2026-05-17** by upstream `ede2786` (C7 stdlib add).
`clock.hl::now_seconds` now calls `std::time::now()` directly;
cookies survive process restarts. Original entry retained below.

`std::time::monotonic()` exists (CLOCK_MONOTONIC, nanoseconds
since boot); there is no `std::time::now()` for wall-clock
seconds since the Unix epoch. The codegen reserves
`CLOCK_REALTIME` for the future `time::now()` per the comment in
`crates/hale-codegen/src/codegen.rs` near `lower_time_monotonic`,
but the surface is not shipped.

Impact on this lib: `SessionStore` stamps expiries with monotonic
seconds (`clock.hl::now_seconds`). Cookies signed by one process
become unparseable-as-expiry by a later process (the monotonic
origin resets), so a deploy invalidates every active session.
For the Rails-shape web app this is the wrong behavior — the
canonical fix is to stamp with wall-clock seconds.

Unblock: add a `std::time::now() -> Int` (or `-> Duration` with a
defined epoch) primitive. The change here is one-line:
`clock.hl::now_seconds` swaps `std::time::monotonic()` for the
new call. Signature and consumer code stay identical.

### ~~Duration → Int conversion~~

**Resolved 2026-05-17** by pond pass D5 (consolidation into
`pond/_util/duration_int`), then **superseded 2026-05-17** by C7
follow-up — `clock.hl` now calls `std::time::now()` directly
(wall-clock seconds since Unix epoch, the right shape for session
TTLs that need to survive a process restart). The Duration → Int
helper is no longer used in this lib; it stays in `_util/duration_int`
for the other consumers (supervisor, tracing, downstream-consumer).

### Duration → Int conversion (pre-D5 context)

`std::time::monotonic()` returns `Duration` (i64 ns). v1 has no
`Int(d)` conversion for Duration — `Int(...)` truncates Float
only. `clock.hl` works around it by stringifying the Duration
(`to_string(d)` → `"123ns"`), stripping `"ns"`, and parsing back
to Int. This is correct but ugly; a direct `duration_ns(d) -> Int`
(or letting `Int(d)` accept Duration) would shorten the helper to
one line.

### ~~v1 `std::http::Response` has no header map~~

**Resolved 2026-05-17** by upstream `965d828` (C11). `Response.headers`
is a CRLF-joined String field with symmetric `header(resp, name)`
lookup; the README example now attaches Set-Cookie through it
directly. Original entry retained below.

`std::http::Response` carries `status`, `content_type`, `body` —
there's no headers field. The Quick Start in the README embeds
the `Set-Cookie` value into the response body for demonstration;
a real server today has to use a custom Stream-driven response
writer to attach Set-Cookie (or wait for the response-headers
follow-up flagged in `spec/stdlib.md § std::http`).

Unblock: a `Response.headers: String` field (same CRLF-joined
shape as `Request.headers`) would let the call site write
`Response { status: 200, headers: "Set-Cookie: " + value, body:
"..." }` directly.

## Contract deviations

### ~~Non-fallible cross-seed free-fn calls don't lower~~

**Resolved 2026-05-17** by upstream `f9068fa` (A3). The `Sessions`
namespace lotus was deleted; the documented free-fn surface
(`sess::sign_payload`, `sess::get_value`, `sess::set_value`,
`sess::now_seconds`, `sess::encode_cookie_value`,
`sess::extract_session_cookie`) is callable directly through the
import alias.

CONTRACTS.md lists the public surface as bare free fns
(`sess::get_value`, `sess::set_value`, `sess::sign_payload`).
Cross-seed non-fallible free-fn calls (`alias::name(args)`
without an `or` clause) fail codegen with:

```
unsupported in codegen v0: path call sess::set_value in expression position
```

— `crates/hale-codegen/src/codegen.rs::lower_path_call_expr`
doesn't consult `mangled_for_path` / `user_fns` on the non-`or`
path. The fallible `or`-disposed path (`sign.hl::verify_cookie(...)
or handler(err)`) DOES work because `lower_or_disp` resolves
through the import-rename table.

**Workaround.** Surface the public non-fallible fns as methods
on a namespace lotus named `Sessions`. Consumers write:

```hale
let s = sess::Sessions { };
let cookie = s.sign_payload(secret, session, now, ttl);
let value  = s.get_value(session, "user");
```

This is the same workaround pond/crypto applies in `crypto.hl`
(see its comment header citing the same codegen path).

**Recommended CONTRACTS.md update:** either acknowledge the
namespace-lotus shape across the affected pond libs, or unblock
the bare-free-fn cross-seed call in codegen so the contract can
ship literally.

### `SessionStore.read` drops `fallible(SessionError)`

`pond/CONTRACTS.md § pond/sessions/` declares:

```hale
fn read(cookie_header: String) -> Session fallible(SessionError);
```

on the `SessionStore` locus. Per
`spec/semantics.md § Fallible call semantics`, user-declared
locus methods may not declare `fallible(E)`. The implementation
drops the marker and surfaces failures via:

- `self.last_error: SessionError` — readable after every call;
  `kind == ""` means success.
- The companion free fn `verify_cookie(secret, header, now)`
  in `sign.hl` *is* fallible(SessionError) — consumers that want
  `or` addressing call it directly without an instantiated locus.

This is the same trend `pond/subprocess/Process` and (in spirit)
every `pond/CONTRACTS.md` "fn X(...) -> T fallible(E)" entry on
a locus is going to hit. The contract document should be updated
to either:

1. Express the binding contract as **the free-fn pair**
   (`read_session` + `write_session`) plus a locus that calls
   them with `last_error` surfaced, or
2. Acknowledge the two-channel deviation directly in CONTRACTS.md
   and tell consumers to read `last_error` from the locus path.

We've taken approach (1) functionally — the free fns `sign_payload`
+ `verify_cookie` are first-class — while keeping the locus
method shape from the contract for source-compatibility.

## Duplicate-suspected

### ~~Tab-separated kv block (`Session.data`)~~

**Resolved 2026-05-17** by pond pass D5 — `pond/_util/kvpack` ships
the `get`/`set`/`has` surface and `sessions/values.hl` now delegates
through it. router and metrics could migrate too in a follow-up
pass; the duplication was a function of the (now-lifted) transitive-
import barrier (A4). Original entry retained below.

### Tab-separated kv block (`Session.data`) (pre-D5 context)

`Session.data` is `k1=v1\tk2=v2\t...`. The same packed shape
appears at least three times in `pond/CONTRACTS.md`:

- `pond/sessions::Session.data`
- `pond/router::RouteParams.path_kv`
- `pond/metrics::Labels.kv`

…with three different free-fn accessor pairs
(`sess::get_value`/`set_value`, `router::path_param`/`query_param`,
no setter yet for `metrics::Labels`). They could all reuse a
single `std::text::kv` namespace lotus or a small `pond/kvpack`
util with `pack/unpack/get/set`. Recommending consolidation; for
now `pond/sessions` ships its own pair to avoid a transitive
dependency on a not-yet-existing util.

### Header-field walker

The `extract_session_cookie` walker in `codec.hl` is structurally
identical to `__find_header` in `pond/http/client/wire.hl` and
`__http_request_header` in `runtime/stdlib/http.hl` (walk a
delimiter-joined block, match a `name=`-style needle, return the
value). The needle / separator pair differs (`session=` vs
`name:` and `; ` vs `\r\n`), but a generalized
`split_kv_first(block, separator, needle) -> String` would cover
all three. Same recommendation as the kv-pack consolidation:
real cross-lib util, not yet a lib.

## Stdlib niceties that would help

- `std::str::split_first(s, sep) -> (String, String)` — would
  replace the index_of + slice + slice pattern that appears
  twice in `codec.hl` and once in `values.hl`.
- A `std::time::wall_seconds() -> Int` would close the session-
  TTL gap above without forcing the full `time::now() -> Time`
  decision.

## Build status

Type-checks cleanly under
`hale build
pond/sessions/`. The example
`examples/login-flow/main.hl` exercises sign → read → tamper →
expire end-to-end via the free-fn surface.
