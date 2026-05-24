# pond/agent/embeddings — FRICTION

## Contract deviations

### `Store` storage shape — `heap items of Embedding` not implementable

CONTRACTS.md declares:

```hale
@form(vec)
locus Store {
    params { dim: Int; }
    capacity { heap items of Embedding; }
    ...
}
```

Two walls block this verbatim:

1. **`@form(vec)` cells can't be locus refs** (`spec/forms.md` §
   "Required capacity shape"):

   > The cell type MAY NOT be a locus reference — vecs hold
   > values, not loci.

   `Embedding.vector` is `mat::Matrix`, a locus. Even if cells
   could hold locus refs, the cross-seed restriction below would
   block it.

2. **A `type` field cannot hold a cross-seed locus ref** at v1.
   Reduced case:

   ```hale
   import "../matrix" as mat;
   type Embedding { id: String; vector: mat::Matrix; metadata: String; }
   ```

   `hale build` rejects with:

   ```
   codegen error: unsupported in codegen v0: qualified type
   `mat::Matrix` (mangled `__lib_mat_matrix_Matrix`) declared in
   stdlib path-renames table but not registered in user_loci,
   user_types, or user_interfaces yet — sequencing issue:
   type_expr_to_codegen_ty called before pass A0/A1 populated
   this name
   ```

   The same diagnostic fires on `params { x: mat::Matrix; }` for
   a locus too. Cross-seed locus refs work as **fn parameters**
   and as **locus method receivers** but not as struct / locus-
   param **fields**.

**Shipped shape:**

- `Store` is a user-declared locus (not `@form(vec)`) carrying
  three child `@form(vec)` sub-loci: `IdBuf` (String cells),
  `MetaBuf` (String cells), `FloatBuf` (Float cells, flat
  `count * dim` floats row-major).
- `Embedding` keeps `id` and `metadata` but `vector: Matrix` is
  replaced with `vector_csv: String` — a CSV serialization of
  the row-major flat vector. Round-trips via
  `embedding_from_matrix` / `EmbeddingOps.to_matrix`.
- The Store's `add` doesn't consume `Embedding` — it takes
  `(id, vector: mat::Matrix, metadata)` directly. Methods *can*
  accept a cross-seed locus ref as a parameter, so the natural
  API is the method form.

### Locus methods can't be `fallible(EmbError)` (G4)

CONTRACTS.md declares the four `Store` methods as
`fallible(EmbError)`. Per `KNOWN_GOTCHAS G4` (two-channel rule),
locus methods on user-declared loci can't carry a
`fallible(E)` return type.

**Shipped shape:** locus methods substitute sentinels on bad
input (silent no-op, empty `Rows`); paired free fns
`add_checked`, `search_checked`, `remove_checked` carry the
fallible(EmbError) surface. Same workaround pattern as
`pond/math/matrix`'s `at` / `at_checked` split.

### `SearchHit` declared but not the Store-surface return type

CONTRACTS.md declares
`type SearchHit { id: String; score: Float; metadata: String; }`
alongside `search() -> Rows`. The two shapes are inconsistent —
`Rows` is a String-CSV blob shape, `SearchHit` is a typed
record. Shipped surface keeps `Rows` (matching the actual
return type in the contract block) and provides `SearchHit` as
a parsing target a consumer can map rows into. The Store
itself never produces a `SearchHit` value.

## Language / stdlib gaps

### Free fns can't take `self` as a value-position arg

A free fn signature like `fn score_buf_for_query(s: Store, ...)`
is legal, but at the call site inside a `Store` method body the
natural form

```hale
let scores = score_buf_for_query(self, query, q_mag);
```

rejects at codegen with:

```
codegen error: unsupported in codegen v0:
expression form Discriminant(3)
```

(`Discriminant(3)` = `Expr::KwSelf`; the rejection is the
fallthrough arm of `lower_expr` for KwSelf in value position —
see `crates/hale-codegen/src/codegen.rs:17815`.) The
workaround is to inline the call into the method body or pass
individual fields (`self.dim`, `self.flat`, etc.) instead of
`self`. The friction is real — the free-fn-with-self-arg
idiom is exactly how the matrix-style "method delegates to a
free helper" pattern works in lifecycle bodies (which reject
`return`), so the failure mode is surprising. A focused
diagnostic ("free-fn call with `self` arg — receiver loci
can't cross fn frames at v1; inline the body or split into
field args") would land it cleanly.

### `or discard` rejects on value-bearing fallibles

```hale
let _drop_id = self.ids.pop() or "";   // works
self.ids.pop() or discard;              // rejected — pop returns String
```

Diagnostic is clear ("`or discard` requires the underlying
call's success type to be Unit"), but the friction is real for
"I'm draining a vec by repeated `pop`, I don't care about the
popped value" loops — every call site needs an `or
<typed-zero>` and an unused `let _ = ...` binding. An `or
ignore` (sugar for "swallow value too") would tidy these
loops. Same applies to `set` chains where the new value isn't
needed.

### Cross-seed locus ref in struct/locus-param field positions

See "Contract deviations § Wall 2" above. The diagnostic from
codegen is pass A0/A1 sequencing-related and reads as an
internal note, not a user-actionable error. The intended user
message is "cross-seed locus refs can't sit in fields at v1;
use method-parameter pass-through instead."

### No `Float::NAN` / `std::math::nan()` constant

Same gap pond/math/matrix logged. Producing NaN required calling
the matrix lib's `mx.nan_sentinel()` (`0.0 / 0.0`) at runtime.
A `std::math::nan()` would let the embedding lib stop reaching
into matrix's namespace lotus just for NaN production. (We do
call `mat::Mat.is_nan`, which is the same shape — see "Duplicate-
suspected" below.)

## Duplicate-suspected helpers

- **`mat_nan()` / `mat_is_nan(f)`** — pure pass-through wrappers
  around `mat::Mat.nan_sentinel()` / `mat::Mat.is_nan()`.
  pond/math/matrix already flagged these as candidates for
  `std::math::nan()` / `std::math::is_nan()`. Embedding consumes
  them in the top-k selection loop (NaN-marker for "already
  picked"); having to instantiate `mat::Mat` per call is real
  friction.

- **`vector_magnitude_from_matrix(m)`** — `sqrt(dot(m, m))` over
  a Matrix interpreted as a flat vector. This is `‖v‖₂`, the
  L2 norm — a textbook linear-algebra primitive. pond/math/matrix
  doesn't expose it directly (only `dot`). Candidate for a
  `mat::Mat.norm(m: Matrix) -> Float` method, or a free fn
  `std::math::norm2(...)`-shaped helper.

- **`csv_field_count(s)`** — counts comma-separated fields. The
  same scan lives inline in `mat::Mat.from_rows`. Candidate for
  a `std::str::split_count(s: String, sep: String) -> Int`
  stdlib helper.

- **`nth_line(csv, i)` / `nth_id(csv, i)`** (in the demo) —
  tab/newline-separated-row parsing utilities. Every pond lib
  that returns `Rows` (router, sqlite, jobs, migrations, ...)
  will reach for the same shape. Strong candidate for a
  `std::rows::{split, field}` or similar stdlib helper.

- **Sentinel-pair pattern (`is_error_*` + sentinel constructor)**
  — second pond lib to land on this (pond/math/matrix is the
  first). If a third instance appears, a `pond/sentinels`
  namespace lotus or `std::sentinel::{nan, is_nan, error_marker}`
  helper would amortize the friction.

## Non-friction observations

- Parallel-array shape ("three `@form(vec)` sub-loci kept in
  lockstep") composes cleanly once the `@form(vec)`-cell rules
  are accepted. The locus-param-default mechanism
  (`ids: IdBuf = IdBuf { }`) gives the sub-loci a lifetime tied
  to the parent's scope without explicit birth/dissolve plumbing.
- `Mat.from_rows(1, n, csv)` is the right primitive for the
  Matrix↔CSV round-trip — the embedding lib didn't have to
  parse floats itself.
- The `Mat.dot` / `Mat.is_nan` interface is enough to express
  cosine similarity at the surface level, but the inner-loop
  hot path (compute dot vs flat row, compute row magnitude) is
  cheaper inline than calling `Mat.dot` per row (would require
  reconstructing a 1xdim Matrix per stored row, defeating the
  parallel-array win).
- The shape of `Store.search` returning `Rows` (newline-tab
  string) is the same shape the rest of pond uses for "tabular
  result" returns — composes with router / sqlite / jobs / etc.
  No new shape invented.
