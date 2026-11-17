// Git smart HTTP: the ref advertisements (protocol v0 and v2), ls-refs, fetch and receive-pack.
// The suite is the only client; it speaks v2 for upload-pack (when it sends Git-Protocol:
// version=2) and v0 for receive-pack. Every response is built from the store's own objects —
// no git binary, no outside service.

import { decodePktLines, DELIM, encodePktLines, FLUSH, pktLine, sidebandData } from './pkt.ts';
import {
  collectCommitTree,
  collectHeld,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'gitforge/0.1.0';

/** Refs in advertisement order: HEAD first, then heads, then tags, each alphabetical. */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => {
    const rank = (name: string): number => (name.startsWith('refs/heads/') ? 0 : name.startsWith('refs/tags/') ? 1 : 2);
    return rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  return refs;
}

/** The commit a tag object peels to, following a chain of tags. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.objects.get(current);
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

function headSymref(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 upload-pack advertisement: service preamble, refs, capabilities on the first line. */
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = sortedRefs(repo);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed symref=HEAD:${headSymref(repo)} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${headSymref(repo)} agent=${AGENT}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = refs.find((ref) => ref.name === headSymref(repo));
    const headOid = head?.oid ?? refs[0]?.oid ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 upload-pack advertisement: service preamble, `version 2`, capability lines. */
function advertisementV2(repo: Repo): Buffer {
  void repo;
  const lines: Array<string | 'flush'> = [
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ];
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- fetch computation

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** The objects a fetch delivers, plus its shallow-info and acknowledgments. */
export interface FetchPlan {
  /** The objects to send, in pack order. */
  objects: GitObject[];
  /** The new shallow boundary commits. */
  shallow: string[];
  /** Old shallow boundaries that are no longer shallow. */
  unshallow: string[];
  /** Haves that are ancestors of (or equal to) a want. */
  acks: string[];
}

function commitDepthWalk(
  repo: Repo,
  roots: readonly string[],
  depth: number | null,
): { commits: Set<string>; frontier: Set<string> } {
  const commits = new Set<string>();
  const frontier = new Set<string>();
  // BFS by generation: depth 1 is the wants themselves.
  let current: string[] = [];
  for (const root of roots) {
    const object = repo.objects.get(root);
    if (!object) continue;
    if (object.type === 'tag') {
      // A wanted tag: the tag itself is delivered, and its target is the commit root.
      commits.add(root);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'commit') current.push(target);
      continue;
    }
    if (object.type === 'commit') current.push(root);
    else commits.add(root); // a wanted tree/blob is delivered as-is
  }
  let generation = 1;
  const seen = new Set<string>(current);
  while (current.length > 0) {
    const next: string[] = [];
    for (const oid of current) {
      commits.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const atLimit = depth !== null && generation >= depth;
      if (atLimit) {
        frontier.add(oid);
        continue;
      }
      for (const parent of parents) {
        if (!seen.has(parent) && repo.objects.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
      if (parents.length === 0) frontier.add(oid);
    }
    current = next;
    generation += 1;
  }
  return { commits, frontier };
}

export function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const { commits: wantedCommits, frontier } = commitDepthWalk(repo, request.wants, request.depth);
  // Every object reachable from the wanted commits (trees, blobs, tag targets).
  const wantedObjects = new Set<string>();
  for (const oid of wantedCommits) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      wantedObjects.add(oid);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'commit') {
        for (const reachable of collectCommitTree(target, lookup)) wantedObjects.add(reachable);
      } else if (targetObject) {
        for (const reachable of collectReachable([target], lookup)) wantedObjects.add(reachable);
      }
    } else if (object.type === 'commit') {
      // The commit's own tree only — never its parents, or a shallow fetch leaks history.
      for (const reachable of collectCommitTree(oid, lookup)) wantedObjects.add(reachable);
    } else {
      wantedObjects.add(oid);
    }
  }
  // Everything the client already holds: the closure of its haves, stopping at its shallow
  // boundaries (a shallow client holds the boundary commit, not its parents).
  const held = collectHeld(request.haves, request.shallow, lookup);
  // The delivered set: wanted minus held.
  const delivered = new Set<string>();
  for (const oid of wantedObjects) if (!held.has(oid)) delivered.add(oid);

  // Order the pack: commits first (in walk order), then tags, trees, blobs.
  const ordered: GitObject[] = [];
  const byType = (type: string): string[] => [...delivered].filter((oid) => repo.objects.get(oid)?.type === type);
  for (const oid of byType('commit')) {
    const object = repo.objects.get(oid);
    if (object) ordered.push(object);
  }
  for (const oid of byType('tag')) {
    const object = repo.objects.get(oid);
    if (object) ordered.push(object);
  }
  for (const oid of byType('tree')) {
    const object = repo.objects.get(oid);
    if (object) ordered.push(object);
  }
  for (const oid of byType('blob')) {
    const object = repo.objects.get(oid);
    if (object) ordered.push(object);
  }

  // Shallow-info: only a depth-limited fetch has a boundary.
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (request.depth !== null) {
    shallow = [...frontier].filter((oid) => repo.objects.get(oid)?.type === 'commit').sort();
    const present = new Set([...held, ...delivered]);
    for (const boundary of request.shallow) {
      const object = repo.objects.get(boundary);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.every((parent) => present.has(parent))) unshallow.push(boundary);
    }
    unshallow.sort();
  }

  // Acknowledgments: haves that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const have of request.haves) {
    if (!repo.objects.has(have)) continue;
    if (request.wants.some((want) => isAncestor(have, want, lookup))) acks.push(have);
  }
  return { objects: ordered, shallow, unshallow, acks };
}

// ---------------------------------------------------------------- request parsing

/** Parse v2 command lines into a command plus its argument lines. */
function parseV2Command(body: Buffer): { command: string | null; args: string[] } {
  const { packets } = decodePktLines(body);
  let command: string | null = null;
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenDelim && line.startsWith('command=')) {
      command = line.slice('command='.length).trim();
      continue;
    }
    if (!seenDelim) continue; // agent= / object-format= lines before the delimiter
    args.push(line.replace(/\n$/, ''));
  }
  return { command, args };
}

/** Parse a v0 fetch body: wants, shallow lines, deepen, haves. */
function parseV0Fetch(body: Buffer): FetchRequest {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).split(' ')[0] as string;
        if (isObjectId(rest)) wants.push(rest);
      } else if (line.startsWith('shallow ')) {
        shallow.push(line.slice(8).trim());
      } else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isFinite(n) && n > 0) depth = Math.trunc(n);
      }
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    }
  }
  return { wants, haves, shallow, depth };
}

// ---------------------------------------------------------------- handlers

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitResult(status: number, contentType: string, body: Buffer): GitResponse {
  return { status, contentType, body };
}

function json404(message: string): GitResponse {
  return gitResult(404, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message }), 'utf8'));
}

/** GET /{owner}/{repo}.git/info/refs?service=... — the advertisement. */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocolVersion2: boolean,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404('Not Found');
  if (service === 'git-upload-pack') {
    const cacheKey = gitProtocolVersion2 ? 'up-v2' : 'up-v0';
    let body = repo.adCache.get(cacheKey);
    if (!body) {
      body = gitProtocolVersion2 ? advertisementV2(repo) : advertisementV0(repo, 'git-upload-pack');
      repo.adCache.set(cacheKey, body);
    }
    return gitResult(200, 'application/x-git-upload-pack-advertisement', body);
  }
  if (service === 'git-receive-pack') {
    let body = repo.adCache.get('recv-v0');
    if (!body) {
      body = advertisementV0(repo, 'git-receive-pack');
      repo.adCache.set('recv-v0', body);
    }
    return gitResult(200, 'application/x-git-receive-pack-advertisement', body);
  }
  return json404('Not Found');
}

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** The v2 ls-refs answer: one line per ref, HEAD first, then a flush. */
function lsRefsLines(repo: Repo, options: LsRefsOptions): Array<string | 'flush'> {
  const lines: Array<string | 'flush'> = [];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headSymref(repo));
  const matches = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (options.unborn && matches('HEAD')) lines.push(`unborn HEAD symref-target:${headSymref(repo)}\n`);
    lines.push('flush');
    return lines;
  }
  if (matches('HEAD')) {
    const head = headOid !== undefined && options.symrefs ? ` symref-target:${headSymref(repo)}` : '';
    lines.push(`${headOid ?? ZERO_OID} HEAD${head}\n`);
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (options.peel) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return lines;
}

/**
 * Build the v2 fetch response: acknowledgments, shallow-info, wanted-refs, packfile sections.
 * The acknowledgments section is sent only when the request carried haves: a client that
 * sent none (a fresh clone) expects the response to open with the next section — real git
 * dies with "expected 'packfile', received 'acknowledgments'" otherwise.
 */
function fetchV2Response(repo: Repo, plan: FetchPlan, wants: readonly string[], hadHaves: boolean): Buffer {
  const parts: Buffer[] = [];
  if (hadHaves) {
    const ackLines: string[] = [];
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) ackLines.push(`ACK ${ack}\n`);
      ackLines.push('ready\n');
    } else {
      ackLines.push('NAK\n');
    }
    parts.push(encodePktLines(['acknowledgments\n', ...ackLines, 'delim']));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowLines: string[] = [];
    for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines(['shallow-info\n', ...shallowLines, 'delim']));
  }
  const wantedRefs: string[] = [];
  for (const want of wants) {
    for (const ref of sortedRefs(repo)) {
      if (ref.oid === want) wantedRefs.push(`${want} ${ref.name}\n`);
    }
  }
  if (wantedRefs.length > 0) parts.push(encodePktLines(['wanted-refs\n', ...wantedRefs, 'delim']));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(encodePktLines(['packfile\n']));
    parts.push(sidebandData([pack]));
    parts.push(FLUSH);
  } else {
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

/** Build the v0 fetch response: text lines, then the sideband pack, then a flush. */
function fetchV0Response(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  const lines: string[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) lines.push(`ACK ${ack}\n`);
  } else {
    lines.push('NAK\n');
  }
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(lines));
  if (plan.objects.length > 0) {
    parts.push(sidebandData([writePack(plan.objects)]));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack — ls-refs and fetch, v2 or v0. */
export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocolVersion2: boolean,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404('Not Found');
  try {
    if (gitProtocolVersion2) {
      const { command, args } = parseV2Command(body);
      if (command === 'ls-refs') {
        const options: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const arg of args) {
          if (arg === 'peel') options.peel = true;
          else if (arg === 'symrefs') options.symrefs = true;
          else if (arg === 'unborn') options.unborn = true;
          else if (arg.startsWith('ref-prefix ')) options.prefixes.push(arg.slice('ref-prefix '.length));
        }
        return gitResult(200, 'application/x-git-upload-pack-result', encodePktLines(lsRefsLines(repo, options)));
      }
      if (command === 'fetch') {
        const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
        for (const arg of args) {
          if (arg.startsWith('want ')) {
            const oid = arg.slice(5).trim();
            if (isObjectId(oid)) request.wants.push(oid);
          } else if (arg.startsWith('have ')) {
            const oid = arg.slice(5).trim();
            if (isObjectId(oid)) request.haves.push(oid);
          } else if (arg.startsWith('shallow ')) {
            request.shallow.push(arg.slice(8).trim());
          } else if (arg.startsWith('deepen ')) {
            const n = Number(arg.slice(7).trim());
            if (Number.isFinite(n) && n > 0) request.depth = Math.trunc(n);
          }
        }
        if (request.wants.length === 0) {
          return gitResult(
            200,
            'application/x-git-upload-pack-result',
            request.haves.length > 0 ? encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']) : FLUSH,
          );
        }
        // The shallow-clone workload repeats one fetch; cache its pack.
        const cacheKey = request.haves.length === 0 && request.depth !== null ? `fetch|${request.wants.join(',')}|${request.depth}` : null;
        if (cacheKey !== null) {
          const cached = repo.packCache.get(cacheKey);
          if (cached) return gitResult(200, 'application/x-git-upload-pack-result', cached);
        }
        const plan = planFetch(repo, request);
        const response = fetchV2Response(repo, plan, request.wants, request.haves.length > 0);
        if (cacheKey !== null && repo.packCache.size < 64) repo.packCache.set(cacheKey, response);
        return gitResult(200, 'application/x-git-upload-pack-result', response);
      }
      // An unknown v2 command: answer a flush rather than crashing.
      return gitResult(200, 'application/x-git-upload-pack-result', FLUSH);
    }
    const request = parseV0Fetch(body);
    if (request.wants.length === 0) return gitResult(200, 'application/x-git-upload-pack-result', encodePktLines(['NAK\n', 'flush']));
    const plan = planFetch(repo, request);
    return gitResult(200, 'application/x-git-upload-pack-result', fetchV0Response(plan));
  } catch {
    // A malformed body must not take the server down: answer an empty result.
    return gitResult(200, 'application/x-git-upload-pack-result', FLUSH);
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack — apply a push, report-status over sideband. */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404('Not Found');
  const lines: string[] = ['unpack ok'];
  const reportFor: Array<{ ref: string; ok: boolean; reason: string }> = [];
  try {
    const { packets, trailing } = decodePktLines(body);
    const commands: PushCommand[] = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (isObjectId(oldOid) && isObjectId(newOid) && ref.startsWith('refs/')) commands.push({ oldOid, newOid, ref });
    }
    // The pack follows the command flush; a delete-only push carries none.
    let unpackOk = true;
    if (trailing.length > 0) {
      try {
        const read = readPack(trailing, (oid) => repo.objects.get(oid));
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        lines[0] = `unpack ${err instanceof Error ? err.message : 'unpack failed'}`;
      }
    }
    if (!unpackOk) {
      for (const command of commands) reportFor.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    } else {
      for (const command of commands) {
        const current = repo.refs.get(command.ref);
        if (command.newOid === ZERO_OID) {
          // Delete.
          if (current === undefined) {
            reportFor.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
          } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
            reportFor.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          } else {
            repo.refs.delete(command.ref);
            reportFor.push({ ref: command.ref, ok: true, reason: '' });
          }
          continue;
        }
        if (!repo.objects.has(command.newOid)) {
          reportFor.push({ ref: command.ref, ok: false, reason: 'object not found' });
          continue;
        }
        if (command.oldOid === ZERO_OID) {
          if (current !== undefined) {
            reportFor.push({ ref: command.ref, ok: false, reason: 'already exists' });
          } else {
            repo.refs.set(command.ref, command.newOid);
            reportFor.push({ ref: command.ref, ok: true, reason: '' });
          }
          continue;
        }
        if (current === undefined || current !== command.oldOid) {
          reportFor.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        if (!isAncestor(command.oldOid, command.newOid, (oid) => repo.objects.get(oid))) {
          reportFor.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportFor.push({ ref: command.ref, ok: true, reason: '' });
      }
      store.touchRepo(repo);
    }
  } catch {
    // Never crash on a malformed push body; report an unpack failure instead.
    if (lines[0] === 'unpack ok') lines[0] = 'unpack error';
  }
  for (const entry of reportFor) {
    lines.push(entry.ok ? `ok ${entry.ref}` : `ng ${entry.ref} ${entry.reason}`);
  }
  // The report-status stream is itself pkt-lined inside sideband band 1.
  const inner = encodePktLines([...lines.map((line) => `${line}\n`), 'flush']);
  const outer = Buffer.concat([sidebandData([inner]), FLUSH]);
  return gitResult(200, 'application/x-git-receive-pack-result', outer);
}

/** The oid a ref points at, for the REST git-refs surface. */
export function refTarget(repo: Repo, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}
