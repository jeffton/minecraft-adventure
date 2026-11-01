"""Publish explicit plain markers for offline bots, which have no Mojang skins."""
import hashlib
import math
import os
from pathlib import Path
import pwd
import struct
import uuid
import zlib

BOT_COLORS = {
    "Roy": (233, 185, 85),
    "Spruce": (71, 167, 136),
    "Flint": (225, 128, 87),
    "Moss": (147, 189, 106),
}
DIMENSIONS = ("overworld", "nether", "end")


def offline_uuid(name):
    digest = hashlib.md5(("OfflinePlayer:" + name).encode()).digest()
    return str(uuid.UUID(bytes=digest, version=3))


def marker_png(color):
    """32px RGBA location dot; generated artwork, not a pretend player skin."""
    size = 32
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)  # PNG scanline: no filter.
        for x in range(size):
            radius = math.hypot(x - 15.5, y - 15.5)
            alpha = round(255 * max(0, min(1, 14.5 - radius)))
            rgb = (255, 255, 255) if radius > 11.5 else color
            pixels.extend((*rgb, alpha))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def install(webroot, uid, gid):
    for dimension in DIMENSIONS:
        directory = webroot / "maps" / dimension / "assets" / "playerheads"
        for path in (webroot / "maps", webroot / "maps" / dimension, directory.parent, directory):
            path.mkdir(exist_ok=True)
            os.chown(path, uid, gid)
            path.chmod(0o750)
        for name, color in BOT_COLORS.items():
            destination = directory / (offline_uuid(name) + ".png")
            destination.write_bytes(marker_png(color))
            os.chown(destination, uid, gid)
            destination.chmod(0o640)


if __name__ == "__main__":
    account = pwd.getpwnam("minecraft-adventure")
    install(Path("/var/lib/minecraft-adventure/server/bluemap/web"), account.pw_uid, account.pw_gid)
