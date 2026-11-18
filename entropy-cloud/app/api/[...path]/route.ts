import { getWorkbench, getStatus, getCommunityPreview, saveState, importWorkbench, setCollector, runSync, runPostRepair, WorkbenchError } from '../../../lib/workbench';

export const dynamic = 'force-dynamic';
const LIMIT = 15 * 1024 * 1024;
type Context = { params: Promise<{ path: string[] }> };
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
function identity(request: Request) {
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id) throw new WorkbenchError(401, 'UNAUTHENTICATED', 'Sign in to this private workbench.');
  return id;
}
async function body(request: Request): Promise<Record<string, any>> {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) throw new WorkbenchError(403, 'ORIGIN_REJECTED', 'This update must come from the workbench.');
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new WorkbenchError(415, 'INVALID_INPUT', 'Use application/json.');
  if (Number(request.headers.get('content-length')) > LIMIT) throw new WorkbenchError(413, 'TOO_LARGE', 'The submitted file is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new WorkbenchError(400, 'INVALID_INPUT', 'A JSON body is required.');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const result = await reader.read(); if (result.done) break;
    length += result.value.byteLength;
    if (length > LIMIT) { await reader.cancel(); throw new WorkbenchError(413, 'TOO_LARGE', 'The submitted file is too large.'); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch { throw new WorkbenchError(400, 'INVALID_INPUT', 'The JSON body is invalid.'); }
}
function errorResponse(error: unknown) {
  if (error instanceof WorkbenchError) return response({ error: { code: error.code, message: error.message } }, error.status);
  return response({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } }, 500);
}
export async function GET(request: Request, context: Context) {
  try {
    identity(request);
    const path = (await context.params).path.join('/');
    if (path === 'workbench') return response(await getWorkbench());
    if (path === 'community-preview') return response(await getCommunityPreview());
    if (path === 'status') return response(await getStatus());
    return response({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } }, 404);
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const actorId = identity(request), payload = await body(request);
    const path = (await context.params).path.join('/');
    if (path === 'state') return response(await saveState(payload.state, payload.expectedRevision, actorId));
    if (path === 'import') return response(await importWorkbench(payload));
    if (path === 'collector') return response(await setCollector(payload.enabled, payload.expectedRevision));
    if (path === 'repair') {
      if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0 || Object.keys(payload).some(key => !['ids', 'expectedRevision'].includes(key)))
        throw new WorkbenchError(400, 'INVALID_INPUT', 'A current revision and exact post IDs are required.');
      return response(await runPostRepair(payload.ids, payload.expectedRevision));
    }
    if (path === 'sync') {
      if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) throw new WorkbenchError(400, 'INVALID_INPUT', 'A current expectedRevision is required.');
      return response(await runSync(payload.expectedRevision, true));
    }
    return response({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } }, 404);
  } catch (error) { return errorResponse(error); }
}
