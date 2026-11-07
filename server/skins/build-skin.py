#!/usr/bin/env python3
"""Paint Roy's original classic (4-pixel arms) Java skin, in native UV space."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).parent
im = Image.new('RGBA', (64, 64))
draw = ImageDraw.Draw(im)
SKIN = '#d7b59c'
HAIR = '#e4e5d9'
DARK = '#19212b'
EDGE = '#34414c'


def box(x, y, w, h, color):
    draw.rectangle((x, y, x + w - 1, y + h - 1), fill=color)


def cube(u, v, w, h, d, color):
    # Standard Java UV net: right/front/left/back; top/bottom above it.
    box(u + d, v, w * 2, d, color)
    box(u, v + d, d * 2 + w * 2, h, color)


cube(0, 0, 8, 8, 8, SKIN)
cube(16, 16, 8, 12, 4, DARK)
cube(40, 16, 4, 12, 4, DARK)
cube(32, 48, 4, 12, 4, DARK)
cube(0, 16, 4, 12, 4, '#252c36')
cube(16, 48, 4, 12, 4, '#252c36')
# Platinum hair, including every side and the crown; short sides, swept fringe.
box(8, 0, 16, 8, HAIR)
for x in (0, 8, 16, 24):
    box(x, 8, 8, 2, HAIR)
box(24, 10, 8, 4, '#c8ccc5')
box(0, 10, 7, 2, '#bcc3c1')
box(17, 10, 7, 2, '#bcc3c1')
for x, y in ((8, 10), (9, 10), (10, 10), (13, 10), (14, 10), (15, 11)):
    box(x, y, 1, 1, '#f3f0df')
# Face: cold blue eyes, defined brow, nose, mouth and asymmetric scar.
box(9, 11, 2, 1, '#897a6c')
box(13, 11, 2, 1, '#897a6c')
box(9, 12, 2, 1, '#e5e7dc')
box(13, 12, 2, 1, '#e5e7dc')
box(10, 12, 1, 1, '#547e8d')
box(13, 12, 1, 1, '#547e8d')
box(11, 13, 2, 1, '#bd947c')
box(11, 14, 3, 1, '#936e60')
box(10, 15, 4, 1, '#c6a58c')
box(15, 13, 1, 2, '#ac7c72')
# Ears.
box(5, 12, 2, 2, '#c39c82')
box(17, 12, 2, 2, '#c39c82')
# Front jacket and ribbed charcoal shirt, high asymmetric lapels.
box(22, 20, 4, 8, '#343c40')
for y in (22, 24, 26):
    box(23, y, 2, 1, '#465056')
for x, y in ((20, 20), (21, 21), (21, 22), (22, 23), (27, 20), (26, 21), (26, 22)):
    box(x, y, 1, 2, EDGE)
box(20, 28, 8, 1, '#101720')
box(23, 28, 2, 1, '#a1aaab')
box(20, 30, 2, 2, EDGE)
box(26, 30, 2, 2, EDGE)
# Back panels and understated off-white dove emblem.
box(34, 21, 1, 10, EDGE)
box(37, 21, 1, 10, '#27323d')
for x, y in ((33, 23), (34, 24), (35, 25), (36, 24), (37, 23), (36, 25)):
    box(x, y, 1, 1, '#d6dedb')
# Sleeves, exposed hands, cuffs, silver hardware. Both arms are independent.
for u, v in ((40, 16), (32, 48)):
    box(u, v + 4, 16, 2, '#303d48')
    box(u, v + 12, 16, 1, '#080e16')
    box(u, v + 13, 16, 3, SKIN)
    box(u + 4, v + 11, 4, 1, '#596971')
    box(u + 5, v + 12, 2, 1, '#a6b3b7')
    box(u + 8, v, 4, 4, SKIN)
# Boots and trouser seams, all four side faces and soles.
for u, v in ((0, 16), (16, 48)):
    box(u, v + 12, 16, 4, '#101720')
    box(u + 4, v + 12, 4, 1, '#57636a')
    box(u + 5, v + 14, 2, 1, '#303c49')
    box(u + 8, v, 4, 4, '#0b1018')
    box(u + 4, v + 5, 1, 6, '#3a424a')
# Outer layers: raised collar and subtle shoulder/coat seams, not a solid helmet.
for x in (40, 47):
    box(x, 14, 1, 2, '#242e37')
box(40, 15, 8, 1, '#242e37')
box(20, 36, 2, 2, EDGE)
box(26, 36, 2, 2, EDGE)
box(20, 45, 1, 3, '#38444f')
box(27, 45, 1, 3, '#38444f')
box(44, 36, 4, 1, '#56636e')
box(52, 52, 4, 1, '#56636e')
OUT.mkdir(parents=True, exist_ok=True)
im.save(OUT / 'roy-batty.png')
# A nearest-neighbour sheet is a human-readable asset, not the Java texture.
im.resize((512, 512), Image.Resampling.NEAREST).save('/tmp/roy-batty-sheet.png')
print(OUT / 'roy-batty.png')
