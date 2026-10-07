#!/usr/bin/env python3
"""Verify the exact unit graph against a static oracle and render native tests.

Expected ratios come only from golden.json. The small declaration reader below
reads the implementation as the system under test, never as an expectation
source. It deliberately accepts only the unit-only catalogue's rational grammar.

    python3 units/tests/generate_golden.py          # verify and regenerate
    python3 units/tests/generate_golden.py --check  # verify and reject stale files
    python3 units/tests/generate_golden.py --verify # verify the graph only

Run generated *_test.hl files with `hale test units/tests` for independent native
compiler/runtime coverage. Graph-only cases are reported separately; they are
never represented as passing native tests.
"""

import argparse
from fractions import Fraction
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent
I64_MAX = 2**63 - 1
NAME = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*$")
DECLARATION = re.compile(r"unit\s+([A-Za-z_][A-Za-z_0-9]*)(?:\s*=\s*([^;]+))?\s*;")
RATIONAL = re.compile(r"(\d[\d_]*)(?:\s*/\s*(\d[\d_]*))?(?:\s+([A-Za-z_][A-Za-z_0-9]*))?\Z")


def fixture():
    data = json.loads((ROOT / "golden.json").read_text())
    if data["schema_version"] != 1:
        raise ValueError("unsupported golden fixture schema")
    group_names = set()
    for group in data["groups"]:
        name = group["name"]
        if not NAME.fullmatch(name) or name in group_names:
            raise ValueError(f"invalid or duplicate group: {name}")
        group_names.add(name)
        ids = set()
        for case in group["cases"]:
            label = f"{name}/{case['id']}"
            if case["id"] in ids:
                raise ValueError(f"duplicate case: {label}")
            ids.add(case["id"])
            if case["source"] not in data["sources"]:
                raise ValueError(f"unknown source: {label}")
            for side in ("left", "right"):
                value = case[side]
                if not NAME.fullmatch(value["unit"]) or not value["count"].isdigit() or int(value["count"]) < 1:
                    raise ValueError(f"invalid positive count/unit: {label}")
            if not case["native"] and not case.get("reason"):
                raise ValueError(f"graph-only case needs a reason: {label}")
            if case["native"]:
                a, b = int(case["left"]["count"]), int(case["right"]["count"])
                if max(a, b) > I64_MAX:
                    raise ValueError(f"native literal exceeds i64: {label}")
                if case["strategy"] == "runtime" and a * b * 3 > I64_MAX:
                    raise ValueError(f"native common denomination lacks multiplier headroom: {label}")
                if case["strategy"] not in ("runtime", "literal"):
                    raise ValueError(f"unknown native strategy: {label}")
            bridge = case.get("native_comparison_unit")
            if bridge and (not NAME.fullmatch(bridge) or not case.get("native_note")):
                raise ValueError(f"comparison bridge needs a unit and explanation: {label}")
    return data


def implementation_graph():
    # The shipped Hale stdlib time definitions are an explicit external baseline.
    # Read no compiler output, optional quantity file, or catalogue.json inventory.
    definitions = {
        "ns": (Fraction(1), None, "@stdlib-time"),
        "us": (Fraction(1000), "ns", "stdlib baseline"),
        "ms": (Fraction(1000), "us", "stdlib baseline"),
        "s": (Fraction(1000), "ms", "stdlib baseline"),
        "min": (Fraction(60), "s", "stdlib baseline"),
        "h": (Fraction(60), "min", "stdlib baseline"),
        "day": (Fraction(24), "h", "stdlib baseline"),
    }
    for path in sorted(ROOT.parent.glob("*.hl")):
        text = re.sub(r"//[^\n]*", "", path.read_text())
        cursor = 0
        for match in DECLARATION.finditer(text):
            if text[cursor:match.start()].strip():
                raise ValueError(f"unsupported syntax in unit-only catalogue {path.name}")
            cursor = match.end()
            name, expression = match.groups()
            if name in definitions:
                raise ValueError(f"duplicate unit or stdlib redeclaration: {name}")
            if expression is None:
                definitions[name] = (Fraction(1), None, name)
                continue
            rational = RATIONAL.fullmatch(expression.strip())
            if not rational:
                raise ValueError(f"unsupported rational declaration: {path.name}: {match.group(0)}")
            numerator, denominator, target = rational.groups()
            factor = Fraction(int(numerator.replace("_", "")), int((denominator or "1").replace("_", "")))
            if factor <= 0:
                raise ValueError(f"nonpositive factor: {name}")
            definitions[name] = (factor, target, "@dimensionless" if target is None else path.name)
        if text[cursor:].strip():
            raise ValueError(f"unsupported syntax at end of {path.name}")
    cache = {}

    def resolve(name, active=()):
        if name in cache:
            return cache[name]
        if name not in definitions:
            raise ValueError(f"unknown unit in actual graph: {name}")
        if name in active:
            raise ValueError(f"cycle in actual graph: {' -> '.join(active + (name,))}")
        factor, target, origin = definitions[name]
        if target is None:
            result = (origin, factor)
        else:
            component, parent_scale = resolve(target, active + (name,))
            result = (component, factor * parent_scale)
        cache[name] = result
        return result

    # Resolve even untested declarations to catch typos, missing targets or cycles.
    for name in definitions:
        resolve(name)
    return cache


def verify_graph(data):
    graph = implementation_graph()
    failures = []
    total = 0
    covered = set()
    # Seeing every symbol is insufficient: a disconnected group of expected
    # relations could float to a different scale without changing any of its
    # internal ratios. Every actual component needs a connected expected graph.
    relation_parent = {unit: unit for unit in graph}

    def representative(unit):
        while relation_parent[unit] != unit:
            relation_parent[unit] = relation_parent[relation_parent[unit]]
            unit = relation_parent[unit]
        return unit

    def connect(left, right):
        relation_parent[representative(right)] = representative(left)

    for group in data["groups"]:
        for case in group["cases"]:
            total += 1
            left, right = case["left"], case["right"]
            covered.update((left["unit"], right["unit"]))
            try:
                lc, ls = graph[left["unit"]]
                rc, rs = graph[right["unit"]]
            except KeyError as error:
                failures.append(f"{group['name']}/{case['id']}: absent actual unit {error.args[0]}")
                continue
            connect(left["unit"], right["unit"])
            expected = Fraction(int(right["count"]), int(left["count"]))
            if lc != rc:
                failures.append(f"{group['name']}/{case['id']}: units belong to different actual components")
            elif ls / rs != expected:
                failures.append(f"{group['name']}/{case['id']}: expected {left['unit']}/{right['unit']} = {expected}, actual {ls / rs}")
    missing = set(graph) - covered
    if missing:
        failures.append("actual units without an independent golden relation: " + ", ".join(sorted(missing)))
    components = {}
    for unit, (component, _) in graph.items():
        components.setdefault(component, {}).setdefault(representative(unit), []).append(unit)
    for component, partitions in sorted(components.items()):
        if len(partitions) > 1:
            examples = "; ".join(", ".join(sorted(units)[:4]) for units in partitions.values())
            failures.append(f"expected relations are not connected within actual component {component}: {len(partitions)} separate groups ({examples})")
    if failures:
        raise ValueError("golden graph mismatch:\n" + "\n".join(failures))
    return total, len(graph)


def literal(side, negative=False):
    return ("-" if negative else "") + side["count"] + side["unit"]


def render(group):
    native = [case for case in group["cases"] if case["native"]]
    runtime = [case for case in native if case["strategy"] == "runtime"]
    folded = [case for case in native if case["strategy"] == "literal"]
    units = sorted({case[side]["unit"] for case in native for side in ("left", "right")})
    aliases = {unit: f"Denomination{i}" for i, unit in enumerate(units)}
    quantity = group.get("quantity", "GoldenQuantity")
    lines = [
        "// Generated from independent golden.json by generate_golden.py; do not edit.",
        f"// {group['name']}: {len(runtime)} runtime ratios, {len(folded)} literal-conversion ratios.",
        "// Each runtime ratio checks signed multiples 1, -1 and 3 in both directions.",
        "// Source references and graph-only limitations are recorded in golden.json.",
        '', 'import ".." as units;', '',
    ]
    if group["principal"]:
        lines += [f"type {quantity} = quantity Int in {group['principal']};", ""]
    lines += [f"type {alias} = {quantity} in {unit};" for unit, alias in aliases.items()]
    lines += [""]
    if runtime:
        lines += ["fn check_runtime(k: Int) {"]
        for index, case in enumerate(runtime):
            left, right = case["left"], case["right"]
            label = f"{group['name']}/{case['id']}"
            bridge = case.get("native_comparison_unit")
            left_expression = f"(k * source_{index}).in({bridge})" if bridge else f"k * source_{index}"
            right_expression = f"(k * target_{index}).in({bridge})" if bridge else f"k * target_{index}"
            if bridge:
                lines += [f"    // {case['native_note']}"]
            lines += [
                f"    // {left['count']} {left['unit']} = {right['count']} {right['unit']}",
                f"    let source_{index}: {aliases[left['unit']]} = {literal(left)};",
                f"    let target_{index}: {aliases[right['unit']]} = {literal(right)};",
                f"    let left_{index} = {left_expression};",
                f"    let right_{index} = {right_expression};",
                f'    std::test::assert(left_{index} == right_{index}, "{label}: forward");',
                f'    std::test::assert(right_{index} == left_{index}, "{label}: reverse");',
            ]
            if quantity == "Duration":
                # Duration is a distinct backend class. Typed divisors keep both
                # operands in that class; a raw quantity literal can lower as Int.
                lines += [
                    f"    let source_unit_{index}: {aliases[left['unit']]} = 1{left['unit']};",
                    f"    let target_unit_{index}: {aliases[right['unit']]} = 1{right['unit']};",
                    f'    std::test::assert_eq_int(left_{index} / target_unit_{index}, k * {right["count"]}, "{label}: target count");',
                    f'    std::test::assert_eq_int(right_{index} / source_unit_{index}, k * {left["count"]}, "{label}: source count");',
                ]
            else:
                lines += [
                    f'    std::test::assert_eq_int(left_{index} / 1{right["unit"]}, k * {right["count"]}, "{label}: target count");',
                    f'    std::test::assert_eq_int(right_{index} / 1{left["unit"]}, k * {left["count"]}, "{label}: source count");',
                ]
            lines += [""]
        lines += ["}", ""]
    lines += ["fn main() {"]
    if runtime:
        lines += ["    check_runtime(1);", "    check_runtime(-1);", "    check_runtime(3);"]
    for index, case in enumerate(folded):
        left, right = case["left"], case["right"]
        label = f"{group['name']}/{case['id']}"
        lines += ["", f"    // {case['reason']}"]
        for direction, source, target in [("forward", left, right), ("reverse", right, left)]:
            for sign, negative in [("positive", False), ("negative", True)]:
                suffix = f"{index}_{direction}_{sign}"
                # Unary minus currently loses Hale's exact-literal narrowing
                # proof. Negate the already-converted value for these oversized
                # ratios; runtime cases above test signed conversions directly.
                actual = f"-actual_{index}_{direction}_positive" if negative else literal(source)
                expected = f"-expected_{index}_{direction}_positive" if negative else literal(target)
                lines += [
                    f"    let actual_{suffix}: {aliases[target['unit']]} = {actual};",
                    f"    let expected_{suffix}: {aliases[target['unit']]} = {expected};",
                    f'    std::test::assert(actual_{suffix} == expected_{suffix}, "{label}: literal {direction} {sign}");',
                ]
    lines += ["}", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="reject stale generated tests and verify every graph ratio")
    parser.add_argument("--verify", action="store_true", help="verify the implementation graph only")
    args = parser.parse_args()
    data = fixture()
    count, unit_count = verify_graph(data)
    native = sum(case["native"] for group in data["groups"] for case in group["cases"])
    runtime = sum(case.get("strategy") == "runtime" for group in data["groups"] for case in group["cases"])
    expected = {ROOT / f"golden_{group['name']}_test.hl": render(group) for group in data["groups"] if any(case["native"] for case in group["cases"])}
    if not args.verify:
        stale = []
        for path, content in expected.items():
            if args.check:
                if not path.exists() or path.read_text() != content:
                    stale.append(path.name)
            else:
                path.write_text(content)
        extras = set(ROOT.glob("golden_*_test.hl")) - set(expected)
        if extras:
            stale.extend(path.name for path in sorted(extras))
        if stale:
            raise ValueError("stale generated golden files: " + ", ".join(stale) + "; run generate_golden.py")
    print(f"Verified {count} independent exact graph ratios across {unit_count} units; {native} native ratios ({runtime} runtime, {native-runtime} literal-conversion), {count-native} graph-only; {len(expected)} generated test files.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError) as error:
        print(f"golden verification failed: {error}", file=sys.stderr)
        sys.exit(1)
