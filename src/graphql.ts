// GraphQL v4 surface (/api/graphql): a small but real GraphQL engine — tokenizer, parser and
// executor — over a schema that covers what gh and github-mcp-server ask of this forge:
// viewer, repository fields, issues/pullRequests connections with cursor pagination, the
// issue/PR mutations, node(id:) and the __type introspection probes.
//
// Global ids are the same base64 `NN:Type<id>` node ids the REST surface emits, so an id read
// through one surface round-trips through the other.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { mergeBase } from './git.ts';
import {
  buildTreeFromFiles,
  makeCommit,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { diffFiles, mergeTrees } from './rest.ts';

// ---------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------

const ID_PREFIX: Record<string, string> = {
  Repository: '07',
  Issue: '08',
  Label: '09',
  IssueComment: '10',
  PullRequest: '11',
  User: '04',
};

export function globalId(type: string, id: number): string {
  return Buffer.from(`${ID_PREFIX[type] ?? '00'}:${type}${id}`).toString('base64');
}

export function decodeGlobalId(raw: string): { type: string; id: number } | null {
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const match = /^\d+:([A-Za-z]+)(\d+)$/.exec(text);
    if (!match) return null;
    return { type: match[1], id: Number(match[2]) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// tokenizer & parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'lit'; value: unknown }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selectionSet?: FieldNode[];
  fragmentType?: string; // inline fragment marker: this node IS the fragment's selection wrapper
}

interface Operation {
  opType: 'query' | 'mutation';
  name?: string;
  selectionSet: FieldNode[];
}

class GqlError extends Error {}

function tokenize(input: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new GqlError('unterminated block string');
        tokens.push({ kind: 'string', value: JSON.parse(`"${input.slice(i + 3, end).replace(/"/g, '\\"')}"`) as string });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          out += input[j] + input[j + 1];
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new GqlError('unterminated string');
      tokens.push({ kind: 'string', value: JSON.parse(`"${out}"`) as string });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) j += 1;
      tokens.push({ kind: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Array<{ kind: string; value: string }>;
  constructor(tokens: Array<{ kind: string; value: string }>) {
    this.tokens = tokens;
  }

  private peek(): { kind: string; value: string } {
    return this.tokens[this.pos];
  }
  private next(): { kind: string; value: string } {
    return this.tokens[this.pos++];
  }
  private expect(kind: string, value?: string): { kind: string; value: string } {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new GqlError(`expected ${value ?? kind}, got ${token.value || token.kind}`);
    }
    return token;
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FieldNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FieldNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ opType: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipVariableDefs();
        this.skipDirectives();
        operations.push({ opType: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name', 'on');
        this.expect('name');
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new GqlError(`unexpected token ${token.value}`);
    }
    return { operations, fragments };
  }

  private skipVariableDefs(): void {
    this.expect('punct', '(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new GqlError('unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expect('name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipVariableDefs();
    }
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('punct', '{');
    const fields: FieldNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new GqlError('unterminated selection set');
      fields.push(this.parseField());
    }
    this.next();
    return fields;
  }

  private parseField(): FieldNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const type = this.expect('name').value;
        this.skipDirectives();
        return { name: '__inlineFragment', fragmentType: type, args: {}, selectionSet: this.parseSelectionSet() };
      }
      const fragName = this.expect('name').value;
      return { name: '__fragmentSpread', fragmentType: fragName, args: {} };
    }
    let name = this.expect('name').value;
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expect('name').value;
        this.expect('punct', ':');
        args[argName] = this.parseValue();
      }
      this.next();
    }
    this.skipDirectives();
    let selectionSet: FieldNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.expect('name').value };
    }
    if (token.kind === 'string') return { kind: 'lit', value: token.value };
    if (token.kind === 'number') return { kind: 'lit', value: token.value.includes('.') ? parseFloat(token.value) : parseInt(token.value, 10) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'lit', value: true };
      if (token.value === 'false') return { kind: 'lit', value: false };
      if (token.value === 'null') return { kind: 'lit', value: null };
      return { kind: 'lit', value: token.value }; // enum
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const key = this.expect('name').value;
        this.expect('punct', ':');
        fields[key] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new GqlError(`unexpected value token ${token.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'lit':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema data: introspection
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'reopenIssue', 'updateIssue', 'createRepository'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId', 'createdAt', 'updatedAt', 'repositories', 'issues'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'url', 'homepageUrl',
    'createdAt', 'updatedAt', 'pushedAt', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled',
    'defaultBranchRef', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'stargazerCount', 'forkCount',
    'primaryLanguage', 'licenseInfo', 'repositoryTopics', 'refs', 'object', 'assignableUsers', 'mentionableUsers',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'bodyHTML', 'state', 'url', 'author', 'editor', 'labels',
    'comments', 'assignees', 'milestone', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked',
    'viewerCanReact', 'viewerCanSubscribe', 'participants', 'projectCards', 'reactions', 'timelineItems',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'url', 'author', 'labels', 'comments',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'headRepository', 'baseRepository', 'mergeable', 'merged',
    'mergedAt', 'mergeCommit', 'mergedBy', 'isDraft', 'files', 'commits', 'additions', 'deletions', 'changedFiles',
    'repository', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked', 'viewerCanUpdate', 'reviews', 'participants',
  ],
  Label: ['id', 'name', 'color', 'description', 'url', 'createdAt', 'updatedAt', 'isDefault'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'url', 'createdAt', 'updatedAt', 'issue', 'repository', 'viewerCanReact'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository', 'associatedPullRequests'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'author', 'committer', 'committedDate', 'authoredDate', 'tree', 'parents', 'url', 'repository'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject', 'timelineEdge'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'issueCount', 'repositoryCount', 'userCount', 'codeCount'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPrivacy: ['PUBLIC', 'PRIVATE'],
  Permission: ['READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  StateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
};

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

type Node = Record<string, unknown> & { __typename: string };

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; type?: string; path?: string[] }>;
  fragments: Map<string, FieldNode[]>;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionSpec<T> {
  items: T[];
  first?: number;
  after?: string;
}

function paginateConnection<T>(spec: ConnectionSpec<T>): { page: T[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null; total: number } {
  const start = spec.after ? indexFromCursor(spec.after) + 1 : 0;
  const first = spec.first ?? 30;
  const page = spec.items.slice(start, start + first);
  const lastIndex = start + page.length - 1;
  return {
    page,
    hasNextPage: start + page.length < spec.items.length,
    endCursor: page.length ? cursorFor(lastIndex) : null,
    startCursor: page.length ? cursorFor(start) : null,
    total: spec.items.length,
  };
}

function repoNode(repo: Repo): Node {
  return { __typename: 'Repository', repo };
}

function userNode(login: string): Node {
  return { __typename: 'User', login };
}

function issueNode(repo: Repo, item: Issue): Node {
  return { __typename: 'Issue', repo, item };
}

function pullNode(repo: Repo, item: Pull): Node {
  return { __typename: 'PullRequest', repo, item };
}

function findItemByGlobalId(store: Store, type: string, id: number): { repo: Repo; item: Issue | Pull } | null {
  for (const repo of store.repos.values()) {
    for (const item of repo.issues.values()) {
      if (item.id === id && ((type === 'Issue' && !item.isPull) || (type === 'PullRequest' && item.isPull))) {
        return { repo, item };
      }
    }
  }
  return null;
}

function findRepoByGlobalId(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

type Resolver = (ctx: ExecCtx, parent: Node, args: Record<string, unknown>) => unknown;

function connectionNode(typename: string, page: ReturnType<typeof paginateConnection<Node>>): Node {
  return {
    __typename: typename,
    nodesList: page.page,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: page.hasNextPage,
      hasPreviousPage: false,
      startCursor: page.startCursor,
      endCursor: page.endCursor,
    },
    totalCount: page.total,
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode(VIEWER.login),
    repository: (ctx, _parent, args) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoNode(repo) : null;
    },
    node: (ctx, _parent, args) => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = findRepoByGlobalId(ctx.store, decoded.id);
        return repo ? repoNode(repo) : null;
      }
      if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
        const found = findItemByGlobalId(ctx.store, decoded.type, decoded.id);
        if (!found) return null;
        return found.item.isPull ? pullNode(found.repo, found.item as Pull) : issueNode(found.repo, found.item as Issue);
      }
      if (decoded.type === 'User') return userNode(VIEWER.login);
      return null;
    },
    __type: (_ctx, _parent, args) => typeNode(String(args.name ?? '')),
    __schema: () => ({ __typename: '__Schema', typesList: Object.keys(TYPE_FIELDS) }),
  },
  Mutation: {
    createIssue: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded ? findRepoByGlobalId(ctx.store, decoded.id) : null;
      if (!repo) throw new GqlError('repository not found');
      const now = ctx.store.tick();
      const issue: Issue = {
        id: ctx.store.nextIssueId(),
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : null,
        state: 'open',
        labels: [],
        author: VIEWER.login,
        createdSeq: now.seq,
        updatedSeq: now.seq,
        comments: [],
        isPull: false,
      };
      if (Array.isArray(input.labelIds)) {
        for (const raw of input.labelIds) {
          const labelRef = decodeGlobalId(String(raw));
          if (!labelRef) continue;
          for (const label of repo.labels.values()) if (label.id === labelRef.id) issue.labels.push(label.name);
        }
      }
      repo.issues.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const found = decoded ? findItemByGlobalId(ctx.store, 'Issue', decoded.id) : null;
      if (!found) throw new GqlError('issue not found');
      found.item.state = 'closed';
      found.item.updatedSeq = ctx.store.tick().seq;
      return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.item as Issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded ? findRepoByGlobalId(ctx.store, decoded.id) : null;
      if (!repo) throw new GqlError('repository not found');
      const clean = (value: unknown): string => String(value ?? '').replace(/^refs\/heads\//, '');
      const headRef = `refs/heads/${clean(input.headRefName)}`;
      const baseRef = `refs/heads/${clean(input.baseRefName)}`;
      if (!repo.refs.has(headRef) || !repo.refs.has(baseRef)) throw new GqlError('head or base ref not found');
      const now = ctx.store.tick();
      const pull: Pull = {
        id: ctx.store.nextIssueId(),
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : null,
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
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const found = decoded ? findItemByGlobalId(ctx.store, 'PullRequest', decoded.id) : null;
      if (!found) throw new GqlError('pull request not found');
      const repo = found.repo;
      const pull = found.item as Pull;
      if (!pull.merged && pull.state === 'open') {
        const headSha = repo.refs.get(pull.headRef);
        const baseSha = repo.refs.get(pull.baseRef);
        if (headSha && baseSha) {
          const merged = mergeTrees(repo, baseSha, headSha);
          if (!merged.conflicts.length) {
            const method = String(input.mergeMethod ?? 'SQUASH').toUpperCase();
            const tree = buildTreeFromFiles(repo, merged.files);
            const now = ctx.store.tick();
            let message: string;
            let parents: string[];
            if (method === 'MERGE') {
              message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef.replace('refs/heads/', '')}`;
              parents = [baseSha, headSha];
            } else {
              const detail = pull.body ?? '';
              message = detail ? `${pull.title} (#${pull.number})\n\n${detail}` : `${pull.title} (#${pull.number})`;
              parents = [baseSha];
            }
            const commitOid = makeCommit(ctx.store, repo, { tree, parents, message });
            repo.refs.set(pull.baseRef, commitOid);
            pull.merged = true;
            pull.state = 'closed';
            pull.mergedSeq = now.seq;
            pull.updatedSeq = now.seq;
            pull.mergeCommitSha = commitOid;
          }
        }
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      let found: { repo: Repo; item: Issue | Pull } | null = null;
      if (decoded) {
        found = findItemByGlobalId(ctx.store, 'Issue', decoded.id) ?? findItemByGlobalId(ctx.store, 'PullRequest', decoded.id);
      }
      if (!found) throw new GqlError('subject not found');
      const now = ctx.store.tick();
      const comment = { id: ctx.store.nextCommentId(), body: String(input.body ?? ''), author: VIEWER.login, createdSeq: now.seq };
      found.item.comments.push(comment);
      found.item.updatedSeq = now.seq;
      const node: Node = { __typename: 'IssueComment', repo: found.repo, item: found.item, comment };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(found.item.comments.length - 1) },
        subject: found.item.isPull ? pullNode(found.repo, found.item as Pull) : issueNode(found.repo, found.item as Issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  User: {
    id: () => globalId('User', VIEWER.id),
    login: (_ctx, parent) => parent.login as string,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    databaseId: () => VIEWER.id,
    url: () => '',
  },
  Repository: {
    id: (_ctx, parent) => globalId('Repository', (parent.repo as Repo).id),
    databaseId: (_ctx, parent) => (parent.repo as Repo).id,
    name: (_ctx, parent) => (parent.repo as Repo).name,
    nameWithOwner: (_ctx, parent) => `${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
    owner: (_ctx, parent) => userNode((parent.repo as Repo).owner),
    description: (_ctx, parent) => (parent.repo as Repo).description,
    isPrivate: (_ctx, parent) => (parent.repo as Repo).private,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => true,
    hasWikiEnabled: () => true,
    isFork: () => false,
    stargazerCount: () => 0,
    forkCount: () => 0,
    url: () => '',
    createdAt: (ctx, parent) => ctx.store.isoOfSeq((parent.repo as Repo).createdSeq),
    updatedAt: (ctx, parent) => ctx.store.isoOfSeq((parent.repo as Repo).updatedSeq),
    pushedAt: (ctx, parent) => ctx.store.isoOfSeq((parent.repo as Repo).updatedSeq),
    defaultBranchRef: (_ctx, parent) => {
      const repo = parent.repo as Repo;
      const oid = repo.refs.get(repo.headRef);
      if (!oid) return null;
      return { __typename: 'Ref', repo, name: repo.defaultBranch, oid } as Node;
    },
    issue: (_ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const item = repo.issues.get(Number(args.number));
      return item && !item.isPull ? issueNode(repo, item as Issue) : null;
    },
    issues: (ctx, parent, args) => {
      const repo = parent.repo as Repo;
      let items = [...repo.issues.values()].filter((item) => !item.isPull) as Issue[];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states) items = items.filter((item) => states.includes(item.state.toUpperCase()));
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
      items.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
      const page = paginateConnection({
        items: items.map((item) => issueNode(repo, item)),
        first: typeof args.first === 'number' ? args.first : undefined,
        after: typeof args.after === 'string' ? args.after : undefined,
      });
      return connectionNode('IssueConnection', page);
    },
    pullRequest: (_ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const item = repo.issues.get(Number(args.number));
      return item && item.isPull ? pullNode(repo, item as Pull) : null;
    },
    pullRequests: (ctx, parent, args) => {
      const repo = parent.repo as Repo;
      let items = [...repo.issues.values()].filter((item) => item.isPull) as Pull[];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states) items = items.filter((item) => states.includes(item.state.toUpperCase()));
      items.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      const page = paginateConnection({
        items: items.map((item) => pullNode(repo, item)),
        first: typeof args.first === 'number' ? args.first : undefined,
        after: typeof args.after === 'string' ? args.after : undefined,
      });
      return connectionNode('PullRequestConnection', page);
    },
  },
  Ref: {
    id: (_ctx, parent) => globalId('Repository', (parent.repo as Repo).id) + ':' + (parent.name as string),
    name: (_ctx, parent) => parent.name as string,
    prefix: () => 'refs/heads/',
    target: (_ctx, parent) => ({ __typename: 'Commit', oid: parent.oid as string }),
    repository: (_ctx, parent) => repoNode(parent.repo as Repo),
  },
  Commit: {
    id: (_ctx, parent) => parent.oid as string,
    oid: (_ctx, parent) => parent.oid as string,
  },
  Issue: {
    id: (_ctx, parent) => globalId('Issue', (parent.item as Issue).id),
    databaseId: (_ctx, parent) => (parent.item as Issue).id,
    number: (_ctx, parent) => (parent.item as Issue).number,
    title: (_ctx, parent) => (parent.item as Issue).title,
    body: (_ctx, parent) => (parent.item as Issue).body,
    bodyText: (_ctx, parent) => (parent.item as Issue).body ?? '',
    state: (_ctx, parent) => (parent.item as Issue).state.toUpperCase(),
    author: (_ctx, parent) => userNode((parent.item as Issue).author),
    repository: (_ctx, parent) => repoNode(parent.repo as Repo),
    url: () => '',
    createdAt: (ctx, parent) => ctx.store.isoOfSeq((parent.item as Issue).createdSeq),
    updatedAt: (ctx, parent) => ctx.store.isoOfSeq((parent.item as Issue).updatedSeq),
    closedAt: (ctx, parent) => {
      const item = parent.item as Issue;
      return item.state === 'closed' ? ctx.store.isoOfSeq(item.updatedSeq) : null;
    },
    closed: (_ctx, parent) => (parent.item as Issue).state === 'closed',
    locked: () => false,
    labels: (_ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const item = parent.item as Issue;
      const nodes = item.labels
        .map((name) => repo.labels.get(name))
        .filter((label) => Boolean(label))
        .map((label) => ({ __typename: 'Label', repo, label }) as Node);
      const page = paginateConnection({ items: nodes, first: typeof args.first === 'number' ? args.first : undefined });
      return connectionNode('LabelConnection', page);
    },
    comments: (_ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const item = parent.item as Issue;
      const nodes = item.comments.map((comment) => ({ __typename: 'IssueComment', repo, item, comment }) as Node);
      const page = paginateConnection({ items: nodes, first: typeof args.first === 'number' ? args.first : undefined, after: typeof args.after === 'string' ? args.after : undefined });
      return connectionNode('IssueCommentConnection', page);
    },
  },
  PullRequest: {
    id: (_ctx, parent) => globalId('PullRequest', (parent.item as Pull).id),
    databaseId: (_ctx, parent) => (parent.item as Pull).id,
    number: (_ctx, parent) => (parent.item as Pull).number,
    title: (_ctx, parent) => (parent.item as Pull).title,
    body: (_ctx, parent) => (parent.item as Pull).body,
    bodyText: (_ctx, parent) => (parent.item as Pull).body ?? '',
    state: (_ctx, parent) => {
      const item = parent.item as Pull;
      return item.merged ? 'MERGED' : item.state.toUpperCase();
    },
    merged: (_ctx, parent) => (parent.item as Pull).merged,
    mergedAt: (ctx, parent) => {
      const item = parent.item as Pull;
      return item.merged ? ctx.store.isoOfSeq(item.mergedSeq ?? item.updatedSeq) : null;
    },
    mergeable: (_ctx, parent) => {
      const repo = parent.repo as Repo;
      const item = parent.item as Pull;
      const headSha = repo.refs.get(item.headRef);
      const baseSha = repo.refs.get(item.baseRef);
      if (!headSha || !baseSha) return 'UNKNOWN';
      return mergeTrees(repo, baseSha, headSha).conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (_ctx, parent) => (parent.item as Pull).headRef.replace('refs/heads/', ''),
    baseRefName: (_ctx, parent) => (parent.item as Pull).baseRef.replace('refs/heads/', ''),
    headRef: (_ctx, parent) => {
      const repo = parent.repo as Repo;
      const item = parent.item as Pull;
      const oid = repo.refs.get(item.headRef);
      return oid ? ({ __typename: 'Ref', repo, name: item.headRef.replace('refs/heads/', ''), oid } as Node) : null;
    },
    baseRef: (_ctx, parent) => {
      const repo = parent.repo as Repo;
      const item = parent.item as Pull;
      const oid = repo.refs.get(item.baseRef);
      return oid ? ({ __typename: 'Ref', repo, name: item.baseRef.replace('refs/heads/', ''), oid } as Node) : null;
    },
    mergeCommit: (_ctx, parent) => {
      const item = parent.item as Pull;
      return item.mergeCommitSha ? ({ __typename: 'Commit', oid: item.mergeCommitSha } as Node) : null;
    },
    author: (_ctx, parent) => userNode((parent.item as Pull).author),
    repository: (_ctx, parent) => repoNode(parent.repo as Repo),
    url: () => '',
    isDraft: () => false,
    closed: (_ctx, parent) => (parent.item as Pull).state === 'closed',
    locked: () => false,
    createdAt: (ctx, parent) => ctx.store.isoOfSeq((parent.item as Pull).createdSeq),
    updatedAt: (ctx, parent) => ctx.store.isoOfSeq((parent.item as Pull).updatedSeq),
    closedAt: (ctx, parent) => {
      const item = parent.item as Pull;
      return item.state === 'closed' ? ctx.store.isoOfSeq(item.updatedSeq) : null;
    },
    files: (_ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const item = parent.item as Pull;
      const headSha = repo.refs.get(item.headRef);
      const baseSha = repo.refs.get(item.baseRef);
      let nodes: Node[] = [];
      if (headSha && baseSha) {
        const base = mergeBase((oid) => repo.objects.get(oid), baseSha, headSha);
        nodes = diffFiles(repo, base, headSha).map((file) => ({
          __typename: 'PullRequestFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status.toUpperCase(),
        }) as Node);
      }
      const page = paginateConnection({ items: nodes, first: typeof args.first === 'number' ? args.first : undefined, after: typeof args.after === 'string' ? args.after : undefined });
      return connectionNode('PullRequestFileConnection', page);
    },
    comments: (_ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const item = parent.item as Pull;
      const nodes = item.comments.map((comment) => ({ __typename: 'IssueComment', repo, item, comment }) as Node);
      const page = paginateConnection({ items: nodes, first: typeof args.first === 'number' ? args.first : undefined });
      return connectionNode('IssueCommentConnection', page);
    },
    labels: (_ctx, parent, args) => {
      void parent;
      const page = paginateConnection({ items: [] as Node[], first: typeof args.first === 'number' ? args.first : undefined });
      return connectionNode('LabelConnection', page);
    },
  },
  Label: {
    id: (_ctx, parent) => globalId('Label', (parent.label as { id: number }).id),
    name: (_ctx, parent) => (parent.label as { name: string }).name,
    color: (_ctx, parent) => (parent.label as { color: string }).color,
    description: (_ctx, parent) => (parent.label as { description: string | null }).description,
    isDefault: () => false,
    url: () => '',
  },
  IssueComment: {
    id: (_ctx, parent) => globalId('IssueComment', (parent.comment as { id: number }).id),
    databaseId: (_ctx, parent) => (parent.comment as { id: number }).id,
    body: (_ctx, parent) => (parent.comment as { body: string }).body,
    bodyText: (_ctx, parent) => (parent.comment as { body: string }).body,
    author: (_ctx, parent) => userNode((parent.comment as { author: string }).author),
    createdAt: (ctx, parent) => ctx.store.isoOfSeq((parent.comment as { createdSeq: number }).createdSeq),
    updatedAt: (ctx, parent) => ctx.store.isoOfSeq((parent.comment as { createdSeq: number }).createdSeq),
    url: () => '',
  },
  __Type: {
    name: (_ctx, parent) => parent.typeName as string,
    kind: (_ctx, parent) => (TYPE_ENUMS[parent.typeName as string] ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (_ctx, parent) => {
      const names = TYPE_FIELDS[parent.typeName as string] ?? [];
      return names.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (_ctx, parent) => {
      const names = TYPE_ENUMS[parent.typeName as string] ?? [];
      return names.map((name) => ({ __typename: '__EnumValue', name }));
    },
    possibleTypes: () => [],
    inputFields: () => [],
    ofType: () => null,
    interfaces: () => [],
  },
  __Field: {
    name: (_ctx, parent) => parent.name as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (_ctx, parent) => parent.name as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: (_ctx, parent) => (parent.typesList as string[]).map((name) => typeNode(name)),
    queryType: () => typeNode('Query'),
    mutationType: () => typeNode('Mutation'),
    subscriptionType: () => null,
    directives: () => [],
  },
};

function typeNode(name: string): Node {
  return { __typename: '__Type', typeName: name };
}

// Connection field resolvers, registered for every connection type.
for (const typename of ['IssueConnection', 'PullRequestConnection', 'LabelConnection', 'IssueCommentConnection', 'PullRequestFileConnection']) {
  RESOLVERS[typename] = {
    nodes: (_ctx, parent) => parent.nodesList as Node[],
    edges: (_ctx, parent) =>
      (parent.nodesList as Node[]).map((node, index) => ({ __typename: 'Edge', node, cursor: cursorFor(index) })),
    pageInfo: (_ctx, parent) => parent.pageInfo as Node,
    totalCount: (_ctx, parent) => parent.totalCount as number,
  };
}
RESOLVERS.PageInfo = {
  hasNextPage: (_ctx, parent) => parent.hasNextPage as boolean,
  hasPreviousPage: (_ctx, parent) => parent.hasPreviousPage as boolean,
  startCursor: (_ctx, parent) => parent.startCursor as string | null,
  endCursor: (_ctx, parent) => parent.endCursor as string | null,
};
RESOLVERS.Edge = {
  node: (_ctx, parent) => parent.node as Node,
  cursor: (_ctx, parent) => parent.cursor as string,
};
RESOLVERS.IssueCommentEdge = RESOLVERS.Edge;
for (const payload of ['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']) {
  RESOLVERS[payload] = {
    issue: (_ctx, parent) => (parent.issue as Node) ?? null,
    pullRequest: (_ctx, parent) => (parent.pullRequest as Node) ?? null,
    commentEdge: (_ctx, parent) => (parent.commentEdge as Node) ?? null,
    subject: (_ctx, parent) => (parent.subject as Node) ?? null,
    clientMutationId: (_ctx, parent) => (parent.clientMutationId as string | null) ?? null,
  };
}
RESOLVERS.PullRequestFile = {
  path: (_ctx, parent) => parent.path as string,
  additions: (_ctx, parent) => parent.additions as number,
  deletions: (_ctx, parent) => parent.deletions as number,
  changeType: (_ctx, parent) => parent.changeType as string,
};

const KNOWN_TYPES = new Set([...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_ENUMS), 'PullRequestFile', 'Edge', 'PageInfo', '__Type', '__Field', '__EnumValue', '__Schema']);

function executeSelectionSet(ctx: ExecCtx, typename: string, parent: Node, selections: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.name === '__inlineFragment' || field.name === '__fragmentSpread') {
      const fragSelections = field.name === '__inlineFragment' ? field.selectionSet ?? [] : ctx.fragments.get(field.fragmentType ?? '') ?? [];
      const fragType = field.name === '__inlineFragment' ? field.fragmentType : undefined;
      if (!fragType || fragType === typename) {
        Object.assign(out, executeSelectionSet(ctx, typename, parent, fragSelections));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typename;
      continue;
    }
    const resolver = RESOLVERS[typename]?.[field.name];
    if (!resolver) {
      ctx.errors.push({
        message: `Field '${field.name}' doesn't exist on type '${typename}'`,
        type: 'FIELD_ERROR',
        path: [key],
      });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, valueNode] of Object.entries(field.args)) args[argName] = resolveValue(valueNode, ctx.variables);
    let value: unknown;
    try {
      value = resolver(ctx, parent, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [key] });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, field);
  }
  return out;
}

function completeValue(ctx: ExecCtx, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, field));
  if (typeof value === 'object') {
    const node = value as Node;
    if (typeof node.__typename === 'string') {
      if (!field.selectionSet) return node;
      return executeSelectionSet(ctx, node.__typename, node, field.selectionSet);
    }
    return value;
  }
  return value;
}

function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>, fragments: Map<string, FieldNode[]>): Record<string, unknown> {
  const ctx: ExecCtx = { store, variables, errors: [], fragments };
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  const root: Node = { __typename: rootType };
  const data = executeSelectionSet(ctx, rootType, root, operation.selectionSet);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length) envelope.errors = ctx.errors;
  return envelope;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  void req;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }));
    return;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const results: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const body = (entry ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
    if (typeof body.query !== 'string') {
      results.push({ errors: [{ message: 'Missing query' }] });
      continue;
    }
    try {
      const { operations, fragments } = new Parser(tokenize(body.query)).parseDocument();
      const operation = body.operationName
        ? operations.find((op) => op.name === body.operationName) ?? operations[0]
        : operations[0];
      if (!operation) throw new GqlError('no operation in document');
      results.push(executeOperation(store, operation, body.variables ?? {}, fragments));
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    }
  }
  const payload = Array.isArray(parsed) ? results : results[0];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export { KNOWN_TYPES };
