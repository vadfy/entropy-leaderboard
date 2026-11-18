import { getStatus, startBackfill, cancelBackfill, runBackfill, WorkbenchError } from '../../../lib/workbench';

export const dynamic = 'force-dynamic';
const LIMIT = 2048;
const response = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
function summary(value: any) { return { revision: value.revision, updatedAt: value.updatedAt, mode: value.mode,
  connection: value.connection, sync: value.sync,
  authors: value.authors ?? value.dataset?.authors?.length, posts: value.posts ?? value.dataset?.posts?.length }; }
function failure(error: unknown) {
  if (error instanceof WorkbenchError) return response({ error: { code: error.code, message: error.message } }, error.status);
  return response({ error: { code: 'BACKFILL_FAILED', message: 'The historical collection request did not complete.' } }, 500);
}
// The private Sites gate validates visitor/service access before forwarding.
// This is an explicit one-off action; ordinary scheduled /internal/sync calls
// cannot create or extend a historical job.
async function body(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new WorkbenchError(403, 'ORIGIN_REJECTED', 'The request origin is not allowed.');
  if (request.headers.get('x-entropy-update') !== '1') throw new WorkbenchError(403, 'UPDATE_INTENT_REQUIRED', 'The update intent header is required.');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new WorkbenchError(415, 'INVALID_INPUT', 'Use application/json.');
  if (Number(request.headers.get('content-length')) > LIMIT) throw new WorkbenchError(413, 'TOO_LARGE', 'The request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new WorkbenchError(400, 'INVALID_INPUT', 'A JSON object is required.');
  let length = 0; const chunks: Uint8Array[] = [];
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
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new WorkbenchError(400, 'INVALID_INPUT', 'A JSON object is required.'); }
}
export async function GET() {
  try { return response(summary(await getStatus())); } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const payload = await body(request);
    if (payload.action === 'start' && Object.keys(payload).every(key => ['action', 'start', 'endExclusive', 'requestLimit', 'method', 'lanes'].includes(key))) return response(summary(await startBackfill(payload)));
    if (payload.action === 'cancel' && Object.keys(payload).every(key => ['action', 'expectedRevision'].includes(key))) return response(summary(await cancelBackfill(payload.expectedRevision)));
    if (payload.action === 'step' && Object.keys(payload).length === 1) return response(summary(await runBackfill()));
    throw new WorkbenchError(400, 'INVALID_INPUT', 'Use a bounded start request, cancel, or one step action.');
  } catch (error) { return failure(error); }
}
