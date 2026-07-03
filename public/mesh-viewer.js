// <mesh-preview> — Three.js GLB viewer with three display modes:
//   "textured"  — original PBR materials, single render pass
//   "wireframe" — triangle wireframe in light gray on the gray bg
//   "both"      — textured first, then wireframe overlaid via polygon-offset
//                 so the lines sit just in front of the surface without z-fight
// Background is Blender-default gray so it reads as a 3D viewport regardless
// of the page's dark/light theme. Mode buttons live in the bottom-right corner.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const BG_COLOR = 0x393939;            // Blender 4.x viewport-ish
const WIRE_COLOR_SOLID = 0xcfcfcf;    // wireframe-only mode: light gray on dark bg
const WIRE_COLOR_OVERLAY = 0x121212;  // both mode: dark wire on top of textured

const MODES = [
  { key: "textured",  label: "Tex" },
  { key: "wireframe", label: "Wire" },
  { key: "both",      label: "Both" },
];

class MeshPreview extends HTMLElement {
  static get observedAttributes() { return ["src", "mode"]; }

  constructor() {
    super();
    this._mode = "textured";
  }

  connectedCallback() {
    if (this._mounted) return;
    this._mounted = true;

    this.style.position = "relative";
    this.style.display = "block";
    this.style.overflow = "hidden";

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "width:100%;height:100%;display:block;";
    this.appendChild(this.canvas);

    this._buildModeControls();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_COLOR);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera.position.set(2.4, 1.6, 2.4);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;

    // Soft three-light rig. Warm key + cool fill, faint top rim. Same energy
    // budget as Blender's "Studio" matcap so PBR materials don't blow out.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xfff1d0, 1.05);
    key.position.set(3, 4, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xc0d4ff, 0.45);
    fill.position.set(-2.5, 1, -2.5);
    this.scene.add(fill);
    const top = new THREE.DirectionalLight(0xffffff, 0.35);
    top.position.set(0, 5, 0);
    this.scene.add(top);

    // Wireframe-only material (used as scene.overrideMaterial in wire mode).
    this._wireMatSolo = new THREE.MeshBasicMaterial({
      color: WIRE_COLOR_SOLID,
      wireframe: true,
    });
    // Wireframe overlay material — pushed slightly forward via polygonOffset
    // so the edges sit on top of the surface render without z-fighting and
    // without losing back-face occlusion.
    this._wireMatOverlay = new THREE.MeshBasicMaterial({
      color: WIRE_COLOR_OVERLAY,
      wireframe: true,
      transparent: true,
      opacity: 0.75,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this._tick = this._tick.bind(this);
    this.loadModel();
    this._tick();

    this._ro = new ResizeObserver(() => this._handleResize());
    this._ro.observe(this);
    this._handleResize();

    // Honor an initial mode set via attribute (e.g. <mesh-preview mode="both">).
    const attrMode = this.getAttribute("mode");
    if (attrMode) this._setMode(attrMode, /*silent=*/true);
  }

  disconnectedCallback() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
    this._disposeModel();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (!this._mounted) return;
    if (name === "src" && oldVal !== newVal) this.loadModel();
    if (name === "mode" && oldVal !== newVal && newVal) this._setMode(newVal, /*silent=*/true);
  }

  _buildModeControls() {
    const wrap = document.createElement("div");
    wrap.className = "mesh-preview-modes";
    for (const { key, label } of MODES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.mode = key;
      btn.textContent = label;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._setMode(key);
      });
      wrap.appendChild(btn);
    }
    this._modeWrap = wrap;
    this.appendChild(wrap);
    this._syncModeButtons();
  }

  _syncModeButtons() {
    if (!this._modeWrap) return;
    for (const btn of this._modeWrap.querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.mode === this._mode);
    }
  }

  _setMode(mode, silent = false) {
    if (!MODES.find(m => m.key === mode)) return;
    this._mode = mode;
    this._syncModeButtons();
    if (!silent) this.setAttribute("mode", mode);
  }

  _disposeModel() {
    if (!this._modelGroup) return;
    this.scene.remove(this._modelGroup);
    this._modelGroup.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry?.dispose?.();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!m) continue;
          for (const k of Object.keys(m)) {
            const v = m[k];
            if (v && v.isTexture) v.dispose();
          }
          m.dispose?.();
        }
      }
    });
    this._modelGroup = null;
  }

  loadModel() {
    const src = this.getAttribute("src");
    if (!src) return;
    this._disposeModel();
    const loader = new GLTFLoader();
    loader.load(
      src,
      (gltf) => {
        this._modelGroup = gltf.scene;
        this.scene.add(this._modelGroup);
        this._fitCameraTo(this._modelGroup);
      },
      undefined,
      (err) => {
        console.error("[mesh-preview] load failed", err);
        this.dispatchEvent(new CustomEvent("error", { detail: err }));
      },
    );
  }

  _fitCameraTo(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    obj.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.85;
    this.camera.position.copy(new THREE.Vector3(1, 0.55, 1.1).normalize().multiplyScalar(dist));
    this.camera.near = Math.max(dist / 200, 0.001);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  _handleResize() {
    const w = this.clientWidth;
    const h = this.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  _tick() {
    this._raf = requestAnimationFrame(this._tick);
    this.controls.update();

    if (!this._modelGroup) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    if (this._mode === "wireframe") {
      this.scene.overrideMaterial = this._wireMatSolo;
      this.renderer.render(this.scene, this.camera);
      this.scene.overrideMaterial = null;
    } else if (this._mode === "both") {
      // Pass 1: textured surface, normal materials.
      this.scene.overrideMaterial = null;
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
      // Pass 2: wireframe overlay, polygonOffset pushes lines forward.
      this.scene.overrideMaterial = this._wireMatOverlay;
      this.renderer.autoClear = false;
      this.renderer.render(this.scene, this.camera);
      this.renderer.autoClear = true;
      this.scene.overrideMaterial = null;
    } else {
      // Textured (default).
      this.scene.overrideMaterial = null;
      this.renderer.render(this.scene, this.camera);
    }
  }
}

customElements.define("mesh-preview", MeshPreview);
