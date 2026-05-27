# pond/agent/sandbox — subprocess-based code execution sandbox

Suggested import alias: **`sandbox`**

```hale
import "vendor/pond/agent/sandbox" as sandbox;
```

## Status

Unblocked + wired. `Sandbox.run_code` and `Sandbox.run_file`
match the CONTRACTS.md surface verbatim — both declare
`fallible(SandboxError)` and dispatch through pond/subprocess
(which itself routes through `std::process::run`). For
`run_code`, the snippet lands in a `/tmp/hale_sb_*.script` path
via `std::io::fs::mktemp` (C9), is written via
`std::io::fs::write_file`, run via `run_file`, and unlinked on a
best-effort basis afterwards.

`memory_limit_mb` is plumbed for forward compat but currently a
documented no-op (no upstream rlimit hook). `timeout_ms` likewise
isn't enforced because `std::process::run` has no wall-clock
cutoff — see FRICTION.md for both.

## Surface

A single `Sandbox` Service locus (pattern 3) carries the runtime
binary + resource limits across a series of runs; two methods
execute code either inline or from a pre-existing file. Both
carry `fallible(SandboxError)` directly, so call sites use the
value channel — `or raise` to propagate, `or self.handler(err)`
to recover, `or discard` if unit.

```hale
// Construct once, reuse across runs.
let sb = sandbox::Sandbox {
    runtime:         "python3",
    timeout_ms:      5000,
    memory_limit_mb: 256,
};

// Run an inline snippet.
let r = sb.run_code("print('hello')") or self.report(err);
println("exit ", r.exit_code, ": ", r.stdout);

// Run a script from disk.
let r2 = sb.run_file("/srv/agent/scripts/probe.py") or raise;
```

## Types

| Name           | Shape                                                |
|----------------|------------------------------------------------------|
| `SandboxResult`| `exit_code: Int; stdout: String; stderr: String;`    |
| `SandboxError` | `kind: String; detail: String;` (synthesized payload)|
| `Sandbox`      | locus — Service holding runtime + limits             |

## Error shape

`SandboxError.kind` is one of:

- `"timeout"`      — wall-clock `timeout_ms` elapsed; the runtime
                     was killed before completing (RESERVED — not
                     yet enforced, see FRICTION.md).
- `"oom"`          — RESERVED for future use; surfaced once
                     `pond/subprocess` plumbs rlimit-style memory
                     enforcement.
- `"spawn_failed"` — the underlying subprocess invocation failed.
- `"io"`           — failed to write the temp file for `run_code`,
                     or failed to read back the captured output.

`detail` is human-readable; typically forwarded from the
underlying `sub::SpawnError.detail`.

## Contract deviations

- `memory_limit_mb` is plumbed on the surface but currently a
  no-op. `pond/subprocess` has no rlimit-style hook in its
  current contract; enforcement is deferred to the day the
  stdlib spawn primitive grows a `mem_limit_bytes` field.

## Building

```
$ hale check pond/agent/sandbox/
ok: 2 file(s) typechecked

$ hale build pond/agent/sandbox/examples/run-python/
built: agent/sandbox/examples/run-python/run-python

$ ./agent/sandbox/examples/run-python/run-python
run-python: exit 0
run-python: stdout: hello
```
