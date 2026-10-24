"""Node feature bits (BOLT 9) decoded into names, badges, and filter flags.

Features live as a bitfield in the node announcement. Version 2 rapid gossip
sync snapshots carry the bytes; the public v1 snapshots and mempool's bulk
lists do not, so bits are also harvested from mempool's per-node profile
(either a ``features`` list of ``{bit, name, is_known, is_required}`` objects
in recent versions, or a ``features``/``featuresBits`` hex string).

Every feature is a pair of bits: the even bit is optional, the odd one
mandatory. A few historic single bits (initial_routing_sync) stand alone.
Everything here is a pure function and unit tested in
``explorer/tests/test_features.py``.
"""

from __future__ import annotations

# Even bit -> feature name. The following odd bit is the same feature, required.
FEATURE_NAMES: dict[int, str] = {
    0: "option_data_loss_protect",
    4: "upfront_shutdown_script",
    6: "gossip_queries",
    8: "var_onion_optin",
    10: "gossip_queries_ex",
    12: "option_static_remotekey",
    14: "payment_secret",
    16: "basic_mpp",
    18: "option_support_large_channel",  # wumbo
    20: "option_anchor_outputs",
    22: "option_anchors_zero_fee_htlc_tx",
    24: "option_route_blinding",
    26: "option_shutdown_anysegwit",
    28: "option_dual_fund",
    34: "option_quiesce",
    38: "option_onion_messages",
    44: "option_channel_type",
    46: "option_scid_alias",
    48: "option_payment_metadata",
    50: "option_zeroconf",
    60: "option_simple_close",
}

# Bits that stand alone, without an optional/mandatory pair.
SINGLE_BITS: dict[int, str] = {3: "initial_routing_sync"}

# Short names the node table can filter on, and the bits that set them.
FILTER_BITS: dict[str, tuple[int, ...]] = {
    "wumbo": (18, 19),
    "anchors": (20, 21, 22, 23),
    "dual_fund": (28, 29),
    "onion_messages": (38, 39),
    "route_blinding": (24, 25),
}
FILTER_NAMES = frozenset(FILTER_BITS)


def name_for_bit(bit: int) -> str | None:
    """Feature name for one bit, or None when the bit is unknown."""
    if bit in SINGLE_BITS:
        return SINGLE_BITS[bit]
    return FEATURE_NAMES.get(bit - (bit % 2))


def describe(bits) -> list[dict]:
    """Sort and name a bit list: ``[{bit, name, required}, ...]``.

    Unknown bits become ``"bit N"``. An odd bit means the feature is
    required; an even bit means it is offered optionally.
    """
    clean = sorted({int(bit) for bit in bits if isinstance(bit, int) and not isinstance(bit, bool) and bit >= 0})
    return [
        {
            "bit": bit,
            "name": name_for_bit(bit) or f"bit {bit}",
            "required": bool(bit % 2),
        }
        for bit in clean
    ]


def has(bits, name: str) -> bool:
    """True when any bit of feature ``name`` (e.g. ``wumbo``) is set."""
    wanted = FILTER_BITS.get(name)
    if not wanted:
        return False
    known = {int(bit) for bit in bits or []}
    return any(bit in known for bit in wanted)


def bits_from_bytes(blob: bytes) -> list[int]:
    """Feature bits from a BOLT 9 byte string (big-endian bit numbering)."""
    if not blob:
        return []
    bits = []
    for index, byte in enumerate(blob):
        for position in range(8):
            if byte & (0x80 >> position):
                bits.append(index * 8 + position)
    return bits


def bits_from_hex(text: str) -> list[int]:
    try:
        return bits_from_bytes(bytes.fromhex(text.strip()))
    except (TypeError, ValueError):
        return []


def bits_from_mempool(payload) -> list[int]:
    """Feature bits from a mempool node profile, whatever shape it has.

    Recent versions return ``features`` as a list of ``{bit, ...}`` objects;
    others expose ``featuresBits`` (or ``features``) as a hex string.
    """
    if not isinstance(payload, dict):
        return []
    raw = payload.get("features")
    bits: list[int] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                bit = item.get("bit")
                if isinstance(bit, int) and not isinstance(bit, bool) and bit >= 0:
                    bits.append(bit)
            elif isinstance(item, int) and not isinstance(item, bool) and item >= 0:
                bits.append(item)
    elif isinstance(raw, str):
        bits = bits_from_hex(raw)
    if not bits:
        for key in ("featuresBits", "features_hex"):
            value = payload.get(key)
            if isinstance(value, str):
                bits = bits_from_hex(value)
                if bits:
                    break
    return sorted(set(bits))
