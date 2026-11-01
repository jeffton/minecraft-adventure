# Minecraft Adventure server

Fresh normal-difficulty survival world; no old worlds are modified or restored.

- Paper 26.3 build 235, Java 25; ViaVersion and ViaBackwards 5.12.2 support older Mineflayer clients.
- Public Velocity 4.3.1 build 45: TCP 25565, Microsoft authentication required.
- Bot Velocity: `127.0.0.1:25567`, local offline identities only.
- Paper backend: `127.0.0.1:25566`, accepts HMAC-authenticated modern Velocity forwarding, not direct client logins.
- Human whitelist entries come from a required private JSON file. Four offline bot UUIDs are added during installation.
- Backend `online-mode=false` delegates authentication to the public proxy. Paper's proxy online-mode flag remains true to retain authenticated profile behavior. Local bot UUIDs are forwarded separately. Secure-profile enforcement is disabled on the backend for local bots; the public proxy still enforces authenticated client keys.

All Java processes run as the dedicated `minecraft-adventure` service account, never root. Root owns unit files. The forwarding secret is generated into private runtime files and is not stored in Git. No RCON or query listener is enabled. The only public Minecraft port is TCP 25565; both unauthenticated listeners bind loopback. Local processes are inside this trust boundary: an untrusted local account must not be given forwarding credentials or access to local bot identity paths.

Runtime: `/var/lib/minecraft-adventure/server`, `proxy-public`, `proxy-local`, and `bin`. Shared state: `control` and `observations`, group `minecraft-adventure-project`; do not give bot/planner/publisher accounts membership in private group `minecraft-adventure`.

The backend heap is 512–2304 MiB, with a 3 GiB cgroup ceiling. Each proxy has 32–128 MiB heap and 256 MiB ceiling. The Minecraft slice has a 4 GiB ceiling and low CPU/I/O weight; renderer and bots should join the same slice. View distance 6, simulation distance 5. Batty is outside that slice.

## Installation

`python3 install.py --whitelist /etc/minecraft-adventure/players.json` as root installs a fresh, stopped stack with SHA256-pinned downloads. It rejects an existing backend configuration. It does not open a firewall port, start services or replace worlds. Review source and security settings before activation. The request to host a Minecraft server authorizes accepting its EULA.

Units:

- `minecraft-adventure-server.service`
- `minecraft-adventure-proxy@local.service`
- `minecraft-adventure-proxy@public.service`
- `minecraft-adventure.slice`

Start the backend and local proxy, verify login/whitelist/direct-backend rejection, then enable the public proxy and allow only TCP 25565. Stop through systemd for graceful world saves. Existing worlds and backups are not modified.

Sources: [Paper forwarding](https://docs.papermc.io/velocity/player-information-forwarding/), [Velocity configuration](https://docs.papermc.io/velocity/configuration/), [ViaVersion 5.12.2](https://github.com/ViaVersion/ViaVersion/releases/tag/5.12.2), [ViaBackwards 5.12.2](https://github.com/ViaVersion/ViaBackwards/releases/tag/5.12.2).
