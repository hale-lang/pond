# pond/subprocess — friction log

**STATUS — UNBLOCKED + WIRED (2026-05-18).**
`std::process::run` + `std::process::Child` shipped upstream
2026-05-17; the implementation pass landed 2026-05-18. The
`spawn` / `run_cmd` free fns now route through
`std::process::run` (empty-stdin path) or
`std::process::spawn` + `write_stdin` + `wait` (stdin-bearing
path); the `Process` locus holds a `std::process::Child` as a
nested param so its `dissolve()` drives the TERM→100ms→KILL reap
escalation. `examples/run-demo/main.hl` builds + runs (echo
hello-from-hale, exit 0, 18 stdout bytes).

The CONTRACTS.md surface stays as documented; consumer code
that addresses `or raise` / `or handler(err)` picks up real
behavior with no source changes.

Remaining gaps (none block v1 ship):

- `SpawnOpts.cwd`        — no upstream chdir hook; ignored.
- `SpawnOpts.env`        — no upstream env hook; ignored.
- `SpawnOpts.timeout_ms` — no upstream wall-clock cutoff; ignored.
- `write_stdin` close    — no explicit stdin-close primitive
  upstream; well-behaved tools that exit-on-EOF (cat, sort,
  python -) may hang on the stdin-bearing path until the
  child reads enough to fill its pipe buffer.
- `Process` streaming    — `StdoutLine` / `StderrLine` per-line
  publishes still need a polling-loop primitive; the bus block
  declares them but `run()` is a placeholder. `ProcessExit`
  publishes correctly on `wait()`. `send_stdin` / `signal` /
  `wait` work.

---

## Contract deviations from `pond/CONTRACTS.md`

### 3.1 `Process.{send_stdin, signal, wait}` drop `fallible(SpawnError)` — [CLOSABLE]

**2026-05-27 update.** v0.8.1 narrowed the two-channel rule (#24
v0.2, commits `d565d6f` + `98910b9`) so user-declared `fn` member
fns can now carry `fallible(E)`. The next source pass restores the
contract surface verbatim: `send_stdin` / `signal` / `wait` regain
`fallible(SpawnError)` and the `last_error` field + `handle_io`
error-check fn collapse.

**Current source shape (still in place).** `process.hl` drops the
`fallible(SpawnError)` marker on the three methods and surfaces
failures via:

1. `self.last_error: SpawnError` — populated by every method
   call; `last_error.kind == ""` means success.
2. A `closure fatal_io { captures: last_error, pid; epoch
   inline; }` + the error-check fn `handle_io(e: SpawnError) ->
   Int` (per `spec/styleguide.md § 7`) that `violate`s for
   unrecoverable failures.

The same deviation was carried by every other pond lib with
fallible-locus-method contract entries; that list is now the
CONTRACTS.md 2026-05-27 status note's "newly-closable" inventory.

### 3.2 `Process` locus has no `birth() { spawn }`

CONTRACTS.md is silent on what `birth()` does. The v1 shape:
`birth()` does the spawn and writes `pid` / `in_fd` / `out_fd` /
`err_fd` to `self`. This mirrors `std::io::tcp::Listener.birth`
which acquires a listen socket and stashes `listen_fd`.

### 3.3 `fn run` renamed to `fn run_cmd`

`CONTRACTS.md` declares the convenience wrapper as `fn run(cmd:
String, args: String)`. The Hale grammar reserves `run` as a
lifecycle keyword (`grammar.ebnf § lifecycle_keyword`), so a
free-fn decl named `run` fails to parse with `expected function
name, got Run`. The lib exports `run_cmd` instead. One-token
consumer impact; flagged at the call site by the deviation
banner in `README.md`.

### 3.4 `SpawnOpts.stdin: Bytes` has no default

CONTRACTS.md's `SpawnOpts` declaration does not specify defaults.
In `types.hl` only the non-`Bytes` fields get defaults; `stdin`
requires an explicit `std::bytes::from_string("")` from the caller
(or whatever bytes they actually want to pipe). Type-defaults for
`Bytes` appear unsupported in the v1 surface — no examples in
stdlib declare `Bytes = ...` defaults — so the burden falls on
the caller. The `run(cmd, args)` convenience wrapper hides this
for the common case.

---

## Open questions

1. **`signal` portability.** POSIX signal numbers aren't
   uniform across platforms; Hale currently has no
   `std::process::SIGTERM` constant surface. The lib's
   `Process.signal(sig: Int)` takes a raw int; the stdlib
   primitive will probably want a tiny constants table
   (`SIGINT = 2`, `SIGTERM = 15`, `SIGKILL = 9`, `SIGHUP = 1`)
   exposed under `std::process::`.

2. **Streaming line-framing.** The `StdoutLine` / `StderrLine`
   topics carry `payload: String` — line-framed. That assumes
   the child's output is line-oriented and UTF-8-ish. Binary
   children need `StdoutChunk { payload: Bytes; }` instead.
   Worth a CONTRACTS.md revision once a real consumer drives
   the choice.

3. **`env` shape.** `"K=V\tK=V"` is tab-separated to dodge the
   v1 lack of `Map<K, V>`. The Phase A stdlib primitive will
   tokenize internally; the surface is awkward but consistent
   with `RouteParams.path_kv` / `Labels.kv` in CONTRACTS.md
   (both also tab-separated). A future `@form(hashmap)`-based
   `EnvMap` could supersede.

4. **`SpawnOpts.cwd = ""` interpretation.** Currently "empty
   means inherit." A more explicit shape would be a Bool flag
   + a String; the empty-sentinel convention is consistent
   with other CONTRACTS.md surfaces (`Url.path = ""`, etc.) so
   keep for now.
