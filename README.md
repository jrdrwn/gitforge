# gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jrdrwn/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jrdrwn/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, standard library only: git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone/fetch/push, the REST v3 API for repositories, issues, pull requests and contents, the GraphQL v4 API, and an MCP endpoint — all served from its own in-memory store, no git binary, no outside service.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with `POST $MAKEFUN_ENV_URL/register`, answers `GET /healthz`, and exits 0 when `GET $MAKEFUN_ENV_URL/done` answers `{"done": true}`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7s88r2m0&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
