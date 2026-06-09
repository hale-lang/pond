# pond/tui — full-screen terminal apps

An Elm-shaped TUI runtime for Hale: you write a locus whose
params are the model, whose `update` handles typed input
events, and whose `view` paints cells; `tui::Program` owns the
terminal lifecycle (raw mode, alternate screen, mouse/paste
modes — acquired in birth, restored in dissolve, so scope exit
and the SIGTERM drain cascade both put the terminal back) and
drives the frame loop with a diff renderer that emits minimal
escape sequences in one write per frame.

```hale
import "vendor/pond/tui" as tui;

locus Counter {
    params { n: Int = 0; }
    fn init(s: tui::Screen) { }
    fn update(e: tui::Event, s: tui::Screen) -> Bool {
        if e.kind == "key" && e.key == "char" && e.ch == 113 {
            return true;                       // 'q' quits
        }
        if e.kind == "tick" { self.n = self.n + 1; }
        return false;
    }
    fn view(s: tui::Screen) {
        s.clear();
        s.print(2, 1, "ticks: " + to_string(self.n));
    }
}

fn main() {
    tui::Program { app: Counter { } };
}
```

`Counter` satisfies the `App` interface structurally (F.20 — no
`impl`). The locus model maps one-to-one onto the Elm
architecture: params are the Model, `update` is the update
function, `view` is the view, and widgets compose as owned
child loci (F.29 cascade handles their teardown).

## Suggested alias

```hale
import "vendor/pond/tui" as tui;
```

## Surface

```hale
// program.hl
interface App {
    fn init(s: Screen);
    fn update(e: Event, s: Screen) -> Bool;   // true = quit
    fn view(s: Screen);
}
locus Program {
    params {
        app: App;                 // required
        fps: Int = 30;            // input-poll timeout = frame budget
        mouse: Bool = false;      // SGR mouse reporting
        use_alt_screen: Bool = true;
        max_frames: Int = -1;     // >= 0 bounds the run (demos/tests)
    }
}

// event.hl — one flat record, every field defaulted
type Event {
    kind: String;                 // none|key|mouse|paste|tick|resize|eof
    key: String; ch: Int; text: String;
    ctrl/alt/shift: Bool;
    btn: String; x: Int; y: Int;  // mouse (1-based cells)
    w: Int; h: Int;               // resize
}
fn next_event(timeout_ms: Int) -> Event;   // Program calls this for you

// screen.hl — cell grid + diff renderer (0-based x, y)
locus Screen {
    params { w: Int; h: Int; ... }
    fn clear();
    fn set_cell(x, y, ch: Int, fg: Int, bg: Int, attrs: Int);
    fn put(x, y, s: String, fg, bg, attrs);   // UTF-8 + wide chars
    fn print(x, y, s: String);                // plain-style put
    fn fill(x, y, w, h, bg: Int);
    fn set_cursor(x, y); fn hide_cursor();
    fn flush();                               // Program calls this for you
}
fn rgb(r, g, b) -> Int;          // truecolor for fg/bg
fn char_width(cp: Int) -> Int;   // 0 / 1 / 2
fn str_width(s: String) -> Int;  // display columns

// widgets.hl
locus Spinner      { fn tick(); fn draw(s, x, y, fg); }
locus ProgressBar  { fn set(p); fn add(d); fn done() -> Bool;
                     fn draw(s, x, y, w, fg); }
locus List         { params { items: String; selected: Int; }  // newline-separated
                     fn handle(e); fn draw(s, x, y, w, h);
                     fn count() -> Int; fn selected_item() -> String; }
locus TextInput    { params { value: String; placeholder: String; focus: Bool; }
                     fn handle(e); fn draw(s, x, y, w); }
fn line_count(s) -> Int; fn line_at(s, i) -> String;
```

Colors use the pond/term one-Int encoding (`-1` default,
`0..255` palette, `tui::rgb(r,g,b)` truecolor). `attrs` is a
bitmask: 1 bold, 2 dim, 4 italic, 8 underline, 16 reverse,
32 strike.

## The frame loop

Per frame, Program delivers: at most one input event (key /
mouse / paste — input polling with the frame budget as timeout
IS the frame clock), a `resize` event if the terminal changed
(size is polled, no SIGWINCH), then exactly one `tick`. Any
`update` returning true quits; EOF on stdin quits. `view` +
`Screen.flush()` then run once.

`flush()` diffs the cell grid against the previous frame and
emits cursor moves only on discontinuity and SGR runs only on
style change, wrapped in DEC 2026 synchronized-update, written
in a single `write(2)`. Measured shape (counter example, 80x24):
full first frame ~2.1 KB, steady-state diff frames ~24 bytes.

Raw mode disables ISIG: **Ctrl-C arrives as a key event**
(`key == "char" && ch == 99 && ctrl`), not SIGINT — handle it
in `update` (or deliberately don't; capturing it is the point).
External SIGTERM still triggers the runtime drain cascade,
which reaches Program's dissolve and restores the terminal.

## Non-TTY degradation (agent-runnable demos)

When stdin/stdout isn't a terminal, Program skips raw mode and
the alternate screen but still renders frames to stdout, and
EOF quits. Combined with `max_frames`, every demo here runs to
completion in a pipe:

```bash
hale build tui/examples/dashboard/ && ./tui/examples/dashboard/dashboard
./tui/examples/keys/keys < /dev/null     # one frame, exits
```

## Examples

- `examples/counter/` — minimal App: tick counter, quits on
  q / Ctrl-C / EOF / 120 frames.
- `examples/dashboard/` — composed widgets: title bar, spinner,
  progress bar, scrollable list; self-quits when the bar hits
  100%.
- `examples/keys/` — interactive event echo (keys with
  modifiers, mouse, paste); the fastest way to see what your
  terminal sends. q / esc quits.

## Self-contained by design (G34)

This seed does NOT import `pond/term` — the G34 two-hop
codegen break keeps tier libs from importing each other — so it
carries its own copies of the escape helpers and the C glue
(`tui_*` symbols; `term_*` belongs to pond/term — @ffi symbols
aren't mangled, so the prefixes keep an app that vendors both
libs linking cleanly). Flagged in FRICTION.md; collapses when
G34 lifts.

## Verification

```bash
hale build pond/tui/            # typechecks (no fn main = expected)
hale build pond/tui/examples/counter/
hale build pond/tui/examples/dashboard/
hale build pond/tui/examples/keys/
./pond/tui/examples/dashboard/dashboard   # self-quits at 100%
```
