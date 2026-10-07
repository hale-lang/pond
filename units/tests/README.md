# Unit-catalogue verification

The oracle is `golden.json`: 1,671 independently specified exact relationships,
with primary-source keys and explicit treatment of cases beyond native integer
headroom. It covers all 986 catalogue declarations and the seven standard time
units they build on. Expected values are not read from library declarations.

`generate_golden.py` reads the actual unit-only Hale source as the system under
test and resolves its rational graph using Python `Fraction`. It verifies the
oracle, requires every component to be connected by independent expected
relationships, rejects uncovered added units, and checks that the committed generated
tests match their fixture. Its supported grammar is deliberately restricted:
unexpected source syntax, duplicate definitions, unresolved references and
cycles fail verification. This catalogue uses acyclic definitions even though
the language also permits consistent cycles.

```sh
python3 units/tests/generate_golden.py --check  # graph, coverage, generated files
python3 units/tests/generate_golden.py         # same checks, regenerate files
python3 units/tests/test_golden_verifier.py   # test the verifier against mutations
hale test units/                              # native positive suites
python3 units/tests/run_rejections.py          # check AND build negative fixtures
```

The native golden corpus contains 72 files and 16,792 assertions:
1,394 signed runtime ratio cases and 16 exact literal-conversion cases.
Runtime cases exercise both directions and multiple positive/negative
inputs; expectations remain the fixture's exact known ratios. An additional
261 cases are **graph-only**, each with a reason. They are not claimed as
native passes: a complete rational graph spans more than a signed `Int` can
hold, notably in the stdlib's nanosecond-based Duration.

Two compiler edges influence emitted test shape. For literal-only exact
conversions, negative literals can lose the positive literal's divisibility
proof; the test negates an already converted exact value. Three time
comparisons explicitly widen to picoseconds to avoid a mixed Duration/Int
backend representation. These choices are visible in fixture metadata and
generated comments; they do not change expected ratios or silently skip tests.

`behavior_test.hl` adds 83 assertions for signed rounding, half ties, named
type policies, substitutes, exact residues, standard time and ratios.
`rational_conversion_test.hl` adds 126 assertions for runtime `.in(...)`
conversions with non-integer factors: Torr/mbar, enzyme units/nkat and lb/g,
in both directions, with signed rounding, ties, exact values and substitutes.
`../quantities/tests/quantities_test.hl` adds 68 assertions, including a
typed conversion and count check for every optional principal quantity, four
temperature point types, origin shifts and cross-seed refinements. Together
the 75 native test programs execute 17,069 assertions.

The 16 negative fixtures must fail with their intended type diagnostic under
both `hale check` and native `hale build`. The runner rejects a signal/crash,
an unrelated error, accidental acceptance, or a produced binary. Build outputs
go into an automatically removed temporary directory. Pass `--hale PATH` or
set `HALE_BIN` to use a pinned compiler; `--timeout` bounds each invocation.

## Pinned run

Verified 2026-10-07 with Hale `0.22.0` at
`2027ab41c1d10b98c0b8baeceafb587ba2178b1a`. The original v0.22.0 release
predates units; use this commit or a later compiler containing the dialect.

The golden verifier was also tested against isolated mutations: a wrong inch
factor, an added uncovered unit, a missing generated test, and coordinated
subgroup scale mutations each made it fail. A regression test also removes a
bridging expectation to ensure the connectivity guard rejects that weakened oracle.
Ordinary tests make no network calls and require no Python dependencies outside
the standard library. The compiler's own SDK/linker requirements still apply.
