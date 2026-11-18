import { getStatus, runSync, runHourlyCatchup, runMetricsRefresh, runPostRepair, WorkbenchError } from '../../../lib/workbench';

export const dynamic = 'force-dynamic';
const LIMIT = 1024;
const response = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
});

// Sites must keep this Site owner-private and validate service access before
// forwarding requests here. The platform consumes its service bearer token and
// does not supply a visitor identity. X-Entropy-Update is intent, not authentication.
async function checkRequest(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new WorkbenchError(403, 'ORIGIN_REJECTED', 'The request origin is not allowed.');
  if (request.headers.get('x-entropy-update') !== '1') throw new WorkbenchError(403, 'UPDATE_INTENT_REQUIRED', 'The update intent header is required.');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new WorkbenchError(415, 'INVALID_INPUT', 'Use application/json.');
  if (Number(request.headers.get('content-length')) > LIMIT) throw new WorkbenchError(413, 'TOO_LARGE', 'The request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new WorkbenchError(400, 'INVALID_INPUT', 'Send {} or an explicit maintenance action.');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    length += part.value.byteLength;
    if (length > LIMIT) { await reader.cancel(); throw new WorkbenchError(413, 'TOO_LARGE', 'The request body is too large.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A JSON object is required.');
    if (!Object.keys(value).length) return { action: 'latest' };
    if (Object.keys(value).length === 1 && ['catchup', 'metrics'].includes(value.action)) return value;
    if (Object.keys(value).length === 2 && value.action === 'repair' && Array.isArray(value.ids)
        && value.ids.length >= 1 && value.ids.length <= 20 && new Set(value.ids).size === value.ids.length
        && value.ids.every((id: unknown) => typeof id === 'string' && /^[1-9]\d{0,24}$/.test(id))) return value;
    throw new Error('Unsupported action.');
  } catch { throw new WorkbenchError(400, 'INVALID_INPUT', 'Send {} or an explicit maintenance action.'); }
}
function errorResponse(error: unknown) {
  if (error instanceof WorkbenchError) return response({ error: { code: error.code, message: error.message } }, error.status);
  return response({ error: { code: 'INTERNAL_ERROR', message: 'The collector request did not complete.' } }, 500);
}
export async function GET() {
  try { return response(await getStatus()); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const { action, ids } = await checkRequest(request);
    // Ordinary {} always checks the newest hourly window. A bounded explicit
    // continuation never replaces that slot or enables/resumes collection.
    const result = action === 'catchup' ? await runHourlyCatchup() : action === 'metrics' ? await runMetricsRefresh()
      : action === 'repair' ? await runPostRepair(ids) : await runSync();
    return response({ revision: result.revision, updatedAt: result.updatedAt, mode: result.mode,
      connection: result.connection, sync: result.sync, authors: result.dataset.authors.length, posts: result.dataset.posts.length });
  } catch (error) { return errorResponse(error); }
}
