// The forge's whole state, in memory. One Store per process; a trial starts it empty.
//
// Determinism: wall-clock time never enters a response. A logical clock starts at
// MAKEFUN_TRIAL_NOW when the trial provides one (else a fixed epoch) and advances one second
// per stamped event, so a live pass and its replay produce byte-identical answers.

import { buildCommit, buildTree, hashObject, parseTree, type GitObject, type TreeEntry } from './git.ts';

export interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The trial scenario's token owner (a sealed constant of the grading env, kit wire.ts). */
export const VIEWER: Viewer = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  createdSeq: number;
  updatedSeq: number;
  comments: Array<{ id: number; body: string; author: string; createdSeq: number }>;
  isPull: false;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  author: string;
  createdSeq: number;
  updatedSeq: number;
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  comments: Array<{ id: number; body: string; author: string; createdSeq: number }>;
  isPull: true;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name -> object id (HEAD is separate)
  headRef: string; // e.g. refs/heads/main; may be unborn
  labels: Map<string, Label>;
  issues: Map<number, Issue | Pull>; // one shared number sequence, like GitHub
  nextNumber: number;
}

export class Store {
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private labelSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private clockMs: number;
  private clockSeq = 0;
  /** The logical clock's epoch (ms); sequence n maps to epochMs + n seconds. */
  readonly epochMs: number;

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = trialNow ? Date.parse(trialNow) : NaN;
    this.clockMs = Number.isNaN(parsed) ? Date.UTC(2026, 10, 14, 0, 0, 0) : parsed;
    this.epochMs = this.clockMs;
  }

  /** ISO timestamp for a sequence number handed out by tick(). */
  isoOfSeq(seq: number): string {
    return new Date(this.epochMs + seq * 1000).toISOString();
  }

  /** Advance the logical clock and return the new instant. */
  tick(): { ms: number; iso: string; seq: number } {
    this.clockSeq += 1;
    const ms = this.clockMs + this.clockSeq * 1000;
    return { ms, iso: new Date(ms).toISOString(), seq: this.clockSeq };
  }

  nowIso(): string {
    return new Date(this.clockMs + this.clockSeq * 1000).toISOString();
  }

  /** A git ident line for the viewer at the current logical time. */
  viewerIdent(): string {
    const seconds = Math.floor((this.clockMs + this.clockSeq * 1000) / 1000);
    return `${VIEWER.name} <${VIEWER.email}> ${seconds} +0000`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** The viewer's repository, or undefined. Any other owner is invisible (404 semantics). */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, init: { description?: string | null; private?: boolean; defaultBranch?: string }): Repo {
    const now = this.tick();
    const repo: Repo = {
      id: ++this.repoSeq,
      owner: VIEWER.login,
      name,
      description: init.description ?? null,
      private: init.private ?? false,
      defaultBranch: init.defaultBranch ?? 'main',
      createdSeq: now.seq,
      updatedSeq: now.seq,
      objects: new Map(),
      refs: new Map(),
      headRef: `refs/heads/${init.defaultBranch ?? 'main'}`,
      labels: new Map(),
      issues: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.key(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(this.key(owner, name));
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  nextLabelId(): number {
    return ++this.labelSeq;
  }

  nextIssueId(): number {
    return ++this.issueSeq;
  }

  nextCommentId(): number {
    return ++this.commentSeq;
  }
}

// ---------------------------------------------------------------------------
// object helpers on a repo
// ---------------------------------------------------------------------------

export function repoLookup(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

export function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Write a blob and return its id. */
export function storeBlob(repo: Repo, data: Buffer): string {
  return storeObject(repo, 'blob', data);
}

/**
 * Build (and store) the tree for a full path->content map, returning the root tree id.
 * `files` maps '/'-joined paths to {mode, oid} leaves already stored.
 */
export function buildTreeFromFiles(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, leaf] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], leaf);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, leaf] of node.files) entries.push({ mode: leaf.mode, name, oid: leaf.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Read a tree id into a path->{mode,oid} map (recursive). */
export function readTreeFiles(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') readTreeFiles(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Create a commit on top of `parent` (null for a root commit) with the given tree; returns its id. */
export function makeCommit(
  store: Store,
  repo: Repo,
  fields: { tree: string; parents: string[]; message: string },
): string {
  const ident = store.viewerIdent();
  const data = buildCommit({ tree: fields.tree, parents: fields.parents, author: ident, committer: ident, message: fields.message });
  return storeObject(repo, 'commit', data);
}
