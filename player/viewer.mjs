import '../bots/compat-loader.mjs';
import { registerHooks } from 'node:module';
import { minecraftLighting } from '../bots/viewer-lightmap.mjs';
import { trackViewerLightColumns, installViewerLightStream, patchViewerLightServer, patchViewerLightClient, createViewerLightMaterial, installViewerLightClient } from '../bots/viewer-light.mjs';
export { trackViewerLightColumns };
import { readyScript, patchViewerClient } from '../bots/viewer-readiness.mjs';
import { patchViewerServer, viewerState, createCameraMotion } from '../bots/viewer-stream.mjs';
import { patchViewerEntities, viewerEntityModel } from '../bots/viewer-entities.mjs';
import { patchViewerHeightClient } from '../bots/viewer-height.mjs';
import { patchViewerRevisionClient } from '../bots/viewer-revisions.mjs';
import { viewerAllowed } from '../bots/viewer-policy.mjs';
import { installViewerBreaking, patchViewerBreakingServer } from '../bots/viewer-breaking.mjs';
import { patchViewerBreakingClient, createViewerBreakingClient } from '../bots/viewer-breaking-client.mjs';

// Only the read-only renderer is retained from the previous bot runtime.
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Viewer integration point changed');
  return source.replace(before, after);
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.includes('/prismarine-viewer/lib/')) return result;
    let source = String(result.source);
    if (url.endsWith('/mineflayer.js')) {
      source = patchViewerServer(patchViewerLightServer(patchViewerBreakingServer(source, installViewerBreaking.toString()), installViewerLightStream.toString()), viewerState.toString());
      source = replace(source, "io.on('connection', (socket) => {", `io.on('connection', (socket) => {
        const isPublic = socket.handshake.headers['x-roycraft-public-viewer'] === '1';
        socket.data.roycraftPublic = isPublic;
        if (!(${viewerAllowed.toString()})(isPublic, sockets.map(s => s.data.roycraftPublic))) { socket.disconnect(true); return }`);
    } else if (url.endsWith('/common.js')) {
      const index = '/opt/minecraft-mindcraft/node_modules/prismarine-viewer/public/index.html';
      source = replace(source, 'app.use(compression())', `app.use(compression())
        app.use(prefix + '/entity-assets', express.static('/opt/minecraft-adventure/bots/assets/entities'))
        app.use(prefix + '/item-assets', express.static('/var/www/roybot.se/minecraft/item-assets'))
        app.get(prefix + '/', (req, res) => res.type('html').send(require('fs').readFileSync(${JSON.stringify(index)}, 'utf8').replace('<body>', '<body>' + ${JSON.stringify(readyScript)})))
        app.get(prefix + '/index.js', (req, res) => res.type('js').send((${patchViewerBreakingClient.toString()})((${patchViewerRevisionClient.toString()})((${patchViewerHeightClient.toString()})((${patchViewerClient.toString()})((${patchViewerLightClient.toString()})((${patchViewerEntities.toString()})(require('fs').readFileSync(${JSON.stringify(index.replace('index.html', 'index.js'))}, 'utf8'), ${JSON.stringify(viewerEntityModel.toString())}), ${JSON.stringify(createViewerLightMaterial.toString())}, ${JSON.stringify(installViewerLightClient.toString())}, ${JSON.stringify(minecraftLighting.toString())}), ${JSON.stringify(createCameraMotion.toString())}))), ${JSON.stringify(createViewerBreakingClient.toString())})))
        app.get(prefix + '/worker.js', (req, res) => res.sendFile('/opt/minecraft-adventure/bots/assets/worker.js'))`);
    }
    return { ...result, source };
  },
});
