#!/usr/bin/env python3
"""Build local inventory imagery from an installed Minecraft asset directory."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageEnhance

VERSION = "26.1"
HUD = {
    "heartEmpty": "heart/container",
    "heartFull": "heart/full",
    "heartHalf": "heart/half",
    "foodEmpty": "food_empty",
    "foodFull": "food_full",
    "foodHalf": "food_half",
}


def model_name(value):
    return value.removeprefix("minecraft:").removeprefix("block/")


def resolve_model(models, name, ancestors=()):
    if name in ancestors:
        raise ValueError(f"Model inheritance cycle: {name}")
    model = models[name]
    result = {"textures": {}}
    if "parent" in model:
        result = resolve_model(models, model_name(model["parent"]), (*ancestors, name))
    return {**result, **model, "textures": {**result["textures"], **model.get("textures", {})}}


def resolve_texture(value, textures):
    seen = set()
    while True:
        if isinstance(value, dict):
            value = value["sprite"]
        if not value.startswith("#"):
            return value
        if value in seen:
            raise ValueError(f"Texture reference cycle: {value}")
        seen.add(value)
        value = textures[value[1:]]


def texture_path(source, texture):
    name = texture.removeprefix("minecraft:")
    parts = name.split("/")
    if len(parts) != 2 or parts[0] not in ("block", "items") or parts[1] in (".", ".."):
        raise ValueError(f"Unsupported texture reference: {texture}")
    return source / ("blocks" if parts[0] == "block" else "items") / f"{parts[1]}.png"


def load_texture(path):
    with Image.open(path) as image:
        # Animated textures are vertical filmstrips. Use the first real frame.
        width, height = image.size
        return image.convert("RGBA").crop((0, 0, width, min(width, height)))


def project_face(image, origin, axis_u, axis_v, shade):
    """Nearest-neighbour texture projection onto a parallelogram."""
    face = Image.new("RGBA", (48, 48))
    texture = ImageEnhance.Brightness(image).enhance(shade)
    determinant = axis_u[0] * axis_v[1] - axis_u[1] * axis_v[0]
    for y in range(48):
        for x in range(48):
            dx, dy = x + 0.5 - origin[0], y + 0.5 - origin[1]
            u = (dx * axis_v[1] - dy * axis_v[0]) / determinant
            v = (dy * axis_u[0] - dx * axis_u[1]) / determinant
            if 0 <= u < 1 and 0 <= v < 1:
                face.putpixel((x, y), texture.getpixel((int(u * texture.width), int(v * texture.height))))
    return face


def cube_icon(source, model):
    elements = model.get("elements", [])
    if len(elements) != 1:
        return None
    element = elements[0]
    if element.get("from") != [0, 0, 0] or element.get("to") != [16, 16, 16] or "rotation" in element:
        return None
    faces = element["faces"]
    if not all(name in faces for name in ("up", "north", "east")):
        return None
    for name in ("up", "north", "east"):
        face = faces[name]
        if face.get("rotation", 0) or face.get("uv", [0, 0, 16, 16]) != [0, 0, 16, 16]:
            return None
    result = Image.new("RGBA", (48, 48))
    projections = [
        ("north", (0, 12), (24, 12), (0, 24), 0.8),
        ("east", (24, 24), (24, -12), (0, 24), 0.65),
        ("up", (0, 12), (24, -12), (24, 12), 1.0),
    ]
    for name, origin, axis_u, axis_v, shade in projections:
        texture = resolve_texture(faces[name]["texture"], model["textures"])
        result.alpha_composite(project_face(load_texture(texture_path(source, texture)), origin, axis_u, axis_v, shade))
    return result


def select_model(models, states, item):
    """Use inventory geometry first, then the canonical blockstate model."""
    name = model_name(item.get("model", item["name"]))
    for candidate in (f"{name}_inventory", name):
        if candidate in models:
            return candidate
    state = states.get(item["name"], {})
    variants = state.get("variants", {})
    for variant in variants.values():
        entry = variant[0] if isinstance(variant, list) else variant
        candidate = model_name(entry["model"])
        if candidate in models:
            return candidate
    for part in state.get("multipart", []):
        entry = part["apply"]
        entry = entry[0] if isinstance(entry, list) else entry
        candidate = model_name(entry["model"])
        if candidate in models:
            return candidate
    return None


def chest_preview(source, name):
    """Front face from the single-chest entity atlas; not its particle texture."""
    atlas_names = {"chest": "normal", "trapped_chest": "trapped", "ender_chest": "ender"}
    with Image.open(source / "entity" / "chest" / f"{atlas_names[name]}.png") as atlas:
        atlas = atlas.convert("RGBA")
        scale = atlas.width // 64
        def crop(box):
            return atlas.crop(tuple(coordinate * scale for coordinate in box))
        front = Image.new("RGBA", (14 * scale, 14 * scale))
        # Vanilla cuboid UVs: lid offset (0,0), base offset (0,19),
        # latch offset (0,0); visible north faces sit after depth+width.
        front.alpha_composite(crop((14, 14, 28, 19)), (0, 0))
        front.alpha_composite(crop((14, 33, 28, 43)), (0, 4 * scale))
        front.alpha_composite(crop((1, 1, 3, 5)), (6 * scale, 3 * scale))
        return front


def item_icon(source, models, item, states=None):
    name = item["name"]
    if name == "air":
        return Image.new("RGBA", (16, 16)), "empty"
    sprite = source / "items" / f"{name}.png"
    if sprite.is_file():
        return load_texture(sprite), "sprite"
    if name in ("compass", "clock", "recovery_compass"):
        return load_texture(source / "items" / f"{name}_00.png"), "sprite-first-frame"
    if name in ("chest", "trapped_chest", "ender_chest"):
        return chest_preview(source, name), "entity-texture-preview"
    selected = select_model(models, states or {}, item)
    if selected is not None:
        model = resolve_model(models, selected)
        icon = cube_icon(source, model)
        if icon is not None:
            return icon, "cube"
        # A real model face is an honest material preview, unlike particle
        # metadata (e.g. a chest's oak_planks), which is not an item graphic.
        for element in model.get("elements", []):
            faces = element.get("faces", {})
            for direction in ("north", "up", "east", "south", "west", "down"):
                if direction in faces:
                    texture = resolve_texture(faces[direction]["texture"], model["textures"])
                    return load_texture(texture_path(source, texture)), "block-texture-preview"
        raise ValueError("Special renderer has no block faces or standalone item sprite")
    texture = item.get("texture")
    if texture and texture.removeprefix("minecraft:").startswith("items/"):
        return load_texture(texture_path(source, texture)), "sprite"
    raise ValueError("No standalone item sprite or block-face model")


def build(source, output):
    items = json.loads((source / "items_textures.json").read_text())
    models = json.loads((source / "blocks_models.json").read_text())
    states_path = source / "blocks_states.json"
    states = json.loads(states_path.read_text()) if states_path.exists() else {}
    output.mkdir(parents=True, exist_ok=True)
    output.chmod(0o755)
    manifest = {"version": VERSION, "items": {}, "hud": {}, "kinds": {}, "unmapped": {}}
    for item in items:
        name = item["name"]
        if not name or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789_" for character in name):
            raise ValueError(f"Invalid item name: {name}")
        try:
            icon, kind = item_icon(source, models, item, states)
        except (KeyError, ValueError, FileNotFoundError) as error:
            manifest["items"][name] = None
            manifest["unmapped"][name] = str(error)
            continue
        path = output / f"{name}.png"
        icon.save(path)
        path.chmod(0o644)
        manifest["items"][name] = f"item-assets/{name}.png"
        manifest["kinds"][name] = kind
    for key, texture in HUD.items():
        with Image.open(source / "gui" / "sprites" / "hud" / f"{texture}.png") as sprite:
            path = output / f"hud-{key}.png"
            sprite.save(path)
            path.chmod(0o644)
        manifest["hud"][key] = f"item-assets/hud-{key}.png"
    manifest_path = output / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    manifest_path.chmod(0o644)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    manifest = build(arguments.source, arguments.output)
    print(f"Mapped {len(manifest['items']) - len(manifest['unmapped'])}/{len(manifest['items'])} items")
    if manifest["unmapped"]:
        print("UNMAPPED (explicit null entries; see manifest.json):")
        for name, reason in manifest["unmapped"].items():
            print(f"  {name}: {reason}")


if __name__ == "__main__":
    main()
