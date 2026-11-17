// REST v3 (/api/v3): repositories, issues, pull requests, contents and the git-data ref
// endpoints the suite drives. Every reply is application/json with a non-empty
// X-GitHub-Request-Id; errors carry a JSON body with a string message.

import { Buffer } from 'node:buffer';
import { isObjectId, ZERO_OID } from './gitobj.ts';
import { VIEWER, trialNowIso } from './scenario.ts';
import { refTarget } from './git-http.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** The request's base URL (scheme + host), for absolute Link headers. */
  baseUrl: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const NO_CONTENT: RestResponse = { status: 204, body: null };

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

export function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${Buffer.from(`${repo.owner}/${repo.name}`, 'utf8').toString('base64')}`,
    name: repo.name,
    full_name: fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User', avatar_url: '', html_url: `${baseUrl}/${repo.owner}` },
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
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
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
    master_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    html_url: `${baseUrl}/${fullName}`,
    url: `${baseUrl}/api/v3/repos/${fullName}`,
    clone_url: `${baseUrl}/${fullName}.git`,
    git_url: `${baseUrl}/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    topics: [],
  };
}

function labelJson(label: { id: number; name: string; color: string }): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: '', default: false };
}

export function issueJson(issue: Issue, repo: Repo, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${Buffer.from(`${fullName}#${issue.number}`, 'utf8').toString('base64')}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `${baseUrl}/${fullName}/issues/${issue.number}`,
    url: `${baseUrl}/api/v3/repos/${fullName}/issues/${issue.number}`,
    repository_url: `${baseUrl}/api/v3/repos/${fullName}`,
  };
}

export function pullJson(pull: PullRequest, repo: Repo, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: pull.id,
    node_id: `P_${Buffer.from(`${fullName}#${pull.number}`, 'utf8').toString('base64')}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner } },
    merged: pull.merged,
    mergeable: pull.state === 'open',
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    draft: false,
    comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    html_url: `${baseUrl}/${fullName}/pull/${pull.number}`,
    url: `${baseUrl}/api/v3/repos/${fullName}/pulls/${pull.number}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}

function pageLink(baseUrl: string, path: string, query: URLSearchParams, pageNum: number, perPage: number): string {
  const next = new URLSearchParams(query);
  next.set('page', String(pageNum));
  next.set('per_page', String(perPage));
  return `<${baseUrl}${path}?${next.toString()}>; rel="next"`;
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Route one REST request. `viewer` is the login the bearer token names. */
export function handleRest(store: Store, viewer: string, req: RestRequest): RestResponse {
  const { method, path, query } = req;
  const segments = path.split('/').filter((part) => part !== '');

  // GET /api/v3/ — the API root (public, like api.github.com).
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    return ok(200, { current_user_url: `${req.baseUrl}/api/v3/user`, rate_limit_url: `${req.baseUrl}/api/v3/rate_limit` }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  // GET /api/v3/meta — public.
  if (path === '/api/v3/meta' && method === 'GET') {
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: false, git: ['github.com'] });
  }
  // GET /api/v3/user — the token owner (used by the MCP suite to learn the login).
  if (path === '/api/v3/user' && method === 'GET') {
    return ok(200, { login: viewer, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }

  // POST /api/v3/user/repos — create a repository for the token owner.
  if (path === '/api/v3/user/repos' && method === 'POST') {
    if (!isRecord(req.body)) return err(400, 'request body must be a JSON object');
    const name = stringField(req.body, 'name');
    if (name === '' || !REPO_NAME.test(name)) return err(422, 'name is invalid');
    if (store.getRepo(viewer, name)) return err(422, `Repository ${viewer}/${name} already exists`);
    const repo = store.createRepo(viewer, name, {
      private: req.body.private === true,
      description: stringField(req.body, 'description'),
    });
    return ok(201, repoJson(repo, req.baseUrl));
  }
  // GET /api/v3/user/repos — the owner's repositories, paginated with Link rel="next".
  if (path === '/api/v3/user/repos' && method === 'GET') {
    const repos = store.reposOf(viewer);
    const { page, total, pageNum, perPage } = paginate(repos, query);
    const headers: Record<string, string> = {};
    if (pageNum * perPage < total) headers.link = pageLink(req.baseUrl, '/api/v3/user/repos', query, pageNum + 1, perPage);
    return ok(200, page.map((repo) => repoJson(repo, req.baseUrl)), headers);
  }

  // /api/v3/repos/{owner}/{repo}[...] — everything else is repository-scoped.
  if (segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos' && segments.length >= 5) {
    const owner = decodeURIComponent(segments[3] as string);
    const name = decodeURIComponent(segments[4] as string);
    return handleRepoRoute(store, viewer, owner, name, segments.slice(5), req);
  }

  return err(404, 'Not Found');
}

function handleRepoRoute(
  store: Store,
  viewer: string,
  owner: string,
  name: string,
  rest: string[],
  req: RestRequest,
): RestResponse {
  const { method, query } = req;
  // A repository belongs to the login the token names: the same name under another owner is
  // a 404, never a 403.
  if (owner !== viewer) return err(404, 'Not Found');
  const repo = store.getRepo(owner, name);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      if (!repo) return err(404, 'Not Found');
      return ok(200, repoJson(repo, req.baseUrl));
    }
    if (method === 'PATCH') {
      if (!repo) return err(404, 'Not Found');
      if (!isRecord(req.body)) return err(400, 'request body must be a JSON object');
      if (typeof req.body.description === 'string') repo.description = req.body.description;
      if (typeof req.body.private === 'boolean') repo.private = req.body.private;
      repo.updatedAt = trialNowIso();
      return ok(200, repoJson(repo, req.baseUrl));
    }
    if (method === 'DELETE') {
      if (!repo) return err(404, 'Not Found');
      store.deleteRepo(owner, name);
      return NO_CONTENT;
    }
    return err(404, 'Not Found');
  }
  if (!repo) return err(404, 'Not Found');

  const [head, ...tail] = rest as [string, ...string[]];

  // ---- branches -----------------------------------------------------------
  if (head === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID }, protected: false }));
      return ok(200, branches);
    }
    if (tail.length === 1 && method === 'GET') {
      const branch = decodeURIComponent(tail[0] as string);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha: tip }, protected: false });
    }
    return err(404, 'Not Found');
  }

  // ---- commits ------------------------------------------------------------
  if (head === 'commits' && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (tip === null) return err(404, 'Not Found');
    const commits = store.commitsFrom(repo, tip).map((commit) => ({
      sha: commit.sha,
      commit: {
        message: commit.message.replace(/\n+$/, ''),
        author: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
        committer: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
      },
      author: { login: repo.owner },
      committer: { login: repo.owner },
    }));
    return ok(200, commits);
  }

  // ---- git data: refs ------------------------------------------------------
  if (head === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      if (!isRecord(req.body)) return err(400, 'request body must be a JSON object');
      const ref = stringField(req.body, 'ref');
      const sha = stringField(req.body, 'sha');
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return err(422, 'ref must start with refs/heads/ or refs/tags/');
      if (!isObjectId(sha) || !repo.objects.has(sha)) return err(422, 'sha does not name an object in this repository');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      store.touchRepo(repo);
      return ok(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
    }
    if (method === 'GET' && tail.length >= 2) {
      const ref = decodeURIComponent(tail.slice(1).join('/'));
      const target = refTarget(repo, ref);
      if (target === null) return err(404, 'Not Found');
      return ok(200, { ref, object: { sha: target, type: repo.objects.get(target)?.type ?? 'commit', url: '' } });
    }
    if (method === 'GET' && tail.length === 1) {
      const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
      return ok(200, refs);
    }
    return err(404, 'Not Found');
  }

  // ---- contents -----------------------------------------------------------
  if (head === 'contents') {
    const contentPath = tail.map((part) => decodeURIComponent(part)).join('/');
    if (method === 'PUT') {
      if (!isRecord(req.body)) return err(400, 'request body must be a JSON object');
      const message = stringField(req.body, 'message');
      const contentB64 = stringField(req.body, 'content');
      const branch = typeof req.body.branch === 'string' && req.body.branch !== '' ? req.body.branch : repo.defaultBranch;
      const sha = typeof req.body.sha === 'string' ? req.body.sha : null;
      if (message === '' || contentB64 === '') return err(422, 'message and content are required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      const existing = store.fileAt(repo, branch, contentPath);
      const isUpdate = existing !== null;
      if (isUpdate && sha !== null && sha.toLowerCase() !== existing.sha.toLowerCase()) {
        return err(409, 'sha does not match the current blob');
      }
      if (isUpdate && sha === null) return err(422, 'sha is required to update a file');
      const { commitSha, blobSha } = store.commitFile(repo, branch, contentPath, content, message);
      return ok(isUpdate ? 200 : 201, {
        content: { name: contentPath.split('/').pop() ?? '', path: contentPath, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
        commit: { sha: commitSha, message },
      });
    }
    if (method === 'GET') {
      const ref = query.get('ref') ?? repo.defaultBranch;
      if (contentPath === '') {
        const entries = store.dirAt(repo, ref, '');
        if (entries === null) return err(404, 'Not Found');
        return ok(200, entries);
      }
      const file = store.fileAt(repo, ref, contentPath);
      if (file) {
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          size: file.size,
          name: contentPath.split('/').pop() ?? '',
          path: contentPath,
          content: file.blob.data.toString('base64'),
          sha: file.sha,
        });
      }
      const entries = store.dirAt(repo, ref, contentPath);
      if (entries === null) return err(404, 'Not Found');
      return ok(200, entries);
    }
    if (method === 'DELETE') {
      if (!isRecord(req.body)) return err(400, 'request body must be a JSON object');
      const message = stringField(req.body, 'message');
      const sha = typeof req.body.sha === 'string' ? req.body.sha : null;
      const existing = store.fileAt(repo, repo.defaultBranch, contentPath);
      if (!existing) return err(404, 'Not Found');
      if (sha !== null && sha.toLowerCase() !== existing.sha.toLowerCase()) return err(409, 'sha does not match the current blob');
      const { commitSha } = store.commitFile(repo, repo.defaultBranch, contentPath, Buffer.alloc(0), message === '' ? 'Delete file' : message, { delete: true });
      return ok(200, { commit: { sha: commitSha, message } });
    }
    return err(404, 'Not Found');
  }

  // ---- labels --------------------------------------------------------------
  if (head === 'labels') {
    if (method === 'POST' && tail.length === 0) {
      if (!isRecord(req.body)) return err(400, 'request body must be a JSON object');
      const name = stringField(req.body, 'name');
      if (name === '') return err(422, 'name is required');
      if (repo.labels.has(name)) return err(422, `Label "${name}" already exists`);
      const label = { id: 0, name, color: typeof req.body.color === 'string' ? req.body.color : 'ededed' };
      // Label ids are per-repository counters derived from the repo id space.
      label.id = repo.id * 1000 + repo.labels.size + 1;
      repo.labels.set(name, label);
      return ok(201, labelJson(label));
    }
    if (method === 'GET' && tail.length === 0) {
      return ok(200, [...repo.labels.values()].map(labelJson));
    }
    return err(404, 'Not Found');
  }

  // ---- issues --------------------------------------------------------------
  if (head === 'issues') {
    if (tail.length === 0) {
      if (method === 'POST') {
        if (!isRecord(req.body)) return err(400, 'request body must be a JSON object');
        const title = stringField(req.body, 'title');
        if (title === '') return err(422, 'title is required');
        const labelNames = Array.isArray(req.body.labels) ? req.body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        const created = store.createIssue(repo, title, typeof req.body.body === 'string' ? req.body.body : '', labelNames);
        if ('error' in created) return err(422, created.error);
        return ok(201, issueJson(created, repo, req.baseUrl));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const { page, total, pageNum, perPage } = paginate(issues, query);
        const headers: Record<string, string> = {};
        if (pageNum * perPage < total) {
          headers.link = pageLink(req.baseUrl, `/api/v3/repos/${owner}/${name}/issues`, query, pageNum + 1, perPage);
        }
        return ok(200, page.map((issue) => issueJson(issue, repo, req.baseUrl)), headers);
      }
      return err(404, 'Not Found');
    }
    const number = Number(tail[0]);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const issue = store.getIssue(repo, number);
    if (tail.length === 1) {
      if (method === 'GET') {
        if (!issue) return err(404, 'Not Found');
        return ok(200, issueJson(issue, repo, req.baseUrl));
      }
      if (method === 'PATCH') {
        if (!issue) return err(404, 'Not Found');
        if (!isRecord(req.body)) return err(400, 'request body must be a JSON object');
        if (typeof req.body.title === 'string') issue.title = req.body.title;
        if (typeof req.body.body === 'string') issue.body = req.body.body;
        if (req.body.state === 'open' || req.body.state === 'closed') {
          issue.state = req.body.state;
          issue.closedAt = req.body.state === 'closed' ? trialNowIso() : null;
        }
        issue.updatedAt = trialNowIso();
        return ok(200, issueJson(issue, repo, req.baseUrl));
      }
      return err(404, 'Not Found');
    }
    if (tail[0] !== undefined && tail[1] === 'comments') {
      if (method === 'POST') {
        if (!issue) return err(404, 'Not Found');
        if (!isRecord(req.body)) return err(400, 'request body must be a JSON object');
        const body = stringField(req.body, 'body');
        if (body === '') return err(422, 'body is required');
        const comment = { id: repo.nextCommentId++, body, user: repo.owner };
        issue.comments.push(comment);
        issue.updatedAt = trialNowIso();
        return ok(201, { id: comment.id, body: comment.body, user: { login: comment.user }, created_at: trialNowIso(), updated_at: trialNowIso() });
      }
      if (method === 'GET') {
        if (!issue) return err(404, 'Not Found');
        return ok(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: comment.user }, created_at: trialNowIso(), updated_at: trialNowIso() })));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // ---- pull requests --------------------------------------------------------
  if (head === 'pulls') {
    if (tail.length === 0) {
      if (method === 'POST') {
        if (!isRecord(req.body)) return err(400, 'request body must be a JSON object');
        const title = stringField(req.body, 'title');
        const headRef = stringField(req.body, 'head');
        const baseRef = stringField(req.body, 'base');
        if (title === '' || headRef === '' || baseRef === '') return err(422, 'title, head and base are required');
        const created = store.createPull(repo, headRef, baseRef, title, typeof req.body.body === 'string' ? req.body.body : '');
        if ('error' in created) return err(422, created.error);
        return ok(201, pullJson(created, repo, req.baseUrl));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page } = paginate(pulls, query);
        return ok(200, page.map((pull) => pullJson(pull, repo, req.baseUrl)));
      }
      return err(404, 'Not Found');
    }
    const number = Number(tail[0]);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const pull = store.getPull(repo, number);
    if (tail.length === 1) {
      if (method === 'GET') {
        if (!pull) return err(404, 'Not Found');
        return ok(200, pullJson(pull, repo, req.baseUrl));
      }
      return err(404, 'Not Found');
    }
    if (tail[1] === 'files' && method === 'GET') {
      if (!pull) return err(404, 'Not Found');
      return ok(200, store.pullFiles(repo, pull));
    }
    if (tail[1] === 'merge' && method === 'PUT') {
      if (!pull) return err(404, 'Not Found');
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return err(merged.status, merged.error);
      return ok(200, { sha: merged.sha, merged: true, message: `Pull Request #${pull.number} successfully merged` });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
