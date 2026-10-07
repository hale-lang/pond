#!/usr/bin/env python3
"""Regression checks for the golden verifier's independent scale coverage.

Run with `python3 units/tests/test_golden_verifier.py`. All mutations happen in
temporary copies; neither the real catalogue nor the static oracle is edited.
"""

import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile
import unittest


TESTS = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("golden_verifier", TESTS / "generate_golden.py")
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class GoldenConnectivityTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="pond-golden-")
        self.units = Path(self.scratch.name) / "units"
        tests = self.units / "tests"
        tests.mkdir(parents=True)
        for source in TESTS.parent.glob("*.hl"):
            shutil.copyfile(str(source), str(self.units / source.name))
        shutil.copyfile(str(TESTS / "golden.json"), str(tests / "golden.json"))
        self.original_root = VERIFIER.ROOT
        VERIFIER.ROOT = tests
        self.data = VERIFIER.fixture()

    def tearDown(self):
        VERIFIER.ROOT = self.original_root
        self.scratch.cleanup()

    def remove_relation(self, group_name, case_id):
        group = next(group for group in self.data["groups"] if group["name"] == group_name)
        old_count = len(group["cases"])
        group["cases"] = [case for case in group["cases"] if case["id"] != case_id]
        self.assertEqual(len(group["cases"]), old_count - 1)

    def shift_density_subgroup(self):
        path = self.units / "chemistry.hl"
        text = path.read_text()
        changes = {
            "unit g_per_m3 = 1 / 1000 kg_per_m3;": "unit g_per_m3 = 1 / 100 kg_per_m3;",
            "unit ug_per_L = 1 / 1000 mg_per_L;": "unit ug_per_L = 1 / 10000 mg_per_L;",
        }
        for original, mutated in changes.items():
            self.assertEqual(text.count(original), 1)
            text = text.replace(original, mutated)
        path.write_text(text)

    def test_complete_oracle_connects_every_actual_component(self):
        count, units = VERIFIER.verify_graph(self.data)
        self.assertEqual(count, sum(len(group["cases"]) for group in self.data["groups"]))
        self.assertEqual(units, len(VERIFIER.implementation_graph()))

    def test_covered_area_units_still_require_an_independent_scale_bridge(self):
        # Every area symbol remains mentioned in true relations. Their expected
        # graph must still tie hectares/acres/square miles to square metres.
        self.remove_relation("area", "ha_to_m2")
        with self.assertRaisesRegex(ValueError, "expected relations are not connected"):
            VERIFIER.verify_graph(self.data)

    def test_coordinated_density_mutation_fails_the_independent_bridge(self):
        # Previously this tenfold shift of g/m3 and mg/L preserved every golden
        # ratio because a compensating ug/L edge hid the disconnected subgroup.
        self.shift_density_subgroup()
        with self.assertRaisesRegex(ValueError, "density/kg_per_m3_to_g_per_m3: expected"):
            VERIFIER.verify_graph(self.data)

    def test_connectivity_rejects_the_mutation_even_if_the_bridge_is_removed(self):
        self.shift_density_subgroup()
        self.remove_relation("density", "kg_per_m3_to_g_per_m3")
        with self.assertRaisesRegex(ValueError, "expected relations are not connected"):
            VERIFIER.verify_graph(self.data)


if __name__ == "__main__":
    unittest.main()
