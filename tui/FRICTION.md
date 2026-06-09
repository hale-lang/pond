# pond/tui — friction log

## duplicate-flagged: glue-duplicated-from-term (G34)

`glue.c` is a copy of `pond/term/glue.c` under `tui_`-prefixed
symbols, and the SGR/escape emission in `screen.hl` re-derives
what `pond/term`'s ansi.hl/style.hl provide. Two independent
blockers:

1. **G34 two-hop break** — `import "../term" as term;` would
   typecheck but every `term::Style { ... }` / `term::RawMode
   { }` literal inside this lib fails codegen (`qualified-name
   struct literal in expression position`).
2. **@ffi symbol collision** — @ffi symbols are not mangled
   (spec/ffi.md), and each imported lib's `[ffi] csrc` compiles
   into the same link. Sharing `term_*` symbols would
   duplicate-symbol any app vendoring both libs, so the copy
   *must* rename even if G34 lifted today.

Cleanup recipe when G34 lifts: drop ansi duplication by calling
`term::` fns; keep glue.c but shrink it to the raw-mode +
read/write shims under the `tui_` prefix (or better: both libs
consume the `std::term` primitives proposed in
`pond/term/FRICTION.md` `stdlib-term-primitives`, and the glue
disappears from both).

## gap: no-append-str-on-bytesbuilder

`std::bytes::BytesBuilder` has `append(chunk: Bytes)` and the
binary-pack writers (`append_u8` ...) but no `append_str(s:
String)`. The frame renderer appends many small string
fragments per flush; materializing a `Bytes` per fragment via
`std::bytes::from_string` would allocate per call, so
`screen.hl` ships a `__append_str` helper that byte-walks the
String through `append_u8`. Costs one C-call per byte (~10k
calls for a full-frame redraw — fine at frame rates, just
inelegant).

**Proposed stdlib unblock:** `BytesBuilder.append_str(s:
String)` — one strlen + memcpy in the C primitive. Trivial
addition with an obvious consumer.

## gap: frame-clone-per-flush

`flush()` ends with
`tui_write_stdout(std::str::clone(self.frame.text_view()))` —
one full copy of the frame per flush. The clone exists because
the `@ffi` String parameter wants an owned C string and the
StringView → String coercion at @ffi call boundaries is
untested surface; the clone makes the call unambiguous.
Steady-state frames are tiny (tens of bytes) so the copy is
noise, but the first frame / full redraws copy the whole frame
buffer.

**Follow-up:** either confirm the view coercion fires at @ffi
arg positions (then pass `text_view()` straight through —
zero-copy since the builder's buffer is already NUL-terminated)
or declare the extern as `fn tui_write_view(v: StringView)`
(spec/ffi.md marshals views as the 16-byte `lotus_view_t`).

## heuristic: unicode-width-heuristic

`char_width(cp)` is ~16 range checks covering combining marks,
the major CJK/Hangul/fullwidth blocks, and the core emoji
blocks. It is NOT the full Unicode EastAsianWidth + emoji
data: ZWJ sequences render wrong (each scalar counted
separately), variation selectors aren't handled, and rarer
wide blocks are missed — a mis-measured glyph shifts the rest
of its row.

**Follow-up:** generate a complete range table from
`EastAsianWidth.txt` + `emoji-data.txt` into a checked-in
`.hl` file (binary search over a const array). Build-time
codegen, no language change needed.

## limitation: textinput-no-mid-line-cursor

`TextInput` edits at end-of-line only (append + UTF-8-aware
backspace). Mid-line cursor movement / insertion needs
byte↔column mapping kept as widget state; deferred until a
consumer needs it.

## limitation: paste-terminator-assumed-wellformed

The bracketed-paste parser consumes 5 bytes after an ESC inside
a paste, assuming the well-formed `[201~` terminator terminals
emit atomically. A hostile/broken sequence ends the paste early
and may eat one stray event. Acceptable for v1; a strict
matcher is a contained follow-up in `__parse_paste`.

## upstream: stdin-not-parkable

The frame loop poll-sleeps in `tui_read_byte(frame_budget)` —
correct and cheap (one poll(2) per frame), but a busy app
sharing the process (bus subscribers on other pools) would
prefer the input fd parked on an `where async_io` pool like
sockets are (F.35 covers recv/accept/send, not stdin).
Logged as the long-term shape; the poll loop is fine for v1.
Note the frame loop services the cooperative queue only between
frames; a TUI app that also subscribes to bus topics should keep
handlers on other pools or accept frame-granularity delivery.

## upstream: panic-exit-bypasses-atexit

Same entry as `pond/term/FRICTION.md` — `_exit(1)` runtime
panic paths (F.30b stale-view) bypass the glue's atexit
terminal restore. An alt-screen TUI hitting one leaves the
terminal raw + on the alternate screen. Routing runtime panics
through `exit()` upstream closes it for both libs at once.
