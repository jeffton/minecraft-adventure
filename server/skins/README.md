# Roy's skin

Original classic-arm 64×64 pixel art: platinum hair, blue eyes, dark leather jacket, raised collar, silver cuffs and a white dove on the back. `build-skin.py` reproduces `roy-batty.png` (Python/Pillow). The artwork is inspired by Roy Batty; no third-party skin was copied.

`roy-texture.properties` contains public Mojang-signed texture data, generated through MineSkin on 7 November 2026 (unlisted skin `a979f1f3c79642859b227adb92b8079c`). Its signature was verified against Minecraft Services' profile-property public keys. It is not an authentication credential. The signed texture matches the PNG; changing the PNG requires signing it again.

`RoySkin.java` decorates only the offline UUID/name pair for Roy. It preserves identity and non-texture properties. It belongs **only in the local Velocity proxy**, not Paper or the public proxy.

Build and test using Java 25 and the installed Velocity 4.3.1 JAR:

```sh
bash server/skins/build.sh
install -o minecraft-adventure -g minecraft-adventure -m 0640 \
  /tmp/roycraft-skin.jar \
  /var/lib/minecraft-adventure/proxy-local/plugins/roycraft-skin.jar
```

Coordinate a local-proxy restart with the player deployment. This disconnects local bots; Paper, the public proxy, worlds and player data stay untouched. The skin is attached on every subsequent Roy login. No network call or MineSkin key is needed at login.

Reference: [Velocity profile event](https://jd.papermc.io/velocity/3.4.0/com/velocitypowered/api/event/player/GameProfileRequestEvent.html), [MineSkin API](https://docs.mineskin.org/docs/intro/).
