# Explored world map

[Public map](https://minecraft.roybot.se/map/) · embedded in the adventure diary.

The embedded renderer mounts only when the map intersects the viewport and unloads when it leaves. Chrome’s proximity-based iframe lazy loading is not used. Offline bots use explicit colored location dots rather than missing Mojang skin images; their names and positions remain server-sourced.

BlueMap 5.29 supports Paper 26.3 and Java 25. It reads saved chunks without generating terrain. Each dimension has its own map; `min-inhabited-time: 1` excludes generated chunks that players have never visited. Visited means Minecraft's chunk habitation counter, not line-of-sight discovery. Nether's ceiling is cut away for navigation.

All connected players, including the four local bots, have live server-sourced markers. Selecting a player follows them; switching dimensions retains real world coordinates, not an Overworld/Nether coordinate conversion. Invisible/spectator players are also public on this deliberately public map.

## Installation and deployment

Run `python3 map/install.py` as root. It checks the official release SHA-256, installs the Paper plugin and configuration, and **does not restart Paper or alter world files**. Coordinate one graceful Paper restart with bot workers to activate it. The plugin inherits the existing nonroot Minecraft service user, 2304 MiB heap, 3 GiB memory ceiling and low-priority Minecraft slice.

Run `bash map/deploy.sh` to publish the map section, CSS and HTTPS proxy. It reloads nginx but never restarts Minecraft. The map listener binds `127.0.0.1:8100`; nginx exposes only GET/HEAD map assets and live data under `/map/`. No server directory, credentials, chat or command API is published.

Rendering uses one lowest-priority thread. Terrain refresh follows saved world changes with a 60-second regional cooldown; position updates use BlueMap's live stream. Initial rendering costs CPU and disk; subsequent updates are incremental. The client renders the isometric map with WebGL and supports pan, zoom, player following, separate dimensions and a full-screen page. Overworld caves below the surface are omitted to keep the map economical. Nether and End retain their geometry with ambient light so underground terrain stays visible.

## Verification

`python3 -m unittest discover -s map -p 'test_*.py'` checks deployment/configuration boundaries. `node --test map/test_*.mjs` reproduces the upstream camera-height failure and checks player-following, dimension resets and connection lifecycle. `map/test-live.mjs` runs the public map smoke using nonroot Chrome, verifying real rendered terrain, live markers, desktop/mobile layout and dimension separation. It requires the diary's installed Playwright dependency. `map/test-viewport-live.mjs` independently verifies zero map requests above the fold, actual terrain and decoded marker PNGs on entry, and destruction of the map document on exit at desktop/mobile widths.

BlueMap 5.29 skips terrain-height correction for tilted orthographic cameras. The small `isometric.js` hook supplies that missing calculation and sets dimension resets to an isometric projection; it does not modify game state or replace the renderer. `connection.js` closes each dimension’s event stream before BlueMap disposes that map, preventing stale tile events from dereferencing unloaded geometry. Its badge reports live, reconnecting and offline states.

Official sources: [release / compatibility / digest](https://github.com/BlueMap-Minecraft/BlueMap/releases/tag/v5.29), [configuration](https://bluemap.bluecolored.de/wiki/configs/), [performance](https://bluemap.bluecolored.de/wiki/customization/PerformanceTuning.html).

Squaremap and Pl3xMap prioritize flat 2D maps; Overviewer is an offline tile renderer without built-in live server players. BlueMap supplies the required isometric terrain and live players without a custom renderer or polling bridge.
