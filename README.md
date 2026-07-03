# Driftcore Vizdev Moodboard

A self-hosted page for generating sprite mood boards for the game's player ship, enemies, projectiles, helper drones (options), augment icons, and secondary weapons. Each catalog entry has a description; click **Generate** to produce N renders via Krea, heart the ones you like, delete the duds. Favorites can then be promoted through a **Pipeline** tab that fires multi-view image-edits (front / 3-quarter / back / top) and an optional 3D mesh render, viewable in-browser via `<model-viewer>`. Favorites and meshes are stored permanently in Cloudflare R2 + KV.

```
tools/moodboard/
  public/             # static frontend (served by the Worker via [assets])
    index.html
    style.css
    app.js
    catalog.json      # source of truth for subjects + default style preamble
  src/
    index.ts          # Cloudflare Worker (API + Krea proxy + R2/KV storage)
  wrangler.toml
  package.json
  tsconfig.json
```

## Architecture

- **Frontend**: vanilla HTML/CSS/JS, no build step. Loads `catalog.json`, hits the Worker for state and generation.
- **Worker**: routes `/api/*` for state mutations, `/img/*` for streaming bytes from R2, and falls through to the `ASSETS` binding for the static page.
- **Krea**: `POST /generate/image/<model>` → `{ job_id }`, polled at `GET /jobs/<job_id>` until `status === "completed"`. The result image URL is downloaded by the Worker and stored to R2 (Krea-hosted URLs aren't guaranteed permanent — favorites need to survive forever).
- **Storage**: image bytes in R2, metadata + settings + prompt overrides in KV.

## One-time setup

You need a Cloudflare account with Workers Paid (R2 needs the paid plan) and a Krea API key.

```powershell
cd tools/moodboard
npm install

# log in once
npx wrangler login

# create the KV namespace (copy the returned id into wrangler.toml)
npx wrangler kv namespace create driftcore_moodboard_state

# create the R2 bucket
npx wrangler r2 bucket create driftcore-moodboard-images

# stash the Krea key as a secret (you'll be prompted to paste it)
npx wrangler secret put KREA_API_KEY

# stash the fal.ai key — used by the 3D pipeline. Krea's public REST API
# doesn't expose image-to-3D, so the Pipeline tab's "Generate 3D" button
# delegates to fal.ai. Krea is still used for everything else (image
# generation, multi-view edits via flux-kontext / nano-banana-pro).
npx wrangler secret put FAL_API_KEY
```

Edit `wrangler.toml` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with the id `wrangler` printed.

## Run locally

```powershell
cd tools/moodboard
npm run dev
```

Opens at http://localhost:8787. The local dev server uses **the same R2 + KV + secret** as production — don't generate spam locally if you don't want it on your real account. (Pass `--remote=false` to wrangler to use a local mock, but R2 mocking is sketchy; remote bindings are usually less surprising.)

## Deploy

```powershell
npm run deploy
```

Lands at `https://driftcore-moodboard.<your-account>.workers.dev`. Bind a custom domain via the Cloudflare dashboard if you want a stable URL.

## How to use the page

1. **Settings (top right)** — edit the global preamble (the camera/composition/style scaffold). Use `%SUBJECT%`, `%KIND%`, and `%FACING%` placeholders; they get substituted per subject. Pick a model, image size, sampler steps, how many to generate per click, and a 3D model slug for the Pipeline tab.
2. **Tabs** — filter to All / Player / Enemies / Weapons / Options / Augments / Bombs / ★ Favorites / ⛭ Pipeline.
3. **Each card** — has the subject's description, an expandable full prompt (preamble + description) you can edit per-subject and save as an override, and a Generate button. Generated images appear in the gallery; hover to favorite (♥) or delete (🗑). Click a thumb for a lightbox view.
4. **Pipeline tab** — lists every favorited primary render. For each, four view slots (front / three-quarter / back / top) — click `+` to fire one, or **Generate views** to fire all four in parallel via Flux Kontext. Once you have the views, **Generate 3D** uses the favorite + its views as input to a Krea 3D model and embeds the resulting mesh in a `<model-viewer>` you can orbit / pan / zoom right in the page.

The order of operations for finding a style: (1) start with the default preamble, generate 2 images for one subject across 3-4 candidate models, (2) pick the model whose output reads best at sprite size, (3) save settings, (4) start clicking Generate on every subject. Heart your favorites; the **Favorites** tab gives you the assembled mood board, and the **Pipeline** tab is where favorites graduate into multi-view + 3D.

### Per-kind preambles

`catalog.json` has both a global `settings.preamble` and a `kind_preambles` map. Per-kind preambles override the global one for that kind only — projectiles use a tiny-particle composition (no surrounding hardware), augments use a flat front-on icon composition. If you add a new subject type whose framing doesn't match the broadside-profile default, add a `kind_preambles[<your-kind>]` entry to scope the change.

### 3D pipeline → fal.ai

Krea's public REST API does not document image-to-3D as of 2026-05 (their UI exposes it; the OpenAPI spec doesn't), so the **Generate 3D** button delegates to **fal.ai**. fal supports several image-to-3D models with different shape/cost/quality tradeoffs; pick one in the inspector's `Pipeline → Mesh` dropdown:

| Model | Slug | Input | Notes |
|---|---|---|---|
| Hunyuan 3D v3.1 Pro | `fal-ai/hunyuan-3d/v3.1/pro/image-to-3d` | **multi-view** (named slots) | Default. Maps the favorite + derivatives to front/back/top/three_quarter slots; PBR; up to 1.5M faces |
| Hyper3D Rodin | `fal-ai/hyper3d/rodin` | multi-image | Premium. Concat / fuse mode |
| Trellis | `fal-ai/trellis` | single image | Solid mid-tier |
| TripoSR | `fal-ai/triposr` | single image | Fastest, cheapest |
| Hunyuan3D 2.1 | `fal-ai/hunyuan3d-v21` | single image | Deprecated by fal but still callable |

After a mesh exists, click **smart-topology** on the mesh card to run `fal-ai/hunyuan-3d/v3.1/smart-topology` for retopology — produces a triangle or quad mesh at low/medium/high face level. The original mesh stays; the remeshed result appears as an indented child mesh on the same Pipeline row so you can compare.

Single-image models receive only the primary favorite. Multi-image models receive every available derivative view (front/3-quarter/back/top) plus the favorite — in practice this means **Rodin is the only model that benefits from clicking "Generate all views" first**.

Image input is passed as base64 data URI (avoids a fal.storage upload round-trip and works the same in `wrangler dev` and prod). Result mesh URL is downloaded and saved to R2 like image renders.

## Adding catalog entries later

Edit `public/catalog.json` and redeploy. The `id` is the storage key; renaming an `id` orphans existing images (they'll still exist in R2 but the card won't find them — you'd need to migrate the index manually).

## Costs to keep in mind

- Krea charges compute units per image (flux-1-dev ≈ 3 cu, flux-1-pro ≈ 28 cu). Two generations × 35 subjects × flux-pro ≈ 2,000 cu.
- R2 storage and Workers requests are negligible at this scale.

## API surface (worker)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/state` | — | `{ settings, overrides, images[], meshes[] }` |
| POST | `/api/settings` | `Settings` | `{ ok }` |
| POST | `/api/prompt` | `{ subjectId, prompt }` (empty prompt = clear override) | `{ ok }` |
| POST | `/api/generate` | `{ subjectId, prompt, model, width, height, steps, styleImageUrl?, styleStrength? }` | `ImageMeta` |
| POST | `/api/favorite` | `{ id, value }` | `ImageMeta` |
| DELETE | `/api/image/:id` | — | `{ ok, cascaded }` (also deletes derivative views) |
| POST | `/api/views/generate` | `{ sourceImageId, view, model?, steps? }` (`view` ∈ front/three_quarter/back/top) | `ImageMeta` (with `parentImageId` + `view`) |
| POST | `/api/mesh/generate` | `{ sourceImageIds: string[], model? }` | `MeshMeta` |
| DELETE | `/api/mesh/:id` | — | `{ ok }` |
| GET | `/img/:r2Key` | — | image bytes (cached 1y) |
| GET | `/mesh/:r2Key` | — | 3D mesh bytes (cached 1y, CORS open for `<model-viewer>`) |

## Notes / known sharp edges

- **One image per `/api/generate` call.** The frontend fires N calls in parallel for "generate N at once." Each Worker invocation polls Krea up to 90s — well within the 30s CPU / unlimited wall-clock budget for a paid Worker. If you find Krea slower than that, raise the deadline in `kreaGenerate`.
- **No auth on the worker.** Anyone with the URL can generate (and burn your Krea credits). If you ever expose this beyond yourself, add a shared-secret header check at the top of `fetch`.
- **R2 is hit through the worker proxy**, not a public bucket. Bandwidth is free between Workers and R2; egress to your browser counts as Workers egress (free up to 10M requests/month on paid).
