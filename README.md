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
- `GET|PUT|DELETE /api/v1/groups/:groupId/playback`: whether the group's replay runs on Strom, start it (body: `name`, `srtUri`, `members`), stop it. The program goes out over SRT to `srtUri` and as WHEP video for the browser (`programPath` in the status). A flow started before the program WHEP existed is reported `outdated`.
- `PUT /api/v1/groups/:groupId/playback/preview` (body `{source}`) puts a source in preview, including the one on air (the preview mixer can show any source); `POST .../playback/take` cuts the preview to program. Status lists the program's WHEP path, each source with its own WHEP video, one preview video that follows whatever is in preview (a second, preview-only mixer inside the replay flow, so changing the preview opens no new connection), and which source is on air and in preview.
- `/api/v1/strom/*`: Strom for the browser (REST, the replay WebSocket, WHEP video), with the Strom key added here.
- `/api/v1/replays`: `GET` list, `POST`, `GET|PATCH|DELETE /:id`. Auth with `X-API-Key` or `Authorization: Bearer`. The earlier single-angle form; `clips` below replaces it.
- The library, each with `GET` list (filter by `groupId`; clips also by `streamId`), `POST`, `GET|PATCH|DELETE /:id`:
  - `/api/v1/marks`: a moment on a group's axis (`t`, nanoseconds as a decimal string).
  - `/api/v1/clips`: a range on the group's axis (`inT`, `outT`) with a default camera (`streamId`), a `number` the server gives (per group, never reused) and a list of `tags`. A clip has no speed: a single clip is played at the `speed` the caller sends (default 1), and a playlist entry keeps its own. Strom applies each camera's sync offset itself, so a clip carries none.
  - `GET|POST /api/v1/groups/:groupId/tags`, `PATCH|DELETE .../tags/:name`: a group's tag list with the number of clips for each (a tag can have none). Rename and delete act on every clip of the group; renaming to a name that exists is `409`.
  - Records saved in the first shape (clip `speed`, `starred`, `tag`; mark `name`, `tag`) are migrated at start.
  - `/api/v1/playlists`: belongs to a group (`groupId`, required, fixed), has `autoPlay` (default false) and an ordered `items` list of entries `{ clipId, streamId?, speed, audioTracks }`: `streamId` is the camera to play from (the clip's own when left out), `speed` is the entry's own (`0 < speed <= 1`, default 1), `audioTracks` is four on/off switches (default `[true, true, false, false]`; stored only, the replay flow has no audio yet). Every clip must exist. `POST /api/v1/playlists/:id/copy` with `{ name }` saves a copy in the same group. Deleting a clip removes it from the playlists that held it.
  - A playlist also has an `endAction`: `freeze` (default, hold the last frame), `loop` or `live`.
  - A `PATCH` may carry the `rev` it was read at; if the document has changed since, the answer is `409` instead of a silent overwrite.

- `PUT|GET|DELETE /api/v1/groups/:groupId/playback/playlist` (`?player=a|b`, body `{playlistId, secondsAfter?}`; `secondsAfter`, 0 to 10 s, default 0, is added to the last entry's out): play a playlist on a clip player of the group's replay flow, read its progress, stop it. The runner keeps two items queued ahead on Strom and follows its `item_started` and `ended` events, reading the state to catch one that is lost. Replay flows have two clip players (A and B, mixer inputs after the cameras; a replay has at most 14 cameras). The player is put in preview, so Take sends it to air. A replay started before clip players existed answers `409`: start it again. Strom reports `source_switch` and `cue_next` in the replay API's `features` when it can; without them these routes answer `409` and say which is missing. It is built and tested against a mock of Strom's planned clip queue (`src/__tests__/mock-strom.ts`), written from the Strom author's description and not from Strom's code (ADR-0002 in the dev team repo). Runners live in memory.
- `PUT|DELETE /api/v1/groups/:groupId/playback/clip` (`?player=a|b`, default b; body `{clipId, streamId?, speed?, secondsAfter?, play?, preview?}`) cues one clip: `speed` is the fader's (default 1) and `secondsAfter` (0 to 10 s, default 0) is added to the clip's out.

A replay is an in/out range on one angle, as TAI nanoseconds (decimal strings), plus a speed.
The database and a `type`/`createdAt` index are created on startup.

## Keys stay here

The OSC access token (`OSC_ACCESS_TOKEN`) and the Strom key (`STROM_AUTH_TOKEN`) are set on this service only. The Studio
is a browser app and never holds them: it calls this API, which reads the store, drives Strom and proxies the
operator screen's WebSocket and video. Without `TAMS_GATEWAY_URL` and `OSC_ACCESS_TOKEN` the store routes answer 503;
without `STROM_URL` the playback routes do.

Going live: a new replay group starts paused at the first recorded segment (Strom 0.8.4 and later), so after starting a replay the backend waits for the group's live edge and sends Strom's `live` command itself, `REPLAY_LIVE_MARGIN_MS` behind the edge (default 1500). A group that is already playing is left alone. No browser has to be attached. The playback status reports the margin (`liveMarginMs`), and the studio uses that value for its own `live` commands, so it is set in one place.

Encoders: replay flows ask Strom for `auto` (hardware first, then software). Set `ENCODER_PREFERENCE` to `hardware` or `software` to force one.

## Test

```bash
pnpm typecheck && pnpm test
```
