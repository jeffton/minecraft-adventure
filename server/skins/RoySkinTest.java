package roycraft.skin;

import com.velocitypowered.api.event.player.GameProfileRequestEvent;
import com.velocitypowered.api.util.GameProfile;
import com.velocitypowered.api.proxy.InboundConnection;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.UUID;

public final class RoySkinTest {
    public static void main(String[] args) {
        RoySkin plugin = new RoySkin();
        var other = new GameProfile.Property("other", "unchanged", "");
        var oldTexture = new GameProfile.Property("textures", "old", "old");
        var roy = new GameProfile(RoySkin.ROY, "Roy", List.of(other, oldTexture));
        var connection = (InboundConnection) Proxy.newProxyInstance(
            RoySkinTest.class.getClassLoader(), new Class<?>[] { InboundConnection.class },
            (proxy, method, arguments) -> { throw new AssertionError("Unexpected connection call"); }
        );
        var event = new GameProfileRequestEvent(connection, roy, false);
        plugin.onProfile(event);
        var result = event.getGameProfile();
        check(result.getId().equals(roy.getId()), "UUID changed");
        check(result.getName().equals(roy.getName()), "Name changed");
        check(result.getProperties().size() == 2, "Texture duplicated");
        check(result.getProperties().contains(other), "Other property lost");
        var texture = result.getProperties().stream()
            .filter(property -> property.getName().equals("textures")).findFirst().orElseThrow();
        check(texture.getValue().length() > 100, "Missing signed skin");
        check(texture.getSignature().length() > 100, "Missing signature");
        check(plugin.decorate(roy, true) == roy, "Online player affected");
        var human = new GameProfile(UUID.randomUUID(), "Roy", List.of());
        check(plugin.decorate(human, false) == human, "Different UUID affected");
        var camera = new GameProfile(RoySkin.ROY, "Camera", List.of());
        check(plugin.decorate(camera, false) == camera, "Different name affected");
        var again = plugin.decorate(result, false);
        check(again.getProperties().size() == 2, "Reconnect duplicates properties");
        System.out.println("PASS: real Velocity profile event, identity isolation and idempotence");
    }

    private static void check(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
