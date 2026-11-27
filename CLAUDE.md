# Open Replay (backend)

The backend API for Open Replay: live replay and slow-motion for broadcast. It reads the TAMS store, drives
Strom's replay flows, keeps marks, clips and playlists, and proxies Strom for the browser. The browser UI is a
separate repo, `Eyevinn/open-replay-studio`. Public repo.

## Stack

Node 22, TypeScript (strict), Fastify 5 with zod schemas, CouchDB through `nano`, Vitest. `pnpm` is the package
manager (`packageManager` in `package.json`).

## The gate

A change is done when this passes, locally and in CI on the pull request:

```bash
pnpm typecheck && pnpm test
```

`pnpm test` runs Vitest over `src/**/*.test.ts`. Tests need no service:

- CouchDB is replaced by an in-memory stand-in for `nano` (`fakeDb()` in the test files) that honours equality
  selectors and the `_rev` rule.
- Strom is replaced by `MockStrom` in `src/__tests__/mock-strom.ts`, an HTTP server bound to `127.0.0.1`.
- A test never needs a live CouchDB, Strom or TAMS.

## Where things are

- `src/server.ts`, `src/main.ts`, `src/services.ts`, `src/config.ts`: the Fastify app, startup and environment.
- `src/routes/`: the HTTP routes (health, streams, playback, playlist play, replays, library).
- `src/lib/`: the clients and logic (Strom, TAMS, the replay flow, live edge, playlist runner).
- `src/db/`: CouchDB access, record types and the migration of older records.
- `README.md` has the API and how to run it.

## Rules

- This repo is public: no secrets, tokens, internal hostnames, SRT URIs with passphrases or customer names in
  code, commits, issues or pull requests. Keys (`OSC_ACCESS_TOKEN`, `STROM_AUTH_TOKEN`) live in the service's
  environment, never in code.
- Minimise dependencies. Add a library only when it does real work, and say why in the pull request.
- Never push to `main` without a pull request when working as the dev team; the owner may push directly.
