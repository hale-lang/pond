# pond/ml/neural — toy NN trainer with dense layers + autograd-lite

Suggested alias: `nn`.

```hale
import "vendor/pond/math/matrix" as mat;
import "vendor/pond/ml/neural"   as nn;

let model = nn::Model {
    name:       "xor",
    rng_state:  42,
};
model.add_dense(2, 3, "sigmoid");
model.add_dense(3, 1, "sigmoid");

let xs = mat::from_rows(4, 2, "0,0, 0,1, 1,0, 1,1");
let ys = mat::from_rows(4, 1, "0, 1, 1, 0");

let trainer = nn::Trainer {
    lr:         0.5,
    batch_size: 4,
};
trainer.fit(model, xs, ys, 5000) or raise;

let x = mat::from_rows(2, 1, "1.0, 0.0");
let p = nn::forward(model, x) or raise;   // free fn (m90); 2x1 in → 1x1 out
println(p.get(0) or 0.0);                  // ~0.98
```

> **Heap-corruption caveat (hale HEAD, 2026-06-12).** A Matrix
> manufactured inside a locus METHOD frame and passed into
> `model.train_step` (which is what `Trainer.fit` does
> internally) corrupts the heap — fit completes correctly but
> the process can segfault at a later allocation. Until the
> upstream fix lands, either drive `model.train_step` directly
> from `fn main()`/free-fn chains, or make the `fit` call the
> last allocation-bearing act of the program. See FRICTION.log
> "method-frame-fresh locus args corrupt the heap".

## Scope — what "autograd-lite" means here

This is a *toy* trainer designed for tiny supervised problems
(XOR, the canonical "smallest non-linear-separable" benchmark;
the MNIST-scale problems CONTRACTS.md mentions are aspirational
at v1 — you can train a 784-128-10 MLP with this surface but the
single-sample SGD inner loop will be uncompetitive with a
production framework).

What you get:

- **Dense layers** — `add_dense(input_dim, output_dim, activation)`
  appends one fully-connected layer to the model. Activations:
  `"sigmoid" | "relu" | "tanh" | "linear"`.
- **No graph, no tape.** Backward is hand-coded against the
  forward pass inside `Model.train_step`. The four supported
  activations have closed-form derivatives wired into the
  `backprop_activation` free fn. New activations require editing
  `activate_one` + `activation_deriv` together.
- **SGD only.** One sample, one update; no Adam / momentum /
  weight-decay. Per-sample order is the dataset's row order
  (no shuffling at v1).
- **MSE loss.** Mean-squared-error over the final layer's output
  vs. target. Cross-entropy / NLL are not wired in.
- **Per-epoch reporting.** `Trainer.fit` publishes one
  `TrainStepEvent` on the bus per epoch with `loss / epoch_idx /
  step`. The example wires a `TrainLogger` subscriber.

## Surface

### `nn::Layer` — pure-data record

```hale
type Layer {
    name:           String;
    input_dim:      Int;
    output_dim:     Int;
    activation:     String;        // "sigmoid" | "relu" | "tanh" | "linear"
    weights_offset: Int;           // window into Model.params
    weights_count:  Int;
    biases_offset:  Int;
    biases_count:   Int;
}
```

CONTRACTS.md declares `weights: Matrix; biases: Matrix;` —
deviated to (offset, count) Int windows because v1 type records
can't carry locus refs (FRICTION.log "layer-stores-windows-not-matrices").
The Matrix surface is preserved everywhere it matters: the
read-side helpers `load_weights(model, layer)` and
`load_biases(model, layer)` (free fns per the v0.8.2 m90
enforcement) rebuild a fresh Matrix per call.

### `nn::Model` — owner of weights + biases

```hale
@form(vec)        // params buffer: heap of Float
locus Model {
    params {
        name:        String;
        meta_csv:    String;       // "in,out,act;in,out,act;..."
        layer_count: Int;
        params_len:  Int;
        gen:         Int;
        era:         Int;
        rng_state:   Int;          // LCG seed for Xavier init
    }
    fn add_dense(input_dim: Int, output_dim: Int, activation: String);
    fn train_step(x: Matrix, y: Matrix, lr: Float) -> Float fallible(NnError);
    fn layer_at(i: Int) -> Layer;

    // state-mirroring surface
    fn version() -> NnVersion;
    fn snapshot_bytes() -> Bytes;
    fn apply_delta(d: Bytes) -> () fallible(NnError);
}

// Module-level free fns (v0.8.2 m90 enforcement: locus methods
// may not return locus values; free fns may):
fn forward(model: Model, x: Matrix) -> Matrix fallible(NnError);
fn load_weights(model: Model, layer: Layer) -> Matrix;
fn load_biases(model: Model, layer: Layer) -> Matrix;
fn extract_row(m: Matrix, r: Int, cols: Int) -> Matrix;
fn extract_row_into(m: Matrix, r: Int, cols: Int, out: Matrix);
```

`forward(model, x)` fails with kind="empty_model" /
"shape_mismatch" on the value channel. `train_step(x, y, lr)`
does forward + backward + per-sample SGD update and returns the
sample's MSE loss; shape errors `fail NnError { ... }`.
CONTRACTS.md declares `forward` as a `Model` method — the m90
enforcement forbids that shape (locus-valued returns); the free
fn is the deviation, logged in FRICTION.log. `NnOps` survives
only as an empty placeholder locus.

### `nn::Trainer` — service locus, publishes TrainStepEvent

```hale
locus Trainer {
    params { lr: Float = 0.01; batch_size: Int = 32; }
    bus { publish TrainStepEvent; }
    fn fit(model: Model, xs: Matrix, ys: Matrix, epochs: Int)
        -> () fallible(NnError);
}
```

`fit` walks the dataset epoch-by-epoch and per-sample. After each
epoch publishes a `TrainStepEvent` carrying the epoch's mean
loss. `batch_size` is accepted for forward-compat but the v1
implementation is per-sample SGD (effective batch_size=1) —
see FRICTION.log "batch-size-stub".

CONTRACTS.md declares `params { model: Model; ... }`; `model`
moved to a fit-arg (locus refs can't sit in another locus's
params — still open). `fit` is `() fallible(NnError)` per the
contract. Internally fit reuses two preallocated row buffers
via `extract_row_into` instead of allocating per sample — part
mitigation for the heap-corruption caveat above (fit completes
correctly; the corruption fires on later allocations). Full
context in FRICTION.log.

### `nn::TrainStep` + `nn::TrainStepEvent` — per-epoch metric

```hale
type TrainStep {
    loss:      Float;
    epoch_idx: Int;          // 1-indexed. Spelled epoch_idx not epoch
                             //   because `epoch` is reserved (closure
                             //   cadence clause).
    step:      Int;
}
topic TrainStepEvent { payload: TrainStep; subject: "nn.TrainStep"; }
```

### `nn::NnError` — single error payload

```hale
type NnError { kind: String; detail: String; }
// kinds: "shape_mismatch" | "unknown_activation" | "empty_model" |
//        "decode_failed" | "snapshot_decode_failed"
```

## Internals

| File          | What it holds                                            |
|---------------|----------------------------------------------------------|
| `errors.hl`   | `NnError` payload type.                                  |
| `metrics.hl`  | `TrainStep` per-epoch metric record.                     |
| `layer.hl`    | `Layer` shape type carrying (offset, count) windows.     |
| `model.hl`    | `Model` locus (`@form(vec)` of Float), matrix-shaping free fns (former `NnOps` methods; the locus is an empty placeholder now), `FwdCache` + `OffsetTable` per-train_step buffers, `NnVersion` shape type. |
| `trainer.hl`  | `Trainer` service locus + the `TrainStepEvent` topic decl (explicit `nn.TrainStep` subject), co-located with its single publisher. |

`FwdCache` and `OffsetTable` are `@form(vec)` sibling loci
let-bound inside `Model.train_step` for the forward-pass
activation cache. Both dissolve at `train_step`'s scope exit.

## Example

```bash
$ hale build \
      pond/ml/neural/examples/xor-trainer/
$ pond/ml/neural/examples/xor-trainer/xor-trainer
[xor] training 2-3-1 MLP for 5000 epochs ...
[xor]   epoch=1 loss=0.286837
[xor]   epoch=1000 loss=0.00245043
[xor]   epoch=2000 loss=0.000824435
[xor]   epoch=3000 loss=0.000486876
[xor]   epoch=4000 loss=0.000343538
[xor]   epoch=5000 loss=0.000264721
ok   final loss 0.000264721 < 0.05
ok   XOR(0,0) = 0
ok   XOR(0,1) = 1
ok   XOR(1,0) = 1
ok   XOR(1,1) = 0
[xor] sigmoid outputs:
  f(0,0) = 0.0077656
  f(0,1) = 0.983393
  f(1,0) = 0.983591
  f(1,1) = 0.0212664
ok   copy XOR(0,1) = 1
ok   copy XOR(1,1) = 0
[xor] exercising Trainer.fit + TrainStepEvent (500 epochs, fresh model) ...
[xor]   trainer epoch=1 loss=0.286837
[xor]   trainer epoch=100 loss=0.28696
[xor]   trainer epoch=500 loss=0.0171117
ok   trainer last_loss 0.0171117 < 0.05
[xor] xor-trainer demo complete
```

The 2-3-1 topology trains reliably across seeds in a few
thousand epochs; a 2-2-1 net falls into the classic
local-minimum failure mode for most random initializations
(see FRICTION.log "xor-2-2-1-init-sensitive").

## See also

- `pond/math/matrix/README.md` — `Matrix` + free-fn substrate
  that this lib stands on top of.
  the Model satisfies.
- `pond/CONTRACTS.md § pond/ml/neural/` — the binding contract.
- `FRICTION.log` — deviations from the contract,
  language gaps, duplication suspicions.
