# pond/ml/neural — FRICTION

Gaps, suspicions, and contract deviations surfaced while building
this lib.

## Contract deviations

### CONTRACTS.md `Layer { weights: Matrix; biases: Matrix; }` →
### shipped `Layer { weights_offset: Int; weights_count: Int; ... }`

CONTRACTS.md declares the `Layer` type with two Matrix fields.
v1 doesn't admit locus refs in `type` record fields
(spec/semantics.md § "Slot restrictions (v1)" rejects LocusRef
cells; the same restriction propagates to type-record fields
through the codegen-pass-A0 ordering pattern documented in
`pond/router/types.hl` "context-req-field"). The shipped shape
flattens to four Int windows into Model's flat `@form(vec) of
Float` param buffer:

```hale
type Layer {
    name:           String;
    input_dim:      Int;
    output_dim:     Int;
    activation:     String;
    weights_offset: Int;
    weights_count:  Int;
    biases_offset:  Int;
    biases_count:   Int;
}
```

Read-side accessors (`Model.load_weights(layer)` /
`Model.load_biases(layer)`) rebuild a fresh Matrix per call from
the windows. Write-side updates (`Model.update_weights` /
`update_biases`) do the reverse. The Matrix surface is preserved
everywhere a caller would naturally want one; the on-locus
storage is the only thing that differs from the contract.

Suggested CONTRACTS.md amendment: either (a) acknowledge the
flattened-Layer-windows shape as the v1 binding contract, or
(b) defer the Matrix-field Layer until v1 ships locus-cells in
type records / vec cells.

### CONTRACTS.md `Trainer.params { model: Model; ... }` →
### shipped `Trainer.params { lr; batch_size; last_error; }` and
### `fit(model, xs, ys, epochs)` (model is fit-arg)

Same root cause: locus refs can't sit in another locus's params
at v1 (the restriction `pond/jobs/pool.hl` documents as
"queue: Queue → db_path + table"; same wall, same workaround).
Shipped shape drops `model` from the Trainer's params and adds
it as the first positional argument to `fit`.

Suggested CONTRACTS.md amendment: amend the Trainer signature to
`fit(model: Model, xs: Matrix, ys: Matrix, epochs: Int)` and drop
`model: Model` from `params`.

### CONTRACTS.md `fn forward(x) -> Matrix fallible(NnError)` →
### shipped `fn forward(x) -> Matrix` (sentinel + last_error)

Two-channel rule (KNOWN_GOTCHAS G4): locus methods cannot
declare `fallible(E)`. Shipped shape returns the matrix error
sentinel (`mat::Mat.is_error(out)` is the predicate) on shape
mismatch and stashes a populated `NnError` on `self.last_error`.
Same pattern `pond/math/matrix`'s `Mat.matmul` uses.

The same deviation lands on `Model.apply_delta(d)`
(state-mirroring surface-interface satisfaction; non-fallible, last_error
populated on decode failure) and `Trainer.fit(...)` (publishes
nothing on shape mismatch; last_error populated).

### CONTRACTS.md `topic TrainStep { payload: TrainStep; }` →
### shipped `topic TrainStepEvent { payload: TrainStep; subject: "nn.TrainStep"; }`

CONTRACTS.md declares a topic and a type both named `TrainStep`.
Typecheck rejects the duplicate top-level name. Adopted shape
matches `downstream-consumer/topics.hl`'s convention:
`topic TickEvent { payload: Tick; subject: "..."; }`. The
payload type name `TrainStep` is preserved; the topic name takes
the `Event` suffix.

The explicit `subject: "nn.TrainStep"` is forced by
KNOWN_GOTCHAS G1 — cross-seed topic-by-name publish/subscribe is
broken at the mangler, so consumers that subscribe to this topic
have to use the literal-string subject form
(`subscribe "nn.TrainStep" as ... of type nn::TrainStep;`).
Naming the subject explicitly at the topic decl gives the
consumer a stable wire name to bind to.

### `TrainStep.epoch` → `TrainStep.epoch_idx`

`epoch` is a reserved keyword (`TokenKind::Epoch` — the closure
cadence clause: `epoch tick;` / `epoch dissolve;` / `epoch
inline;`), so a `type` field named `epoch` is unparseable. Same
deviation pattern `a future store-pattern lib` applies for Version.era
(CONTRACTS.md spells it `epoch`; lib spells it `era`).

Suggested CONTRACTS.md amendment: rename the field to
`epoch_idx` to match the lib (or `era` for symmetry with
the version shape).

### `the version shape` → `nn::NnVersion`

CONTRACTS.md declares `Model` as satisfying `state-mirroring surface`,
which includes `fn version() -> Version`. Importing
`the future store-pattern lib` and referencing `the version shape` in a return-position
type fires "codegen error: qualified type `the version shape` not in
stdlib path-renames table" — the cross-seed qualified-type
lookup table doesn't yet register user-lib qualified types in
fn return positions. Shipped shape: a locally-declared
`NnVersion` type with the same `{ generation: Int; era: Int; }`
shape. The interface satisfaction is moot until the
qualified-type codegen gap is fixed; the wire-shape stability
is preserved.

### `Trainer.batch_size` is a stub at v1

The `batch_size` param is accepted and threaded into TrainStep's
`step` counter but the inner loop is per-sample SGD (effective
batch_size=1). A true mini-batch loop would accumulate grads
across `batch_size` samples before each update. Two paths
forward, neither blocked by the language:

1. Extend `Model` with `zero_grad()` / `accumulate_step()` /
   `apply_grad()` so `Trainer.fit` can fold grads across the
   batch and apply once. Straight-line — no language gap.
2. Keep the per-sample inner loop but multiply effective lr by
   `1.0 / batch_size`. A weak approximation; correct only for
   linear models.

Logged as "batch-size-stub" for the future-work pass.

## Language / stdlib gaps

### `int_to_float` requires ASCII roundtrip

The documented Int → Float widening at let-binding type
ascriptions (spec/types.md § "Numeric coercion: Int → Float")
rejects with "expected Float, got Int" on the current build for
ints sourced from struct fields. Routing through
`std::str::parse_float(to_string(n))` is the available
type-coercion surface — same shape `downstream-consumer/
library-b.hl` uses for `decimal_to_float`. The lib's
`int_to_float(n)` free fn wraps the roundtrip.

The cleanest fix at the language level would be making the
widening fire at any value-position where the destination type
is Float — not just at let-binding ascriptions. Or shipping
`std::math::int_to_float` / `std::math::float_to_int` primitives
that codegen handles directly.

Note: `downstream-consumer/library-a.hl` line 746 documents
`let whole_f: Float = whole;` working for its case. The same
pattern fires the typecheck rejection in
`pond/math/stats/stats.hl` line 25 and in this lib. The
asymmetry might be sensitive to surrounding context (immediate
struct-field source? prior arithmetic?) and warrants a focused
repro.

### `let f: Float = expr;` rejected for Int-typed expr in some positions

```hale
fn add_dense(input_dim: Int, output_dim: Int, ...) {
    let in_out_sum_i = input_dim + output_dim;   // Int
    let in_out_sum: Float = in_out_sum_i;         // REJECTS at typecheck:
    //  ^^                                          "expected Float, got Int"
}
```

The matching free-fn return-position widening also rejects:

```hale
fn int_to_float(n: Int) -> Float {
    return n;   // REJECTS: "return type mismatch: declared Float, got Int"
}
```

Both are documented widening surfaces per `spec/types.md`. The
downstream consumers have one working case
(`downstream-consumer/library-a.hl` line 746) and one rejecting
case (`downstream-consumer/metrics.hl` line 72 — try building
that seed in isolation). Logged as
"int-to-float-ascription-rejected" alongside the `int_to_float`
ASCII-roundtrip workaround.

### `-> ()` parse + codegen gap on fallible — see pond/math/matrix FRICTION

Same gap as the matrix lib's `set_at_checked` — fallible(E) free
fns must declare a non-Unit return type. The neural lib didn't
need fallible free fns in the final shape (the lib's two-channel
choice puts every fallibility on `last_error` instead), so the
gap didn't bite. Mentioned here to triangulate it across libs.

### Topic-decl + payload-type name collision

`topic TrainStep { payload: TrainStep; }` (verbatim CONTRACTS.md)
parse-rejects as "duplicate top-level name". The grammar
registers topic decls and type decls in one namespace; the parser
distinguishes by keyword but the typecheck pass treats them as
shared names. Workaround: name the topic `XxxEvent` and the
payload `Xxx`. The `downstream-consumer/topics.hl` convention
is the canonical shape.

A cleaner fix at the typecheck level: topics and types should
live in disjoint scopes (the grammar already keeps them
syntactically distinct).

### ~~Cross-seed topic-by-name publish + subscribe — KNOWN_GOTCHAS G1~~

**Resolved 2026-05-17** by upstream `f9068fa` (A1 + A7).
trainer.hl publishes by topic ident (`publish TrainStepEvent;
TrainStepEvent <- payload;`) and the xor-trainer demo subscribes
via `nn::TrainStepEvent`. Original entry retained below for
context.

The lib's `Trainer.publish TrainStepEvent` was working in-seed
but firing "unknown topic" when consumers imported `nn` and
referenced the topic by name. The literal-string subject form is
the documented workaround (per KNOWN_GOTCHAS G1):

```hale
// In trainer.hl:
bus { publish "nn.TrainStep" of type TrainStep; }
"nn.TrainStep" <- payload;

// In the consumer (example main.hl):
subscribe "nn.TrainStep" as on_step of type nn::TrainStep;
```

The lib reaches for this both in `topics.hl` (the topic itself
carries `subject: "nn.TrainStep"`) and in `trainer.hl` (the
publish uses the literal-string form). Once the mangler learns
to rewrite topic idents in BusMember::Publish / BusMember::Subscribe
the bare-name form will compose.

### Cross-seed qualified-type codegen — `the version shape` rejected

```hale
import "../../future store-pattern" as store;
fn version() -> the version shape { ... }
// codegen error: qualified type `the version shape` not in stdlib
//                path-renames table
```

The cross-seed type-import surface works at parse + typecheck
but loses the qualified-type registration at codegen. Workaround:
declare a local twin shape (`NnVersion { generation: Int; era:
Int; }`) and return that. The Model's state-mirroring surface
is technically incomplete until the qualified-type codegen gap
is fixed — the contract calls for `version() -> the version shape`
but the lib ships `version() -> NnVersion`. The wire-shape
stability is preserved (same two-Int payload, same
declaration order, same field names) so a consumer that needs
the version shape can construct one at the boundary.

### Float / Int binary-op widening

```hale
let mean_loss = epoch_loss / (0.0 + n_samples);
//                            ^^^^^^^^^^^^^^^^
// "binary op: incompatible operand types `Float` and `Int`"
```

The `(0.0 + n_samples)` Float-widening idiom from
`pond/math/matrix` README examples doesn't compile on the
current build (no expression-position widening). Workaround via
the `int_to_float` free-fn helper (which itself goes through the
ASCII roundtrip — see "int_to_float requires ASCII roundtrip"
above):

```hale
let n_samples_f = int_to_float(n_samples);
let mean_loss = epoch_loss / n_samples_f;
```

`pond/math/stats/stats.hl` also doesn't build standalone for
the same reason (lines 25 / 37 / 83). Logged for the float-
widening pass.

### ~~No `std::math::tanh`~~

**Resolved 2026-05-17** by upstream `d946ae2` (C8: std::math tanh
/ nan / is_nan / inf). pond pass D12 swapped model.hl's
`tanh_float` for `std::math::tanh` and trainer.hl's `mx.is_nan`
for `std::math::is_nan`. Follow-up **2026-05-18**: model.hl's
three `mx.nan_sentinel()` sites in `train_step` (the
shape-mismatch / empty-model early returns) now call
`std::math::nan()` directly — the `mat::Mat` instantiation was a
pre-C8 workaround for the missing quiet-NaN primitive. Original
entry retained below.

Note: under tight V-memory ulimit (≤ 6 GB) the xor-trainer demo
binary aborts with the libm-backed tanh in use; under default
ulimit it converges normally. Worth investigating why libm tanh
inflates the binary's address space in this lib's hot loop —
not a correctness issue, but a memory-footprint anomaly that
shows up only on a 2-3-1 MLP × 5000 epochs scale.

`std::math::{sqrt, exp, log, floor, ceil, pow}` ship per
spec/stdlib.md, but `tanh` doesn't. The lib synthesizes it from
`exp`:

```hale
fn tanh_float(x: Float) -> Float {
    let ex = std::math::exp(x);
    let enx = std::math::exp(0.0 - x);
    return (ex - enx) / (ex + enx);
}
```

Candidate stdlib add: `std::math::tanh(x) -> Float` (libm
primitive — same path-call shape as `exp`). Also `std::math::nan()`
and `std::math::is_nan(f)` reach for the same primitives the
matrix lib synthesizes itself.

### No batched / mini-batch primitives in mat::

A natural extension on `mat::Mat` would be `slice_rows(m,
row_start, row_end) -> Matrix` so the trainer can extract a
mini-batch in one call. v1 has `at(r, c)` element access; the
trainer's `extract_row` builds the slice one cell at a time.
Logged as "duplicate-suspected" — any other lib that does
row-major slicing will reach for the same shape.

## Duplicate-suspected helpers

- **`int_to_float(n: Int) -> Float`** — every numeric lib that
  mixes Int + Float (`pond/math/stats/stats.hl` line 25,
  `downstream-consumer/library-b.hl` line 302 for the
  Decimal→Float twin) needs this bridge. Candidate for
  `std::math::int_to_float` once the widening gap is owned at
  the language level OR a stdlib helper lands.

- **`activate_one(v, name)` / `activation_deriv(z, name)`** —
  this lib's hand-rolled sigmoid / relu / tanh / linear
  switchboard is the toy version. A more serious NN lib (or a
  shared `pond/ml/activations/`) would centralize the activation
  vocabulary so multiple model surfaces compose against the same
  derivative table.

- **`extract_row` / `column_view` / `transpose_col_to_row`** —
  all three shape helpers live on `NnOps` because v1 free fns
  can't return LocusRef (G3). A shared `pond/math/matrix` Mat
  method set (`Mat.row(m, r)`, `Mat.col(m, c)`, `Mat.as_column(m)`)
  would absorb all three. Candidate for promotion to the matrix
  lib once a second consumer surfaces.

- **`FwdCache` / `OffsetTable` flat-buffer pair** — the "two
  parallel `@form(vec)` loci to track variable-length records in
  a flat float buffer" pattern. The metrics lib's
  `MetricMap + HistogramList` pair has similar shape (composite
  key + parallel value vec). Candidate to promote to a
  `pond/forms/jagged-vec` once a third consumer appears.

## Non-friction observations

- The `@form(vec) of Float` Model substrate worked first try
  once the deviations above were settled. The flat param buffer
  + per-layer offset windows is small enough to fit on one
  screen and fast enough that the matmul dominates per-sample
  time.
- The state-mirroring surface snapshot/apply_delta round-trip in the XOR demo
  copies all weights and biases through ASCII and recovers a
  network that predicts identically to the original on the four
  XOR corners. Bytes-shape stability validated end to end.
- The XOR demo's 2-3-1 topology trains to loss < 0.001 in 5000
  epochs at lr=0.5 with a deterministic rng_state=42 seed. The
  2-2-1 topology (the smallest "valid" XOR net) is
  init-sensitive — most seeds fall into the 0.15-plateau local
  minimum and only learn 3-of-4 corners. The README + the demo
  use 2-3-1 to make the demo deterministic across runs.
