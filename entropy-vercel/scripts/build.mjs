import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const files = ['app.js', 'index.html', 'styles.css'];
const entries = await readdir(new URL('public/', root), { withFileTypes: true });
if (entries.length !== files.length || entries.some((entry) => !entry.isFile() || !files.includes(entry.name))) {
  throw new Error('Only the three reviewed public UI files may enter the static build.');
}
const destination = new URL('dist/', root);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const name of files) await cp(new URL('public/' + name, root), new URL(name, destination));
console.log('Built three public assets in ' + fileURLToPath(destination));
