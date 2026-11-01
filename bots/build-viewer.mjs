// Build the large upstream worker once, not inside each live HTTP request.
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { patchViewerHeightWorker } from './viewer-height.mjs';
import { patchViewerRevisionWorker } from './viewer-revisions.mjs';
import { patchViewerLightWorker } from './viewer-light.mjs';
import { patchChunkLightWorker } from './chunk-light.mjs';

const directory = new URL('./assets/', import.meta.url);
mkdirSync(directory, { recursive: true });
chmodSync(directory, 0o755);
const source = readFileSync('/opt/minecraft-mindcraft/node_modules/prismarine-viewer/public/worker.js', 'utf8');
const temporary = new URL('worker.js.tmp', directory);
writeFileSync(temporary, patchChunkLightWorker(patchViewerLightWorker(patchViewerRevisionWorker(patchViewerHeightWorker(source)))));
chmodSync(temporary, 0o644);
renameSync(temporary, new URL('worker.js', directory));
console.log('Built height-aware viewer worker.');
