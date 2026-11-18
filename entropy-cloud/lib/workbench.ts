import { env } from 'cloudflare:workers';
import { Model, createClient, advanceSync, advanceHourlyDiscovery, beginBackfill, advanceBackfill, normalizeDiscoveryPage, mergeDataset, seed } from './entropy-engine.mjs';
import { projectCommunitySnapshot, publishCommunitySnapshot } from './community-projection';

type ObjectValue = Record<string, any>;
type StoredRow = { generation: string; revision: number; updated_at: string; lease_token: string | null; lease_until: number; daily_date: string; daily_attempts: number; kind: string; record_id: string; chunk_index: number; payload: string };
type EntityRow = { kind: string; id: string; chunk: number; payload: string };
export type Workbench = { dataset: ObjectValue; state: ObjectValue; revision: number; sync: ObjectValue; updatedAt: string };
const DAILY_LIMIT = 288;
const CATCHUP_DAILY_LIMIT = DAILY_LIMIT - 24;
const LEASE_MS = 120000;
const BACKFILL_SPACING_MS = 5100;
const CHUNK_UNITS = 128000;
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;
const STATE_MAPS = ['bans', 'periodDecisions', 'postExclusions', 'postRelevance', 'accountReviews', 'identityEvidence'];
const ENCODER = new TextEncoder();

export class WorkbenchError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'WorkbenchError'; }
}
function invalid(message = 'The submitted data is invalid.'): never { throw new WorkbenchError(400, 'INVALID_INPUT', message); }
function db(): D1Database {
  if (!env.DB) throw new WorkbenchError(503, 'STORE_UNAVAILABLE', 'Cloud storage is unavailable.');
  return env.DB;
}
function providerKey(): string | null {
  const value = (env as unknown as { TWITTERAPI_IO_KEY?: string }).TWITTERAPI_IO_KEY;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function connection() { return { configured: providerKey() !== null, keySource: providerKey() ? 'environment' : 'none' }; }
function validatedState(raw: unknown): ObjectValue { try { return Model.validateState(raw); } catch { return invalid('The saved decisions are invalid.'); } }
function validatedDataset(raw: unknown): ObjectValue { try { return Model.validateDataset(raw); } catch { return invalid('The dataset is invalid.'); } }
function expected(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return invalid('A current expectedRevision is required.');
  return Number(value);
}
function assertRevision(workbench: Workbench, value: unknown) {
  if (workbench.revision !== expected(value)) throw new WorkbenchError(409, 'CONFLICT', 'The workbench changed. Reload it before retrying.');
}

export function splitPayload(value: unknown): string[] {
  const text = JSON.stringify(value);
  if (text === undefined) return invalid();
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHUNK_UNITS, text.length);
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
}
function recordsFor(workbench: Workbench): EntityRow[] {
  const rows: EntityRow[] = [];
  let bytes = 0;
  const add = (kind: string, id: string, value: unknown) => splitPayload(value).forEach((payload, chunk) => {
    bytes += ENCODER.encode(payload).byteLength;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new WorkbenchError(413, 'TOO_LARGE', 'The workbench exceeds this version’s storage limit.');
    rows.push({ kind, id, chunk, payload });
  });
  add('dataset-meta', 'main', workbench.dataset.meta);
  for (const [kind, key] of [['author', 'authors'], ['post', 'posts'], ['account', 'accounts']] as const) for (const value of workbench.dataset[key]) add(kind, value.id, value);
  workbench.dataset.followRelations.forEach((value: unknown, i: number) => add('follow', String(i).padStart(8, '0'), value));
  workbench.dataset.interactions.forEach((value: unknown, i: number) => add('interaction', String(i).padStart(8, '0'), value));
  add('state-meta', 'main', { version: 1, ui: workbench.state.ui });
  for (const name of STATE_MAPS) for (const [id, value] of Object.entries(workbench.state[name] || {})) add('state:' + name, id, value);
  workbench.state.audit.forEach((value: unknown, i: number) => add('audit', String(i).padStart(8, '0'), value));
  add('sync', 'main', workbench.sync);
  return rows;
}
function assemble(rows: StoredRow[]): Workbench {
  if (!rows.length) throw new WorkbenchError(503, 'STORE_UNAVAILABLE', 'Cloud storage is not initialized.');
  const groups = new Map<string, { kind: string; id: string; chunks: { index: number; text: string }[] }>();
  for (const row of rows) {
    const key = JSON.stringify([row.kind, row.record_id]);
    if (!groups.has(key)) groups.set(key, { kind: row.kind, id: row.record_id, chunks: [] });
    groups.get(key)!.chunks.push({ index: row.chunk_index, text: row.payload });
  }
  const dataset: ObjectValue = { meta: {}, authors: [], posts: [], accounts: [], followRelations: [], interactions: [] };
  let state: ObjectValue = Model.initialState(), sync: ObjectValue = {};
  let metadataFound = false;
  for (const group of groups.values()) {
    group.chunks.sort((a, b) => a.index - b.index);
    if (group.chunks.some((value, index) => value.index !== index)) throw new WorkbenchError(503, 'STORE_UNAVAILABLE', 'A stored record is incomplete.');
    const value = JSON.parse(group.chunks.map(c => c.text).join(''));
    switch (group.kind) {
      case 'dataset-meta': dataset.meta = value; metadataFound = true; break;
      case 'author': dataset.authors.push(value); break;
      case 'post': dataset.posts.push(value); break;
      case 'account': dataset.accounts.push(value); break;
      case 'follow': dataset.followRelations.push(value); break;
      case 'interaction': dataset.interactions.push(value); break;
      case 'state-meta': state = { ...state, ...value }; break;
      case 'audit': state.audit.push(value); break;
      case 'sync': sync = value; break;
      default: if (group.kind.startsWith('state:') && STATE_MAPS.includes(group.kind.slice(6))) state[group.kind.slice(6)][group.id] = value;
    }
  }
  if (!metadataFound) throw new WorkbenchError(503, 'STORE_UNAVAILABLE', 'Stored metadata is missing.');
  return { dataset: Model.validateDataset(dataset), state: Model.validateState(state), sync, revision: rows[0].revision, updatedAt: rows[0].updated_at };
}
async function stage(database: D1Database, generation: string, workbench: Workbench) {
  const rows = recordsFor(workbench), now = Date.now();
  for (let offset = 0; offset < rows.length; offset += 50) {
    const statements = rows.slice(offset, offset + 50).map(row => database.prepare('INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at) VALUES (?,?,?,?,?,?)').bind(generation, row.kind, row.id, row.chunk, row.payload, now));
    await database.batch(statements);
  }
}
async function initialize(database: D1Database) {
  const generation = crypto.randomUUID(), now = new Date().toISOString();
  const workbench: Workbench = { dataset: Model.validateDataset(seed), state: Model.initialState(), revision: 0, updatedAt: now,
    sync: { version: 1, source: 'twitterapi.io', target: 'entropyIO', enabled: false, paused: false, intervalMs: 300000, status: 'disabled', requestCount: 0, lastAttemptAt: null, lastSuccessAt: null, lastDataAt: null, lastError: null, gaps: [] } };
  await stage(database, generation, workbench);
  await database.prepare('INSERT OR IGNORE INTO entropy_control (id,generation,revision,updated_at,lease_until,daily_date,daily_attempts) VALUES (?,?,?,?,?,?,?)').bind('main', generation, 0, now, 0, '', 0).run();
}
async function readRows(database: D1Database): Promise<StoredRow[]> {
  const result = await database.prepare('SELECT c.generation,c.revision,c.updated_at,c.lease_token,c.lease_until,c.daily_date,c.daily_attempts,r.kind,r.record_id,r.chunk_index,r.payload FROM entropy_control c JOIN entropy_records r ON r.generation=c.generation WHERE c.id=? ORDER BY r.kind,r.record_id,r.chunk_index').bind('main').all<StoredRow>();
  return result.results || [];
}
async function loadInternal() {
  const database = db();
  try {
    let rows = await readRows(database);
    if (!rows.length) { await initialize(database); rows = await readRows(database); }
    return { database, workbench: assemble(rows), control: rows[0] };
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(503, 'STORE_UNAVAILABLE', 'Cloud storage could not be read.');
  }
}
function external(workbench: Workbench, control: Pick<StoredRow, 'daily_date' | 'daily_attempts' | 'lease_until' | 'lease_token'>) {
  const today = new Date().toISOString().slice(0, 10);
  const hourly = workbench.sync.hourly;
  const catchupDue = hourly?.pendingWindows?.length
    ? new Date(Math.max(Date.parse(hourly.nextAttemptAt || hourly.catchupNextAttemptAt) || 0, Date.parse(workbench.updatedAt) + BACKFILL_SPACING_MS)).toISOString() : null;
  const lastDiscovery = Date.parse(hourly?.lastSuccessAt) || 0;
  const freshness = !workbench.sync.enabled ? 'disabled' : workbench.sync.paused ? 'paused' : hourly?.lastError ? 'error'
    : !lastDiscovery ? 'not-started' : Date.now() - lastDiscovery > 90 * 60000 ? 'stale' : 'current';
  return { ...workbench, mode: 'cloud', connection: connection(), sync: { ...workbench.sync,
    ...(hourly ? { hourly: { ...hourly, nextAttemptAt: catchupDue, catchupNextAttemptAt: catchupDue } } : {}),
    collectionHealth: { policy: 'new-mentions-first', intervalMinutes: 60, freshness,
      lastDiscoveryAttemptAt: hourly?.lastAttemptAt || null, lastDiscoverySuccessAt: hourly?.lastSuccessAt || null,
      pendingDiscoveryWindows: hourly?.pendingWindows?.length || 0, catchupDailyLimit: CATCHUP_DAILY_LIMIT },
    collectorBusyUntil: control.lease_token && control.lease_until > Date.now() ? new Date(control.lease_until).toISOString() : null,
    ...(workbench.sync.backfill ? { backfill: { ...workbench.sync.backfill,
      nextStepAt: new Date(Math.max(Date.parse(workbench.sync.backfill.nextAttemptAt) || 0, Date.parse(workbench.updatedAt) + BACKFILL_SPACING_MS)).toISOString(),
      totalRequests: workbench.sync.backfill.requestCount || 0 } } : {}),
    usage: { date: today, attempts: control.daily_date === today ? control.daily_attempts : 0, dailyLimit: DAILY_LIMIT },
    attemptBudget: { day: today, count: control.daily_date === today ? control.daily_attempts : 0, limit: DAILY_LIMIT } } };
}
export async function getWorkbench() { const value = await loadInternal(); return external(value.workbench, value.control); }
function communityConfiguration() {
  const settings = env as unknown as { COMMUNITY_VIEWER_URL?: string; COMMUNITY_SYNC_SECRET?: string };
  return { url: settings.COMMUNITY_VIEWER_URL, secret: settings.COMMUNITY_SYNC_SECRET };
}
export async function getCommunityPreview() {
  const { workbench } = await loadInternal();
  return projectCommunitySnapshot(workbench);
}
export async function syncCommunitySnapshot() {
  const { workbench } = await loadInternal();
  return publishCommunitySnapshot(workbench, communityConfiguration());
}
export async function getStatus() {
  const value = await getWorkbench();
  return { revision: value.revision, updatedAt: value.updatedAt, mode: value.mode, connection: value.connection,
    sync: value.sync, authors: value.dataset.authors.length, posts: value.dataset.posts.length };
}
async function commit(database: D1Database, current: Workbench, next: Workbench, leaseToken: string | null = null) {
  const now = Date.now(), at = new Date(now).toISOString();
  const validated: Workbench = { ...next, dataset: validatedDataset(next.dataset), state: validatedState(next.state), revision: current.revision + 1, updatedAt: at };
  const control = await database.prepare('SELECT generation FROM entropy_control WHERE id=? AND revision=?').bind('main', current.revision).first<{ generation: string }>();
  if (!control) throw new WorkbenchError(409, 'CONFLICT', 'The workbench changed. Reload it before retrying.');
  const key = (row: EntityRow) => JSON.stringify([row.kind, row.id, row.chunk]);
  const before = new Map(recordsFor(current).map(row => [key(row), row]));
  const after = new Map(recordsFor(validated).map(row => [key(row), row]));
  const changed = [...after].filter(([id, row]) => before.get(id)?.payload !== row.payload).map(([, row]) => row);
  const removed = [...before].filter(([id]) => !after.has(id)).map(([, row]) => row);
  const guard = leaseToken
    ? 'id=? AND revision=? AND generation=? AND lease_token=? AND lease_until>?'
    : 'id=? AND revision=? AND generation=? AND (lease_token IS NULL OR lease_until<=?)';
  const guardArgs = leaseToken ? ['main', current.revision, control.generation, leaseToken, now] : ['main', current.revision, control.generation, now];
  if (changed.length + removed.length <= 400) {
    // D1.batch is a transaction. Each row is guarded against the same control
    // revision and the revision changes last, so stale writers change no rows.
    // A twenty-post page writes only that page instead of the entire dataset.
    const statements = changed.map(row => database.prepare('INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM entropy_control WHERE ' + guard + ') ON CONFLICT(generation,kind,record_id,chunk_index) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at').bind(control.generation, row.kind, row.id, row.chunk, row.payload, now, ...guardArgs));
    statements.push(...removed.map(row => database.prepare('DELETE FROM entropy_records WHERE generation=? AND kind=? AND record_id=? AND chunk_index=? AND EXISTS (SELECT 1 FROM entropy_control WHERE ' + guard + ')').bind(control.generation, row.kind, row.id, row.chunk, ...guardArgs)));
    statements.push(database.prepare('UPDATE entropy_control SET revision=revision+1,updated_at=?,lease_token=NULL,lease_until=0 WHERE ' + guard).bind(at, ...guardArgs));
    const results = await database.batch(statements);
    if (results.at(-1)?.meta.changes !== 1) throw new WorkbenchError(409, 'CONFLICT', 'The workbench changed. Reload it before retrying.');
  } else {
    // Large explicit imports use a new staged generation. Routine ingestion
    // and moderation stay on the small atomic-diff path above.
    const generation = crypto.randomUUID();
    await stage(database, generation, validated);
    const result = await database.prepare('UPDATE entropy_control SET generation=?,revision=revision+1,updated_at=?,lease_token=NULL,lease_until=0 WHERE ' + guard).bind(generation, at, ...guardArgs).run();
    if (result.meta.changes !== 1) throw new WorkbenchError(409, 'CONFLICT', 'The workbench changed. Reload it before retrying.');
  }
  // Cleanup is bounded and only touches old, unreferenced generations. Readers
  // retrieve control and records in one SQLite statement, never a mixed snapshot.
  await database.prepare('DELETE FROM entropy_records WHERE rowid IN (SELECT rowid FROM entropy_records WHERE created_at<? AND generation<>(SELECT generation FROM entropy_control WHERE id=?) LIMIT 1000)').bind(now - 3600000, 'main').run().catch(() => {});
  // Only the server-built public projection crosses the private Site boundary.
  // The receiver ignores older revisions; failed delivery leaves this commit intact.
  await publishCommunitySnapshot(validated, communityConfiguration());
  return getWorkbench();
}
function assertNotBusy(control: StoredRow) {
  if (control.lease_token && control.lease_until > Date.now()) throw new WorkbenchError(423, 'SYNC_BUSY', 'An update is in progress. Try again shortly.');
}
export async function saveState(rawState: unknown, expectedRevision: unknown, actorId: string) {
  const { database, workbench, control } = await loadInternal();
  assertRevision(workbench, expectedRevision); assertNotBusy(control);
  const state = validatedState(rawState);
  state.identityEvidence = workbench.state.identityEvidence;
  const existingEvents = new Set(workbench.state.audit.map((event: ObjectValue) => event.id));
  state.audit = state.audit.map((event: ObjectValue) => existingEvents.has(event.id) ? event : { ...event, actorUserId: actorId });
  return commit(database, workbench, { ...workbench, state });
}
export async function importWorkbench(payload: ObjectValue) {
  const { database, workbench, control } = await loadInternal();
  assertRevision(workbench, payload.expectedRevision); assertNotBusy(control);
  if (workbench.sync.enabled) throw new WorkbenchError(400, 'COLLECTOR_ACTIVE', 'Stop the collector before importing a replacement dataset.');
  const dataset = validatedDataset(payload.dataset);
  // Replacing a backup cannot turn a known reply/repost into a counted original
  // merely by omitting its type fields. Keep positive evidence for the same ID.
  const knownPosts = new Map(workbench.dataset.posts.map((post: ObjectValue) => [post.id, post]));
  for (const post of dataset.posts as ObjectValue[]) {
    const previous = knownPosts.get(post.id) as ObjectValue | undefined;
    if (!previous) continue;
    // A replacement cannot bypass review by dropping its stored relevance facts.
    if (previous.relevance) post.relevance = structuredClone(previous.relevance);
    if (previous.discoveryLanes) post.discoveryLanes = structuredClone(previous.discoveryLanes);
    const kind = Model.postEligibility(previous);
    if (kind.reason === 'reply') {
      post.isReply = true;
      if (previous.inReplyToId !== null && previous.inReplyToId !== undefined) post.inReplyToId = previous.inReplyToId;
    } else if (kind.reason === 'repost') post.isRepost = true;
  }
  let candidate = payload.isBackup === true ? validatedState(payload.state) : workbench.state;
  candidate = { ...candidate, identityEvidence: { ...candidate.identityEvidence, ...workbench.state.identityEvidence } };
  let state: ObjectValue;
  try { state = Model.reconcileImport(workbench.dataset, dataset, candidate); }
  catch { return invalid('The import conflicts with saved creator identity evidence or decisions.'); }
  const sync = { ...workbench.sync, enabled: false, paused: false, status: 'disabled',
    phase: dataset.authors.some((author: ObjectValue) => author.id.startsWith('sample:')) ? 'refresh' : 'discovery',
    discovery: { pendingWindows: [], coveredThrough: null }, refresh: { pendingIds: [], cycleStartedAt: null },
    lastAttemptAt: null, lastSuccessAt: null, lastDataAt: null, lastError: null, nextRunAt: null, gaps: [],
    backfill: null, hourly: null, metricsRefresh: null, lastImportAt: new Date().toISOString() };
  return commit(database, workbench, { ...workbench, dataset, state, sync });
}
export async function setCollector(enabled: unknown, expectedRevision?: unknown, allowUnversioned = false) {
  if (typeof enabled !== 'boolean') return invalid('enabled must be a boolean.');
  const { database, workbench, control } = await loadInternal();
  if (!allowUnversioned) assertRevision(workbench, expectedRevision);
  assertNotBusy(control);
  if (enabled && !providerKey()) throw new WorkbenchError(400, 'KEY_REQUIRED', 'Configure the server’s TWITTERAPI_IO_KEY secret first.');
  const sync = { ...workbench.sync, enabled, paused: false, status: enabled ? 'waiting' : 'disabled', lastError: null,
    nextRunAt: enabled ? new Date().toISOString() : workbench.sync.nextRunAt || null };
  return commit(database, workbench, { ...workbench, sync });
}
export async function runSync(expectedRevision?: unknown, force = false) {
  const { database, workbench, control } = await loadInternal();
  if (expectedRevision !== undefined) assertRevision(workbench, expectedRevision);
  const secret = providerKey(), now = Date.now(), at = new Date(now).toISOString(), today = at.slice(0, 10);
  if (force) {
    if (!secret) throw new WorkbenchError(400, 'KEY_REQUIRED', 'Configure the server’s TWITTERAPI_IO_KEY secret first.');
    if (!workbench.sync.enabled) throw new WorkbenchError(400, 'COLLECTOR_DISABLED', 'Enable the collector before updating.');
    if (workbench.sync.paused) throw new WorkbenchError(400, 'COLLECTOR_PAUSED', 'Resume the collector before updating.');
    workbench.sync.nextRunAt = new Date(Math.floor(now / 1000) * 1000).toISOString();
    if (workbench.sync.hourly) workbench.sync.hourly.nextRunAt = workbench.sync.nextRunAt;
  }
  if (!secret || !workbench.sync.enabled || workbench.sync.paused) return external(workbench, control);
  // Each hourly call starts with the newest time window. Neither an old cursor,
  // historical job nor a slow metrics endpoint may take this slot.
  if (Date.parse(workbench.sync.hourly?.nextRunAt || workbench.sync.nextRunAt) > now) return external(workbench, control);
  assertNotBusy(control);
  const token = crypto.randomUUID();
  // Claim the lease AND reserve an attempt in one durable SQL operation before
  // constructing a provider client. A crash cannot erase spent daily allowance.
  const claim = await database.prepare('UPDATE entropy_control SET lease_token=?,lease_until=?,daily_attempts=CASE WHEN daily_date=? THEN daily_attempts+1 ELSE 1 END,daily_date=?,updated_at=? WHERE id=? AND revision=? AND (lease_token IS NULL OR lease_until<=?) AND (daily_date<>? OR daily_attempts<?)').bind(token, now + LEASE_MS, today, today, at, 'main', workbench.revision, now, today, DAILY_LIMIT).run();
  if (claim.meta.changes !== 1) {
    const latest = await loadInternal();
    if (latest.control.daily_date === today && latest.control.daily_attempts >= DAILY_LIMIT) throw new WorkbenchError(429, 'DAILY_LIMIT', 'The daily collection allowance has been reached. It resets at 00:00 UTC.');
    throw new WorkbenchError(409, 'CONFLICT', 'Another update started. Retry later.');
  }
  try {
    const result = await advanceHourlyDiscovery(workbench, { client: createClient({ apiKey: secret, timeoutMs: 65000 }), now: at, maxRequests: 1, lane: 'latest' });
    return await commit(database, workbench, { ...workbench, ...result }, token);
  } catch (error) {
    await database.prepare('UPDATE entropy_control SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').bind('main', token).run().catch(() => {});
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(500, 'SYNC_FAILED', 'The update did not complete. Existing data was retained.');
  }
}

/** One optional continuation page after the latest hourly window was checked. */
export async function runHourlyCatchup() {
  const { database, workbench, control } = await loadInternal();
  const secret = providerKey(), now = Date.now(), at = new Date(now).toISOString(), today = at.slice(0, 10);
  if (!secret || !workbench.sync.enabled || workbench.sync.paused) return external(workbench, control);
  const hourly = workbench.sync.hourly;
  if (!hourly || !Array.isArray(hourly.pendingWindows) || !hourly.pendingWindows.length) return external(workbench, control);
  if (Date.parse(hourly.nextRunAt || workbench.sync.nextRunAt) <= now) return external(workbench, control);
  const notBefore = Math.max(Date.parse(hourly.nextAttemptAt || hourly.catchupNextAttemptAt) || 0,
    Date.parse(control.updated_at) + BACKFILL_SPACING_MS);
  if (notBefore > now) return external(workbench, control);
  assertNotBusy(control);
  // A busy catch-up queue must leave a full day's hourly discovery allowance.
  if (control.daily_date === today && control.daily_attempts >= CATCHUP_DAILY_LIMIT)
    throw new WorkbenchError(429, 'FRESH_DISCOVERY_RESERVE', 'Catch-up is waiting to preserve the allowance for new-post discovery.');
  const token = crypto.randomUUID();
  const claim = await database.prepare('UPDATE entropy_control SET lease_token=?,lease_until=?,daily_attempts=CASE WHEN daily_date=? THEN daily_attempts+1 ELSE 1 END,daily_date=?,updated_at=? WHERE id=? AND revision=? AND (lease_token IS NULL OR lease_until<=?) AND updated_at<=? AND (daily_date<>? OR daily_attempts<?)')
    .bind(token, now + LEASE_MS, today, today, at, 'main', workbench.revision, now,
      new Date(now - BACKFILL_SPACING_MS).toISOString(), today, CATCHUP_DAILY_LIMIT).run();
  if (claim.meta.changes !== 1) {
    const latest = await loadInternal();
    if (latest.control.daily_date === today && latest.control.daily_attempts >= CATCHUP_DAILY_LIMIT)
      throw new WorkbenchError(429, 'FRESH_DISCOVERY_RESERVE', 'Catch-up is waiting to preserve the allowance for new-post discovery.');
    if (latest.control.lease_token && latest.control.lease_until > now)
      throw new WorkbenchError(423, 'SYNC_BUSY', 'An update is in progress. Try again shortly.');
    throw new WorkbenchError(409, 'CONFLICT', 'Another update started. Retry later.');
  }
  try {
    const result = await advanceHourlyDiscovery(workbench, { client: createClient({ apiKey: secret, timeoutMs: 65000 }), now: at, maxRequests: 1, lane: 'catchup' });
    return await commit(database, workbench, { ...workbench, ...result }, token);
  } catch (error) {
    await database.prepare('UPDATE entropy_control SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').bind('main', token).run().catch(() => {});
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(500, 'SYNC_FAILED', 'The continuation did not complete. Existing data was retained.');
  }
}

/** Optional metrics maintenance; new-post discovery always owns the hourly slot. */
export async function runMetricsRefresh() {
  const { database, workbench, control } = await loadInternal();
  const secret = providerKey(), now = Date.now(), at = new Date(now).toISOString(), today = at.slice(0, 10);
  if (!secret || !workbench.sync.enabled || workbench.sync.paused) return external(workbench, control);
  const hourly = workbench.sync.hourly;
  if (!hourly?.lastAttemptAt || Date.parse(hourly.nextRunAt || workbench.sync.nextRunAt) <= now) return external(workbench, control);
  const previous = workbench.sync.metricsRefresh || {};
  const notBefore = Math.max(Date.parse(previous.nextRunAt) || 0, Date.parse(control.updated_at) + BACKFILL_SPACING_MS);
  if (notBefore > now) return external(workbench, control);
  const numeric = (value: unknown) => typeof value === 'string' && /^[1-9]\d*$/.test(value);
  const eligible = workbench.dataset.posts.filter((post: ObjectValue) => numeric(post.id) && Model.countablePost(post, workbench.state).eligible);
  const eligibleIds = new Set(eligible.map((post: ObjectValue) => post.id));
  let pending = [...new Set((workbench.sync.refresh?.pendingIds || []).filter((id: unknown) => eligibleIds.has(id)))];
  if (!pending.length) pending = [...eligible].sort((a: ObjectValue, b: ObjectValue) => (Date.parse(a.lastCheckedAt || a.metricsAsOf) || 0) - (Date.parse(b.lastCheckedAt || b.metricsAsOf) || 0)).map((post: ObjectValue) => post.id);
  if (!pending.length) return external(workbench, control);
  assertNotBusy(control);
  if (control.daily_date === today && control.daily_attempts >= CATCHUP_DAILY_LIMIT)
    throw new WorkbenchError(429, 'FRESH_DISCOVERY_RESERVE', 'Metrics maintenance is waiting to preserve the allowance for new-post discovery.');
  const token = crypto.randomUUID();
  const claim = await database.prepare('UPDATE entropy_control SET lease_token=?,lease_until=?,daily_attempts=CASE WHEN daily_date=? THEN daily_attempts+1 ELSE 1 END,daily_date=?,updated_at=? WHERE id=? AND revision=? AND (lease_token IS NULL OR lease_until<=?) AND updated_at<=? AND (daily_date<>? OR daily_attempts<?)')
    .bind(token, now + LEASE_MS, today, today, at, 'main', workbench.revision, now,
      new Date(now - BACKFILL_SPACING_MS).toISOString(), today, CATCHUP_DAILY_LIMIT).run();
  if (claim.meta.changes !== 1) {
    const latest = await loadInternal();
    if (latest.control.daily_date === today && latest.control.daily_attempts >= CATCHUP_DAILY_LIMIT)
      throw new WorkbenchError(429, 'FRESH_DISCOVERY_RESERVE', 'Metrics maintenance is waiting to preserve the allowance for new-post discovery.');
    if (latest.control.lease_token && latest.control.lease_until > now)
      throw new WorkbenchError(423, 'SYNC_BUSY', 'An update is in progress. Try again shortly.');
    throw new WorkbenchError(409, 'CONFLICT', 'Another update started. Retry later.');
  }
  const batchSize = [5, 10, 20].includes(previous.batchSize) ? previous.batchSize : 20;
  const selected = pending.slice(0, batchSize), selectedSet = new Set(selected);
  const working = { ...workbench, sync: { ...workbench.sync, phase: 'refresh', nextRunAt: at,
    refresh: { ...(workbench.sync.refresh || {}), pendingIds: selected } } };
  try {
    const result = await advanceSync(working, { client: createClient({ apiKey: secret, timeoutMs: 65000 }), now: at, maxRequests: 1 });
    const failed = !!result.sync.lastError;
    const remaining = pending.filter(id => !selectedSet.has(id));
    // A failed subset returns to the end. Its old source values remain intact;
    // another unavailable account cannot stall every other post indefinitely.
    const pendingIds = failed ? [...remaining, ...selected] : remaining;
    const deadline = new Date(Math.floor(now / 3600000) * 3600000 + 3600000).toISOString();
    const sync = { ...result.sync, phase: workbench.sync.phase, discovery: workbench.sync.discovery, hourly: workbench.sync.hourly,
      nextRunAt: workbench.sync.nextRunAt,
      refresh: { ...(workbench.sync.refresh || {}), pendingIds },
      metricsRefresh: { ...previous, lastAttemptAt: at, lastSuccessAt: failed ? previous.lastSuccessAt || null : at,
        lastError: failed ? result.sync.lastError : null, nextRunAt: deadline,
        batchSize: failed && result.sync.lastError?.diagnosticCode === 'REQUEST_TIMEOUT' ? Math.max(5, batchSize / 2) : batchSize,
        lastBatchSize: selected.length, pendingCount: pendingIds.length } };
    return await commit(database, workbench, { ...workbench, dataset: result.dataset, state: result.state, sync }, token);
  } catch (error) {
    await database.prepare('UPDATE entropy_control SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').bind('main', token).run().catch(() => {});
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(500, 'SYNC_FAILED', 'Metrics maintenance did not complete. Existing data was retained.');
  }
}

/** Explicit, bounded exact-ID recovery; only eligible @entropyIO posts are added. */
export async function runPostRepair(rawIds: unknown, expectedRevision?: unknown) {
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 20
      || rawIds.some(id => typeof id !== 'string' || !/^[1-9]\d{0,24}$/.test(id))
      || new Set(rawIds).size !== rawIds.length) return invalid('Provide 1–20 unique X post IDs.');
  const ids = rawIds as string[];
  const { database, workbench, control } = await loadInternal();
  if (expectedRevision !== undefined) assertRevision(workbench, expectedRevision);
  requireCollection(workbench); assertNotBusy(control);
  const now = Date.now(), at = new Date(now).toISOString(), today = at.slice(0, 10);
  const notBefore = Math.max(Date.parse(workbench.sync.postRepair?.nextAttemptAt) || 0, Date.parse(control.updated_at) + BACKFILL_SPACING_MS);
  if (notBefore > now) throw new WorkbenchError(429, 'REPAIR_NOT_DUE', 'Wait briefly before another recovery request.');
  if (control.daily_date === today && control.daily_attempts >= CATCHUP_DAILY_LIMIT)
    throw new WorkbenchError(429, 'FRESH_DISCOVERY_RESERVE', 'Post recovery is waiting to preserve the allowance for new-post discovery.');
  const token = crypto.randomUUID();
  const claim = await database.prepare('UPDATE entropy_control SET lease_token=?,lease_until=?,daily_attempts=CASE WHEN daily_date=? THEN daily_attempts+1 ELSE 1 END,daily_date=?,updated_at=? WHERE id=? AND revision=? AND (lease_token IS NULL OR lease_until<=?) AND updated_at<=? AND (daily_date<>? OR daily_attempts<?)')
    .bind(token, now + LEASE_MS, today, today, at, 'main', workbench.revision, now,
      new Date(now - BACKFILL_SPACING_MS).toISOString(), today, CATCHUP_DAILY_LIMIT).run();
  if (claim.meta.changes !== 1) {
    const latest = await loadInternal();
    if (latest.control.daily_date === today && latest.control.daily_attempts >= CATCHUP_DAILY_LIMIT)
      throw new WorkbenchError(429, 'FRESH_DISCOVERY_RESERVE', 'Post recovery is waiting to preserve the allowance for new-post discovery.');
    if (latest.control.lease_token && latest.control.lease_until > now)
      throw new WorkbenchError(423, 'SYNC_BUSY', 'An update is in progress. Try again shortly.');
    throw new WorkbenchError(409, 'CONFLICT', 'Another update started. Retry later.');
  }
  const requestCount = (Number.isSafeInteger(workbench.sync.requestCount) ? workbench.sync.requestCount : 0) + 1;
  try {
    const page = await createClient({ apiKey: providerKey()!, timeoutMs: 65000 }).tweetsByIds(ids);
    const incoming = normalizeDiscoveryPage(page.tweets, at);
    const oldIds = new Set(workbench.dataset.posts.map((post: ObjectValue) => post.id));
    // An exact lookup can prove an older, untyped record was a reply. Retain
    // that positive evidence even though the record is ineligible for discovery.
    // Newly found replies/reposts are never inserted into the source history.
    const returned = new Map(page.tweets.map((post: ObjectValue) => [post.id, post]));
    const authors = new Map(workbench.dataset.authors.map((author: ObjectValue) => [author.id, author]));
    const classified = { ...workbench.dataset, posts: workbench.dataset.posts.map((post: ObjectValue) => {
      const observation = returned.get(post.id) as ObjectValue | undefined;
      if (!observation) return post;
      const kind = Model.postEligibility(observation);
      if (kind.eligible) return post;
      const author = authors.get(post.authorId) as ObjectValue | undefined;
      const sameOwner = post.authorId === observation.author?.id || post.authorId.startsWith('sample:')
        && typeof author?.handle === 'string' && typeof observation.author?.userName === 'string'
        && author.handle.replace(/^@/, '').toLowerCase() === observation.author.userName.toLowerCase();
      if (!sameOwner) throw new Error('Post ownership conflict.');
      return kind.reason === 'reply' ? { ...post, isReply: true,
        ...(typeof observation.inReplyToId === 'string' && observation.inReplyToId.trim() ? { inReplyToId: observation.inReplyToId } : {}) }
        : { ...post, isRepost: true };
    }) };
    const dataset = mergeDataset(classified, incoming);
    const state = Model.reconcileImport(workbench.dataset, dataset, workbench.state);
    const ignoredReplies = page.tweets.filter((post: ObjectValue) => Model.postEligibility(post).reason === 'reply').length;
    const ignoredReposts = page.tweets.filter((post: ObjectValue) => Model.postEligibility(post).reason === 'repost').length;
    const matched = incoming.posts.length;
    const queuedForReview = incoming.posts.filter((post: ObjectValue) => post.relevance?.status === 'review').length;
    const repair = { status: 'complete', requested: ids.length, returned: page.tweets.length,
      matched, accepted: matched - queuedForReview, queuedForReview,
      addedPosts: incoming.posts.filter((post: ObjectValue) => !oldIds.has(post.id)).length,
      ignoredReplies, ignoredReposts, notRelevant: Math.max(0, page.tweets.length - matched - ignoredReplies - ignoredReposts),
      unavailable: ids.length - page.tweets.length, lastAttemptAt: at, lastSuccessAt: at, nextAttemptAt: null, lastError: null };
    return await commit(database, workbench, { ...workbench, dataset, state,
      sync: { ...workbench.sync, requestCount, postRepair: repair } }, token);
  } catch (error) {
    if (error instanceof WorkbenchError) {
      await database.prepare('UPDATE entropy_control SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').bind('main', token).run().catch(() => {});
      throw error;
    }
    const failure = error as { status?: unknown; code?: unknown };
    const status = Number.isInteger(failure?.status) ? Number(failure.status) : null;
    const code = status === 402 ? 'CREDITS_EXHAUSTED' : status === 401 || status === 403 ? 'AUTH_REQUIRED'
      : status === 429 ? 'RATE_LIMITED' : 'REPAIR_FAILED';
    const paused = code === 'CREDITS_EXHAUSTED' || code === 'AUTH_REQUIRED';
    const nextAttemptAt = new Date(now + (code === 'RATE_LIMITED' ? 3600000 : 60000)).toISOString();
    const diagnosticCode = ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE', 'PROVIDER_ERROR', 'HTTP_ERROR', 'RATE_LIMITED', 'CREDITS_EXHAUSTED'].includes(String(failure?.code)) ? failure.code : 'INVALID_POST_RESPONSE';
    const lastError = { code, diagnosticCode, at, httpStatus: status };
    try {
      return await commit(database, workbench, { ...workbench, sync: { ...workbench.sync, requestCount,
        ...(paused ? { paused: true, status: 'error', lastError } : {}),
        postRepair: { status: 'error', requested: ids.length, lastAttemptAt: at, lastSuccessAt: null, nextAttemptAt, lastError } } }, token);
    } finally {
      await database.prepare('UPDATE entropy_control SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').bind('main', token).run().catch(() => {});
    }
  }
}

function requireCollection(workbench: Workbench) {
  if (!providerKey()) throw new WorkbenchError(400, 'KEY_REQUIRED', 'Configure the server’s TWITTERAPI_IO_KEY secret first.');
  if (!workbench.sync.enabled) throw new WorkbenchError(400, 'COLLECTOR_DISABLED', 'Enable the collector before starting the historical collection.');
  if (workbench.sync.paused) throw new WorkbenchError(400, 'COLLECTOR_PAUSED', 'Resume the collector before continuing the historical collection.');
}
function backfillResponse(workbench: Workbench, control: StoredRow, nextStepAt?: string) {
  const result = external(workbench, control);
  if (result.sync.backfill) result.sync.backfill = { ...result.sync.backfill,
    nextStepAt: nextStepAt || result.sync.backfill.nextAttemptAt || null,
    totalRequests: result.sync.backfill.requestCount || 0 };
  return result;
}
function backfillArchive(job: ObjectValue) {
  const safe: ObjectValue = {};
  for (const key of ['version', 'id', 'target', 'method', 'queryPolicy', 'start', 'endExclusive', 'status', 'requestCount', 'requestLimit', 'successfulPages', 'addedPosts', 'initialWindows', 'completedWindows', 'splitWindows', 'startedAt', 'finishedAt', 'cancelledAt']) {
    if (typeof job[key] === 'string' || typeof job[key] === 'number' || job[key] === null) safe[key] = job[key];
  }
  if (Array.isArray(job.lanes)) safe.lanes = job.lanes.filter((lane: unknown) => ['direct', 'evidence', 'context'].includes(String(lane)));
  safe.gaps = (Array.isArray(job.gaps) ? job.gaps : []).map((gap: ObjectValue) => {
    const value: ObjectValue = {};
    for (const key of ['code', 'at', 'start', 'endExclusive']) if (typeof gap?.[key] === 'string') value[key] = gap[key];
    return value;
  });
  return safe;
}
export async function startBackfill(payload: ObjectValue) {
  const { database, workbench, control } = await loadInternal();
  assertNotBusy(control); requireCollection(workbench);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid();
  const start = typeof payload.start === 'string' ? payload.start : null;
  const endExclusive = typeof payload.endExclusive === 'string' ? payload.endExclusive : null;
  const requestLimit = payload.requestLimit ?? 250;
  const method = payload.method ?? 'search';
  const lanes = payload.lanes;
  if (lanes !== undefined && (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > 3 || new Set(lanes).size !== lanes.length
      || lanes.some((lane: unknown) => !['direct', 'evidence', 'context'].includes(String(lane))))) return invalid('Provide unique supported discovery lanes.');
  const now = Date.now();
  if (!['search', 'mentions', 'id-search'].includes(method) || !start || !endExclusive || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(endExclusive)) || Date.parse(start) >= Date.parse(endExclusive) || Date.parse(endExclusive) > now || Date.parse(endExclusive) - Date.parse(start) > 62 * 86400000 || !Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 1000) return invalid('Provide a supported collection method, an explicit UTC interval up to now, and a bounded request limit.');
  let result;
  try { result = beginBackfill(workbench, { start, endExclusive, requestLimit, method, ...(lanes === undefined ? {} : { lanes }), now: new Date(now).toISOString() }); }
  catch { return invalid('The historical collection could not be started with this interval.'); }
  if (workbench.sync.backfill && result.sync.backfill?.id !== workbench.sync.backfill.id) result.sync.backfillHistory = [
    ...(Array.isArray(workbench.sync.backfillHistory) ? workbench.sync.backfillHistory : []).map(backfillArchive),
    backfillArchive(workbench.sync.backfill),
  ].slice(-5);
  const next = { ...workbench, ...result };
  // Retrying the same start request must not reset progress, spend allowance,
  // or keep pushing the first step into the future.
  if (JSON.stringify(next.sync) === JSON.stringify(workbench.sync)) return backfillResponse(workbench, control, new Date(Math.max(Date.parse(workbench.sync.backfill?.nextAttemptAt) || 0, Date.parse(control.updated_at) + BACKFILL_SPACING_MS)).toISOString());
  const saved = await commit(database, workbench, next);
  saved.sync.backfill.nextStepAt = new Date(Math.max(Date.parse(saved.sync.backfill.nextAttemptAt) || 0, Date.parse(saved.updatedAt) + BACKFILL_SPACING_MS)).toISOString();
  saved.sync.backfill.totalRequests = saved.sync.backfill.requestCount || 0;
  return saved;
}
export async function cancelBackfill(expectedRevision?: unknown) {
  const { database, workbench, control } = await loadInternal();
  if (expectedRevision !== undefined) assertRevision(workbench, expectedRevision);
  assertNotBusy(control);
  const job = workbench.sync.backfill;
  if (!job || job.status === 'cancelled') return backfillResponse(workbench, control);
  const at = new Date(Date.now()).toISOString();
  const sync = { ...workbench.sync, backfill: { ...job, status: 'cancelled', cancelledAt: at, finishedAt: at, nextAttemptAt: null } };
  return commit(database, workbench, { ...workbench, sync });
}
export async function runBackfill() {
  const { database, workbench, control } = await loadInternal();
  requireCollection(workbench); assertNotBusy(control);
  const job = workbench.sync.backfill;
  if (!job || !['running', 'waiting'].includes(job.status)) return backfillResponse(workbench, control);
  const now = Date.now(), at = new Date(now).toISOString(), today = at.slice(0, 10);
  // updated_at is reserved durably together with the provider attempt below.
  // It also conservatively spaces a step after a manual state change.
  const notBefore = Math.max(Date.parse(job.nextAttemptAt) || 0, Date.parse(control.updated_at) + BACKFILL_SPACING_MS);
  if (notBefore > now) return backfillResponse(workbench, control, new Date(notBefore).toISOString());
  if (control.daily_date === today && control.daily_attempts >= CATCHUP_DAILY_LIMIT)
    throw new WorkbenchError(429, 'FRESH_DISCOVERY_RESERVE', 'Historical collection is waiting to preserve the allowance for new-post discovery.');
  const token = crypto.randomUUID();
  const claim = await database.prepare('UPDATE entropy_control SET lease_token=?,lease_until=?,daily_attempts=CASE WHEN daily_date=? THEN daily_attempts+1 ELSE 1 END,daily_date=?,updated_at=? WHERE id=? AND revision=? AND (lease_token IS NULL OR lease_until<=?) AND updated_at<=? AND (daily_date<>? OR daily_attempts<?)').bind(token, now + LEASE_MS, today, today, at, 'main', workbench.revision, now, new Date(now - BACKFILL_SPACING_MS).toISOString(), today, CATCHUP_DAILY_LIMIT).run();
  if (claim.meta.changes !== 1) {
    const latest = await loadInternal();
    if (latest.control.daily_date === today && latest.control.daily_attempts >= CATCHUP_DAILY_LIMIT)
      throw new WorkbenchError(429, 'FRESH_DISCOVERY_RESERVE', 'Historical collection is waiting to preserve the allowance for new-post discovery.');
    if (latest.control.lease_token && latest.control.lease_until > Date.now()) throw new WorkbenchError(423, 'SYNC_BUSY', 'An update is in progress. Try again shortly.');
    return backfillResponse(latest.workbench, latest.control, new Date(Math.max(Date.parse(latest.workbench.sync.backfill?.nextAttemptAt) || 0, Date.parse(latest.control.updated_at) + BACKFILL_SPACING_MS)).toISOString());
  }
  try {
    const result = await advanceBackfill(workbench, { client: createClient({ apiKey: providerKey()!, timeoutMs: 65000 }), now: at });
    const saved = await commit(database, workbench, { ...workbench, ...result }, token);
    if (saved.sync.backfill) {
      saved.sync.backfill.nextStepAt = new Date(Math.max(Date.parse(saved.sync.backfill.nextAttemptAt) || 0, Date.parse(saved.updatedAt) + BACKFILL_SPACING_MS)).toISOString();
      saved.sync.backfill.totalRequests = saved.sync.backfill.requestCount || 0;
    }
    return saved;
  } catch (error) {
    await database.prepare('UPDATE entropy_control SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').bind('main', token).run().catch(() => {});
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(500, 'BACKFILL_FAILED', 'The historical step did not complete. Existing data and progress were retained.');
  }
}
