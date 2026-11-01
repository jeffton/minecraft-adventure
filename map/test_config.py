import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("map_install", ROOT / "map/install.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class MapBoundaryTests(unittest.TestCase):
    def test_private_listener_and_limited_render_work(self):
        config = installer.configurations()
        self.assertIn('ip: "127.0.0.1"', config["webserver.conf"])
        self.assertIn("render-thread-count: 1", config["core.conf"])
        self.assertIn("live-player-markers: true", config["plugin.conf"])
        self.assertIn("hidden-game-modes: []", config["plugin.conf"])

    def test_dimensions_keep_world_coordinates_and_visited_chunks(self):
        for dimension in ("minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"):
            config = installer.map_config("world", dimension, "World", 0)
            self.assertIn(f'dimension: "{dimension}"', config)
            self.assertIn('world: "world"', config)
            self.assertIn("min-inhabited-time: 1", config)
            self.assertIn("enable-flat-view: true", config)
            self.assertEqual("subtract: true" in config, dimension == "minecraft:the_nether")
            self.assertIn("ambient-light: 0" if dimension == "minecraft:overworld" else "ambient-light: 0.6", config)
            self.assertIn("remove-caves-below-y: 10000" if dimension == "minecraft:overworld" else "remove-caves-below-y: -10000", config)

    def test_only_readonly_map_proxy_is_added(self):
        nginx = (ROOT / "diary/minecraft.roybot.se.conf").read_text()
        section = nginx.split("location /map/ {", 1)[1].split("\n    }", 1)[0]
        self.assertIn("limit_except GET HEAD { deny all; }", section)
        self.assertIn("proxy_pass http://127.0.0.1:8100/;", section)
        self.assertIn("proxy_buffering off;", section)
        self.assertNotIn("/var/lib/", section)
        self.assertNotIn("alias", section)

    def test_map_embed_does_not_start_another_game_camera(self):
        html = (ROOT / "diary/index.html").read_text()
        self.assertIn('data-src="/map/"', html)
        self.assertNotIn('<iframe src="/map/"', html)
        self.assertNotIn('loading="lazy"', html)
        self.assertIn('src="map.js"', html)
        self.assertIn('title="Isometric map and live player positions"', html)
        self.assertNotIn('src="/live/"', html)


if __name__ == "__main__":
    unittest.main()
