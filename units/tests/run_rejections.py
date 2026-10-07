#!/usr/bin/env python3
"""Require each unsupported unit operation to fail for its intended reason.

Run with HALE_BIN=/path/to/hale python3 units/tests/run_rejections.py,
or pass --hale. Both check and native build must reject every fixture.
Build outputs are confined to an automatically removed temporary directory.
"""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


EXPECTED = {
    "atomic_mass_conversion": ("`g` is not a unit of", "AtomicMass"),
    "builtin_time_duplicate": (
        "unit `ns` is declared twice",
        "stdlib's time catalogue",
    ),
    "catalogue_needs_quantity": ("the units of `m` have no quantity",),
    "conversion_headroom": ("`1J`", "overflows an `Int`"),
    "dimensional_product": (
        "a product of two quantities is a quantity only when one is dimensionless",
    ),
    "dimensional_quotient": (
        "a quotient of two quantities is a count only within one quantity",
    ),
    "duplicate_principal": (
        "already have their quantity",
        "a component of the catalogue has one quantity",
    ),
    "duplicate_unit": ("unit `m` is declared twice",),
    "float_quantity": ("a quantity counts an `Int`, and `Float` is not one",),
    "irrational_angle_conversion": ("`rad` is not a unit of", "DegreeAngle"),
    "information_headroom": ("`1EiB`", "overflows an `Int`"),
    "literal_headroom": ("`1Qm`", "overflows an `Int`"),
    "missing_rounding": ("divides by 1,000", "say what happens to the remainder"),
    "point_addition": ("two points do not add",),
    "time_headroom": ("`1Ts`", "`Duration`", "overflows an `Int`"),
    "unrelated_sum": ("different quantities", "`+` holds within one"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hale", default=os.environ.get("HALE_BIN", "hale"))
    parser.add_argument("--timeout", type=float, default=60,
                        help="maximum seconds per compiler invocation (default: 60)")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    compiler = shutil.which(args.hale)
    if compiler is None:
        parser.error("Hale compiler not found: " + args.hale)

    root = Path(__file__).resolve().parent / "rejections"
    discovered = {path.name for path in root.iterdir() if path.is_dir()}
    if discovered != set(EXPECTED):
        parser.error("fixture directories disagree with EXPECTED: " +
                     repr(sorted(discovered.symmetric_difference(EXPECTED))))

    failures = []
    with tempfile.TemporaryDirectory(prefix="pond-units-rejections-") as scratch:
        for name, fragments in sorted(EXPECTED.items()):
            case_failures = []
            for verb in ("check", "build"):
                command = [compiler, verb, str(root / name)]
                output = Path(scratch) / name
                if verb == "build":
                    command.extend(["--dev", "-o", str(output)])
                try:
                    result = subprocess.run(
                        command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        universal_newlines=True, timeout=args.timeout,
                    )
                except (OSError, subprocess.TimeoutExpired) as error:
                    case_failures.append("{} {}: {}".format(name, verb, error))
                    continue
                missing = [fragment for fragment in fragments if fragment not in result.stdout]
                if result.returncode <= 0 or missing or "type error:" not in result.stdout:
                    case_failures.append(
                        "{} {}: expected a type rejection containing {}; exit={}\n{}".format(
                            name, verb, repr(fragments), result.returncode, result.stdout,
                        )
                    )
                if output.exists():
                    case_failures.append("{} {}: rejected program emitted a binary".format(name, verb))
            failures.extend(case_failures)
            if not case_failures:
                print("ok {} (check, build)".format(name))

    if failures:
        for failure in failures:
            print("FAIL " + failure)
        print("{} failed compiler checks".format(len(failures)))
        return 1
    print("{} rejection fixtures passed ({} compiler invocations)".format(
        len(EXPECTED), 2 * len(EXPECTED),
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
