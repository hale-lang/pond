# pond/math/stats — FRICTION

Gaps, suspicions, and deviations from CONTRACTS.md surfaced while
building this lib.

## blocked-on-sibling-lib: pond/math/matrix not yet present

`pond/math/matrix/` does not yet exist on disk at build time
(`ls pond/math/` lists `stats` only).
Every source file in this lib imports `../matrix` for the
`Matrix` type that every free-fn signature references, so

```
hale build \
    pond/math/stats/
```

fails with

```
could not resolve import "../matrix": tried .../math/stats//../matrix.hl,
.../math/stats//../matrix/, and workspace-root/../matrix/
```

This is the documented expected state per the assignment ("If
matrix isn't built yet, your example will fail to build — that's
expected. Note in FRICTION.md."). The assignment also explicitly
forbids forward-declaring Matrix on this side, so we hold the
import and stop. The lib should compile clean once
`pond/math/matrix/` lands and exports the surface in
`pond/CONTRACTS.md § pond/math/matrix/`.

Re-run the build command above once matrix is in place; no source
changes here should be needed.

## 2026-05-17 — pond pass D3 (cross-seed free-fn sweep) repair

The lib's public surface was already bare free fns (no
`Stats`-namespace-lotus facade) — D3's substitution found
nothing to remove. Two collateral fixes shipped here:

1. `stats.hl` and `examples/stats-demo/main.hl` had been written
   against `mat::zeros(rows, cols)` as if it were a bare free fn,
   but `zeros` lives on the `Mat` namespace lotus per G3 (free
   fns can't return Matrix locus refs — and matrix is out of D3
   scope so its surface didn't move). Fix: instantiate the
   lotus and dispatch — `let mx = mat::Mat { }; mx.zeros(1, n);`.
2. `set_at(r, c, v) or raise` calls on Matrix were rejected by
   codegen (the method is non-fallible — silent no-op on OOB);
   the original demo + stats internal both used the `or raise`
   pattern as if Matrix.set_at were fallible. Fix: drop the
   `or raise` clause; the fallible variant is the free fn
   `mat::set_at_checked(m, r, c, v) or raise`.

Both demos build and pass post-fix. Neither was an A3 substitution
— pre-existing bugs surfaced when the demo battery actually ran.

## duplicate-suspected: near_eq helper in demo

`examples/stats-demo/main.hl` redeclares a `near_eq(actual,
expected, eps, label)` helper that's nearly identical to the one
in `crates/hale-codegen/tests/fixtures/examples/53-window-ring/
main.hl` (and likely in every other Float-comparing demo in the
tree). Candidate to lift into a `pond/dev/asserts/` or
`std::test::assert_near_float` once a workload demonstrates the
pattern is N>=3 places. Not lifted here — staying inside the
"only edit pond/math/stats/" rule.

## design-question: empty-input policy on infallible free fns

`mean` / `variance` / `stddev` / `min_max` are infallible per
CONTRACTS.md but every one has a well-defined failure on
`xs.len() == 0` (division by zero / no element to compare).
This lib resolves that by returning `0.0` (or a 1x2 `[0.0, 0.0]`
for `min_max`), matching the same empty-as-zero convention
`OnlineMoments`'s `current_mean()` uses pre-`observe`. That's a
choice, not a contract requirement. Two alternatives worth
flagging if a workload pushes back:

1. **Flip them all to `fallible(StatsError)` with `kind: "empty"`**
   — uniform with `quantile`, but every call site pays an `or`
   even on guaranteed-non-empty inputs. Heavy for the common
   case.
2. **Closure-violation on empty** — substrate-channel failure
   ("this is a substrate invariant break"). Free fns can't host
   closure assertions, so this would require restructuring as
   locus methods, which conflicts with pattern-6 placement.

Sticking with empty-as-zero for v1; revisit if a consumer
surfaces ambiguity.

## design-question: variance/stddev use population (/N) divisor

CONTRACTS.md says `variance(xs) -> Float` and `stddev(xs) -> Float`
without specifying population vs sample. This lib uses population
variance (sum of squared deviations divided by `N`, not `N-1`).
Matches what `OnlineMoments.current_var()` returns
(`m2 / n`), so the two surfaces agree under the empty-as-zero
convention. If a downstream consumer needs sample variance, the
natural extension is `variance_sample(xs)` /
`stddev_sample(xs)` rather than a flag — flag-driven semantic
shifts are an anti-pattern The Design counsels against.

## deviation: quantile uses type-7 / R-default interpolation

CONTRACTS.md doesn't specify the quantile convention. This lib
uses the type-7 linear-interpolated convention (the R / NumPy
default): `h = q*(N-1)`, then linearly interpolate between the
`floor(h)`-th and `ceil(h)`-th sorted order statistics. That
matches what most consumers expect from a bare `quantile(xs,
0.5)` median call; flagged here so the choice is explicit.
