// The HTTP server: one Node http server routing the four surfaces — git smart HTTP,
// REST v3, GraphQL and MCP — plus the /healthz boot probe. Every request gets a
// X-GitHub-Request-Id; every REST reply is application/json, never HTML; a request without a
// bearer token is 401 on every protected route. A malformed body never crashes the process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body the server reads (packs in the suite are well under a megabyte). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token of a request, or null when it carries none. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? (match[1] as string) : null;
}

export interface AppOptions {
  store?: Store;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on port 0. */
export function createApp(options: AppOptions = {}): Server {
  const store = options.store ?? new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req-${++requestCounter}`;
    const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
    const method = req.method ?? 'GET';
    const path = pathOf(req);
    const host = req.headers.host ?? '127.0.0.1';
    const baseUrl = `http://${host}`;

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true }, baseHeaders);
      return;
    }

    void (async () => {
      try {
        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const rawBody = needsBody ? await readBody(req) : Buffer.alloc(0);

        // ---- MCP ---------------------------------------------------------
        if (path === '/mcp' && method === 'POST') {
          if (bearerToken(req) === null) {
            sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
            return;
          }
          const answer = handleMcp(store, VIEWER_LOGIN, baseUrl, rawBody.toString('utf8'));
          if (answer.body === null) {
            res.writeHead(answer.status, { ...baseHeaders });
            res.end();
            return;
          }
          sendBuffer(res, answer.status, JSON_TYPE, Buffer.from(answer.body, 'utf8'), baseHeaders);
          return;
        }

        // ---- GraphQL ------------------------------------------------------
        if (path === '/api/graphql' && method === 'POST') {
          if (bearerToken(req) === null) {
            sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
            return;
          }
          let body: unknown;
          try {
            body = JSON.parse(rawBody.toString('utf8')) as unknown;
          } catch {
            sendJson(res, 400, { message: 'request body is not valid JSON' }, baseHeaders);
            return;
          }
          const result = handleGraphQL(store, VIEWER_LOGIN, body);
          sendJson(res, 200, result, baseHeaders);
          return;
        }

        // ---- REST v3 ------------------------------------------------------
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          const isPublic = (path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta') && method === 'GET';
          if (!isPublic && bearerToken(req) === null) {
            sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
            return;
          }
          let parsedBody: unknown = undefined;
          if (needsBody && rawBody.length > 0) {
            try {
              parsedBody = JSON.parse(rawBody.toString('utf8')) as unknown;
            } catch {
              sendJson(res, 400, { message: 'request body is not valid JSON' }, baseHeaders);
              return;
            }
          }
          const restReq: RestRequest = { method, path, query: queryOf(req), body: parsedBody, baseUrl };
          const answer = handleRest(store, VIEWER_LOGIN, restReq);
          if (answer.status === 204) {
            res.writeHead(204, { 'content-type': JSON_TYPE, ...baseHeaders, ...(answer.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, answer.status, answer.body, { ...baseHeaders, ...(answer.headers ?? {}) });
          return;
        }

        // ---- git smart HTTP ------------------------------------------------
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          if (bearerToken(req) === null) {
            sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
            return;
          }
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const service = gitMatch[3] as string;
          if (owner !== VIEWER_LOGIN) {
            sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
            return;
          }
          const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          if (service === 'info/refs' && method === 'GET') {
            const query = queryOf(req);
            const serviceName = query.get('service') ?? '';
            const answer = handleInfoRefs(store, owner, repoName, serviceName, wantsV2);
            if (answer.status === 404) {
              sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
              return;
            }
            sendBuffer(res, 200, answer.contentType, answer.body, baseHeaders);
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            const answer = handleUploadPack(store, owner, repoName, rawBody, wantsV2);
            if (answer.status === 404) {
              sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
              return;
            }
            sendBuffer(res, 200, answer.contentType, answer.body, baseHeaders);
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            const answer = handleReceivePack(store, owner, repoName, rawBody);
            if (answer.status === 404) {
              sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
              return;
            }
            sendBuffer(res, 200, answer.contentType, answer.body, baseHeaders);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
          return;
        }

        // ---- everything else ----------------------------------------------
        sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, baseHeaders);
        } else {
          res.destroy();
        }
      }
    })();
  });
}
