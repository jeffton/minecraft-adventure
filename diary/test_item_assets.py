"""Run with python3 -m unittest discover -s diary -p test_item_assets.py."""

import importlib.util
import json
import os
import stat
from pathlib import Path
import tempfile
import unittest

from PIL import Image

SPEC = importlib.util.spec_from_file_location("item_assets", Path(__file__).with_name("build-item-assets.py"))
ASSETS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASSETS)
INSTALLED = Path("/opt/minecraft-mindcraft/node_modules/minecraft-assets/minecraft-assets/data/26.1")


class ItemAssetsTests(unittest.TestCase):
    def test_cube_uses_each_inherited_face_not_particle(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "blocks").mkdir()
            colors = {"top": (255, 0, 0, 255), "front": (0, 255, 0, 255), "side": (0, 0, 255, 255)}
            for name, color in colors.items():
                Image.new("RGBA", (16, 16), color).save(source / "blocks" / f"{name}.png")
            models = {
                "cube": {"elements": [{"from": [0, 0, 0], "to": [16, 16, 16], "faces": {
                    "up": {"texture": "#up"}, "north": {"texture": "#north"}, "east": {"texture": "#east"},
                }}]},
                "table": {"parent": "minecraft:block/cube", "textures": {
                    "up": "minecraft:block/top", "north": "minecraft:block/front", "east": "minecraft:block/side",
                    "particle": "minecraft:block/does_not_exist",
                }},
            }
            image = ASSETS.cube_icon(source, ASSETS.resolve_model(models, "table"))
            self.assertEqual(image.getpixel((24, 12)), colors["top"])
            self.assertEqual(image.getpixel((12, 30)), (0, 204, 0, 255))
            self.assertEqual(image.getpixel((36, 30)), (0, 0, 165, 255))

    def test_texture_alias_and_modern_sprite_object(self):
        self.assertEqual(ASSETS.resolve_texture("#side", {"side": "#all", "all": {"sprite": "minecraft:block/stone"}}), "minecraft:block/stone")
        with self.assertRaises(ValueError):
            ASSETS.resolve_texture("#a", {"a": "#b", "b": "#a"})

    def test_special_renderer_does_not_use_misleading_particle(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "Special renderer"):
                ASSETS.item_icon(Path(directory), {"decorated_pot": {"textures": {"particle": "minecraft:block/oak_planks"}}}, {"name": "decorated_pot", "texture": "minecraft:block/oak_planks"})

    def test_build_reports_every_item_and_preserves_hud(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            output = Path(directory) / "output"
            (source / "items").mkdir(parents=True)
            sprite = Image.new("RGBA", (16, 16), (10, 20, 30, 255))
            sprite.save(source / "items" / "stick.png")
            (source / "items_textures.json").write_text(json.dumps([{"name": "stick"}, {"name": "air"}, {"name": "unknown"}]))
            (source / "blocks_models.json").write_text("{}")
            for texture in ASSETS.HUD.values():
                path = source / "gui" / "sprites" / "hud" / f"{texture}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                sprite.save(path)
            previous_umask = os.umask(0o077)
            try:
                manifest = ASSETS.build(source, output)
            finally:
                os.umask(previous_umask)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o755)
            for path in output.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            self.assertEqual(set(manifest["items"]), {"stick", "air", "unknown"})
            self.assertIsNone(manifest["items"]["unknown"])
            self.assertIn("unknown", manifest["unmapped"])
            self.assertEqual(manifest["items"]["stick"], "item-assets/stick.png")
            self.assertEqual(Image.open(output / "hud-heartFull.png").tobytes(), sprite.tobytes())
            self.assertIsNone(Image.open(output / "air.png").getbbox())

    @unittest.skipUnless(INSTALLED.is_dir(), "Installed Mojang assets required for real-model integration")
    def test_real_crafting_table_and_log_model_textures(self):
        models = json.loads((INSTALLED / "blocks_models.json").read_text())
        table = ASSETS.resolve_model(models, "crafting_table")
        log = ASSETS.resolve_model(models, "oak_log")
        self.assertEqual(ASSETS.resolve_texture(table["elements"][0]["faces"]["up"]["texture"], table["textures"]), "minecraft:block/crafting_table_top")
        self.assertEqual(ASSETS.resolve_texture(log["elements"][0]["faces"]["north"]["texture"], log["textures"]), "minecraft:block/oak_log")
        self.assertEqual(ASSETS.resolve_texture(log["elements"][0]["faces"]["up"]["texture"], log["textures"]), "minecraft:block/oak_log_top")
        for name in ("crafting_table", "oak_log", "oak_planks", "white_wool"):
            image, kind = ASSETS.item_icon(INSTALLED, models, {"name": name})
            self.assertEqual(kind, "cube")
            self.assertIsNotNone(image.getbbox())
        states = json.loads((INSTALLED / "blocks_states.json").read_text())
        for name, expected in (("oak_fence", "oak_fence_inventory"), ("oak_trapdoor", "oak_trapdoor_bottom"), ("bee_nest", "bee_nest_empty"), ("waxed_copper_block", "copper_block")):
            self.assertEqual(ASSETS.select_model(models, states, {"name": name}), expected)
            image, _ = ASSETS.item_icon(INSTALLED, models, {"name": name}, states)
            self.assertIsNotNone(image.getbbox())
        image, kind = ASSETS.item_icon(INSTALLED, models, {"name": "chest"}, states)
        self.assertEqual(kind, "entity-texture-preview")
        self.assertEqual(image.size, (14, 14))
        with Image.open(INSTALLED / "entity" / "chest" / "normal.png") as atlas:
            self.assertEqual(image.getpixel((0, 0)), atlas.convert("RGBA").getpixel((14, 14)))
            self.assertEqual(image.getpixel((0, 13)), atlas.convert("RGBA").getpixel((14, 42)))
        for name in ("stone_pickaxe", "mutton", "stick"):
            _, kind = ASSETS.item_icon(INSTALLED, models, {"name": name})
            self.assertEqual(kind, "sprite")


if __name__ == "__main__":
    unittest.main()
