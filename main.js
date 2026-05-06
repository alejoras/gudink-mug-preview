import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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

const MAX_LAYERS = 5;

// Each layer: { id, imageBitmap, thumbDataUrl, name, scale, offsetX, offsetY }
// Layers paint in array order (index 0 first, last index on top). The active
// layer is the one whose bbox is shown and that the sliders/handles modify.
const state = {
  bodyColor: '#ffffff',
  wrapMode: 'front',
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
// Default product-hero angle: ~60° rotated from front, slight elevation,
// so the handle is visible on the LEFT of the frame and the printed
// design wraps around to the RIGHT. This matches standard print-on-
// demand product photography (Printful, Printify, Fourthwall) and is
// what users expect to see in the live mockup mini panel + initial
// preview. The "Frente" preset in the mockup gallery still shows a
// dead-front view as a distinct angle.
const DEFAULT_POS = new THREE.Vector3(0.18, 0.045, 0.10);
const DEFAULT_TARGET = new THREE.Vector3(0, 0, 0);
camera.position.copy(DEFAULT_POS);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(DEFAULT_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.10;
controls.maxDistance = 0.60;
controls.enablePan = true;

// ---------- Lighting (slightly warm key, cool rim) ----------
scene.add(new THREE.AmbientLight(0xfff8ee, 0.30));

// Key intensity lowered from 1.6 to 1.05 — combined with low-roughness
// glaze + clearcoat, the previous value was over-illuminating bright
// regions of the printed texture and washing them out.
const keyLight = new THREE.DirectionalLight(0xfff5e6, 1.05);
keyLight.position.set(0.25, 0.45, 0.30);
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
rimLight.position.set(-0.30, 0.20, -0.25);
scene.add(rimLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.20);
fillLight.position.set(-0.05, -0.20, 0.30);
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
const texCanvas = document.createElement('canvas');
texCanvas.width = TEX_W;
texCanvas.height = TEX_H;
const texCtx = texCanvas.getContext('2d');

const mugTexture = new THREE.CanvasTexture(texCanvas);
mugTexture.colorSpace = THREE.SRGBColorSpace;
mugTexture.wrapS = THREE.RepeatWrapping;
mugTexture.wrapT = THREE.ClampToEdgeWrapping;
mugTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
// Cylinder UV starts at +Z (camera-facing). Offset 0.5 puts the canvas seam at
// the back of the mug; the image, centered at canvas U=0.5, lands on the front.
mugTexture.offset.x = 0.5;

// Letterbox fractions for the print area inside the full unwrapped canvas.
// 0.991 × 0.977 ≈ uniform 1mm bleed on a 257.6 × 91 mm cylinder unwrap.
const PRINT_AREA_W_FRAC_FRONT = 0.991;
const PRINT_AREA_W_FRAC_FULL = 1.0;
const PRINT_AREA_H_FRAC = 0.977;

function getPrintAreaFracs() {
  return {
    wFrac: state.wrapMode === 'full' ? PRINT_AREA_W_FRAC_FULL : PRINT_AREA_W_FRAC_FRONT,
    hFrac: PRINT_AREA_H_FRAC,
  };
}

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

// Paint all layers into ctx of size w × h. The ratio between (w, h) and the
// print area inside is constant (the print area is letterboxed by wFrac/hFrac
// of total). Used by both drawTexture (texCanvas at TEX_W × TEX_H) and the
// print exporter (high-res offscreen canvas).
function paintLayers(ctx, w, h, opts = {}) {
  if (opts.fillBg !== false) {
    ctx.fillStyle = state.bodyColor;
    ctx.fillRect(0, 0, w, h);
  }
  const { wFrac, hFrac } = getPrintAreaFracs();
  const printAreaW = w * wFrac;
  const printAreaH = h * hFrac;
  const printAreaX = (w - printAreaW) / 2;
  const printAreaY = (h - printAreaH) / 2;

  ctx.imageSmoothingQuality = 'high';
  for (const layer of state.layers) {
    if (!layer.imageBitmap) continue;
    const { baseW, baseH } = layerBaseDraw(layer, printAreaW, printAreaH);
    const drawW = baseW * layer.scale;
    const drawH = baseH * layer.scale;
    const drawX = printAreaX + (printAreaW - drawW) / 2 + layer.offsetX * w;
    const drawY = printAreaY + (printAreaH - drawH) / 2 + layer.offsetY * h;
    ctx.drawImage(layer.imageBitmap, drawX, drawY, drawW, drawH);
  }
}

function drawTexture() {
  paintLayers(texCtx, TEX_W, TEX_H);
  mugTexture.needsUpdate = true;
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
  const { wFrac, hFrac } = getPrintAreaFracs();
  const { baseW, baseH } = layerBaseDraw(layer, TEX_W * wFrac, TEX_H * hFrac);
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

// 1. Printable body cylinder (between the two rounded edges)
const body = new THREE.Mesh(
  new THREE.CylinderGeometry(MUG.topRadius, MUG.bottomRadius, bodyHeight, 128, 1, true),
  bodyMat
);
body.castShadow = true;
body.receiveShadow = true;
mugGroup.add(body);

// 2. Top assembly (LatheGeometry): rim curl (180 deg) + inner wall + small inner-floor fillet + flat
//    Profile is walked CCW so outer-rim normals point outward and inner-wall normals point inward.
const rimCurl = arc2D(MUG.topRadius - r, cylTop, r, 0, Math.PI, 24);
const fillR = 0.0015;
const innerCornerCenter = { x: innerRbot - fillR, y: innerFloor + fillR };
const innerCornerArc = arc2D(innerCornerCenter.x, innerCornerCenter.y, fillR, 0, -Math.PI / 2, 8);

const topProfile = [
  ...rimCurl,                                      // (Rt, cylTop) ... over the rim ... (Rt - 2r, cylTop)
  // implicit straight line down the inner wall to the start of the floor fillet
  ...innerCornerArc,                               // ends at (innerRbot - fillR, innerFloor)
  new THREE.Vector2(0, innerFloor),                // flat across the inner bottom to the centre
];
const topAssembly = new THREE.Mesh(
  new THREE.LatheGeometry(topProfile, 128),
  ceramicMat
);
topAssembly.castShadow = true;
topAssembly.receiveShadow = true;
mugGroup.add(topAssembly);

// 3. Bottom assembly (LatheGeometry): bottom flat + outer rounded corner
//    Profile walks centre-out so the bottom face's normal points down.
const bottomCorner = arc2D(MUG.bottomRadius - r, cylBot, r, -Math.PI / 2, 0, 16);
const bottomProfile = [
  new THREE.Vector2(0, -MUG.height / 2),
  ...bottomCorner,                                 // (Rb-r, -H/2) ... (Rb, cylBot)
];
const bottomAssembly = new THREE.Mesh(
  new THREE.LatheGeometry(bottomProfile, 128),
  ceramicMat
);
bottomAssembly.castShadow = true;
bottomAssembly.receiveShadow = true;
mugGroup.add(bottomAssembly);

// 4. Handle: TubeGeometry along a stadium-shaped centerline.
//    Path (top → bottom): phantom inside body → top attach → top horizontal
//    shelf → quarter-arc top corner → outer straight → quarter-arc bottom
//    corner → bottom horizontal shelf → bottom attach → phantom inside body.
const handlePts = [];
const vR = MUG.handleVertR;
const hExt = MUG.handleHorizExt;
const Rc = MUG.handleCornerR;
const eD = MUG.handleEmbed;
const ARC_N = 10;
const STR_N = 4;

// Top phantom + attachment + shelf
handlePts.push(new THREE.Vector3(-eD, vR, 0));
handlePts.push(new THREE.Vector3(0, vR, 0));
handlePts.push(new THREE.Vector3(hExt, vR, 0));

// Top corner: quarter arc from (hExt, vR) to (hExt + Rc, vR - Rc), centered at (hExt, vR - Rc)
for (let i = 1; i <= ARC_N; i++) {
  const a = (Math.PI / 2) * (1 - i / ARC_N);
  handlePts.push(new THREE.Vector3(
    hExt + Rc * Math.cos(a),
    (vR - Rc) + Rc * Math.sin(a),
    0
  ));
}

// Outer straight (vertical down) — intermediate samples between the two corners
const outerLen = 2 * (vR - Rc);
for (let i = 1; i < STR_N; i++) {
  handlePts.push(new THREE.Vector3(
    hExt + Rc,
    (vR - Rc) - (i / STR_N) * outerLen,
    0
  ));
}

// Bottom corner: quarter arc from (hExt + Rc, -vR + Rc) to (hExt, -vR), centered at (hExt, -vR + Rc)
for (let i = 0; i <= ARC_N; i++) {
  const a = -(Math.PI / 2) * (i / ARC_N);
  handlePts.push(new THREE.Vector3(
    hExt + Rc * Math.cos(a),
    (-vR + Rc) + Rc * Math.sin(a),
    0
  ));
}

// Bottom shelf + attachment + phantom
handlePts.push(new THREE.Vector3(0, -vR, 0));
handlePts.push(new THREE.Vector3(-eD, -vR, 0));

const handleCurve = new THREE.CatmullRomCurve3(handlePts, false, 'catmullrom', 0.5);
const handle = new THREE.Mesh(
  new THREE.TubeGeometry(handleCurve, 160, MUG.handleTube, 20, false),
  ceramicMat
);
// Handle lives at the BACK of the mug (-Z) so the front (+Z) — which is what
// canvas U=0.5 maps to via mugTexture.offset.x = 0.5 — is the line OPPOSITE
// the handle. This matches the print-on-demand convention where the canvas
// seam is at the handle and the canvas center is the far side of the cylinder.
// Default camera looks at +Z so the print is centered in view; the handle is
// hidden behind the cylinder until the user orbits around.
handle.position.set(0, 0, -MUG.topRadius);
handle.rotation.y = Math.PI / 2;
handle.scale.z = MUG.handleZScale;
handle.castShadow = true;
handle.receiveShadow = true;
mugGroup.add(handle);

function updateBodyColor(hex) {
  state.bodyColor = hex;
  ceramicMat.color.set(hex);
  drawTexture();
}

drawTexture();

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
        offsetX: 0,
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
    hint.classList.add('hidden');
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

// ---------- UI controls ----------
document.getElementById('reset-view').addEventListener('click', () => {
  camera.position.copy(DEFAULT_POS);
  controls.target.copy(DEFAULT_TARGET);
  controls.update();
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

const MOCKUP_PRESETS = [
  { id: 'front',         name: 'Frente',                pos: [0,     0.05, 0.22], target: [0, 0, 0]     },
  { id: 'three-quarter', name: 'Tres cuartos derecho',  pos: [0.13,  0.05, 0.18], target: [0, 0, 0]     },
  { id: 'profile-right', name: 'Perfil derecho',        pos: [0.20,  0.05, 0.10], target: [0, 0, 0]     },
  { id: 'profile-left',  name: 'Perfil izquierdo',      pos: [-0.20, 0.05, 0.10], target: [0, 0, 0]     },
  { id: 'top-angle',     name: 'Vista superior',        pos: [0,     0.16, 0.18], target: [0,-0.02, 0]  },
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
// Front-panel: 228.6 × 88.9 mm (Printful 11oz spec) → 2700 × 1050 px @ 300 DPI
// Full wrap:   257.6 × 91.4 mm (cylinder circumference × bodyHeight) → matched
const PRINT_DPI = 300;
const MM_PER_INCH = 25.4;

function exportPrintFile() {
  if (state.layers.length === 0) {
    alert('Subí al menos una imagen antes de exportar el archivo de impresión.');
    return;
  }
  // Physical print dimensions (mm) — front-panel uses Printful's published
  // 11oz spec; full wrap uses the actual cylinder circumference & height.
  const circumferenceMm = 2 * Math.PI * MUG.topRadius * 1000;
  const bodyHeightMm = bodyHeight * 1000;
  const wMm = state.wrapMode === 'full' ? circumferenceMm : 228.6;
  const hMm = state.wrapMode === 'full' ? bodyHeightMm * PRINT_AREA_H_FRAC : 88.9;
  const printPxW = Math.round(wMm / MM_PER_INCH * PRINT_DPI);
  const printPxH = Math.round(hMm / MM_PER_INCH * PRINT_DPI);

  // Render the full virtual unwrap proportionally so the print area maps
  // exactly to printPxW × printPxH after cropping out the bleed letterbox.
  const { wFrac, hFrac } = getPrintAreaFracs();
  const fullW = Math.round(printPxW / wFrac);
  const fullH = Math.round(printPxH / hFrac);

  const work = document.createElement('canvas');
  work.width = fullW;
  work.height = fullH;
  const wctx = work.getContext('2d');
  // Transparent background — printers want alpha 0 outside the design.
  paintLayers(wctx, fullW, fullH, { fillBg: false });

  const cropX = Math.round((fullW - printPxW) / 2);
  const cropY = Math.round((fullH - printPxH) / 2);
  const out = document.createElement('canvas');
  out.width = printPxW;
  out.height = printPxH;
  out.getContext('2d').drawImage(
    work,
    cropX, cropY, printPxW, printPxH,
    0, 0, printPxW, printPxH,
  );

  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const tag = state.wrapMode === 'full' ? 'wrap' : 'front';
    a.download = `mug-print-${tag}-${printPxW}x${printPxH}-300dpi.png`;
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

// Wrap mode is hard-coded to 'front' (panel frontal 270°) in v1 — covers
// ~99% of mug SKUs. The 'full' (360°) code path stays in getPrintAreaFracs
// and exportPrintFile for future re-exposure as a separate product variant.

// Compute and display the printable area in cm. Derived from MUG.topRadius
// (cylinder circumference) and bodyHeight, so if the geometry changes the
// readout follows. Frontend mode = 88.7% of circumference (Printful spec for
// 11oz: 228.6 × 88.9 mm); full wrap mode = 100% circumference.
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
  const wFrac = state.wrapMode === 'full' ? 1 : 0.991;
  const hFrac = 0.977;
  const circumferenceMm = 2 * Math.PI * MUG.topRadius * 1000;
  const wMm = wFrac * circumferenceMm;
  const hMm = hFrac * bodyHeight * 1000;
  el.textContent = `${(wMm / 10).toFixed(1)} × ${(hMm / 10).toFixed(1)} cm`;
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
  if (!layer) {
    bbox.hidden = true;
    return;
  }
  bbox.hidden = false;

  const { wFrac, hFrac } = getPrintAreaFracs();
  const printAreaW = TEX_W * wFrac;
  const printAreaH = TEX_H * hFrac;
  const printAreaX = (TEX_W - printAreaW) / 2;
  const printAreaY = (TEX_H - printAreaH) / 2;

  const { baseW, baseH } = layerBaseDraw(layer, printAreaW, printAreaH);
  const drawW = baseW * layer.scale;
  const drawH = baseH * layer.scale;
  const drawX = printAreaX + (printAreaW - drawW) / 2 + layer.offsetX * TEX_W;
  const drawY = printAreaY + (printAreaH - drawH) / 2 + layer.offsetY * TEX_H;

  bbox.style.left = `${(drawX / TEX_W) * 100}%`;
  bbox.style.top = `${(drawY / TEX_H) * 100}%`;
  bbox.style.width = `${(drawW / TEX_W) * 100}%`;
  bbox.style.height = `${(drawH / TEX_H) * 100}%`;

  // Live size chip — convert canvas px to cm via the isotropic mm/px
  // ratio (same constant as DPI calc). Display as "W × H cm" with one
  // decimal, mirroring the dimensions readout convention below the canvas.
  const sizeEl = document.getElementById('bbox-size-text');
  if (sizeEl) {
    const wCm = (drawW * MM_PER_CANVAS_PX) / 10;
    const hCm = (drawH * MM_PER_CANVAS_PX) / 10;
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

// Default: open Diseño panel so the user lands on the layer list / dropzone.
openSidePanel('design');
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

function applySnap() {
  const layer = getActiveLayer();
  if (!layer) return;
  const base = getBaseDraw();
  if (!base) return;
  const drawW = base.baseDrawW * layer.scale;
  const drawH = base.baseDrawH * layer.scale;
  const cx = TEX_W / 2 + layer.offsetX * TEX_W;
  const cy = TEX_H / 2 + layer.offsetY * TEX_H;
  const left = cx - drawW / 2;
  const right = cx + drawW / 2;
  const top = cy - drawH / 2;
  const bottom = cy + drawH / 2;

  const { wFrac, hFrac } = getPrintAreaFracs();
  const printAreaW = TEX_W * wFrac;
  const printAreaH = TEX_H * hFrac;
  const paLeft = (TEX_W - printAreaW) / 2;
  const paRight = paLeft + printAreaW;
  const paTop = (TEX_H - printAreaH) / 2;
  const paBottom = paTop + printAreaH;
  const paCx = TEX_W / 2;
  const paCy = TEX_H / 2;

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
    layer.offsetX = Math.max(-0.5, Math.min(0.5, layer.offsetX + bestX.delta / TEX_W));
    if (snapV) {
      snapV.hidden = false;
      snapV.style.left = `${(bestX.target / TEX_W) * 100}%`;
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
    layer.offsetY = Math.max(-0.4, Math.min(0.4, layer.offsetY + bestY.delta / TEX_H));
    if (snapH) {
      snapH.hidden = false;
      snapH.style.top = `${(bestY.target / TEX_H) * 100}%`;
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
// whose drawn rect contains (px, py) in TEX_W × TEX_H pixel space, or null.
function hitTestLayers(px, py) {
  const { wFrac, hFrac } = getPrintAreaFracs();
  const printAreaW = TEX_W * wFrac;
  const printAreaH = TEX_H * hFrac;
  const printAreaX = (TEX_W - printAreaW) / 2;
  const printAreaY = (TEX_H - printAreaH) / 2;
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const layer = state.layers[i];
    if (!layer.imageBitmap) continue;
    const { baseW, baseH } = layerBaseDraw(layer, printAreaW, printAreaH);
    const drawW = baseW * layer.scale;
    const drawH = baseH * layer.scale;
    const drawX = printAreaX + (printAreaW - drawW) / 2 + layer.offsetX * TEX_W;
    const drawY = printAreaY + (printAreaH - drawH) / 2 + layer.offsetY * TEX_H;
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
  const px = ((e.clientX - wrapRect.left) / wrapRect.width) * TEX_W;
  const py = ((e.clientY - wrapRect.top)  / wrapRect.height) * TEX_H;
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
  layer.offsetX = Math.max(-0.5, Math.min(0.5, layer.offsetX + dx));
  layer.offsetY = Math.max(-0.4, Math.min(0.4, layer.offsetY + dy));
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
  const { wFrac, hFrac } = getPrintAreaFracs();
  const { baseW, baseH, imgRatio } = layerBaseDraw(
    layer, TEX_W * wFrac, TEX_H * hFrac,
  );
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
    const cx = TEX_W / 2 + layer.offsetX * TEX_W;
    const cy = TEX_H / 2 + layer.offsetY * TEX_H;
    resizing = { center: { x: cx, y: cy }, base, layerId: layer.id };
  });
});

window.addEventListener('pointermove', (e) => {
  if (!resizing) return;
  const layer = state.layers.find((l) => l.id === resizing.layerId);
  if (!layer) { resizing = null; return; }
  const wrapRect = canvasWrap.getBoundingClientRect();
  const px = ((e.clientX - wrapRect.left) / wrapRect.width) * TEX_W;
  const py = ((e.clientY - wrapRect.top)  / wrapRect.height) * TEX_H;
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
  layer.offsetX = 0;
  layer.offsetY = 0;
  drawTexture();
  syncAllSliders();
});

// Ajustar: reset scale to "fit" (1.0) and re-center vertically. Horizontal
// position is preserved so the user can keep the image on the left/center/
// right side of the mug.
document.getElementById('qa-fit')?.addEventListener('click', () => {
  const layer = getActiveLayer();
  if (!layer) return;
  layer.scale = 1;
  layer.offsetY = 0;
  drawTexture();
  syncAllSliders();
});

// Llenar: scale up so the image fills the print area on its tighter axis,
// then center both axes — at fill scale the image is bigger than the print
// area, so any off-center offset would push pixels off the mug.
document.getElementById('qa-fill')?.addEventListener('click', () => {
  const layer = getActiveLayer();
  if (!layer) return;
  const base = getBaseDraw();
  if (!base) return;
  const { wFrac, hFrac } = getPrintAreaFracs();
  const printAreaW = TEX_W * wFrac;
  const printAreaH = TEX_H * hFrac;
  const fillScale = Math.max(
    printAreaW / base.baseDrawW,
    printAreaH / base.baseDrawH,
  );
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
  if (state.layers.length === 0) hint.classList.remove('hidden');
}

function setActiveLayer(layerId) {
  if (!state.layers.find((l) => l.id === layerId)) return;
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

  // Canvas upload button — show only when there are no layers.
  const canvasUploadBtn = document.getElementById('canvas-upload-btn');
  if (canvasUploadBtn) canvasUploadBtn.hidden = state.layers.length > 0;
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
