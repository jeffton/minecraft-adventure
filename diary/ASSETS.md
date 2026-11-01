# Inventory graphics

Build from the installed Minecraft 26.1 asset directory with Python 3 and Pillow (`python3-pil`):

```sh
python3 diary/build-item-assets.py \
  /opt/minecraft-mindcraft/node_modules/minecraft-assets/minecraft-assets/data/26.1 \
  /var/www/roybot.se/minecraft/item-assets
python3 -m unittest discover -s diary -p test_item_assets.py
```

The builder reads installed assets and downloads 17 pinned, checksum-verified official Bedrock item sprites: all 16 bed colors and chain. Downloads require HTTPS access to `raw.githubusercontent.com`; checksum, image-format or dimension failures stop the build. It sets its output directory to 0755 and public files to 0644, including under umask 077. Each file is replaced atomically; the manifest is published last. Generated PNGs and `manifest.json` belong outside the Git repository; do not commit or package Mojang assets. Only the generator, tests and documentation are source code.

## Manifest

`version` is `26.1`, identifying the installed asset set. `items` contains every name in `items_textures.json`, plus the Java 1.21.4 `chain` name when the installed set calls it `iron_chain`: a site-relative `item-assets/name.png` URL, or explicit `null` for unsupported graphics. `unmapped` gives each null entry's reason; the build also prints them. The UI must show the item name for null/unknown entries rather than inventing an image. `hud` supplies `heartEmpty`, `heartFull`, `heartHalf`, `foodEmpty`, `foodFull` and `foodHalf` from the original HUD sprites.

`sources` records the URL, SHA-256 and Mojang EULA notice for each downloaded sprite. Bed and chain icons come from [Mojang/bedrock-samples at commit `15701fa9c13923f12662984c32c124327e40e3d3`](https://github.com/Mojang/bedrock-samples/tree/15701fa9c13923f12662984c32c124327e40e3d3/resource_pack/textures/items). They are original 16×16 PNG item art, not block-face previews. Java `light_gray_bed` uses Bedrock's `bed_silver.png`; other colors map directly to `bed_COLOR.png`.

`kinds` identifies the imagery:

- `sprite`: actual standalone item sprite.
- `sprite-first-frame`: a static frame of a compass/clock, not a live direction/time indicator.
- `cube`: inherited unit-cube model, projected from its real top/north/east textures. Crafting tables retain their table faces; logs retain bark and end grain.
- `block-texture-preview`: an actual face texture from a noncube model, not a full inventory-model rendering. Shape, tint, overlays and model display transforms are not reproduced.
- `entity-texture-preview`: the chest front (lid, body, latch) or unpatterned shield plate from its actual entity atlas, not a full 3D model. Shield banner patterns are not available in inventory telemetry.
- `empty`: transparent air.

Model selection uses the item's model reference, inventory variants and actual blockstate model references. This includes fences, trapdoors, bee nests and waxed copper aliases. The renderer intentionally does not turn particle textures into icons. Banners, spawn eggs and other special-renderer items without suitable standalone sprites may remain unmapped. Animated textures use their first frame. Biome/dye-dependent model tinting and custom resource packs are not applied. The primary imagery set is 26.1; item names also support the bots' Java 1.21.4 `chain` spelling. Items absent from the manifest must remain text-labelled.

## Ownership

Minecraft graphics remain © Mojang AB / Microsoft, not this repository's code license. Local generation does not grant a redistribution license. This fan site's use remains subject to the [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines) and [EULA](https://www.minecraft.net/en-us/eula), reviewed 2026-11-01. Keep the site's independent ownership and non-affiliation notice visible:

> Not an official Minecraft service. Not approved by or associated with Mojang or Microsoft.
