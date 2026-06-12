# pond/subprocess — fork/exec with pipes + timeout

Suggested import alias: **`sub`**

```hale
import "vendor/pond/subprocess" as sub;
```

## Status (2026-06-12): UNBLOCKED + WIRED

`std::process::run` / `std::process::spawn` shipped upstream
2026-05-17 and the lib routes through them. `run_cmd` / `spawn`
do real fork/exec with output capture; the `Process` locus
spawns at `birth()`, and `send_stdin` / `signal` / `wait` work
(`wait()` publishes `ProcessExit`). Three `SpawnOpts` fields are
documented no-ops pending upstream hooks (`cwd`, `env`,
`timeout_ms`), there is no stdin-close primitive yet (don't
pipe stdin to a read-until-EOF child you intend to `wait()` on),
and the `StdoutLine` / `StderrLine` per-line streaming publishes
await a polling primitive. Details in `FRICTION.log`.

## Surface

Two free-fn entry points for the one-shot case, plus a `Process`
locus + three topics for the long-lived streaming case.

```hale
// One-shot — run to completion, capture full output.
// (Contract deviation: CONTRACTS.md names this `run`, but
// `run` is a reserved lifecycle keyword. See FRICTION.log § 3.3.)
let out = sub::run_cmd("/bin/ls", "-la /tmp") or raise;
println(len(out.stdout), " bytes on stdout");

// Same with full opts.
let opts = sub::SpawnOpts {
    cmd:        "/usr/bin/grep",
    args:       "-i needle",
    cwd:        "/srv/data",
    env:        "PATH=/usr/bin\tLANG=C.UTF-8",
    stdin:      haystack_bytes,
    timeout_ms: 5000,
};
let out = sub::spawn(opts) or self.report_err(err);

// Long-lived — Process locus (spawns at birth; wait publishes
// ProcessExit). Subscribers: `subscribe sub::ProcessExit as on_exit;`
let p = sub::Process { cmd: "/bin/echo", args: "hello" };
let st = p.wait()
    or sub::ExitStatus { code: -1, signaled: false, signal: 0 };
println("exit code = ", st.code);
```

## Types

| Name | Shape |
|---|---|
| `SpawnOpts`   | `cmd, args, cwd, env, stdin, timeout_ms` |
| `ExitStatus`  | `code, signaled, signal` |
| `Output`      | `status, stdout, stderr` |
| `SpawnError`  | `kind, detail, errno` (synthesized fallible payload) |
| `Process`     | locus — long-lived streaming child |
| `StdoutLine`  | topic, `payload: String` |
| `StderrLine`  | topic, `payload: String` |
| `ProcessExit` | topic, `payload: ExitStatus` |

## Error shape

`SpawnError.kind` is one of:

- `"spawn_failed"` — fork/exec didn't take (maps upstream
  IoError kinds "not_found" / "permission_denied" / "invalid").
- `"io"` — pipe read/write failure on stdin/stdout/stderr.
- `"timeout"` — reserved (`timeout_ms` is a no-op today).
- `"killed"` — reserved (signaled exits currently surface via
  `ExitStatus.signaled`).

`errno` carries the raw platform errno; `detail` is human-readable.

## Contract deviations

- `run` ships as `run_cmd` — `run` is still a reserved lifecycle
  keyword at free-fn position (re-tested 2026-06-12; see
  FRICTION.log § 3.3). Everything else matches CONTRACTS.md:
  `send_stdin` / `signal` / `wait` carry `fallible(SpawnError)`
  directly, and `SpawnOpts.stdin` has an empty-Bytes default.

## Building

```
$ hale check pond/subprocess/          # bare lib (no fn main)
$ hale build pond/subprocess/examples/run-demo/
$ ./pond/subprocess/examples/run-demo/run-demo
```

Expected demo output: exit code 0 / 16 stdout bytes from
/bin/echo (twice — `run_cmd` and the full-`SpawnOpts` path),
then `streaming wait code = 0` from the Process locus path.
