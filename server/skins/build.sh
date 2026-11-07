#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
velocity="${1:-/var/lib/minecraft-adventure/bin/velocity.jar}"
output="$(mktemp -d)"
trap 'trash "$output"' EXIT
javac -proc:none -cp "$velocity" -d "$output" RoySkin.java RoySkinTest.java
cp velocity-plugin.json roy-texture.properties "$output/"
java -cp "$output:$velocity" roycraft.skin.RoySkinTest
jar --create --file "$output/roycraft-skin.jar" -C "$output" roycraft/skin/RoySkin.class -C "$output" velocity-plugin.json -C "$output" roy-texture.properties
install -m 0644 "$output/roycraft-skin.jar" /tmp/roycraft-skin.jar
printf 'Built /tmp/roycraft-skin.jar\n'
