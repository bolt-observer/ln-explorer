"""Parser for Lightning Development Kit rapid gossip sync snapshots.

The binary layout follows ``lightning-rapid-gossip-sync`` (prefix ``LDK``,
versions 1 and 2). Version 1, which the public LDK snapshot server currently
serves, carries node ids, channel announcements, and channel updates (fees,
CLTV, HTLC bounds, disabled flag). Aliases, socket addresses, and funding
capacity are not part of that version; version 2 adds addresses and an
optional funding amount.
"""

from __future__ import annotations

import base64
import ipaddress
import struct
from dataclasses import dataclass, field


class RGSParseError(ValueError):
    """Snapshot bytes are not a readable rapid gossip sync payload."""


@dataclass
class Policy:
    base_msat: int
    ppm: int
    cltv: int
    min_htlc_msat: int
    max_htlc_msat: int
    disabled: bool


@dataclass
class ParsedChannel:
    scid: int
    node1: str
    node2: str
    capacity: int | None = None
    policy1: Policy | None = None
    policy2: Policy | None = None


@dataclass
class ParsedNode:
    pubkey: str
    addresses: list[str] = field(default_factory=list)
    features: bytes = b""


@dataclass
class ParsedGraph:
    version: int
    chain_hash: bytes
    timestamp: int
    nodes: dict[str, ParsedNode]
    channels: dict[int, ParsedChannel]

    @property
    def node_count(self) -> int:
        return len(self.nodes)

    @property
    def channel_count(self) -> int:
        return len(self.channels)


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.i = 0

    def remaining(self) -> int:
        return len(self.data) - self.i

    def _need(self, n: int) -> None:
        if self.i + n > len(self.data):
            raise RGSParseError(
                f"truncated snapshot at {self.i}, need {n} more bytes"
            )

    def u8(self) -> int:
        self._need(1)
        value = self.data[self.i]
        self.i += 1
        return value

    def u16(self) -> int:
        self._need(2)
        value = struct.unpack_from(">H", self.data, self.i)[0]
        self.i += 2
        return value

    def u32(self) -> int:
        self._need(4)
        value = struct.unpack_from(">I", self.data, self.i)[0]
        self.i += 4
        return value

    def u64(self) -> int:
        self._need(8)
        value = struct.unpack_from(">Q", self.data, self.i)[0]
        self.i += 8
        return value

    def raw(self, n: int) -> bytes:
        self._need(n)
        value = self.data[self.i : self.i + n]
        self.i += n
        return value

    def bigsize(self) -> int:
        marker = self.u8()
        if marker < 0xFD:
            return marker
        if marker == 0xFD:
            value = self.u16()
            if value < 0xFD:
                raise RGSParseError("non-canonical BigSize")
            return value
        if marker == 0xFE:
            value = self.u32()
            if value < 0x10000:
                raise RGSParseError("non-canonical BigSize")
            return value
        value = self.u64()
        if value < 0x100000000:
            raise RGSParseError("non-canonical BigSize")
        return value

    def collection_len(self) -> int:
        """LDK ``CollectionLength``: u16, or 0xffff followed by a u64 offset."""
        value = self.u16()
        if value == 0xFFFF:
            extra = self.u64()
            value = extra + 0xFFFF
        return value

    def vec_u8(self) -> bytes:
        length = self.collection_len()
        if length > self.remaining():
            raise RGSParseError("length-prefixed blob exceeds snapshot")
        return self.raw(length)

    def feature_bytes(self) -> bytes:
        length = self.u16()
        return self.raw(length)


def _onion_v3(pubkey: bytes, checksum: int, version: int) -> str:
    raw = pubkey + struct.pack(">H", checksum) + bytes([version])
    text = base64.b32encode(raw).decode("ascii").lower().rstrip("=")
    return f"{text}.onion"


def _decode_address(blob: bytes) -> str | None:
    if not blob:
        return None
    kind = blob[0]
    body = blob[1:]
    try:
        if kind == 1 and len(body) >= 6:
            host = ".".join(str(b) for b in body[:4])
            port = struct.unpack_from(">H", body, 4)[0]
            return f"{host}:{port}"
        if kind == 2 and len(body) >= 18:
            host = ipaddress.IPv6Address(body[:16]).compressed
            port = struct.unpack_from(">H", body, 16)[0]
            return f"[{host}]:{port}"
        if kind == 3 and len(body) >= 12:
            return "torv2:" + body[:10].hex()
        if kind == 4 and len(body) >= 37:
            pubkey = body[:32]
            checksum = struct.unpack_from(">H", body, 32)[0]
            version = body[34]
            port = struct.unpack_from(">H", body, 35)[0]
            return f"{_onion_v3(pubkey, checksum, version)}:{port}"
        if kind == 5 and len(body) >= 1:
            host_len = body[0]
            if len(body) < 1 + host_len + 2:
                return None
            host = body[1 : 1 + host_len].decode("ascii", errors="replace")
            port = struct.unpack_from(">H", body, 1 + host_len)[0]
            return f"{host}:{port}"
    except (ValueError, struct.error):
        return None
    return None


def _read_node_ids(reader: _Reader, version: int) -> dict[str, ParsedNode]:
    nodes: dict[str, ParsedNode] = {}
    default_features: list[bytes] = []
    if version >= 2:
        feature_sets = reader.u8()
        for _ in range(feature_sets):
            default_features.append(reader.feature_bytes())

    count = reader.u32()
    if count > 200_000:
        raise RGSParseError(f"implausible node count {count}")

    for _ in range(count):
        if version < 2:
            pubkey = reader.raw(33).hex()
            nodes[pubkey] = ParsedNode(pubkey=pubkey)
            continue

        raw_key = bytearray(reader.raw(33))
        flags = raw_key[0]
        parity = flags & 0b11
        if parity not in (2, 3):
            raise RGSParseError("node id parity bits are not a compressed pubkey")
        raw_key[0] = parity
        pubkey = bytes(raw_key).hex()
        has_address = (flags & (1 << 2)) != 0
        feature_marker = (flags & (0b111 << 3)) >> 3
        is_reminder = (flags & (1 << 6)) != 0
        has_extra = (flags & (1 << 7)) != 0

        addresses: list[str] = []
        features = b""
        if is_reminder or has_address or feature_marker:
            if has_address:
                address_count = reader.u8()
                for _addr in range(address_count):
                    byte_count = reader.u8()
                    decoded = _decode_address(reader.raw(byte_count))
                    if decoded:
                        addresses.append(decoded)
            if feature_marker:
                if feature_marker < 7:
                    index = feature_marker - 1
                    if index >= len(default_features):
                        raise RGSParseError("feature preset index out of range")
                    features = default_features[index]
                else:
                    features = reader.feature_bytes()
        if has_extra:
            reader.vec_u8()
        nodes[pubkey] = ParsedNode(pubkey=pubkey, addresses=addresses, features=features)
    return nodes


def _apply_policy(channel: ParsedChannel, direction_bit: int, policy: Policy) -> None:
    # BOLT 7: direction 0 is the lesser pubkey (node1).
    if direction_bit:
        channel.policy2 = policy
    else:
        channel.policy1 = policy


def parse_snapshot(data: bytes) -> ParsedGraph:
    """Parse a full rapid gossip sync snapshot into nodes and channels."""
    if len(data) < 40:
        raise RGSParseError("snapshot is too small")
    reader = _Reader(data)
    prefix = reader.raw(3)
    if prefix != b"LDK":
        raise RGSParseError("missing LDK gossip prefix")
    version = reader.u8()
    if version not in (1, 2):
        raise RGSParseError(f"unsupported rapid gossip sync version {version}")

    chain_hash = reader.raw(32)
    timestamp = reader.u32()
    nodes = _read_node_ids(reader, version)
    node_ids = list(nodes)

    channels: dict[int, ParsedChannel] = {}
    announcement_count = reader.u32()
    if announcement_count > 2_000_000:
        raise RGSParseError(f"implausible announcement count {announcement_count}")
    previous_scid = 0
    for _ in range(announcement_count):
        reader.feature_bytes()
        previous_scid += reader.bigsize()
        index1 = reader.bigsize()
        index2 = reader.bigsize()
        has_extra = (index2 & (1 << 63)) != 0
        index2 &= ~(1 << 63)
        if index1 >= len(node_ids) or index2 >= len(node_ids):
            raise RGSParseError("channel endpoint index out of range")
        capacity = None
        if version >= 2 and has_extra:
            extra = reader.vec_u8()
            extra_reader = _Reader(extra)
            if extra_reader.remaining():
                capacity = extra_reader.bigsize()
        left, right = node_ids[index1], node_ids[index2]
        if left > right:
            left, right = right, left
        channel = channels.get(previous_scid)
        if channel is None:
            channel = ParsedChannel(
                scid=previous_scid, node1=left, node2=right, capacity=capacity
            )
            channels[previous_scid] = channel
        elif capacity is not None:
            channel.capacity = capacity

    previous_scid = 0
    previous_direction: int | None = None
    update_count = reader.u32()
    if update_count > 5_000_000:
        raise RGSParseError(f"implausible update count {update_count}")
    if update_count:
        default_cltv = reader.u16()
        default_min = reader.u64()
        default_base = reader.u32()
        default_ppm = reader.u32()
        default_max = reader.u64()
        for _ in range(update_count):
            delta = reader.bigsize()
            previous_scid += delta
            flags = reader.u8()
            direction = flags & 1
            if version >= 2 and delta == 0 and previous_direction == direction:
                reader.vec_u8()
                continue
            previous_direction = direction

            incremental = (flags & 0b1000_0000) != 0
            cltv = default_cltv
            min_htlc = default_min
            base = default_base
            ppm = default_ppm
            max_htlc = default_max
            channel = channels.get(previous_scid)
            existing = None
            if channel is not None:
                existing = channel.policy2 if direction else channel.policy1
            if incremental and existing is not None:
                cltv = existing.cltv
                min_htlc = existing.min_htlc_msat
                base = existing.base_msat
                ppm = existing.ppm
                max_htlc = existing.max_htlc_msat

            if flags & 0b0100_0000:
                cltv = reader.u16()
            if flags & 0b0010_0000:
                min_htlc = reader.u64()
            if flags & 0b0001_0000:
                base = reader.u32()
            if flags & 0b0000_1000:
                ppm = reader.u32()
            if flags & 0b0000_0100:
                max_htlc = reader.u64()

            # Incremental updates refer to a previously applied direction.
            # A full snapshot has no prior graph, matching LDK's skip.
            if incremental and existing is None:
                continue
            if channel is None:
                continue
            _apply_policy(
                channel,
                direction,
                Policy(
                    base_msat=base,
                    ppm=ppm,
                    cltv=cltv,
                    min_htlc_msat=min_htlc,
                    max_htlc_msat=max_htlc,
                    disabled=bool(flags & 0b10),
                ),
            )

    if reader.remaining():
        raise RGSParseError(f"{reader.remaining()} trailing bytes after snapshot")

    return ParsedGraph(
        version=version,
        chain_hash=chain_hash,
        timestamp=timestamp,
        nodes=nodes,
        channels=channels,
    )


def format_scid(scid: int) -> str:
    block = scid >> 40
    tx_index = (scid >> 16) & 0xFFFFFF
    output = scid & 0xFFFF
    return f"{block}x{tx_index}x{output}"


def parse_scid(value: str) -> int | None:
    text = value.strip().lower()
    if not text:
        return None
    if "x" in text or ":" in text:
        parts = text.replace(":", "x").split("x")
        if len(parts) != 3 or not all(part.isdigit() for part in parts):
            return None
        block, tx_index, output = (int(part) for part in parts)
        if tx_index > 0xFFFFFF or output > 0xFFFF:
            return None
        return (block << 40) | (tx_index << 16) | output
    if text.isdigit():
        number = int(text)
        if number < 0 or number > 0xFFFFFFFFFFFFFFFF:
            return None
        return number
    return None
