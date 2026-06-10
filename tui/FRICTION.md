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

## no-append-str-on-bytesbuilder — RESOLVED upstream (hale #105, 2026-06-09)

**Was:** no `append_str(s: String)` on BytesBuilder; the frame
renderer byte-walked Strings through `append_u8` (~10k C calls
per full redraw).

**Fix (upstream):** `BytesBuilder.append_str(s: String)` shipped
(strlen + memcpy primitive; realloc-NULL routes through
`violate alloc_failed` like `append`). `screen.hl` now calls it
directly; the byte-walk helper is deleted. String only, not
StringView — a view carries no terminating NUL, so strlen would
overrun it (slices like `s[lo..hi]` are owned Strings and work).

## frame-clone-per-flush — CLOSED as correct-by-design (hale #105)

**Was:** `flush()` clones the frame
(`std::str::clone(self.frame.text_view())`) before the @ffi
write, pending an answer on StringView → String coercion at
@ffi boundaries.

**Answer (upstream, documented in spec/ffi.md):** StringView
does NOT coerce to a String @ffi param — `lower_ffi_fn_call`
exact-checks the type, and correctly so (no NUL at a view's
end). The per-flush clone is the right shape, not a workaround.
Steady-state frames are tens of bytes, so the copy is noise.
The zero-copy path, if a workload ever measures the full-redraw
copy: declare the extern as `fn tui_write_view(v: StringView)`
(marshals as the 16-byte `lotus_view_t`) and recover ptr+len in
glue. Not worth the glue complexity today.

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

## panic-exit-bypasses-atexit — RESOLVED upstream (hale #106, 2026-06-09)

The F.30b stale-view panic now exits via `exit(1)` instead of
`_exit(1)`, so this lib's atexit restore (termios + leave alt
screen + show cursor) runs on every runtime panic path. See
`pond/term/FRICTION.md` for the full entry; upstream carries a
regression test modeled on exactly this glue pattern.
