// The forge's store: every repository, ref, object, issue, pull request and label, in memory.
// One process, one store; nothing is written to disk, so the hot paths stay fast. All ids are
// sequential counters (stable across reads, deterministic for a given request sequence) and every
// timestamp derives from the trial clock, never the wall clock.

import {
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  lineCount,
  lineDiff,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type FileEntry,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';
import { VIEWER, trialNowIso, trialNowSec } from './scenario.ts';

export const DEFAULT_BRANCH = 'main';

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  nextIssueNumber: number;
  nextCommentId: number;
  pulls: PullRequest[];
  nextPullNumber: number;
  /** Cached packs, keyed by the fetch signature; cleared whenever the repo mutates. */
  packCache: Map<string, Buffer>;
  /** Cached ref advertisements; cleared whenever the refs change. */
  adCache: Map<string, Buffer>;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextLabelId = 1;
  private nextSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const list: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) list.push(repo);
    list.sort((a, b) => a.createdSeq - b.createdSeq);
    return list;
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string }): Repo {
    const now = trialNowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq++,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      nextIssueNumber: 1,
      nextCommentId: 1,
      pulls: [],
      nextPullNumber: 1,
      packCache: new Map(),
      adCache: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The object store lookup for one repository. */
  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Store an object; returns its id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Any mutation of a repo's refs or objects clears its derived caches. */
  touchRepo(repo: Repo): void {
    repo.packCache.clear();
    repo.adCache.clear();
    repo.updatedAt = trialNowIso();
  }

  /** The commit author/committer line for commits this forge writes itself. */
  identityLine(): string {
    return `${VIEWER.name} <${VIEWER.email}> ${trialNowSec()} +0000`;
  }

  // ---------------------------------------------------------- branches and refs

  /** The tip of a branch, or null when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Create a branch at `sha`; false when it already exists or the object is missing. */
  createBranch(repo: Repo, branch: string, sha: string): boolean {
    const ref = `refs/heads/${branch}`;
    if (repo.refs.has(ref)) return false;
    if (!isObjectId(sha) || !repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    this.touchRepo(repo);
    return true;
  }

  // ---------------------------------------------------------- contents commits

  /**
   * Commit one file change on a branch: build the new tree from the branch tip's tree, write the
   * commit, and move the branch. When the branch does not exist it is created from the default
   * branch tip (or from nothing when the repository is unborn). Returns the commit and blob ids.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    opts: { delete?: boolean } = {},
  ): { commitSha: string; blobSha: string | null } {
    const tip = this.branchTip(repo, branch);
    let files = new Map<string, FileEntry>();
    if (tip !== null) {
      const commit = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0));
      files = flattenTree(commit.tree, this.lookup(repo));
    }
    let blobSha: string | null = null;
    if (opts.delete === true) {
      files.delete(path);
    } else {
      blobSha = this.putObject(repo, 'blob', content);
      files.set(path, { mode: '100644', oid: blobSha });
    }
    const treeOid = buildTreeFromFiles(files, (type, data) => this.putObject(repo, type, data));
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === null ? [] : [tip],
      message,
      author: this.identityLine(),
      committer: this.identityLine(),
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    this.touchRepo(repo);
    return { commitSha, blobSha };
  }

  /** The file entry at `path` in the tree of `ref` (a branch name or an object id). */
  fileAt(repo: Repo, ref: string, path: string): { blob: GitObject; sha: string; size: number } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    const files = flattenTree(parseCommit(object.data).tree, this.lookup(repo));
    const entry = files.get(path);
    if (!entry) return null;
    const blob = repo.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { blob, sha: entry.oid, size: blob.data.length };
  }

  /** The directory entries under `prefix` in the tree of `ref` ('' is the root). */
  dirAt(repo: Repo, ref: string, prefix: string): Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string; size?: number }> | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    let treeOid = parseCommit(object.data).tree;
    // Descend into the subtree at the prefix, one segment at a time.
    if (prefix !== '') {
      for (const segment of prefix.split('/')) {
        const treeObject = repo.objects.get(treeOid);
        if (!treeObject || treeObject.type !== 'tree') return null;
        const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segment);
        if (!entry || entry.mode !== '40000') return null;
        treeOid = entry.oid;
      }
    }
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject || treeObject.type !== 'tree') return null;
    const out: Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string; size?: number }> = [];
    for (const entry of parseTree(treeObject.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        out.push({ name: entry.name, path, type: 'dir', sha: entry.oid });
      } else {
        const blob = repo.objects.get(entry.oid);
        out.push({ name: entry.name, path, type: 'file', sha: entry.oid, size: blob?.data.length ?? 0 });
      }
    }
    return out;
  }

  /** Resolve a branch name, a full ref, or a raw object id to a commit id. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const tip = repo.refs.get(`refs/heads/${ref}`);
    if (tip !== undefined) return tip;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) {
      const object = repo.objects.get(tag);
      if (object?.type === 'tag') return parseTag(object.data).object;
      return tag;
    }
    return null;
  }

  /** The commit history from a tip, newest first, following first parents. */
  commitsFrom(repo: Repo, tip: string): Array<{ sha: string; message: string; author: string; committer: string }> {
    const out: Array<{ sha: string; message: string; author: string; committer: string }> = [];
    const seen = new Set<string>();
    let current: string | null = tip;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') break;
      const commit = parseCommit(object.data);
      out.push({ sha: current, message: commit.message, author: commit.author, committer: commit.committer });
      current = commit.parents[0] ?? null;
    }
    return out;
  }

  // ---------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `Label "${name}" does not exist` };
      labels.push(label);
    }
    const now = trialNowIso();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      createdSeq: this.nextSeq++,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  // ---------------------------------------------------------- pull requests

  createPull(repo: Repo, head: string, base: string, title: string, body: string): PullRequest | { error: string } {
    const headSha = this.branchTip(repo, head);
    if (headSha === null) return { error: `head branch "${head}" does not exist` };
    const baseSha = this.branchTip(repo, base);
    if (baseSha === null) return { error: `base branch "${base}" does not exist` };
    const now = trialNowIso();
    const pull: PullRequest = {
      id: this.nextPullId++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      createdSeq: this.nextSeq++,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** The merge base of a pull request, or null when the branches share no history. */
  pullMergeBase(repo: Repo, pull: PullRequest): string | null {
    return mergeBase(pull.headSha, pull.baseSha, this.lookup(repo));
  }

  /** The files a pull request changes, as a merge-base -> head diff. */
  pullFiles(repo: Repo, pull: PullRequest): PullFile[] {
    const base = this.pullMergeBase(repo, pull);
    const lookup = this.lookup(repo);
    const baseFiles = new Map<string, FileEntry>();
    if (base !== null) {
      const baseCommit = repo.objects.get(base);
      if (baseCommit?.type === 'commit') {
        for (const [path, entry] of flattenTree(parseCommit(baseCommit.data).tree, lookup)) baseFiles.set(path, entry);
      }
    }
    const headCommit = repo.objects.get(pull.headSha);
    const headFiles = new Map<string, FileEntry>();
    if (headCommit?.type === 'commit') {
      for (const [path, entry] of flattenTree(parseCommit(headCommit.data).tree, lookup)) headFiles.set(path, entry);
    }
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const files: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const from = baseFiles.get(path);
      const to = headFiles.get(path);
      if (from && !to) {
        const old = repo.objects.get(from.oid)?.data ?? Buffer.alloc(0);
        const deletions = lineCount(old);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!from && to) {
        const next = repo.objects.get(to.oid)?.data ?? Buffer.alloc(0);
        const additions = lineCount(next);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (from && to && from.oid !== to.oid) {
        const prev = repo.objects.get(from.oid)?.data ?? Buffer.alloc(0);
        const next = repo.objects.get(to.oid)?.data ?? Buffer.alloc(0);
        const diff = lineDiff(prev, next);
        files.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
      }
    }
    return files;
  }

  /** Whether a pull request would merge cleanly, and the conflict paths when it would not. */
  pullMergeable(repo: Repo, pull: PullRequest): { mergeable: boolean; conflicts: string[] } {
    if (pull.state !== 'open') return { mergeable: false, conflicts: [] };
    const base = this.pullMergeBase(repo, pull);
    if (base === null) return { mergeable: false, conflicts: [] };
    const lookup = this.lookup(repo);
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(pull.headSha);
    const baseTipCommit = repo.objects.get(pull.baseSha);
    if (!baseCommit?.type || !headCommit?.type || !baseTipCommit?.type) return { mergeable: false, conflicts: [] };
    const baseFiles = flattenTree(parseCommit(baseCommit.data).tree, lookup);
    const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
    const tipFiles = flattenTree(parseCommit(baseTipCommit.data).tree, lookup);
    const conflicts: string[] = [];
    for (const path of new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()])) {
      const from = baseFiles.get(path)?.oid ?? null;
      const head = headFiles.get(path)?.oid ?? null;
      const tip = tipFiles.get(path)?.oid ?? null;
      const headChanged = head !== from;
      const tipChanged = tip !== from;
      if (headChanged && tipChanged && head !== tip) conflicts.push(path);
    }
    return { mergeable: conflicts.length === 0, conflicts };
  }

  /**
   * Squash-merge a pull request: a new commit on the base tip whose tree is the base tree with
   * the merge-base -> head diff applied. Returns the merge commit sha, or an error reason.
   */
  mergePull(repo: Repo, pull: PullRequest): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'pull request is not open', status: 405 };
    // Re-read the live tips: the base may have moved since the pull request was opened.
    const liveHead = this.branchTip(repo, pull.headRef);
    const liveBase = this.branchTip(repo, pull.baseRef);
    if (liveHead === null || liveBase === null) return { error: 'head or base branch is gone', status: 422 };
    pull.headSha = liveHead;
    pull.baseSha = liveBase;
    const { mergeable, conflicts } = this.pullMergeable(repo, pull);
    if (!mergeable) return { error: `merge conflict in ${conflicts.join(', ')}`, status: 405 };
    const base = this.pullMergeBase(repo, pull);
    const lookup = this.lookup(repo);
    const baseCommit = repo.objects.get(liveBase);
    const headCommit = repo.objects.get(liveHead);
    if (!baseCommit?.type || !headCommit?.type) return { error: 'missing commit', status: 422 };
    const baseFiles = flattenTree(parseCommit(baseCommit.data).tree, lookup);
    const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
    const mergeBaseFiles = new Map<string, FileEntry>();
    if (base !== null) {
      const mergeBaseCommit = repo.objects.get(base);
      if (mergeBaseCommit?.type === 'commit') {
        for (const [path, entry] of flattenTree(parseCommit(mergeBaseCommit.data).tree, lookup)) mergeBaseFiles.set(path, entry);
      }
    }
    // Apply the merge-base -> head diff onto the base tip's tree.
    const merged = new Map(baseFiles);
    for (const path of new Set([...mergeBaseFiles.keys(), ...headFiles.keys()])) {
      const from = mergeBaseFiles.get(path)?.oid ?? null;
      const head = headFiles.get(path)?.oid ?? null;
      if (head !== from) {
        if (head === null) merged.delete(path);
        else {
          const entry = headFiles.get(path) as FileEntry;
          merged.set(path, entry);
        }
      }
    }
    const treeOid = buildTreeFromFiles(merged, (type, data) => this.putObject(repo, type, data));
    const commitData = buildCommit({
      tree: treeOid,
      parents: [liveBase],
      message: pull.title,
      author: this.identityLine(),
      committer: this.identityLine(),
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = trialNowIso();
    pull.updatedAt = trialNowIso();
    this.touchRepo(repo);
    return { sha };
  }
}
