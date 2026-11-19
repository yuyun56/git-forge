// Git object model, packfiles and pkt-lines, implemented from scratch on node:zlib and
// node:crypto. No git binary is involved anywhere: objects live in memory as raw bytes,
// addressed by their SHA-1, exactly as git defines them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // '100644', '100755', '120000', '40000', ...
  name: string;
  oid: string;
}

/** Git's tree order: by name, with directories compared as if they ended in '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space);
    const mode = buffer.toString('utf8', offset, space);
    const name = buffer.toString('utf8', space + 1, nul);
    const oid = buffer.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** committer timestamp, seconds */
  committerTime: number;
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const match = / (\d+) [+-]\d{4}$/.exec(committer);
  return { tree, parents, author, committer, message, committerTime: match ? Number(match[1]) : 0 };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message: split >= 0 ? text.slice(split + 2) : '' };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

/** Peel an object id to the commit it ultimately names (through tags); null if it is not commit-bound. */
export function peelToCommit(lookup: (oid: string) => GitObject | undefined, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Every object reachable from the given tips (commits, their trees and blobs, tags and their targets). */
export function collectReachable(
  lookup: (oid: string) => GitObject | undefined,
  tips: Iterable<string>,
  options: { exclude?: ReadonlySet<string>; shallow?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) if (!options.exclude?.has(tip)) stack.push(tip);
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || options.exclude?.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      if (!options.shallow?.has(oid)) for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Ancestor test over commit parents (inclusive). */
export function isAncestor(
  lookup: (oid: string) => GitObject | undefined,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** The best common ancestor of two commits (first found by BFS from b over a's ancestor set). */
export function mergeBase(
  lookup: (oid: string) => GitObject | undefined,
  a: string,
  b: string,
): string | null {
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestors.has(oid)) return oid;
    const object = lookup(oid);
    if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Flatten a tree (recursively) into path -> {mode, oid}. Paths use '/'. */
export function flattenTree(
  lookup: (oid: string) => GitObject | undefined,
  treeOid: string,
  prefix = '',
  out = new Map<string, { mode: string; oid: string }>(),
): Map<string, { mode: string; oid: string }> {
  const object = lookup(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(lookup, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.from(base);
  const deltaBuffer = Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error(`delta base size ${sourceSize} != ${baseBuffer.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

interface PackDelta {
  offset: number;
  baseOffset?: number;
  baseOid?: string;
  delta: Buffer;
}

/**
 * Read a packfile into full objects. `resolveBase` supplies objects a thin pack leaves out
 * (REF_DELTA bases the pack does not carry). OFS_DELTA bases are earlier objects in the pack.
 * Deltas resolve iteratively, so chains work; a resolved delta takes its base's type.
 */
export function readPack(
  pack: Uint8Array,
  resolveBase?: (oid: string) => GitObject | undefined,
): PackReadResult {
  const buffer = Buffer.from(pack);
  if (buffer.length < 12 + 20 || buffer.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = buffer.readUInt32BE(8);
  let offset = 12;
  const objects = new Map<string, GitObject>();
  const resolvedByOffset = new Map<number, GitObject>();
  const deltas: PackDelta[] = [];
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    const objectStart = offset;
    let byte = buffer[offset++];
    const code = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (code === 6) {
      let b = buffer[offset++];
      let baseValue = b & 0x7f;
      while (b & 0x80) {
        b = buffer[offset++];
        baseValue = ((baseValue + 1) * 128) + (b & 0x7f);
      }
      const { data, next } = inflateAt(buffer, offset);
      offset = next;
      deltaCount += 1;
      deltas.push({ offset: objectStart, baseOffset: objectStart - baseValue, delta: data });
    } else if (code === 7) {
      const baseOid = buffer.toString('hex', offset, offset + 20);
      offset += 20;
      const { data, next } = inflateAt(buffer, offset);
      offset = next;
      deltaCount += 1;
      deltas.push({ offset: objectStart, baseOid, delta: data });
    } else {
      const type = CODE_TYPE[code];
      if (!type) throw new Error(`unknown pack object type ${code}`);
      const { data, next } = inflateAt(buffer, offset);
      offset = next;
      if (data.length !== size) throw new Error(`pack object size mismatch for ${type}`);
      const object: GitObject = { type, data };
      resolvedByOffset.set(objectStart, object);
      objects.set(hashObject(type, data), object);
    }
  }
  let remaining = deltas;
  while (remaining.length) {
    const still: PackDelta[] = [];
    let progressed = false;
    for (const delta of remaining) {
      let base: GitObject | undefined;
      if (delta.baseOffset !== undefined) base = resolvedByOffset.get(delta.baseOffset);
      else if (delta.baseOid !== undefined) base = objects.get(delta.baseOid) ?? resolveBase?.(delta.baseOid);
      if (!base) {
        still.push(delta);
        continue;
      }
      const object: GitObject = { type: base.type, data: applyDelta(base.data, delta.delta) };
      resolvedByOffset.set(delta.offset, object);
      objects.set(hashObject(object.type, object.data), object);
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base is missing (unresolved thin pack)');
    remaining = still;
  }
  return { objects, deltaCount };
}

/** Deflated pack entries, cached by object id: objects are immutable, so an entry never changes. */
const packEntryCache = new Map<string, Buffer>();

/** Build a packfile of full objects (no deltas), with the SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  return writePackKeyed([...objects].map((object) => ({ oid: hashObject(object.type, object.data), object })));
}

/** writePack for callers that already know each object's id (the fetch path). */
export function writePackKeyed(entries: ReadonlyArray<{ oid: string; object: GitObject }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const { oid, object } of entries) {
    let entry = packEntryCache.get(oid);
    if (!entry) {
      entry = Buffer.concat([writePackObjectHeader(object.type, object.data.length), deflateSync(object.data)]);
      packEntryCache.set(oid, entry);
    }
    parts.push(entry);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const length = data.length + 4;
  const prefix = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(prefix, 'ascii'), data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Split a buffer of pkt-lines into packets. Trailing partial data is an error. */
export function decodePktLines(bytes: Uint8Array): PktPacket[] {
  const buffer = Buffer.from(bytes);
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const length = parseInt(buffer.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(length)) throw new Error('bad pkt-line length');
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}
