// Driftcore Vizdev Moodboard frontend.
// Two-column inspector layout: left rail = filter + prompt + generation params,
// right canvas = the gallery (Gallery view) or the favorites pipeline (Pipeline view).

const state = {
  catalog: null,
  settings: null,
  overrides: {},
  images: [],
  meshes: [],
  jobs: [],
  activeView: "gallery",   // "gallery" | "pipeline"
  activeFilter: "all",     // "all" | "<kind>" | "favorites"
  pollers: new Map(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(path, init) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

// Toast also logs to console — toasts disappear after a few seconds and the
// 4s window for errors was too short to actually read or screenshot. Every
// error is duplicated to console.error (open DevTools to inspect after the
// toast vanishes). Errors also get a longer visible window, and any toast
// can be dismissed early by clicking it.
let _toastTimer = null;
function toast(msg, kind = "info") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  if (kind === "error") {
    console.error("[toast]", msg);
  } else {
    console.log("[toast]", msg);
  }
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add("hidden"), kind === "error" ? 12000 : 4000);
  el.onclick = () => {
    el.classList.add("hidden");
    if (_toastTimer) clearTimeout(_toastTimer);
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// ---------- job freshness ---------------------------------------------------
// `JobMeta.updatedAt` is written by the worker every time the runner calls
// update() (which happens on every fal/Krea status poll). If it's advancing,
// the worker is alive and the underlying provider is responding. If it's
// frozen for >30s the job is probably stuck — either fal is slow or the
// worker invocation died. We surface the freshness as "last update Xs ago"
// under the progress text, and color it warm/red as it gets stale.

function jobAgeSeconds(job) {
  return Math.max(0, Math.round((Date.now() - job.updatedAt) / 1000));
}
function ageHint(s) {
  if (s < 60) return `last update ${s}s ago`;
  if (s < 3600) return `last update ${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `last update >1h ago — likely dead`;
}
function ageStaleness(s) {
  if (s > 120) return "dead";   // red
  if (s > 30)  return "stale";  // amber
  return "fresh";
}

// One ticker for all visible job-age displays. Started lazily, stops when
// no in-flight jobs remain so we're not running setInterval forever.
function ensureAgeTicker() {
  if (state._ageTicker) return;
  state._ageTicker = setInterval(() => {
    const els = document.querySelectorAll(".job-age[data-updated-at]");
    if (!els.length) {
      clearInterval(state._ageTicker);
      state._ageTicker = null;
      return;
    }
    const now = Date.now();
    for (const el of els) {
      const t = parseInt(el.dataset.updatedAt, 10);
      if (!t) continue;
      const s = Math.max(0, Math.round((now - t) / 1000));
      el.textContent = ageHint(s);
      el.classList.remove("fresh", "stale", "dead");
      el.classList.add(ageStaleness(s));
    }
  }, 1000);
}

// ---------- prompt resolution ----------------------------------------------

function preambleFor(subject) {
  // Per-kind only — no global fallback. Each kind in catalog.kind_preambles
  // MUST have a preamble; missing kinds surface a console warning so the
  // catalog gets fixed instead of silently rendering the legacy global.
  const settingsKind = state.settings.kind_preambles?.[subject.type];
  if (settingsKind && settingsKind.trim()) return settingsKind;
  const catalogKind = state.catalog.kind_preambles?.[subject.type];
  if (catalogKind && catalogKind.trim()) return catalogKind;
  console.warn(`[moodboard] no preamble for kind '${subject.type}'. Add one to catalog.kind_preambles.`);
  return state.catalog.settings.preamble;
}

function buildPrompt(subject) {
  const body = state.overrides[subject.id] ?? subject.description;
  const kinds = state.catalog.kinds || {};
  const kind = kinds[subject.type] || subject.type;
  return preambleFor(subject)
    .replace(/%SUBJECT%/g, subject.name)
    .replace(/%KIND%/g, kind)
    .replace(/%FACING%/g, subject.facing) +
    "\n\n" + body;
}

// Resolve which kind preamble to show in the inspector editor based on the
// active filter. Returns { kind, value, source } or null if filter isn't a
// specific kind (i.e. "all" or "favorites").
function resolveActivePreamble() {
  const filter = state.activeFilter;
  if (!state.catalog.kinds?.[filter]) return null; // "all" / "favorites" / unknown
  const k = filter;
  const saved = state.settings.kind_preambles?.[k];
  const cat = state.catalog.kind_preambles?.[k];
  if (saved && saved.trim()) {
    return { kind: k, value: saved, source: `saved override · ${k}` };
  }
  if (cat && cat.trim()) {
    return { kind: k, value: cat, source: `catalog default · ${k}` };
  }
  return { kind: k, value: "", source: `${k} has NO preamble — add one to catalog.kind_preambles` };
}

// ---------- image / job filters --------------------------------------------

function imagesForSubject(subjectId) {
  return state.images
    .filter(i => i.subjectId === subjectId)
    .sort((a, b) => b.createdAt - a.createdAt);
}
function primaryImagesForSubject(subjectId) {
  return imagesForSubject(subjectId).filter(i => !i.parentImageId);
}
function viewsForParent(parentId) {
  return state.images.filter(i => i.parentImageId === parentId);
}
function meshesForImage(imageId) {
  // Only the "primary" meshes for this image (not remeshed children).
  return state.meshes.filter(m => m.sourceImageIds.includes(imageId) && !m.parentMeshId);
}
function remeshChildrenOf(meshId) {
  return state.meshes.filter(m => m.parentMeshId === meshId);
}
function remeshJobFor(meshId) {
  return state.jobs.find(j =>
    j.kind === "remesh" &&
    j.params?.sourceMeshId === meshId &&
    j.status !== "completed",
  );
}

const KNOWN_MESH_MODELS = new Set([
  "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d",
  "fal-ai/hyper3d/rodin",
  "fal-ai/meshy/v6/image-to-3d",
  "fal-ai/trellis",
  "fal-ai/triposr",
  "fal-ai/hunyuan3d-v21",
]);
const DEFAULT_MESH_MODEL = "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d";
function jobsForSubject(subjectId, kind = null) {
  return state.jobs.filter(j =>
    j.subjectId === subjectId &&
    j.status !== "completed" &&
    (kind ? j.kind === kind : true),
  );
}
function jobForView(parentImageId, view) {
  return state.jobs.find(j =>
    j.kind === "view" &&
    j.parentImageId === parentImageId &&
    j.view === view &&
    j.status !== "completed",
  );
}
function jobsForMeshParent(parentImageId) {
  return state.jobs.filter(j =>
    j.kind === "mesh" &&
    j.parentImageId === parentImageId &&
    j.status !== "completed",
  );
}

function subjectsForActiveFilter() {
  const all = state.catalog.subjects;
  if (state.activeFilter === "all") return all;
  if (state.activeFilter === "favorites") {
    const favSubjectIds = new Set(state.images.filter(i => i.favorite).map(i => i.subjectId));
    return all.filter(s => favSubjectIds.has(s.id));
  }
  return all.filter(s => s.type === state.activeFilter);
}

// ---------- inspector: kind list -------------------------------------------

function renderKindList() {
  const ul = $("#kind-list");
  ul.innerHTML = "";

  const allCount = state.catalog.subjects.length;
  const favCount = new Set(state.images.filter(i => i.favorite).map(i => i.subjectId)).size;

  const items = [
    { key: "all", label: "All", count: allCount },
  ];
  for (const kindKey of Object.keys(state.catalog.kinds || {})) {
    const kindCount = state.catalog.subjects.filter(s => s.type === kindKey).length;
    items.push({ key: kindKey, label: prettyKind(kindKey), count: kindCount });
  }
  items.push({ key: "favorites", label: "Favorites", count: favCount, accent: true });

  for (const item of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.dataset.key = item.key;
    if (item.key === state.activeFilter) btn.classList.add("active");
    btn.innerHTML = `<span>${escapeHtml(item.label)}</span><span class="count">${item.count}</span>`;
    btn.addEventListener("click", () => setActiveFilter(item.key));
    li.appendChild(btn);
    ul.appendChild(li);
  }

  $("#filter-count").textContent = `${subjectsForActiveFilter().length} of ${allCount}`;
}

const KIND_LABELS = {
  player: "Player",
  enemy: "Enemies",
  weapon: "Weapons",
  option: "Options",
  augment: "Augments",
  secondary_weapon: "Bombs",
};
function prettyKind(k) {
  return KIND_LABELS[k] ?? (k.charAt(0).toUpperCase() + k.slice(1));
}

function setActiveFilter(key) {
  state.activeFilter = key;
  pushUrlState();
  renderKindList();
  renderActivePreamble();
  renderCanvas();
}

// ---------- deep-linkable URL state ---------------------------------------
// View + filter are reflected as `?view=pipeline&filter=option` so the page
// is bookmarkable and shareable. Back/forward navigation works via popstate.
// We omit defaults from the URL to keep the bare `/` clean.

function parseUrlState() {
  const p = new URLSearchParams(location.search);
  const rawView = p.get("view");
  const rawFilter = p.get("filter");
  const view = (rawView === "pipeline") ? "pipeline" : "gallery";
  const validFilter =
    rawFilter === "all" || rawFilter === "favorites" || (rawFilter && state.catalog?.kinds?.[rawFilter]);
  return { view, filter: validFilter ? rawFilter : "all" };
}

function pushUrlState({ replace = false } = {}) {
  const p = new URLSearchParams();
  if (state.activeView !== "gallery") p.set("view", state.activeView);
  if (state.activeFilter !== "all") p.set("filter", state.activeFilter);
  const qs = p.toString();
  const target = qs ? `${location.pathname}?${qs}` : location.pathname;
  // Avoid spamming history with no-op entries (e.g. clicking the already-active tab).
  if (location.pathname + location.search === target) return;
  if (replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
}

function applyUrlToState() {
  const { view, filter } = parseUrlState();
  state.activeView = view;
  state.activeFilter = filter;
  // Sync visual selection state in the inspector + view switch.
  $$("#view-switch button").forEach(b => b.classList.toggle("active", b.dataset.view === state.activeView));
  renderKindList();
  renderActivePreamble();
  renderCanvas();
}

window.addEventListener("popstate", () => applyUrlToState());

// ---------- inspector: prompt editor ---------------------------------------

function renderActivePreamble() {
  const ta = $("#active-preamble");
  const sourceEl = $("#active-prompt-source");
  const saveBtn = $("#save-preamble");
  const resetBtn = $("#reset-preamble");

  const resolved = resolveActivePreamble();
  if (!resolved) {
    ta.value = "";
    ta.disabled = true;
    ta.placeholder = "Pick a specific kind in the filter list to edit its preamble.";
    sourceEl.textContent = "— pick a kind";
    saveBtn.disabled = true;
    resetBtn.disabled = true;
    return;
  }
  ta.disabled = false;
  ta.placeholder = "";
  ta.value = resolved.value;
  sourceEl.textContent = resolved.source;
  saveBtn.disabled = false;
  resetBtn.disabled = false;
}

function bindPromptEditor() {
  $("#save-preamble").addEventListener("click", async () => {
    const resolved = resolveActivePreamble();
    if (!resolved) return;
    const k = resolved.kind;
    const val = $("#active-preamble").value;
    const next = { ...state.settings };
    next.kind_preambles = { ...(next.kind_preambles || {}) };
    if (val.trim()) next.kind_preambles[k] = val;
    else delete next.kind_preambles[k];
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify(next) });
      state.settings = next;
      toast(`Saved ${k} preamble`);
      renderActivePreamble();
    } catch (e) { toast(e.message, "error"); }
  });

  $("#reset-preamble").addEventListener("click", async () => {
    const resolved = resolveActivePreamble();
    if (!resolved) return;
    const k = resolved.kind;
    const next = { ...state.settings };
    next.kind_preambles = { ...(next.kind_preambles || {}) };
    delete next.kind_preambles[k];
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify(next) });
      state.settings = next;
      toast(`Reset ${k} preamble to catalog`);
      renderActivePreamble();
    } catch (e) { toast(e.message, "error"); }
  });
}

// ---------- inspector: scalar settings -------------------------------------

function bindSettings() {
  const modelEl = $("#model");
  const modelCustomEl = $("#model-custom");
  const widthEl = $("#width");
  const heightEl = $("#height");
  const stepsEl = $("#steps");
  const countEl = $("#count");
  const meshModelEl = $("#mesh-model");
  const viewsModelEl = $("#views-model");
  const remeshModelEl = $("#remesh-model");
  const remeshTopologyEl = $("#remesh-topology");
  const remeshDensityEl = $("#remesh-density");
  // Meshy v6 specific knobs
  const meshyOptsEl = $("#meshy-options");
  const meshyPolycountEl = $("#meshy-polycount");
  const meshyTopologyEl = $("#meshy-topology");
  const meshyPoseEl = $("#meshy-pose");
  const meshySymmetryEl = $("#meshy-symmetry");
  const meshyPbrEl = $("#meshy-pbr");
  const meshyRemeshEl = $("#meshy-remesh");
  const styleStrengthEl = $("#style-strength");

  widthEl.value = state.settings.width;
  heightEl.value = state.settings.height;
  stepsEl.value = state.settings.steps;
  countEl.value = state.settings.count;
  styleStrengthEl.value = state.settings.styleStrength ?? 0.5;
  meshModelEl.value = state.settings.meshModel ?? "fal-ai/trellis";
  viewsModelEl.value = state.settings.viewsModel ?? "google/nano-banana-pro";
  remeshModelEl.value = state.settings.remeshModel ?? "fal-ai/hunyuan-3d/v3.1/smart-topology";
  remeshTopologyEl.value = state.settings.remeshTopology ?? "triangle";
  remeshDensityEl.value = state.settings.remeshDensity ?? "medium";

  // Hydrate Meshy v6 options from saved settings (with sensible defaults).
  const meshy = state.settings.meshyOptions ?? {};
  meshyPolycountEl.value = meshy.target_polycount ?? 30000;
  meshyTopologyEl.value = meshy.topology ?? "triangle";
  meshyPoseEl.value = meshy.pose_mode ?? "";
  meshySymmetryEl.value = meshy.symmetry_mode ?? "auto";
  meshyPbrEl.checked = meshy.enable_pbr ?? true;
  meshyRemeshEl.checked = meshy.should_remesh ?? true;
  // Show/hide block based on selected mesh model.
  const syncMeshyVisibility = () => {
    meshyOptsEl.classList.toggle("hidden", meshModelEl.value !== "fal-ai/meshy/v6/image-to-3d");
  };
  syncMeshyVisibility();
  meshModelEl.addEventListener("change", syncMeshyVisibility);

  const optionValues = Array.from(modelEl.querySelectorAll("option")).map(o => o.value);
  if (optionValues.includes(state.settings.model)) {
    modelEl.value = state.settings.model;
  } else {
    modelEl.value = "__custom__";
    modelCustomEl.value = state.settings.model;
    modelCustomEl.classList.remove("hidden");
  }
  modelEl.addEventListener("change", () => {
    modelCustomEl.classList.toggle("hidden", modelEl.value !== "__custom__");
  });

  $("#save-settings").addEventListener("click", async () => {
    const next = {
      ...state.settings,
      model: modelEl.value === "__custom__" ? modelCustomEl.value.trim() : modelEl.value,
      width: parseInt(widthEl.value, 10),
      height: parseInt(heightEl.value, 10),
      steps: parseInt(stepsEl.value, 10),
      count: parseInt(countEl.value, 10),
      styleStrength: parseFloat(styleStrengthEl.value),
      meshModel: meshModelEl.value,
      viewsModel: viewsModelEl.value,
      remeshModel: remeshModelEl.value,
      remeshTopology: remeshTopologyEl.value,
      remeshDensity: remeshDensityEl.value,
      meshyOptions: {
        target_polycount: parseInt(meshyPolycountEl.value, 10) || 30000,
        topology: meshyTopologyEl.value,
        pose_mode: meshyPoseEl.value,
        symmetry_mode: meshySymmetryEl.value,
        enable_pbr: meshyPbrEl.checked,
        should_remesh: meshyRemeshEl.checked,
      },
    };
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify(next) });
      state.settings = next;
      toast("Settings saved");
    } catch (e) { toast(e.message, "error"); }
  });

  $("#reset-settings").addEventListener("click", async () => {
    if (!confirm("Reset per-kind preambles + model + dimensions + style strength to catalog defaults?")) return;
    const defaults = {
      preamble: state.catalog.settings.preamble,
      kind_preambles: {},
      model: "bfl/flux-1-dev",
      width: 1024,
      height: 1024,
      steps: 28,
      count: 2,
      styleStrength: 0.7,
      meshModel: "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d",
      viewsModel: "google/nano-banana-pro",
      remeshModel: "fal-ai/hunyuan-3d/v3.1/smart-topology",
      remeshTopology: "triangle",
      remeshDensity: "medium",
      meshyOptions: {
        target_polycount: 30000,
        topology: "triangle",
        pose_mode: "",
        symmetry_mode: "auto",
        enable_pbr: true,
        should_remesh: true,
      },
    };
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify(defaults) });
      state.settings = defaults;
      modelEl.value = defaults.model;
      modelCustomEl.classList.add("hidden");
      widthEl.value = defaults.width;
      heightEl.value = defaults.height;
      stepsEl.value = defaults.steps;
      countEl.value = defaults.count;
      styleStrengthEl.value = defaults.styleStrength;
      meshModelEl.value = defaults.meshModel;
      viewsModelEl.value = defaults.viewsModel;
      remeshModelEl.value = defaults.remeshModel;
      remeshTopologyEl.value = defaults.remeshTopology;
      remeshDensityEl.value = defaults.remeshDensity;
      meshyPolycountEl.value = defaults.meshyOptions.target_polycount;
      meshyTopologyEl.value = defaults.meshyOptions.topology;
      meshyPoseEl.value = defaults.meshyOptions.pose_mode;
      meshySymmetryEl.value = defaults.meshyOptions.symmetry_mode;
      meshyPbrEl.checked = defaults.meshyOptions.enable_pbr;
      meshyRemeshEl.checked = defaults.meshyOptions.should_remesh;
      renderActivePreamble();
      toast("Reset to catalog defaults");
      renderCanvas();
    } catch (e) { toast(e.message, "error"); }
  });
}

// ---------- header status --------------------------------------------------

function activeJobs() {
  return state.jobs.filter(j => j.status === "queued" || j.status === "processing");
}

function renderHeaderStatus() {
  const trigger = $("#jobs-trigger");
  const label = $("#jobs-trigger-label");
  const pending = activeJobs().length;
  if (pending > 0) {
    trigger.classList.add("has-active");
    trigger.classList.remove("idle");
    label.textContent = `${pending} in flight`;
  } else {
    trigger.classList.remove("has-active");
    trigger.classList.add("idle");
    label.textContent = "idle";
  }
  // If popover is open, refresh its contents.
  if (!$("#jobs-popover").classList.contains("hidden")) renderJobsPopover();
}

function renderJobsPopover() {
  const list = $("#jobs-popover-list");
  const count = $("#jobs-popover-count");
  list.innerHTML = "";
  const jobs = activeJobs();
  count.textContent = String(jobs.length);

  if (jobs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "jobs-popover-empty";
    empty.textContent = "no jobs in flight";
    list.appendChild(empty);
    return;
  }

  const subjectsById = new Map(state.catalog.subjects.map(s => [s.id, s]));
  jobs.sort((a, b) => a.createdAt - b.createdAt);
  for (const job of jobs) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const subject = job.subjectId ? subjectsById.get(job.subjectId) : null;
    const name = subject ? subject.name : (job.subjectId ?? "(unknown)");
    const kindLabel = job.kind === "view"
      ? `view · ${VIEW_LABELS[job.view] || job.view}`
      : job.kind;
    btn.innerHTML = `
      <span class="jobs-popover-kind">${escapeHtml(kindLabel)}</span>
      <span class="jobs-popover-name">${escapeHtml(name)}</span>
      <span class="jobs-popover-progress">${escapeHtml(job.progress || job.status)}</span>
    `;
    btn.addEventListener("click", () => {
      closeJobsPopover();
      scrollToJob(job);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function openJobsPopover() {
  const pop = $("#jobs-popover");
  pop.classList.remove("hidden");
  $("#jobs-trigger").setAttribute("aria-expanded", "true");
  renderJobsPopover();
}
function closeJobsPopover() {
  $("#jobs-popover").classList.add("hidden");
  $("#jobs-trigger").setAttribute("aria-expanded", "false");
}
function bindJobsPopover() {
  $("#jobs-trigger").addEventListener("click", (e) => {
    e.stopPropagation();
    if ($("#jobs-popover").classList.contains("hidden")) openJobsPopover();
    else closeJobsPopover();
  });
  document.addEventListener("click", (e) => {
    if ($("#jobs-popover").classList.contains("hidden")) return;
    if (e.target.closest("#jobs-popover") || e.target.closest("#jobs-trigger")) return;
    closeJobsPopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeJobsPopover();
  });
}

function scrollToJob(job) {
  // Switch to the right view and filter so the placeholder is on screen.
  const targetView = job.kind === "mesh" || job.kind === "view" ? "pipeline" : "gallery";
  if (state.activeView !== targetView) {
    state.activeView = targetView;
    $$("#view-switch button").forEach(b => b.classList.toggle("active", b.dataset.view === targetView));
  }
  // For a kind-job, switch the filter to the subject's kind so the block is visible
  // (handles the case where the user was on a different filter than the subject).
  if (job.subjectId) {
    const subject = state.catalog.subjects.find(s => s.id === job.subjectId);
    if (subject && state.activeFilter !== "all" && state.activeFilter !== subject.type && state.activeFilter !== "favorites") {
      state.activeFilter = subject.type;
      renderKindList();
      renderActivePreamble();
    }
  }
  renderCanvas();
  // Scroll after the canvas renders.
  requestAnimationFrame(() => {
    let target;
    if (job.kind === "mesh" || job.kind === "view") {
      target = document.querySelector(`.pipe-row[data-image-id="${job.parentImageId}"]`);
    } else {
      target = document.querySelector(`.subject-block[data-subject-id="${job.subjectId}"]`);
    }
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("scrolled-to");
      setTimeout(() => target.classList.remove("scrolled-to"), 1700);
    }
  });
}

// ---------- theme toggle ---------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("#theme-toggle").textContent = theme === "light" ? "LIGHT" : "DARK";
}
function bindThemeToggle() {
  const stored = localStorage.getItem("moodboard.theme");
  const initial = stored ?? "dark";
  applyTheme(initial);
  $("#theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    const next = cur === "dark" ? "light" : "dark";
    localStorage.setItem("moodboard.theme", next);
    applyTheme(next);
  });
}

// ---------- view switch (Gallery / Pipeline) ------------------------------

function bindViewSwitch() {
  $$("#view-switch button").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("#view-switch button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeView = btn.dataset.view;
      pushUrlState();
      renderCanvas();
    });
  });
}

// ---------- canvas ---------------------------------------------------------

function renderCanvas() {
  const canvas = $("#grid");
  // Preserve scrollY across the rebuild. innerHTML="" briefly shrinks the
  // page below current scroll, which makes the browser snap to top — that's
  // the "page jumps to the top whenever an image finishes" symptom. Saving
  // and restoring is cheap and invisible.
  const savedScrollY = window.scrollY;
  canvas.innerHTML = "";
  if (state.activeView === "pipeline") {
    renderPipeline(canvas);
  } else {
    renderGallery(canvas);
  }
  if (document.querySelector(".job-age")) ensureAgeTicker();
  if (window.scrollY !== savedScrollY) {
    window.scrollTo({ top: savedScrollY, behavior: "instant" });
  }
}

function renderGallery(canvas) {
  const subjects = subjectsForActiveFilter();
  if (subjects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.activeFilter === "favorites"
      ? "No favorites yet. Heart a render in any filter to add it here."
      : `No subjects match the filter '${state.activeFilter}'.`;
    canvas.appendChild(empty);
    return;
  }

  const tpl = $("#subject-template");
  for (const subject of subjects) {
    const node = tpl.content.cloneNode(true);
    const block = $(".subject-block", node);
    block.dataset.subjectId = subject.id;

    $(".subject-name", block).textContent = subject.name;
    const tag = $(".subject-tag", block);
    tag.innerHTML = `<span>${subject.type}</span> · <span>${subject.id}</span>`;
    if (subject.source) {
      const link = document.createElement("a");
      link.href = `vscode://file/${encodeURI(subject.source)}`;
      link.textContent = subject.source;
      link.title = "open in VS Code";
      tag.appendChild(document.createTextNode(" · "));
      tag.appendChild(link);
    }
    $(".subject-desc", block).textContent = subject.description;

    const sprite = $(".subject-sprite", block);
    if (subject.sprite) {
      sprite.src = subject.sprite;
      sprite.alt = `current sprite for ${subject.name}`;
    } else {
      sprite.classList.add("missing");
      sprite.alt = "no sprite";
      sprite.removeAttribute("src");
    }

    const refToggle = $(".card-use-ref", block);
    if (!subject.sprite) refToggle.disabled = true;
    const countInput = $(".count-input", block);
    countInput.value = state.settings.count ?? 2;

    $(".generate-btn", block).addEventListener("click", () => {
      generate(subject, parseInt(countInput.value, 10) || 1, block, refToggle.checked && !!subject.sprite);
    });

    // Per-subject prompt override (collapsed)
    const overrides = $(".prompt-overrides", block);
    const promptText = $(".prompt-text", block);
    promptText.value = state.overrides[subject.id] ?? subject.description;
    $(".subject-prompt-btn", block).addEventListener("click", (e) => {
      overrides.classList.toggle("open");
      e.target.textContent = overrides.classList.contains("open")
        ? "▾ per-subject prompt override"
        : "▸ per-subject prompt override";
    });
    $(".save-prompt", block).addEventListener("click", async () => {
      try {
        await api("/api/prompt", {
          method: "POST",
          body: JSON.stringify({ subjectId: subject.id, prompt: promptText.value }),
        });
        state.overrides[subject.id] = promptText.value;
        toast(`Saved override for ${subject.name}`);
      } catch (e) { toast(e.message, "error"); }
    });
    $(".reset-prompt", block).addEventListener("click", async () => {
      try {
        await api("/api/prompt", {
          method: "POST",
          body: JSON.stringify({ subjectId: subject.id, prompt: "" }),
        });
        delete state.overrides[subject.id];
        promptText.value = subject.description;
        toast(`Reset prompt for ${subject.name}`);
      } catch (e) { toast(e.message, "error"); }
    });

    // Gallery
    const gallery = $(".gallery", block);
    for (const job of jobsForSubject(subject.id, "image")) {
      gallery.appendChild(buildJobThumb(job));
    }
    let imgs = primaryImagesForSubject(subject.id);
    if (state.activeFilter === "favorites") imgs = imgs.filter(i => i.favorite);
    for (const img of imgs) gallery.appendChild(buildThumb(img));

    canvas.appendChild(node);
  }
}

function renderPipeline(canvas) {
  let favorites = state.images.filter(i => i.favorite && !i.parentImageId);
  // Honor the kind filter as a secondary filter inside Pipeline view.
  if (state.activeFilter !== "all" && state.activeFilter !== "favorites") {
    const subjectsByKind = new Set(state.catalog.subjects.filter(s => s.type === state.activeFilter).map(s => s.id));
    favorites = favorites.filter(f => subjectsByKind.has(f.subjectId));
  }
  if (favorites.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No favorites in scope. Heart some renders in Gallery view first — they graduate here for multi-view + 3D.";
    canvas.appendChild(empty);
    return;
  }
  favorites.sort((a, b) => b.createdAt - a.createdAt);

  const tpl = $("#pipeline-row-template");
  const subjectsById = new Map(state.catalog.subjects.map(s => [s.id, s]));
  for (const fav of favorites) {
    const node = tpl.content.cloneNode(true);
    const row = $(".pipe-row", node);
    row.dataset.imageId = fav.id;
    const subject = subjectsById.get(fav.subjectId);

    $(".pipe-source", row).src = `/img/${fav.r2Key}`;
    $(".pipe-source-meta", row).textContent = `${fav.subjectId} · ${fav.model} · ${fav.width}×${fav.height}`;
    $(".pipe-name", row).textContent = subject ? subject.name : fav.subjectId;

    const viewsRow = $(".pipe-views-row", row);
    renderPipelineViewsRow(viewsRow, fav);

    const meshRow = $(".pipe-mesh-row", row);
    renderPipelineMeshRow(meshRow, fav);

    $(".pipe-views-btn", row).addEventListener("click", () => generateAllViews(fav, viewsRow));
    $(".pipe-mesh-btn", row).addEventListener("click", () => {
      const n = parseInt($(".pipe-mesh-count", row).value, 10) || 1;
      generateMesh(fav, meshRow, n);
    });

    canvas.appendChild(node);
  }
}

const VIEW_ORDER = ["front", "three_quarter", "back", "top"];
const VIEW_LABELS = { front: "Front", three_quarter: "3/4", back: "Back", top: "Top" };

function renderPipelineViewsRow(row, parentImage) {
  row.innerHTML = "";
  const views = viewsForParent(parentImage.id);
  for (const viewName of VIEW_ORDER) {
    const slot = document.createElement("div");
    slot.className = "view-slot";
    slot.dataset.view = viewName;
    const label = document.createElement("div");
    label.className = "view-label";
    label.textContent = VIEW_LABELS[viewName];
    slot.appendChild(label);
    const existing = views.find(v => v.view === viewName);
    const pendingJob = jobForView(parentImage.id, viewName);
    if (existing) slot.appendChild(buildThumb(existing));
    else if (pendingJob) slot.appendChild(buildJobThumb(pendingJob));
    else {
      const stub = document.createElement("button");
      stub.className = "view-stub";
      stub.title = `Generate ${VIEW_LABELS[viewName]} view`;
      stub.textContent = "+";
      stub.addEventListener("click", () => generateView(parentImage, viewName));
      slot.appendChild(stub);
    }
    row.appendChild(slot);
  }
}

function renderPipelineMeshRow(row, parentImage) {
  row.innerHTML = "";
  const pendingMeshJobs = jobsForMeshParent(parentImage.id);
  for (const job of pendingMeshJobs) {
    row.appendChild(buildMeshPendingBanner(job, "3D in flight"));
  }
  const meshes = meshesForImage(parentImage.id);
  if (meshes.length === 0 && pendingMeshJobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mesh-empty";
    empty.textContent = "no mesh yet";
    row.appendChild(empty);
    return;
  }
  meshes.sort((a, b) => b.createdAt - a.createdAt);
  for (const mesh of meshes) {
    row.appendChild(buildMeshCard(mesh, () => renderPipelineMeshRow(row, parentImage)));
    // Render remesh children (and any in-flight remesh job) immediately under the parent.
    const children = remeshChildrenOf(mesh.id).sort((a, b) => b.createdAt - a.createdAt);
    for (const child of children) {
      const childCard = buildMeshCard(child, () => renderPipelineMeshRow(row, parentImage));
      childCard.classList.add("mesh-card-child");
      row.appendChild(childCard);
    }
    const pendingRemesh = remeshJobFor(mesh.id);
    if (pendingRemesh) {
      const banner = buildMeshPendingBanner(pendingRemesh, "smart-topology in flight");
      banner.classList.add("mesh-card-child");
      row.appendChild(banner);
    }
  }
}

function buildMeshPendingBanner(job, label) {
  const banner = document.createElement("div");
  banner.className = "mesh-pending";
  banner.dataset.jobId = job.id;
  const isLocal = isLocalJob(job);
  const cancelTitle = isLocal
    ? "Uploading to fal — wait until the submit completes before cancelling, or fal will keep the orphan."
    : "Tell fal to cancel and drop this job. Existing meshes stay. Credits used up to now are gone.";
  banner.innerHTML = `
    <strong>${escapeHtml(label)}</strong>
    <span class="fal-status fal-${falStatusClass(job.falStatus)}" data-fal-status>${escapeHtml(falStatusLabel(job))}</span>
    <span class="mesh-progress">${escapeHtml(job.progress || job.status)}</span>
    <span class="job-age" data-updated-at="${job.updatedAt}">${ageHint(jobAgeSeconds(job))}</span>
    <button class="mesh-pending-cancel" type="button" ${isLocal ? "disabled" : ""} title="${escapeHtml(cancelTitle)}">✕ Cancel</button>
  `;
  banner.querySelector(".mesh-pending-cancel").addEventListener("click", (e) => {
    e.stopPropagation();
    cancelJob(job, () => banner.remove());
  });
  return banner;
}

function isLocalJob(job) {
  return typeof job?.id === "string" && job.id.startsWith("local-");
}

// Two distinct signals, distinct UI:
//   falStatus  → what fal's queue says (upstream truth — IN_QUEUE / IN_PROGRESS / etc)
//   updatedAt  → when our worker last polled fal (worker liveness)
// Both healthy = job actually progressing. fal=IN_PROGRESS but updatedAt>30s old =
// worker likely died, fal might still be running. fal=IN_QUEUE + worker alive =
// fal hasn't started yet, just waiting in queue.
function falStatusLabel(job) {
  if (!job.falStatus) return "no fal status";
  if (job.falStatus === "IN_QUEUE" && job.falQueuePosition != null) {
    return `fal: in_queue (pos ${job.falQueuePosition})`;
  }
  return `fal: ${job.falStatus.toLowerCase()}`;
}
function falStatusClass(falStatus) {
  if (!falStatus) return "unknown";
  if (falStatus === "IN_QUEUE") return "queued";
  if (falStatus === "IN_PROGRESS") return "running";
  if (falStatus === "COMPLETED") return "done";
  return "bad"; // FAILED, ERROR, CANCELLED
}

function buildMeshCard(mesh, rerender) {
  const card = document.createElement("div");
  card.className = "mesh-card";
  card.dataset.meshId = mesh.id;
  const viewer = document.createElement("mesh-preview");
  viewer.setAttribute("src", `/mesh/${mesh.r2Key}`);
  card.appendChild(viewer);

  const foot = document.createElement("div");
  foot.className = "mesh-foot";
  const label = document.createElement("span");
  const isRemeshed = !!mesh.parentMeshId;
  label.textContent = `${isRemeshed ? "↳ " : ""}${mesh.model} · ${mesh.format}`;
  foot.appendChild(label);

  const actions = document.createElement("span");
  actions.className = "mesh-foot-actions";
  const theatreBtn = document.createElement("button");
  theatreBtn.className = "mesh-theatre-open";
  theatreBtn.textContent = "⛶ theater";
  theatreBtn.title = "Open this mesh full-viewport for a closer look";
  theatreBtn.addEventListener("click", () => openMeshTheatre(mesh));
  actions.appendChild(theatreBtn);
  if (!isRemeshed) {
    const remeshBtn = document.createElement("button");
    remeshBtn.className = "tiny-link";
    remeshBtn.textContent = "smart-topology";
    remeshBtn.title = "Run Hunyuan 3D smart-topology to clean up this mesh";
    remeshBtn.addEventListener("click", () => generateRemesh(mesh, rerender));
    actions.appendChild(remeshBtn);
  }
  const del = document.createElement("button");
  del.className = "tiny-link";
  del.style.color = "var(--bad)";
  del.textContent = "delete";
  del.addEventListener("click", async () => {
    if (!confirm(isRemeshed ? "Delete this remeshed mesh?" : "Delete this mesh? Any smart-topology children will remain.")) return;
    try {
      await api(`/api/mesh/${mesh.id}`, { method: "DELETE" });
      state.meshes = state.meshes.filter(m => m.id !== mesh.id);
      rerender();
    } catch (e) { toast(e.message, "error"); }
  });
  actions.appendChild(del);
  foot.appendChild(actions);
  card.appendChild(foot);
  return card;
}

// ---------- thumbs ---------------------------------------------------------

function buildThumb(img) {
  const tpl = $("#thumb-template");
  const node = tpl.content.cloneNode(true);
  const thumb = $(".thumb", node);
  thumb.dataset.id = img.id;
  if (img.favorite) thumb.classList.add("is-favorite");

  const imgEl = $(".thumb-img", thumb);
  imgEl.src = `/img/${img.r2Key}`;
  imgEl.alt = img.prompt.slice(0, 80);

  const badge = $(".thumb-badge", thumb);
  if (img.view) badge.textContent = VIEW_LABELS[img.view] || img.view;
  else if (img.parentImageId) badge.textContent = "view";
  else badge.remove();

  thumb.addEventListener("click", (e) => {
    if (e.target.closest(".thumb-overlay-actions")) return;
    openLightbox(img);
  });

  $(".fav", thumb).addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const next = !img.favorite;
      await api("/api/favorite", {
        method: "POST",
        body: JSON.stringify({ id: img.id, value: next }),
      });
      img.favorite = next;
      thumb.classList.toggle("is-favorite", next);
      // Favorites count in inspector — refresh
      renderKindList();
    } catch (err) { toast(err.message, "error"); }
  });

  const delBtn = $(".del", thumb);
  let armTimer = null;
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!delBtn.classList.contains("armed")) {
      delBtn.classList.add("armed");
      delBtn.textContent = "✕ confirm";
      armTimer = setTimeout(() => {
        delBtn.classList.remove("armed");
        delBtn.textContent = "×";
        armTimer = null;
      }, 2500);
      return;
    }
    clearTimeout(armTimer);
    try {
      await api(`/api/image/${img.id}`, { method: "DELETE" });
      state.images = state.images.filter(i => i.id !== img.id && i.parentImageId !== img.id);
      // Re-render canvas (not just thumb.remove()) so a deleted derivative-view
      // slot in Pipeline gets its "+" stub back, and so cascade-deleted views
      // disappear from the pipeline rows. Cheaper than tracking which DOM
      // nodes need surgery.
      renderCanvas();
      renderKindList();
    } catch (err) {
      toast(err.message, "error");
      delBtn.classList.remove("armed");
      delBtn.textContent = "×";
    }
  });

  return node;
}

function buildJobThumb(job) {
  const div = document.createElement("div");
  div.className = "thumb is-pending";
  div.dataset.jobId = job.id;
  div.innerHTML = `
    <div class="job-progress-wrap">
      <div class="job-spinner"></div>
      <div class="job-progress">${escapeHtml(job.progress || job.status)}</div>
      <div class="job-age" data-updated-at="${job.updatedAt}">${ageHint(jobAgeSeconds(job))}</div>
    </div>
    <button class="job-cancel" title="Cancel locally (Krea/fal charge already incurred if started)">×</button>
  `;
  div.querySelector(".job-cancel").addEventListener("click", (e) => {
    e.stopPropagation();
    cancelJob(job, () => div.remove());
  });
  return div;
}

// Server-side cancel — fires fal's cancel URL when applicable, marks the
// JobMeta failed with "Cancelled by user", drops from job-index. The local
// poller stops. Charges already incurred up to the cancel point are gone.
// Optimistic placeholders (id="local-*") aren't on the server yet, so we
// just drop them locally without a server roundtrip.
async function cancelJob(job, removeDom) {
  stopPoller(job.id);
  if (isLocalJob(job)) {
    toast("Cancelled local placeholder. (If the upload was already in flight, you may still get a stray job — just delete it.)");
  } else {
    try {
      const res = await fetch(`/api/job/${job.id}/cancel`, { method: "POST" });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(body.cancelHit ? "Cancelled" : "Cancel sent (best-effort)");
      } else {
        toast(`Cancel returned ${res.status}`, "error");
      }
    } catch (e) {
      toast(`Cancel failed: ${e.message}`, "error");
    }
  }
  state.jobs = state.jobs.filter(j => j.id !== job.id);
  if (typeof removeDom === "function") removeDom();
  renderHeaderStatus();
  if (state.activeView === "pipeline") renderCanvas();
}

// ---------- job polling ----------------------------------------------------

function ensurePoller(job) {
  if (state.pollers.has(job.id)) return;
  const ctrl = new AbortController();
  state.pollers.set(job.id, ctrl);
  pollJobLoop(job.id, ctrl.signal).catch(err => console.error("[poll]", err));
}

async function pollJobLoop(jobId, signal) {
  while (!signal.aborted) {
    await sleep(2000);
    if (signal.aborted) return;
    let updated;
    try {
      updated = await api(`/api/job/${jobId}`);
    } catch (err) {
      console.warn("[poll]", jobId, err.message);
      stopPoller(jobId);
      return;
    }
    onJobUpdate(updated);
    if (updated.status === "completed" || updated.status === "failed") {
      stopPoller(jobId);
      return;
    }
  }
}
function stopPoller(jobId) {
  const ctrl = state.pollers.get(jobId);
  if (ctrl) { ctrl.abort(); state.pollers.delete(jobId); }
}

function onJobUpdate(updated) {
  const idx = state.jobs.findIndex(j => j.id === updated.id);
  if (idx >= 0) state.jobs[idx] = updated;
  else state.jobs.push(updated);

  // Live-update progress text without re-rendering everything.
  const placeholder = document.querySelector(`[data-job-id="${updated.id}"] .job-progress`);
  if (placeholder) placeholder.textContent = updated.progress || updated.status;
  const meshPending = document.querySelector(`.mesh-pending[data-job-id="${updated.id}"] .mesh-progress`);
  if (meshPending) meshPending.textContent = updated.progress || updated.status;
  // Refresh the age display from the JUST-polled updatedAt. Critical: we
  // compute the age from the actual timestamp (which may still be stale if
  // the worker hasn't written new progress between our polls), NOT a
  // hardcoded "0s ago." Otherwise a poll that returns no new progress will
  // flash "fresh" for one tick before the 1Hz ticker corrects to "200s ago"
  // — a flickering red/gray race condition.
  const ageSec = Math.max(0, Math.round((Date.now() - updated.updatedAt) / 1000));
  const stale = ageStaleness(ageSec);
  for (const el of document.querySelectorAll(`[data-job-id="${updated.id}"] .job-age`)) {
    el.dataset.updatedAt = String(updated.updatedAt);
    el.textContent = ageHint(ageSec);
    el.classList.remove("fresh", "stale", "dead");
    el.classList.add(stale);
  }
  // Refresh the fal-status pill — that's the upstream-truth signal, distinct
  // from worker liveness above.
  for (const el of document.querySelectorAll(`[data-job-id="${updated.id}"] [data-fal-status]`)) {
    el.textContent = falStatusLabel(updated);
    el.className = `fal-status fal-${falStatusClass(updated.falStatus)}`;
    el.dataset.falStatus = ""; // keep the marker for re-querying
  }

  if (updated.status === "completed") {
    if ((updated.kind === "mesh" || updated.kind === "remesh") && updated.result) state.meshes.push(updated.result);
    else if (updated.result) state.images.push(updated.result);
    state.jobs = state.jobs.filter(j => j.id !== updated.id);
    surgicalSwapJobIntoResult(updated);
    renderKindList();
    fetch(`/api/job/${updated.id}`, { method: "DELETE" }).catch(() => {});
  } else if (updated.status === "failed") {
    toast(`${updated.kind} job failed: ${updated.error}`, "error");
    state.jobs = state.jobs.filter(j => j.id !== updated.id);
    surgicalRemoveJobPlaceholder(updated);
    fetch(`/api/job/${updated.id}`, { method: "DELETE" }).catch(() => {});
  }
  renderHeaderStatus();
}

// Surgical replacement when a job completes — patch only the affected DOM
// instead of nuking #grid (which costs scroll position). For each job kind:
//   image  → replace pending-thumb in the subject's gallery with a real thumb
//   view   → re-render just the parent's pipe-views-row
//   mesh / remesh → re-render just the parent's pipe-mesh-row
// Falls back to a full renderCanvas() if the targeted DOM isn't present
// (user might be on a different filter / view).
function surgicalSwapJobIntoResult(updated) {
  if (updated.kind === "image" && updated.result) {
    const placeholder = document.querySelector(`.thumb.is-pending[data-job-id="${updated.id}"]`);
    if (placeholder) {
      placeholder.replaceWith(buildThumb(updated.result));
      return;
    }
  } else if (updated.kind === "view" && updated.result && updated.parentImageId) {
    const parentImage = state.images.find(i => i.id === updated.parentImageId);
    const row = document.querySelector(`.pipe-row[data-image-id="${updated.parentImageId}"]`);
    if (parentImage && row) {
      const viewsRow = $(".pipe-views-row", row);
      if (viewsRow) {
        renderPipelineViewsRow(viewsRow, parentImage);
        return;
      }
    }
  } else if (updated.kind === "mesh" && updated.result) {
    const favId = updated.parentImageId;
    const fav = state.images.find(i => i.id === favId);
    const row = document.querySelector(`.pipe-row[data-image-id="${favId}"]`);
    if (fav && row) {
      const meshRow = $(".pipe-mesh-row", row);
      if (meshRow) {
        renderPipelineMeshRow(meshRow, fav);
        return;
      }
    }
  } else if (updated.kind === "remesh" && updated.result) {
    // Find the favorite that originated this lineage by walking up parentMeshId.
    const sourceMesh = state.meshes.find(m => m.id === updated.result.parentMeshId);
    const favId = sourceMesh ? sourceMesh.sourceImageIds[0] : undefined;
    const fav = favId ? state.images.find(i => i.id === favId) : undefined;
    const row = favId ? document.querySelector(`.pipe-row[data-image-id="${favId}"]`) : null;
    if (fav && row) {
      const meshRow = $(".pipe-mesh-row", row);
      if (meshRow) {
        renderPipelineMeshRow(meshRow, fav);
        return;
      }
    }
  }
  // Fallback — only when surgical didn't apply. renderCanvas preserves
  // scroll, so even this path won't jump the page.
  renderCanvas();
}

function surgicalRemoveJobPlaceholder(updated) {
  // Drop any in-DOM placeholder tied to this job id. For view jobs we
  // additionally re-render the views row so the slot reverts to a "+" stub.
  const els = document.querySelectorAll(`[data-job-id="${updated.id}"]`);
  for (const el of els) el.remove();
  if (updated.kind === "view" && updated.parentImageId) {
    const parentImage = state.images.find(i => i.id === updated.parentImageId);
    const row = document.querySelector(`.pipe-row[data-image-id="${updated.parentImageId}"]`);
    if (parentImage && row) {
      const viewsRow = $(".pipe-views-row", row);
      if (viewsRow) renderPipelineViewsRow(viewsRow, parentImage);
    }
  }
}

// ---------- generate handlers ---------------------------------------------

async function generateView(parentImage, view) {
  try {
    const job = await api("/api/views/generate", {
      method: "POST",
      body: JSON.stringify({
        sourceImageId: parentImage.id,
        view,
        model: state.settings.viewsModel || "google/nano-banana-pro",
      }),
    });
    state.jobs.push(job);
    ensurePoller(job);
    renderCanvas();
    renderHeaderStatus();
  } catch (e) {
    toast(`View ${view} failed to start: ${e.message}`, "error");
  }
}

async function generateAllViews(parentImage, _row) {
  const existing = new Set(viewsForParent(parentImage.id).map(v => v.view));
  const pendingViews = new Set(state.jobs.filter(j => j.kind === "view" && j.parentImageId === parentImage.id).map(j => j.view));
  const missing = VIEW_ORDER.filter(v => !existing.has(v) && !pendingViews.has(v));
  if (missing.length === 0) {
    toast("All four views already generated or in flight.");
    return;
  }
  await Promise.allSettled(missing.map(v => generateView(parentImage, v)));
}

async function generateRemesh(mesh, rerender) {
  const model = state.settings.remeshModel ?? "fal-ai/hunyuan-3d/v3.1/smart-topology";
  const topology = state.settings.remeshTopology ?? "triangle";
  const density = state.settings.remeshDensity ?? "medium";
  if (!confirm(`Run ${model} (topology: ${topology}, density: ${density}) on this mesh? Cleans up topology — source mesh stays.`)) return;

  // Optimistic placeholder: appears INSTANTLY so the user has feedback during
  // the encode-and-upload phase (we have to base64 the multi-MB GLB into the
  // submit body, which can take 5-30s before fal even sees it). Replaced by
  // the real JobMeta once the worker's submit returns.
  const local = makeOptimisticJob({
    kind: "remesh",
    progress: "Encoding mesh & uploading to fal…",
    params: { sourceMeshId: mesh.id },
  });
  state.jobs.push(local);
  rerender();
  renderHeaderStatus();

  try {
    const job = await api("/api/mesh/remesh", {
      method: "POST",
      body: JSON.stringify({
        sourceMeshId: mesh.id,
        model,
        polygon_type: topology,
        face_level: density,
      }),
    });
    state.jobs = state.jobs.filter(j => j.id !== local.id);
    state.jobs.push(job);
    ensurePoller(job);
    rerender();
    renderHeaderStatus();
  } catch (e) {
    state.jobs = state.jobs.filter(j => j.id !== local.id);
    rerender();
    toast(`Remesh failed to start: ${e.message}`, "error");
  }
}

// An "optimistic" client-only job — placeholder shown while the worker is
// encoding the source payload to base64 and shipping it to fal (the part of
// the request that happens before any JobMeta exists server-side). Real
// JobMeta replaces it once the submit returns. id starts with "local-" so
// cancelJob and the cancel button know to skip the server roundtrip.
function makeOptimisticJob({ kind, subjectId, parentImageId, progress, params }) {
  const id = `local-${crypto.randomUUID()}`;
  const now = Date.now();
  return {
    id,
    kind,
    status: "processing",
    progress,
    subjectId,
    parentImageId,
    params: params ?? {},
    createdAt: now,
    updatedAt: now,
    falStatus: undefined,
  };
}

async function generateMesh(parentImage, row, count = 1) {
  const n = Math.max(1, Math.min(3, count));
  const inputs = [parentImage.id, ...viewsForParent(parentImage.id).map(v => v.id)];
  const noun = n > 1 ? `${n} 3D meshes` : "a 3D mesh";
  if (!confirm(`Generate ${noun} in parallel from ${inputs.length} image${inputs.length > 1 ? "s" : ""} using ${state.settings.meshModel}? This is the most expensive operation in the tool — each mesh is its own job and stacks as a separate card.`)) return;

  // Same upload-feedback story as remesh: encoding N images as base64 into
  // the submit body takes time. Push optimistic placeholders first so the
  // pipeline row shows "uploading" cards immediately.
  const locals = Array.from({ length: n }, () => makeOptimisticJob({
    kind: "mesh",
    subjectId: parentImage.subjectId,
    parentImageId: parentImage.id,
    progress: `Encoding ${inputs.length} source image${inputs.length > 1 ? "s" : ""} & uploading to fal…`,
  }));
  for (const l of locals) state.jobs.push(l);
  if (state.activeView === "pipeline") renderPipelineMeshRow(row, parentImage);
  renderHeaderStatus();

  // Per-model options. Meshy v6 reads everything in state.settings.meshyOptions;
  // other adapters ignore the options object.
  const options = state.settings.meshModel === "fal-ai/meshy/v6/image-to-3d"
    ? state.settings.meshyOptions ?? {}
    : {};
  await Promise.allSettled(locals.map(local =>
    api("/api/mesh/generate", {
      method: "POST",
      body: JSON.stringify({ sourceImageIds: inputs, model: state.settings.meshModel, options }),
    }).then(job => {
      state.jobs = state.jobs.filter(j => j.id !== local.id);
      state.jobs.push(job);
      ensurePoller(job);
    }).catch(e => {
      state.jobs = state.jobs.filter(j => j.id !== local.id);
      toast(`3D job failed to start: ${e.message}`, "error");
    }),
  ));
  if (state.activeView === "pipeline") renderPipelineMeshRow(row, parentImage);
  renderHeaderStatus();
}

async function generate(subject, n, block, useStyleRef) {
  const promptOverride = $(".prompt-text", block).value;
  if (promptOverride !== (state.overrides[subject.id] ?? subject.description)) {
    state.overrides[subject.id] = promptOverride;
  }
  const fullPrompt = buildPrompt({ ...subject, description: promptOverride });
  const model = state.settings.model;
  const width = state.settings.width;
  const height = state.settings.height;
  const steps = state.settings.steps;
  const styleImageUrl = useStyleRef && subject.sprite
    ? new URL(subject.sprite, location.origin).toString()
    : undefined;
  const styleStrength = state.settings.styleStrength ?? 0.5;
  const STYLE_AWARE = new Set(["bfl/flux-1-dev", "google/nano-banana", "google/nano-banana-pro", "ideogram/ideogram-3"]);
  if (styleImageUrl && !STYLE_AWARE.has(model)) {
    toast(`${model} ignores style refs. Use flux-1-dev / nano-banana(-pro) / ideogram-3 for style transfer.`);
  }

  const tasks = Array.from({ length: n }).map(() =>
    api("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        subjectId: subject.id,
        prompt: fullPrompt,
        model, width, height, steps,
        styleImageUrl, styleStrength,
      }),
    }).then(job => {
      state.jobs.push(job);
      ensurePoller(job);
    }).catch(err => {
      toast(`Generate failed to start: ${err.message}`, "error");
    }),
  );
  await Promise.allSettled(tasks);
  renderCanvas();
  renderHeaderStatus();
}

// ---------- lightbox -------------------------------------------------------

function openLightbox(img) {
  const lb = $("#lightbox");
  $("#lb-img").src = `/img/${img.r2Key}`;
  $("#lb-meta").textContent = `${img.model} · ${img.width}×${img.height} · seed ${img.seed ?? "?"} · ${new Date(img.createdAt).toLocaleString()}`;
  lb.classList.remove("hidden");
}
function bindLightbox() {
  $("#lb-close").addEventListener("click", () => $("#lightbox").classList.add("hidden"));
  $("#lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox") $("#lightbox").classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("#lightbox").classList.add("hidden");
  });
}

// ---------- theater (fullscreen mesh preview) ------------------------------

function openMeshTheatre(mesh) {
  const wrap = $("#mesh-theatre");
  const stage = $("#mesh-theatre-stage");
  const meta = $("#mesh-theatre-meta");
  // Build a fresh mesh-preview each time so opening a different mesh doesn't
  // reuse the previous Three.js scene.
  stage.innerHTML = "";
  const viewer = document.createElement("mesh-preview");
  viewer.setAttribute("src", `/mesh/${mesh.r2Key}`);
  stage.appendChild(viewer);
  meta.textContent = `${mesh.parentMeshId ? "↳ " : ""}${mesh.model} · ${mesh.format} · ${new Date(mesh.createdAt).toLocaleString()}`;
  wrap.classList.remove("hidden");
}
function closeMeshTheatre() {
  const wrap = $("#mesh-theatre");
  wrap.classList.add("hidden");
  // Drop the mesh-preview to free its WebGL context immediately rather than
  // leaving it ticking in the background.
  $("#mesh-theatre-stage").innerHTML = "";
}
function bindMeshTheatre() {
  $("#mesh-theatre-close").addEventListener("click", closeMeshTheatre);
  $("#mesh-theatre").addEventListener("click", (e) => {
    if (e.target.id === "mesh-theatre") closeMeshTheatre();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#mesh-theatre").classList.contains("hidden")) closeMeshTheatre();
  });
}

// ---------- init -----------------------------------------------------------

async function init() {
  state.catalog = await fetch("/catalog.json").then(r => r.json());
  const server = await api("/api/state");
  state.images = server.images || [];
  state.meshes = server.meshes || [];
  state.overrides = server.overrides || {};
  state.jobs = (server.jobs || []).filter(j => j.status !== "completed");
  state.settings = {
    preamble: state.catalog.settings.preamble,
    kind_preambles: {},
    model: "bfl/flux-1-dev",
    width: 1024,
    height: 1024,
    steps: 28,
    count: 2,
    styleStrength: 0.7,
    meshModel: DEFAULT_MESH_MODEL,
    ...(server.settings || {}),
  };
  // Migrate stale slugs from prior Krea-era settings. The worker rejects
  // unknown slugs at runtime; nicer to silently move forward than block.
  if (!KNOWN_MESH_MODELS.has(state.settings.meshModel)) {
    console.warn(`[moodboard] migrating stale meshModel '${state.settings.meshModel}' → '${DEFAULT_MESH_MODEL}'`);
    state.settings.meshModel = DEFAULT_MESH_MODEL;
  }

  // Instrumented: a stale-cache app.js missing the new binds was silently
  // breaking buttons. If "[init] binds done" doesn't show, the browser is
  // running an older copy; hard refresh (Ctrl+Shift+R) or use the cache-bust
  // query string in index.html.
  console.log("[init] starting binds");
  bindThemeToggle();
  bindViewSwitch();
  bindPromptEditor();
  bindSettings();
  bindLightbox();
  bindMeshTheatre();
  bindJobsPopover();
  console.log("[init] binds done");

  // applyUrlToState reads ?view= and ?filter= and renders the canvas. On a
  // bare URL it falls back to gallery + all (the same as our state defaults).
  // This is what makes a refresh on `?view=pipeline&filter=enemy` actually
  // land on Pipeline / Enemy instead of resetting to Gallery / All.
  applyUrlToState();
  renderHeaderStatus();

  for (const job of state.jobs) {
    if (job.status !== "completed" && job.status !== "failed") ensurePoller(job);
  }
}

init().catch(err => {
  toast(`Init failed: ${err.message}`, "error");
  console.error(err);
});
