# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yuyun56/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yuyun56/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process — git smart HTTP with protocol v2, REST v3, GraphQL v4 and MCP over a single in-memory store, no git binary, no dependencies.

## Run it

```sh
node main.ts
```

## What it is

One Node 22 process, standard library only, serving four surfaces over a single in-memory
store, so an object created through one surface reads identically through the others:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (capability advertisement,
  `ls-refs`, `fetch` with shallow/deepen) and v0 fetch, plus v0 receive-pack with
  fast-forward enforcement and per-ref `ok`/`ng` report-status. Packfiles, pkt-lines, deltas
  and the object model are implemented from scratch on `node:zlib` and `node:crypto`; no git
  binary is ever invoked.
- **REST v3** at `/api/v3` — repositories, contents commits, git refs, branches, commits,
  labels, issues, comments and pull requests (including squash merges with a path-level
  three-way tree merge), with GitHub's status codes, shapes and `Link` pagination.
- **GraphQL v4** at `/api/graphql` — a small purpose-built GraphQL engine (parser + executor)
  covering `viewer`, `repository`, connections with cursor pagination, `node(id:)`, the
  issue/pull-request mutations and the `__type` introspection probes gh relies on.
- **MCP** at `/mcp` — JSON-RPC Streamable HTTP with the `server/discover` handshake
  (revision 2026-07-28) and the legacy `initialize` handshake, exposing `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and `merge_pull_request`.

State is deterministic: a logical clock seeded from the trial's opening time stamps every
object, so a replayed trial answers byte-for-byte identically. Started beside the make.fun
env, the process registers its ephemeral port with `$MAKEFUN_ENV_URL/register`, serves until
the env reports done, and exits 0; run standalone it serves on `$PORT` (default 8080).

---

<sub>Entered on [make.fun](https://make.fun/?ref=sz67g615&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
