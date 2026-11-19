// The REST v3 surface (/api/v3), GitHub-shaped: repositories, contents, git refs, branches,
// commits, labels, issues, comments and pull requests, all over the in-memory store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  type GitObject,
} from './git.ts';
import {
  buildTreeFromFiles,
  makeCommit,
  readTreeFiles,
  repoLookup,
  storeBlob,
  VIEWER,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

let requestSeq = 0;

export function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': `EMBER-${(++requestSeq).toString(16).toUpperCase().padStart(6, '0')}`,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function validationFailed(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message, documentation_url: 'https://docs.github.com/rest' });
}

// ---------------------------------------------------------------------------
// object shapes
// ---------------------------------------------------------------------------

export function userJson(login: string): Record<string, unknown> {
  const isViewer = login === VIEWER.login;
  return {
    login,
    id: isViewer ? VIEWER.id : 0,
    node_id: Buffer.from(`04:User${isViewer ? VIEWER.id : 0}`).toString('base64'),
    type: 'User',
    site_admin: false,
    name: isViewer ? VIEWER.name : login,
    email: isViewer ? VIEWER.email : null,
  };
}

export function repoJson(store: Store, repo: Repo, base: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: Buffer.from(`07:Repository${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: fullName,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `${base}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${fullName}`,
    created_at: isoOf(store, repo.createdSeq),
    updated_at: isoOf(store, repo.updatedSeq),
    pushed_at: isoOf(store, repo.updatedSeq),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, push: true, pull: true },
  };
}

function isoOf(store: Store, seq: number): string {
  return store.isoOfSeq(seq);
}

function labelJson(label: Label, repo: Repo, base: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`09:Label${label.id}`).toString('base64'),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(store: Store, repo: Repo, item: Issue | Pull, base: string): Record<string, unknown> {
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const out: Record<string, unknown> = {
    id: item.id,
    node_id: Buffer.from(`${item.isPull ? '11:PullRequest' : '08:Issue'}${item.id}`).toString('base64'),
    url: `${repoUrl}/issues/${item.number}`,
    repository_url: repoUrl,
    labels_url: `${repoUrl}/issues/${item.number}/labels{/name}`,
    comments_url: `${repoUrl}/issues/${item.number}/comments`,
    events_url: `${repoUrl}/issues/${item.number}/events`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${item.number}`,
    number: item.number,
    state: item.state,
    title: item.title,
    body: item.body,
    user: userJson(item.author),
    labels: item.isPull
      ? []
      : (item as Issue).labels
          .map((name) => repo.labels.get(name))
          .filter((label): label is Label => Boolean(label))
          .map((label) => labelJson(label, repo, base)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: item.comments.length,
    created_at: isoOf(store, item.createdSeq),
    updated_at: isoOf(store, item.updatedSeq),
    closed_at: item.state === 'closed' ? isoOf(store, item.updatedSeq) : null,
    author_association: 'OWNER',
  };
  if (item.isPull) {
    const pull = item as Pull;
    out.html_url = `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`;
    out.pull_request = {
      url: `${repoUrl}/pulls/${pull.number}`,
      html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
      diff_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
      patch_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
      merged_at: pull.merged ? isoOf(store, pull.mergedSeq ?? pull.updatedSeq) : null,
    };
  }
  return out;
}

function pullJson(store: Store, repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  const out = issueJson(store, repo, pull, base) as Record<string, unknown>;
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  out.url = `${repoUrl}/pulls/${pull.number}`;
  delete out.pull_request;
  const lookup = repoLookup(repo);
  const headSha = repo.refs.get(pull.headRef) ?? null;
  const baseSha = repo.refs.get(pull.baseRef) ?? null;
  const refSide = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref.replace('refs/heads/', '')}`,
    ref: ref.replace('refs/heads/', ''),
    sha,
    user: userJson(repo.owner),
    repo: repoJson(store, repo, base),
  });
  out.head = refSide(pull.headRef, headSha);
  out.base = refSide(pull.baseRef, baseSha);
  out.merged = pull.merged;
  out.merged_at = pull.merged ? isoOf(store, pull.mergedSeq ?? pull.updatedSeq) : null;
  out.merge_commit_sha = pull.mergeCommitSha;
  out.draft = false;
  const mergeable = computeMergeable(repo, pull);
  out.mergeable = pull.state === 'closed' && !pull.merged ? false : mergeable;
  out.mergeable_state = pull.merged ? 'clean' : mergeable ? 'clean' : 'dirty';
  out.rebaseable = out.mergeable;
  const stats = pullStats(repo, pull);
  out.commits = stats.commits;
  out.additions = stats.additions;
  out.deletions = stats.deletions;
  out.changed_files = stats.changedFiles;
  void lookup;
  return out;
}

function commentJson(store: Store, repo: Repo, item: Issue | Pull, comment: { id: number; body: string; author: string; createdSeq: number }, base: string): Record<string, unknown> {
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: Buffer.from(`10:IssueComment${comment.id}`).toString('base64'),
    url: `${repoUrl}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`,
    issue_url: `${repoUrl}/issues/${item.number}`,
    body: comment.body,
    user: userJson(comment.author),
    created_at: isoOf(store, comment.createdSeq),
    updated_at: isoOf(store, comment.createdSeq),
    author_association: 'OWNER',
  };
}

function commitJson(store: Store, repo: Repo, oid: string, base: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  const ident = (raw: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(raw);
    return {
      name: match?.[1] ?? '',
      email: match?.[2] ?? '',
      date: new Date((match ? Number(match[3]) : 0) * 1000).toISOString(),
    };
  };
  void store;
  return {
    sha: oid,
    node_id: Buffer.from(`06:Commit${oid}`).toString('base64'),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${oid}`,
    commit: {
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      author: ident(view.author),
      committer: ident(view.committer),
      message: view.message,
      tree: { sha: view.tree, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${view.tree}` },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: view.parents.map((parent) => ({
      sha: parent,
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${parent}`,
      html_url: `${base}/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// git-side helpers for REST operations
// ---------------------------------------------------------------------------

/** Resolve a branch name, ref or object id to a commit id in this repo. */
export function resolveCommit(repo: Repo, refOrSha: string): string | null {
  const lookup = repoLookup(repo);
  const candidates = [
    repo.refs.get(refOrSha),
    repo.refs.get(`refs/heads/${refOrSha}`),
    repo.refs.get(`refs/tags/${refOrSha}`),
    refOrSha === 'HEAD' ? repo.refs.get(repo.headRef) : undefined,
    lookup(refOrSha) ? refOrSha : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const commit = peelToCommit(lookup, candidate);
    if (commit) return commit;
  }
  return null;
}

/** Commits reachable from `tip`, newest first (DFS pre-order, parents in order). */
export function listCommits(repo: Repo, tip: string): string[] {
  const lookup = repoLookup(repo);
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

interface TreeMerge {
  files: Map<string, { mode: string; oid: string }>;
  conflicts: string[];
}

/** Path-level three-way merge of two tips against their merge base. */
export function mergeTrees(repo: Repo, baseTip: string, headTip: string): TreeMerge {
  const lookup = repoLookup(repo);
  const baseCommit = mergeBase(lookup, baseTip, headTip);
  const treeOf = (commit: string | null): Map<string, { mode: string; oid: string }> => {
    if (!commit) return new Map();
    const object = lookup(commit);
    if (!object || object.type !== 'commit') return new Map();
    return flattenTree(lookup, parseCommit(object.data).tree);
  };
  const baseFiles = treeOf(baseCommit);
  const ourFiles = treeOf(baseTip);
  const theirFiles = treeOf(headTip);
  const result = new Map(ourFiles);
  const conflicts: string[] = [];
  const paths = new Set([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  const same = (a?: { mode: string; oid: string }, b?: { mode: string; oid: string }): boolean =>
    a?.oid === b?.oid && a?.mode === b?.mode;
  for (const path of paths) {
    const b = baseFiles.get(path);
    const o = ourFiles.get(path);
    const t = theirFiles.get(path);
    if (same(t, b)) continue; // head side unchanged
    if (same(o, b)) {
      if (t) result.set(path, t);
      else result.delete(path);
      continue;
    }
    if (same(o, t)) continue;
    conflicts.push(path);
  }
  return { files: result, conflicts };
}

function computeMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.merged) return true;
  const headSha = repo.refs.get(pull.headRef);
  const baseSha = repo.refs.get(pull.baseRef);
  if (!headSha || !baseSha) return false;
  if (headSha === baseSha) return false;
  return mergeTrees(repo, baseSha, headSha).conflicts.length === 0;
}

interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

/** Line-diff counts via LCS on the two blob texts (files here are small). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length;
  const n = b.length;
  if (m * n > 4_000_000) {
    return { additions: n, deletions: m };
  }
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

export function diffFiles(repo: Repo, fromTreeCommit: string | null, toCommit: string): FileDiff[] {
  const lookup = repoLookup(repo);
  const treeOf = (commit: string | null): Map<string, { mode: string; oid: string }> => {
    if (!commit) return new Map();
    const object = lookup(commit);
    if (!object || object.type !== 'commit') return new Map();
    return flattenTree(lookup, parseCommit(object.data).tree);
  };
  const from = treeOf(fromTreeCommit);
  const to = treeOf(toCommit);
  const out: FileDiff[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const f = from.get(path);
    const t = to.get(path);
    if (f?.oid === t?.oid && f?.mode === t?.mode) continue;
    const text = (entry?: { mode: string; oid: string }): string => {
      if (!entry) return '';
      const object = lookup(entry.oid);
      return object ? object.data.toString('utf8') : '';
    };
    const { additions, deletions } = lineDiff(text(f), text(t));
    out.push({
      filename: path,
      status: !f ? 'added' : !t ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: t?.oid ?? null,
    });
  }
  return out;
}

function pullStats(repo: Repo, pull: Pull): { commits: number; additions: number; deletions: number; changedFiles: number } {
  const lookup = repoLookup(repo);
  const headSha = repo.refs.get(pull.headRef);
  const baseSha = repo.refs.get(pull.baseRef);
  if (!headSha || !baseSha) return { commits: 0, additions: 0, deletions: 0, changedFiles: 0 };
  const base = mergeBase(lookup, baseSha, headSha);
  const files = diffFiles(repo, base, headSha);
  const headCommits = new Set(listCommits(repo, headSha));
  const baseCommits = new Set(base ? listCommits(repo, base) : []);
  let commits = 0;
  for (const oid of headCommits) if (!baseCommits.has(oid)) commits += 1;
  return {
    commits,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    changedFiles: files.length,
  };
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  base: string;
  body: Record<string, unknown> | null;
  query: URLSearchParams;
}

function paginate<T>(ctx: Ctx, items: T[], path: string): T[] {
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const next = `${ctx.base}${path}?${params.toString()}`;
    params.set('page', String(totalPages));
    const last = `${ctx.base}${path}?${params.toString()}`;
    ctx.res.setHeader('Link', `<${next}>; rel="next", <${last}>; rel="last"`);
  }
  return items.slice((page - 1) * perPage, page * perPage);
}

export async function handleRest(ctx: Ctx, segments: string[]): Promise<void> {
  const { store, res, base } = ctx;
  const method = ctx.req.method ?? 'GET';
  const [s0, s1, s2, s3, s4, s5] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound(res);
    res.setHeader('X-OAuth-Scopes', 'repo, read:org, user');
    return sendJson(res, 200, {
      current_user_url: `${base}/api/v3/user`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      issue_search_url: `${base}/api/v3/search/issues?q={query}`,
      emojis_url: `${base}/api/v3/emojis`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
    });
  }

  if (s0 === 'meta' && segments.length === 1 && method === 'GET') {
    return sendJson(res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: '1.0.0-ember-forge',
      github_services_sha: 'ember',
    });
  }

  if (s0 === 'user' && segments.length === 1) {
    if (method === 'GET') return sendJson(res, 200, userJson(VIEWER.login));
    return notFound(res);
  }

  if (s0 === 'user' && s1 === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = store.viewerRepos().map((repo) => repoJson(store, repo, base));
      return sendJson(res, 200, paginate(ctx, repos, '/api/v3/user/repos'));
    }
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return validationFailed(res, 'Repository creation failed: name is invalid');
      if (store.getRepo(VIEWER.login, name)) {
        return sendJson(res, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
      }
      const repo = store.createRepo(name, {
        description: typeof body.description === 'string' ? body.description : null,
        private: body.private === true,
        defaultBranch: typeof body.default_branch === 'string' && body.default_branch ? body.default_branch : 'main',
      });
      repo.updatedSeq = store.tick().seq;
      return sendJson(res, 201, repoJson(store, repo, base));
    }
    return notFound(res);
  }

  if (s0 !== 'repos' || !s1 || !s2) return notFound(res);
  const repo = store.getRepo(s1, s2);
  if (!repo) return notFound(res);
  const repoPath = `/api/v3/repos/${repo.owner}/${repo.name}`;

  if (segments.length === 3) {
    if (method === 'GET') return sendJson(res, 200, repoJson(store, repo, base));
    if (method === 'PATCH') {
      const body = ctx.body ?? {};
      if (typeof body.description === 'string' || body.description === null) repo.description = body.description as string | null;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name && body.name !== repo.name && !store.getRepo(repo.owner, body.name)) {
        store.repos.delete(store.key(repo.owner, repo.name));
        repo.name = body.name;
        store.repos.set(store.key(repo.owner, repo.name), repo);
      }
      repo.updatedSeq = store.tick().seq;
      return sendJson(res, 200, repoJson(store, repo, base));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'X-GitHub-Request-Id': `EMBER-${(++requestSeq).toString(16).toUpperCase().padStart(6, '0')}` });
      return res.end();
    }
    return notFound(res);
  }

  // ---- git refs / branches / commits ----
  if (s3 === 'git' && s4 === 'refs' && segments.length === 5) {
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return validationFailed(res, 'Invalid ref or sha');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, {
        ref,
        node_id: Buffer.from(`08:Ref${repo.id}:${ref}`).toString('base64'),
        url: `${base}${repoPath}/git/refs/${ref.replace('refs/', '')}`,
        object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${base}${repoPath}/git/commits/${sha}` },
      });
    }
    if (method === 'GET') {
      const list = [...repo.refs.entries()].map(([ref, sha]) => ({
        ref,
        node_id: Buffer.from(`08:Ref${repo.id}:${ref}`).toString('base64'),
        url: `${base}${repoPath}/git/refs/${ref.replace('refs/', '')}`,
        object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${base}${repoPath}/git/commits/${sha}` },
      }));
      return sendJson(res, 200, list);
    }
    return notFound(res);
  }

  if (s3 === 'branches' && segments.length === 4 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha, url: `${base}${repoPath}/commits/${sha}` },
        protected: false,
      }));
    return sendJson(res, 200, branches);
  }

  if (s3 === 'commits' && segments.length === 4 && method === 'GET') {
    const refParam = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveCommit(repo, refParam);
    if (!tip) return sendJson(res, 200, []);
    const all = listCommits(repo, tip)
      .map((oid) => commitJson(store, repo, oid, base))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    return sendJson(res, 200, paginate(ctx, all, `${repoPath}/commits`));
  }
  if (s3 === 'commits' && segments.length === 5 && method === 'GET') {
    const entry = commitJson(store, repo, s4, base);
    if (!entry) return notFound(res);
    return sendJson(res, 200, entry);
  }

  // ---- contents ----
  if (s3 === 'contents') {
    const path = segments.slice(4).join('/');
    return handleContents(ctx, repo, repoPath, path);
  }

  // ---- labels ----
  if (s3 === 'labels' && segments.length === 4) {
    if (method === 'GET') {
      return sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label, repo, base)));
    }
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) return validationFailed(res, 'Label creation failed: name is required');
      if (repo.labels.has(name)) return validationFailed(res, 'Validation Failed: label already exists');
      const label: Label = {
        id: store.nextLabelId(),
        name,
        color: (typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed').toLowerCase(),
        description: typeof body.description === 'string' ? body.description : null,
      };
      repo.labels.set(name, label);
      return sendJson(res, 201, labelJson(label, repo, base));
    }
    return notFound(res);
  }

  // ---- issues & pulls (shared number space) ----
  if (s3 === 'issues' || s3 === 'pulls') {
    return handleIssuesAndPulls(ctx, repo, repoPath, segments);
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function handleContents(ctx: Ctx, repo: Repo, repoPath: string, rawPath: string): void {
  const { store, res, base, method } = { store: ctx.store, res: ctx.res, base: ctx.base, method: ctx.req.method ?? 'GET' };
  const path = decodeURIComponent(rawPath);
  const body = ctx.body ?? {};
  const branchName = typeof body.branch === 'string' && body.branch ? body.branch : null;

  const refForRead = ctx.query.get('ref') ?? branchName ?? repo.defaultBranch;
  const refForWrite = branchName ?? repo.defaultBranch;
  const writeRef = `refs/heads/${refForWrite}`;

  if (method === 'GET') {
    const commit = resolveCommit(repo, refForRead);
    if (!commit) {
      // An unborn repository reads as an empty directory at the root, 404 deeper.
      if (path === '') return sendJson(res, 200, []);
      return notFound(res);
    }
    const tree = parseCommit(repo.objects.get(commit)?.data ?? Buffer.alloc(0)).tree;
    const files = readTreeFiles(repo, tree);
    if (path === '') {
      return sendJson(res, 200, dirListing(repo, repoPath, base, tree, ''));
    }
    const entry = files.get(path);
    if (entry) {
      const blob = repo.objects.get(entry.oid);
      const content = blob ? blob.data.toString('base64').replace(/.{60}/g, '$&\n') : '';
      return sendJson(res, 200, {
        name: path.split('/').pop(),
        path,
        sha: entry.oid,
        size: blob?.data.length ?? 0,
        url: `${base}${repoPath}/contents/${path}`,
        html_url: `${base}/${repo.owner}/${repo.name}/blob/${refForRead}/${path}`,
        git_url: `${base}${repoPath}/git/blobs/${entry.oid}`,
        download_url: `${base}/${repo.owner}/${repo.name}/raw/${refForRead}/${path}`,
        type: 'file',
        encoding: 'base64',
        content,
        _links: { self: `${base}${repoPath}/contents/${path}`, git: `${base}${repoPath}/git/blobs/${entry.oid}`, html: `${base}/${repo.owner}/${repo.name}/blob/${refForRead}/${path}` },
      });
    }
    // directory?
    const prefix = `${path}/`;
    if ([...files.keys()].some((key) => key.startsWith(prefix))) {
      const subTree = findSubTree(repo, tree, path);
      if (subTree) return sendJson(res, 200, dirListing(repo, repoPath, base, subTree, path));
    }
    return notFound(res);
  }

  if (method === 'PUT') {
    const message = typeof body.message === 'string' ? body.message : '';
    const contentB64 = typeof body.content === 'string' ? body.content : null;
    if (!message || contentB64 === null) return validationFailed(res, 'Commit creation failed: message and content are required');
    const tip = repo.refs.get(writeRef);
    const tipCommit = tip ? peelToCommit(repoLookup(repo), tip) : null;
    const files = tipCommit ? readTreeFiles(repo, parseCommit(repo.objects.get(tipCommit)?.data ?? Buffer.alloc(0)).tree) : new Map<string, { mode: string; oid: string }>();
    const existing = files.get(path);
    const suppliedSha = typeof body.sha === 'string' ? body.sha : null;
    if (existing) {
      if (suppliedSha === null) return validationFailed(res, 'sha wasn\'t supplied');
      if (suppliedSha !== existing.oid) {
        return sendJson(res, 409, { message: `${path} does not match ${suppliedSha}`, documentation_url: 'https://docs.github.com/rest' });
      }
    }
    const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const blobOid = storeBlob(repo, data);
    files.set(path, { mode: '100644', oid: blobOid });
    const tree = buildTreeFromFiles(repo, files);
    const commitOid = makeCommit(store, repo, { tree, parents: tipCommit ? [tipCommit] : [], message });
    repo.refs.set(writeRef, commitOid);
    if (writeRef === repo.headRef && repo.defaultBranch !== refForWrite) {
      // Writing to another branch does not move HEAD.
    }
    repo.updatedSeq = store.tick().seq;
    const status = existing ? 200 : 201;
    return sendJson(res, status, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: data.length,
        url: `${base}${repoPath}/contents/${path}`,
        html_url: `${base}/${repo.owner}/${repo.name}/blob/${refForWrite}/${path}`,
        git_url: `${base}${repoPath}/git/blobs/${blobOid}`,
        download_url: `${base}/${repo.owner}/${repo.name}/raw/${refForWrite}/${path}`,
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        _links: { self: `${base}${repoPath}/contents/${path}`, git: `${base}${repoPath}/git/blobs/${blobOid}`, html: `${base}/${repo.owner}/${repo.name}/blob/${refForWrite}/${path}` },
      },
      commit: {
        sha: commitOid,
        url: `${base}${repoPath}/git/commits/${commitOid}`,
        html_url: `${base}/${repo.owner}/${repo.name}/commit/${commitOid}`,
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: store.nowIso() },
        committer: { name: VIEWER.name, email: VIEWER.email, date: store.nowIso() },
        tree: { sha: tree, url: `${base}${repoPath}/git/trees/${tree}` },
        parents: tipCommit ? [{ sha: tipCommit, url: `${base}${repoPath}/git/commits/${tipCommit}`, html_url: `${base}/${repo.owner}/${repo.name}/commit/${tipCommit}` }] : [],
      },
    });
  }

  if (method === 'DELETE') {
    const message = typeof body.message === 'string' ? body.message : '';
    const suppliedSha = typeof body.sha === 'string' ? body.sha : null;
    if (!message || suppliedSha === null) return validationFailed(res, 'sha and message are required');
    const tip = repo.refs.get(writeRef);
    const tipCommit = tip ? peelToCommit(repoLookup(repo), tip) : null;
    if (!tipCommit) return notFound(res);
    const files = readTreeFiles(repo, parseCommit(repo.objects.get(tipCommit)?.data ?? Buffer.alloc(0)).tree);
    const existing = files.get(path);
    if (!existing) return notFound(res);
    if (existing.oid !== suppliedSha) {
      return sendJson(res, 409, { message: `${path} does not match ${suppliedSha}` });
    }
    files.delete(path);
    const tree = buildTreeFromFiles(repo, files);
    const commitOid = makeCommit(store, repo, { tree, parents: [tipCommit], message });
    repo.refs.set(writeRef, commitOid);
    repo.updatedSeq = store.tick().seq;
    return sendJson(res, 200, {
      content: null,
      commit: {
        sha: commitOid,
        url: `${base}${repoPath}/git/commits/${commitOid}`,
        html_url: `${base}/${repo.owner}/${repo.name}/commit/${commitOid}`,
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: store.nowIso() },
        committer: { name: VIEWER.name, email: VIEWER.email, date: store.nowIso() },
        tree: { sha: tree, url: `${base}${repoPath}/git/trees/${tree}` },
        parents: [{ sha: tipCommit, url: `${base}${repoPath}/git/commits/${tipCommit}`, html_url: `${base}/${repo.owner}/${repo.name}/commit/${tipCommit}` }],
      },
    });
  }

  return notFound(res);
}

function findSubTree(repo: Repo, treeOid: string, path: string): string | null {
  let current = treeOid;
  for (const part of path.split('/')) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function dirListing(repo: Repo, repoPath: string, base: string, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : repo.objects.get(entry.oid);
    return {
      name: entry.name,
      path,
      sha: entry.oid,
      size: blob?.data.length ?? 0,
      url: `${base}${repoPath}/contents/${path}`,
      html_url: `${base}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
      git_url: `${base}${repoPath}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      download_url: isDir ? null : `${base}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
      type: isDir ? 'dir' : 'file',
      _links: {
        self: `${base}${repoPath}/contents/${path}`,
        git: `${base}${repoPath}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        html: `${base}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// issues & pulls
// ---------------------------------------------------------------------------

function handleIssuesAndPulls(ctx: Ctx, repo: Repo, repoPath: string, segments: string[]): void {
  const { store, res, base } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body ?? {};
  const kind = segments[3]; // 'issues' | 'pulls'

  if (segments.length === 4) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let items = [...repo.issues.values()].filter((item) => (kind === 'issues' ? true : item.isPull));
      if (kind === 'pulls') items = items.filter((item) => item.isPull);
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      const direction = ctx.query.get('direction') ?? 'desc';
      items.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
      const labelsFilter = ctx.query.get('labels');
      if (labelsFilter && kind === 'issues') {
        const wanted = labelsFilter.split(',');
        items = items.filter((item) => !item.isPull && wanted.every((name) => (item as Issue).labels.includes(name)));
      }
      const rendered = items.map((item) => (item.isPull ? pullJson(store, repo, item as Pull, base) : issueJson(store, repo, item, base)));
      return sendJson(res, 200, paginate(ctx, rendered, `${repoPath}/${kind}`));
    }
    if (method === 'POST' && kind === 'issues') {
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) return validationFailed(res, 'Issue creation failed: title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.map((entry) => (typeof entry === 'string' ? entry : (entry as { name?: string })?.name ?? '')).filter(Boolean) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) {
          return sendJson(res, 422, { message: 'Validation Failed: label not found', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
        }
      }
      const now = store.tick();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title,
        body: typeof body.body === 'string' ? body.body : null,
        state: 'open',
        labels: labelNames,
        author: VIEWER.login,
        createdSeq: now.seq,
        updatedSeq: now.seq,
        comments: [],
        isPull: false,
      };
      repo.issues.set(issue.number, issue);
      return sendJson(res, 201, issueJson(store, repo, issue, base));
    }
    if (method === 'POST' && kind === 'pulls') {
      const title = typeof body.title === 'string' ? body.title : '';
      const headRaw = typeof body.head === 'string' ? body.head : '';
      const baseRaw = typeof body.base === 'string' ? body.base : '';
      const headBranch = headRaw.includes(':') ? headRaw.split(':').pop() as string : headRaw;
      const baseBranch = baseRaw.includes(':') ? baseRaw.split(':').pop() as string : baseRaw;
      const headRef = `refs/heads/${headBranch}`;
      const baseRef = `refs/heads/${baseBranch}`;
      const headSha = repo.refs.get(headRef);
      const baseSha = repo.refs.get(baseRef);
      if (!title) return validationFailed(res, 'Pull request creation failed: title is required');
      if (!headSha) return sendJson(res, 422, { message: 'Validation Failed: head sha not found' });
      if (!baseSha) return sendJson(res, 422, { message: 'Validation Failed: base sha not found' });
      if (headSha === baseSha) return sendJson(res, 422, { message: 'Validation Failed: No commits between base and head' });
      const lookup = repoLookup(repo);
      const between = collectReachable(lookup, [headSha]).size - collectReachable(lookup, [baseSha]).size;
      void between;
      const existingOpen = [...repo.issues.values()].find(
        (item) => item.isPull && item.state === 'open' && (item as Pull).headRef === headRef && (item as Pull).baseRef === baseRef,
      );
      if (existingOpen) return sendJson(res, 422, { message: `A pull request already exists for ${headBranch}.` });
      const now = store.tick();
      const pull: Pull = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title,
        body: typeof body.body === 'string' ? body.body : null,
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
      return sendJson(res, 201, pullJson(store, repo, pull, base));
    }
    return notFound(res);
  }

  const number = Number(segments[4]);
  const item = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (segments.length === 5) {
    if (!item) return notFound(res);
    if (kind === 'pulls' && !item.isPull) return notFound(res);
    if (method === 'GET') {
      return sendJson(res, 200, item.isPull ? pullJson(store, repo, item as Pull, base) : issueJson(store, repo, item, base));
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string') item.title = body.title;
      if (typeof body.body === 'string' || body.body === null) item.body = body.body as string | null;
      if (body.state === 'open' || body.state === 'closed') item.state = body.state;
      if (!item.isPull && Array.isArray(body.labels)) {
        const names = body.labels.map((entry) => (typeof entry === 'string' ? entry : (entry as { name?: string })?.name ?? '')).filter(Boolean);
        for (const name of names) if (!repo.labels.has(name)) return validationFailed(res, 'Validation Failed: label not found');
        (item as Issue).labels = names;
      }
      item.updatedSeq = store.tick().seq;
      return sendJson(res, 200, item.isPull ? pullJson(store, repo, item as Pull, base) : issueJson(store, repo, item, base));
    }
    return notFound(res);
  }

  if (!item) return notFound(res);

  if (segments[5] === 'comments' && segments.length === 6) {
    if (method === 'GET') {
      return sendJson(res, 200, item.comments.map((comment) => commentJson(store, repo, item, comment, base)));
    }
    if (method === 'POST') {
      const text = typeof body.body === 'string' ? body.body : '';
      if (!text) return validationFailed(res, 'Comment creation failed: body is required');
      const now = store.tick();
      const comment = { id: store.nextCommentId(), body: text, author: VIEWER.login, createdSeq: now.seq };
      item.comments.push(comment);
      item.updatedSeq = now.seq;
      return sendJson(res, 201, commentJson(store, repo, item, comment, base));
    }
    return notFound(res);
  }

  if (kind === 'pulls' && segments[5] === 'files' && segments.length === 6 && method === 'GET') {
    const pull = item as Pull;
    const lookup = repoLookup(repo);
    const headSha = repo.refs.get(pull.headRef);
    const baseSha = repo.refs.get(pull.baseRef);
    if (!headSha || !baseSha) return sendJson(res, 200, []);
    const base = mergeBase(lookup, baseSha, headSha);
    const files = diffFiles(repo, base, headSha).map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      blob_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.sha ?? ''}`,
      raw_url: `${base}/${repo.owner}/${repo.name}/raw/${pull.headRef.replace('refs/heads/', '')}/${file.filename}`,
      contents_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${file.filename}?ref=${pull.headRef.replace('refs/heads/', '')}`,
    }));
    return sendJson(res, 200, files);
  }

  if (kind === 'pulls' && segments[5] === 'merge' && segments.length === 6 && method === 'PUT') {
    const pull = item as Pull;
    if (pull.merged || pull.state !== 'open') {
      return sendJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest' });
    }
    const headSha = repo.refs.get(pull.headRef);
    const baseSha = repo.refs.get(pull.baseRef);
    if (!headSha || !baseSha) return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    const merged = mergeTrees(repo, baseSha, headSha);
    if (merged.conflicts.length) {
      return sendJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest' });
    }
    const methodWanted = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    const tree = buildTreeFromFiles(repo, merged.files);
    const now = store.tick();
    let message: string;
    let parents: string[];
    if (methodWanted === 'squash') {
      const title = typeof body.commit_title === 'string' && body.commit_title ? body.commit_title : `${pull.title} (#${pull.number})`;
      const detail = typeof body.commit_message === 'string' ? body.commit_message : (pull.body ?? '');
      message = detail ? `${title}\n\n${detail}` : title;
      parents = [baseSha];
    } else if (methodWanted === 'rebase') {
      // Approximate rebase with a single replayed commit (the suite uses squash/merge).
      message = pull.title;
      parents = [baseSha];
    } else {
      message = typeof body.commit_title === 'string' && body.commit_title
        ? body.commit_title
        : `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef.replace('refs/heads/', '')}`;
      parents = [baseSha, headSha];
    }
    const commitOid = makeCommit(store, repo, { tree, parents, message });
    repo.refs.set(pull.baseRef, commitOid);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedSeq = now.seq;
    pull.updatedSeq = now.seq;
    pull.mergeCommitSha = commitOid;
    return sendJson(res, 200, { sha: commitOid, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound(res);
}

// Re-exported for the GraphQL layer, which shares these shapes.
export { issueJson, pullJson, labelJson, commentJson, commitJson, isoOf };
export type { FileDiff };
