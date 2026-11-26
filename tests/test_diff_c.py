import unittest
from unittest.mock import patch

from python.bo.machine import Machine
from tests.diff_c import collect


class DifferentialCollection(unittest.TestCase):
    def test_collection_records_word_execution_and_restores_execute(self):
        class PassingCase(unittest.TestCase):
            def runTest(self):
                self.assertTrue(Machine().execute('"include/core.bo" () INCLUDE (OP) unittype'))

        original = Machine.execute
        suite = unittest.TestSuite([PassingCase()])
        with patch.object(unittest.defaultTestLoader, "discover", return_value=suite):
            self.assertEqual(collect(), ['"include/core.bo" () INCLUDE (OP) unittype'])
        self.assertIs(Machine.execute, original)

    def test_collection_reports_test_failures_and_restores_execute(self):
        class FailingCase(unittest.TestCase):
            def runTest(self):
                self.fail("collection sentinel")

        original = Machine.execute
        suite = unittest.TestSuite([FailingCase()])
        with patch.object(unittest.defaultTestLoader, "discover", return_value=suite):
            with self.assertRaisesRegex(RuntimeError, "collection sentinel"):
                collect()
        self.assertIs(Machine.execute, original)
