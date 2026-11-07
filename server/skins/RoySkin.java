package roycraft.skin;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.player.GameProfileRequestEvent;
import com.velocitypowered.api.util.GameProfile;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.Properties;
import java.util.UUID;

/** Local-proxy-only profile decoration; authentication and identity stay unchanged. */
public final class RoySkin {
    static final UUID ROY = UUID.fromString("0b14879a-cd6c-348a-8d93-cbc2a12f4aea");
    private final GameProfile.Property texture;

    public RoySkin() {
        Properties data = new Properties();
        try (var input = RoySkin.class.getResourceAsStream("/roy-texture.properties")) {
            data.load(input);
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
        texture = new GameProfile.Property(
            "textures", data.getProperty("value"), data.getProperty("signature")
        );
    }

    GameProfile decorate(GameProfile profile, boolean onlineMode) {
        if (onlineMode || !profile.getId().equals(ROY) || !profile.getName().equals("Roy")) {
            return profile;
        }
        var properties = new ArrayList<>(profile.getProperties());
        properties.removeIf(property -> property.getName().equals("textures"));
        properties.add(texture);
        return profile.withProperties(properties);
    }

    @Subscribe
    public void onProfile(GameProfileRequestEvent event) {
        event.setGameProfile(decorate(event.getGameProfile(), event.isOnlineMode()));
    }
}
