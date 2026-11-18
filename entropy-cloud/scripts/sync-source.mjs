import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.resolve(root, '../entropy-app');
const source = path.join(root, 'source');
await mkdir(source, { recursive: true });
await mkdir(path.join(root, 'lib'), { recursive: true });
await mkdir(path.join(root, 'public'), { recursive: true });
const available = await access(path.join(app, 'app.js')).then(() => true).catch(() => false);
if (available) {
  for (const name of ['index.html','styles.css','scoring.js','model.js','app.js','seed.js','seed.json']) {
    await copyFile(path.join(app, name), path.join(root, 'public', name));
  }
  for (const name of ['model.js','scoring.js','twitterapi.mjs','live-engine.mjs','backfill.mjs','relevance.mjs','seed.json']) {
    let content = await readFile(path.join(app, name), 'utf8');
    content = content.replaceAll("'./model.js'", "'./model.cjs'").replaceAll("'./scoring.js'", "'./scoring.cjs'");
    const filename = name.endsWith('.js') ? name.slice(0, -3) + '.cjs' : name;
    await writeFile(path.join(source, filename), content);
  }
}
const entry = `import Model from './model.cjs';\nimport {createClient} from './twitterapi.mjs';\nimport {advanceSync,advanceHourlyDiscovery,mergeDataset,normalizeDiscoveryPage} from './live-engine.mjs';\nimport {beginBackfill,advanceBackfill} from './backfill.mjs';\nimport seed from './seed.json';\nexport {Model,createClient,advanceSync,advanceHourlyDiscovery,mergeDataset,normalizeDiscoveryPage,beginBackfill,advanceBackfill,seed};\n`;
await writeFile(path.join(source, 'entry.mjs'), entry);
await build({ entryPoints: [path.join(source, 'entry.mjs')], outfile: path.join(root, 'lib/entropy-engine.mjs'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'warning' });
const html = await readFile(path.join(root, 'public/index.html'), 'utf8');
await writeFile(path.join(root, 'lib/entropy-html.ts'), 'export default ' + JSON.stringify(html) + ';\n');
console.log('Prepared existing Ukrainian interface and server-only sync engine.');
