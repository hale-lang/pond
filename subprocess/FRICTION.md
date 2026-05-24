# pond/subprocess — friction log

**STATUS UPDATE 2026-05-18 — UNBLOCKED + WIRED.**
`std::process::run` + `std::process::Child` shipped upstream
2026-05-17; the implementation pass landed 2026-05-18. The
`spawn` / `run_cmd` free fns now route through
`std::process::run` (empty-stdin path) or
`std::process::spawn` + `write_stdin` + `wait` (stdin-bearing
path); the `Process` locus holds a `std::process::Child` as a
nested param so its dissolve() drives the TERM→100ms→KILL reap
escalation. `examples/run-demo/main.hl` builds + runs (echo
hello-from-hale, exit 0, 18 stdout bytes).

The CONTRACTS.md surface stays as documented; consumer code
that addresses `or raise` / `or handler(err)` picks up real
behavior with no source changes.

Remaining gaps (documented below; none block v1 ship):
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

The primary deliverable of this lib at v1 is this document.
`pond/subprocess` is **architecturally blocked**: there is no
way to launch a child process from Hale source code without
adding a stdlib primitive, and `AGENTS.md` explicitly forbids
editing `crates/` from a lib-build session. The lib ships with
the CONTRACTS.md surface fully realized at the type / signature
level so consumers can compile against it today, but every
fallible surface returns `kind = "unsupported"` until the gap
closes.

---

## ~~1. The blocker: no stdlib spawn primitive~~

**closed 2026-05-17** by upstream `std::process::run` (sync
path-call) + `std::process::Child` (async locus with
spawn/wait/kill/write_stdin/read_stdout/read_stderr). The
investigation + Phase A / Phase B / Phase C plan documented
below mirrors what shipped; the lib bodies just need to wire
through. Original section retained below for context.

## 1. The blocker: no stdlib spawn primitive (pre-2026-05-17 context)

### What I verified

Per the MANDATORY PREAMBLE STEP 1 verification, I grepped
`hale/crates/hale-codegen/runtime/stdlib/*.hl`
and `hale/spec/stdlib.md` for any
subprocess surface. The `std::process` namespace currently
ships exactly two symbols (per `spec/stdlib.md` "Shipped module
surface" table):

| Symbol | Surface |
|---|---|
| `std::process::pid() -> Int`       | `getpid()` wrapper (m71 proof-of-life) |
| `std::process::exit(code: Int)`    | `exit()` wrapper (m79) |

There is no `spawn`, `fork`, `exec`, `popen`, `system`, or
`Command` analog anywhere in the shipped stdlib. The `spawn*`
references in `runtime/stdlib/lang.hl` are tree-sitter AST
helpers for analyzing other languages — not subprocess
primitives. No `lotus_proc_*` / `lotus_spawn_*` / `lotus_exec_*`
C runtime symbols exist either; the only `lotus_*` substrate
families are `lotus_fs_*`, `lotus_tcp_*`, `lotus_bytes_*`,
`lotus_str_*`, `lotus_stdin_*`, `lotus_arena_*`,
`lotus_recpool_*`, `lotus_subject_match`, and a handful of
`lotus_io_*` helpers.

### Why I can't add it from here

`AGENTS.md § Operational rules`:

> Don't edit `crates/`. That's compiler territory. If a
> primitive you need is missing, work within the existing
> surface; don't reach into the compiler.

A subprocess spawn primitive *requires* C-runtime additions
(at minimum `fork`/`execvp`/`pipe`/`waitpid` wrappers) plus
codegen path-call dispatches plus the path entry in
`STDLIB_PATH_RENAMES`. That's three layers inside `crates/`,
none of which is reachable from a lib-build session.

The contract is therefore stubbed at the source surface and
this document specs the upstream change Hale needs.

---

## 2. Proposed stdlib primitive

Below is the shape `pond/subprocess` would build on. It mirrors
existing stdlib conventions: a path-call free-fn surface for
one-shot work, plus a `Stream`-style locus for long-lived work,
plus a synthesized `IoError`-shaped error payload. Two phases —
the first unblocks `pond/subprocess::spawn` and `pond/subprocess::run`;
the second unblocks the `Process` locus.

### Phase A — one-shot path-call surface

```hale
// std::process — additions to the m71 / m79 surface.
//
// Synthesized error type (per the form / IoError convention):
//
// type ProcError {
//     kind:  String;   // "spawn_failed" | "io" | "timeout" |
//                      // "killed" | "not_found" | "permission_denied"
//     errno: Int;
//     cmd:   String;
// }
//
// One-shot run-to-completion:
fn std::process::run(
    cmd:        String,
    args:       String,         // whitespace-separated argv tail
    cwd:        String,         // empty = inherit
    env:        String,         // "K=V\tK=V" tab-separated; empty = inherit
    stdin:      Bytes,          // bytes piped to child, then close
    timeout_ms: Int,            // <= 0 = no timeout
) -> ProcOutput fallible(ProcError);

// where:
type ProcOutput {
    exit_code:    Int;
    signaled:     Bool;
    signal:       Int;
    stdout:       Bytes;
    stderr:       Bytes;
}
```

Phase A behavior:

1. `fork()` the parent.
2. In the child: build `argv[]` by tokenizing `cmd` + whitespace-
   splitting `args`; build `envp[]` from `env` (`\t`-split, then
   `=`-split); `chdir(cwd)` if non-empty; `dup2` pipe ends onto
   fd 0/1/2; `execvp(argv[0], argv)`.
3. In the parent: write `stdin` to the child's stdin pipe and
   close it; drain stdout/stderr pipes into payload-arena Bytes
   buffers until EOF; `waitpid()` with timeout enforcement via
   `SIGCHLD` + timed `clock_nanosleep` loop (or `pidfd_open` +
   `ppoll` on Linux ≥ 5.3).
4. Assemble `ProcOutput`; on error, return `fallible(ProcError)`
   with errno-derived kind tag (`"spawn_failed"`, `"not_found"`,
   `"permission_denied"`, `"timeout"`, `"killed"`).

C-runtime additions:

| Symbol | Backing |
|---|---|
| `lotus_proc_run` | `fork`/`execvp`/`pipe2`/`waitpid` orchestration |
| `lotus_proc_split_args` | whitespace tokenizer (or share with `std::str`) |
| `lotus_proc_split_env`  | `\t`/`=` tokenizer for envp |

Codegen additions:

- `lower_std_process_run` in `lower_stdlib_path_call_expr`.
- `STDLIB_PATH_RENAMES` entry for the synthesized `ProcError`
  type.
- Path-rewrite for `std::process::run` (already a path-call so
  this is one match arm).

### Phase B — long-lived streaming locus

```hale
// std::process — Phase B (locus surface for long-lived work).
//
// locus Child {
//     params {
//         cmd:    String;
//         args:   String = "";
//         cwd:    String = "";
//         env:    String = "";
//         pid:    Int    = -1;
//         in_fd:  Int    = -1;
//         out_fd: Int    = -1;
//         err_fd: Int    = -1;
//     }
//     birth() { /* fork + exec; stash pid + pipe fds */ }
//     dissolve() { /* close fds; SIGTERM if still alive; reap */ }
//
//     fn write_stdin(b: Bytes) -> Int;      // -1 sentinel on err
//     fn read_stdout(max: Int) -> Bytes;    // empty on EOF
//     fn read_stderr(max: Int) -> Bytes;
//     fn close_stdin() -> Int;
//     fn signal(sig: Int) -> Int;
//     fn wait() -> Int;                     // packed exit code/signal
// }
```

This mirrors `std::io::tcp::Stream` exactly — methods can't
declare `fallible(E)` per the two-channel rule, so failures
surface via sentinel returns and the calling locus wraps them
in `fallible(...)` at its own free-fn boundary. Phase B's
C-runtime addition is `lotus_proc_spawn_child` (returning a
4-tuple of fds + pid) plus the per-stream read/write/close
methods that already exist for pipes.

### Phase C (optional) — bus integration

Once Phase B is in, `pond/subprocess::Process` becomes a thin
wrapper that owns a `std::process::Child` and runs a poll loop
publishing `StdoutLine` / `StderrLine` / `ProcessExit`. No
further stdlib work needed — pure user-land composition.

### Why this shape

- **Mirrors `std::io::tcp` and `std::io::fs`.** The same
  `fallible(E)` + Bytes + payload-arena conventions; the same
  path-call-then-locus phasing. A reader who knows the I/O
  surface knows this surface.
- **Synthesizes `ProcError` like `IoError` / `ParseError`.**
  Same machinery, no new typechecker work.
- **Two-channel rule respected.** Free fn = fallible-bearing;
  locus methods = sentinels + structural failure via the
  parent's `on_failure`.
- **No new language features.** Phase A composes existing
  fallible / Bytes / payload-arena primitives; Phase B mirrors
  the m81/m82 Stream locus.

---

## 3. Contract deviations from `pond/CONTRACTS.md`

### 3.1 `Process.{send_stdin, signal, wait}` drop `fallible(SpawnError)`

`CONTRACTS.md § pond/subprocess/` declares the Process locus
methods as e.g. `fn wait() -> ExitStatus fallible(SpawnError)`.
Per `spec/semantics.md § Fallible call semantics`:

> `fallible(E)` may NOT be declared on user-declared locus
> methods. […] The typechecker rejects `fn ... fallible(E)`
> on a locus member with a diagnostic naming this rule.

The signatures in `process.hl` therefore drop the
`fallible(SpawnError)` marker and surface failures via:

1. `self.last_error: SpawnError` — populated by every method
   call; `last_error.kind == ""` means success.
2. A `closure fatal_io { captures: last_error, pid; epoch
   inline; }` + the error-check fn `handle_io(e: SpawnError) ->
   Int` (per `spec/styleguide.md § 7`) that `violate`s for
   unrecoverable failures.

This is **not a one-off**. The same deviation applies to:

- `pond/sqlite::Db.{exec,query_one,query_all,prepare,bind_*,step,finalize}`
- `pond/http/client::Client.{get,post,request}`
- `(another lib).{put,get}`
- `(future owner-pattern lib)`
- `(future consumer-pattern lib)`
- `pond/sessions::SessionStore.read`
- `pond/jobs::Queue.{enqueue,dequeue,ack,fail}`
- `pond/migrations::Runner.{current_version,pending,migrate_up,migrate_down}`
- `pond/logfmt::FileSink.{write,line,newline}`
- `pond/logfmt::OtlpSink.{write,line,newline}`
- `pond/tracing::Tracer.export_otlp`
- `downstream-consumer::ConsumerTypeA.{add,cancel,modify}`
- `downstream-consumer::ItchParser.parse_chunk`
- `downstream-consumer::ConsumerTypeB.run`
- `pond/agent/llm::*.{complete}`
- `pond/agent/tools::Registry.dispatch`
- `pond/agent/conversation::Conversation.apply_delta`
- `pond/agent/sandbox::Sandbox.{run_code,run_file}`
- `pond/agent/embeddings::Store.{add,search,remove}`
- `pond/ml/neural::Model.{forward,apply_delta}`
- `pond/ml/neural::Trainer.fit`

**duplicate-suspected**: every lib in `pond/CONTRACTS.md` that
declares `fn METHOD(...) -> T fallible(E)` on a locus body
hits the same wall. The wider fix is either (a) `CONTRACTS.md`
gets revised to drop the `fallible(...)` marker from locus
methods uniformly and document the `last_error` + `violate`
shape as the canonical replacement, or (b) Hale relaxes the
two-channel rule for a designated subset of "infrastructure"
locus methods. Worth raising at the pond/contract-review layer
rather than per-lib.

### 3.2 `Process` locus has no `birth() { spawn }`

CONTRACTS.md is silent on what `birth()` does. Given the
deviation above (sentinel field + violate channel), the v1 shape
is `birth()` does the spawn and writes `pid` / `in_fd` /
`out_fd` / `err_fd` to `self` (or, in the blocked state, sets
`last_error.kind = "unsupported"` and leaves the fds at -1).
This mirrors `std::io::tcp::Listener.birth` which acquires a
listen socket and stashes `listen_fd`.

### 3.3 `fn run` renamed to `fn run_cmd`

`CONTRACTS.md` declares the convenience wrapper as `fn run(cmd:
String, args: String)`. The Hale grammar reserves `run` as a
lifecycle keyword (`grammar.ebnf § lifecycle_keyword`), so a
free-fn decl named `run` fails to parse with `expected function
name, got Run`. The lib exports `run_cmd` instead. One-token
consumer impact; flagged at the call site by the deviation
banner in `README.md`.

### 3.4 `SpawnOpts.stdin: Bytes` has no default

CONTRACTS.md's `SpawnOpts` declaration:

```
type SpawnOpts { cmd: String; args: String; cwd: String;
                 env: String; stdin: Bytes; timeout_ms: Int; }
```

does not specify defaults. In `types.hl` only the non-`Bytes`
fields get defaults; `stdin` requires an explicit
`std::bytes::from_string("")` from the caller (or whatever
bytes they actually want to pipe). Type-defaults for `Bytes`
appear unsupported in the v1 surface — no examples in stdlib
declare `Bytes = ...` defaults — so the burden falls on the
caller. The `run(cmd, args)` convenience wrapper hides this
for the common case.

---

## 4. What's stubbed, what works

| Surface | Status |
|---|---|
| `type SpawnOpts`   | declared, complete |
| `type ExitStatus`  | declared, complete |
| `type Output`      | declared, complete |
| `type SpawnError`  | declared, complete |
| `topic StdoutLine` / `StderrLine` / `ProcessExit` | declared, complete |
| `fn spawn(opts)`   | stub: `fail SpawnError { kind: "unsupported", ... }` |
| `fn run(cmd, args)`| stub: delegates to `spawn` |
| `locus Process` shape (params, bus, closure) | declared, complete |
| `Process.birth/run/dissolve` | stubs |
| `Process.send_stdin/signal/wait` | stubs that populate `self.last_error.kind = "unsupported"` |
| `Process.handle_io` | declared, ready to wire once primitives land |
| `examples/run-demo/main.hl` | exercises the full shape; runs and prints "BLOCKED…" until unblocked |

When the stdlib primitive ships, the work needed in this lib
is purely body-substitution — every signature stays put, every
consumer compiles unchanged.

---

## ~~4. Compiler bug: cross-seed `publish TopicName;` doesn't mangle~~

**Resolved 2026-05-17** by upstream `f9068fa` (A1). process.hl now
publishes by topic ident (`publish StdoutLine; publish StderrLine;
publish ProcessExit;`). Original entry retained below for context.

Encountered while building the example. When `pond/subprocess`
is imported via `import "../.." as sub;`, the seed-rename pass
rewrites the `topic StdoutLine { }` declaration in `topics.hl`
to its mangled symbol (`__lib_sub_topics_StdoutLine`) — but the
`publish StdoutLine;` reference inside `process.hl`'s `bus { }`
block stays as the bare `StdoutLine` identifier. At consumer
build time the typechecker then reports:

```
type error: publish references unknown topic `StdoutLine`
(no `topic StdoutLine` declaration in scope)
```

**Where:** `crates/hale-codegen/src/mangle.rs` —
`walk_locus_member` for `LocusMember::Bus`, the `BusMember::
Publish { ty, .. }` arm. The arm currently walks `ty` but not
the `subject` field. The `BusMember::Subscribe` arm has the
same gap on its `subject` field — only the `handler` ident is
rewritten. The `BusSubject::Topic(ident)` variant carries the
topic ident that needs `rewrite_ident` applied so it matches
the mangled topic decl.

**Workaround in this lib:** publish on **literal subjects with
explicit `of type T`**:

```hale
bus {
    publish "subprocess.stdout" of type String;
    publish "subprocess.stderr" of type String;
    publish "subprocess.exit"   of type ExitStatus;
}
```

The topic decls in `topics.hl` carry matching `subject: "..."`
fields so that subscribers writing `subscribe sub::StdoutLine
as on_line;` still wire to the right wire subject (the
subscribe-side path also routes through the same mangler bug
and would need verification once a real subscriber is built —
filed as a follow-up).

**Cost of the workaround:** publish-side reads the literal
subject string, which is two lookups away from the typed topic
decl. The payload type still type-checks (the `of type T`
annotation carries the type). Subscribers using `subscribe
sub::StdoutLine as on_line` will work *if* the subscribe-side
mangler arm is correct (untested — no end-to-end subscriber
fixture for cross-seed topics exists in the upstream test
tree).

**duplicate-suspected:** every pond lib that publishes typed
topics across an `import` boundary will trip this. Worth a
compiler fix rather than per-lib workarounds.

## 5. Compiler limitation: `fn name -> () fallible(E)`

`CONTRACTS.md` declares `Process.send_stdin` and `Process.signal`
returning `() fallible(SpawnError)`. The codegen rejects unit-
typed returns:

```
codegen error: unsupported in codegen v0: tuple type must have
at least 2 elements; got 0
```

Workaround: omit the `-> ()` clause entirely (a fn without `->`
defaults to void). This matches stdlib convention — no stdlib
fn declares `-> ()` explicitly. Worth a `CONTRACTS.md` cleanup
to standardize on the omitted-arrow form for void-returning fns.

## 6. Open questions

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
