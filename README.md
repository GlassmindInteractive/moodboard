# Moodboard

A self-hosted Cloudflare Worker + vanilla-JS page for generating and curating AI reference art for game asset design. Define a "subject" (a ship, a creature, a projectile, an icon — whatever you're designing), write a description, click **Generate**, and get N renders back from [Krea](https://krea.ai). Heart the ones you like. Promote favorites through a **Pipeline** tab that produces multi-angle views (front / three-quarter / back / top) via Krea image-editing, then feeds those views into [fal.ai](https://fal.ai) to generate an actual 3D mesh you can orbit in-browser.

Everything — renders, derivative views, meshes, subjects, prompts, settings — is stored permanently in Cloudflare R2 + KV, so the gallery survives restarts and is shareable by URL.

This tool started life as an internal vizdev utility for **Driftcore**, a side-scrolling shmup, and was later split out into its own repo. The bundled `public/catalog.json` and `public/refs/*` sprites are **seed/demo data** from that game — a working example of the subject shape, not something the tool depends on. Delete them, or add your own subjects from the UI, and it works the same for any project.

## Pipeline story

1. **Generate** — pick a subject, pick a Krea model (FLUX, Imagen, Ideogram, nano-banana, etc.), click Generate N. Each click fires N parallel requests; each request is tracked as a background job so a page refresh doesn't lose in-flight work.
2. **Curate** — heart the renders you like, delete the rest. Favorites show up in the ★ Favorites tab and become the input to the next stage.
3. **Multi-view** — on the Pipeline tab, each favorite gets four view slots (front / three-quarter / back / top). Each slot fires a Krea image-edit call (default model `google/nano-banana-pro`) that rotates the same subject into that view while preserving its identity.
4. **3D mesh** — once you have views, "Generate 3D" sends the favorite + its views to a fal.ai image-to-3D model (Hunyuan 3D, Rodin, Trellis, TripoSR, etc., picked from a dropdown). The resulting glb is stored in R2 and rendered in a custom Three.js viewer with textured/wireframe/both display modes. A retopology pass (fal's smart-topology or Meshy remesh) can clean up the mesh afterward.

## Architecture

```
public/               # static frontend (served by the Worker via the ASSETS binding), no build step
  index.html
  style.css
  app.js               # all frontend logic — subjects, generation, jobs, pipeline, lightbox
  mesh-viewer.js        # <mesh-preview> custom element: Three.js GLB viewer (textured/wireframe/both)
  catalog.json          # SEED DATA ONLY — imported into KV once, on first boot
  refs/                 # legacy static sprite refs bundled as demo style-image inputs
    bullets/  enemies/  player/
src/
  index.ts              # Cloudflare Worker: /api/* routes, Krea + fal proxying, R2/KV storage
wrangler.toml            # bindings: ASSETS (static), IMAGES (R2), STATE (KV); secrets: KREA_API_KEY, FAL_API_KEY
package.json
tsconfig.json
```

- **Frontend**: vanilla HTML/CSS/JS, ES-module-style, no framework, no bundler. Subjects, settings, and images all come from the Worker's `/api/*` endpoints — `catalog.json` is read only by the server-side one-time seed migration, never by the frontend directly.
- **Worker**: routes `/api/*` for state mutations, `/img/*` and `/mesh/*` for streaming bytes out of R2, and falls through to the `ASSETS` binding for everything else (the static page).
- **Subjects are dynamic and KV-backed.** They're created, edited, and deleted from the UI ("+ Add asset" button, per-subject edit panel) — not by hand-editing a JSON file. On first boot, the Worker seeds KV from `public/catalog.json` once (`ensureSeeded`); after that, `catalog.json` is inert.
- **Krea** (image generation + image-edit): `POST /generate/image/<model>` → `{ job_id }`, polled at `GET /jobs/<job_id>` until `status === "completed"`. The Worker downloads the resulting image and stores it in R2 (Krea-hosted URLs aren't guaranteed permanent).
- **fal.ai** (3D mesh + retopology only): Krea's public API doesn't expose image-to-3D, so the mesh step runs on fal's queue API (`queue.fal.run`) instead. Submission is fast; the resulting job is polled per-request (not held open in the Worker) so a 5-minute mesh generation survives Cloudflare recycling the isolate.
- **Storage**: image bytes + mesh bytes in R2; subjects, settings, prompt overrides, image/mesh metadata, and job state in KV.

## One-time setup

You need a Cloudflare account with a paid Workers plan (R2 requires it), a [Krea](https://krea.ai) API key, and a [fal.ai](https://fal.ai) API key.

```powershell
npm install

# log in once
npx wrangler login

# create your own KV namespace — the id checked into wrangler.toml belongs to
# the original deployment, so you need your own
npx wrangler kv namespace create moodboard-state

# create your own R2 bucket (any name works, but it must match wrangler.toml's
# bucket_name — either rename the bucket or edit the toml to match what you create)
npx wrangler r2 bucket create driftcore-moodboard-images

# stash the Krea key as a secret (prompts for the value)
npx wrangler secret put KREA_API_KEY

# stash the fal.ai key — used only by the 3D mesh + retopology pipeline
npx wrangler secret put FAL_API_KEY
```

Edit `wrangler.toml`: replace the `[[kv_namespaces]]` block's `id` with whatever `wrangler kv namespace create` printed (the committed id points at the original deployment's namespace, not yours), and make sure `[[r2_buckets]]`'s `bucket_name` matches the R2 bucket you created.

For local development, put the same two keys in a `.dev.vars` file at the repo root (gitignored):

```
KREA_API_KEY=your-krea-key
FAL_API_KEY=your-fal-key
```

## Run locally

```powershell
npm run dev
```

Opens at `http://localhost:8787`. **`wrangler dev` talks to the same real R2 bucket, real KV namespace, and real Krea/fal credentials as production** — there is no free local mock for this stack. Every generation you click locally burns real Krea/fal credits and writes into the same gallery you'd see in prod. Don't spam-test.

## Deploy

```powershell
npm run deploy
```

Lands at `https://<worker-name>.<your-account>.workers.dev` (the worker name comes from `wrangler.toml`'s `name` field). Bind a custom domain via the Cloudflare dashboard if you want a stable URL. Other useful scripts: `npm run tail` streams live Worker logs.

## Cost warnings

- **Krea charges compute units per image.** Rough guide from the model picker: `flux-1-dev` ≈ 3 cu, `qwen-2512` ≈ 9 cu, `seedream-4` ≈ 21 cu, `flux-1.1-pro` ≈ 28 cu. Multi-view edits and 3D mesh generation cost more and take longer (up to several minutes for a mesh).
- **fal.ai bills per mesh/retopology job**, independent of Krea. Multi-image models (Rodin) cost more than single-image models (TripoSR).
- **Generation cost is incurred the moment it's submitted, not when you see the result.** Cancelling a pending Krea job (image/view generation) only stops local polling — Krea keeps working and you're billed anyway. Cancelling a pending fal job (mesh/retopology) does send a real cancel request upstream, but it's best-effort.
- **There is no authentication on the Worker.** Anyone who has the URL can fire generations and burn your Krea/fal credits. This is fine for a private/dev URL you don't share, but if you ever expose it publicly, add an auth check (e.g. a shared-secret header) at the top of the `fetch` handler in `src/index.ts` before you do.

## How to use the page

1. **+ Add asset** (top of the left panel) opens a modal to create a new subject: name, kind (pick an existing one from the dropdown or type a new one), facing direction, a text description of what the model should render, and an optional reference image upload. Kind tabs in the filter list are generated dynamically from whatever kinds exist across your subjects — there's no fixed list to edit.
2. **Preamble** (per kind) — the camera/composition/style scaffold that gets combined with each subject's description. Placeholders `%SUBJECT%`, `%KIND%`, `%FACING%` are substituted per subject at generation time. Each kind can have its own preamble override; kinds without one fall back to the global preamble in Settings.
3. **Generation panel** — pick a Krea model, output size, sampler steps, how many images to generate per click, and (if the subject has a reference image) how strongly to weight it as a style reference.
4. **Each subject row** — shows its description/prompt (editable and saveable as a per-subject override), a Generate button, and its gallery of past renders. Hover a thumbnail to favorite (♥) or delete (🗑); click one for a lightbox view. A jobs popover in the header shows everything currently in flight and lets you cancel.
5. **Pipeline tab** — lists every favorited render. Each gets four view slots (front / three-quarter / back / top); click `+` on a slot to fire one edit, or generate all four at once. Once views exist, "Generate 3D" sends the favorite + its views to the selected fal.ai model and the resulting mesh appears in an orbitable 3D viewer. A "smart-topology" button on a mesh runs retopology and slots the cleaned-up result in as a child mesh next to the original, so you can compare.

### 3D pipeline models (fal.ai)

| Model | Slug | Input | Notes |
|---|---|---|---|
| Hunyuan 3D v3.1 Pro | `fal-ai/hunyuan-3d/v3.1/pro/image-to-3d` | multi-view (named slots) | Default. Maps favorite + derivative views to front/back/top/three-quarter slots; PBR, up to 500k faces |
| Hyper3D Rodin | `fal-ai/hyper3d/rodin` | multi-image | Premium; concat/fuse mode across every available view |
| Meshy v6 | `fal-ai/meshy/v6/image-to-3d` | single image | Most exposed knobs: polycount, topology, pose, symmetry, auto-retopo |
| Trellis | `fal-ai/trellis` | single image | Solid mid-tier |
| TripoSR | `fal-ai/triposr` | single image | Fastest, cheapest |
| Hunyuan3D 2.1 | `fal-ai/hunyuan3d-v21` | single image | Deprecated upstream but still callable |

Retopology (separate step, on an existing mesh): `fal-ai/hunyuan-3d/v3.1/smart-topology` or `fal-ai/meshy/v5/remesh`, both taking a target topology (triangle/quad) and density (low/medium/high).

## API surface (Worker)

All endpoints are prefixed `/api`. Generation endpoints return a `JobMeta` immediately (`{ id, status, ... }`) — the actual work happens asynchronously; poll `GET /api/job/:id` until `status` is `completed` or `failed`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/state` | — | `{ settings, overrides, images[], meshes[], jobs[] }` |
| POST | `/api/settings` | `Settings` | `{ ok }` |
| POST | `/api/prompt` | `{ subjectId, prompt }` (empty prompt clears the override) | `{ ok }` |
| GET | `/api/subjects` | — | `{ subjects[] }` (also runs the one-time seed migration) |
| POST | `/api/subjects` | `{ name, kind, description?, facing? }` | `Subject` |
| PUT | `/api/subjects/:id` | `{ name?, kind?, description?, facing? }` | `Subject` (id/refImages not editable here) |
| DELETE | `/api/subjects/:id` | — | `{ ok, deletedImages }` (cascades renders + views; meshes survive) |
| POST | `/api/subjects/:id/ref` | raw image bytes, `content-type: image/*` | `Subject` (appends an R2-hosted ref) |
| DELETE | `/api/subjects/:id/ref` | `{ ref }` | `Subject` |
| POST | `/api/generate` | `{ subjectId, prompt, model, width, height, steps, styleImageUrl?, styleStrength? }` | `JobMeta` |
| POST | `/api/favorite` | `{ id, value }` | `ImageMeta` |
| DELETE | `/api/image/:id` | — | `{ ok, cascaded }` (also deletes derivative views) |
| POST | `/api/views/generate` | `{ sourceImageId, view, model?, steps? }` (`view` ∈ front/three_quarter/back/top) | `JobMeta` |
| POST | `/api/mesh/generate` | `{ sourceImageIds: string[], model?, options? }` | `JobMeta` |
| POST | `/api/mesh/remesh` | `{ sourceMeshId, model?, polygon_type?, face_level? }` | `JobMeta` |
| GET | `/api/job/:id` | — | `JobMeta` (+ inlined `result` once completed) |
| DELETE | `/api/job/:id` | — | `{ ok }` |
| POST | `/api/job/:id/cancel` | — | `{ ok, cancelHit }` |
| DELETE | `/api/mesh/:id` | — | `{ ok }` |
| GET | `/img/:r2Key` | — | image bytes (cached 1y, immutable) |
| GET | `/mesh/:r2Key` | — | 3D mesh bytes (cached 1y, immutable, CORS open) |

## Adding subjects

Create them from the "+ Add asset" button in the UI — no file editing required. `public/catalog.json` is seed data consumed exactly once (on first boot, when the `subject-index` KV key doesn't exist yet); editing it after that has no effect on an already-seeded deployment. A subject's `id` is a slug derived from its name and is immutable once created (it's embedded in R2 keys for every render) — renaming a subject changes its display name but not its `id`.

## Notes / known sharp edges

- **One image per `/api/generate` call.** The frontend parallelizes "generate N at once" by firing N requests, not by asking Krea for N images in one call.
- **No auth on the Worker** — see Cost warnings above.
- **R2 is fronted by the Worker**, not exposed as a public bucket; bandwidth between the Worker and R2 is free, egress to the browser counts as normal Workers usage.
- **Style images and image-edit inputs must be Krea-hosted.** The Worker uploads local/R2 bytes to Krea's asset endpoint on first use and caches the resulting URL in KV — this is transparent to the UI but means the very first generation using a new reference image is slightly slower.
