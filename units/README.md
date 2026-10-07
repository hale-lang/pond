# units — exact unit catalogues

Predefined units for physics, chemistry, engineering and computing. Import
the catalogue and choose what your application's integers count, or opt into
the [ready-to-use quantity types](quantities/README.md).

Requires Hale's unit dialect, merged after v0.22.0 was released. Verified with
Hale `0.22.0` at commit `2027ab41c1d10b98c0b8baeceafb587ba2178b1a` (2026-10-07).
The version string alone is insufficient: use that commit or a later compiler
containing the unit dialect. This library does not change Pond's older baseline
for its other libraries.

## Choose your denominations

```hale
import "vendor/pond/units" as units;

type Length = quantity Int in um;
type Volume = quantity Int in uL;

fn main() {
    let length: Length = 5ft;             // 1,524,000 micrometres, exact
    let volume: Volume = 250mL;           // 250,000 microlitres, exact
    let whole_mm = length.in(mm) or floor;
    println(whole_mm, " ", volume);
}
```

The root seed declares **units only**. A component needs a quantity declaration
before its literals can be used. Declare only the quantities you need. The
stdlib already owns `Duration` and `Time`; this catalogue extends its time
units without redeclaring either type.

Unit suffixes are global across imported seeds. `1ft` is the spelling even when
the import alias is `units`; `1units::ft` is not. Import aliases do not isolate
unit names. Do not redeclare `m`, `K`, `B`, `pct`, or another catalogue symbol.
Every connected component can have only one principal quantity.

## Coverage and spelling

There are **986 declarations**, in seven source files. Symbols are
case-sensitive and ASCII: `u` replaces the micro sign, `ohm` replaces Ω,
and `m2` / `m3` denote square / cubic metres. `m` means metre; minutes are
`min`, as in the stdlib. A suffix is attached directly to an integer:
`250mL`, not `250 mL` or `0.25L`.

The complete SI prefix range is defined for these 30 symbol families:

```text
m g s A K mol cd
Hz N Pa J W C V F ohm S Wb T H lm lx Bq Gy Sv kat rad sr
L eV
```

| Prefix symbols, in increasing scale | Powers of ten |
|---|---|
| q r y z a f p n u m | -30 -27 -24 -21 -18 -15 -12 -9 -6 -3 |
| c d (none) da h k | -2 -1 0 1 2 3 |
| M G T P E Z Y R Q | 6 9 12 15 18 21 24 27 30 |

Examples: `nm`, `kg`, `uA`, `mPa`, `keV`, `kL`, `QJ`. Prefixes on mass
attach to `g`; `kg` is the SI base unit. Attoseconds are **`asec`**, because
`as` is Hale's import keyword. `ns`, `us`, `ms`, `s`, `min`, `h` and `day`
come from the stdlib; `week` is exactly seven fixed 24-hour days.

| Area | Additional symbols |
|---|---|
| Length | `inch ft yd mi nmi fathom angstrom au` |
| Area | `m2 mm2 cm2 dm2 km2 um2 nm2 pm2 angstrom2 barn in2 ft2 yd2 mi2 ha acre` |
| Volume | `m3 mm3 cm3 dm3 km3 in3 ft3 yd3 acre_ft`; all prefixes of `L` |
| US liquid volume | `gal_us qt_us pt_us cup_us floz_us tbsp_us tsp_us` |
| Imperial volume | `gal_imp qt_imp pt_imp floz_imp` |
| Mass | `lb oz grain oz_troy lb_troy tonne ton_us ton_imp carat` |
| Atomic mass (separate component) | `Da kDa MDa GDa` |
| Force / pressure | `dyn kgf lbf bar mbar atm Torr psi Ba` |
| Energy / power | `erg cal_th cal_IT kcal_th kcal_IT Btu_IT ft_lbf Wh kWh MWh hp_mech hp_metric Btu_IT_per_h` |
| Charge / magnetism | `Ah mAh e_charge gauss Mx` |
| Radiation / catalytic activity | `Ci radiation_rad rem enzyme_unit` |
| Angle | `degree arcmin arcsec turn gradian`; independent of the `rad` family |
| Temperature intervals | `degC degF degR mdegC udegC mdegF udegF temperature_quantum` |
| Information | `bit B`; decimal `k M G T P E Z Y R Q` + `bit` or `B`; binary `Ki Mi Gi Ti Pi Ei Zi Yi Ri Qi` + `bit` or `B` |
| Dimensionless fractions | `one pct permille bp ppm ppb` |

`oz` is avoirdupois mass; `floz_us` / `floz_imp` are different volumes.
`ton_us` is 2,000 lb; `ton_imp` is 2,240 lb; `tonne` is 1,000 kg. All
customary lengths use the international foot, never the retired US survey
foot. US measures here are liquid measures, including a customary cup
of exactly 8 US fluid ounces: 236.5882365 mL. They are not
US nutrition-label or metric cooking measures. `cal_th` and `cal_IT`,
`hp_mech` and `hp_metric` deliberately keep distinct names.

Compound spellings are **named unit components** with their own exact scale
conversions:

| Component | Symbols |
|---|---|
| Speed | `m_per_s cm_per_s mm_per_s um_per_s km_per_h m_per_h mi_per_h knot ft_per_s` |
| Acceleration | `m_per_s2 mm_per_s2 um_per_s2 ft_per_s2 g0 Gal` |
| Dynamic viscosity | `Pa_s mPa_s P cP` |
| Kinematic viscosity | `m2_per_s mm2_per_s St cSt` |
| Surface tension | `N_per_m mN_per_m dyn_per_cm` |
| Volume flow | `m3_per_s L_per_s L_per_min mL_per_min gal_us_per_min` |
| Mass flow | `kg_per_s g_per_s kg_per_h g_per_min` |
| Torque | `N_m mN_m lbf_ft` |
| Amount concentration | `mol_per_m3 mmol_per_m3 mol_per_L mmol_per_L umol_per_L nmol_per_L mol_per_mL mmol_per_mL umol_per_mL` |
| Density / mass concentration | `kg_per_m3 g_per_m3 g_per_L mg_per_L ug_per_L mg_per_mL g_per_cm3 lb_per_ft3` |
| Molality | `mol_per_kg mmol_per_kg umol_per_kg mol_per_g mmol_per_g umol_per_g` |
| Molar mass | `kg_per_mol g_per_mol mg_per_mol kg_per_kmol` |
| Molar volume | `m3_per_mol L_per_mol mL_per_mol m3_per_kmol` |
| Molar energy | `J_per_mol kJ_per_mol cal_th_per_mol` |
| Heat capacity | `J_per_K kJ_per_K` |
| Specific heat | `J_per_kg_K kJ_per_kg_K J_per_g_K cal_th_per_g_K` |
| Molar heat capacity | `J_per_mol_K kJ_per_mol_K cal_th_per_mol_K` |
| Thermal conductivity | `W_per_m_K mW_per_m_K W_per_cm_K` |
| Electrical conductivity | `S_per_m mS_per_cm uS_per_cm` |
| Wavenumber | `per_m per_cm` |

Concentration's volume is mixture volume; molality's mass is solvent mass.
`entity` is the amount of substance of one **specified elementary entity**,
linked to `mol` through the exact Avogadro constant. It is not a molar-mass
conversion. `ppm` and `ppb` are plain dimensionless fractions: the application
must identify whether a fraction is by mass, amount or volume. They do not
convert to `mg_per_L` automatically.

## Exact graphs, finite integers

Every equation is exact, including electronvolt-to-joule and elementary
charge-to-coulomb under the revised SI. Irrational or measured relationships
are not approximated into the graph. `degree` and `rad` remain disconnected;
`Da` and `g` remain disconnected. Energy and torque, and absorbed and equivalent
dose, are deliberately different quantities even where dimensions coincide.

An exact graph does not imply unlimited numerical headroom. Every value is a
signed 64-bit `Int`. A smaller counting unit gives less maximum range. Choosing
`Length in um` gives roughly ±9.22 trillion metres; `Length in pm` gives about
±9,223 km. A graph may contain quecto and quetta nodes while an expression
cannot span both. A whole literal is first counted in its principal quantity,
so a coarse boundary annotation does not rescue an overflowing literal.

The compiler refuses `1Qm` with the optional `Length`, `1EiB` with its
bit-counted `Information`, and `1Ts` with the stdlib's nanosecond `Duration`.
It also refuses the exact common denomination needed by `1eV < 1J`.
Choose the principal denomination for the workload, or explicitly narrow at a
boundary; do not assume a conversion or comparison across all catalogue scales
will fit. Use `hale check <app> --units` to inspect denominations and headroom.

No type in the optional seed carries a rounding policy. Loss must be named at
the call site (`.in(unit) or half_even`, `or floor`, a substitute or a handler),
or in an application boundary type. This includes rounding an eV value into
the optional nJ-counted `Energy`.

## Deliberately outside this library

- **Derived-dimension algebra:** `1N * 1m` does not produce `J` or `N_m`;
  `1m / 1s` does not produce `m_per_s`. Independently named compounds support
  conversions within their own component only.
- **Float quantities, custom rounding functions, packed widths:** deferred by
  the language. Quantity ranges are not used as a substitute for runtime
  physical validation; temperature points have no absolute-zero guarantee.
- **Irrational conversions:** radians/degrees, steradians/square degrees,
  parsecs/metres and oersteds/ampere-per-metre need more than exact rationals.
- **Measured constants:** no fixed Da/kg conversion, material densities or
  substance-specific molar masses. A future approximate-physics library must
  state uncertainty and its numerical representation.
- **Nonlinear quantities:** pH, decibels, nepers and reciprocal fuel economy.
- **Calendars and conditions:** months, calendar years, zones, standard gas
  volumes without declared temperature/pressure, and amount-to-mass or
  mass-fraction-to-concentration conversions without composition/density.

These are boundaries of this catalogue, not suggestions to edit the compiler.
See [Hale's unit specification](https://hale-lang.org/docs/spec/units/) and
the [design discussion](https://github.com/hale-lang/hale/issues/1076).

## Verification

From the Pond repository root, with a compiler containing the unit dialect:

```sh
hale check units/
hale check units/quantities/
python3 units/tests/generate_golden.py --check
python3 units/tests/test_golden_verifier.py
hale test units/
python3 units/tests/run_rejections.py
hale build units/examples/catalogue-demo/
./units/examples/catalogue-demo/catalogue-demo
hale build units/examples/quantities-demo/
./units/examples/quantities-demo/quantities-demo
hale fmt --check units/
```

The rejection runner accepts `HALE_BIN` or `--hale` for a pinned compiler;
the golden generator uses Python only and never invokes Hale. The independent
[golden corpus](tests/golden.json) records sourced
expected ratios, not ratios extracted from the implementation. Its generator
checks those relationships against the actual unit graph with exact rational
arithmetic and emits native Hale tests. Graph-only cases explicitly identify
the compiler's integer headroom limit; they are not counted as native passes.
Behavior tests exercise signed rounding and residues. Negative fixtures must
be rejected by both `check` and `build` for the intended reason. See
[tests/README.md](tests/README.md) for counts and reproduction commands.

## Sources

- [BIPM SI Brochure](https://www.bipm.org/en/publications/si-brochure/) and
  [SI prefixes](https://www.bipm.org/en/measurement-units/si-prefixes): SI units,
  exact prefix scales and accepted non-SI units.
- [BIPM defining constants](https://www.bipm.org/en/measurement-units/si-defining-constants)
  and [mole](https://www.bipm.org/en/si-base-units/mole): exact `eV`, `e_charge`
  and `entity` relationships. Pre-2019 eV uncertainty tables do not apply.
- [NIST revised customary factors](https://www.nist.gov/pml/us-surveyfoot/revised-unit-conversion-factors):
  international length, area and volume definitions, replacing survey-foot
  interpretations of acre and acre-foot.
- [NIST SP 811 conversion footnotes](https://www.nist.gov/pml/special-publication-811/nist-guide-si-footnotes)
  and [Appendix B.8](https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b8):
  customary, CGS, calorie/BTU, temperature and engineering conversions. Exact
  definitions are used, not rounded display-table coefficients.
- [IUPAC amount concentration](https://goldbook.iupac.org/terms/view/A00295)
  and [molality](https://goldbook.iupac.org/terms/view/M03970): chemistry meanings.
- [IEC binary prefixes](https://www.iec.ch/prefixes-binary-multiples) and
  [BIPM's 2025 record of IEC 80000-13:2025](https://www.bipm.org/documents/20126/17315032/CIPM2025-Session-III-EN.pdf/c2faa8e4-12d3-29b8-6dde-dbc6214522eb?download=true&t=1770712187621&version=1.0):
  binary multiples through robi and quebi. A byte here is exactly eight bits.
