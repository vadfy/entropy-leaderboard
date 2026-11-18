import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
test('deployment publishes static assets and just one bounded public function, without cron', async () => {
  const config = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'dist');
  assert.deepEqual(Object.keys(config.functions), ['api/leaderboard.js']);
  assert.equal(config.functions['api/leaderboard.js'].maxDuration, 20);
  assert.equal(config.functions['api/leaderboard.js'].supportsCancellation, true);
  assert.equal(config.crons, undefined);
  assert.equal(config.schedules, undefined);
  assert.deepEqual(await readdir(new URL('api/', root)), ['leaderboard.js']);
  assert.deepEqual((await readdir(new URL('public/', root))).sort(), ['app.js', 'index.html', 'styles.css']);
});
test('unchanged public UI keeps same-origin polling, creator posts and read-only language', async () => {
  const html = await readFile(new URL('public/index.html', root), 'utf8');
  const script = await readFile(new URL('public/app.js', root), 'utf8');
  assert.match(html, /Публічний перегляд/);
  assert.match(html, /Пости кріейтора/);
  assert.match(script, /fetch\('\/api\/leaderboard'/);
  assert.match(script, /if \(!same && state.selected\) state.pending = snapshot/);
  assert.match(script, /60000/);
  assert.doesNotMatch(script, /TWITTERAPI_IO_KEY|COMMUNITY_SYNC_SECRET|\/api\/workbench|\/internal\/sync/);
});
