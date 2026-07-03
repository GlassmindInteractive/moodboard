# CLAUDE.md

Standalone Cloudflare Worker (TypeScript) + vanilla HTML/CSS/JS frontend, no build step. Generates and curates AI reference art via the Krea API, with a multi-view + 3D-mesh pipeline on fal.ai. This repo (`GlassmindInteractive/moodboard`) started as an internal vizdev tool for a Godot shmup called Driftcore and was split out to stand on its own — it has no runtime dependency on that game or any other parent repo. `public/catalog.json` and `public/refs/*` are seed/demo data carried over from that origin (see the dynamic-subjects note below); nothing here reads or writes into a game project.

`README.md` next to this file has the user-facing setup/run/deploy walkthrough — read it before touching infrastructure. This file is for **conventions and gotchas an editor needs to know that the README doesn't say**.

## Layout (only the meaningful parts — `node_modules/` is excluded)

```
public/
  index.html          # single page, no framework
  style.css
  app.js              # frontend logic (vanilla JS, ES modules style)
  mesh-viewer.js      # <mesh-preview> custom element: Three.js GLB viewer (textured/wireframe/both)
  catalog.json        # SEED DATA ONLY — imported into KV once by ensureSeeded on first boot; subjects live in KV thereafter
  refs/               # legacy static sprite refs (style-image inputs to Krea), demo data from the tool's origin
    bullets/  enemies/  player/
src/
  index.ts            # Cloudflare Worker (API + Krea/fal proxy + R2/KV storage)
wrangler.toml         # bindings: ASSETS, IMAGES (R2), STATE (KV); secrets: KREA_API_KEY, FAL_API_KEY
package.json          # dev deps only — wrangler + types
tsconfig.json
.dev.vars             # local secrets (gitignored)
```

## Architecture (one paragraph)

The Worker exposes `/api/*` for state mutations and `/img/*` for streaming bytes from R2. Subjects are **dynamic and KV-backed**: the frontend loads them from `GET /api/subjects` (which triggers a one-time seed migration from `catalog.json` on first boot), pulls saved state via `/api/state`, and fires `/api/generate` once **per image** (parallel calls when "generate N" is clicked). Subjects are created/edited/deleted from the UI via `POST/PUT/DELETE /api/subjects[/:id]`, with reference images uploaded to `POST /api/subjects/:id/ref`. The Worker calls Krea (`POST /generate/image/<model>`, polled at `GET /jobs/<id>`), downloads the resulting bytes (Krea-hosted URLs are not guaranteed permanent), stores them in R2, and writes metadata to KV. Subjects, settings (including the preamble/kinds/kind_preambles), favorites, and prompt overrides all live in KV.

## Conventions

- **No build step.** `public/app.js` is shipped as-is. Don't add bundlers, frameworks, or transpilers — the value of this tool is that it's editable in 10 seconds.
- **Subjects live in KV, not the catalog.** `subject:<id>` + `subject-index` are the source of truth; `catalog.json` is one-time seed data only (see `ensureSeeded`). Subjects are created/edited/deleted from the UI. A subject's `id` is a **slug derived from its name** (uniquified) and is the storage key inside R2 (`subjects/<id>/<uuid>.<ext>`) — it's immutable once created (`PUT` edits name/kind/description/facing but never `id`), because renaming it would orphan existing renders + favorites in R2.
- **Subject shape:** `{ id, name, kind, description, facing, refImages?: string[], createdAt }`. No `source` field (the old Godot scene path was dropped on import). `refImages` entries are **uniform**: each is either a legacy `/refs/…` static URL (from `public/refs/`, seeded from the old `sprite` field) or an R2 key (`refs/<id>/<uuid>.<ext>`, uploaded via the UI). `resolveStyleRef` (worker) and `refUrl` (frontend) normalize both flavors so callers don't branch.
- **Preamble uses placeholders** — `%SUBJECT%`, `%FACING%`, `%KIND%`. The frontend substitutes at request time inside `buildPrompt`. Changing the global preamble re-affects *every* subject without a per-kind override.
- **Preambles + kinds live in `settings` (KV), not the catalog.** `settings.preamble` (global), `settings.kind_preambles[kind]` (per-kind override, wins over global), and `settings.kinds[kind]` (the `%KIND%` noun phrase) are all seeded from `catalog.json` on first boot, then edited via the UI / `POST /api/settings`. Unknown/custom kinds fall back to the global preamble and use the kind name itself as the `%KIND%` phrase.
- **Kinds are dynamic.** The filter list / tabs are derived at runtime from the kinds present in `settings.kinds` plus any custom kind a subject was created with (`allKinds()` in `app.js`) — there are no hardcoded kind tabs in `index.html`. Creating a subject with a brand-new kind just works; add a `kind_preambles` entry only if it needs different framing from the global preamble.

## Storage shape

- **R2 (`IMAGES` binding)** — image bytes and 3D mesh bytes. Both routed through the same bucket; the worker's `/img/<key>` and `/mesh/<key>` routes are functionally identical proxies, just different URL roots.
  - `subjects/<subjectId>/<uuid>.<ext>` — primary renders.
  - `subjects/<subjectId>/views/<uuid>.<ext>` — derivative views (front/back/top/three-quarter) generated from a primary favorite via a Krea image-edit model (defaults to `google/nano-banana-pro`; see Krea image-edit below).
  - `refs/<subjectId>/<uuid>.<ext>` — user-uploaded reference images (style-image inputs), uploaded via `POST /api/subjects/:id/ref`.
  - `meshes/<id>.<ext>` — 3D mesh bytes (glb/gltf/obj/etc).
  - All R2 reads serve with `cache-control: immutable, max-age=1y`.
- **KV (`STATE` binding)**:
  - `settings` — global `Settings` object (preamble, kinds, kind_preambles, model defaults, mesh model, etc.).
  - `subject-index` — `string[]` of all subject ids. **Absent (`null`) = never seeded; `[]` = user deleted every subject** — `ensureSeeded` distinguishes the two so it never re-seeds over an intentional wipe.
  - `subject:<id>` — `Subject` record.
  - `overrides` — `{ [subjectId]: prompt }` per-subject prompt override.
  - `image-index` — `string[]` of all image ids.
  - `image:<id>` — `ImageMeta` for each render. Derivative views carry `parentImageId` and `view` fields ("front", "back", "top", "three_quarter"); primary renders leave both undefined.
  - `mesh-index` — `string[]` of all mesh ids.
  - `mesh:<id>` — `MeshMeta` for each generated 3D mesh; references the source image ids that fed it.
  - `asset-cache:<sourceUrl>` — cached Krea-asset upload result for `/refs/*` sprite uploads.
  - `asset-cache:r2:<r2Key>` — cached Krea-asset upload result for R2-stored images promoted to Krea (used by multi-view image-edit / 3D when the source image lives in our R2).
- **Don't add new top-level KV keys without naming them with a prefix.** `settings`, `overrides`, `image-index`, `mesh-index`, `subject-index` are unprefixed; everything else uses `noun:identifier` form.
- **`handleDelete` cascades.** Deleting a primary image also deletes any derivative views that reference it as `parentImageId`. Mesh records are NOT cascaded — they survive until explicitly deleted via `/api/mesh/:id`. (Source-image gone but mesh remains is intentional: the mesh itself is the artifact.)
- **`handleSubjectDelete` cascades images, keeps meshes.** Deleting a subject deletes every render + derivative view that carries its `subjectId` (both do), plus its uploaded R2 ref images and its prompt override. Meshes are intentionally NOT cascaded — same rule as `handleMeshDelete`. Legacy `/refs/…` static files are left on disk (they may be shared); only R2-uploaded refs are deleted.

## Job tracking (persistent generation)

Generation is **not synchronous**, and there are **two different job architectures** depending on which provider is doing the work — don't conflate them.

**Krea jobs (image + view generation) use `ctx.waitUntil`.** `POST /api/generate` and `/api/views/generate` call `startJob`, which persists a `JobMeta`, returns it immediately, then does the actual Krea polling inside `ctx.waitUntil` (see `pollKreaJob` in `src/index.ts`) — the worker stays alive after the HTTP response is sent to finish the work.

**fal jobs (mesh + remesh) do NOT use `ctx.waitUntil` — they're polled per-request.** `handleMeshGenerate` / `handleMeshRemesh` submit to fal's queue API synchronously (fast — just a POST), store the returned `status_url`/`response_url` on the `JobMeta`, and return. Neither handler holds a background poll open — they take `_ctx: ExecutionContext` and never call it. Instead, every `GET /api/job/:id` (throttled to once per 2.5s via `falLastPolledAt`) calls `pollFalAndAdvance`, which hits fal's status endpoint once and advances the job. This is deliberate: mesh generation takes up to 5 minutes, and a `ctx.waitUntil` that long risks Cloudflare evicting the idle isolate mid-poll and stranding the job in "processing" forever. Per-request polling means each poll is its own short-lived invocation, so isolate eviction can't strand it.

The frontend polls `/api/job/:id` every 2s for status regardless of which architecture is behind it; pending jobs are persisted in KV (`job:<id>`, indexed by `job-index`) and **survive page refresh**. On a fresh page load, `init()` reads `state.jobs` from `/api/state` and resumes polling.

### Why this shape

- Generation can take 30s (Krea image) to 5min (fal 3D mesh). Holding an HTTP connection open that long burns server connection slots and loses all progress on a frontend refresh.
- Krea jobs are short enough that `ctx.waitUntil` reliably survives to completion. fal mesh jobs are not, hence the per-request-poll fallback for those.
- Stale jobs (no progress for >15min — see `JOB_STALE_MS`) are surfaced as `failed` automatically for the `ctx.waitUntil` path (Krea). This guards against the worker getting killed mid-poll without leaving the job stuck in "processing" forever. fal jobs self-heal via per-poll instead and shouldn't go stale this way.

### Don't break this

- **Always thread `ctx` to Krea job handlers.** `handleGenerate(req, env, ctx)` / `handleViewsGenerate(req, env, ctx)`, not `(req, env)`. `startJob` requires `ctx.waitUntil` to keep the Krea polling alive. `handleMeshGenerate` / `handleMeshRemesh` intentionally ignore `ctx` — don't "fix" them to use `ctx.waitUntil`, that's the eviction bug this architecture avoids.
- **Update progress liberally.** Each Krea poll inside `pollKreaJob` calls `update("Krea status: …")`; each fal poll inside `pollFalAndAdvance` sets `job.progress` directly. If you add new long-running steps, keep the frontend's progress text meaningful.
- **Job records are removed from `job-index` on terminal status** but the `job:<id>` KV record stays around briefly so the frontend's last poll can resolve. The frontend then DELETEs the job record. Don't refactor this to delete on terminal — you'd race with the frontend's poll.
- **Cancellation differs by provider.** `POST /api/job/:id/cancel` (`handleJobCancel`) always marks the job `failed` locally, but for fal jobs it also fires the job's `falCancelUrl` (`PUT` with `Authorization: Key <FAL_API_KEY>`) as a best-effort real cancel, since fal exposes one. Krea jobs have no `falCancelUrl`, so cancelling one is local-only — the in-flight Krea job keeps running and you're billed regardless. The cancel button's title is worded to reflect this asymmetry; don't blur it into "cancellation always stops billing."

## Krea integration gotchas

- **One image per `/api/generate` call.** The frontend parallelizes by firing N requests, not by asking Krea for N. Krea's response shape is `{ urls: [...] }` but in practice we only consume `urls[0]`.
- **Style images need to live on Krea.** Random URLs (including `/refs/*` from this Worker) get rejected with "Invalid asset URL". `ensureKreaAsset` uploads the bytes to `POST /assets`, caches the returned `image_url` in KV by source URL, and reuses it. If you change the bytes of a `/refs/*` file, **the cache will keep handing back the old Krea-hosted upload** — bust the cache by changing the URL (rename the file or add a query string) or manually delete the `asset-cache:*` KV entry.
- **Krea's request fields are snake_case.** Krea deprecated the camelCase field names (`styleImages`, `imageUrl`, `imageUrls`) in favor of `style_images`, `image_url`, `image_urls` (sunset 2026-06-19 — see `docs.krea.ai/developers/deprecations`). `kreaGenerate` in `src/index.ts` builds the request body with the snake_case names; the TypeScript-side params passed *into* `kreaGenerate` (`styleImages`, `imageUrl`, `imageUrls`) are still camelCase — only the wire format sent to Krea changed. Don't reintroduce camelCase into the `body` object built in `kreaGenerate`.
- **Model param shape varies.** `flux-1-dev` accepts `steps`; `flux-1.1-pro` does not and caps at 1440x1440. `STYLE_IMAGE_MODELS` (currently `bfl/flux-1-dev`, `google/nano-banana`, `google/nano-banana-pro`, `ideogram/ideogram-3`) is the allow-list for `style_images` — outside that set, Krea silently drops the param. Update both places when adding a new model.
- **Output resolution floors at the style-image dims.** Some Krea models lock output to the reference's size if the requested output is smaller. `handleGenerate` raises `width`/`height` to at least the ref's dims before calling Krea. Don't "simplify" this away.
- **Polling caps at 90s wall-clock.** Workers Paid gets unlimited wall-clock but 30s CPU; the polling loop is mostly `await sleep(2000)` so CPU is fine. If Krea is consistently slower, raise the deadline in `kreaGenerate` rather than tightening the poll interval. (This 90s cap only applies to Krea polling inside `ctx.waitUntil` — see the fal per-poll architecture above for why mesh generation doesn't use this pattern.)

## Local dev gotchas

- **`wrangler dev` uses real R2 + real KV + real Krea credits by default.** Local generations cost real money and pollute the production gallery. The README mentions this; keep it in mind.
- **The `ASSETS` binding works in dev.** `/refs/*` is served by the same Worker that handles `/api/*`, so style-image uploads from local sprites round-trip correctly without poking at `127.0.0.1`.
- **No auth on the Worker.** Anyone with the URL can generate and burn Krea credits. If you ever expose this beyond the dev's machine, gate `/api/generate` behind a shared secret check at the top of `fetch`.

## Pipeline tab — favorites → multi-view → 3D

The Pipeline tab (`renderPipeline` in `app.js`) is the curation surface that turns favorites into 3D assets. Each favorite primary image gets a row with four view slots (front, three_quarter, back, top) and a "Generate 3D" button. Empty slots show a `+` stub; click it to fire a Krea image-edit at the source image with a view-specific prompt from `VIEW_PROMPTS` that says "same exact subject, but rotated to <view>." The generated derivative is stored as a regular `ImageMeta` with `parentImageId` and `view` set, then slotted in.

3D generation collects the favorite + every derivative view, base64-encodes them, and submits to a fal.ai model (see below). The mesh comes back as a binary blob (glb expected); we save it to R2 and surface it via a **custom `<mesh-preview>` element** (`public/mesh-viewer.js`) — a hand-rolled Three.js viewer (loaded via an import map for `three` + `three/addons/`, no bundler) with three display modes (textured / wireframe / both) and orbit controls. This is **not** Google's `<model-viewer>` web component — that was the original plan but the tool moved to a custom Three.js element to get the textured/wireframe split-viewport `<model-viewer>` can't do natively.

### 3D pipeline runs on fal.ai, NOT Krea

Krea's public REST API at `https://api.krea.ai/openapi.json` does not document image-to-3D (verified 2026-05; the web UI exposes it but the API doesn't). The 3D pipeline therefore runs on **fal.ai**, not Krea. The image generation and multi-view pipelines still run on Krea — only the mesh/remesh step crosses providers.

fal's queue API (`falSubmit` submits, `pollFalAndAdvance` polls — see the Job tracking section above for why there's no long-lived polling loop):
- Submit: `POST https://queue.fal.run/<model-slug>` with body shaped per `FAL_3D_MODELS[slug].buildBody` (or `FAL_REMESH_MODELS[slug].buildBody` for retopology)
- Auth header is `Authorization: Key <FAL_API_KEY>` — **NOT Bearer**. Wrong scheme is the most likely auth failure mode.
- Status polling: `GET status_url`, driven by `handleJobGet` at most once per 2.5s per job (not a fixed interval loop — see Job tracking above).
- States: `IN_QUEUE` → `IN_PROGRESS` → `COMPLETED` (or `FAILED` / `ERROR` / `CANCELLED`).
- Result fetch: separate GET to `response_url` once `COMPLETED`.

Per-model field-name divergence is normalized by adapters in `FAL_3D_MODELS` (mesh generation) and `FAL_REMESH_MODELS` (retopology). Each 3D adapter has `buildBody(sources, options)`, `extractMeshUrl(result)`, and `multiImage`. **When adding a new fal 3D model:**
1. Add an entry to `FAL_3D_MODELS` in `src/index.ts`.
2. Confirm field names by visiting `https://fal.ai/models/<slug>/api`.
3. Add the slug to the `<select id="mesh-model">` in `index.html`.

**Image input is base64 data URIs.** fal accepts URLs or data URIs; we use data URIs to (a) avoid a separate fal.storage upload round-trip, and (b) make `wrangler dev` work without exposing localhost to fal. `r2ToDataUri` reads the R2 object and emits `data:image/png;base64,...`. The chunked `arrayBufferToBase64` helper avoids call-stack overflow on large buffers.

**Multi-image-capable models** (Rodin, Hunyuan 3D v3.1 Pro) receive every favorite + derivative view; single-image models (Trellis, TripoSR, Meshy v6, Hunyuan 2.1) receive only the primary favorite. The branching is in `handleMeshGenerate` via each adapter's `multiImage` flag. Don't blindly send N images to a single-image model — fal will reject or silently drop them.

### Krea image-edit (multi-view)

Multi-view defaults to **`google/nano-banana-pro`** (Gemini 2.5 Flash Image), not Flux Kontext. The comment above `VIEW_PROMPTS` in `src/index.ts` explains why: nano-banana-pro is much stronger than `bfl/flux-1-kontext-dev` at identity-preserving rotation — flux-kontext drifts wildly when asked to rotate a subject, it's better suited to prompt-style edits. The UI's `views-model` select even labels the flux-kontext option "drifts a lot." The default is overridable per the frontend's `state.settings.viewsModel`; other options are `google/nano-banana` (faster) and `bytedance/seedream-4` (alt).

`kreaGenerate` dispatches on model slug: `flux-1-kontext-dev` gets `image_url` (singular — one source image); `nano-banana*`, `seedream*`, and `flux-1-kontext*` all get `image_urls` (array). `handleViewsGenerate` passes the source through both `imageUrl` and `imageUrls` params so whichever the chosen model wants is populated. None of these models are in `STYLE_IMAGE_MODELS` — image-edit is a separate code path from style-reference generation.

## When adding a new subject type or kind

Subjects and kinds are **fully dynamic and KV-backed** (see Conventions above) — there's no catalog file to hand-edit. To add a new kind:
1. Create a subject with that kind from the "+ Add asset" UI (type a new kind name into the kind field) — it shows up as a new filter tab automatically via `allKinds()` in `app.js`.
2. If the kind needs different framing/composition than the global preamble (e.g. items shown three-quarter, not broadside), add a `settings.kind_preambles[<kind>]` entry via the Settings panel (or `POST /api/settings` directly) — see the Conventions section above for how per-kind preambles resolve.
3. Add a `settings.kinds[<kind>]` entry (the noun phrase substituted for `%KIND%`) if the kind name itself isn't a good `%KIND%` phrase on its own.
- **`public/catalog.json` is not part of this loop.** It's read exactly once, by `ensureSeeded`, only on a KV instance that has never been seeded. Editing it after first boot has zero effect on a running deployment — don't tell someone to "add to catalog.json and redeploy" to add a subject.
- **Mismatched `kind` vs subject leaks visual noise.** E.g. a "weapon" subject described as "ammunition projectile" but with a `%KIND%` phrase of "an in-flight ammunition projectile by itself, NOT a gun and NOT a vehicle" exists in the seed data specifically because earlier renders kept generating guns and ships. If you see the model painting hardware around a projectile, the fix is in that kind's noun phrase, not the per-subject `description`.

## When adding a new pipeline step

- New endpoints go in `src/index.ts` with the same `/api/<verb>` shape and the same KV-prefix discipline above.
- **Decide which job architecture it needs.** If the upstream call reliably finishes in well under a minute, the Krea/`ctx.waitUntil` pattern (`startJob` + a `runner` callback) is simpler. If it can run for minutes (like fal mesh generation), use the per-request-poll pattern instead (`falSubmit`-style: submit synchronously, stash `status_url`/`response_url` on the `JobMeta`, advance it from inside `handleJobGet`) — see the Job tracking section above for why the two exist and don't blend them.
- Large artifacts (images, meshes) go in R2; metadata in KV. Never put binary bytes in KV — its 25MB/key limit will bite you and reads count toward request quota.
- **Anything irreversible or expensive must be explicitly user-triggered.** 3D mesh generation is gated behind a confirm dialog because it's the most expensive operation in the tool. Don't auto-fire on favorite. The cost story matters.
