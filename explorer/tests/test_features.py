"""Decoding of BOLT 9 feature bits into names, badges, and filter flags."""

import unittest

from explorer.features import (
    bits_from_bytes,
    bits_from_hex,
    bits_from_mempool,
    describe,
    has,
)


class FeatureDecodeTest(unittest.TestCase):
    def test_names_and_required_flag(self):
        rows = {row["bit"]: row for row in describe([8, 19, 3, 99])}
        self.assertEqual(rows[8]["name"], "var_onion_optin")
        self.assertFalse(rows[8]["required"])
        self.assertEqual(rows[19]["name"], "option_support_large_channel")
        self.assertTrue(rows[19]["required"])
        self.assertEqual(rows[3]["name"], "initial_routing_sync")
        # Unknown bits are still shown, as "bit N"; odd bits stay mandatory.
        self.assertEqual(rows[99]["name"], "bit 99")
        self.assertTrue(rows[99]["required"])

    def test_wumbo_from_either_bit(self):
        self.assertTrue(has([18], "wumbo"))
        self.assertTrue(has([19], "wumbo"))
        self.assertFalse(has([20], "wumbo"))
        self.assertFalse(has([], "wumbo"))

    def test_anchors_covers_both_anchor_kinds(self):
        self.assertTrue(has([20], "anchors"))
        self.assertTrue(has([23], "anchors"))
        self.assertFalse(has([24], "anchors"))

    def test_filter_flags(self):
        bits = [18, 28, 38, 24]
        self.assertTrue(has(bits, "dual_fund"))
        self.assertTrue(has(bits, "onion_messages"))
        self.assertTrue(has(bits, "route_blinding"))
        self.assertFalse(has(bits, "anchors"))

    def test_bits_from_bytes_and_hex(self):
        # BOLT 9 numbering: bit 0 is the MSB of the first byte, bit 8 the
        # MSB of the second (so 0x0080 is var_onion, 0x8001 is bits 0 and 15).
        self.assertEqual(bits_from_bytes(bytes([0x00, 0x80])), [8])
        self.assertEqual(bits_from_bytes(bytes([0x80, 0x01])), [0, 15])
        self.assertEqual(bits_from_bytes(b""), [])
        self.assertEqual(bits_from_hex("0080"), [8])
        self.assertEqual(bits_from_hex("nothex"), [])
        self.assertEqual(bits_from_hex(""), [])

    def test_mempool_profile_shapes(self):
        listed = {"features": [
            {"bit": 18, "name": "option_support_large_channel", "is_known": True, "is_required": False},
            {"bit": 8},
        ]}
        self.assertEqual(bits_from_mempool(listed), [8, 18])
        self.assertEqual(bits_from_mempool({"features": "0080"}), [8])
        self.assertEqual(bits_from_mempool({"featuresBits": "0080"}), [8])
        self.assertEqual(bits_from_mempool({"features": []}), [])
        self.assertEqual(bits_from_mempool({"alias": "x"}), [])
        self.assertEqual(bits_from_mempool("junk"), [])
        # A junk features list never falls through to a missing hex field.
        self.assertEqual(bits_from_mempool({"features": [{"no_bit": 1}]}), [])

    def test_describe_deduplicates_and_sorts(self):
        rows = describe([19, 18, 18])
        self.assertEqual([row["bit"] for row in rows], [18, 19])


if __name__ == "__main__":
    unittest.main()
