# pond/term — friction log

Deviations, gaps, and proposed upstream unblocks surfaced while
building the terminal control surface. Format per pond
convention: one entry per item, smallest repro, proposed unblock.

## `panic-exit-bypasses-atexit` — `_exit(1)` panics skip terminal restore

**What:** `glue.c` installs an `atexit` hook on first
`term_raw_enable()` so the saved termios + a screen reset are
restored on `exit()`-shaped abnormal exits. This covers
`lotus_root_panic` (dprintf + `exit(1)` per `spec/runtime.md`
§ "Process exit"). It does NOT cover runtime paths that call
`_exit(1)` directly — the F.30b stale-view panic
(`lotus_view_stale_panic`) and the shm-ring
handler-must-not-call-exit convention both use `_exit`, which
bypasses atexit by design.

**Consequence:** a program that holds a live raw-mode terminal
and trips a stale-view panic leaves the user's terminal raw
(no echo, no canonical mode) until they type `reset`.

**Proposed upstream unblock:** route runtime panics through
`exit()` uniformly, or expose an abnormal-exit hook the FFI
layer can register cleanup into. Filed as the highest-value
hardening item for terminal-facing programs.

## `stdlib-term-primitives` — five shims that want a `std::` home

**What:** `term_isatty` / `term_size_packed` /
`term_write_stdout` / `term_read_byte` / raw-mode toggles are
generic OS surface, not terminal-styling logic. Color-aware
*logging* (pond/logfmt's ConsoleSink) shouldn't need to vendor
an FFI lib just to ask "is stdout a tty"; today it takes a
`color: Bool` param instead and documents passing
`term::is_tty(1)` (see `logfmt/README.md`).

**Proposed upstream unblock:** `std::term::{is_tty, size}` +
`std::io::stdout::write_bytes` + byte-level
`std::io::stdin::read_byte(timeout)` in the stdlib. The raw-mode
toggle pair could ride along or stay FFI. Longer-term: stdin as
a parkable fd on `where async_io` pools so an interactive app
can park on input instead of poll-sleeping.

## `ffi-symbols-not-namespaced` — C symbol collisions across FFI libs

**What:** `@ffi("c")` symbols are NOT mangled per-import
(`spec/ffi.md`: "The LLVM symbol name is the literal Hale fn
name as written"), and every imported lib's `[ffi] csrc` files
are compiled into the same link. Two pond libs shipping a
`glue.c` that defines the same symbol produce a duplicate-symbol
link error in any app vendoring both.

**Workaround (active):** per-lib C symbol prefixes — this lib
claims `term_*`; `pond/tui` duplicates the same shims under
`tui_*`. Works, but it's convention-enforced only.

**Proposed upstream unblock:** none needed immediately;
documenting the convention here. If FFI libs proliferate, a
lib-id-derived symbol-prefix check (or weak-symbol convention)
at the build layer would make collisions a diagnostic instead of
a linker error.

## `int-only-ffi-packing` — no tuple returns at the FFI boundary

**What:** `spec/ffi.md` rejects tuples in `@ffi` signatures, so
`term_size_packed` returns `(cols << 16) | rows` in one Int and
`width()` / `height()` unpack it Hale-side. Two ioctl calls per
size poll when a caller wants both dimensions.

**Status:** cosmetic; not worth an unblock. Logged so the next
reader knows the packing is deliberate.

## `sigwinch-not-surfaced` — resize is polled, not signaled

**What:** Hale has no user-facing signal surface (SIGINT/SIGTERM
are runtime-owned, per `spec/runtime.md`). Terminal resize is
therefore detected by polling `term_size_packed()` per frame
(pond/tui does this in its Program loop) rather than via
SIGWINCH.

**Status:** polling is the approach several mainstream TUI
runtimes use anyway; cost is one ioctl per frame. No unblock
requested unless a workload surfaces drift between resize and
next frame as user-visible.

## bug-suspected: method-name-shadowed-by-fn — cross-seed method call breaks when a top-level fn shares the name

**What:** with both a top-level `fn title(s: String) -> String`
(ansi.hl, the OSC-0 builder) and a `Console.title(s)` method in
this seed, an importing program's `c.title("...")` failed at
codegen with `locus __lib__console_Console has no method
'title'`. Renaming the free fn to `window_title` fixed it; the
method kept the short name. Same-seed callers were unaffected —
the break is on the imported path, which points at the F.25
mangler rewriting the member name (post-`.` should be
unambiguous member position per `member_name` in
grammar.ebnf, exempt from top-level rename).

**Repro shape:** lib seed declaring `fn foo()` at top level AND
`locus L { fn foo() }`; importer calls `l.foo()` → codegen
error. (`Screen.print` vs the *builtin* `print` does NOT trip
it — only seed-top-level fns through the import mangler.)

**Workaround (active):** no top-level fn may share a name with
any locus method in the same seed. This forced two renames:
`title` → `window_title` (Console.title owns the name) and
`write` → `write_raw` (Console.write is fixed by the
`std::text::Sink` interface shape, so the free fn moved).

**Proposed upstream unblock:** mangler/codegen treat post-`.`
member names as member position (never rewrite), matching the
grammar's `member_name` rule.
