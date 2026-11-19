// MCP surface (/mcp): JSON-RPC 2.0 over Streamable HTTP, speaking the modern server/discover
// handshake (revision 2026-07-28) and the legacy initialize handshake. The six tools mirror
// github-mcp-server's argument shapes and act on the same store as REST, so an object made
// through one surface reads identically through the other.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildTreeFromFiles, makeCommit, VIEWER, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { baseUrlOf, issueJson, mergeTrees, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'ember-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'ember-forge-session';

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The name of the repository.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of a GitHub repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a GitHub repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a GitHub repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a GitHub repository.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      head: { type: 'string', description: 'The name of the branch to merge from.' },
      base: { type: 'string', description: 'The name of the branch to merge into.' },
      body: { type: 'string', description: 'The body of the pull request.' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a GitHub repository.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      merge_method: { type: 'string', description: 'The merge method: merge, squash, or rebase.' },
    },
  },
];

const TOOLS_LIST = TOOL_DEFS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: 'object',
    properties: tool.properties,
    required: tool.required,
    additionalProperties: false,
  },
}));

type Json = Record<string, unknown>;

function toolResult(structured: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

function toolError(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mergePull(store: Store, repo: Repo, pull: Pull, method: string): { ok: boolean; message: string } {
  const headSha = repo.refs.get(pull.headRef);
  const baseSha = repo.refs.get(pull.baseRef);
  if (!headSha || !baseSha) return { ok: false, message: 'head or base ref missing' };
  const merged = mergeTrees(repo, baseSha, headSha);
  if (merged.conflicts.length) return { ok: false, message: 'merge conflict' };
  const tree = buildTreeFromFiles(repo, merged.files);
  const now = store.tick();
  let message: string;
  let parents: string[];
  if (method === 'merge') {
    message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef.replace('refs/heads/', '')}`;
    parents = [baseSha, headSha];
  } else {
    const detail = pull.body ?? '';
    message = detail ? `${pull.title} (#${pull.number})\n\n${detail}` : `${pull.title} (#${pull.number})`;
    parents = [baseSha];
  }
  const commitOid = makeCommit(store, repo, { tree, parents, message });
  repo.refs.set(pull.baseRef, commitOid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedSeq = now.seq;
  pull.updatedSeq = now.seq;
  pull.mergeCommitSha = commitOid;
  return { ok: true, message: 'merged' };
}

function callTool(store: Store, base: string, name: string, args: Json): Json | 'unknown-tool' {
  const def = TOOL_DEFS.find((tool) => tool.name === name);
  if (!def) return 'unknown-tool';
  for (const required of def.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  const repoOf = (): Repo | null => store.getRepo(String(args.owner ?? ''), String(args.repo ?? '')) ?? null;

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER.login, repoName)) return toolError(`repository ${repoName} already exists`);
      const repo = store.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : null,
        private: args.private === true,
      });
      repo.updatedSeq = store.tick().seq;
      return toolResult(repoJson(store, repo, base));
    }
    case 'get_repo': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const out = repoJson(store, repo, base) as Json;
      out.full_name = `${repo.owner}/${repo.name}`;
      return toolResult(out);
    }
    case 'create_issue': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const now = store.tick();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open',
        labels: [],
        author: VIEWER.login,
        createdSeq: now.seq,
        updatedSeq: now.seq,
        comments: [],
        isPull: false,
      };
      repo.issues.set(issue.number, issue);
      return toolResult(issueJson(store, repo, issue, base));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = [...repo.issues.values()]
        .filter((item) => !item.isPull)
        .filter((item) => state === 'all' || item.state === state)
        .sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number)
        .map((item) => issueJson(store, repo, item as Issue, base));
      return toolResult(items);
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const clean = (value: unknown): string => String(value ?? '').replace(/^refs\/heads\//, '').split(':').pop() as string;
      const headRef = `refs/heads/${clean(args.head)}`;
      const baseRef = `refs/heads/${clean(args.base)}`;
      if (!repo.refs.has(headRef)) return toolError(`head branch not found: ${clean(args.head)}`);
      if (!repo.refs.has(baseRef)) return toolError(`base branch not found: ${clean(args.base)}`);
      const now = store.tick();
      const pull: Pull = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open',
        headRef,
        baseRef,
        author: VIEWER.login,
        createdSeq: now.seq,
        updatedSeq: now.seq,
        merged: false,
        mergedSeq: null,
        mergeCommitSha: null,
        comments: [],
        isPull: true,
      };
      repo.issues.set(pull.number, pull);
      return toolResult(pullJson(store, repo, pull, base));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const item = repo.issues.get(Number(args.pull_number));
      if (!item || !item.isPull) return toolError('pull request not found');
      const pull = item as Pull;
      if (pull.merged || pull.state !== 'open') return toolError('pull request is not mergeable');
      const result = mergePull(store, repo, pull, typeof args.merge_method === 'string' ? args.merge_method : 'squash');
      if (!result.ok) return toolError(result.message);
      return toolResult(pullJson(store, repo, pull, base));
    }
  }
  return 'unknown-tool';
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}

function rpcResult(id: string | number | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(store: Store, base: string, message: RpcMessage): string | null {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  switch (message.method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      });
    case 'initialize': {
      const requested = (message.params?.protocolVersion as string) ?? '2025-11-25';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS_LIST });
    case 'tools/call': {
      const params = message.params ?? {};
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Json;
      const result = callTool(store, base, name, args);
      if (result === 'unknown-tool') return rpcError(id, -32602, `unknown tool: ${name}`);
      return rpcResult(id, result);
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${message.method ?? ''}`);
  }
}

export async function handleMCP(store: Store, req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'GET' || method === 'DELETE') {
    res.writeHead(405, { 'Content-Type': 'application/json', 'Mcp-Session-Id': SESSION_ID });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method Not Allowed' } }));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(rpcError(null, -32700, 'Parse error'));
    return;
  }
  const base = baseUrlOf(req);
  const messages = (Array.isArray(parsed) ? parsed : [parsed]) as RpcMessage[];
  const replies: string[] = [];
  let sawNotificationOnly = messages.length > 0;
  for (const message of messages) {
    if (message.id !== undefined) sawNotificationOnly = false;
    const reply = handleMessage(store, base, message);
    if (reply !== null) replies.push(reply);
  }
  res.setHeader('Mcp-Session-Id', SESSION_ID);
  if (replies.length === 0 || sawNotificationOnly) {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(Array.isArray(parsed) ? `[${replies.join(',')}]` : replies[0]);
}
