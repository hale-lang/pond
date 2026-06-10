# pond/term — friction log

Deviations, gaps, and proposed upstream unblocks surfaced while
building the terminal control surface. Format per pond
convention: one entry per item, smallest repro, proposed unblock.

## `panic-exit-bypasses-atexit` — RESOLVED upstream (hale #106, 2026-06-09)

**Was:** the F.30b stale-view panic (`lotus_view_stale_panic`)
used `_exit(1)`, bypassing the atexit termios/screen restore
this lib's glue installs — a raw-mode program tripping it left
the user's terminal raw.

**Fix (upstream):** `lotus_view_stale_panic` now calls
`exit(1)`, matching `lotus_root_panic` — atexit hooks run on
every runtime panic path. Upstream added a regression test
(`panic_atexit::view_stale_panic_runs_atexit_cleanup`) that
installs an atexit hook via FFI glue exactly the way this lib
does. No pond-side change needed; the glue's hook now covers
panic, error, and normal return uniformly. (SIGKILL remains
unrecoverable — true everywhere.)

## `stdlib-term-primitives` — RESOLVED upstream (hale #108–#110) + cleanup DONE (2026-06-10)

**What:** `term_isatty` / `term_size_packed` /
`term_write_stdout` / `term_read_byte` / raw-mode toggles are
generic OS surface, not terminal-styling logic. Color-aware
*logging* (pond/logfmt's ConsoleSink) shouldn't need to vendor
an FFI lib just to ask "is stdout a tty"; today it takes a
`color: Bool` param instead and documents passing
`term::is_tty(1)` (see `logfmt/README.md`).

**Status (2026-06-09):** upstream scoped the design in
`hale/notes/stdlib-term-primitives.md` — `std::term::{is_tty,
size, RawMode}` + `std::io::stdout::write_bytes` +
`std::io::stdin::read_byte`, with real shapes (a TermSize
record + fallible instead of the cols<<16|rows pack) and a
std-side RawMode guard locus whose runtime primitive registers
the atexit termios restore. Parkable-stdin-on-async_io and key
decoding are explicitly deferred (the latter stays library
territory — this lib / pond/tui).

**Unblocked + cleaned up (2026-06-10):** hale #108–#110 shipped
the full scoped surface — `std::term::{is_tty, size, RawMode}`,
`std::io::stdout::write_bytes` (with a fflush-before-raw-write
ordering fix ours lacked), `std::io::stdin::read_byte` — with
pond's glue bodies moved upstream verbatim. The recipe above is
executed: `glue.c` + `hale.toml` + the `term_*` externs are
deleted; `is_tty`/`width`/`height`/`write_raw`/`read_byte` are
thin delegates; `RawMode` wraps `std::term::RawMode` (keeping
the `is_active()` probe the std guard doesn't expose).
`pond/tui` likewise dropped its `tui_*` copies, and
`logfmt::ConsoleSink` gained the real tty probe (auto color).
This lib is pure Hale now.

## `ffi-symbols-not-namespaced` — C symbol collisions across FFI libs

**What:** `@ffi("c")` symbols are NOT mangled per-import
(`spec/ffi.md`: "The LLVM symbol name is the literal Hale fn
name as written"), and every imported lib's `[ffi] csrc` files
are compiled into the same link. Two pond libs shipping a
`glue.c` that defines the same symbol produce a duplicate-symbol
link error in any app vendoring both.

**Status (2026-06-10):** moot for term/tui — both libs' glue
retired when the primitives moved upstream (hale #108–#110);
`heron/` is pond's only FFI lib again. The entry stays as the
documented convention for any future FFI-bearing lib: claim a
unique C symbol prefix.

**Proposed upstream unblock:** none needed immediately;
documenting the convention here. If FFI libs proliferate, a
lib-id-derived symbol-prefix check (or weak-symbol convention)
at the build layer would make collisions a diagnostic instead of
a linker error.

## `int-only-ffi-packing` — RESOLVED by the stdlib move (2026-06-10)

**Was:** `@ffi` rejects tuple returns, so the size shim packed
`(cols << 16) | rows` into one Int. The upstream
`std::term::size()` returns a real `TermSize { cols, rows }`
record (path-calls aren't FFI-constrained); pond's `width()` /
`height()` now read it directly. The packing is gone.

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

## method-name-shadowed-by-fn — FIXED upstream (hale #104, 2026-06-09)

**Was:** a cross-seed method call failed at codegen when the
imported seed had a top-level fn sharing the method's name
(`fn title` in ansi.hl + `Console.title` → importing program's
`c.title(...)` died with `locus ... has no method 'title'`).

**Actual root cause (per the upstream fix — opposite of this
entry's original guess):** the call site was fine; the mangler's
`walk_fn_decl` renamed the method *declaration* through the
seed's top-level rename map, producing a decl/use mismatch.
Fixed by routing `LocusMember::Fn` through a `walk_method_decl`
that walks the body but never renames the method. Regression
test upstream:
`cross_seed_imports::method_name_shadowed_by_top_level_fn_resolves`.

**Names kept by choice:** `window_title` (clearer than `title`
for the OSC-0 builder) and `write_raw` (distinguishes the raw
fd-1 write from `Console.write`'s Sink-shape passthrough) stay
— they read better, the constraint just no longer forces them.
