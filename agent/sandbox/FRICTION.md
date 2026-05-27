# pond/agent/sandbox — friction log

**STATUS UPDATE 2026-05-18 — UNBLOCKED + WIRED.**
`std::process::run` + `std::process::Child` shipped upstream
2026-05-17. `std::io::fs::mktemp` also shipped (C9). The
implementation pass on pond/subprocess landed 2026-05-18, and
this lib's body was wired in the same session. Path (a) was
chosen: `run_file` calls `sub::run_cmd(self.runtime, path)`;
`run_code` lands the snippet in `/tmp/hale_sb_*.script` via
`std::io::fs::mktemp`, writes through `std::io::fs::write_file`,
delegates to `run_file`, and best-effort `unlink`s afterwards.
`examples/run-python/main.hl` builds + runs against
`/usr/bin/python3`: "hello\n" capture, exit 0 on both the
method-channel and value-channel paths.

The CONTRACTS.md surface stays put; consumer code is unchanged.

Remaining gaps (none block v1 ship):
- `timeout_ms`      — no upstream wall-clock cutoff; ignored.
- `memory_limit_mb` — no upstream rlimit hook; ignored.

The primary deliverable of this lib at v1 is this document.
`pond/agent/sandbox` is **architecturally blocked** behind
`pond/subprocess`, which is in turn blocked on a missing stdlib
spawn primitive. The lib ships with the CONTRACTS.md surface
fully realized at the type / signature level so consumers can
compile against it today, but every fallible surface forwards
the underlying SpawnError until the gap closes.

---

## Contract deviations from `pond/CONTRACTS.md`

### 2.1 `Sandbox.run_code` / `Sandbox.run_file` drop `fallible(SandboxError)` — [CLOSABLE]

`CONTRACTS.md § pond/agent/sandbox/` declares:

```
locus Sandbox {
    params { runtime: String = "python3"; timeout_ms: Int = 30000;
             memory_limit_mb: Int = 512; }
    fn run_code(code: String) -> SandboxResult fallible(SandboxError);
    fn run_file(path: String) -> SandboxResult fallible(SandboxError);
}
```

**2026-05-27 update.** v0.8.1 narrowed the two-channel rule (#24
v0.2, commits `d565d6f` + `98910b9`); user-declared `fn` member
fns now carry `fallible(E)`. The next source pass restores
`Sandbox.run_code` / `run_file` to
`-> SandboxResult fallible(SandboxError)`; the `last_error` field,
the `fatal_sandbox` closure + `handle_err` error-check fn, and
the paired `run_code_at` / `run_file_at` free fns all collapse.
Clean breaking change.

**Current source shape (still in place).** Under the old
(pre-v0.8.1) rule, locus methods could not declare `fallible(E)`.
The methods drop the marker and surface failures via:

1. `self.last_error: SandboxError` — populated by every method
   call; `last_error.kind == ""` means success.
2. A `closure fatal_sandbox { captures: last_error; epoch
   inline; }` + the error-check fn `handle_err(e: SandboxError)
   -> Int` that `violate`s for unrecoverable failures.
3. The free-fn companions `run_code_at(sb, code)` /
   `run_file_at(sb, path)` in `helpers.hl` for value-channel
   addressing.

### 2.2 `memory_limit_mb` is plumbed but unenforced

CONTRACTS.md declares `memory_limit_mb: Int = 512` on the
Sandbox params. There's no rlimit-style hook in pond/subprocess's
SpawnOpts shape and no `RLIMIT_AS` analog in the proposed Phase A
stdlib primitive. The field is accepted, stored, and ignored at
v1 — documented as a no-op in README.md.

The right shape long-term: extend `sub::SpawnOpts` with
`mem_limit_bytes: Int = 0` (0 = no limit), have the Phase A
stdlib primitive `setrlimit(RLIMIT_AS, ...)` between fork and
exec, and have pond/agent/sandbox forward `memory_limit_mb *
1024 * 1024` into the spawn opts. Once the primitive lands the
Sandbox body change is a single line.

### 2.3 `Sandbox.last_error` needs an explicit `= SandboxError { }` default

`CONTRACTS.md`'s Sandbox params block doesn't include
`last_error` at all — it's added here only because the
two-channel-rule deviation needs somewhere to stash the failure
state. The natural shape `last_error: SandboxError;` (with the
type's own defaults filling in) is rejected at instantiation
with:

```
codegen error: locus `...Sandbox` instantiation: param
`last_error` is required (no default) — supply it as
`...Sandbox { last_error: ... }`
```

The current workaround: `last_error: SandboxError =
SandboxError { };`. Less surprising once you see it; surprises
agents the first time. **duplicate-suspected**: every locus
following the "sentinel last_error per two-channel rule"
pattern (subprocess::Process, jobs::Queue, sandbox::Sandbox, …
the full list at `../../subprocess/FRICTION.md § 3.1`) hits
this. Either type-shape params should default to their type's
all-defaults instance automatically, or the codegen diagnostic
should suggest the `= T { }` form rather than the bare
"supply it" wording.

### 2.4 Codegen rejects qualified cross-seed types in locus-method signatures

The natural shape for the error-bridge fn inside `Sandbox` is:

```hale
fn bridge_spawn_err(e: sub::SpawnError) -> sub::Output {
    self.last_error = SandboxError {
        kind:   map_kind(e.kind),
        detail: e.detail,
    };
    return sub::Output { /* zeros */ };
}
```

invoked at the call site as `let out = sub::spawn(opts) or
self.bridge_spawn_err(err);`. Codegen rejects the signature:

```
codegen error: unsupported in codegen v0: qualified type
`sub::SpawnError` not in stdlib path-renames table
```

The same shape works fine when written **as a locus method
inside the example** (see `../../subprocess/examples/run-demo/
main.hl`'s `fn report(e: sub::SpawnError) -> sub::Output`) but
fails when the locus is itself in a library file that's then
imported by another seed. The codegen v0 path-rename table is
populated for the *example*'s import set but not for nested-
importer cases.

**Workaround in this lib**: since `sub::spawn` always fails
with kind="unsupported" today anyway, `run_file` short-circuits
without making the call — it populates `self.last_error`
preemptively and returns the sentinel. Once the underlying
spawn primitive ships AND the codegen-v0 limitation is
resolved (or once we find a way to bridge through a free fn
in the bridging seed), the body flips to actually invoke
`sub::spawn` and the bridge fn comes back online.

**duplicate-suspected**: same wall `pond/jobs` hits when wrapping
`db::DbError` (`pond/jobs/query.hl` declares
`fn __bridge_db_exec(e: db::DbError) -> db::ExecResult fallible(JobError)`
and that build fails with the analogous diagnostic). Every
"wrap another pond lib's fallible surface" lib trips this.
Worth a path-rename-table generalization for nested imports.

## 3. Desired shape for sandbox-specific extensions (long-term)

These are explicitly *outside* the v1 surface but worth
recording for the day the lib graduates to "real sandbox" — at
which point the surface in `CONTRACTS.md` needs to grow.

### 3.1 chroot / mount namespace isolation

A "real" sandbox shouldn't just rely on the OS PATH lookup of a
python3 binary — it should jail the child into a constrained
filesystem view. Two pieces:

- **`chroot_path: String`** on Sandbox params (empty = no
  chroot). The Phase A stdlib primitive would need a
  pre-execve hook (between fork and exec) to call `chroot(2)` +
  `chdir("/")`. Linux requires CAP_SYS_CHROOT; bind-mounting
  the runtime binary in is the caller's responsibility.

- **`mount_ro: String`** — tab-separated host:guest pairs to
  bind-mount read-only inside the sandbox's mount namespace
  (Linux only; requires unshare(CLONE_NEWNS) before chroot).
  Same shape convention as `sub::SpawnOpts.env`.

### 3.2 user namespace + uid mapping

For unprivileged callers, the right primitive is `unshare(2)`
with `CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWNS`
and a uid_map of `0 <real_uid> 1` — the child sees itself as
root inside the sandbox but is the unprivileged caller outside.
Maps to:

- **`isolate_user: Bool`** on Sandbox params.
- **`isolate_network: Bool`** (NEWNET — child has no network).
- **`isolate_pid: Bool`** (NEWPID — child sees only itself + descendants).

Implementation needs `lotus_proc_unshare_run` in the C runtime
(distinct from `lotus_proc_run` so the simple path stays
lightweight) plus matching SpawnOpts plumbing.

### 3.3 cgroup-based resource limits

`memory_limit_mb` (already on the v1 surface) plus:

- **`cpu_quota_pct: Int`** — cgroup v2 `cpu.max`.
- **`pids_max: Int`**     — cgroup v2 `pids.max` (fork-bomb defense).
- **`io_weight: Int`**    — cgroup v2 `io.weight`.

These need a cgroup v2 mount surface in pond/subprocess (e.g.
write `/sys/fs/cgroup/hale-sandbox-{pid}/memory.max`) and a
matching `lotus_proc_cgroup_*` C-runtime family. Out of scope
for v1; recorded so the long-term shape is consistent.

### 3.4 seccomp filter profile

`seccomp_profile: String` — path to a BPF program or a named
profile ("strict", "audio", "compute"). Apply via
`prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ...)` between fork
and exec. The hard part is the profile vocabulary, not the
plumbing; the Docker default seccomp.json is a reasonable
starting point.

### 3.5 Streaming output (line-by-line)

CONTRACTS.md returns a single `SandboxResult` after the run
completes — fine for short snippets, less fine for long-running
data processing jobs. The natural extension is to thread
pond/subprocess's `StdoutLine` / `StderrLine` topics through
Sandbox so consumers can subscribe:

```hale
locus Sandbox {
    bus {
        publish "sandbox.stdout" of type String;
        publish "sandbox.stderr" of type String;
        publish "sandbox.exit"   of type SandboxResult;
    }
    // ... existing methods plus:
    fn run_code_streaming(code: String) -> ();   // fire-and-forget
}
```

This is a v2 surface — the locus would internally hold a
`sub::Process` child and forward its bus topics. Requires
pond/subprocess Phase B (the streaming Process locus) which is
itself blocked.

---

## 4. What's stubbed, what works

| Surface                                                                   | Status |
|---------------------------------------------------------------------------|--------|
| `type SandboxResult`                                                      | declared, complete |
| `type SandboxError`                                                       | declared, complete |
| `locus Sandbox` shape (params, closure, lifecycle)                        | declared, complete |
| `Sandbox.run_code / run_file`                                             | stubs; delegate to `sub::spawn` which always fails "unsupported" today |
| `Sandbox.report / handle_err`                                             | declared, wired |
| `run_code_at / run_file_at` (free-fn fallible wrappers)                   | declared, wired |
| `examples/run-python/main.hl`                                             | exercises the full shape; runs and prints the BLOCKED sentinel today |

When `pond/subprocess` unblocks, the work needed in this lib is
purely body-substitution inside `Sandbox.run_code` (the temp-file
write path) — every signature, every other body, every error
mapping stays put.

---

## 5. duplicate-suspected — error-kind translation table

`map_kind(inner: String) -> String` in `sandbox.hl` translates
sub::SpawnError kind tags into SandboxError kind tags. Every
pond lib that wraps another pond lib's fallible surface needs
the same shape of helper. Worth a doc anchor (or a tiny
`pond/errors/` helper) once two more wrappers hit this — at
that point a shared "error-translation table" primitive saves
duplicated boilerplate.

Other libs likely to hit this: `pond/agent/embeddings` (wraps
http for OpenAI/Cohere embed APIs), `pond/jobs` (wraps sqlite +
will wrap pond/subprocess for shell-job handlers),
`pond/migrations` (wraps sqlite).

---

## 6. duplicate-suspected — temp file pattern

`Sandbox.run_code` needs a temp-file primitive. So will any
future lib that needs to hand a runtime a file (image
preprocessors, model checkpointers, scratch directories for
unpacking tarballs, etc.). The ask is `std::io::fs::mktemp(prefix,
suffix) -> String fallible(IoError)`, race-free, returning a
path the caller is responsible for cleaning up. Filed against
this lib because we hit it first; equally a problem for
`pond/agent/embeddings`, future `pond/data/*` formats, and any
lib that needs scratch space.
