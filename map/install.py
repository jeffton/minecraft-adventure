#!/usr/bin/env python3
"""Install a pinned BlueMap plugin and bounded read-only map configuration.

Does not restart Paper or touch world data. Coordinate a graceful restart separately.
"""
import hashlib
import os
from pathlib import Path
import pwd
import urllib.request

from marker_icons import install as install_marker_icons

VERSION = "5.29"
SHA256 = "7bf475936c26107d476c63151c76d5b49e865eebeada12c9e7d92155de877b9f"
SERVER = Path("/var/lib/minecraft-adventure/server")
CONFIG = SERVER / "plugins/BlueMap"


def configurations():
    return {
        "core.conf": """accept-download: true
data: "bluemap"
render-thread-count: 1
render-thread-priority: 1
update-cooldown: 60
full-update-interval: 1440
region-file-check-interval: 5
metrics: false
""",
        "plugin.conf": """live-player-markers: true
hidden-game-modes: []
hide-vanished: false
hide-invisible: false
hide-sneaking: false
hide-below-sky-light: 0
hide-below-block-light: 0
hide-different-world: false
skin-download: false
player-render-limit: -1
""",
        "webserver.conf": """enabled: true
ip: "127.0.0.1"
port: 8100
webroot: "bluemap/web"
sse-enabled: true
additional-headers: { "Cache-Control": "no-cache" }
""",
        "webapp.conf": """enabled: true
webroot: "bluemap/web"
update-settings-file: true
use-cookies: false
default-to-flat-view: false
start-location: "overworld:0:130:0:420:0.7854:0.61548:0:1:flat"
scripts: ["isometric.js", "connection.js"]
styles: ["map.css"]
resolution-default: 1
hires-slider-default: 100
hires-slider-max: 300
lowres-slider-default: 1000
lowres-slider-max: 3000
""",
        "storages/file.conf": """storage-type: file
root: "bluemap/web/maps"
compression: gzip
""",
    }


def map_config(world, dimension, name, order):
    return f'''world: "{world}"
dimension: "{dimension}"
name: "{name}"
sorting: {order}
start-pos: {{ x: 0, z: 0 }}
min-inhabited-time: 1
enable-perspective-view: true
enable-flat-view: true
enable-free-flight-view: false
enable-hires: true
remove-caves-below-y: {10000 if dimension == "minecraft:overworld" else -10000}
ambient-light: {0 if dimension == "minecraft:overworld" else 0.6}
storage: "file"
''' + ('render-mask: [{ subtract: true, min-y: 90, max-y: 127 }]\n'
       if dimension == "minecraft:the_nether" else "")


def install():
    account = pwd.getpwnam("minecraft-adventure")
    url = f"https://github.com/BlueMap-Minecraft/BlueMap/releases/download/v{VERSION}/bluemap-{VERSION}-paper.jar"
    with urllib.request.urlopen(url, timeout=60) as response:
        jar = response.read()
    if hashlib.sha256(jar).hexdigest() != SHA256:
        raise ValueError("BlueMap download SHA256 mismatch")
    entries = configurations()
    # Paper 26.3 stores all vanilla dimensions below the primary world directory.
    entries["maps/overworld.conf"] = map_config("world", "minecraft:overworld", "Overworld", 0)
    entries["maps/nether.conf"] = map_config("world", "minecraft:the_nether", "Nether", 1)
    entries["maps/end.conf"] = map_config("world", "minecraft:the_end", "The End", 2)
    for relative, content in entries.items():
        path = CONFIG / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        os.chown(path, account.pw_uid, account.pw_gid)
        path.chmod(0o640)
    for directory in (CONFIG, CONFIG / "maps", CONFIG / "storages"):
        os.chown(directory, account.pw_uid, account.pw_gid)
        directory.chmod(0o750)
    web = SERVER / "bluemap/web"
    for directory in (web.parent, web):
        directory.mkdir(parents=True, exist_ok=True)
        os.chown(directory, account.pw_uid, account.pw_gid)
        directory.chmod(0o750)
    for filename in ("isometric.js", "connection.js", "map.css"):
        asset = web / filename
        asset.write_bytes(Path(__file__).with_name(filename).read_bytes())
        os.chown(asset, account.pw_uid, account.pw_gid)
        asset.chmod(0o640)
    install_marker_icons(web, account.pw_uid, account.pw_gid)
    plugin = SERVER / "plugins/BlueMap.jar"
    plugin.write_bytes(jar)
    plugin.chmod(0o640)
    os.chown(plugin, account.pw_uid, account.pw_gid)
    print("BlueMap installed; coordinate a graceful Paper restart to activate.")


if __name__ == "__main__":
    install()
