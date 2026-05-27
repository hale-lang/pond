# pond/math/stats — FRICTION

Gaps, suspicions, and deviations from CONTRACTS.md surfaced while
building this lib. `pond/math/matrix/` is on disk and unblocked;
the lib builds clean.

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
