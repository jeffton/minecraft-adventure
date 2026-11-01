import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Run as root at installation, never with model-controlled paths or code. */
export function prepareSandboxRoot(root, nodePath = '/usr/bin/node') {
  mkdirSync(root, { recursive: true, mode: 0o755 });
  chmodSync(root, 0o755);
  const ensureDirectory = path => {
    mkdirSync(path, { recursive: true, mode: 0o755 });
    let current = root;
    for (const part of relative(root, path).split('/').filter(Boolean)) {
      current = join(current, part);
      chmodSync(current, 0o755);
    }
  };
  const copy = (source, destination) => {
    ensureDirectory(dirname(join(root, destination)));
    copyFileSync(realpathSync(source), join(root, destination));
    chmodSync(join(root, destination), 0o555);
  };
  copy(nodePath, '/usr/bin/node');
  const libraries = execFileSync('/usr/bin/ldd', [nodePath], { encoding: 'utf8' });
  for (const line of libraries.split('\n')) {
    const library = line.match(/(?:=>\s*)?(\/\S+)/)?.[1];
    if (library) copy(library, library);
  }
  copy(fileURLToPath(new URL('./sandbox-worker.mjs', import.meta.url)), '/worker.mjs');
  for (const path of ['tmp', 'proc', 'dev']) ensureDirectory(join(root, path));
  return root;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.getuid() !== 0) throw new Error('Sandbox installation requires root');
  const root = process.argv[2] ?? '/var/lib/minecraft-player-sandbox/root';
  prepareSandboxRoot(root);
  console.log(`Prepared runtime-only root: ${root}`);
}
