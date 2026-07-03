# tools/moodboard/CLAUDE.md

Vizdev moodboard for Driftcore sprites. Cloudflare Worker (TypeScript) + vanilla HTML/CSS/JS frontend, no build step. Generates and curates reference renders via the Krea API.

`README.md` next to this file has the user-facing setup/run/deploy walkthrough — read it before touching infrastructure. This file is for **conventions and gotchas an editor needs to know that the README doesn't say**.

## Layout (only the meaningful parts — `node_modules/` is excluded)

```
tools/moodboard/
  public/
    index.html          # single page, no framework
    style.css
    app.js              # frontend logic (vanilla JS, ES modules style)
    catalog.json        # source of truth for subjects + default style preamble
    refs/               # locally-served sprite refs (style-image inputs to Krea)
      bullets/  enemies/  player/
  src/
    index.ts            # Cloudflare Worker (API + Krea proxy + R2/KV storage)
  wrangler.toml         # bindings: ASSETS, IMAGES (R2), STATE (KV), KREA_API_KEY (secret)
  package.json          # dev deps only — wrangler + types
  tsconfig.json
  .dev.vars             # local secrets (gitignored)
```

## Architecture (one paragraph)

The Worker exposes `/api/*` for state mutations and `/img/*` for streaming bytes from R2. The frontend loads `catalog.json` directly (static), pulls saved state via `/api/state`, and fires `/api/generate` once **per image** (parallel calls when "generate N" is clicked). The Worker calls Krea (`POST /generate/image/<model>`, polled at `GET /jobs/<id>`), downloads the resulting bytes (Krea-hosted URLs are not guaranteed permanent), stores them in R2, and writes metadata to KV. Favorites and prompt overrides also live in KV.

## Conventions

- **No build step.** `public/app.js` is shipped as-is. Don't add bundlers, frameworks, or transpilers — the value of this tool is that it's editable in 10 seconds.
- **Catalog is hand-curated.** `public/catalog.json` is the canonical list of subjects. The `id` field is the storage key inside R2 (`subjects/<id>/<uuid>.<ext>`) — renaming an `id` orphans existing favorites in R2. Treat `id` as immutable once shipped.
- **`catalog.json` references are soft.** `source` and `sprite` fields are documentation/links to the game; nothing automated walks them. They can be `null`.
- **Preamble uses placeholders** — `%SUBJECT%`, `%FACING%`, `%KIND%`. The frontend substitutes at request time inside `buildPrompt`. Changing the global preamble re-affects *every* subject without a per-kind override.
- **Per-kind preambles override the global one.** `catalog.kind_preambles[kind]` (e.g. `weapon`, `augment`) wins over `settings.preamble` for that kind. Use this when one subject category needs different framing — projectiles want a tiny-particle composition, augment icons want a flat front-on icon composition. The `weapon` and `augment` kinds already have overrides; `player`, `enemy`, `option`, `secondary_weapon` fall back to the global broadside-profile preamble.
- **`kinds` is small on purpose.** It's a per-subject-type noun phrase that gets dropped into `(%KIND%)` so the model knows whether the subject is a ship, a creature, a projectile, etc. Adding a new subject type means adding a new `kind`, a new tab in `index.html`, and probably also a `kind_preambles` entry if the framing differs from the broadside default.

## Storage shape

- **R2 (`IMAGES` binding)** — image bytes and 3D mesh bytes. Both routed through the same bucket; the worker's `/img/<key>` and `/mesh/<key>` routes are functionally identical proxies, just different URL roots.
  - `subjects/<subjectId>/<uuid>.<ext>` — primary renders.
  - `subjects/<subjectId>/views/<uuid>.<ext>` — derivative views (front/back/top/three-quarter) generated from a primary favorite via Flux Kontext.
  - `meshes/<id>.<ext>` — 3D mesh bytes (glb/gltf/obj/etc).
  - All R2 reads serve with `cache-control: immutable, max-age=1y`.
- **KV (`STATE` binding)**:
  - `settings` — global `Settings` object (preamble, model defaults, mesh model, etc.).
  - `overrides` — `{ [subjectId]: prompt }` per-subject prompt override.
  - `image-index` — `string[]` of all image ids.
  - `image:<id>` — `ImageMeta` for each render. Derivative views carry `parentImageId` and `view` fields ("front", "back", "top", "three_quarter"); primary renders leave both undefined.
  - `mesh-index` — `string[]` of all mesh ids.
  - `mesh:<id>` — `MeshMeta` for each generated 3D mesh; references the source image ids that fed it.
  - `asset-cache:<sourceUrl>` — cached Krea-asset upload result for `/refs/*` sprite uploads.
  - `asset-cache:r2:<r2Key>` — cached Krea-asset upload result for R2-stored images promoted to Krea (used by Flux Kontext / 3D when the source image lives in our R2).
- **Don't add new top-level KV keys without naming them with a prefix.** `settings`, `overrides`, `image-index`, `mesh-index` are unprefixed; everything else uses `noun:identifier` form.
- **`handleDelete` cascades.** Deleting a primary image also deletes any derivative views that reference it as `parentImageId`. Mesh records are NOT cascaded — they survive until explicitly deleted via `/api/mesh/:id`. (Source-image gone but mesh remains is intentional: the mesh itself is the artifact.)

## Job tracking (persistent generation)

Generation is **not synchronous**. `POST /api/generate`, `/api/views/generate`, and `/api/mesh/generate` all return a `JobMeta` immediately and do the actual Krea work via `ctx.waitUntil`. The frontend polls `/api/job/:id` every 2s for status; pending jobs are persisted in KV (`job:<id>`, indexed by `job-index`) and **survive page refresh**. On a fresh page load, `init()` reads `state.jobs` from `/api/state` and resumes polling.

### Why this shape

- Generation can take 30s–5min (3D). Holding an HTTP connection open that long burns server connection slots and loses all progress on a frontend refresh.
- `ctx.waitUntil` lets us return immediately while the worker keeps polling Krea. The worker stays alive long enough to finish the work, even after the response is sent.
- Stale jobs (no progress for >15min — see `JOB_STALE_MS`) are surfaced as `failed` automatically. This guards against the worker getting killed mid-poll without leaving the job stuck in "processing" forever.

### Don't break this

- **Always thread `ctx` to handlers that start jobs.** `handleGenerate(req, env, ctx)` not `(req, env)`. `startJob` requires `ctx.waitUntil` to keep the work alive.
- **Update progress liberally.** Each Krea poll inside `pollKreaJob` calls `update("Krea status: …")` so the frontend's progress text stays meaningful. If you add new long-running steps (e.g. style-transfer pre-process), call `update()` between them.
- **Job records are removed from `job-index` on terminal status** but the `job:<id>` KV record stays around briefly so the frontend's last poll can resolve. The frontend then DELETEs the job record. Don't refactor this to delete on terminal — you'd race with the frontend's poll.
- **Generation cost is incurred on Krea side regardless of frontend cancellation.** The "×" cancel button on a pending thumb only stops local polling and deletes the job record. It does not cancel the in-flight Krea job. Surfacing this in the cancel button title is intentional.

## Krea integration gotchas

- **One image per `/api/generate` call.** The frontend parallelizes by firing N requests, not by asking Krea for N. Krea's response shape is `{ urls: [...] }` but in practice we only consume `urls[0]`.
- **Style images need to live on Krea.** Random URLs (including `/refs/*` from this Worker) get rejected with "Invalid asset URL". `ensureKreaAsset` uploads the bytes to `POST /assets`, caches the returned `image_url` in KV by source URL, and reuses it. If you change the bytes of a `/refs/*` file, **the cache will keep handing back the old Krea-hosted upload** — bust the cache by changing the URL (rename the file or add a query string) or manually delete the `asset-cache:*` KV entry.
- **Model param shape varies.** `flux-1-dev` accepts `steps`; `flux-1.1-pro` does not and caps at 1440x1440. `STYLE_IMAGE_MODELS` is the allow-list for `styleImages` — outside that set, Krea silently drops the param. Update both places when adding a new model.
- **Output resolution floors at the style-image dims.** Some Krea models lock output to the reference's size if the requested output is smaller. `handleGenerate` raises `width`/`height` to at least the ref's dims before calling Krea. Don't "simplify" this away.
- **Polling caps at 90s wall-clock.** Workers Paid gets unlimited wall-clock but 30s CPU; the polling loop is mostly `await sleep(2000)` so CPU is fine. If Krea is consistently slower, raise the deadline in `kreaGenerate` rather than tightening the poll interval.

## Local dev gotchas

- **`wrangler dev` uses real R2 + real KV + real Krea credits by default.** Local generations cost real money and pollute the production gallery. The README mentions this; keep it in mind.
- **The `ASSETS` binding works in dev.** `/refs/*` is served by the same Worker that handles `/api/*`, so style-image uploads from local sprites round-trip correctly without poking at `127.0.0.1`.
- **No auth on the Worker.** Anyone with the URL can generate and burn Krea credits. If you ever expose this beyond the dev's machine, gate `/api/generate` behind a shared secret check at the top of `fetch`.

## Pipeline tab — favorites → multi-view → 3D

The Pipeline tab (`renderPipeline` in `app.js`) is the curation surface that turns favorites into 3D assets. Each favorite primary image gets a row with four view slots (front, three_quarter, back, top) and a "Generate 3D" button. Empty slots show a `+` stub; click it to fire Flux Kontext at the source image with a view-specific prompt that says "same exact subject, but rotated to <view>." The generated derivative is stored as a regular `ImageMeta` with `parentImageId` and `view` set, then slotted in.

3D generation collects the favorite + every derivative view as `imageUrls` and POSTs to Krea. The mesh comes back as a binary blob (glb expected); we save it to R2 and surface it via `<model-viewer>` from `cdn.jsdelivr.net/npm/@google/model-viewer` — a CDN-loaded web component that does orbit / pan / zoom / auto-rotate without any Three.js plumbing on our side.

### 3D pipeline runs on fal.ai, NOT Krea

Krea's public REST API at `https://api.krea.ai/openapi.json` does not document image-to-3D (verified 2026-05; the web UI exposes it but the API doesn't). The 3D pipeline therefore runs on **fal.ai**, not Krea. The image generation pipeline still runs on Krea — only the mesh step crosses providers.

`falGenerate3d` in `src/index.ts` handles the queue API:
- Submit: `POST https://queue.fal.run/<model-slug>` with body shaped per `FAL_3D_MODELS[slug].buildBody`
- Auth header is `Authorization: Key <FAL_API_KEY>` — **NOT Bearer**. Wrong scheme is the most likely auth failure mode.
- Status polling: `GET status_url` every 3s (the submit response gives us status_url + response_url directly).
- States: `IN_QUEUE` → `IN_PROGRESS` → `COMPLETED` (or `FAILED` / `ERROR` / `CANCELLED`).
- Result fetch: separate GET to `response_url` once `COMPLETED`.

Per-model field-name divergence is normalized by adapters in `FAL_3D_MODELS`. Each adapter has `buildBody(uris)`, `extractMeshUrl(result)`, and `multiImage`. **When adding a new fal 3D model:**
1. Add an entry to `FAL_3D_MODELS` in `src/index.ts`.
2. Confirm field names by visiting `https://fal.ai/models/<slug>/api`.
3. Add the slug to the `<select id="mesh-model">` in `index.html`.

**Image input is base64 data URIs.** fal accepts URLs or data URIs; we use data URIs to (a) avoid a separate fal.storage upload round-trip, and (b) make `wrangler dev` work without exposing localhost to fal. `r2ToDataUri` reads the R2 object and emits `data:image/png;base64,...`. The chunked `arrayBufferToBase64` helper avoids call-stack overflow on large buffers.

**Multi-image-capable models** (Rodin) receive every favorite + derivative view; single-image models receive only the primary favorite. The branching is in `handleMeshGenerate.runner`. Don't blindly send N images to a single-image model — fal will reject or silently drop them.

### Krea image-edit (Flux Kontext)

Multi-view uses `bfl/flux-1-kontext-dev` which **does** exist in Krea's API. It accepts `imageUrl` (single source) + `prompt`. The view prompts in `VIEW_PROMPTS` are tuned to keep the subject identity stable while rotating it; they include the original prompt so the model has a textual anchor for what the subject is. If multi-view results drift in identity, the lever is the per-view prompt — make it more emphatic about "same exact subject."

Flux Kontext is **not** in `STYLE_IMAGE_MODELS`. It uses `imageUrl` (singular), not `styleImages`. The dispatch in `kreaGenerate` keys on the model slug to decide which params to send.

## When extending the catalog

- **Add to `public/catalog.json`** and redeploy (`npm run deploy`) — the frontend reads it as a static file, the Worker doesn't need to know.
- **Provide a sprite ref** under `public/refs/<category>/` if you want style-image conditioning. PNG with transparent background works best; the magenta-backdrop preamble assumes the sprite is the only content.
- **Mismatched `kind` vs subject leaks visual noise.** E.g. a "weapon" subject described as "ammunition projectile" but with `%KIND%` of "an in-flight ammunition projectile by itself, NOT a gun and NOT a vehicle" exists specifically because earlier renders kept generating guns and ships. If you see the model painting hardware around a projectile, the fix is in `kinds.weapon`, not the per-subject `description`.

## When adding a new subject type (e.g. items, augments, level tiles)

1. Add an entry to `kinds` describing what the model should render.
2. Add subjects with that `type` to `subjects[]`.
3. If the new type needs different framing/composition (e.g. items shown three-quarter, not broadside), the global preamble probably can't accommodate it — consider per-type preambles, or a per-subject `preamble_override` field, before forcing the global one to do everything.
4. Add a tab in `public/index.html` / `public/app.js` so it can be filtered.

## When adding a new pipeline step

- New endpoints go in `src/index.ts` with the same `/api/<verb>` shape and the same KV-prefix discipline above.
- The current pipeline (multi-view + 3D) blocks the worker for the duration of polling — up to 90s for image edits, 300s for 3D. Workers Paid gives unlimited wall-clock, but if you add longer steps, switch to a job-record pattern (`job:<id>` in KV, frontend polls) instead of holding the connection open.
- Large artifacts (images, meshes) go in R2; metadata in KV. Never put binary bytes in KV — its 25MB/key limit will bite you and reads count toward request quota.
- **Anything irreversible or expensive must be explicitly user-triggered.** 3D mesh generation is gated behind a confirm dialog because it's the most expensive operation in the tool. Don't auto-fire on favorite. The cost story matters.
