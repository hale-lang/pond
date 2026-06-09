# pond/term — terminal control: color, styles, console, raw mode

Tier-0 infrastructure for terminal-facing programs: capability
detection (NO_COLOR / FORCE_COLOR / COLORTERM / TERM / isatty),
profile-aware styled output with automatic color downgrade
(truecolor → 256 → 16 → plain), a stylized `Console` printer
(titles / rules / steps / status sigils — the rich-style
upgrade for your program's own stdout), raw ANSI escape
builders, and a `RawMode` locus for per-byte input.

This is the first pond lib after `heron/` to use the
`@ffi("c")` mechanism (`spec/ffi.md`): five libc-only shims in
`glue.c`, picked up automatically through `hale.toml [ffi]`
when you import the lib. No external link deps.

## Suggested alias

```hale
import "vendor/pond/term" as term;
```

## Surface

```hale
// caps.hl — environment-derived color profile
fn detect_profile() -> Int;          // 0 plain / 1 ansi16 / 2 ansi256 / 3 truecolor
fn profile_name(p: Int) -> String;
const PROFILE_NONE / PROFILE_ANSI16 / PROFILE_ANSI256 / PROFILE_TRUECOLOR: Int;

// style.hl — styled text
type Style { fg: Int = -1; bg: Int = -1; bold/dim/italic/underline/reverse/strike: Bool; }
fn rgb(r: Int, g: Int, b: Int) -> Int;       // truecolor encoding for Style.fg/bg
locus Styler {                               // namespace lotus; profile-aware
    params { profile: Int = 3; }
    fn apply(st: Style, s: String) -> String;   // wrap + reset
    fn prefix(st: Style) -> String;             // SGR prefix only
}
fn style_apply(profile, st, s) -> String;    // free-fn core Styler delegates to
fn style_prefix(profile, st) -> String;

// console.hl — the stylized println (one instance per app)
locus Console {
    params { profile: Int = -1;              // -1 = detect at birth
             out_width: Int = 0; }           // 0 = probe (fallback 60)
    fn title(s) / rule(label) / kv(key, value) / bullet(s);
    fn info(s) / success(s);                 // stdout
    fn warn(s) / error(s);                   // stderr
    fn step(n, total, s);                    // [2/5] cargo-shaped
    fn paint(st: Style, s) -> String;        // style without printing
    fn paint_fg(c: Int, s) -> String;
    fn write(s) / line(s) / newline();       // std::text::Sink shape
}

// ansi.hl — raw escape builders (free fns)
fn reset() / cursor_to(row, col) / cursor_home() / cursor_hide() / cursor_show();
fn clear_screen() / clear_line() / alt_screen_on() / alt_screen_off();
fn sync_on() / sync_off();                   // DEC 2026 synchronized update
fn mouse_on() / mouse_off();                 // SGR mouse (1002 + 1006)
fn paste_on() / paste_off();                 // bracketed paste (2004)
fn window_title(s) / hyperlink(url, text);   // OSC 0 / OSC 8

// term.hl — terminal I/O + raw mode
fn is_tty(fd: Int) -> Bool;
fn width() -> Int;                           // 0 when not a tty
fn height() -> Int;
fn write_raw(s: String) -> Int;              // single write(2), bypasses _IOLBF
fn read_byte(timeout_ms: Int) -> Int;        // 0..255 byte / -1 timeout / -2 EOF
locus RawMode {                              // birth enables, dissolve restores
    fn is_active() -> Bool;
}
```

## Canonical use — Console (stylized program output)

```hale
import "vendor/pond/term" as term;

fn main() {
    let c = term::Console { };
    c.title("deploy");
    c.kv("target", "prod-eu");
    c.rule("steps");
    c.step(1, 2, "building image");
    c.success("built in 42s");
    c.step(2, 2, "rolling out");
    c.error("quota exceeded");        // → stderr
}
```

Console is the upgrade for the stdout lane `std::log` doesn't
cover — your program's own output. The two sinks compose:
`logfmt::ConsoleSink` colors what Loggers publish on `log.**`,
`term::Console` colors what the app itself says. Both honor
NO_COLOR and degrade to clean plain text when piped.

## Canonical use — styled output

```hale
import "vendor/pond/term" as term;

fn main() {
    let st = term::Styler { profile: term::detect_profile() };
    let warn = term::Style { fg: 214, bold: true };
    println(st.apply(warn, "WARN"), " disk at 91%");

    let brand = term::Style { fg: term::rgb(255, 135, 0), underline: true };
    println(st.apply(brand, "hale"), " — see ",
        term::hyperlink("https://example.com/docs", "the docs"));
}
```

`Styler` downgrades automatically: the same `rgb(...)` value
emits `38;2;r;g;b` on truecolor terminals, the nearest 6x6x6
cube index on 256-color, the nearest base-16 color on ansi16,
and nothing at all when piped / `NO_COLOR`'d. Call sites never
branch on capability.

## Canonical use — raw mode

```hale
fn read_one_key() -> Int {
    let raw = term::RawMode { };          // birth: termios raw
    if !raw.is_active() { return -2; }    // piped stdin — degrade
    return term::read_byte(5000);
    // scope exit → dissolve → termios restored
}
```

Terminal restore is structural, not best-effort: dissolve fires
at scope exit (m82 timing), the SIGTERM drain cascade reaches it
(F.4), and `glue.c` installs an `atexit` hook on first enable so
`exit()`-shaped panics (incl. `lotus_root_panic`) restore too.
The one uncovered path is `_exit()` — see FRICTION.md.

Notes while raw mode is active:

- ISIG is off: **Ctrl-C arrives as byte 3**, not SIGINT. The
  caller owns the quit path.
- OPOST is off: `println`'s `\n` does not return the carriage.
  Use `term::write_raw` with explicit `\r\n` or cursor addressing.

## Color encoding

One `Int` axis (no parametric color type, per pond convention):
`-1` = terminal default, `0..255` = ANSI palette index,
`16777216 + (r<<16|g<<8|b)` = truecolor (build via
`term::rgb(r, g, b)`).

## Files

- `glue.c` + `hale.toml` — libc FFI shims (`term_*` symbols).
- `term.hl` — externs, free-fn wrappers, `RawMode`.
- `ansi.hl` — escape builders.
- `style.hl` — `Style` + `Styler` + downgrade math.
- `caps.hl` — profile detection.
- `console.hl` — the `Console` stylized printer.
- `examples/styles/` — capability report + swatches + downgrade
  ladder + raw-mode probe. Agent-runnable (degrades to plain
  text when piped; `FORCE_COLOR=1 COLORTERM=truecolor` shows
  the full output anywhere).
- `examples/report/` — Console demo: a stylized build report
  exercising title/rule/kv/step/success/warn/error/bullet.
  Agent-runnable.

## Verification

```bash
# library typechecks (codegen complains about no `fn main()`,
# which is expected for a lib seed)
hale build pond/term/

# demo — build then run
hale build pond/term/examples/styles/
./pond/term/examples/styles/styles
FORCE_COLOR=1 COLORTERM=truecolor ./pond/term/examples/styles/styles
```

Expected: a capability report (`profile: plain` when piped), the
attribute/palette/truecolor swatch sections, a 4-step downgrade
ladder for `rgb(255,135,0)` (`38;2;255;135;0` → `38;5;208` →
`38;5;11` → plain), and a raw-mode probe line (`-2` when stdin
is piped, `-1` timeout on a quiet tty).

## Relationship to pond/tui

`tui/` does NOT import this lib — the G34 two-hop codegen break
keeps tier libs from importing each other, so `tui/` carries its
own copies of the escape helpers and glue shims (under `tui_*` C
symbols so a program vendoring both links cleanly). Apps that
just want color/styled *output* (logging, CLI reports) take
`term/`; full-screen interactive apps take `tui/`.
