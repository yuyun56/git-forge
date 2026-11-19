// Git smart HTTP: info/refs advertisements (protocol v0 and v2), upload-pack (v2 ls-refs and
// fetch, v0 fetch) and receive-pack (v0), against the in-memory store. The wire format follows
// git's own protocol, restricted to what the suite's in-process client speaks.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  isAncestor,
  isObjectId,
  parseCommit,
  peelToCommit,
  pktDelim,
  pktFlush,
  readPack,
  writePackKeyed,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { repoLookup, type Repo, type Store } from './store.ts';

const AGENT = 'ember-forge/1.0';

export function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!expected) return true;
  const header = req.headers.authorization;
  return header === `Bearer ${expected}`;
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer | string): void {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': bytes.length });
  res.end(bytes);
}

function notFound(res: ServerResponse): void {
  send(res, 404, 'text/plain; charset=utf-8', 'not found\n');
}

/** Sorted ref names of a repo, HEAD first handled by callers. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The commit a ref peels to (for ^{} lines), or null. */
function peeled(repo: Repo, oid: string): string | null {
  const lookup = repoLookup(repo);
  const object = lookup(oid);
  if (!object || object.type !== 'tag') return null;
  return peelToCommit(lookup, oid);
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(res: ServerResponse): void {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ];
  const body = Buffer.concat([...lines.map((line) => encodePktLine(line)), pktFlush()]);
  send(res, 200, 'application/x-git-upload-pack-advertisement', body);
}

function v0Advertisement(res: ServerResponse, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${repo.headRef} object-format=sha1`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = repo.refs.get(repo.headRef) ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      const peel = peeled(repo, oid);
      if (peel) lines.push(`${peel} ${name}^{}\n`);
    }
  }
  for (const line of lines) parts.push(encodePktLine(line));
  parts.push(pktFlush());
  send(res, 200, `application/x-${service}-advertisement`, Buffer.concat(parts));
}

export function handleInfoRefs(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  service: string | null,
): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    notFound(res);
    return;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(res);
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    v2Advertisement(res);
    return;
  }
  v0Advertisement(res, repo, service);
}

// ---------------------------------------------------------------------------
// pkt-line request parsing
// ---------------------------------------------------------------------------

interface PktRequest {
  /** v2: capability lines before the delimiter. v0: the first flush-terminated section. */
  head: string[];
  /** v2: argument lines after the delimiter. v0: unused (see sections). */
  args: string[];
  /** Every flush-terminated section of data lines, in order (v0: [wants, haves]). */
  sections: string[][];
}

function parsePktRequest(body: Buffer): PktRequest {
  const packets = decodePktLines(body);
  const sections: string[][] = [[]];
  let delimAt: { section: number; index: number } | null = null;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
    } else if (packet.kind === 'delim') {
      if (!delimAt) delimAt = { section: sections.length - 1, index: sections[sections.length - 1].length };
    } else if (packet.kind === 'data') {
      sections[sections.length - 1].push(packet.payload.toString('utf8'));
    }
  }
  while (sections.length && sections[sections.length - 1].length === 0) sections.pop();
  let head: string[] = [];
  let args: string[] = [];
  if (delimAt) {
    const section = sections[delimAt.section] ?? [];
    head = section.slice(0, delimAt.index);
    args = section.slice(delimAt.index);
  } else {
    head = sections[0] ?? [];
  }
  return { head, args, sections };
}

function stripNl(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  // A pkt-line is at most 65520 bytes including its 4-byte header and the 1-byte band.
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  done: boolean;
}

/**
 * Compute the pack for a fetch: objects reachable from the wants, minus what the haves cover,
 * honouring a shallow depth. Returns the pack bytes and the new shallow boundary.
 */
function planFetch(repo: Repo, plan: FetchPlan): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const lookup = repoLookup(repo);
  const clientShallow = new Set(plan.clientShallow);
  const haveSet = collectReachable(lookup, plan.haves, { shallow: clientShallow });
  let include: Set<string>;
  let boundary: string[] = [];
  if (plan.depth !== null && plan.depth > 0) {
    // BFS by generation from the wants (peeling tags to commits for the walk).
    const generations = new Map<string, number>();
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const want of plan.wants) {
      const commit = peelToCommit(lookup, want) ?? want;
      if (!generations.has(commit)) {
        generations.set(commit, 1);
        queue.push({ oid: commit, gen: 1 });
      }
    }
    while (queue.length) {
      const { oid, gen } = queue.shift() as { oid: string; gen: number };
      if (gen >= plan.depth) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!generations.has(parent)) {
          generations.set(parent, gen + 1);
          queue.push({ oid: parent, gen: gen + 1 });
        }
      }
    }
    const commits = new Set(generations.keys());
    boundary = [...commits].filter((oid) => {
      if (generations.get(oid) !== plan.depth) return false;
      const object = lookup(oid);
      return object?.type === 'commit' && parseCommit(object.data).parents.length > 0;
    });
    // Include: the wants' full object closure with boundary commits treated as parentless,
    // plus any non-commit wants (tags/blobs/trees) themselves and their targets.
    const shallowSet = new Set(boundary);
    include = collectReachable(lookup, plan.wants, { shallow: shallowSet });
    // collectReachable stops at boundary commits' parents already; but it also walks parents of
    // non-boundary commits only — the shallow set above only contains the boundary. However the
    // depth-limited commits beyond the boundary are not in `include` because their only path is
    // through a boundary commit's parents. Good. But commits deeper than depth that are reachable
    // from a tag want are excluded the same way.
    void commits;
  } else {
    include = collectReachable(lookup, plan.wants, { shallow: clientShallow });
  }
  const toSend: Array<{ oid: string; object: GitObject }> = [];
  for (const oid of include) {
    if (haveSet.has(oid)) continue;
    // In a shallow fetch, objects the client already holds as its boundary are not resent.
    const object = lookup(oid);
    if (object) toSend.push({ oid, object });
  }
  const pack = writePackKeyed(toSend);
  const unshallow = plan.clientShallow.filter((oid) => !boundary.includes(oid) && plan.depth !== null);
  return { pack, shallow: boundary, unshallow };
}

function handleLsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = stripNl(raw);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const lookup = repoLookup(repo);
  // HEAD first (when it matches the prefixes).
  if (matches('HEAD')) {
    const headOid = repo.refs.get(repo.headRef);
    if (headOid) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:${repo.headRef}`;
      parts.push(encodePktLine(`${line}\n`));
    } else if (unborn) {
      let line = `unborn HEAD`;
      if (symrefs) line += ` symref-target:${repo.headRef}`;
      parts.push(encodePktLine(`${line}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const target = lookup(oid);
      if (target?.type === 'tag') {
        const commit = peelToCommit(lookup, oid);
        if (commit) line += ` peeled:${commit}`;
      }
    }
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV2(repo: Repo, args: string[], res: ServerResponse): void {
  const plan: FetchPlan = { wants: [], haves: [], clientShallow: [], depth: null, done: false };
  for (const raw of args) {
    const line = stripNl(raw);
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.depth = Number(line.slice(7).trim());
    else if (line === 'done') plan.done = true;
  }
  const lookup = repoLookup(repo);
  const parts: Buffer[] = [];
  if (!plan.done) {
    parts.push(encodePktLine('acknowledgments\n'));
    const acks = plan.haves.filter((oid) => lookup(oid)?.type === 'commit');
    if (!acks.length) parts.push(encodePktLine('NAK\n'));
    else for (const oid of acks) parts.push(encodePktLine(`ACK ${oid}\n`));
    parts.push(pktFlush());
    send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  const { pack, shallow, unshallow } = planFetch(repo, plan);
  parts.push(encodePktLine('acknowledgments\n'));
  const acks = plan.haves.filter((oid) => lookup(oid)?.type === 'commit');
  if (!acks.length) parts.push(encodePktLine('NAK\n'));
  else for (const oid of acks) parts.push(encodePktLine(`ACK ${oid}\n`));
  parts.push(encodePktLine('ready\n'));
  parts.push(pktFlush());
  if (plan.depth !== null || plan.clientShallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV0(repo: Repo, request: PktRequest, res: ServerResponse): void {
  const plan: FetchPlan = { wants: [], haves: [], clientShallow: [], depth: null, done: false };
  // v0: section 0 holds want lines (the first may carry capabilities) plus shallow/deepen,
  // then a flush, then section 1 holds have/done lines.
  for (const raw of request.sections[0] ?? []) {
    const line = stripNl(raw);
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      plan.wants.push(oid);
    } else if (line.startsWith('shallow ')) plan.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.depth = Number(line.slice(7).trim());
  }
  for (const raw of request.sections[1] ?? []) {
    const line = stripNl(raw);
    if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line === 'done') plan.done = true;
  }
  const lookup = repoLookup(repo);
  const { pack, shallow, unshallow } = planFetch(repo, plan);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  const acks = plan.haves.filter((oid) => lookup(oid)?.type === 'commit');
  if (!acks.length) parts.push(encodePktLine('NAK\n'));
  else for (const oid of acks) parts.push(encodePktLine(`ACK ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

export function handleUploadPack(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(res);
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  let request: PktRequest;
  try {
    request = parsePktRequest(body);
  } catch {
    send(res, 400, 'text/plain; charset=utf-8', 'bad request\n');
    return;
  }
  if (wantsV2) {
    const command = request.head.map(stripNl).find((line) => line.startsWith('command='));
    if (command === 'command=ls-refs') {
      handleLsRefs(repo, request.args, res);
      return;
    }
    if (command === 'command=fetch') {
      handleFetchV2(repo, request.args, res);
      return;
    }
    send(res, 400, 'text/plain; charset=utf-8', 'unknown command\n');
    return;
  }
  handleFetchV0(repo, request, res);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  void req;
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(res);
    return;
  }
  // Split the body: pkt-lines up to the first flush, then the pack (if any).
  let offset = 0;
  const commandLines: string[] = [];
  while (offset + 4 <= body.length) {
    const length = parseInt(body.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(length) || length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    commandLines.push(body.toString('utf8', offset + 4, offset + length));
    offset += length;
  }
  const packBytes = body.subarray(offset);
  const commands: PushCommand[] = [];
  let useSideband = false;
  let reportStatus = false;
  commandLines.forEach((raw, index) => {
    let line = stripNl(raw);
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        useSideband = caps.includes('side-band-64k');
        reportStatus = caps.includes('report-status') || caps.includes('report-status-v2');
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isObjectId(parts[0]) && isObjectId(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  });

  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, repoLookup(repo));
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const lookup = repoLookup(repo);
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  if (!unpackOk) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const command of commands) {
      results.push(applyPushCommand(repo, lookup, command));
    }
  }

  if (!reportStatus) {
    send(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack error ${unpackError}\n`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`);
  }
  const reportBytes = Buffer.concat(reportLines.map((line) => encodePktLine(line)));
  let payload: Buffer;
  if (useSideband) {
    const parts: Buffer[] = [];
    // The whole report fits in one band-1 packet for our sizes; chunk defensively anyway.
    const CHUNK = 65515;
    for (let at = 0; at < reportBytes.length; at += CHUNK) {
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), reportBytes.subarray(at, at + CHUNK)])));
    }
    parts.push(pktFlush());
    payload = Buffer.concat(parts);
  } else {
    payload = Buffer.concat([reportBytes, pktFlush()]);
  }
  send(res, 200, 'application/x-git-receive-pack-result', payload);
}

function applyPushCommand(
  repo: Repo,
  lookup: (oid: string) => GitObject | undefined,
  command: PushCommand,
): { ref: string; ok: boolean; reason?: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  const isDelete = newOid === ZERO_OID;
  if (isDelete) {
    if (current === ZERO_OID) return { ref, ok: false, reason: 'reference does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ref, ok: false, reason: 'stale info' };
    repo.refs.delete(ref);
    return { ref, ok: true };
  }
  const object = lookup(newOid);
  if (!object) return { ref, ok: false, reason: 'missing object' };
  if (current === ZERO_OID) {
    if (oldOid !== ZERO_OID) return { ref, ok: false, reason: 'stale info' };
    repo.refs.set(ref, newOid);
    return { ref, ok: true };
  }
  if (oldOid !== current) return { ref, ok: false, reason: 'stale info' };
  if (current === newOid) return { ref, ok: true };
  // Fast-forward rule for branches (and any ref whose old and new both peel to commits).
  const oldCommit = peelToCommit(lookup, current);
  const newCommit = peelToCommit(lookup, newOid);
  if (oldCommit && newCommit && !isAncestor(lookup, oldCommit, newCommit)) {
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true };
}
