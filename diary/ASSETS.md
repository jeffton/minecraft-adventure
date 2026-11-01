# Inventory graphics

Build from the installed Minecraft 26.1 asset directory with Python 3 and Pillow (`python3-pil`):

```sh
python3 diary/build-item-assets.py \
  /opt/minecraft-mindcraft/node_modules/minecraft-assets/minecraft-assets/data/26.1 \
  /var/www/roybot.se/minecraft/item-assets
python3 -m unittest discover -s diary -p test_item_assets.py
```

The builder reads local files only and explicitly sets its output directory to 0755 and public files to 0644, including when run under umask 077. Generated PNGs and `manifest.json` belong outside the Git repository; do not commit or package Mojang assets. Only the generator, tests and documentation are source code.

## Manifest

`version` is `26.1`. `items` contains every name in `items_textures.json`: a site-relative `item-assets/name.png` URL, or explicit `null` for unsupported graphics. `unmapped` gives each null entry's reason; the build also prints them. The UI must show the item name for null/unknown entries rather than inventing an image. `hud` supplies `heartEmpty`, `heartFull`, `heartHalf`, `foodEmpty`, `foodFull` and `foodHalf` from the original HUD sprites.

`kinds` identifies the imagery:

- `sprite`: actual standalone item sprite.
- `sprite-first-frame`: a static frame of a compass/clock, not a live direction/time indicator.
- `cube`: inherited unit-cube model, projected from its real top/north/east textures. Crafting tables retain their table faces; logs retain bark and end grain.
- `block-texture-preview`: an actual face texture from a noncube model, not a full inventory-model rendering. Shape, tint, overlays and model display transforms are not reproduced.
- `entity-texture-preview`: the assembled chest front (lid, body, latch) from its actual entity atlas, not a full 3D model.
- `empty`: transparent air.

Model selection uses the item's model reference, inventory variants and actual blockstate model references. This includes fences, trapdoors, bee nests and waxed copper aliases. The renderer intentionally does not turn particle textures into icons. Banners, spawn eggs and other special-renderer items without suitable standalone sprites may remain unmapped. Animated textures use their first frame. Biome/dye-dependent model tinting and custom resource packs are not applied. This is 26.1 imagery for the mature 26.1 bot/viewer protocol; the server runs 26.3, so newer items can be absent and must remain text-labelled.

## Ownership

Minecraft graphics remain © Mojang AB / Microsoft, not this repository's code license. Local generation does not grant a redistribution license. This fan site's use remains subject to the [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines) and [EULA](https://www.minecraft.net/en-us/eula), reviewed 2026-11-01. Keep the site's independent ownership and non-affiliation notice visible:

> Not an official Minecraft service. Not approved by or associated with Mojang or Microsoft.
