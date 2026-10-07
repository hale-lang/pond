# Optional quantity types

Import `vendor/pond/units/quantities` as `q` to get the catalogue and
53 principal quantity types plus four temperature point types. Import the
parent `units` seed alone if your application needs to choose the principal
denominations itself. A direct import of both seeds is supported and does
not duplicate their declarations.

```hale
import "vendor/pond/units/quantities" as q;

fn main() {
    let width: q::Length = 1inch;
    let charge: q::Charge = 2500mAh;
    println(width, " ", charge.in(C) or floor);
}
```

Each type counts a signed `Int` in the denomination below. These are practical
precision choices, not a promise that all catalogue scales fit at once. There
are no default rounding policies and no range checks for physical validity.
All types permit negative quantities where the language permits the arithmetic.

| Quantity | One integer count |
|---|---|
| `Length` | `um` |
| `Mass` | `ug` |
| `Current` | `uA` |
| `TemperatureDelta` | `temperature_quantum` |
| `Amount` | `nmol` |
| `LuminousIntensity` | `ucd` |
| `Frequency` | `mHz` |
| `Force` | `uN` |
| `Pressure` | `mPa` |
| `Energy` | `nJ` |
| `Power` | `uW` |
| `Charge` | `nC` |
| `Voltage` | `uV` |
| `Capacitance` | `pF` |
| `Resistance` | `uohm` |
| `Conductance` | `nS` |
| `MagneticFlux` | `pWb` |
| `MagneticFluxDensity` | `nT` |
| `Inductance` | `nH` |
| `LuminousFlux` | `ulm` |
| `Illuminance` | `ulx` |
| `Activity` | `mBq` |
| `AbsorbedDose` | `nGy` |
| `EquivalentDose` | `nSv` |
| `CatalyticActivity` | `pkat` |
| `RadianAngle` | `urad` |
| `SolidAngle` | `usr` |
| `Area` | `mm2` |
| `Volume` | `uL` |
| `DegreeAngle` | `arcsec` |
| `AtomicMass` | `Da` |
| `Speed` | `mm_per_s` |
| `Acceleration` | `um_per_s2` |
| `DynamicViscosity` | `mPa_s` |
| `KinematicViscosity` | `mm2_per_s` |
| `SurfaceTension` | `mN_per_m` |
| `VolumeFlow` | `mL_per_min` |
| `MassFlow` | `g_per_min` |
| `Torque` | `mN_m` |
| `Concentration` | `umol_per_L` |
| `Density` | `ug_per_L` |
| `Molality` | `umol_per_kg` |
| `MolarMass` | `mg_per_mol` |
| `MolarVolume` | `mL_per_mol` |
| `MolarEnergy` | `J_per_mol` |
| `HeatCapacity` | `J_per_K` |
| `SpecificHeat` | `J_per_kg_K` |
| `MolarHeatCapacity` | `J_per_mol_K` |
| `ThermalConductivity` | `mW_per_m_K` |
| `Conductivity` | `uS_per_cm` |
| `Wavenumber` | `per_m` |
| `Information` | `bit` |
| `Ratio` | `ppb` |

`Duration` and `Time` remain the stdlib's types in nanoseconds; this seed
does not replace them. `Ratio` is a dimensionless numeric fraction. `Density`
can describe mass density or mass concentration but does not track the identity
of the material or the fraction basis. `AtomicMass` counts daltons and cannot
convert to `Mass` through an exact edge.

## Application boundaries

Refine an imported quantity to name your storage boundary:

```hale
import "vendor/pond/units/quantities" as q;
type WholeMetres = q::Length in m { round: half_even; }

fn main() {
    let sample: q::Length = 2500mm;
    let report: WholeMetres = sample;      // 2 metres, nearest even
    let exact_mm = sample.in(mm) or 0;     // explicit policy at the site
    println(report, " ", exact_mm);
}
```

Do not redeclare `type FineLength = quantity Int in nm;` after importing this
seed: the component already has its principal quantity. Write
`type FineLength = q::Length in nm;`. A refinement provides a different storage
denomination; it does not change the principal quantity's literal-counting
rule or remove `Int` headroom limits.

At the verified compiler revision, **qualified imported scalar constructors**
are incomplete: `q::Speed(x) or half_even` does not recognize the policy, and
`q::Celsius(x)` typechecks but fails native lowering. Use `x.in(m_per_s) or half_even` for
conversion and a local scalar refinement for point construction. A plain alias
alone does not fix point construction. These are reproduced in Pond's
`COMPILER-BUGS.md`; the tests exercise the supported forms.

## Temperature intervals and points

`degC`, `degF` and `degR` are **intervals**. `TemperatureDelta` counts
`temperature_quantum = 1 / 9_000_000 K`, the exact common increment for
microkelvin and microdegree-Fahrenheit. Its magnitude range is about
±1.0248 trillion K. This unusual denominator avoids rounding either scale's
microdegree steps or either origin.

The point types are `Kelvin`, `Celsius`, `Fahrenheit` and `Rankine`.
Kelvin and Rankine share absolute zero; Celsius has origin 273.15 K;
Fahrenheit has origin 459.67 Fahrenheit intervals above absolute zero.
Every point retains `temperature_quantum` as its representation; its name
alone does not change its printed count or denomination.

```hale
import "vendor/pond/units/quantities" as q;

type Celsius = q::Celsius in temperature_quantum;
type Fahrenheit = q::Fahrenheit in temperature_quantum;
type Kelvin = q::Kelvin in temperature_quantum;

fn main() {
    let room = Celsius(25degC);            // point, 25 degrees above Celsius zero
    let freeze = Celsius(0degC);
    let rise = Fahrenheit(room) - Fahrenheit(freeze);
    println(rise.in(degF) or floor);       // 45degF interval
    let absolute = Kelvin(room) - Kelvin(0K);
    println(absolute.in(mK) or floor);     // 298150mK above absolute zero
}
```

Adding two points is invalid. Subtracting two points in the same frame returns
an interval; explicitly convert the point before mixing frames. Negative
Celsius readings are valid, and negative Kelvin readings are not rejected by
these types: physical bounds require application validation. We deliberately
do not rely on the deferred quantity-range conversion checks.

## Verification

From the Pond root:

```sh
hale check units/quantities/
hale test units/quantities/
hale build units/examples/quantities-demo/
./units/examples/quantities-demo/quantities-demo
```

The native test gives every one of the 53 imported quantity types at least one
typed known conversion and checks all four temperature points. The parent
library's golden corpus tests the units independently of these defaults.
