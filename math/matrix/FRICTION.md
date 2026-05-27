# pond/math/matrix — FRICTION

## Contract deviations

### CONTRACTS.md surface differs from shipped surface

CONTRACTS.md declares:

```hale
fn zeros(rows: Int, cols: Int) -> Matrix;
fn eye(n: Int) -> Matrix;
fn from_rows(rows: Int, cols: Int, data: String) -> Matrix;
fn matmul(a: Matrix, b: Matrix) -> Matrix fallible(MatrixError);
fn add(a: Matrix, b: Matrix) -> Matrix fallible(MatrixError);
fn scale(a: Matrix, k: Float) -> Matrix;
fn dot(a: Matrix, b: Matrix) -> Float fallible(MatrixError);
```

Shipped surface routes through a `Mat` namespace lotus:

```hale
locus Mat {
    params { }
    fn zeros(rows: Int, cols: Int) -> Matrix;
    fn eye(n: Int) -> Matrix;
    fn from_rows(rows: Int, cols: Int, data: String) -> Matrix;
    fn matmul(a: Matrix, b: Matrix) -> Matrix;        // sentinel
    fn add(a: Matrix, b: Matrix) -> Matrix;            // sentinel
    fn scale(a: Matrix, k: Float) -> Matrix;
    fn dot(a: Matrix, b: Matrix) -> Float;             // NaN sentinel
    fn error_matrix() -> Matrix;
    fn is_error(m: Matrix) -> Bool;
    fn nan_sentinel() -> Float;
    fn is_nan(f: Float) -> Bool;
}
```

The deviation has two roots, and both are walls the contract
ran into at v1:

#### Wall 1: free fns can't return LocusRef

`crates/hale-codegen/src/codegen.rs:10197`:

```
free-fn return of LocusRef(...): locus references shouldn't
cross arena boundaries — pass via bus instead
```

A `@form(vec)` locus is a locus, and Matrix returns from
`zeros` / `eye` / `from_rows` / etc. would all need to escape
the free fn's frame. Only locus methods get the m90 heap-alloc
treatment that lets the returned handle outlive the call. So
the factories had to move onto a locus.

#### Wall 2: locus methods can't carry `fallible(E)` — [CLOSABLE]

**2026-05-27 update.** v0.8.1 narrowed the two-channel rule (#24
v0.2, commits `d565d6f` + `98910b9`) so user-declared `fn` member
fns on a locus now carry `fallible(E)` with heap-bearing payloads.
The next source pass flips `Mat.matmul` / `Mat.add` /
`Mat.dot` (and `at_checked` / `set_at_checked`) to
`fallible(MatrixError)` directly; the sentinel-pair pattern
(`error_matrix()` / `is_error(...)` / `nan_sentinel()` /
`is_nan(...)`) retires. Clean breaking change — callers move from
`if mx.is_error(r) { ... }` to `or raise` / `or handler(err)`
addressing. **Wall 1 (free fns can't return LocusRef) stays open**,
so `Mat` remains a namespace lotus; only the sentinel-pair shape
goes away.

**Current source shape (still in place).** Once the binary ops
moved onto a locus (per Wall 1), they could no longer declare
`fallible(MatrixError)` under the old (pre-v0.8.1) two-channel
rule. The adopted shape is the sentinel-pair pattern:

- `matmul` / `add` return `Matrix`; on shape mismatch they
  return `error_matrix()` (a `rows=-1, cols=-1` `Matrix`).
  Callers branch on `mx.is_error(result)`.
- `dot` returns `Float`; on shape mismatch / empty it returns
  `nan_sentinel()`. Callers branch on `mx.is_nan(result)`.

The fully-typed `fallible(MatrixError)` shape lives in free
fns that validate but don't return Matrix — `check_matmul_shapes`,
`check_same_shape`, `check_dot_shapes`. The `Mat` methods consume
these and translate to sentinels at the boundary; the next source
pass collapses both surfaces into a single fallible method set.

### `at` / `set_at` are not `fallible(IndexError)` — [CLOSABLE]

**2026-05-27 update.** Same two-channel-rule narrowing as Wall 2
above. Next source pass: `Matrix.at` and `Matrix.set_at` regain
`fallible(IndexError)` directly; the `_checked` free-fn pair
retires. Also: `set_at` returning `() fallible(IndexError)` lowers
post-`6beb1be` (FUv0.8.2 #6), closing the no-`-> ()` gap that
forced the Float-return workaround.

**Current source shape (still in place).** These are locus methods
→ couldn't declare `fallible(E)` under the old (pre-v0.8.1) rule.
The shipped shape:

- `Matrix.at(r, c) -> Float` — substitutes `0.0` on OOB.
- `Matrix.set_at(r, c, v: Float)` — silent no-op on OOB.

The fallible surface lives in sibling free fns:

- `at_checked(m, r, c) -> Float fallible(IndexError)`.
- `set_at_checked(m, r, c, v) -> Float fallible(IndexError)`.

## Language / stdlib gaps

### Free fns can't return LocusRef (Wall 1 above)

See above. Calling out separately as a language-level gap that
forces all locus-producing functions to be locus methods.

### No `from-offset` `index_of` on strings

`std::str::index_of(haystack, needle)` returns the first match
from the start. Scanning forward through a comma-separated
string in `from_rows` required a manual character-by-character
loop. A `std::str::index_of_from(s, needle, start) -> Int`
would make `from_rows` an O(parse) one-liner instead of an
O(parse · n) double-scan.

### NaN literal awkward

There is no `Float::NAN` constant. Producing NaN required `0.0
/ 0.0` at runtime. Adding a stdlib `std::math::nan() -> Float`
(and `std::math::inf()` for symmetry) would tidy this.

### Float-from-Int literal mixing

The agent's natural shape of writing `let acc = 0;` (Int) then
`acc = acc + a * b` (Float) requires explicit `0.0` to widen.
The widening rule (Phase 2c) only fires at let-binding type
ascriptions and fn-arg sites; expression-position widening
isn't implicit. Workaround: start accumulators as `0.0`. Not
blocking, just a small friction.

## Duplicate-suspected helpers

- **`is_nan(f: Float) -> Bool`** — `f != f` is the canonical
  IEEE 754 NaN test. Every numeric Hale library is likely to
  re-implement it. Candidate for `std::math::is_nan(f)`.
- **`nan_sentinel() -> Float`** — `0.0 / 0.0` is the same NaN
  every Hale program will reach for. Candidate for
  `std::math::nan()`.
- **`error_matrix()` / `is_error(m)` sentinel-pair pattern** —
  the contract-deviation workaround. If any other pond lib hits
  the same Wall-1 + Wall-2 combo it will reach for the same
  shape. Candidate for a pond-internal namespace lotus once a
  second consumer appears.

## Non-friction observations

- `@form(vec)` over `Float` cells worked first try once the
  surface-shape questions above were settled. The synthesized
  `push` / `get` / `set` / `len` covered the whole row-major
  buffer story; the lib only had to add `at` / `set_at` /
  `transpose` on top.
- Locus method `transpose() -> Matrix` returning a fresh Matrix
  worked cleanly thanks to m90 — the heap-alloc / leak-on-exit
  trade-off is exactly what this kind of factory wants.
- `or discard` is a noticeably nicer addressing shape than the
  pre-2026-05-16 `or noop(err)` workaround for "I know this
  Unit-success can fail and I don't care."
