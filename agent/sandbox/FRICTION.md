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

---

## Contract deviations from `pond/CONTRACTS.md`

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

### 2.4 Codegen rejects qualified cross-seed types in locus-method signatures (cleared)

Previously documented: a locus-method body that declared an
error-check fn like `fn bridge_spawn_err(e: sub::SpawnError) ->
sub::Output { ... }` would trip
`codegen error: unsupported in codegen v0: qualified type
\`sub::SpawnError\` not in stdlib path-renames table` when the
lib was cross-seed-imported. As of v0.8.1's user-declared-locus-
method fallible support (#24 v0.2), the migrated source shape uses
`fn raise_spawn(e: sub::SpawnError) -> sub::Output fallible(SandboxError)`
inside `Sandbox` and `hale build` accepts it cross-seed. The
sibling claim that `pond/jobs/query.hl` hits the analogous
issue is preserved in `pond/jobs/FRICTION.md`; this lib doesn't
hit it on the migrated path.

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
