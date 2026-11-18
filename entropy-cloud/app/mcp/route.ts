import { getStatus, runHourlyCycle, WorkbenchError } from '../../lib/workbench';

export const dynamic = 'force-dynamic';
const VERSION = '2026-07-28';
const tools = [
  { name: 'entropy_status', description: 'Read Entropy collector status and usage without exposing credentials or moderation notes.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'entropy_sync', description: 'Run one bounded due hourly Entropy cycle: tagged, official-link and contextual searches before fresh pagination. Honors pause, provider cooldown, server key, revision lease and daily allowance. Never enables or resumes the collector.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const rpcError = (id: unknown, code: number, message: string) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
// The hosted Site remains owner-private. Sites validates visitor or supported
// unattended service access before forwarding /mcp. No separate OAuth stack or
// browser API-key endpoint is introduced here.
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);
  if (Number(request.headers.get('content-length')) > 1024 * 1024) return json({ error: 'Request too large.' }, 413);
  let message: Record<string, any>;
  try {
    const reader = request.body?.getReader();
    if (!reader) return rpcError(null, -32700, 'A JSON body is required.');
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 1024 * 1024) { await reader.cancel(); return json({ error: 'Request too large.' }, 413); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request');
    message = parsed;
  } catch { return rpcError(null, -32700, 'Invalid JSON.'); }
  const id = message.id ?? null;
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(id, -32600, 'Invalid request.');
  if (message.method === 'notifications/initialized') return new Response(null, { status: 204 });
  if (message.method === 'server/discover') return json({ jsonrpc: '2.0', id, result: { supportedVersions: [VERSION], capabilities: { tools: {} }, serverInfo: { name: 'Entropy private collector', version: '0.1.0' } } });
  if (message.method === 'initialize') return json({ jsonrpc: '2.0', id, result: { protocolVersion: VERSION, capabilities: { tools: {} }, serverInfo: { name: 'Entropy private collector', version: '0.1.0' } } });
  if (message.method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools } });
  if (message.method !== 'tools/call') return rpcError(id, -32601, 'Method not found.');
  const name = message.params?.name, args = message.params?.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) return rpcError(id, -32602, 'This tool takes no arguments.');
  if (!tools.some(tool => tool.name === name)) return rpcError(id, -32602, 'Unknown tool.');
  try {
    let summary;
    if (name === 'entropy_sync') {
      const result = await runHourlyCycle('mcp');
      summary = { revision: result.revision, updatedAt: result.updatedAt, mode: result.mode, connection: result.connection,
        sync: result.sync, authors: result.dataset.authors.length, posts: result.dataset.posts.length };
    } else summary = await getStatus();
    return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: summary } });
  } catch (error) {
    const value = error instanceof WorkbenchError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: 'The collector request did not complete.' };
    return json({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }] } });
  }
}
