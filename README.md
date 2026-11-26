# Open Replay

Backend API for Open Replay: live replay and slow-motion production. See the architecture
draft in the cockpit repo (`docs/open-replay-architecture.md`).

Stack: Node 22, TypeScript, Fastify 5, zod, CouchDB (via `nano`), pnpm. It follows `open-live`.

## Run

```bash
cp .env.example .env      # set COUCHDB_PASSWORD and API_KEY
docker compose up -d couchdb
pnpm install
pnpm dev                  # http://localhost:3000, OpenAPI UI at /docs
```

`docker compose up --build` runs CouchDB and the API together. Set `COUCHDB_PORT` if 5984 is taken.

## API

- `GET /health`, `GET /ready` (ready checks CouchDB)
- `GET /api/v1/streams`: the recorded streams in the TAMS store (every flow with segments, its tags and extent).
- `GET|PUT|DELETE /api/v1/groups/:groupId/playback`: whether the group's replay runs on Strom, start it (body: `name`, `srtUri`, `members`), stop it. The program goes out over SRT to `srtUri`.
- `PUT /api/v1/groups/:groupId/playback/preview` (body `{source}`) puts a source in preview, including the one on air (the preview mixer can show any source); `POST .../playback/take` cuts the preview to program. Status lists each source with its own WHEP video, one preview video that follows whatever is in preview (a second, preview-only mixer inside the replay flow, so changing the preview opens no new connection), and which source is on air and in preview.
- `/api/v1/strom/*`: Strom for the browser (REST, the replay WebSocket, WHEP video), with the Strom key added here.
- `/api/v1/replays`: `GET` list, `POST`, `GET|PATCH|DELETE /:id`. Auth with `X-API-Key` or `Authorization: Bearer`.

A replay is an in/out range on one angle, as TAI nanoseconds (decimal strings), plus a speed.
The database and a `type`/`createdAt` index are created on startup.

## Keys stay here

The OSC access token (`OSC_ACCESS_TOKEN`) and the Strom key (`STROM_AUTH_TOKEN`) are set on this service only. The Studio
is a browser app and never holds them: it calls this API, which reads the store, drives Strom and proxies the
operator screen's WebSocket and video. Without `TAMS_GATEWAY_URL` and `OSC_ACCESS_TOKEN` the store routes answer 503;
without `STROM_URL` the playback routes do.

Encoders: replay flows ask Strom for `auto` (hardware first, then software). Set `ENCODER_PREFERENCE` to `hardware` or `software` to force one.

## Test

```bash
pnpm typecheck && pnpm test
```
