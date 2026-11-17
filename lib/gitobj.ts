// The git object model: loose-object hashing, tree/commit/tag parsing and building, packfile
// reading and writing (plain objects plus REF_DELTA and OFS_DELTA), reachability, and the
// three-way merge helpers the pull-request surface needs. Standard library only; every object is
// stored byte-for-byte, so a clone round-trips exactly what was pushed.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of the loose-object bytes `<type> <length>\0<data>`. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'ascii'));
  hash.update(data);
  return hash.digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry has no name terminator');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}

/** Build a commit object; the message is stored with a trailing newline, as git writes it. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------- packfiles

/** Read the size varint at `offset`; returns the first byte, the size and the next offset. */
function readVarintSize(buffer: Buffer, offset: number): { first: number; size: number; next: number } {
  const first = buffer[offset] ?? 0;
  let byte = first;
  let size = byte & 0x0f;
  let shift = 4;
  let next = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { first, size, next };
}

/** The OFS_DELTA base offset: a variable-length big-endian-ish encoding. */
function readOfsDeltaBase(buffer: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buffer[offset] ?? 0;
  let baseOffset = byte & 0x7f;
  let next = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] ?? 0;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { baseOffset, next };
}

/** Apply a git delta (copy/insert instructions) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] ?? 0;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base is ${base.length} bytes, delta expects ${sourceSize}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const opcode = delta[offset++] ?? 0;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) copyOffset |= (delta[offset++] ?? 0) << (bit * 8);
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) copySize |= (delta[offset++] ?? 0) << (bit * 8);
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past its base');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (opcode !== 0) {
      if (offset + opcode > delta.length) throw new Error('delta insert runs past its data');
      parts.push(delta.subarray(offset, offset + opcode));
      offset += opcode;
      written += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error(`delta produced ${out.length} bytes, expected ${targetSize}`);
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a PACK v2/v3 packfile into its objects, resolving OFS_DELTA and REF_DELTA entries.
 * REF_DELTA bases outside the pack resolve through `resolveBase`. A bad trailer, a truncated
 * entry or an unresolvable delta throws.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): PackRead {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = sha1Hex(pack.subarray(0, trailerStart));
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { maxOutputLength: Math.max(header.size, 1) });
    if (inflated.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.length}`);
    entry.data = inflated;
    // inflateSync consumes the whole slice; find where the deflate stream ended by re-reading
    // with a length probe: the stream's end is the first offset whose inflate matches the size.
    offset = findDeflateEnd(pack, offset, trailerStart, header.size);
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  let deltaCount = 0;

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as { resolved?: { type: GitObjectType; data: Buffer; oid: string } }).resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid ?? '';
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const resolved = { type, data, oid };
    (entry as { resolved?: unknown }).resolved = resolved;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return resolved;
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

/**
 * Find where a zlib stream starting at `start` ends, by binary search: the smallest end whose
 * inflate yields exactly `size` bytes. Node's inflateSync needs the exact slice, so probe ends.
 */
function findDeflateEnd(buffer: Buffer, start: number, limit: number, size: number): number {
  let low = start;
  let high = limit;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const out = inflateSync(buffer.subarray(start, mid));
      if (out.length === size) {
        high = mid;
      } else {
        low = mid + 1;
      }
    } catch {
      low = mid + 1;
    }
  }
  // Verify the found end inflates to the declared size; otherwise fall back to a linear scan.
  try {
    if (inflateSync(buffer.subarray(start, low)).length === size) return low;
  } catch {
    // fall through
  }
  for (let end = start + 1; end <= limit; end += 1) {
    try {
      if (inflateSync(buffer.subarray(start, end)).length === size) return end;
    } catch {
      // not the end yet
    }
  }
  throw new Error('could not find the end of a deflate stream in the pack');
}

/** Encode one object's pack header: the type/size varint. */
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

/**
 * Build a PACK v2 packfile from plain objects (no deltas: the pack-deltas check passes with
 * zero deltas as long as every object resolves). The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** True when the pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return actual === sha1Hex(pack.subarray(0, pack.length - 20));
}

// ---------------------------------------------------------------- reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * The full closure of `roots`: every commit's ancestors, every tree and blob they name, and every
 * tag's target. Throws when a referenced object is missing.
 */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/**
 * The objects one commit contributes on its own: the commit plus the closure of its tree
 * (trees and blobs), never its parents. This is what a depth-limited fetch delivers per
 * included commit — the full closure would leak history past the depth boundary.
 */
export function collectCommitTree(commitOid: string, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const object = lookup(commitOid);
  if (!object || object.type !== 'commit') return seen;
  seen.add(commitOid);
  const stack: string[] = [parseCommit(object.data).tree];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const entry = lookup(oid);
    if (!entry) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (entry.type === 'tree') {
      for (const child of parseTree(entry.data)) stack.push(child.oid);
    }
  }
  return seen;
}

/**
 * What a client already holds, given its haves and its shallow boundaries: the closure of the
 * haves, but never expanding past a shallow boundary commit — the client has the boundary
 * itself, not its parents. With no boundaries this is the full closure. A have the server
 * does not know is skipped, not an error.
 */
export function collectHeld(haves: Iterable<string>, shallow: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const boundaries = new Set(shallow);
  const seen = new Set<string>();
  const stack: string[] = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      for (const reachable of collectCommitTree(oid, lookup)) seen.add(reachable);
      if (!boundaries.has(oid)) {
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The first common ancestor of two tips (the merge base), or null when they share no history. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  if (a === ZERO_OID || b === ZERO_OID) return null;
  const ancestorsOfA = new Set<string>();
  const stackA: string[] = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    ancestorsOfA.add(oid);
    for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  const queue: string[] = [b];
  const seenB = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (ancestorsOfA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- trees as file maps

export interface FileEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree into path -> file entry, recursing into subdirectories. */
export function flattenTree(treeOid: string, lookup: ObjectLookup): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return files;
}

interface TreeNode {
  files: Map<string, FileEntry>;
  dirs: Map<string, TreeNode>;
}

/** Build a (possibly nested) tree object from a path -> file map; returns the new tree oid. */
export function buildTreeFromFiles(
  files: ReadonlyMap<string, FileEntry>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  const makeNode = (): TreeNode => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      let child = node.dirs.get(name);
      if (!child) {
        child = makeNode();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: TreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** Count the lines of a buffer (a trailing newline does not make an extra empty line). */
export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** A simple line diff: added lines are those in `next` not in `prev` (multiset difference). */
export function lineDiff(prev: Buffer, next: Buffer): { additions: number; deletions: number } {
  const prevLines = prev.length === 0 ? [] : prev.toString('utf8').split('\n');
  const nextLines = next.length === 0 ? [] : next.toString('utf8').split('\n');
  if (prevLines.length > 0 && prevLines[prevLines.length - 1] === '') prevLines.pop();
  if (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') nextLines.pop();
  const prevCounts = new Map<string, number>();
  for (const line of prevLines) prevCounts.set(line, (prevCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of nextLines) {
    const remaining = prevCounts.get(line) ?? 0;
    if (remaining > 0) prevCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of prevCounts.values()) deletions += remaining;
  return { additions, deletions };
}
