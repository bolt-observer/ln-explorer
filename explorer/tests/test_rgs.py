"""Snapshots borrowed from lightning-rapid-gossip-sync's own tests."""

import unittest

from explorer.rgs import format_scid, parse_scid, parse_snapshot

# lightning-rapid-gossip-sync/src/processing.rs VALID_RGS_BINARY
VALID_V1 = bytes(
    [
        76, 68, 75, 1, 111, 226, 140, 10, 182, 241, 179, 114, 193, 166, 162, 70, 174, 99, 247, 79,
        147, 30, 131, 101, 225, 90, 8, 156, 104, 214, 25, 0, 0, 0, 0, 0, 97, 227, 98, 218, 0, 0, 0,
        4, 2, 22, 7, 207, 206, 25, 164, 197, 231, 230, 231, 56, 102, 61, 250, 251, 187, 172, 38,
        46, 79, 247, 108, 44, 155, 48, 219, 238, 252, 53, 192, 6, 67, 2, 36, 125, 157, 176, 223,
        175, 234, 116, 94, 248, 201, 225, 97, 235, 50, 47, 115, 172, 63, 136, 88, 216, 115, 11,
        111, 217, 114, 84, 116, 124, 231, 107, 2, 158, 1, 242, 121, 152, 106, 204, 131, 186, 35,
        93, 70, 216, 10, 237, 224, 183, 89, 95, 65, 3, 83, 185, 58, 138, 181, 64, 187, 103, 127,
        68, 50, 2, 201, 19, 17, 138, 136, 149, 185, 226, 156, 137, 175, 110, 32, 237, 0, 217, 90,
        31, 100, 228, 149, 46, 219, 175, 168, 77, 4, 143, 38, 128, 76, 97, 0, 0, 0, 2, 0, 0, 255,
        8, 153, 192, 0, 2, 27, 0, 0, 0, 1, 0, 0, 255, 2, 68, 226, 0, 6, 11, 0, 1, 2, 3, 0, 0, 0, 4,
        0, 40, 0, 0, 0, 0, 0, 0, 3, 232, 0, 0, 3, 232, 0, 0, 0, 1, 0, 0, 0, 0, 29, 129, 25, 192,
        255, 8, 153, 192, 0, 2, 27, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 100, 0, 0, 2, 224,
        0, 0, 0, 0, 58, 85, 116, 216, 0, 29, 0, 0, 0, 1, 0, 0, 0, 125, 0, 0, 0, 0, 58, 85, 116,
        216, 255, 2, 68, 226, 0, 6, 11, 0, 1, 0, 0, 1,
    ]
)

# node_data_update_succeeds_with_v2
VALID_V2 = bytes(
    [
        76, 68, 75, 2, 111, 226, 140, 10, 182, 241, 179, 114, 193, 166, 162, 70, 174, 99, 247,
        79, 147, 30, 131, 101, 225, 90, 8, 156, 104, 214, 25, 0, 0, 0, 0, 0, 102, 97, 206, 240,
        0, 0, 0, 0, 2, 63, 27, 132, 197, 86, 123, 18, 100, 64, 153, 93, 62, 213, 170, 186, 5,
        101, 215, 30, 24, 52, 96, 72, 25, 255, 156, 23, 245, 233, 213, 221, 7, 143, 5, 38, 4,
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 0, 2, 3, 0, 4, 7, 1, 127, 0, 0, 1, 37, 163, 14, 5, 10, 103, 111, 111, 103,
        108, 101, 46, 99, 111, 109, 1, 187, 19, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        1, 5, 57, 13, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0, 2, 23, 48, 62, 77, 75, 108,
        209, 54, 16, 50, 202, 155, 210, 174, 185, 217, 0, 170, 77, 69, 217, 234, 216, 10, 201,
        66, 51, 116, 196, 81, 167, 37, 77, 7, 102, 0, 0, 2, 25, 48, 0, 0, 0, 1, 0, 0, 1, 1, 0,
        0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 1, 0, 0, 1,
    ]
)


class RGSParseTest(unittest.TestCase):
    def test_v1_reference_snapshot(self):
        graph = parse_snapshot(VALID_V1)
        self.assertEqual(graph.version, 1)
        self.assertEqual(graph.timestamp, 1642291930)
        self.assertEqual(graph.node_count, 4)
        self.assertEqual(graph.channel_count, 2)
        policies = [
            policy
            for channel in graph.channels.values()
            for policy in (channel.policy1, channel.policy2)
            if policy is not None
        ]
        self.assertGreaterEqual(len(policies), 2)
        self.assertTrue(any(policy.base_msat == 1000 for policy in policies))

    def test_v2_includes_socket_addresses(self):
        graph = parse_snapshot(VALID_V2)
        self.assertEqual(graph.version, 2)
        self.assertEqual(graph.node_count, 2)
        joined = " ".join(
            address for node in graph.nodes.values() for address in node.addresses
        )
        self.assertIn("127.0.0.1:9635", joined)
        self.assertIn("google.com:443", joined)

    def test_scid_roundtrip(self):
        scid = (811984 << 40) | (2037 << 16) | 0
        self.assertEqual(format_scid(scid), "811984x2037x0")
        self.assertEqual(parse_scid("811984x2037x0"), scid)
        self.assertEqual(parse_scid(str(scid)), scid)
        self.assertIsNone(parse_scid("not-a-channel"))


if __name__ == "__main__":
    unittest.main()
