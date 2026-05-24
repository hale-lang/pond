# pond/crypto — friction log

Format: each entry names a sharp edge encountered while building
the lib, the smallest reproducible shape, and (where applicable)
the workaround taken. AGENTS.md "Don't edit crates/" is in force,
so every gap is logged here rather than papered over upstream.

---

## stdlib gaps

### ~~no-std-crypto-sha256~~

**Resolved 2026-05-17** by upstream `83f87ff` (C3). See `crypto.hl`
for the substituted shape.

`std::crypto::sha1` ships (lotus_arena.c:4353), `std::crypto::sha256`
does not. SHA-256 is by far the more common primitive in modern
applications (HMAC-SHA256 cookies, JWT signing, JWS, content
hashing). Implementing it in pure Hale took ~140 lines and a
careful read of FIPS 180-4, but the resulting Bytes-builder pattern
(`from_int` + `concat` 32 times per output) is O(N²) for the
output construction phase — not a problem at 32 bytes, but it
would be for, say, scrypt or PBKDF2 derivations that iterate
the hash thousands of times.

**Workaround:** pure-Hale implementation in `sha256.hl`. Verified
against FIPS 180-2 vectors B.1 (`"abc"`), the empty string, and
B.2 (the 56-byte input that exercises padding into a second
512-bit block). HMAC-SHA256 layered on top per RFC 2104; verified
against RFC 4231 test case 1.

**Ask:** `std::crypto::sha256(b: Bytes) -> Bytes` as a C-backed
primitive matching the existing `std::crypto::sha1` shape. While
you're in there, `std::crypto::sha512`, `std::crypto::hmac_sha256`,
and `std::crypto::hmac_sha512` would close the bulk of the
mainstream signing surface.

### ~~no-csprng-getrandom~~

**Resolved 2026-05-17** by upstream `ef85ed5` (C4). See
`random.hl` for the substituted shape.

The contract calls for `random_bytes` to be a CSPRNG via
`getrandom(2)`. The stdlib's only random surface is
`std::rand::seed_from_time` + `std::rand::next_int(max)` —
documented in `lotus_arena.c:4580` as xorshift64* seeded from
monotonic time, **explicitly NOT cryptographic**.

Two paths were considered:

1. **`/dev/urandom` via `std::io::fs::read_bytes`.** Rejected:
   `read_bytes` `fstat`s the file to size the blob, and
   `/dev/urandom` reports `st_size == 0` — so the read returns an
   empty Bytes regardless of requested length. There is no
   `read_bytes(path, max)` overload that would cap the read length.

2. **`std::rand::next_int(256)` repeated N times.** Taken — at
   least the surface compiles and the sign-demo runs. **NOT
   crypto-strength.** Predictable given the seed.

**Ask (high priority):** `std::os::getrandom(n: Int) -> Bytes
fallible(IoError)` backed by the `getrandom(2)` syscall (or
`/dev/urandom` fallback on platforms lacking the syscall). Without
this, every pond/crypto consumer that needs real entropy — session
tokens, nonces, key generation, CSRF tokens — has to vendor their
own libc binding, which AGENTS.md forbids per-project.

**Failing that:** an overload `std::io::fs::read_bytes(path,
max_bytes: Int) -> Bytes fallible(IoError)` that caps the read
length, so `/dev/urandom` becomes usable as the entropy source.

### ~~bytes-builder-needed~~

**Resolved 2026-05-17** in pond/crypto — sha256.hl (the only consumer
of the workaround in this lib) deleted by D9. Upstream
`std::bytes::builder_*` shipped as `894f393` (C10); other pond libs
can use it directly.

Constructing a Bytes value from individual byte values requires
`from_int` (1 byte) + `concat` for every byte. This is O(N²) in
the total output length because each `concat` reallocs+copies
both sides. The 32-byte SHA-256 output is fine; a kilobyte
output (e.g. a PBKDF2-derived key) would be unpleasant.

**Workaround:** for SHA-256, the output is only 32 bytes — the
O(N²) cost is bounded at ~1024 byte-copies, well below the cost
of the main compression loop. No mitigation needed in-seed.

**Ask:** `std::bytes::builder_new() -> BytesBuilder` /
`builder_append_int(bb, b: Int)` / `builder_append_bytes(bb, b)` /
`builder_finish(bb) -> Bytes`. Same shape as the existing
`std::str::builder_*` family but with binary-safe append (no
strlen). The str-builder family is documented at
`lotus_arena.c:5060` — the bytes-builder analogue would fit
cleanly alongside.

### ~~no-bitwise-not-on-int~~

**Resolved 2026-05-17 in pond/crypto** — the `~` workaround only
fired in sha256.hl (Ch function), now deleted by D9. The upstream
codegen rejection of `~` on Int is **not** fixed; other libs that
want bitwise-not still need the `x ^ -1` rewrite.

The grammar admits unary `~`, but codegen rejects it:
`unsupported in codegen v0: unop BitNot on Int`. SHA-256's `Ch`
round function (`Ch(x,y,z) = (x AND y) XOR ((NOT x) AND z)`) is
the natural use site.

**Workaround:** `~x` rewritten as `x ^ 0xFFFFFFFF` (XOR with the
32-bit all-ones mask). Works because we're masking the result to
32 bits anyway.

**Ask:** lower `BinOp::BitNot` in `codegen.rs::lower_binary_unary`
(or wherever the unary path lives) — it's a one-LLVM-instruction
emission, and the grammar already accepts it. Or, if `~` is being
held in reserve for something semantic, document the rejection
with a focused diagnostic (`use \`x ^ -1\` for bitwise complement`).

---

## codegen / import-system friction

### ~~cross-seed-free-fn-call-in-expr-pos~~

**Resolved 2026-05-17** by upstream `f9068fa` (A3). See `crypto.hl`
for the substituted shape — the public surface is now bare free
fns (`crypto::sha256(b)`, `crypto::hmac_sha256(k, m)`,
`crypto::random_bytes(n)`, `crypto::constant_time_eq(a, b)`,
`crypto::hex_encode(b)`), matching CONTRACTS.md. The `Crypto`
namespace lotus is gone; consumers no longer instantiate it.

**Symptom:** `alias::free_fn(args)` from an importer fails with
`codegen error: unsupported in codegen v0: path call alias::name in
expression position` — even though the same alias's locus
literals (`alias::Locus { ... }`) and the same alias's fallible
free fns (`alias::fn(args) or raise`) work fine.

**Reproducer:**

```hale
// lib/foo.hl
fn hello(x: Int) -> Int { return x + 1; }

// consumer.hl
import "./lib" as foo;
fn main() {
    let r = foo::hello(41);   // FAILS to codegen
    println("r=", r);
}
```

The same `r = foo::hello(41) or 0;` works (the `or`-clause path
in `codegen.rs:10881` consults `mangled_for_path`); only the
plain-call path (`lower_path_call_expr`, codegen.rs:18879) skips
the import rename table and falls through to the catch-all
`path call ... in expression position` diagnostic.

**Workaround:** wrap the public free-fn surface in a namespace
lotus (`Crypto` in `crypto.hl`) and document the call shape as
`let c = crypto::Crypto { }; c.sha256(b);`. Locus literals and
locus methods through an import alias DO codegen — the toy-import
fixture (`tests/fixtures/import-toy-consumer/`) is the witness.
This is the contract deviation noted below.

**Ask:** `lower_path_call_expr` (and its statement-position
sibling `lower_path_call`) should consult `mangled_for_path`
followed by `user_fns` lookup before falling through to the
"unsupported" catch-all, mirroring the path already proven out in
the `or`-clause flow at codegen.rs:10881. One-screen patch; the
flow is already in the file.

---

## contract deviation

### ~~public-surface-via-namespace-lotus~~

**Resolved 2026-05-17** by upstream `f9068fa` (A3). The `Crypto`
namespace lotus that wrapped the documented free-fn surface has
been deleted; consumers now call `crypto::sha256(b)` etc.
directly, matching CONTRACTS.md. `hex_decode` remains the typed
fallible free fn (always worked through `or`). The
`hex_decode_lossy` method had no callers and was deleted with
the lotus.

`CONTRACTS.md` spells the public surface as free fns:

```hale
fn sha256(input: Bytes) -> Bytes;
fn hmac_sha256(key: Bytes, message: Bytes) -> Bytes;
fn random_bytes(n: Int) -> Bytes;
fn constant_time_eq(a: Bytes, b: Bytes) -> Bool;
fn hex_encode(b: Bytes) -> String;
fn hex_decode(s: String) -> Bytes fallible(HexError);
```

Per `cross-seed-free-fn-call-in-expr-pos` above, non-fallible free
fns can't be called through an import alias today. The actual
public surface is the `Crypto` namespace lotus declared in
`crypto.hl`:

```hale
let c = crypto::Crypto { };
let d = c.sha256(b);
let m = c.hmac_sha256(key, msg);
let r = c.random_bytes(16);
let eq = c.constant_time_eq(a, b);
let h = c.hex_encode(d);
let bs = c.hex_decode_lossy(s);              // empty Bytes on err
let bs = crypto::hex_decode(s) or raise;     // typed err via free fn
```

Once the import-system fix lands, the `Crypto` lotus becomes a
thin convenience facade and the documented free-fn surface can be
called directly. The underlying free fns (`__sha256`,
`__hmac_sha256`, …) are still in their per-concern files for
in-seed reuse and will be promotable to bare names at that point.

`hex_decode` is the one contract method that stayed a free fn —
because fallible free fns DO codegen through imports (the
`or`-clause path), and the typed `HexError` is more valuable than
the lossy substitute. The lotus method `hex_decode_lossy` is the
side-by-side convenience for callers that don't care about the
error kind.

---

## suspected-duplicate helpers

### nibble-char / nibble-value

`hex.hl` declares two helpers — `nibble_char(n) -> String` (0..15
to one hex char) and `nibble_value(c) -> Int` (byte value of an
ASCII hex digit to 0..15, -1 otherwise). The stdlib's
`__json_hex_byte` / `__json_hex_nibble` in
`runtime/stdlib/json.hl` are the same shape; if a future
pond/json or pond/jwt lib lands, those helpers should probably
graduate into a `std::text::hex` namespace or similar. Logged
here per `pond/README.md` design rule "If a helper looks reusable
across pond libs, write it locally and add a duplicate-suspected
line."

### char_at_byte

`hex.hl`'s `char_at_byte(s, i)` is `std::bytes::at(std::bytes::
from_string(s), i)` — a common shape. Anywhere a String needs
byte-level inspection (parsers, validators, codecs) the same
pattern recurs. If `std::str::byte_at(s, i) -> Int
fallible(IndexError)` landed as a one-call surface (one less
heap-copy from `from_string`), every consumer benefits. Suspected
duplicate of the pattern at `json.hl:255-260` and adjacent.
