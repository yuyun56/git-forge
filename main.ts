// Entry point: the forge server plus the make.fun trial lifecycle.
//
// The server binds an ephemeral port, registers it with the env at $MAKEFUN_ENV_URL/register,
// serves git smart HTTP + REST + GraphQL + MCP until the env answers {"done": true} on
// GET $MAKEFUN_ENV_URL/done, then exits 0. Without MAKEFUN_ENV_URL (local development) it
// serves on $PORT (default 8080) indefinitely.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { authorized, handleInfoRefs, handleReceivePack, handleUploadPack } from './src/smarthttp.ts';
import { baseUrlOf, handleRest, sendJson } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMCP } from './src/mcp.ts';

const store = new Store();
const MAX_BODY = 512 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = chunk as Buffer;
    total += bytes.length;
    if (total > MAX_BODY) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function unauthorizedJson(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const [, owner, repo, action] = gitMatch;
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('unauthorized\n');
      return;
    }
    if (action === 'info/refs' && method === 'GET') {
      handleInfoRefs(store, req, res, decodeURIComponent(owner), decodeURIComponent(repo), url.searchParams.get('service'));
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      handleUploadPack(store, req, res, decodeURIComponent(owner), decodeURIComponent(repo), await readBody(req));
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      handleReceivePack(store, req, res, decodeURIComponent(owner), decodeURIComponent(repo), await readBody(req));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return;
  }

  // REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) return unauthorizedJson(res);
    const raw = await readBody(req);
    let body: Record<string, unknown> | null = null;
    if (raw.length > 0 && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
      try {
        body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return sendJson(res, 400, { message: 'Problems parsing JSON' });
      }
    }
    const segments = path
      .replace(/^\/api\/v3\/?/, '')
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
    // contents paths keep their inner slashes: re-join from the raw remainder when needed.
    await handleRest({ store, req, res, base: baseUrlOf(req), body, query: url.searchParams }, segments);
    return;
  }

  // GraphQL v4
  if (path === '/api/graphql') {
    if (!authorized(req)) return unauthorizedJson(res);
    const raw = await readBody(req);
    await handleGraphQL(store, req, res, raw);
    return;
  }

  // MCP
  if (path === '/mcp') {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
      return;
    }
    const raw = await readBody(req);
    await handleMCP(store, req, res, raw);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

const server = createServer((req, res) => {
  route(req, res).catch(() => {
    try {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    } catch {
      // The peer is gone; nothing more to do.
    }
  });
});
server.headersTimeout = 60_000;
server.requestTimeout = 0;

async function registerAndWait(port: number): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) return;
  const registerUrl = `${envUrl.replace(/\/$/, '')}/register`;
  let registered = false;
  for (let attempt = 0; attempt < 60 && !registered; attempt += 1) {
    try {
      const response = await fetch(registerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok || response.status === 409) registered = true;
      else await new Promise((resolve) => setTimeout(resolve, 250));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const doneUrl = `${envUrl.replace(/\/$/, '')}/done`;
  for (;;) {
    try {
      const response = await fetch(doneUrl);
      if (response.ok) {
        const payload = (await response.json()) as { done?: boolean };
        if (payload.done) break;
      }
    } catch {
      // The env may not be up yet or the long-poll dropped; keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  server.close();
  process.exit(0);
}

const port = process.env.MAKEFUN_ENV_URL ? 0 : Number(process.env.PORT ?? 8080);
server.listen(port, '0.0.0.0', () => {
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  void registerAndWait(bound);
});
