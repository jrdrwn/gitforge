// GitForge entry point: bind an ephemeral port, register it with the environment, answer
// /healthz, then poll the environment until the trial is done and exit 0.
//
// Boot protocol (from the competition rules): the trial's pod gives the program 20 seconds
// to be ready; the suite listens on 8080, so this program must never bind that port. It
// binds port 0, learns its own port from the socket, tells the environment with
// POST $MAKEFUN_ENV_URL/register {"port": port}, answers GET /healthz, and then long-polls
// GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.

import { createApp } from './lib/server.ts';

const REGISTER_MAX_TRIES = 12;
const REGISTER_FIRST_DELAY_MS = 100;
const DONE_POLL_MS = 250;

function envUrl(): string | null {
  const value = process.env.MAKEFUN_ENV_URL;
  if (typeof value !== 'string' || value === '') return null;
  return value.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function registerWithRetry(env: string, port: number): Promise<void> {
  let delay = REGISTER_FIRST_DELAY_MS;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_MAX_TRIES; attempt += 1) {
    try {
      const response = await postJson(`${env}/register`, { port });
      if (response.ok) return;
      lastError = new Error(`register answered ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < REGISTER_MAX_TRIES) await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
  throw lastError instanceof Error ? lastError : new Error('register failed');
}

async function waitForDone(env: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${env}/done`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const data = (await response.json()) as { done?: unknown };
        if (data.done === true) return;
      }
    } catch {
      // A transient poll failure must not end the trial early; keep polling.
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  const env = envUrl();
  if (env === null) {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }

  const app = createApp();
  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, () => resolve());
  });
  const address = app.address();
  if (address === null || typeof address === 'string') {
    console.error('could not learn the bound port');
    process.exit(1);
  }
  const port = address.port;

  await registerWithRetry(env, port);
  await waitForDone(env);
  app.close(() => process.exit(0));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
