import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

// ---------- Mug constants (meters) ----------
const MUG = {
  height: 0.095,
  topRadius: 0.0410,
  bottomRadius: 0.0395,
  cornerRadius: 0.0020,    // 2 mm bevel → ~4 mm wall (was 6 mm — too chunky)
  baseThickness: 0.0055,
  // Stadium-shaped handle: short horizontal shelves at top/bottom, big rounded
  // corners, near-straight outer edge — matches the Printful reference.
  handleVertR: 0.0300,     // top/bottom attachment Y (handle is 60 mm tall)
  handleHorizExt: 0.0080,  // horizontal shelf length before the corner starts
  handleCornerR: 0.0220,   // big rounded corner radius (top + bottom)
  handleTube: 0.0052,      // tube cross-section radius → ~10.5 mm thick handle
  handleEmbed: 0.0035,     // bury the tube ends inside the body wall
  handleZScale: 0.74,      // mild oval cross-section
};

const r = MUG.cornerRadius;
const bodyHeight = MUG.height - 2 * r;
const cylTop =  MUG.height / 2 - r;
const cylBot = -MUG.height / 2 + r;
const innerFloor = -MUG.height / 2 + MUG.baseThickness;
const innerRtop = MUG.topRadius - 2 * r;
const innerRbot = MUG.bottomRadius - 2 * r;

// Texture canvas: sized isotropically to the printable cylinder section
const TEX_W = 2048;
const TEX_H = Math.round(TEX_W * bodyHeight / (2 * Math.PI * MUG.topRadius));

// Print area in physical units. Source of truth for 11oz mug production.
// Real production constraint: handle blocks ~5 cm of circumference, leaving
// 20.5 cm of usable horizontal print width. Vertical headroom = body height
// minus the standard 8 mm Print-on-Demand bleed at top and base of the mug.
const PRINT_AREA_CM = {
  width: 20.5,
  height: 8.9,
};

// Mug body unwrap dimensions, derived from MUG geometry.
const UNWRAP_W_CM = 2 * Math.PI * MUG.topRadius * 100;  // ≈ 25.76 cm
const UNWRAP_H_CM = bodyHeight * 100;                    // ≈ 9.10 cm

const MAX_LAYERS = 5;

// Each layer: { id, imageBitmap, thumbDataUrl, name, scale, offsetX, offsetY }
// Layers paint in array order (index 0 first, last index on top). The active
// layer is the one whose bbox is shown and that the sliders/handles modify.
const state = {
  bodyColor: '#ffffff',
  layers: [],
  activeLayerId: null,
};

let layerSeq = 0;
function nextLayerId() {
  return `L${++layerSeq}`;
}

function getActiveLayer() {
  return state.layers.find((l) => l.id === state.activeLayerId) || null;
}

// ---------- Renderer ----------
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Lower exposure (was 1.15) — at 1.15 light pixels in the texture were
// being pushed past the tone-mapper's roll-off and clipping to white.
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('viewer').appendChild(renderer.domElement);

// ---------- Scene ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xefedea);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;

// ---------- Camera & controls ----------
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.01, 100);
// Default view: 270° (camera at -X direction, slight elevation). This is
// the "Frente" — the side of the mug that faces the audience when a
// right-handed person holds it. The Frente placement zone (canvas-25%)
// maps directly to this 270° camera position, so a design uploaded with
// the default offsetX (-0.25) is immediately visible head-on.
// Camera defaults to a head-on view of the printable face (looking down -Z),
// since the mug is rotated so canvas_u = 0.5 lands at +Z. The 0.045 elevation
// gives a slight downward tilt that reads more product-photo than schematic.
const DEFAULT_POS = new THREE.Vector3(0, 0.045, 0.21);
const DEFAULT_TARGET = new THREE.Vector3(0, 0, 0);
camera.position.copy(DEFAULT_POS);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(DEFAULT_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.10;
controls.maxDistance = 0.60;
controls.enablePan = true;

// Live angle indicator — recompute the camera's Y rotation on every change
// and write it into the viewer-angle badge. Angle is measured CCW from +Z:
// 0° = dead-front, 90° = right side (+X), 180° = back, 270° = left side.
const angleEl = document.getElementById('viewer-angle');
function updateAngleDisplay() {
  if (!angleEl) return;
  const x = camera.position.x;
  const z = camera.position.z;
  let deg = Math.atan2(x, z) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  angleEl.textContent = `${Math.round(deg)}°`;
}
controls.addEventListener('change', updateAngleDisplay);
updateAngleDisplay();

// Position the camera to look head-on at whatever cylinder position
// corresponds to the active layer's offsetX. With mugTexture.offset.x = 0.5:
//   canvas-50% (offsetX=0)   → mesh u=0   → +Z direction (front, 0°)
//   canvas-25% (offsetX=-0.25) → mesh u=-0.25 → -X direction (left side, 270°)
//   canvas-75% (offsetX=+0.25) → mesh u=+0.25 → +X direction (right side, 90°)
// Camera follows on explicit actions (upload, "Centrar") — not on slider drag,
// so the user can manually rotate the mug to inspect other angles.
const CAMERA_DISTANCE = 0.21;
const CAMERA_HEIGHT = 0.045;
function positionCameraForOffset(offsetX) {
  const angle = 2 * Math.PI * (offsetX || 0);
  camera.position.set(
    CAMERA_DISTANCE * Math.sin(angle),
    CAMERA_HEIGHT,
    CAMERA_DISTANCE * Math.cos(angle),
  );
  controls.target.set(0, 0, 0);
  controls.update();
}

// ---------- Lighting (slightly warm key, cool rim) ----------
scene.add(new THREE.AmbientLight(0xfff8ee, 0.30));

// Key intensity lowered from 1.6 to 1.05 — combined with low-roughness
// glaze + clearcoat, the previous value was over-illuminating bright
// regions of the printed texture and washing them out.
const keyLight = new THREE.DirectionalLight(0xfff5e6, 1.05);
// Key light at ~282° angle (slight offset from the dead-Frente 270° direction
// for natural shadow definition). Position is mostly -X with small +Z bias so
// the light hits the Frente face near-frontally, with the highlight rolling
// off toward the audience-right edge.
keyLight.position.set(-0.40, 0.35, 0.08);
keyLight.castShadow = true;
// Larger map + bigger PCF radius = visibly softer/blurrier shadow penumbra
keyLight.shadow.mapSize.set(4096, 4096);
keyLight.shadow.camera.near = 0.05;
keyLight.shadow.camera.far = 0.80;
keyLight.shadow.camera.left = -0.18;
keyLight.shadow.camera.right = 0.18;
keyLight.shadow.camera.top = 0.18;
keyLight.shadow.camera.bottom = -0.18;
keyLight.shadow.bias = -0.0002;
keyLight.shadow.radius = 14;
keyLight.shadow.blurSamples = 24;
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xeaf0ff, 0.55);
rimLight.position.set(0.30, 0.20, -0.25);
scene.add(rimLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.20);
fillLight.position.set(0.05, -0.20, 0.30);
scene.add(fillLight);

// ---------- Ground (shadow only) ----------
// Ground takes the directional light's shadow. Lower opacity gives a softer
// contact shadow that fades out instead of a hard dark patch.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShadowMaterial({ opacity: 0.18 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -MUG.height / 2 - 0.001;
ground.receiveShadow = true;
scene.add(ground);

// ---------- Texture (canvas-backed) ----------
// Two canvases with DIFFERENT dimensions:
//   texCanvas    — visible in the editor, sized to the print area only
//                   (≈ 1631 × 676 px = 20.5 × 8.5 cm). Everything inside is
//                   printable; the user never sees the bleed/handle area.
//   textureCanvas — hidden, backs the 3D CanvasTexture. Sized to the full
//                   cylinder unwrap (TEX_W × TEX_H = 2048 × 724) so the 3D
//                   mug wraps correctly. Built by compositing texCanvas into
//                   the centered letterbox + filling the bleed with body color.
const EDITOR_W = Math.round(TEX_W * PRINT_AREA_CM.width / UNWRAP_W_CM);
const EDITOR_H = Math.round(TEX_H * PRINT_AREA_CM.height / UNWRAP_H_CM);

const texCanvas = document.createElement('canvas');
texCanvas.width = EDITOR_W;
texCanvas.height = EDITOR_H;
const texCtx = texCanvas.getContext('2d');

const textureCanvas = document.createElement('canvas');
textureCanvas.width = TEX_W;
textureCanvas.height = TEX_H;
const textureCtx = textureCanvas.getContext('2d');

const mugTexture = new THREE.CanvasTexture(textureCanvas);
mugTexture.colorSpace = THREE.SRGBColorSpace;
// The loaded OBJ's body UVs occupy a sub-rectangle of [0,1]² (the bottom-right
// of the artist's UV layout). We map our existing canvas onto exactly that
// rectangle via texture transform. ClampToEdge on both axes so that any UVs
// outside the body region (the handle, etc.) sample the canvas border (kept
// white) instead of wrapping the design weirdly.
mugTexture.wrapS = THREE.ClampToEdgeWrapping;
mugTexture.wrapT = THREE.ClampToEdgeWrapping;
mugTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
// Body UV sub-region for the user's printable design. Values determined
// empirically by painting test patterns on the loaded model and measuring
// the visible aspect ratio of a known canvas square on the rendered mug.
//
// Three things the V range controls together:
//   1. **Bleed-through**: full body UV is u∈[0.175,1.0], v∈[0,0.45], but the
//      upper portion (V > ~0.36) wraps over the rim into the cup's interior.
//      Anything painted there shows up on the inside surface.
//   2. **Margin**: real-world print-on-demand always leaves ~5-10mm of bare
//      ceramic at the rim and the base. Designs that touch the rolled edges
//      look amateur and aren't actually printable on a real ceramic mug.
//   3. **Aspect ratio**: the canvas is 2048×723 (2.83 W:H), but the mug body
//      is roughly 251mm circumference × ~67mm of usable print zone (3.75 W:H).
//      Mapping the canvas v 1:1 onto the body would over-stretch designs
//      vertically — a perfect canvas square ends up as a tall rectangle on
//      the mug. To compensate, V range = 0.270 (calibrated empirically: a
//      500×500 canvas square renders as 290×285 visible px = aspect 1.018).
//
// Mapping model_uv → canvas_uv: canvas_uv = model_uv * repeat + offset
const BODY_U0 = 0.175, BODY_U1 = 1.000;
const BODY_V0 = 0.045, BODY_V1 = 0.315;
mugTexture.repeat.set(1 / (BODY_U1 - BODY_U0), 1 / (BODY_V1 - BODY_V0));
mugTexture.offset.set(-BODY_U0 / (BODY_U1 - BODY_U0), -BODY_V0 / (BODY_V1 - BODY_V0));

// Compute base-fit dimensions for a given layer onto a print area of size
// (areaW, areaH). "Base" means scale=1 (image letterboxed inside the area
// preserving its aspect ratio).
function layerBaseDraw(layer, areaW, areaH) {
  const img = layer.imageBitmap;
  const imgRatio = img.width / img.height;
  const areaRatio = areaW / areaH;
  let baseW, baseH;
  if (imgRatio > areaRatio) {
    baseW = areaW;
    baseH = baseW / imgRatio;
  } else {
    baseH = areaH;
    baseW = baseH * imgRatio;
  }
  return { baseW, baseH, imgRatio };
}

// Paint all layers into ctx of size w × h. (w, h) IS the print area — there is
// no internal letterbox. Used by drawTexture (texCanvas at EDITOR_W × EDITOR_H)
// and the print exporter (high-res offscreen canvas at the same aspect).
function paintLayers(ctx, w, h, opts = {}) {
  if (opts.fillBg !== false) {
    ctx.fillStyle = opts.bgColor || state.bodyColor;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  for (const layer of state.layers) {
    if (!layer.imageBitmap) continue;
    const { baseW, baseH } = layerBaseDraw(layer, w, h);
    const drawW = baseW * layer.scale;
    const drawH = baseH * layer.scale;
    const drawX = (w - drawW) / 2 + layer.offsetX * w;
    const drawY = (h - drawH) / 2 + layer.offsetY * h;
    ctx.drawImage(layer.imageBitmap, drawX, drawY, drawW, drawH);
  }
}

// Composite texCanvas (print area) into textureCanvas (full cylinder unwrap)
// for 3D rendering. Bleed area = handle backside + top/bottom margin, never
// visible from the editor — fill with body color so the 3D mug shows correct
// material there.
function compositeToTexture() {
  textureCtx.fillStyle = state.bodyColor;
  textureCtx.fillRect(0, 0, TEX_W, TEX_H);
  const dx = (TEX_W - EDITOR_W) / 2;
  const dy = (TEX_H - EDITOR_H) / 2;
  textureCtx.drawImage(texCanvas, dx, dy);
  mugTexture.needsUpdate = true;
}

function drawTexture() {
  // Editor canvas: always white background so the canvas itself stays
  // light regardless of which body color the user picked.
  paintLayers(texCtx, EDITOR_W, EDITOR_H, { bgColor: '#ffffff' });
  // 3D texture: composite the print-area design into the unwrap with body
  // color filling the bleed.
  compositeToTexture();
  if (typeof updateImageBbox === 'function') updateImageBbox();
  if (typeof updateQualityChip === 'function') updateQualityChip();
}

// ---------- Image quality (DPI) ----------
// The texture canvas is sized so 1 canvas pixel = constant physical mm in
// both axes (TEX_H derived from bodyHeight to match TEX_W ↔ circumference).
// So the image's effective DPI on the print is just imagePixels / drawnInches.
const QUALITY_THRESHOLD_DPI = 150;
const MM_PER_CANVAS_PX = (2 * Math.PI * MUG.topRadius * 1000) / TEX_W;

function getLayerDPI(layer) {
  if (!layer.imageBitmap) return Infinity;
  const { baseW, baseH } = layerBaseDraw(layer, EDITOR_W, EDITOR_H);
  const drawWPx = baseW * layer.scale;
  const drawHPx = baseH * layer.scale;
  // Convert canvas px to inches via the isotropic mm/px ratio.
  const drawWInches = (drawWPx * MM_PER_CANVAS_PX) / 25.4;
  const drawHInches = (drawHPx * MM_PER_CANVAS_PX) / 25.4;
  // Use the worse of the two axes (smaller DPI) since both must be
  // sufficient for sharp output.
  return Math.min(
    layer.imageBitmap.width / drawWInches,
    layer.imageBitmap.height / drawHInches,
  );
}

// ---------- Materials ----------
// Glazed ceramic: smooth base layer + a strong, very smooth clearcoat for the
// glaze. Low roughness on both layers so the environment reflects sharply.
// Real glazed ceramic isn't a mirror. Roughness around 0.4 + a moderate
// clearcoat at 0.4 with slightly diffuse glaze (0.15) gives a satin
// finish that reflects the environment subtly without burning out the
// printed image where the texture is light-coloured. envMapIntensity
// dropped from 1.4 to 0.85 for the same reason — strong env reflections
// on a near-mirror surface saturated white pixels of the print to pure
// white. These values match how studio-shot product mockups (Printful,
// Printify, etc.) actually render their mugs.
const bodyMat = new THREE.MeshPhysicalMaterial({
  map: mugTexture,
  color: 0xffffff,
  roughness: 0.40,
  metalness: 0,
  clearcoat: 0.40,
  clearcoatRoughness: 0.15,
  reflectivity: 0.45,
  envMapIntensity: 0.85,
});

const ceramicMat = new THREE.MeshPhysicalMaterial({
  color: state.bodyColor,
  roughness: 0.40,
  metalness: 0,
  clearcoat: 0.40,
  clearcoatRoughness: 0.15,
  reflectivity: 0.45,
  envMapIntensity: 0.85,
});

// ---------- Geometry helpers ----------
function arc2D(cx, cy, R, a0, a1, segments) {
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = a0 + (a1 - a0) * t;
    out.push(new THREE.Vector2(cx + R * Math.cos(a), cy + R * Math.sin(a)));
  }
  return out;
}

// ---------- Mug ----------
const mugGroup = new THREE.Group();
scene.add(mugGroup);

// Mug geometry comes from a third-party OBJ (CGTrader artist-B "3D Cup Model
// — Standard Size"). Procedural geometry (cylinder body, lathe top/bottom,
// swept handle) was abandoned after many iterations couldn't make the handle
// look organic without visible bumps at the inner-side joins. The OBJ has
// professional UV unwrapping prepared for print-mockup work, with the body
// occupying the bottom-right rectangle of [0,1]² UV space — that's what the
// texture transform set up earlier is mapping our design canvas onto.
//
// The model contains two objects: "3D_Cup" (mug we want) and "Backdrop"
// (a render-prop plane we hide). We override the model's default red-template
// material with bodyMat (textured) and ceramicMat (handle/non-printable) so
// the user's design ends up on the printable body and the rest stays plain
// glazed ceramic.
//
// Coordinates: model is y-up, base near y=0, top near y=0.094m. We shift it
// down so the mug centers at y=0 to match the camera/lighting setup.
const objLoader = new OBJLoader();
objLoader.load('mug-model/cup.obj', (root) => {
  // Skip-list: parts of the model we don't want in the scene.
  const HIDE = new Set(['Backdrop']);
  let cupMesh = null;
  root.traverse((child) => {
    if (!child.isMesh) return;
    if (HIDE.has(child.name)) {
      child.visible = false;
      return;
    }
    cupMesh = child;
    child.material = bodyMat;
    child.castShadow = true;
    child.receiveShadow = true;
  });
  if (cupMesh) {
    // Center the model vertically (model base sits near y=0).
    const box = new THREE.Box3().setFromObject(cupMesh);
    const cy = (box.min.y + box.max.y) / 2;
    root.position.y -= cy;
    // Rotate the mug so canvas_u = 0.5 (where centered designs live) lands on
    // the visible front (+Z direction). The exact angle was tuned empirically
    // by painting a vertical line at u=0.5 and iterating until it hit the
    // mug's apparent center in the default front-on camera view. The seller's
    // UV unwrap doesn't put u=0.5 at the front of the model as-loaded, hence
    // this offset. Side effect: the handle ends up at the back-left of the
    // mug rather than the camera-left (-X) — visible if you orbit, but the
    // priority here is putting the design dead-center on the front face.
    root.rotation.y = Math.PI - 1.35;
  }
  mugGroup.add(root);
}, undefined, (err) => {
  console.error('Failed to load mug OBJ:', err);
});

function updateBodyColor(hex) {
  state.bodyColor = hex;
  ceramicMat.color.set(hex);
  drawTexture();
}

drawTexture();

// Dev hooks. Lets you paint test patterns and orbit the camera from the
// browser console / Playwright while tuning UV mapping to a new model. Safe
// to leave in — costs nothing at runtime and isn't referenced by app code.
//   window.__dbg.textureCtx.fillStyle = 'red'; window.__dbg.textureCtx.fillRect(0,0,2048,2048); window.__dbg.mugTexture.needsUpdate = true;
window.__dbg = {
  THREE,
  textureCanvas,
  textureCtx,
  mugTexture,
  mugGroup,
  camera,
  controls,
  renderer,
  scene,
};

// ---------- File handling ----------
const hint = document.getElementById('empty-hint');

// Build a small dataURL thumbnail from an ImageBitmap so layer-list <img>
// tags can show a preview without holding extra ImageBitmaps around.
function makeThumbnail(bitmap, max = 96) {
  const ratio = bitmap.width / bitmap.height;
  const w = ratio >= 1 ? max : Math.round(max * ratio);
  const h = ratio >= 1 ? Math.round(max / ratio) : max;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bitmap, 0, 0, w, h);
  return c.toDataURL('image/png');
}

async function handleFiles(files) {
  if (!files || !files.length) return;
  const list = Array.from(files);
  let added = 0;
  for (const file of list) {
    if (state.layers.length >= MAX_LAYERS) {
      // At limit — silently stop. Dropzone already shows "Máximo 5 capas".
      break;
    }
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      console.warn('Unsupported file type:', file.type);
      continue;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const layer = {
        id: nextLayerId(),
        imageBitmap: bitmap,
        thumbDataUrl: makeThumbnail(bitmap),
        name: file.name || `Capa ${state.layers.length + 1}`,
        scale: 1.0,
        // Default to the Frente placement zone (canvas-25% = camera 270°)
        // so new uploads land where the user expects designs to live.
        offsetX: -0.25,
        offsetY: 0,
      };
      state.layers.push(layer);
      state.activeLayerId = layer.id;
      added++;
    } catch (err) {
      console.error('Failed to read image', err);
    }
  }
  if (added > 0) {
    drawTexture();
    syncAllSliders();
    renderLayerList();
    renderActiveLayerSection();
    if (hint) hint.classList.add('hidden');
    // Reset 3D camera to look head-on at whatever cylinder position the
    // active layer's offsetX maps to, so the design is centered in the
    // 3D mini preview right after upload.
    const layer = getActiveLayer();
    positionCameraForOffset(layer ? layer.offsetX : 0);
  }
}

document.getElementById('file-input').addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
});

let dragCounter = 0;
function isFileDrag(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}
document.body.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter++;
  document.body.classList.add('dragging');
});
document.body.addEventListener('dragover', (e) => {
  if (isFileDrag(e)) e.preventDefault();
});
document.body.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    document.body.classList.remove('dragging');
  }
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  document.body.classList.remove('dragging');
  handleFiles(e.dataTransfer?.files);
});

// ---------- Mockup gallery (multi-angle product shots) ----------
// Fixed library of 5 camera presets that cover the standard angles a
// seller needs for a store listing. We render the existing 3D scene
// from each one at high resolution, capture as PNG, and expose all of
// them in a modal where the user can preview + download. Same scene,
// same lighting, same shadow plane — only the camera changes.
//
// Path A (this implementation): client-side 3D camera presets. Studio-
// shot quality, no humans, no lifestyle. Good enough for v1.
// Path B (future): pre-shot mug photos with masked print areas, server
// composits the design onto each. Matches Printful's lifestyle quality.

// Mockup camera presets, all anchored to the new Frente orientation:
// the Frente face is at -X (270°), audience-right is +Z, audience-left is
// -Z (the handle side). Cameras orbit at distance 0.22 around the mug.
const MOCKUP_PRESETS = [
  { id: 'front',         name: 'Frente',                pos: [-0.22, 0.05, 0],     target: [0, 0, 0]     },
  { id: 'three-quarter', name: 'Tres cuartos derecho',  pos: [-0.18, 0.05, 0.13],  target: [0, 0, 0]     },
  { id: 'profile-right', name: 'Perfil derecho',        pos: [0,     0.05, 0.22],  target: [0, 0, 0]     },
  { id: 'profile-left',  name: 'Perfil izquierdo',      pos: [0,     0.05, -0.22], target: [0, 0, 0]     },
  { id: 'top-angle',     name: 'Vista superior',        pos: [-0.18, 0.16, 0.05],  target: [0,-0.02, 0]  },
];
const MOCKUP_RENDER_SIZE = 1200;  // px square — high enough for store listings

async function renderPresetToBlob(preset) {
  camera.position.set(...preset.pos);
  controls.target.set(...preset.target);
  camera.lookAt(controls.target);
  controls.update();
  renderer.render(scene, camera);
  return new Promise((resolve) => {
    renderer.domElement.toBlob((blob) => resolve(blob), 'image/png');
  });
}

async function generateMockupSet() {
  // Snapshot the renderer + camera state so we can restore exactly.
  const origSize = new THREE.Vector2();
  renderer.getSize(origSize);
  const origAspect = camera.aspect;
  const origPos = camera.position.clone();
  const origTarget = controls.target.clone();

  // Resize to a fixed square at high quality. The renderer's WebGL
  // canvas DOES live inside #viewer (which may be hidden in edit mode),
  // but toBlob still captures from the GL backbuffer regardless.
  renderer.setSize(MOCKUP_RENDER_SIZE, MOCKUP_RENDER_SIZE);
  camera.aspect = 1;
  camera.updateProjectionMatrix();

  const mockups = [];
  for (const preset of MOCKUP_PRESETS) {
    const blob = await renderPresetToBlob(preset);
    if (blob) {
      mockups.push({
        id: preset.id,
        name: preset.name,
        blob,
        url: URL.createObjectURL(blob),
      });
    }
  }

  // Restore camera + renderer size. resizeViewer() resets size+aspect
  // to whatever the viewer container currently is.
  camera.position.copy(origPos);
  controls.target.copy(origTarget);
  controls.update();
  if (typeof resizeViewer === 'function') resizeViewer();
  else {
    renderer.setSize(origSize.x, origSize.y);
    camera.aspect = origAspect;
    camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);

  return mockups;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// State for the open modal — kept module-scoped so the "Descargar todo"
// handler can reach the latest render set.
let _currentMockups = [];

function renderMockupsModal(mockups) {
  const grid = document.getElementById('mockups-grid');
  const status = document.getElementById('mockups-status');
  const dlAll = document.getElementById('mockups-download-all');
  if (!grid || !status) return;
  grid.innerHTML = '';
  for (const m of mockups) {
    const tile = document.createElement('div');
    tile.className = 'mockup-tile';
    tile.innerHTML = `
      <img class="mockup-tile-img" src="${m.url}" alt="${m.name}">
      <div class="mockup-tile-foot">
        <span class="mockup-tile-name">${m.name}</span>
        <button class="mockup-tile-download" data-id="${m.id}" title="Descargar ${m.name}" aria-label="Descargar ${m.name}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
      </div>`;
    grid.appendChild(tile);
  }
  status.hidden = true;
  grid.hidden = false;
  if (dlAll) dlAll.disabled = false;
}

function clearMockupsModal() {
  const grid = document.getElementById('mockups-grid');
  const status = document.getElementById('mockups-status');
  const dlAll = document.getElementById('mockups-download-all');
  if (grid) { grid.innerHTML = ''; grid.hidden = true; }
  if (status) { status.hidden = false; status.textContent = 'Generando mockups…'; }
  if (dlAll) dlAll.disabled = true;
  // Free old object URLs from the previous open
  for (const m of _currentMockups) URL.revokeObjectURL(m.url);
  _currentMockups = [];
}

function openMockupsModal() {
  const modal = document.getElementById('mockups-modal');
  if (!modal) return;
  clearMockupsModal();
  modal.hidden = false;
}

function closeMockupsModal() {
  const modal = document.getElementById('mockups-modal');
  if (!modal) return;
  modal.hidden = true;
  for (const m of _currentMockups) URL.revokeObjectURL(m.url);
  _currentMockups = [];
}

document.getElementById('generate-mockups')?.addEventListener('click', async () => {
  if (state.layers.length === 0) {
    alert('Subí al menos una imagen antes de generar los mockups.');
    return;
  }
  openMockupsModal();
  try {
    _currentMockups = await generateMockupSet();
    renderMockupsModal(_currentMockups);
  } catch (err) {
    console.error('Mockup generation failed', err);
    const status = document.getElementById('mockups-status');
    if (status) status.textContent = 'No se pudieron generar los mockups. Probá de nuevo.';
  }
});

// Close modal on backdrop / X / ESC
document.getElementById('mockups-modal')?.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeMockupsModal();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('mockups-modal');
    if (modal && !modal.hidden) closeMockupsModal();
  }
});

// Per-tile download (delegated)
document.getElementById('mockups-grid')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.mockup-tile-download');
  if (!btn) return;
  const m = _currentMockups.find((x) => x.id === btn.dataset.id);
  if (m) downloadBlob(m.blob, `mug-mockup-${m.id}.png`);
});

// Bulk download — sequentially trigger per-image downloads
document.getElementById('mockups-download-all')?.addEventListener('click', async () => {
  for (const m of _currentMockups) {
    downloadBlob(m.blob, `mug-mockup-${m.id}.png`);
    await new Promise((r) => setTimeout(r, 250));  // browsers throttle simultaneous downloads
  }
});

// Print file export. Renders ALL layers at 300 DPI for the physical mug
// dimensions, transparent background outside the design (so the printer
// applies its own white base), and crops to exactly the print area — no
// bleed bands, no body-color fill. This is the file that goes to production.
//
// 11oz mug print area: 205 × 85 mm → ~2421 × 1004 px @ 300 DPI
const PRINT_DPI = 300;
const MM_PER_INCH = 25.4;

function exportPrintFile() {
  if (state.layers.length === 0) {
    alert('Subí al menos una imagen antes de exportar el archivo de impresión.');
    return;
  }
  // Physical print dimensions (mm) — fixed 11oz mug print area.
  const wMm = PRINT_AREA_CM.width * 10;
  const hMm = PRINT_AREA_CM.height * 10;
  const printPxW = Math.round(wMm / MM_PER_INCH * PRINT_DPI);
  const printPxH = Math.round(hMm / MM_PER_INCH * PRINT_DPI);

  // paintLayers now treats (w, h) as the print area directly — no letterbox,
  // no crop step needed. Transparent background so the printer applies its
  // own white base outside the design.
  const out = document.createElement('canvas');
  out.width = printPxW;
  out.height = printPxH;
  paintLayers(out.getContext('2d'), printPxW, printPxH, { fillBg: false });

  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mug-print-${printPxW}x${printPxH}-300dpi.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }, 'image/png');
}

document.getElementById('download-print').addEventListener('click', exportPrintFile);

// All sliders / quick actions act on the active layer. If no active layer
// exists they no-op (the panel still shows but does nothing meaningful).
const scaleEl = document.getElementById('scale');
const scaleVal = document.getElementById('scale-val');
scaleEl.addEventListener('input', () => {
  const layer = getActiveLayer();
  if (!layer) return;
  layer.scale = parseFloat(scaleEl.value);
  scaleVal.textContent = `${Math.round(layer.scale * 100)}%`;
  drawTexture();
});

const offXEl = document.getElementById('offset-x');
const offXVal = document.getElementById('offset-x-val');
offXEl.addEventListener('input', () => {
  const layer = getActiveLayer();
  if (!layer) return;
  layer.offsetX = parseFloat(offXEl.value);
  offXVal.textContent = layer.offsetX.toFixed(2);
  drawTexture();
});

const offYEl = document.getElementById('offset-y');
const offYVal = document.getElementById('offset-y-val');
offYEl.addEventListener('input', () => {
  const layer = getActiveLayer();
  if (!layer) return;
  layer.offsetY = parseFloat(offYEl.value);
  offYVal.textContent = layer.offsetY.toFixed(2);
  drawTexture();
});

// Color swatches (Blanco / Negro). Two-color picker — we only stock
// these SKUs, so an unbounded color picker would expose options users
// can't actually buy.
document.querySelectorAll('.color-swatch').forEach((sw) => {
  sw.addEventListener('click', () => {
    const color = sw.dataset.color;
    if (!color) return;
    updateBodyColor(color);
    document.querySelectorAll('.color-swatch').forEach((s) => {
      const isActive = s === sw;
      s.classList.toggle('is-active', isActive);
      s.setAttribute('aria-checked', String(isActive));
    });
  });
});

// Show the quality chip when the active layer's DPI drops below threshold.
// Hidden when no active layer or when DPI is acceptable.
function updateQualityChip() {
  const chip = document.getElementById('quality-chip');
  if (!chip) return;
  const layer = getActiveLayer();
  if (!layer) {
    chip.hidden = true;
    return;
  }
  const dpi = getLayerDPI(layer);
  if (!isFinite(dpi) || dpi >= QUALITY_THRESHOLD_DPI) {
    chip.hidden = true;
    return;
  }
  const dpiEl = document.getElementById('quality-dpi');
  const nameEl = document.getElementById('quality-layer-name');
  if (dpiEl) dpiEl.textContent = Math.round(dpi);
  if (nameEl) {
    const idx = state.layers.findIndex((l) => l.id === layer.id);
    nameEl.textContent = `Capa ${idx + 1}`;
  }
  chip.hidden = false;
}

function updatePrintDimensions() {
  const el = document.getElementById('dim-text');
  if (!el) return;
  el.textContent = `${PRINT_AREA_CM.width.toFixed(1)} × ${PRINT_AREA_CM.height.toFixed(1)} cm`;
}
updatePrintDimensions();

// Renderer follows the size of its container (.canvas-area), not the window.
// We pass `true` (default) to setSize so it updates BOTH the canvas bitmap
// AND the CSS style — otherwise the canvas keeps the style of the previous
// window size and overflows the container when the viewport gets smaller.
const viewerContainer = document.getElementById('viewer');
function resizeViewer() {
  const r = viewerContainer.getBoundingClientRect();
  const w = Math.max(1, r.width);
  const h = Math.max(1, r.height);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resizeViewer);
// ResizeObserver catches layout-driven size changes (e.g., side panel
// opening/closing) that don't fire window resize.
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => resizeViewer());
  ro.observe(viewerContainer);
}
// Initial size — but the container may be hidden, so also resize on first
// switch to preview (handled inside setViewMode).
requestAnimationFrame(resizeViewer);

// ---------- Custom model loader (.glb / .gltf) ----------
const gltfLoader = new GLTFLoader();
let customMug = null;

async function loadCustomModel(file) {
  const url = URL.createObjectURL(file);
  try {
    const gltf = await gltfLoader.loadAsync(url);
    if (customMug) scene.remove(customMug);
    customMug = gltf.scene;

    // Find the largest mesh (assume it's the mug body) and apply our canvas
    // texture as its print map. Other meshes (handle, etc.) keep their stock
    // material so PBR maps that came with the model are preserved.
    let bodyMesh = null;
    let bodyArea = 0;
    customMug.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      obj.geometry.computeBoundingBox();
      const s = new THREE.Vector3();
      obj.geometry.boundingBox.getSize(s);
      const area = s.x * s.y * s.z;
      if (area > bodyArea) { bodyArea = area; bodyMesh = obj; }
    });
    if (bodyMesh) {
      const m = bodyMesh.material.clone();
      m.map = mugTexture;
      m.needsUpdate = true;
      bodyMesh.material = m;
    }

    // Re-center the model on the origin and scale it so its tallest dimension
    // matches our procedural mug height (so the camera framing still works).
    const bbox = new THREE.Box3().setFromObject(customMug);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    bbox.getSize(size);
    bbox.getCenter(center);
    const scale = MUG.height / Math.max(size.x, size.y, size.z);
    customMug.scale.setScalar(scale);
    customMug.position.copy(center).multiplyScalar(-scale);
    customMug.position.y -= bbox.min.y * scale + (size.y * scale) / 2 - MUG.height / 2;

    mugGroup.visible = false;
    scene.add(customMug);
    hint.classList.add('hidden');
    console.info('Loaded custom model:', file.name, 'body mesh:', bodyMesh?.name || '(unnamed)');
  } catch (err) {
    console.error('Failed to load model', err);
    alert('Could not load that 3D model. Make sure it is a .glb or .gltf file.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function useDefaultMug() {
  if (customMug) {
    scene.remove(customMug);
    customMug = null;
  }
  mugGroup.visible = true;
}

// "Cargar modelo 3D" UI removed in v1 (the loadCustomModel / useDefaultMug
// helpers stay defined above in case we re-expose this for advanced users).

// ---------- Editor shell (Gudink-style: top toggle + left sidebar tabs) ----------
const canvasWrap = document.getElementById('canvas-wrap');

// Mount the texture canvas as the visible 2D editor surface. It's the same
// canvas backing the THREE.CanvasTexture, so any drawTexture() call updates
// both this on-screen view and the 3D mug simultaneously.
canvasWrap.insertBefore(texCanvas, canvasWrap.firstChild);

// Position the bbox over the active layer's drawn rectangle on texCanvas
// and update the live size chip with the layer's physical dimensions.
// Resolves bbox via getElementById each call because drawTexture() runs at
// init before this module-level const is set; we don't want a TDZ crash.
function updateImageBbox() {
  const bbox = document.getElementById('image-bbox');
  if (!bbox) return;
  const layer = getActiveLayer();
  // Placement Zone Guide tracks the bbox: visible only when a layer is
  // selected, hidden when nothing is selected — matches Fourthwall.
  const guide = document.querySelector('.ed2-placement-guide');
  if (!layer) {
    bbox.hidden = true;
    if (guide) guide.hidden = true;
    return;
  }
  bbox.hidden = false;
  if (guide) guide.hidden = false;

  // Editor canvas IS the print area now — no letterbox.
  const { baseW, baseH } = layerBaseDraw(layer, EDITOR_W, EDITOR_H);
  const drawW = baseW * layer.scale;
  const drawH = baseH * layer.scale;
  const drawX = (EDITOR_W - drawW) / 2 + layer.offsetX * EDITOR_W;
  const drawY = (EDITOR_H - drawH) / 2 + layer.offsetY * EDITOR_H;

  bbox.style.left = `${(drawX / EDITOR_W) * 100}%`;
  bbox.style.top = `${(drawY / EDITOR_H) * 100}%`;
  bbox.style.width = `${(drawW / EDITOR_W) * 100}%`;
  bbox.style.height = `${(drawH / EDITOR_H) * 100}%`;

  // Size chip reads the INTERSECTION of the image with the print area, i.e.
  // what actually gets printed. When the image fully covers the print area,
  // the chip reads 20.5 × 8.5 cm — matching the badge below the canvas.
  const sizeEl = document.getElementById('bbox-size-text');
  if (sizeEl) {
    const visibleW = Math.min(drawW, EDITOR_W);
    const visibleH = Math.min(drawH, EDITOR_H);
    const wCm = (visibleW * MM_PER_CANVAS_PX) / 10;
    const hCm = (visibleH * MM_PER_CANVAS_PX) / 10;
    sizeEl.textContent = `${wCm.toFixed(1)} × ${hCm.toFixed(1)} cm`;
  }
}

const imageBbox = document.getElementById('image-bbox');

function syncOffsetSliders() {
  const layer = getActiveLayer();
  const ox = document.getElementById('offset-x');
  const oxv = document.getElementById('offset-x-val');
  const oy = document.getElementById('offset-y');
  const oyv = document.getElementById('offset-y-val');
  const x = layer ? layer.offsetX : 0;
  const y = layer ? layer.offsetY : 0;
  if (ox) ox.value = x;
  if (oxv) oxv.textContent = x.toFixed(2);
  if (oy) oy.value = y;
  if (oyv) oyv.textContent = y.toFixed(2);
}

// ---- Edit / Preview toggle (top-right pill) ----
const canvasEdit = document.getElementById('canvas-edit');
const viewToggleBtns = document.querySelectorAll('.view-toggle-btn');
let viewMode = 'edit';

// ---- Mouse-following grid background (Modeinspect-style) ----
// Two SVG pattern layers in .canvas-edit. Base stays at low opacity, reveal
// is masked by a radial spotlight that tracks the cursor. Grid is static —
// only the spotlight moves.
(function initGridEffect() {
  const reveal = document.getElementById('ed2-grid-reveal');
  if (!reveal || !canvasEdit) return;

  function setMouseVars(x, y) {
    reveal.style.setProperty('--mouse-x', x + 'px');
    reveal.style.setProperty('--mouse-y', y + 'px');
  }
  function resetMouseVars() {
    reveal.style.setProperty('--mouse-x', '-500px');
    reveal.style.setProperty('--mouse-y', '-500px');
  }
  resetMouseVars();

  // Document-level listener so we don't block clicks on overlay UI. Convert
  // to canvas-edit-relative coords; bail out if cursor is outside the bounds.
  document.addEventListener('mousemove', (e) => {
    if (canvasEdit.hidden) return;
    const rect = canvasEdit.getBoundingClientRect();
    if (
      e.clientX < rect.left || e.clientX > rect.right ||
      e.clientY < rect.top || e.clientY > rect.bottom
    ) {
      resetMouseVars();
      return;
    }
    setMouseVars(e.clientX - rect.left, e.clientY - rect.top);
  });
  document.addEventListener('mouseleave', resetMouseVars);
})();

function setViewMode(mode) {
  viewMode = mode;
  viewToggleBtns.forEach((b) => {
    const isActive = b.dataset.mode === mode;
    b.classList.toggle('is-active', isActive);
    b.setAttribute('aria-selected', String(isActive));
  });
  // Viewer stays mounted in BOTH modes so the live mockup keeps re-rendering
  // as the user edits. CSS class drives the size: --mini in edit (small
  // bottom-right thumbnail), --full in preview (fills canvas-area).
  viewerContainer.hidden = false;
  if (mode === 'edit') {
    canvasEdit.hidden = false;
    viewerContainer.classList.add('canvas-preview--mini');
    viewerContainer.classList.remove('canvas-preview--full');
    // Mini supports orbit but not zoom or pan — wheel-zoom would
    // hijack page scroll over the mini, and pan would push the mug
    // out of frame at this small size. Drag to rotate is enough.
    if (controls) {
      controls.enabled = true;
      controls.enableZoom = false;
      controls.enablePan = false;
      // Damping disabled in mini so the camera locks the moment the
      // user releases — no perceived "continues with mouse movement"
      // tail. Full preview keeps damping for a smoother feel.
      controls.enableDamping = false;
    }
  } else {
    canvasEdit.hidden = true;
    viewerContainer.classList.remove('canvas-preview--mini');
    viewerContainer.classList.add('canvas-preview--full');
    if (controls) {
      controls.enabled = true;
      controls.enableZoom = true;
      controls.enablePan = true;
      controls.enableDamping = true;
    }
    // Hide the rotate hint if user switched away from edit
    const hint = document.getElementById('mini-hint');
    if (hint) { hint.classList.remove('is-visible'); hint.hidden = true; }
  }
  // Renderer reads container size, so call after class change.
  resizeViewer();
}

viewToggleBtns.forEach((b) => {
  b.addEventListener('click', () => setViewMode(b.dataset.mode));
});

// Dedicated expand button (top-right of mini) — clicking it ramps up
// to full preview. Clicks/drags anywhere else on the mini orbit the
// camera (controls.enabled is true in mini mode). pointerdown is also
// stopped here so OrbitControls doesn't start an orbit underneath
// the button click.
document.getElementById('expand-preview')?.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
});
document.getElementById('expand-preview')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (viewMode !== 'edit') return;
  setViewMode('preview');
});

// Safety net for OrbitControls — re-dispatch pointerup to the renderer
// canvas whenever pointerup fires on the window but didn't land on the
// canvas itself. Belt + suspenders for the case where pointer capture
// gets lost mid-drag (was causing the mug to keep rotating with mouse
// movement after release).
window.addEventListener('pointerup', (e) => {
  const canvas = renderer?.domElement;
  if (!canvas) return;
  if (e.target === canvas || canvas.contains(e.target)) return;
  try {
    canvas.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true,
      pointerId: e.pointerId, pointerType: e.pointerType,
      clientX: e.clientX, clientY: e.clientY,
      button: e.button,
    }));
  } catch {}
});

// One-time "Arrastrá para rotar" hint on the mini.
// Shows the first time the cursor enters the mini in this session;
// dismisses on first drag (pointerdown + meaningful move) or after
// 3.5s of hovering. Once dismissed, never shows again this session.
(function initMiniHint() {
  const hint = document.getElementById('mini-hint');
  if (!hint || !viewerContainer) return;
  let shownOnce = false;
  let dismissed = false;
  let autoHideTimer = null;
  let hintPointerStart = null;

  function show() {
    if (dismissed || shownOnce || viewMode !== 'edit') return;
    hint.hidden = false;
    requestAnimationFrame(() => hint.classList.add('is-visible'));
    shownOnce = true;
    clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(hide, 3500);
  }
  function hide() {
    dismissed = true;
    clearTimeout(autoHideTimer);
    hint.classList.remove('is-visible');
    setTimeout(() => { hint.hidden = true; }, 320);
  }

  viewerContainer.addEventListener('pointerenter', () => {
    if (viewMode !== 'edit') return;
    show();
  });
  // Track real drag (not just a click) so the hint dismisses precisely
  // when the user actually rotates.
  viewerContainer.addEventListener('pointerdown', (e) => {
    if (viewMode !== 'edit') return;
    if (e.target.closest('.preview-expand-btn')) return;
    hintPointerStart = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointermove', (e) => {
    if (!hintPointerStart) return;
    const dx = Math.abs(e.clientX - hintPointerStart.x);
    const dy = Math.abs(e.clientY - hintPointerStart.y);
    if (dx + dy > 6) {
      hide();
      hintPointerStart = null;
    }
  });
  window.addEventListener('pointerup', () => { hintPointerStart = null; });
})();

// Prime the initial view-mode state (default = 'edit'). This unhides the
// viewer, applies the mini class, and triggers the first resizeViewer()
// so the live mockup is rendered correctly on page load.
setViewMode('edit');

// ---- Left sidebar tabs (Subir / Agregar / Producto) ----
const leftbarTabs = document.querySelectorAll('.leftbar-tab[data-panel]');
const sidePanel = document.getElementById('side-panel');
const sidePanelTitle = document.getElementById('side-panel-title');
const sidePanelClose = document.getElementById('side-panel-close');
const sidePanelSections = document.querySelectorAll('.side-panel-section');

const PANEL_TITLES = {
  design: 'DISEÑO',
  product: 'PRODUCTO',
};

function openSidePanel(panelKey) {
  sidePanel.hidden = false;
  sidePanelTitle.textContent = PANEL_TITLES[panelKey] || '';
  sidePanelSections.forEach((s) => {
    s.hidden = s.dataset.panel !== panelKey;
  });
  leftbarTabs.forEach((t) => {
    t.classList.toggle('is-active', t.dataset.panel === panelKey);
  });
}

function closeSidePanel() {
  sidePanel.hidden = true;
  leftbarTabs.forEach((t) => t.classList.remove('is-active'));
}

leftbarTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const panelKey = tab.dataset.panel;
    if (tab.classList.contains('is-active')) {
      closeSidePanel();
    } else {
      openSidePanel(panelKey);
    }
  });
});

sidePanelClose.addEventListener('click', closeSidePanel);

// Default: side panel closed. The canvas + upload button are the focus on
// first load; the Diseño / Producto panels open only when the user clicks
// their leftbar tabs.
renderLayerList();
renderActiveLayerSection();

// ---------- Smart-guide snap ----------
// During drag, snap the image edges/center to one of 6 print-area lines
// (top, bottom, left, right, horizontal centerline, vertical centerline).
// Threshold is small so the snap is a gentle nudge — not a sticky magnet.
const SNAP_PX = 8;
const snapV = document.getElementById('snap-v');
const snapH = document.getElementById('snap-h');

function clearSnaps() {
  if (snapV) snapV.hidden = true;
  if (snapH) snapH.hidden = true;
}

// Free movement with generous overflow: the image's center can move up to the
// canvas edge in each direction (so at least half the image stays visible).
// Whatever lands outside the print area is clipped visually (CSS overflow:
// hidden) but allowed — only the print-area-inside portion gets printed.
function clampLayerOffsets(layer) {
  layer.offsetX = Math.max(-0.5, Math.min(0.5, layer.offsetX));
  layer.offsetY = Math.max(-0.5, Math.min(0.5, layer.offsetY));
}

function applySnap() {
  const layer = getActiveLayer();
  if (!layer) return;
  const base = getBaseDraw();
  if (!base) return;
  const drawW = base.baseDrawW * layer.scale;
  const drawH = base.baseDrawH * layer.scale;
  const cx = EDITOR_W / 2 + layer.offsetX * EDITOR_W;
  const cy = EDITOR_H / 2 + layer.offsetY * EDITOR_H;
  const left = cx - drawW / 2;
  const right = cx + drawW / 2;
  const top = cy - drawH / 2;
  const bottom = cy + drawH / 2;

  // Print area edges + center, in editor canvas coords (canvas IS the print area).
  const paLeft = 0;
  const paRight = EDITOR_W;
  const paTop = 0;
  const paBottom = EDITOR_H;
  const paCx = EDITOR_W / 2;
  const paCy = EDITOR_H / 2;

  // Vertical snap (X axis)
  const xCands = [{ pos: cx }, { pos: left }, { pos: right }];
  const xTargets = [paCx, paLeft, paRight];
  let bestX = null;
  for (const c of xCands) {
    for (const t of xTargets) {
      const d = t - c.pos;
      if (Math.abs(d) < SNAP_PX && (bestX === null || Math.abs(d) < Math.abs(bestX.delta))) {
        bestX = { delta: d, target: t };
      }
    }
  }
  if (bestX) {
    layer.offsetX += bestX.delta / EDITOR_W;
    clampLayerOffsets(layer);
    if (snapV) {
      snapV.hidden = false;
      snapV.style.left = `${(bestX.target / EDITOR_W) * 100}%`;
    }
  } else if (snapV) {
    snapV.hidden = true;
  }

  // Horizontal snap (Y axis)
  const yCands = [{ pos: cy }, { pos: top }, { pos: bottom }];
  const yTargets = [paCy, paTop, paBottom];
  let bestY = null;
  for (const c of yCands) {
    for (const t of yTargets) {
      const d = t - c.pos;
      if (Math.abs(d) < SNAP_PX && (bestY === null || Math.abs(d) < Math.abs(bestY.delta))) {
        bestY = { delta: d, target: t };
      }
    }
  }
  if (bestY) {
    layer.offsetY += bestY.delta / EDITOR_H;
    clampLayerOffsets(layer);
    if (snapH) {
      snapH.hidden = false;
      snapH.style.top = `${(bestY.target / EDITOR_H) * 100}%`;
    }
  } else if (snapH) {
    snapH.hidden = true;
  }
}

// Drag the image bbox to update offsetX/offsetY. Pointer Events handle both
// mouse and touch. Clicks landing on a corner handle are skipped here so the
// handle's own resize logic takes over.
let dragging = false;
let dragLast = null;

// Hit-test layers in reverse paint order (topmost first). Returns the layer
// whose drawn rect contains (px, py) in EDITOR_W × EDITOR_H pixel space, or null.
function hitTestLayers(px, py) {
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const layer = state.layers[i];
    if (!layer.imageBitmap) continue;
    const { baseW, baseH } = layerBaseDraw(layer, EDITOR_W, EDITOR_H);
    const drawW = baseW * layer.scale;
    const drawH = baseH * layer.scale;
    const drawX = (EDITOR_W - drawW) / 2 + layer.offsetX * EDITOR_W;
    const drawY = (EDITOR_H - drawH) / 2 + layer.offsetY * EDITOR_H;
    if (px >= drawX && px <= drawX + drawW && py >= drawY && py <= drawY + drawH) {
      return layer;
    }
  }
  return null;
}

// Click on the active bbox → drag the active layer. Resize handles short-circuit.
imageBbox.addEventListener('pointerdown', (e) => {
  if (!getActiveLayer()) return;
  if (e.target.classList.contains('ed2-handle')) return;
  dragging = true;
  dragLast = { x: e.clientX, y: e.clientY };
  imageBbox.setPointerCapture(e.pointerId);
  e.preventDefault();
});

// Drop the active selection: clears the bbox + collapses the contextual
// "Editar capa" subsection. Triggered by clicks on empty canvas area
// (Figma / Canva / Fourthwall convention).
function deselectActiveLayer() {
  if (!state.activeLayerId) return;
  state.activeLayerId = null;
  drawTexture();
  syncAllSliders();
  renderLayerList();
  renderActiveLayerSection();
}

// Click on the canvas (outside the active bbox) → hit-test underlying layers.
// If a layer is hit, make it active and start dragging it. The bbox handler
// above takes care of clicks INSIDE the active bbox; here we handle clicks
// OUTSIDE it that may land on a partially-visible non-active layer, OR on
// completely empty canvas area — the latter deselects.
canvasWrap.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.ed2-bbox')) return;        // active bbox handles itself
  if (e.target.closest('.ed2-handle')) return;      // resize handles handle themselves
  const wrapRect = canvasWrap.getBoundingClientRect();
  const px = ((e.clientX - wrapRect.left) / wrapRect.width) * EDITOR_W;
  const py = ((e.clientY - wrapRect.top)  / wrapRect.height) * EDITOR_H;
  const hit = hitTestLayers(px, py);
  if (!hit) {
    // Empty area inside the canvas → deselect
    deselectActiveLayer();
    return;
  }
  if (state.activeLayerId !== hit.id) setActiveLayer(hit.id);
  dragging = true;
  dragLast = { x: e.clientX, y: e.clientY };
  canvasWrap.setPointerCapture(e.pointerId);
  e.preventDefault();
});

// Click on the canvas-edit area OUTSIDE the canvas-wrap (e.g. on the surrounding
// background, on the mug icons, on the labels) → also deselect. Skip clicks
// that fall inside canvas-wrap (the handler above owns those) and clicks on
// the live mockup mini, the side panel, etc. (those bubble through different
// elements and aren't descendants of canvas-edit).
canvasEdit.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#canvas-wrap')) return;
  if (e.target.closest('.ed2-bbox')) return;
  if (e.target.closest('.ed2-handle')) return;
  deselectActiveLayer();
});

// Window-level pointermove handles drag from EITHER initiation path (bbox
// click or canvas-wrap hit-test). This is essential because when canvas-wrap
// initiates the drag, the new bbox jumps to the freshly-activated layer and
// subsequent moves are no longer over the original element.
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const layer = getActiveLayer();
  if (!layer) return;
  const wrapRect = canvasWrap.getBoundingClientRect();
  const dx = (e.clientX - dragLast.x) / wrapRect.width;
  const dy = (e.clientY - dragLast.y) / wrapRect.height;
  layer.offsetX += dx;
  layer.offsetY += dy;
  clampLayerOffsets(layer);
  dragLast = { x: e.clientX, y: e.clientY };
  applySnap();
  drawTexture();
  syncOffsetSliders();
});

const stopDrag = () => { dragging = false; clearSnaps(); };
// Safety net: window-level pointerup ALWAYS releases drag state, even if
// the bbox lost pointer capture mid-drag (browser quirks, alt-tab, etc.)
window.addEventListener('pointerup', stopDrag);
window.addEventListener('pointercancel', stopDrag);
window.addEventListener('blur', stopDrag);
// Same belt-and-suspenders for OrbitControls: when window blurs or the
// pointer is released anywhere, dispatch a synthetic pointerup to the
// renderer canvas so three.js releases its internal drag state.
function nudgeOrbitRelease() {
  const el = renderer?.domElement;
  if (!el) return;
  try {
    el.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1, button: 0,
    }));
  } catch {}
}
window.addEventListener('blur', nudgeOrbitRelease);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) nudgeOrbitRelease();
});

// ---------- Resize via corner handles ----------
// Drag a corner: opposite corner is the anchor (stays fixed), aspect ratio is
// maintained, scale + offset are derived from the new bbox dimensions.
function syncScaleSlider() {
  const layer = getActiveLayer();
  const el = document.getElementById('scale');
  const val = document.getElementById('scale-val');
  const s = layer ? layer.scale : 1;
  if (el) el.value = s;
  if (val) val.textContent = `${Math.round(s * 100)}%`;
}

function getBaseDraw() {
  const layer = getActiveLayer();
  if (!layer) return null;
  const { baseW, baseH, imgRatio } = layerBaseDraw(layer, EDITOR_W, EDITOR_H);
  return { baseDrawW: baseW, baseDrawH: baseH, imgRatio };
}

let resizing = null;

// Center-anchored resize: the layer's center stays fixed and the bbox grows
// or shrinks symmetrically based on pointer distance from center. Same UX as
// the existing Gudink editor for tshirts and frames. Position (offsetX/Y)
// stays unchanged during resize — only the active layer's scale moves.
const handles = imageBbox.querySelectorAll('.ed2-handle');
handles.forEach((handle) => {
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const layer = getActiveLayer();
    if (!layer) return;
    const base = getBaseDraw();
    if (!base) return;
    const cx = EDITOR_W / 2 + layer.offsetX * EDITOR_W;
    const cy = EDITOR_H / 2 + layer.offsetY * EDITOR_H;
    resizing = { center: { x: cx, y: cy }, base, layerId: layer.id };
  });
});

window.addEventListener('pointermove', (e) => {
  if (!resizing) return;
  const layer = state.layers.find((l) => l.id === resizing.layerId);
  if (!layer) { resizing = null; return; }
  const wrapRect = canvasWrap.getBoundingClientRect();
  const px = ((e.clientX - wrapRect.left) / wrapRect.width) * EDITOR_W;
  const py = ((e.clientY - wrapRect.top)  / wrapRect.height) * EDITOR_H;
  const halfW = Math.abs(px - resizing.center.x);
  const halfH = Math.abs(py - resizing.center.y);
  const ratio = resizing.base.imgRatio;
  let bboxW;
  if (halfW * 2 / ratio > halfH * 2) {
    bboxW = halfW * 2;
  } else {
    bboxW = halfH * 2 * ratio;
  }
  let newScale = bboxW / resizing.base.baseDrawW;
  newScale = Math.max(0.2, Math.min(5.0, newScale));
  layer.scale = newScale;
  clampLayerOffsets(layer);
  drawTexture();
  syncScaleSlider();
});

window.addEventListener('pointerup', () => { resizing = null; });
window.addEventListener('pointercancel', () => { resizing = null; });

// Initialise bbox visibility on first paint
updateImageBbox();

// ---------- Quick actions (Centrar / Ajustar / Llenar) ----------
function syncAllSliders() {
  syncOffsetSliders();
  syncScaleSlider();
}

document.getElementById('qa-center')?.addEventListener('click', () => {
  const layer = getActiveLayer();
  if (!layer) return;
  // "Centrar" only zeroes the design's offsets within the print area.
  // The 3D camera is independent — user controls it via orbit drag.
  layer.offsetX = 0;
  layer.offsetY = 0;
  drawTexture();
  syncAllSliders();
});

// Ajustar: scale = 1 (fit), re-center vertically. Horizontal offset preserved.
document.getElementById('qa-fit')?.addEventListener('click', () => {
  const layer = getActiveLayer();
  if (!layer) return;
  layer.scale = 1;
  layer.offsetY = 0;
  clampLayerOffsets(layer);
  drawTexture();
  syncAllSliders();
});

// Llenar: scale so the image's drawn width = print area width (cover-width
// guarantee). The image always fills the canvas edge-to-edge horizontally.
// Vertical: portrait/most landscapes overflow top/bottom (clipped by CSS);
// very wide panoramas (aspect > 2.41) sit centered with vertical margin.
document.getElementById('qa-fill')?.addEventListener('click', () => {
  const layer = getActiveLayer();
  if (!layer) return;
  const base = getBaseDraw();
  if (!base) return;
  const fillScale = EDITOR_W / base.baseDrawW;
  layer.scale = Math.min(5.0, fillScale);
  layer.offsetX = 0;
  layer.offsetY = 0;
  drawTexture();
  syncAllSliders();
});

// ---------- Layer management ----------
function deleteLayer(layerId) {
  const idx = state.layers.findIndex((l) => l.id === layerId);
  if (idx === -1) return;
  const [removed] = state.layers.splice(idx, 1);
  if (removed.imageBitmap?.close) removed.imageBitmap.close();
  if (state.activeLayerId === layerId) {
    state.activeLayerId = state.layers.length
      ? state.layers[Math.min(idx, state.layers.length - 1)].id
      : null;
  }
  drawTexture();
  syncAllSliders();
  renderLayerList();
  renderActiveLayerSection();
}

function setActiveLayer(layerId) {
  const layer = state.layers.find((l) => l.id === layerId);
  if (!layer) return;
  state.activeLayerId = layerId;
  drawTexture();
  syncAllSliders();
  renderLayerList();
  renderActiveLayerSection();
}

// Re-render the layer list panel from state. Called on add / remove /
// activate. Items appear in REVERSE array order so the topmost layer
// (last in array, painted on top) is at the top of the list — standard
// design-tool convention.
function renderLayerList() {
  const list = document.getElementById('layer-list');
  const count = document.getElementById('layer-count');
  const dz = document.getElementById('upload-dropzone');
  const primary = document.getElementById('dropzone-primary');
  if (!list) return;

  if (count) count.textContent = `${state.layers.length}/${MAX_LAYERS}`;

  if (state.layers.length === 0) {
    list.hidden = true;
    list.innerHTML = '';
  } else {
    list.hidden = false;
    list.innerHTML = '';
    // Reverse so newer/top layers appear at the top of the list.
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const layer = state.layers[i];
      const item = document.createElement('div');
      item.className = 'layer-item';
      if (layer.id === state.activeLayerId) item.classList.add('is-active');
      item.dataset.layerId = layer.id;
      const positionLabel = `Capa ${i + 1}`;

      const thumb = document.createElement('img');
      thumb.className = 'layer-thumb';
      thumb.src = layer.thumbDataUrl;
      thumb.alt = '';
      item.appendChild(thumb);

      const label = document.createElement('span');
      label.className = 'layer-label';
      label.textContent = positionLabel;
      item.appendChild(label);

      const actions = document.createElement('div');
      actions.className = 'layer-actions';

      const upBtn = document.createElement('button');
      upBtn.className = 'layer-action-btn';
      upBtn.dataset.action = 'up';
      upBtn.title = 'Subir capa';
      upBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
      if (i === state.layers.length - 1) upBtn.disabled = true;
      actions.appendChild(upBtn);

      const dnBtn = document.createElement('button');
      dnBtn.className = 'layer-action-btn';
      dnBtn.dataset.action = 'down';
      dnBtn.title = 'Bajar capa';
      dnBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
      if (i === 0) dnBtn.disabled = true;
      actions.appendChild(dnBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'layer-action-btn layer-action-btn--danger';
      delBtn.dataset.action = 'delete';
      delBtn.title = 'Eliminar capa';
      delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      actions.appendChild(delBtn);

      item.appendChild(actions);
      list.appendChild(item);
    }
  }

  // Toggle dropzone enabled state at max layers.
  if (dz && primary) {
    const atLimit = state.layers.length >= MAX_LAYERS;
    dz.classList.toggle('is-disabled', atLimit);
    primary.textContent = atLimit
      ? `Máximo ${MAX_LAYERS} capas`
      : (state.layers.length === 0 ? 'Subir imagen' : 'Agregar capa');
  }

  // Canvas upload button shows in empty state only.
  // (Placement Zone Guide visibility is driven by updateImageBbox(), which
  // ties it to layer selection — matches Fourthwall's "guide on selection".)
  const empty = state.layers.length === 0;
  const canvasUploadBtn = document.getElementById('canvas-upload-btn');
  if (canvasUploadBtn) canvasUploadBtn.hidden = !empty;
}

// Canvas upload button click → trigger file input (same as dropzone).
document.getElementById('canvas-upload-btn')?.addEventListener('click', () => {
  document.getElementById('file-input')?.click();
});

// Single delegated listener on the layer list — handles select, delete,
// and reorder. Each item carries data-layer-id; each action button carries
// data-action.
document.getElementById('layer-list')?.addEventListener('click', (e) => {
  const item = e.target.closest('.layer-item');
  if (!item) return;
  const layerId = item.dataset.layerId;
  const actionBtn = e.target.closest('.layer-action-btn');
  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.action;
    if (action === 'delete') {
      deleteLayer(layerId);
    } else if (action === 'up' || action === 'down') {
      reorderLayer(layerId, action === 'up' ? 1 : -1);
    }
    return;
  }
  setActiveLayer(layerId);
});

// Move a layer up (+1, paints later → on top) or down (-1, paints earlier).
function reorderLayer(layerId, delta) {
  const idx = state.layers.findIndex((l) => l.id === layerId);
  if (idx === -1) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= state.layers.length) return;
  const [layer] = state.layers.splice(idx, 1);
  state.layers.splice(newIdx, 0, layer);
  drawTexture();
  renderLayerList();
  renderActiveLayerSection();
}

// Toggle the contextual "Editar capa" subsection inside the Diseño tab
// based on whether an active layer exists. When visible, updates the
// header to reflect the active layer's display name (e.g. "Capa 2"),
// computed from the current array index so it stays correct after
// reorder/delete.
function renderActiveLayerSection() {
  const section = document.getElementById('editar-capa-section');
  const nameEl = document.getElementById('editar-capa-name');
  if (!section) return;
  const layer = getActiveLayer();
  if (!layer) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (nameEl) {
    const idx = state.layers.findIndex((l) => l.id === layer.id);
    nameEl.textContent = `Capa ${idx + 1}`;
  }
}

// "Eliminar imagen" button + Delete/Backspace key both delete the active layer.
function deleteActive() {
  const layer = getActiveLayer();
  if (!layer) return;
  deleteLayer(layer.id);
}

// Standalone "Eliminar imagen" button is gone — the per-layer X in the
// layer list and the Delete/Backspace key both still delete the active
// layer via deleteActive().

window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (getActiveLayer()) {
      e.preventDefault();
      deleteActive();
    }
  }
});

// Render every frame in BOTH modes — the live mini-mockup in edit mode
// updates as the user manipulates layers (CanvasTexture re-uploads on
// every drawTexture call). Only run controls.update() in preview mode
// since orbit is disabled in mini mode.
function tick() {
  requestAnimationFrame(tick);
  if (viewMode === 'preview') controls.update();
  renderer.render(scene, camera);
}
tick();
