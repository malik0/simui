import * as THREE from 'three';
import {
  LayoutGrid, Orbit, Glasses, Aperture, Eye, Gamepad2, Hand, ScanEye, Gauge, Timer, Waves, Volume2, Move3d,
  Radar, Rotate3d, Globe, Shapes, Box, Network, Layers, Sparkles, Zap, Circle, Lightbulb, Cpu, Wrench,
} from 'lucide';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------- Load and parse the markdown database ----------

const files = import.meta.glob('./database/*.md', { query: '?raw', import: 'default', eager: true });

const nodes = [];
const byTitle = new Map();

for (const [path, raw] of Object.entries(files)) {
  const title = path.split('/').pop().replace(/\.md$/, '');
  const text = raw.replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = fm ? text.slice(fm[0].length) : text;
  const tags = (fm?.[1].match(/tags:\s*\[(.*?)\]/)?.[1] ?? '')
    .split(',').map((t) => t.trim()).filter(Boolean);
  const node = { title, tags, body, links: new Set(), index: nodes.length };
  nodes.push(node);
  byTitle.set(title.toLowerCase(), node);
}

const edges = [];
const edgeKeys = new Set();
for (const n of nodes) {
  for (const m of n.body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = byTitle.get(m[1].trim().toLowerCase());
    if (!target || target === n) continue;
    const key = [n.index, target.index].sort().join('-');
    n.links.add(target);
    target.links.add(n);
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push([n, target]);
    }
  }
}

const clean = (s) =>
  s.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/`/g, '');

// `raw` keeps the [[wikilink]] markup (used to make links clickable), `text` is the plain version
const bodyLines = (body) =>
  body.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).map((l) => {
    if (l.startsWith('# ')) return null; // title is drawn separately
    const img = l.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) return { type: 'img', alt: img[1], src: img[2].trim(), raw: '', text: '' };
    const item = (type, s) => ({ type, raw: s.replace(/`/g, ''), text: clean(s) });
    if (l.startsWith('## ')) return item('h', l.slice(3));
    if (/^\s*- /.test(l)) return item('li', l.replace(/^\s*- /, ''));
    return item('p', l);
  }).filter(Boolean);

for (const n of nodes) {
  n.lines = bodyLines(n.body);
  n.summary = n.lines.filter((l) => l.type !== 'h' && l.type !== 'img' && !l.text.startsWith('Back to'));
  n.image = n.lines.find((l) => l.type === 'img') ?? null;
}

// Images referenced from notes as ![caption](images/file.svg), resolved relative to database/
const imageUrls = import.meta.glob('./database/images/*', { query: '?url', import: 'default', eager: true });
const images = new Map();
await Promise.all(nodes.filter((n) => n.image).map(async (n) => {
  const url = imageUrls[`./database/${n.image.src}`];
  if (!url) return console.warn(`Image not found for "${n.title}": ${n.image.src}`);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    images.set(n.image.src, img);
  } catch {
    console.warn(`Could not load image: ${n.image.src}`);
  }
}));

// ---------- Icons (Lucide, kept as vectors) ----------

// Each note gets a Lucide glyph: by title first, then by its first tag, so new notes still get a sensible one.
const ICON_BY_TITLE = {
  'Index': LayoutGrid, 'Virtual Reality': Orbit, 'Head-Mounted Display': Glasses, 'Fresnel Lens': Aperture,
  'Interpupillary Distance': Eye, 'VR Controllers': Gamepad2, 'Hand Tracking': Hand, 'Field of View': ScanEye,
  'Frame Rate': Gauge, 'Latency': Timer, 'Motion Sickness': Waves, 'Spatial Audio': Volume2,
  'Six Degrees of Freedom': Move3d, 'Inside-Out Tracking': Radar, 'Quaternions': Rotate3d, 'WebXR': Globe,
  'WebGL': Shapes, 'Three.js': Box, 'Scene Graph': Network, 'Stereoscopic Rendering': Layers,
  'Shaders': Sparkles, 'Vite': Zap,
};
const ICON_BY_TAG = {
  concept: Lightbulb, hardware: Cpu, software: Wrench, tracking: Radar, perception: Eye, graphics: Shapes,
  input: Hand, performance: Gauge, comfort: Waves, audio: Volume2, math: Rotate3d, web: Globe, library: Box,
  tooling: Zap, optics: Aperture, index: LayoutGrid,
};

// Lucide icons are lists of [tag, attributes]; turn one into an SVG image the canvas can draw at any size
const glyphs = new Map();
await Promise.all(nodes.map(async (n) => {
  const icon = ICON_BY_TITLE[n.title] ?? ICON_BY_TAG[n.tags[0]] ?? Circle;
  const inner = icon.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 24 24" fill="none" `
    + `stroke="#ffffff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await img.decode();
    glyphs.set(n, img);
  } catch {
    console.warn(`Could not build icon for "${n.title}"`);
  }
}));

// Notes sharing a first tag share a colour (used by the graph beads and tiles)
for (const n of nodes) {
  let h = 0;
  for (const ch of n.tags[0] ?? n.title) h = (h * 31 + ch.charCodeAt(0)) % 360;
  n.hue = h / 360;
}

// ---------- 3D force-directed layout ----------

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

for (const n of nodes) {
  const u = rand() * 2 - 1, a = rand() * Math.PI * 2, r = 5 + rand() * 3;
  const s = Math.sqrt(1 - u * u);
  n.pos = new THREE.Vector3(r * s * Math.cos(a), r * u, r * s * Math.sin(a));
}

(function layout() {
  const REST = 3.6;
  for (let i = 0; i < 500; i++) {
    const cool = 1 - i / 500;
    const force = nodes.map(() => new THREE.Vector3());
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const d = new THREE.Vector3().subVectors(nodes[a].pos, nodes[b].pos);
        const len = Math.max(d.length(), 0.3);
        d.multiplyScalar(14 / (len * len * len));
        force[a].add(d);
        force[b].sub(d);
      }
    }
    for (const [a, b] of edges) {
      const d = new THREE.Vector3().subVectors(b.pos, a.pos);
      const f = d.multiplyScalar(0.06 * (d.length() - REST) / Math.max(d.length(), 0.001));
      force[a.index].add(f);
      force[b.index].sub(f);
    }
    for (const n of nodes) {
      force[n.index].addScaledVector(n.pos, -0.015);
      const step = force[n.index].clampLength(0, 0.6 * cool + 0.02);
      n.pos.add(step);
    }
  }
})();

// ---------- Scene ----------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b24);
scene.fog = new THREE.Fog(0x141a45, 10, 40);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200);
const HOME_DIR = new THREE.Vector3(0.25, 0.15, 1).normalize();
const HOME_DIST = 17;
camera.position.copy(HOME_DIR).multiplyScalar(HOME_DIST);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.minDistance = 2;
controls.maxDistance = 40;
controls.enableZoom = false; // scroll-zoom is handled below with our own eased spring

const timeUniform = { value: 0 }; // seconds, shared by every animated shader

// Shared GLSL: cheap 3D value noise and fractal noise
const NOISE_GLSL = /* glsl */ `
  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
    return s;
  }`;

// Living background: a domain-warped aurora on a huge sphere that follows the camera.
// Glass needs something colourful and moving to refract.
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(90, 40, 28),
  new THREE.ShaderMaterial({
    uniforms: {
      uTime: timeUniform,
      uNavy: { value: new THREE.Color('#060a22') },
      uBlue: { value: new THREE.Color('#2a63ff') },
      uViolet: { value: new THREE.Color('#9442ff') },
      uTeal: { value: new THREE.Color('#12c9c4') },
      uPink: { value: new THREE.Color('#ff4f9c') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uNavy, uBlue, uViolet, uTeal, uPink;
      varying vec3 vDir;
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float t = uTime * 0.035;
        vec3 q = d * 1.5 + vec3(t, -t * 0.6, t * 0.8);
        vec3 w = vec3(fbm(q + 3.1), fbm(q + 7.7), fbm(q + 1.3));
        vec3 p = q + (w - 0.5) * 1.8;                 // domain warp: flowing, liquid shapes
        float n1 = fbm(p);
        float n2 = fbm(p * 0.8 + 11.0);
        float n3 = fbm(p * 1.2 - 5.0);

        vec3 col = uNavy;
        col = mix(col, uBlue,   smoothstep(0.38, 0.78, n1) * 0.62);
        col = mix(col, uViolet, smoothstep(0.42, 0.80, n2) * 0.55);
        col = mix(col, uTeal,   smoothstep(0.50, 0.85, n3) * smoothstep(0.35, -0.55, d.y) * 0.55);
        col = mix(col, uPink,   smoothstep(0.62, 0.90, n2 * n3 * 1.9) * 0.40);
        col *= 0.85 + 0.25 * smoothstep(-0.8, 0.8, d.y);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  }),
);
sky.renderOrder = -10;
sky.frustumCulled = false;
scene.add(sky);

// Twinkling, soft round dust for depth cues
{
  const count = 800;
  const pos = new Float32Array(count * 3), size = new Float32Array(count), phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize()
      .multiplyScalar(7 + rand() * 26);
    pos.set([v.x, v.y, v.z], i * 3);
    size[i] = 0.5 + rand() * rand() * 2.2;
    phase[i] = rand() * 6.283;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  scene.add(new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform, uPx: { value: renderer.getPixelRatio() } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      uniform float uPx;
      varying float vTw;
      varying float vDepth;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        vTw = 0.55 + 0.45 * sin(uTime * 1.4 + aPhase);
        gl_PointSize = aSize * uPx * 70.0 / max(vDepth, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vTw;
      varying float vDepth;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        a *= a * vTw * (1.0 - smoothstep(18.0, 38.0, vDepth));
        gl_FragColor = vec4(0.78, 0.86, 1.0, a * 0.9);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })));
}

// ---------- VFX: sparks ----------

// A pool of additive sparks simulated entirely in the vertex shader (position = start + drag-decayed velocity * age).
// Used for the burst when a note opens and for the sparkle trail that follows the cursor.
const SPARKS = 900;
const sparkPos = new Float32Array(SPARKS * 3);
const sparkVel = new Float32Array(SPARKS * 3);
const sparkBirth = new Float32Array(SPARKS).fill(-100);
const sparkLife = new Float32Array(SPARKS).fill(1);
const sparkSize = new Float32Array(SPARKS).fill(1);
const sparkColor = new Float32Array(SPARKS * 3);
const sparkGeo = new THREE.BufferGeometry();
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
sparkGeo.setAttribute('aVel', new THREE.BufferAttribute(sparkVel, 3).setUsage(THREE.DynamicDrawUsage));
sparkGeo.setAttribute('aBirth', new THREE.BufferAttribute(sparkBirth, 1).setUsage(THREE.DynamicDrawUsage));
sparkGeo.setAttribute('aLife', new THREE.BufferAttribute(sparkLife, 1).setUsage(THREE.DynamicDrawUsage));
sparkGeo.setAttribute('aSize', new THREE.BufferAttribute(sparkSize, 1).setUsage(THREE.DynamicDrawUsage));
sparkGeo.setAttribute('aColor', new THREE.BufferAttribute(sparkColor, 3).setUsage(THREE.DynamicDrawUsage));
const sparks = new THREE.Points(sparkGeo, new THREE.ShaderMaterial({
  uniforms: { uTime: timeUniform, uPx: { value: renderer.getPixelRatio() } },
  vertexShader: /* glsl */ `
    attribute vec3 aVel;
    attribute float aBirth;
    attribute float aLife;
    attribute float aSize;
    attribute vec3 aColor;
    uniform float uTime;
    uniform float uPx;
    varying vec3 vColor;
    varying float vFade;
    void main() {
      float age = uTime - aBirth;
      float alive = step(0.0, age) * step(age, aLife);
      float k = (1.0 - exp(-age * 2.2)) / 2.2;               // velocity decays like air drag
      vec3 p = position + aVel * k + vec3(0.0, 0.25 * age * age, 0.0);
      float f = clamp(1.0 - age / aLife, 0.0, 1.0);
      vFade = f * f * alive;
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = aSize * (0.35 + 0.65 * f) * uPx * 80.0 / max(-mv.z, 1.0) * alive;
      gl_Position = alive > 0.5 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    varying float vFade;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float glow = pow(smoothstep(0.5, 0.0, d), 2.0);
      float core = smoothstep(0.14, 0.0, d);
      gl_FragColor = vec4(vColor * (glow + core * 1.5), (glow + core) * vFade);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
}));
sparks.frustumCulled = false;
sparks.renderOrder = 20; // above the glass
scene.add(sparks);

let sparkHead = 0;
const sparkTint = new THREE.Color();

// opts: speed (world units/s), size, life (s), hue (0..1), sat, glow (0..1 mix toward white)
function emitSparks(origin, count, { speed = 3, size = 1.4, life = 1, hue = 0.6, sat = 0.9, white = 0.35 } = {}) {
  for (let n = 0; n < count; n++) {
    const i = sparkHead;
    sparkHead = (sparkHead + 1) % SPARKS;
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    const sp = speed * (0.35 + Math.random() * 0.9);
    sparkPos.set([origin.x, origin.y, origin.z], i * 3);
    sparkVel.set([Math.sin(ph) * Math.cos(th) * sp, Math.sin(ph) * Math.sin(th) * sp, Math.cos(ph) * sp], i * 3);
    sparkBirth[i] = timeUniform.value;
    sparkLife[i] = life * (0.6 + Math.random() * 0.8);
    sparkSize[i] = size * (0.5 + Math.random());
    sparkTint.setHSL((hue + (Math.random() - 0.5) * 0.12 + 1) % 1, sat, 0.6 + Math.random() * 0.15).lerp(WHITE, white);
    sparkTint.toArray(sparkColor, i * 3);
  }
  for (const name of ['position', 'aVel', 'aBirth', 'aLife', 'aSize', 'aColor']) sparkGeo.attributes[name].needsUpdate = true;
}
const WHITE = new THREE.Color(1, 1, 1);

// ---------- Frosted glass: blurred backdrop for the open page ----------

// Whole scene (minus the open page) is rendered small, blurred, and sampled by the page's glass shader.
const dbSize = new THREE.Vector2();
const rtScene = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
const rtA = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
const rtB = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });

const shared = { // uniforms shared by every panel's material
  uBackdrop: { value: rtB.texture },
  uRes: { value: new THREE.Vector2(1, 1) },
  uFog: { value: new THREE.Vector2(scene.fog.near, scene.fog.far) },
  uTime: timeUniform,
};

function resizeTargets() {
  renderer.getDrawingBufferSize(dbSize);
  shared.uRes.value.copy(dbSize);
  rtScene.setSize(Math.max(2, dbSize.x >> 1), Math.max(2, dbSize.y >> 1));
  rtA.setSize(Math.max(2, dbSize.x >> 2), Math.max(2, dbSize.y >> 2));
  rtB.setSize(Math.max(2, dbSize.x >> 2), Math.max(2, dbSize.y >> 2));
}
resizeTargets();

const blurMat = new THREE.ShaderMaterial({
  uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uTex;
    uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(uTex, vUv) * 0.2270270270;
      c += texture2D(uTex, vUv + uDir * 1.3846153846) * 0.3162162162;
      c += texture2D(uTex, vUv - uDir * 1.3846153846) * 0.3162162162;
      c += texture2D(uTex, vUv + uDir * 3.2307692308) * 0.0702702703;
      c += texture2D(uTex, vUv - uDir * 3.2307692308) * 0.0702702703;
      gl_FragColor = c;
    }`,
  depthTest: false,
  depthWrite: false,
});
const blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat);
blurQuad.frustumCulled = false;
const blurScene = new THREE.Scene();
blurScene.add(blurQuad);
const blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function blurPass(src, dst, dx, dy) {
  blurMat.uniforms.uTex.value = src.texture;
  blurMat.uniforms.uDir.value.set(dx / dst.width, dy / dst.height);
  renderer.setRenderTarget(dst);
  renderer.render(blurScene, blurCam);
}

function renderBackdrop(page) {
  page.mesh.visible = false;
  page.icon.visible = false;
  renderer.setRenderTarget(rtScene);
  renderer.render(scene, camera);
  page.mesh.visible = true;
  page.icon.visible = true;
  blurPass(rtScene, rtA, 1.5, 0);
  blurPass(rtA, rtB, 0, 1.5);
  blurPass(rtB, rtA, 2.5, 0);
  blurPass(rtA, rtB, 0, 2.5);
  renderer.setRenderTarget(null);
}

const PANEL_W = 2, PANEL_H = 2.5;
let seedCounter = 0;

function makeGlassMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null },
      uMap2: { value: null },   // the far-away face (icon tile)
      uLod: { value: 0 },       // 0 = readable card, 1 = icon tile
      uOpacity: { value: 0.95 },
      uBackdropMix: { value: 0 },
      uHover: { value: 0 },
      uDim: { value: 0 },                               // fades the page content while you zoom into its mini graph
      uPointer: { value: new THREE.Vector2(0.5, 0.5) }, // where the cursor touches the pane (uv)
      uSeed: { value: seedCounter++ * 0.37 },           // desynchronises the sheen sweeps
      uSize: { value: new THREE.Vector2(PANEL_W, PANEL_H) },
      ...shared,
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform sampler2D uMap2;
      uniform float uLod;
      uniform sampler2D uBackdrop;
      uniform vec2 uRes;
      uniform vec2 uSize;
      uniform vec2 uFog;
      uniform float uOpacity;
      uniform float uBackdropMix;
      uniform float uHover;
      uniform float uDim;
      uniform float uTime;
      uniform float uSeed;
      uniform vec2 uPointer;
      varying vec2 vUv;
      varying float vDepth;

      float sdRoundBox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }

      void main() {
        vec2 p = (vUv - 0.5) * uSize;
        float d = sdRoundBox(p, uSize * 0.5, 0.2);       // < 0 inside the rounded panel
        float aa = max(fwidth(d), 1e-4);
        float mask = 1.0 - smoothstep(-aa, aa, d);
        if (mask <= 0.0) discard;
        float inner = -d;
        vec2 dir = normalize(p + vec2(1e-5));
        float ang = atan(dir.y, dir.x);

        // frosted body: the blurred scene behind, bent at the rim like thick glass, with
        // each colour channel bent a little differently (chromatic dispersion)
        vec2 suv = gl_FragCoord.xy / uRes;
        vec2 bend = -dir * exp(-inner * 8.0) * 0.032 * vec2(uRes.y / uRes.x, 1.0);
        vec3 back = vec3(
          texture2D(uBackdrop, suv + bend * 1.35).r,
          texture2D(uBackdrop, suv + bend).g,
          texture2D(uBackdrop, suv + bend * 0.65).b);
        float luma = dot(back, vec3(0.299, 0.587, 0.114));
        back = mix(vec3(luma), back, 1.5);                   // lift saturation, like vibrancy
        vec3 frost = back * 0.84 + vec3(0.05, 0.06, 0.085);

        // light pane for panels that are not backed by the live blur
        vec3 pane = vec3(0.50, 0.58, 0.80);
        float paneA = 0.13 + 0.10 * vUv.y;

        vec3 col = mix(pane, frost, uBackdropMix);
        float a = mix(paneA, 0.96, uBackdropMix);
        a *= 1.0 - 0.85 * uLod * (1.0 - uBackdropMix);      // from afar the glass nearly disappears so the icon tile stands out

        // volume: a little darker toward the bottom, like light falling through a slab
        col *= mix(0.88, 1.0, smoothstep(0.0, 0.65, vUv.y));

        // specular rim lit from the top-left, soft inner glow, faint sheen
        float lit = dot(dir, normalize(vec2(-0.6, 0.8)));
        float rim = exp(-inner * 75.0);
        float rimLit = rim * (0.30 + 0.70 * max(lit, 0.0) + 0.18 * max(-lit, 0.0));
        float glow = exp(-inner * 11.0) * 0.10 * (0.5 + 0.5 * lit);
        float sheen = smoothstep(0.35, 1.0, vUv.y) * 0.05;
        col += vec3(rimLit * 0.95 + glow + sheen + uHover * 0.07);
        a += rimLit * 0.55 + glow * 0.6 + uHover * 0.05;

        // thin-film iridescence: a rainbow fringe just inside the edge that drifts over time
        float film = exp(-pow((inner - 0.018) / 0.012, 2.0));
        vec3 irid = 0.5 + 0.5 * cos(6.2831 * (ang / 6.2831 + uTime * 0.04 + vec3(0.0, 0.33, 0.67)));
        col += irid * film * (0.22 + 0.25 * max(lit, 0.0) + 0.3 * uHover);
        a += film * 0.12;

        // light sweep: a soft diagonal band that glides across the glass every few seconds
        float diag = vUv.x * 0.8 + vUv.y * 0.6;
        float pos = mix(-0.4, 1.8, fract(uTime * 0.09 + uSeed));
        float sweep = exp(-pow((diag - pos) / 0.10, 2.0));
        col += vec3(0.85, 0.92, 1.0) * sweep * (0.05 + 0.10 * uHover + 0.05 * uBackdropMix);
        a += sweep * 0.05;

        // touch light: the pane catches a soft highlight where the cursor is
        vec2 dp = (vUv - uPointer) * uSize;
        float touch = exp(-dot(dp, dp) * 2.6) * uHover;
        col += vec3(0.55, 0.68, 1.0) * touch * 0.24 + irid * touch * rim * 0.4;
        a += touch * 0.10;

        // fine grain, so the frost has a physical feel
        float grain = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        col += grain * 0.03 * (0.4 + uBackdropMix);

        // content (text, tags, image) painted on top
        vec4 t1 = texture2D(uMap, vUv);
        vec4 t2 = texture2D(uMap2, vUv);
        vec4 pm = mix(vec4(t1.rgb * t1.a, t1.a), vec4(t2.rgb * t2.a, t2.a), uLod);   // cross-fade card <-> icon (premultiplied)
        vec4 t = vec4(pm.a > 0.001 ? pm.rgb / pm.a : vec3(0.0), pm.a);
        t.a *= 1.0 - uDim * 0.9;
        col = mix(col, t.rgb, t.a);
        a = max(a, t.a);

        a *= 1.0 - smoothstep(uFog.x, uFog.y, vDepth) * 0.85 * (1.0 - 0.9 * uLod);   // icon tiles stay visible at any distance
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * mask * uOpacity);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------- VFX: post-processing for the whole frame ----------

// scene -> bloom (soft glow on bright edges, icons, pulses, stars) -> lens pass -> sRGB output
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 }));
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.65, 0.8);
composer.addPass(bloom);

// Lens pass: chromatic fringing that grows toward the edges, a radial warp blur on impacts,
// an expanding shockwave ring that refracts the image, and a brief flash.
const lensPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: innerWidth / innerHeight },
    uWarp: { value: 0 },
    uFlash: { value: 0 },
    uShock: { value: new THREE.Vector3(0.5, 0.5, 99) }, // x, y (screen uv), age in seconds
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },    // where zoom blur radiates from (what you are moving toward)
    uRadial: { value: 0 },                              // motion blur from moving toward / away from that point
    uDir: { value: new THREE.Vector2() },               // motion blur from sideways camera movement (screen uv)
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAspect;
    uniform float uWarp;
    uniform float uFlash;
    uniform vec3 uShock;
    uniform vec2 uCenter;
    uniform float uRadial;
    uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv;

      // shockwave: a thin ring that travels outward and bends the image as it passes
      vec2 sp = (uv - uShock.xy) * vec2(uAspect, 1.0);
      float d = length(sp), age = uShock.z;
      float fade = (1.0 - smoothstep(0.0, 1.4, age)) * step(0.0, age);
      float ring = exp(-pow((d - age * 0.8) / 0.055, 2.0)) * fade;
      uv += normalize(sp + 1e-5) / vec2(uAspect, 1.0) * ring * 0.02;

      vec2 dir = uv - 0.5;
      float r = length(dir);
      float ca = 0.0014 + r * r * 0.012 + uWarp * 0.01;       // chromatic split, stronger at the edges
      vec3 col;
      float blurR = uWarp + uRadial;
      if (blurR > 0.004 || dot(uDir, uDir) > 2.5e-7) {          // motion blur: only while something is moving
        vec2 bd = uv - uCenter;
        col = vec3(0.0);
        for (int i = 0; i < 10; i++) {
          float s = float(i) / 9.0 - 0.5;
          vec2 o = bd * s * blurR * 0.1 + uDir * s;
          col += vec3(texture2D(tDiffuse, uv + o + dir * ca).r,
                      texture2D(tDiffuse, uv + o).g,
                      texture2D(tDiffuse, uv + o - dir * ca).b);
        }
        col /= 10.0;
      } else {
        col = vec3(texture2D(tDiffuse, uv + dir * ca).r,
                   texture2D(tDiffuse, uv).g,
                   texture2D(tDiffuse, uv - dir * ca).b);
      }
      col += ring * vec3(0.30, 0.45, 1.0) * 0.55;               // glint on the ring
      col += uFlash * vec3(0.45, 0.55, 1.0);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
composer.addPass(lensPass);
composer.addPass(new OutputPass());

// Motion blur follows how fast the camera is moving (dolly / fly-to / orbit) and how fast you scroll into the mini graph
const prevCam = new THREE.Vector3().copy(camera.position);
const camDelta = new THREE.Vector3();
const camInvQ = new THREE.Quaternion();
const blurCenter = new THREE.Vector3();
const motion = { radial: 0, dx: 0, dy: 0 };
let prevMz = 0, motionFrames = 0;

function updateMotionBlur(dt) {
  camDelta.subVectors(camera.position, prevCam);
  prevCam.copy(camera.position);
  if (motionFrames++ < 3 || dt <= 0) return; // ignore the jump from the initial placement / a deep link
  camDelta.applyQuaternion(camInvQ.copy(camera.quaternion).invert()); // into camera space (-z is forward)
  const perSec = 1 / dt, dist = Math.max(camera.position.distanceTo(controls.target), 1);
  const radial = Math.min(0.6, Math.abs(camDelta.z) * perSec / dist * 0.35 + Math.abs(mz - prevMz) * perSec * 0.3);
  prevMz = mz;
  const side = (v) => THREE.MathUtils.clamp(v * perSec / dist * 0.012, -0.03, 0.03);
  const k = 1 - Math.exp(-dt * 16); // smoothing, independent of frame rate
  motion.radial += (radial - motion.radial) * k;
  motion.dx += (side(camDelta.x) - motion.dx) * k;
  motion.dy += (side(camDelta.y) - motion.dy) * k;

  // zoom blur radiates from what you are moving toward: the focus point, or the mini graph while you scroll into it
  blurCenter.copy(controls.target).project(camera);
  const cx = (blurCenter.x + 1) / 2, cy = (blurCenter.y + 1) / 2;
  let mx = cx, my = cy;
  if (mini.owner && mini.show > 0.5 && mz > 0.01) {
    mini.root.getWorldPosition(blurCenter).project(camera);
    const w = Math.min(1, mz * 4);
    mx = cx + ((blurCenter.x + 1) / 2 - cx) * w;
    my = cy + ((blurCenter.y + 1) / 2 - cy) * w;
  }
  lensOf('uCenter').value.set(mx, my);
  lensOf('uRadial').value = motion.radial;
  lensOf('uDir').value.set(motion.dx, motion.dy);
}

// Impacts: kicked off by opening a note or the graph, decayed every frame
let warp = 0, flash = 0, shockAt = -10;
const lensOf = (name) => lensPass.uniforms[name];

function fxImpact({ warpAmt = 0.6, flashAmt = 0, shockUV = null } = {}) {
  warp = Math.max(warp, warpAmt);
  flash = Math.max(flash, flashAmt);
  if (shockUV) {
    lensOf('uShock').value.set(shockUV.x, shockUV.y, 0);
    shockAt = timeUniform.value;
  }
}

// ---------- Panel content ----------

const FONT = '-apple-system, "SF Pro Display", "SF Pro Text", "Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif';

function wrap(ctx, text, maxW) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      out.push(line);
      line = word;
    } else line = test;
  }
  if (line) out.push(line);
  return out;
}

// Splits text containing [[wikilinks]] into wrapped lines of positioned words.
// Each word remembers the note it links to (or null).
function layoutWords(ctx, src, maxW) {
  const segs = [];
  let last = 0;
  for (const m of src.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    if (m.index > last) segs.push({ text: src.slice(last, m.index), link: null });
    segs.push({ text: m[2] ?? m[1], link: byTitle.get(m[1].trim().toLowerCase()) ?? null });
    last = m.index + m[0].length;
  }
  if (last < src.length) segs.push({ text: src.slice(last), link: null });

  const spaceW = ctx.measureText(' ').width;
  const lines = [[]];
  let x = 0, gap = false;
  for (const seg of segs) {
    for (const piece of seg.text.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) { gap = true; continue; }
      const w = ctx.measureText(piece).width;
      const lead = gap && x > 0 ? spaceW : 0;
      gap = false;
      if (x > 0 && x + lead + w > maxW) {
        lines.push([]);
        lines.at(-1).push({ word: piece, link: seg.link, x: 0, w });
        x = w;
      } else {
        lines.at(-1).push({ word: piece, link: seg.link, x: x + lead, w });
        x += lead + w;
      }
    }
  }
  return lines.filter((l) => l.length);
}

// Paints only the content: the glass itself (fill, edge light, blur) is drawn by the shader.
function drawPanel(node, detailed, blur = 0, scroll = 0) {
  const W = detailed ? 1024 : 512, H = detailed ? 1280 : 640, s = W / 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const pad = 40 * s;
  const pill = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.font = `600 ${30 * s}px ${FONT}`;
  let y = pad;
  // on the open page the title stops short of the mini-graph in the top-right corner
  for (const l of wrap(ctx, node.title, detailed ? W * 0.66 - pad : W - pad * 2)) {
    ctx.fillText(l, pad, y);
    y += 38 * s;
  }

  ctx.font = `500 ${13 * s}px ${FONT}`;
  let x = pad;
  y += 6 * s;
  for (const t of node.tags) {
    const w = ctx.measureText(t).width + 22 * s;
    pill(x, y, w, 26 * s, 13 * s);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText(t, x + 11 * s, y + 6 * s);
    x += w + 8 * s;
  }
  y += 46 * s;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fillRect(pad, y, W - pad * 2, 1.5 * s);
  y += 18 * s;

  // On the open page everything below the header scrolls inside a clipped viewport
  const bodyTop = y, bodyBottom = H - 64 * s;
  if (detailed) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, bodyTop, W, bodyBottom - bodyTop);
    ctx.clip();
    y -= scroll;
  }
  const contentTop = y;

  const picture = node.image && images.get(node.image.src);
  if (picture) {
    const bw = W - pad * 2, bh = (detailed ? 290 : 140) * s, inset = 14 * s;
    pill(pad, y, bw, bh, 18 * s);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
    ctx.fill();
    ctx.save();
    ctx.clip();
    const fit = Math.min((bw - inset * 2) / picture.width, (bh - inset * 2) / picture.height);
    const iw = picture.width * fit, ih = picture.height * fit;
    ctx.drawImage(picture, pad + (bw - iw) / 2, y + (bh - ih) / 2, iw, ih);
    ctx.restore();
    y += bh + 8 * s;
    if (detailed && node.image.alt) {
      ctx.font = `${13 * s}px ${FONT}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.fillText(node.image.alt, pad, y);
      y += 22 * s;
    }
    y += 10 * s;
  }

  const fontPx = (detailed ? 19 : 21) * s; // the open page uses smaller text so whole notes fit
  const lineH = fontPx * 1.38, maxY = H - 64 * s;
  const hits = [];
  node.hits = detailed ? hits : [];
  node.hitSize = [W, H];
  const items = detailed ? node.lines : node.summary;
  outer: for (const item of items) {
    if (item.type === 'img') continue; // drawn above the text
    const isLi = item.type === 'li', isH = item.type === 'h';
    ctx.font = `${isH ? '600' : '400'} ${fontPx}px ${FONT}`;
    const indent = isLi ? 24 * s : 0;
    const wrapped = layoutWords(ctx, detailed ? item.raw : item.text, W - pad * 2 - indent);
    for (let i = 0; i < wrapped.length; i++) {
      if (!detailed && y + lineH > maxY) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.fillText('…', pad, y);
        break outer;
      }
      if (isLi && i === 0) {
        ctx.fillStyle = '#7cc0ff';
        ctx.beginPath();
        ctx.arc(pad + 7 * s, y + fontPx * 0.62, 3 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const w of wrapped[i]) {
        const wx = pad + indent + w.x;
        ctx.fillStyle = w.link ? '#8ccbff' : isH ? 'rgba(255, 255, 255, 0.98)' : 'rgba(255, 255, 255, 0.86)';
        ctx.fillText(w.word, wx, y);
        if (w.link) {
          ctx.fillStyle = 'rgba(140, 203, 255, 0.5)';
          ctx.fillRect(wx, y + fontPx * 1.17, w.w, 1.5 * s);
          const top = Math.max(y, bodyTop), bottom = Math.min(y + lineH, bodyBottom);
          if (bottom > top) hits.push({ x: wx, y: top, w: w.w, h: bottom - top, link: w.link }); // only the visible part is clickable
        }
      }
      y += lineH;
    }
    y += 6 * s;
  }

  node.scrollMax = 0;
  if (detailed) {
    ctx.restore();
    const viewH = bodyBottom - bodyTop, contentH = y - contentTop;
    node.scrollMax = Math.max(0, contentH - viewH);
    if (node.scrollMax > 0) { // scrollbar
      const thumbH = Math.max(40 * s, (viewH * viewH) / contentH);
      const thumbY = bodyTop + (scroll / node.scrollMax) * (viewH - thumbH);
      pill(W - 26 * s, thumbY, 5 * s, thumbH, 2.5 * s);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.fill();
    }
  }

  ctx.font = `${13 * s}px ${FONT}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.fillText(`${node.links.size} link${node.links.size === 1 ? '' : 's'}`, pad, H - 46 * s);

  return toTexture(c, blur, s);
}

// Compact "tile" face used on the isolated graph screen: a colour bead, the title and its tags.
function drawTile(node, blur = 0) {
  const s = 1.5, W = 512 * s, H = 640 * s;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const cx = W / 2, hue = Math.round(node.hue * 360);

  const glow = ctx.createRadialGradient(cx, 190 * s, 0, cx, 190 * s, 95 * s);
  glow.addColorStop(0, `hsla(${hue}, 90%, 70%, 0.85)`);
  glow.addColorStop(0.4, `hsla(${hue}, 90%, 65%, 0.30)`);
  glow.addColorStop(1, `hsla(${hue}, 90%, 60%, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = `hsl(${hue}, 90%, 82%)`;
  ctx.beginPath(); ctx.arc(cx, 190 * s, 15 * s, 0, Math.PI * 2); ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
  ctx.font = `600 ${40 * s}px ${FONT}`;
  const lines = wrap(ctx, node.title, W - 90 * s);
  lines.forEach((l, i) => ctx.fillText(l, cx, 330 * s + i * 50 * s));

  ctx.font = `500 ${15 * s}px ${FONT}`;
  const widths = node.tags.map((t) => ctx.measureText(t).width + 26 * s);
  let x = cx - (widths.reduce((a, b) => a + b, 0) + 8 * s * Math.max(0, widths.length - 1)) / 2;
  const ty = 330 * s + lines.length * 50 * s + 8 * s;
  node.tags.forEach((t, i) => {
    ctx.beginPath(); ctx.roundRect(x, ty, widths[i], 30 * s, 15 * s);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(t, x + 13 * s, ty + 15 * s);
    x += widths[i] + 8 * s;
  });

  ctx.textAlign = 'center';
  ctx.font = `${14 * s}px ${FONT}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.fillText(`${node.links.size} link${node.links.size === 1 ? '' : 's'}`, cx, H - 70 * s);

  node.hits = [];
  node.hitSize = [W, H];
  return toTexture(c, blur, s);
}

// Far-away face: a glossy, colour-coded app-icon tile with the note's Lucide glyph and its title.
// Faded in by the shader when the note is too small on screen to read.
function drawFace(node) {
  const s = 1.5, W = 512 * s, H = 640 * s;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const cx = W / 2, cy = 245 * s, hue = Math.round(node.hue * 360);

  const aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, 230 * s);
  aura.addColorStop(0, `hsla(${hue}, 90%, 62%, 0.55)`);
  aura.addColorStop(1, `hsla(${hue}, 90%, 62%, 0)`);
  ctx.fillStyle = aura;
  ctx.fillRect(0, 0, W, H);

  const size = 270 * s, r = 66 * s, x = cx - size / 2, y = cy - size / 2;
  ctx.save();
  ctx.shadowColor = `hsla(${hue}, 90%, 55%, 0.75)`;
  ctx.shadowBlur = 44 * s;
  ctx.shadowOffsetY = 14 * s;
  const body = ctx.createLinearGradient(0, y, 0, y + size);
  body.addColorStop(0, `hsl(${hue}, 88%, 68%)`);
  body.addColorStop(1, `hsl(${(hue + 28) % 360}, 82%, 46%)`);
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.roundRect(x, y, size, size, r); ctx.fill();
  ctx.restore();

  ctx.save(); // glossy highlight across the top half
  ctx.beginPath(); ctx.roundRect(x, y, size, size, r); ctx.clip();
  const gloss = ctx.createLinearGradient(0, y, 0, y + size * 0.55);
  gloss.addColorStop(0, 'rgba(255, 255, 255, 0.42)');
  gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gloss;
  ctx.fillRect(x, y, size, size * 0.55);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 3 * s;
  ctx.beginPath(); ctx.roundRect(x, y, size, size, r); ctx.stroke();

  const glyph = glyphs.get(node);
  if (glyph) {
    const g = 150 * s;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 10 * s;
    ctx.shadowOffsetY = 4 * s;
    ctx.drawImage(glyph, cx - g / 2, cy - g / 2, g, g);
    ctx.restore();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
  ctx.font = `600 ${40 * s}px ${FONT}`;
  wrap(ctx, node.title, W - 70 * s).forEach((l, i) => ctx.fillText(l, cx, cy + size / 2 + 38 * s + i * 50 * s));

  return toTexture(c, 0, s);
}

function toTexture(c, blur, s) {
  let out = c;
  const ctx = c.getContext('2d');
  if (blur > 0 && 'filter' in ctx) {
    out = document.createElement('canvas');
    out.width = c.width; out.height = c.height;
    const o = out.getContext('2d');
    o.filter = `blur(${blur * s}px)`;
    o.drawImage(c, 0, 0);
  }
  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function setPanelTexture(node, tex) {
  const u = node.mesh.material.uniforms;
  u.uMap.value?.dispose();
  u.uMap.value = tex;
}

// ---------- Panels and links ----------

const panelGeo = new THREE.PlaneGeometry(PANEL_W, PANEL_H);
const panels = [];

for (const n of nodes) {
  const mesh = new THREE.Mesh(panelGeo, makeGlassMaterial());
  mesh.position.copy(n.pos);
  mesh.userData.node = n;
  n.mesh = mesh;
  setPanelTexture(n, drawPanel(n, false));
  mesh.material.uniforms.uMap2.value = drawFace(n);
  n.scaleGoal = 1;
  n.opacityGoal = 0.95;
  n.detailed = false;
  n.state = 'sharp';
  n.vel = new THREE.Vector3(); // spring velocity of the position
  n.scaleV = 0;                // spring velocity of the scale
  n.wait = 0;                  // seconds before the note starts moving (cascade)
  n.cur = n.pos.clone();  // where the panel is drawn right now
  n.goal = n.pos.clone(); // where it is heading (layout position, or its place in depth while a page is open)
  panels.push(mesh);
  scene.add(mesh);
}

// Links are faint curved threads with a soft pulse of light travelling along them.
// The links of the open page glow brighter; everything else recedes.
const LINE_SEG = 18;
const lineVerts = edges.length * LINE_SEG * 2;
const linePos = new Float32Array(lineVerts * 3);
const lineT = new Float32Array(lineVerts);
const lineHot = new Float32Array(lineVerts);
const lineSeed = new Float32Array(lineVerts);
const lineVis = new Float32Array(lineVerts).fill(1);
const edgeHot = new Float32Array(edges.length);
const edgeHotGoal = new Float32Array(edges.length);
const edgeVis = new Float32Array(edges.length).fill(1);     // 0 hides a link (graph screen shows only related ones)
const edgeVisGoal = new Float32Array(edges.length).fill(1);
const edgeBend = edges.map(() => rand() * Math.PI * 2);
edges.forEach((_, i) => {
  const seed = rand();
  for (let k = 0; k < LINE_SEG; k++) {
    const o = (i * LINE_SEG + k) * 2;
    lineT[o] = k / LINE_SEG;
    lineT[o + 1] = (k + 1) / LINE_SEG;
    lineSeed[o] = lineSeed[o + 1] = seed;
  }
});
const lineGeo = new THREE.BufferGeometry();
lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
lineGeo.setAttribute('aT', new THREE.BufferAttribute(lineT, 1));
lineGeo.setAttribute('aHot', new THREE.BufferAttribute(lineHot, 1).setUsage(THREE.DynamicDrawUsage));
lineGeo.setAttribute('aSeed', new THREE.BufferAttribute(lineSeed, 1));
lineGeo.setAttribute('aVis', new THREE.BufferAttribute(lineVis, 1).setUsage(THREE.DynamicDrawUsage));
const lineMat = new THREE.ShaderMaterial({
  uniforms: { uTime: timeUniform, uFog: shared.uFog, uSelected: { value: 0 } },
  vertexShader: /* glsl */ `
    attribute float aT;
    attribute float aHot;
    attribute float aSeed;
    attribute float aVis;
    varying float vT;
    varying float vHot;
    varying float vSeed;
    varying float vVis;
    varying float vDepth;
    void main() {
      vT = aT; vHot = aHot; vSeed = aSeed; vVis = aVis;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uSelected;
    uniform vec2 uFog;
    varying float vT;
    varying float vHot;
    varying float vSeed;
    varying float vVis;
    varying float vDepth;
    void main() {
      float x = vT - fract(uTime * 0.10 + vSeed);
      float pulse = exp(-x * x / 0.0016);
      float a = 0.06 * (1.0 - 0.65 * uSelected) + vHot * 0.34 + pulse * (0.26 + vHot * 0.30);
      a *= (1.0 - smoothstep(uFog.x, uFog.y, vDepth) * 0.9) * vVis;
      vec3 col = mix(vec3(0.45, 0.60, 1.0), vec3(1.0), clamp(vHot * 0.55 + pulse * 0.5, 0.0, 1.0));
      gl_FragColor = vec4(col, a);
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const lineMesh = new THREE.LineSegments(lineGeo, lineMat);
lineMesh.frustumCulled = false;
scene.add(lineMesh);

// Tethers: while the mini graph is hovered, glowing threads run from each of its beads out to the
// real note it stands for, so you can see exactly which notes it connects. Same shader as the links.
const TETHER_SEG = 14;
const tetherVerts = nodes.length * TETHER_SEG * 2;
const tetherPos = new Float32Array(tetherVerts * 3);
const tetherT = new Float32Array(tetherVerts);
const tetherHot = new Float32Array(tetherVerts);
const tetherSeed = new Float32Array(tetherVerts);
const tetherVis = new Float32Array(tetherVerts);
for (let i = 0; i < nodes.length; i++) {
  const seed = rand();
  for (let k = 0; k < TETHER_SEG; k++) {
    const o = (i * TETHER_SEG + k) * 2;
    tetherT[o] = k / TETHER_SEG;
    tetherT[o + 1] = (k + 1) / TETHER_SEG;
    tetherSeed[o] = tetherSeed[o + 1] = seed;
  }
}
const tetherGeo = new THREE.BufferGeometry();
tetherGeo.setAttribute('position', new THREE.BufferAttribute(tetherPos, 3).setUsage(THREE.DynamicDrawUsage));
tetherGeo.setAttribute('aT', new THREE.BufferAttribute(tetherT, 1));
tetherGeo.setAttribute('aHot', new THREE.BufferAttribute(tetherHot, 1).setUsage(THREE.DynamicDrawUsage));
tetherGeo.setAttribute('aSeed', new THREE.BufferAttribute(tetherSeed, 1));
tetherGeo.setAttribute('aVis', new THREE.BufferAttribute(tetherVis, 1).setUsage(THREE.DynamicDrawUsage));
tetherGeo.setDrawRange(0, 0);
const tetherMesh = new THREE.LineSegments(tetherGeo, lineMat);
tetherMesh.frustumCulled = false;
tetherMesh.renderOrder = 3;
scene.add(tetherMesh);

function refreshLinks() {
  edges.forEach(([a, b], i) => { edgeHotGoal[i] = selected && (a === selected || b === selected) ? 1 : 0; });
}

// ---------- Selection and camera flight ----------

let selected = null;
let hovered = null;
let flying = false;
let graphMode = false;       // isolated graph screen of the open page's related notes
const graphSet = new Set();  // notes shown on that screen
const goalTarget = new THREE.Vector3();
const goalCam = new THREE.Vector3();

// Camera flights are timed and eased in and out (slow start, fast middle, soft landing).
// Starting a new flight mid-flight begins from wherever the camera currently is.
const flightFromTarget = new THREE.Vector3(), flightFromCam = new THREE.Vector3();
let flightT = 0, flightDur = 1.2;
// Scroll zoom: the wheel moves a goal distance, and the camera springs toward it
let zoomActive = false, zoomGoal = 0, zoomCur = 0, zoomV = 0;
const zoomDir = new THREE.Vector3();
const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

function flyTo(target, dist) {
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  goalTarget.copy(target);
  goalCam.copy(target).addScaledVector(dir, dist);
  flightFromTarget.copy(controls.target);
  flightFromCam.copy(camera.position);
  flightT = 0;
  zoomActive = false; // a flight overrides any scroll-zoom in progress
  flightDur = THREE.MathUtils.clamp(0.9 + flightFromCam.distanceTo(goalCam) * 0.05, 1.0, 1.8);
  flying = true;
}

// Critically damped spring: accelerates gently, never overshoots, and can be retargeted mid-motion
// without a jolt. Returns the new value; the new velocity is left in `dampV`.
let dampV = 0;
function dampTo(x, v, target, omega, dt) {
  const dx = x - target, ex = Math.exp(-omega * dt), tmp = (v + omega * dx) * dt;
  dampV = (v - omega * tmp) * ex;
  return target + (dx + tmp) * ex;
}

// Breadth-first hop count from `root` through the link graph (unreachable notes get the deepest ring + 1)
function hopsFrom(root) {
  const hops = new Map([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const n = queue.shift();
    for (const m of n.links) if (!hops.has(m)) { hops.set(m, hops.get(n) + 1); queue.push(m); }
  }
  const deepest = Math.max(...hops.values());
  for (const n of nodes) if (!hops.has(n)) hops.set(n, deepest + 1);
  return hops;
}

// Relatedness to the open page: a direct link counts most, then every neighbour the two
// notes share, then closeness in hops. Normalised to 0 (barely related) .. 1 (most related).
function relatedness(root, hops) {
  const score = new Map();
  for (const n of nodes) {
    if (n === root) continue;
    let common = 0;
    for (const m of n.links) if (root.links.has(m)) common++;
    score.set(n, (hops.get(n) === 1 ? 10 : 0) + common * 3 + 2 / hops.get(n) + n.links.size * 0.1);
  }
  const vals = [...score.values()];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  for (const [n, s] of score) n.rel = hi > lo ? (s - lo) / (hi - lo) : 0.5;
}

// More related notes sit closer to the viewer, are larger and clearer; the least related
// drift far back. Lateral positions follow a golden-angle spiral in order of relatedness,
// so neighbours of similar rank never stack on top of each other.
const DEPTH_NEAR = 1.6, DEPTH_SPAN = 20, SIZE_MIN = 1.1, SIZE_MAX = 1.6;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function arrangeByConnection(root, hops, viewDir) {
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), viewDir).normalize();
  const upv = new THREE.Vector3().crossVectors(viewDir, right);
  relatedness(root, hops);
  root.goal.copy(root.pos);
  root.rel = 1;
  const ranked = nodes.filter((n) => n !== root).sort((a, b) => b.rel - a.rel);
  ranked.forEach((n, i) => {
    const depth = DEPTH_NEAR + Math.pow(1 - n.rel, 1.3) * DEPTH_SPAN;
    const radius = 4.3 + depth * 0.4; // wider with depth, so far panels still fill the view
    const a = i * GOLDEN_ANGLE;
    n.goal.copy(root.pos)
      .addScaledVector(right, Math.cos(a) * radius)
      .addScaledVector(upv, Math.sin(a) * radius)
      .addScaledVector(viewDir, -depth);
    n.wait = 0.05 + i * 0.016; // the closest relatives move first, the distant ones follow
  });
  root.wait = 0;
}

const crumb = document.getElementById('crumb');
const backBtn = document.getElementById('back');
backBtn.addEventListener('click', () => exitGraph());
const hint = document.getElementById('hud');
const defaultHint = hint.innerHTML;
const setHint = (html) => { hint.innerHTML = html; };

// ---------- Hover nameplate (main graph only) ----------
// A glass tag springs out of the hovered note's corner icon on a glowing thread. Its title decodes
// letter by letter, and when you move to another note the tag glides across instead of popping.

const tagEl = document.getElementById('tag');
const tagText = document.getElementById('tagText');
const tagSub = document.getElementById('tagSub');
const leaderEl = document.getElementById('leader');
const SCRAMBLE = '01<>/\\{}[]#%&*+=?~';
let tagNode = null, tagShow = 0, tagShowV = 0, tagStart = 0, tagShown = '', tagW = 0, tagH = 0;
const tagPos = { x: 0, y: 0, vx: 0, vy: 0 };
const tagProj = new THREE.Vector3();

function updateHoverTag(t, dt) {
  const want = !selected && !graphMode && !miniDrag && hovered?.mesh.visible ? hovered : null;

  if (want && want !== tagNode) { // a new note: restart the reveal
    const fresh = tagShow < 0.05;
    tagNode = want;
    tagStart = t;
    tagText.textContent = want.title;
    tagSub.textContent = `${want.tags.join(' · ')}  ·  ${want.links.size} link${want.links.size === 1 ? '' : 's'}`;
    tagEl.style.width = 'auto';
    tagW = tagEl.offsetWidth;
    tagH = tagEl.offsetHeight;
    tagEl.style.width = `${tagW}px`; // fixed width so the scramble does not make the tag jitter
    const c = `hsl(${Math.round(want.hue * 360)} 92% 70%)`;
    tagEl.style.setProperty('--c', c);
    leaderEl.style.setProperty('--c', c);
    if (fresh) { // start at the node and spring outward
      tagProj.copy(want.anchor).project(camera);
      tagPos.x = (tagProj.x + 1) / 2 * innerWidth;
      tagPos.y = (1 - tagProj.y) / 2 * innerHeight;
      tagPos.vx = tagPos.vy = 0;
    }
    emitSparks(want.anchor, 6, { speed: 1.6, size: 1.0, life: 0.7, hue: want.hue });
  }

  tagShow = dampTo(tagShow, tagShowV, want ? 1 : 0, want ? 11 : 14, dt);
  tagShowV = dampV;
  if (!want && tagShow < 0.01) {
    tagEl.style.visibility = leaderEl.style.visibility = 'hidden';
    tagNode = null;
    return;
  }

  const n = tagNode;
  tagProj.copy(n.anchor).project(camera);
  const sx = (tagProj.x + 1) / 2 * innerWidth, sy = (1 - tagProj.y) / 2 * innerHeight;
  const tx = THREE.MathUtils.clamp(sx + 30, 14, innerWidth - tagW - 14);
  const ty = THREE.MathUtils.clamp(sy - 62 - tagH * 0.2, 66, innerHeight - tagH - 14);
  tagPos.x = dampTo(tagPos.x, tagPos.vx, tx, 9, dt); tagPos.vx = dampV;
  tagPos.y = dampTo(tagPos.y, tagPos.vy, ty, 9, dt); tagPos.vy = dampV;

  const s = THREE.MathUtils.clamp(tagShow, 0, 1);
  tagEl.style.visibility = leaderEl.style.visibility = 'visible';
  tagEl.style.opacity = Math.min(1, s * 1.5);
  tagEl.style.filter = `blur(${((1 - s) * 7).toFixed(2)}px)`;
  tagEl.style.transform = `translate(${tagPos.x.toFixed(1)}px, ${tagPos.y.toFixed(1)}px) scale(${(0.72 + 0.28 * s).toFixed(3)})`;

  // the thread from the label's corner back to the note's icon, drawn on as the tag appears
  const ox = tagPos.x + 12, oy = tagPos.y + tagH;
  const dx = sx - ox, dy = sy - oy;
  leaderEl.style.opacity = s;
  leaderEl.style.width = `${(Math.hypot(dx, dy) * s).toFixed(1)}px`;
  leaderEl.style.transform = `translate(${ox.toFixed(1)}px, ${oy.toFixed(1)}px) rotate(${Math.atan2(dy, dx).toFixed(4)}rad)`;

  // title decodes left to right: unresolved letters flicker through random glyphs
  const title = n.title, elapsed = t - tagStart;
  const done = Math.floor(THREE.MathUtils.clamp(elapsed / (0.12 + title.length * 0.03), 0, 1) * title.length);
  let out = '';
  for (let i = 0; i < title.length; i++) {
    out += i < done || title[i] === ' ' ? title[i] : SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
  }
  if (out !== tagShown) { tagText.textContent = out; tagShown = out; }
  tagSub.style.opacity = 0.72 * THREE.MathUtils.smoothstep(elapsed, 0.2, 0.6);
}

// `instant` skips the animation (used for deep links such as #Three.js)
function select(node, instant = false) {
  selected = node;
  graphMode = false;
  mzGoal = mz = mzV = 0;
  miniBead = null;
  graphSet.clear();
  edgeVisGoal.fill(1);
  backBtn.hidden = true;
  setHint(defaultHint);
  controls.autoRotate = !node;
  crumb.textContent = node ? `Knowledge Space  ›  ${node.title}` : 'Knowledge Space';
  history.replaceState(null, '', node ? `#${encodeURIComponent(node.title)}` : location.pathname);
  const hops = node ? hopsFrom(node) : null;
  if (node) {
    arrangeByConnection(node, hops, new THREE.Vector3().subVectors(camera.position, controls.target).normalize());
  } else {
    for (const n of nodes) { n.goal.copy(n.pos); n.wait = (n.index % 8) * 0.025; }
  }
  for (const n of nodes) {
    const rel = node ? n.rel : 1;
    const near = !node || rel >= 0.5;
    n.scaleGoal = !node ? 1 : n === node ? 1.9 : THREE.MathUtils.lerp(SIZE_MIN, SIZE_MAX, rel);
    n.opacityGoal = !node ? 0.95 : THREE.MathUtils.lerp(0.25, 0.95, rel);
    // the open page stays crisp; everything behind it is blurred (neighbors less than the rest)
    const state = n === node ? 'page' : !node ? 'sharp' : near ? 'soft' : 'heavy';
    if (state !== n.state) {
      n.scroll = n.scrollGoal = 0;
      setPanelTexture(n, drawPanel(n, state === 'page', { soft: 2.5, heavy: 5 }[state] ?? 0));
      n.state = state;
      n.detailed = state === 'page';
    }
  }
  refreshLinks();
  if (node) setupMini(node);
  if (node) flyTo(node.pos, 6.5);
  else flyTo(new THREE.Vector3(), HOME_DIST);
  if (!instant) {
    // opening a note: the view warps as the camera dives in, then a shockwave and a burst of sparks land with it
    fxImpact({ warpAmt: node ? 0.55 : 0.25 });
    if (node) {
      setTimeout(() => {
        if (selected !== node) return;
        fxImpact({ warpAmt: 0, shockUV: { x: 0.5, y: 0.5 } });
        emitSparks(node.pos, 90, { speed: 7, size: 1.8, life: 1.2, hue: node.hue });
      }, 300);
    }
  }
  if (instant) {
    edgeVis.set(edgeVisGoal);
    for (const n of nodes) {
      n.cur.copy(n.goal);
      n.vel.set(0, 0, 0);
      n.scaleV = 0;
      n.wait = 0;
      n.mesh.scale.set(n.scaleGoal, n.scaleGoal, 1);
      n.mesh.material.uniforms.uOpacity.value = n.opacityGoal;
      n.mesh.material.uniforms.uBackdropMix.value = n === node ? 1 : 0;
    }
    controls.target.copy(goalTarget);
    camera.position.copy(goalCam);
    lineMat.uniforms.uSelected.value = node ? 1 : 0;
    edgeHot.set(edgeHotGoal);
    flying = false;
  }
}

// ---------- Related-notes sub-graph (shared by the mini widget and the graph screen) ----------

// Force layout of one note plus its direct neighbours, with the note pinned at the origin.
// Cached per note, so the mini widget and the big graph screen show the same arrangement.
function subLayout(center) {
  if (center.subPos) return center.subPos;
  const list = [center, ...center.links];
  const idx = new Map(list.map((n, i) => [n, i]));
  const p = list.map((n) => (n === center ? new THREE.Vector3()
    : new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize().multiplyScalar(2.5 + rand() * 2)));
  const sub = edges.filter(([a, b]) => idx.has(a) && idx.has(b));
  const rest = 3.2 + 0.4 * Math.sqrt(list.length); // roomier when there are many neighbours
  for (let it = 0; it < 400; it++) {
    const cool = 1 - it / 400;
    const f = list.map(() => new THREE.Vector3());
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const d = new THREE.Vector3().subVectors(p[a], p[b]);
        const len = Math.max(d.length(), 0.3);
        d.multiplyScalar(9 / (len * len * len));
        f[a].add(d);
        f[b].sub(d);
      }
    }
    for (const [a, b] of sub) {
      const i = idx.get(a), j = idx.get(b);
      const d = new THREE.Vector3().subVectors(p[j], p[i]);
      const L = d.length();
      const fv = d.multiplyScalar(0.05 * (L - rest) / Math.max(L, 0.001));
      f[i].add(fv);
      f[j].sub(fv);
    }
    list.forEach((n, i) => {
      if (n === center) return;
      f[i].addScaledVector(p[i], -0.012);
      p[i].add(f[i].clampLength(0, 0.5 * cool + 0.02));
    });
  }
  center.subPos = new Map(list.map((n, i) => [n, p[i]]));
  return center.subPos;
}

// ---------- Mini graph: a tiny constellation on the open page ----------
// Hover and it lifts off the page, tilts toward the cursor and spins faster; click to open the graph screen.

const MINI_X = 0.70, MINI_Y = 0.95, MINI_R = 0.22, MINI_GRAPH_R = 0.145; // page-local units (page is 2 x 2.5)

const dotTex = (() => {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255, 255, 255, 1)');
  g.addColorStop(0.25, 'rgba(255, 255, 255, 0.85)');
  g.addColorStop(0.5, 'rgba(255, 255, 255, 0.18)');
  g.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

const labelTex = (() => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.roundRect(6, 6, 308, 52, 26);
  ctx.fillStyle = 'rgba(40, 52, 120, 0.82)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = `600 24px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
  ctx.fillText('Explore graph  →', 160, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

const mini = (() => {
  const root = new THREE.Group();   // position / scale / lift
  const tilt = new THREE.Group();   // leans toward the cursor
  const inner = new THREE.Group();  // spins; holds the beads and threads
  root.add(tilt);
  tilt.add(inner);

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(MINI_R, 64),
    new THREE.ShaderMaterial({
      uniforms: { uHover: { value: 0 }, uZoom: { value: 0 }, uTime: timeUniform },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uHover;
        uniform float uZoom;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          float aa = max(fwidth(r), 1e-4);
          float mask = 1.0 - smoothstep(1.0 - aa, 1.0, r);
          vec3 col = mix(vec3(0.10, 0.14, 0.34), vec3(0.30, 0.40, 0.88), smoothstep(1.0, 0.0, r) * 0.55 + 0.25 * uHover);
          float a = 0.52 + 0.20 * uHover;

          vec2 dir = p / max(r, 1e-4);
          float lit = dot(dir, normalize(vec2(-0.6, 0.8)));
          float rim = exp(-(1.0 - r) * 20.0);
          col += rim * (0.45 + 0.65 * max(lit, 0.0));
          a += rim * 0.5;

          float film = exp(-pow((1.0 - r - 0.07) / 0.035, 2.0));
          vec3 irid = 0.5 + 0.5 * cos(6.2831 * (atan(p.y, p.x) / 6.2831 - uTime * 0.08 + vec3(0.0, 0.33, 0.67)));
          col += irid * film * (0.35 + 0.5 * uHover);

          float orbit = exp(-pow((r - 0.62) / 0.014, 2.0)) * (0.5 + 0.5 * sin(atan(p.y, p.x) * 22.0 + uTime * 0.8));
          col += orbit * 0.18;

          vec2 sp = p - vec2(-0.45, 0.5);
          col += exp(-dot(sp, sp) * 7.0) * (0.22 + 0.35 * uHover);

          a *= 1.0 - 0.45 * uZoom;  // more see-through when zoomed in, so the beads and labels read clearly
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * mask);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    }),
  );
  disc.renderOrder = 5;
  tilt.add(disc);

  // soft contact shadow cast on the page; it drifts away and softens as the widget lifts
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(MINI_R * 1.6, 48),
    new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0.3 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float a = pow(1.0 - smoothstep(0.15, 1.0, r), 2.0) * uStrength;
          gl_FragColor = vec4(0.01, 0.02, 0.09, a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    }),
  );
  shadow.renderOrder = 4;

  const label = new THREE.Sprite(new THREE.SpriteMaterial({
    map: labelTex, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
  }));
  label.scale.set(0.5, 0.1, 1);
  label.position.set(0, -MINI_R - 0.085, 0.02);
  label.renderOrder = 8;
  root.add(label);

  return { root, tilt, inner, disc, shadow, label, lines: null, beads: [], owner: null, hover: 0, show: 0 };
})();

// Crisp ring-and-core token that fades in over the soft glow as you zoom into the mini graph
const ringTex = (() => {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 9;
  ctx.beginPath(); ctx.arc(S / 2, S / 2, 46, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(S / 2, S / 2, 20, 0, Math.PI * 2); ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

// Title chip shown beside a bead once you are zoomed in (cached per note)
const chipCache = new Map();
function chipTexture(title) {
  if (!chipCache.has(title)) {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = `600 28px ${FONT}`;
    const w = Math.min(308, ctx.measureText(title).width + 36);
    ctx.beginPath();
    ctx.roundRect(160 - w / 2, 6, w, 52, 26);
    ctx.fillStyle = 'rgba(24, 32, 84, 0.86)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
    ctx.fillText(title, 160, 33, 290);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    chipCache.set(title, tex);
  }
  return chipCache.get(title);
}

// Rebuild the little constellation for `node` and attach the widget to its page
function setupMini(node) {
  if (mini.owner === node) return;
  mini.owner?.mesh.remove(mini.root, mini.shadow);
  node.mesh.add(mini.root, mini.shadow);
  mini.owner = node;

  for (const ch of [...mini.inner.children]) {
    mini.inner.remove(ch);
    ch.geometry?.dispose();
    ch.material?.dispose();
  }
  for (const b of mini.beads) {
    mini.tilt.remove(b.label);
    b.label.material.dispose();
  }
  mini.beads = [];
  const pos = subLayout(node);
  let R = 0;
  for (const p of pos.values()) R = Math.max(R, p.length());
  const k = MINI_GRAPH_R / Math.max(R, 1e-3);

  const verts = [];
  for (const [a, b] of edges) {
    if (!pos.has(a) || !pos.has(b)) continue;
    verts.push(...pos.get(a).clone().multiplyScalar(k).toArray(), ...pos.get(b).clone().multiplyScalar(k).toArray());
  }
  const lineGeoMini = new THREE.BufferGeometry();
  lineGeoMini.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  mini.lines = new THREE.LineSegments(lineGeoMini, new THREE.LineBasicMaterial({
    color: 0xa9c1ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
  }));
  mini.lines.renderOrder = 6;
  mini.inner.add(mini.lines);

  for (const [n, p] of pos) {
    const color = n === node ? new THREE.Color(1, 1, 1) : new THREE.Color().setHSL(n.hue, 0.85, 0.66);
    const spriteMat = (map) => new THREE.SpriteMaterial({
      map, color, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const soft = new THREE.Sprite(spriteMat(dotTex));   // blurry glow, what you see from afar
    const crisp = new THREE.Sprite(spriteMat(ringTex)); // sharp token, what you see up close
    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: chipTexture(n.title), transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    }));
    const local = p.clone().multiplyScalar(k);
    soft.position.copy(local);
    crisp.position.copy(local);
    soft.renderOrder = 7;
    crisp.renderOrder = 7;
    label.renderOrder = 9;
    mini.inner.add(soft, crisp);
    mini.tilt.add(label); // labels do not spin with the graph, they just follow their bead
    mini.beads.push({ node: n, local, soft, crisp, label });
  }
  mini.inner.rotation.set(0.35, 0, 0);
}

const miniPointer = new THREE.Vector2(); // cursor position on the widget, -1..1
let miniHovered = false;
let miniBead = null;  // the note whose bead the cursor is on (only when zoomed in)
let mzGoal = 0, mz = 0, mzV = 0; // how far you have scrolled into the mini graph, 0..1 (and its spring velocity)

// ---------- Graph screen: only the open page's related notes, everything else steps aside ----------

function enterGraph() {
  if (!selected || graphMode) return;
  const center = selected;
  graphMode = true;
  mzGoal = mz = 0;
  miniBead = null;
  graphSet.clear();
  graphSet.add(center);
  for (const n of center.links) graphSet.add(n);

  const pos = subLayout(center);
  let R = 0;
  for (const p of pos.values()) R = Math.max(R, p.length());

  for (const n of nodes) {
    if (graphSet.has(n)) {
      n.goal.copy(center.pos).add(pos.get(n)); // the neighbours burst outward from the page
      n.wait = pos.get(n).length() * 0.025;    // nearest first, so it ripples out
      n.scaleGoal = n === center ? 1.3 : 0.95;
      n.opacityGoal = 0.95;
      if (n.state !== 'tile') {
        n.scroll = n.scrollGoal = 0;
        setPanelTexture(n, drawTile(n));
        n.state = 'tile';
        n.detailed = false;
      }
    } else {
      n.goal.copy(center.pos);                 // everything else collapses into the page and fades
      n.wait = 0;
      n.scaleGoal = 0.4;
      n.opacityGoal = 0;
    }
  }
  edges.forEach(([a, b], i) => { edgeVisGoal[i] = graphSet.has(a) && graphSet.has(b) ? 1 : 0; });
  crumb.textContent = `Knowledge Space  ›  ${center.title}  ›  Graph`;
  backBtn.hidden = false;
  controls.autoRotate = true;
  flyTo(center.pos, R * 1.5 + 3.2);
  fxImpact({ warpAmt: 1, flashAmt: 0.3, shockUV: { x: 0.5, y: 0.5 } }); // bigger bang for the graph
  emitSparks(center.pos, 220, { speed: 9, size: 1.6, life: 1.5, hue: center.hue });
  setHint('<b>Drag</b> orbit &nbsp;·&nbsp; <b>Hover</b> a note to trace its links &nbsp;·&nbsp; <b>Click</b> a note to open it &nbsp;·&nbsp; <b>Esc</b> back to the page');
}

function exitGraph() {
  if (graphMode) select(selected); // reopens the page with the usual depth arrangement
}

controls.addEventListener('start', () => { flying = false; });
refreshLinks();

// ---------- Input ----------

const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;

// Once zoomed into the mini graph its beads are clickable: nearest one within reach of the cursor
const beadPos = new THREE.Vector3();
function pickBead(e) {
  if (mz < 0.25) return null;
  let best = null, bestD = 40;
  for (const b of mini.beads) {
    if (b.node === selected) continue;
    b.soft.getWorldPosition(beadPos).project(camera);
    const d = Math.hypot((beadPos.x + 1) / 2 * innerWidth - e.clientX, (1 - beadPos.y) / 2 * innerHeight - e.clientY);
    if (d < bestD) { bestD = d; best = b.node; }
  }
  return best;
}

// Returns { node, link }: the panel under the pointer, and the note linked at that exact spot (if any)
function pick(e) {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  if (selected?.detailed && mini.show > 0.5) { // the mini graph floats in front of the page, so it is tested first
    const mh = ray.intersectObject(mini.disc, false)[0];
    if (mh) return { node: selected, link: null, uv: null, onMini: true, miniUV: mh.uv, bead: pickBead(e) };
  }
  const hit = ray.intersectObjects(panels.filter((p) => p.visible), false)[0];
  if (!hit) return { node: null, link: null, uv: null };
  const node = hit.object.userData.node;
  let link = null;
  if (node === selected && node.detailed) {
    const [W, H] = node.hitSize;
    const px = hit.uv.x * W, py = (1 - hit.uv.y) * H;
    link = node.hits.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)?.link ?? null;
  }
  return { node, link, uv: hit.uv };
}

// Dragging the mini graph spins its constellation like a trackball and keeps a little momentum on release.
// This listener runs first (capture) so OrbitControls does not also start orbiting the scene.
let miniDrag = null;
const miniSpin = new THREE.Vector2(); // angular velocity left over after a drag, rad/s (x = yaw, y = pitch)
const AXIS_X = new THREE.Vector3(1, 0, 0), AXIS_Y = new THREE.Vector3(0, 1, 0), spinQ = new THREE.Quaternion();

function spinMini(yaw, pitch) {
  mini.inner.quaternion.premultiply(spinQ.setFromAxisAngle(AXIS_Y, yaw));
  mini.inner.quaternion.premultiply(spinQ.setFromAxisAngle(AXIS_X, pitch)).normalize();
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY];
  if (!pick(e).onMini) return;
  miniDrag = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  miniSpin.set(0, 0);
  renderer.domElement.setPointerCapture(e.pointerId);
  renderer.domElement.style.cursor = 'grabbing';
  e.stopImmediatePropagation();
}, { capture: true });

const endMiniDrag = () => { miniDrag = null; };
addEventListener('pointerup', endMiniDrag);
addEventListener('pointercancel', endMiniDrag);
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const { node, link, onMini, bead } = pick(e);
  if (graphMode) { // on the graph screen: a tile opens that note, anything else steps back to the page
    if (node && node !== selected) select(node);
    else exitGraph();
    return;
  }
  if (onMini) {
    if (bead) select(bead);                // zoomed in: a bead opens its note
    else if (mz < 0.25) enterGraph();      // a plain click on the widget opens the isolated graph
  }
  else if (link) select(link);
  else if (node && node !== selected) select(node);
  else if (!node && selected) select(null);
});
// Sparkle trail: a couple of tiny sparks fall off the cursor as it moves, on a plane in front of the camera
let lastTrail = null;
const trailPlane = new THREE.Plane(), trailDir = new THREE.Vector3(), trailPoint = new THREE.Vector3(), trailAnchor = new THREE.Vector3();
function emitTrail(e) {
  if (lastTrail && Math.hypot(e.clientX - lastTrail[0], e.clientY - lastTrail[1]) < 16) return;
  lastTrail = [e.clientX, e.clientY];
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  camera.getWorldDirection(trailDir);
  trailPlane.setFromNormalAndCoplanarPoint(trailDir, trailAnchor.copy(camera.position).addScaledVector(trailDir, 9));
  if (ray.ray.intersectPlane(trailPlane, trailPoint)) {
    emitSparks(trailPoint, 2, { speed: 0.9, size: 0.8, life: 0.8, hue: 0.58 + Math.random() * 0.2, sat: 0.8, white: 0.55 });
  }
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!miniDrag && e.buttons === 0) emitTrail(e);
  if (miniDrag) {
    const dtm = Math.max((e.timeStamp - miniDrag.t) / 1000, 0.008);
    const yaw = (e.clientX - miniDrag.x) * 0.012, pitch = (e.clientY - miniDrag.y) * 0.012;
    spinMini(yaw, pitch);
    miniSpin.x = THREE.MathUtils.clamp(THREE.MathUtils.lerp(miniSpin.x, yaw / dtm, 0.5), -9, 9);
    miniSpin.y = THREE.MathUtils.clamp(THREE.MathUtils.lerp(miniSpin.y, pitch / dtm, 0.5), -9, 9);
    miniDrag.x = e.clientX; miniDrag.y = e.clientY; miniDrag.t = e.timeStamp;
    miniHovered = true;
    return;
  }
  const { node, link, uv, onMini, miniUV, bead } = pick(e);
  hovered = node;
  miniHovered = !!onMini;
  miniBead = bead ?? null;
  if (onMini) miniPointer.set(miniUV.x * 2 - 1, miniUV.y * 2 - 1);
  else if (node) node.mesh.material.uniforms.uPointer.value.copy(uv); // the glass lights up under the cursor
  renderer.domElement.style.cursor = onMini ? (bead ? 'pointer' : 'grab')
    : node && (link || node !== selected || graphMode) ? 'pointer' : 'default';
});

// Scrolling the open page: the wheel scrolls it while the pointer is over it (and zooms elsewhere),
// arrow / page keys work anywhere.
function scrollPage(delta) {
  if (!selected?.detailed) return;
  selected.scrollGoal = THREE.MathUtils.clamp(selected.scrollGoal + delta, 0, selected.scrollMax);
}

renderer.domElement.addEventListener('wheel', (e) => {
  if (!selected?.detailed) return;
  const { node, onMini } = pick(e);
  if (onMini) { // scrolling over the mini graph zooms into it; the notes get clearer and gain labels
    e.preventDefault();
    e.stopImmediatePropagation();
    const dy = e.deltaY * (e.deltaMode === 1 ? 40 : 1);
    if (dy < 0 && mzGoal >= 0.999) enterGraph(); // keep pushing in and you arrive in the full graph
    else mzGoal = THREE.MathUtils.clamp(mzGoal - dy * 0.0016, 0, 1);
    return;
  }
  if (node !== selected) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // keep OrbitControls from zooming
  scrollPage(e.deltaY * (e.deltaMode === 1 ? 40 : 1.4));
}, { capture: true, passive: false });

// Whatever the wheel did not already claim (page scroll, mini-graph zoom) zooms the camera.
// Zoom is multiplicative, so it feels the same close up and far away.
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  flying = false; // scrolling takes over from an automatic flight
  if (!zoomActive) {
    zoomCur = zoomGoal = camera.position.distanceTo(controls.target);
    zoomV = 0;
    zoomActive = true;
  }
  const dy = e.deltaY * (e.deltaMode === 1 ? 40 : 1);
  zoomGoal = THREE.MathUtils.clamp(zoomGoal * Math.exp(dy * 0.0014), controls.minDistance, controls.maxDistance);
}, { passive: false });

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (mzGoal > 0.02) mzGoal = 0;
    else if (graphMode) exitGraph();
    else if (selected) select(null);
  }
  const step = { ArrowDown: 120, ArrowUp: -120, PageDown: 700, PageUp: -700, ' ': 700 }[e.key];
  if (step && selected) { e.preventDefault(); scrollPage(step); }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resizeTargets();
  composer.setSize(innerWidth, innerHeight);
  lensOf('uAspect').value = innerWidth / innerHeight;
});

// ---------- Node icon ----------

// A soft glass bead: halo, ring and a bright core. Drawn once and shared by all nodes.
const iconTex = (() => {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const m = S / 2;
  const halo = ctx.createRadialGradient(m, m, 6, m, m, m);
  halo.addColorStop(0, 'rgba(255, 255, 255, 0.45)');
  halo.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.arc(m, m, 26, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(m, m, 11, 0, Math.PI * 2); ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

const right = new THREE.Vector3();
const up = new THREE.Vector3();
const mid = new THREE.Vector3();
const ctrl = new THREE.Vector3();
const curvePt = new THREE.Vector3();
const tetherStart = new THREE.Vector3();

for (const n of nodes) {
  n.anchor = new THREE.Vector3();
  n.icon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: iconTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(n.icon);
}

// Deep link: index.html#Three.js opens that note straight away
{
  const target = byTitle.get(decodeURIComponent(location.hash.slice(1)).toLowerCase());
  if (target) select(target, true);
}

// ---------- Loop ----------

const startMs = performance.now();
let lastT = 0;

renderer.setAnimationLoop(() => {
  const t = (performance.now() - startMs) / 1000;
  const dt = Math.min(0.05, t - lastT);
  lastT = t;
  timeUniform.value = t;
  sky.position.copy(camera.position); // the sky has no parallax

  if (flying) {
    flightT = Math.min(1, flightT + dt / flightDur);
    const k = easeInOutCubic(flightT);
    controls.target.lerpVectors(flightFromTarget, goalTarget, k);
    camera.position.lerpVectors(flightFromCam, goalCam, k);
    if (flightT >= 1) flying = false;
  }

  // eased scroll-zoom: a spring on the camera's distance from its focus point
  if (zoomActive) {
    zoomCur = dampTo(zoomCur, zoomV, zoomGoal, 7, dt);
    zoomV = dampV;
    zoomDir.subVectors(camera.position, controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(zoomDir, zoomCur);
    if (Math.abs(zoomCur - zoomGoal) < 0.004) zoomActive = false;
  }
  controls.update();

  if (selected?.detailed && Math.abs(selected.scrollGoal - selected.scroll) > 0.5) {
    const n = selected; // spring toward the target, redrawing the page texture as it moves
    n.scroll = dampTo(n.scroll, n.scrollV || 0, n.scrollGoal, 14, dt);
    n.scrollV = dampV;
    setPanelTexture(n, drawPanel(n, true, 0, n.scroll));
  }

  // while the mini graph is hovered, the notes it connects step forward and the rest recede
  const miniFocus = selected && mini.owner === selected && !graphMode ? (mini.e || 0) : 0;

  for (const n of nodes) {
    const m = n.mesh, u = m.material.uniforms;
    m.quaternion.copy(camera.quaternion); // panels always face the viewer
    // gentle floating, so the depth parallax is visible even at rest
    if (n.wait > 0) n.wait -= dt; // cascade: notes set off one after another
    else {
      n.cur.x = dampTo(n.cur.x, n.vel.x, n.goal.x, 6, dt); n.vel.x = dampV;
      n.cur.y = dampTo(n.cur.y, n.vel.y, n.goal.y, 6, dt); n.vel.y = dampV;
      n.cur.z = dampTo(n.cur.z, n.vel.z, n.goal.z, 6, dt); n.vel.z = dampV;
    }
    const bob = n === selected ? 1 - (mini.zoomE || 0) : 1; // the open page stops floating while you read its mini graph
    m.position.set(n.cur.x, n.cur.y + Math.sin(t * 0.8 + n.index) * 0.06 * bob, n.cur.z);
    let og = n.opacityGoal, sg = n.scaleGoal * (n === hovered && n !== selected ? 1.12 : 1), hv = n === hovered ? 1 : 0;
    if (miniFocus > 0.01 && n !== selected) {
      if (selected.links.has(n)) {
        const isBead = n === miniBead;
        og = THREE.MathUtils.lerp(og, 0.98, miniFocus);
        sg *= 1 + (isBead ? 0.38 : 0.16) * miniFocus;
        hv = Math.max(hv, (isBead ? 1 : 0.6) * miniFocus);
      } else og *= 1 - 0.75 * miniFocus;
    }
    // level of detail: once a note is too small on screen to read, it cross-fades into its icon tile (and grows a little)
    const camDist = camera.position.distanceTo(m.position);
    const shown = PANEL_H * n.scaleGoal / (2 * camDist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))); // fraction of screen height
    const lodGoal = n.detailed ? 0 : 1 - THREE.MathUtils.smoothstep(shown, 0.045, 0.1);
    u.uLod.value = THREE.MathUtils.lerp(u.uLod.value, lodGoal, 0.12);
    sg *= 1 + 1.1 * u.uLod.value;
    const sc = dampTo(m.scale.x, n.scaleV, sg, 9, dt); // springy but never overshooting
    n.scaleV = dampV;
    m.scale.set(sc, sc, 1);
    u.uOpacity.value = THREE.MathUtils.lerp(u.uOpacity.value, og, 0.1);
    u.uHover.value = THREE.MathUtils.lerp(u.uHover.value, hv, 0.15);
    u.uDim.value = n === selected ? (mini.zoomE || 0) : 0;
    u.uBackdropMix.value = THREE.MathUtils.lerp(u.uBackdropMix.value, n === selected && n.detailed ? 1 : 0, 0.1);
    n.icon.visible = m.visible = u.uOpacity.value > 0.01 || n.opacityGoal > 0.01; // fully faded notes are neither drawn nor pickable
  }

  // Graph screen: hovering a tile lights its connections and dims the notes it is not linked to
  if (graphMode) {
    edges.forEach(([a, b], i) => {
      edgeHotGoal[i] = hovered
        ? (a === hovered || b === hovered ? 1 : 0.05)
        : (a === selected || b === selected ? 0.6 : 0.2);
    });
    for (const n of graphSet) {
      n.opacityGoal = hovered && n !== hovered && !hovered.links.has(n) ? 0.35 : 0.95;
    }
  }

  // Mini graph: lifts off the page, leans toward the cursor and spins up while hovered
  if (mini.owner) {
    const showTarget = selected?.detailed && !graphMode ? 1 : 0;
    mini.show = dampTo(mini.show, mini.showV || 0, showTarget, 8, dt); mini.showV = dampV;
    mini.hover = dampTo(mini.hover, mini.hoverV || 0, miniHovered && showTarget ? 1 : 0, 9, dt); mini.hoverV = dampV;
    mini.hover = THREE.MathUtils.clamp(mini.hover, 0, 1);
    const e = mini.hover * mini.hover * (3 - 2 * mini.hover);
    mini.e = e;

    // scrolling into it: the widget grows toward the middle of the page and its notes come into focus
    if (!miniHovered) mzGoal = Math.max(0, mzGoal - dt * 0.9); // eases back out when you leave it
    mz = dampTo(mz, mzV, mzGoal, 6, dt); mzV = dampV;
    const z = mz * mz * (3 - 2 * mz);
    mini.zoomE = z;

    mini.root.visible = mini.shadow.visible = mini.show > 0.01;
    const calm = 1 - THREE.MathUtils.smoothstep(mz, 0.02, 0.4); // 1 at rest, 0 once you have scrolled in a little
    const px = MINI_X * (1 - z), py = MINI_Y * (1 - z) + Math.sin(t * 1.6) * 0.006 * (1 + 2 * e) * calm;
    const grow = mini.show * (1 + 0.6 * e) * (1 + 5.0 * z);
    mini.root.position.set(px, py, 0.03 + 0.34 * e + 0.5 * z);
    mini.root.scale.setScalar(grow);
    // everything holds still once you are zooming: no cursor-following tilt, no spin, no bob
    const lean = miniDrag ? 0 : calm; // the lens stays flat while you drag the constellation
    mini.tilt.rotation.x += (miniPointer.y * 0.6 * e * lean - mini.tilt.rotation.x) * 0.18;
    mini.tilt.rotation.y += (-miniPointer.x * 0.6 * e * lean - mini.tilt.rotation.y) * 0.18;
    if (!miniDrag) {
      spinMini(dt * (0.35 + 1.4 * e) * calm, 0);                 // idle spin
      spinMini(miniSpin.x * dt, miniSpin.y * dt);                // momentum from the last drag
      miniSpin.multiplyScalar(Math.exp(-dt * 2.5));
    }
    mini.inner.updateMatrix();
    mini.disc.material.uniforms.uHover.value = e;
    mini.disc.material.uniforms.uZoom.value = z;
    mini.lines.material.opacity = 0.32 + 0.45 * e + 0.2 * z;
    mini.label.material.opacity = e * (1 - THREE.MathUtils.smoothstep(mz, 0.0, 0.12)); // gone as soon as you zoom in
    mini.shadow.position.set(px + 0.06 * e, py - 0.08 * e, 0.012); // drifts away as it lifts
    mini.shadow.scale.setScalar(grow);
    mini.shadow.material.uniforms.uStrength.value = (0.32 - 0.08 * e) * (1 - 0.6 * z);

    // beads: soft glow from afar, crisp token and title chip up close
    const beadScale = THREE.MathUtils.lerp(1, 0.38, z);
    const chip = THREE.MathUtils.smoothstep(mz, 0.1, 0.5);
    for (const b of mini.beads) {
      const isCenter = b.node === selected, isHot = b.node === miniBead;
      const size = (isCenter ? 0.115 : 0.062) * beadScale * (isHot ? 1.5 : 1);
      b.soft.scale.setScalar(size * 1.15);
      b.soft.material.opacity = 1 - 0.75 * z;
      b.crisp.scale.setScalar(size * 0.85);
      b.crisp.material.opacity = THREE.MathUtils.smoothstep(mz, 0.05, 0.6);
      beadPos.copy(b.local).applyMatrix4(mini.inner.matrix);
      const lh = 0.026 * (isHot ? 1.2 : 1);
      b.label.scale.set(lh * 5, lh, 1);
      b.label.position.set(beadPos.x, beadPos.y - size * 0.7 - lh * 0.75, beadPos.z + 0.001);
      b.label.material.opacity = chip * (isHot || isCenter ? 1 : 0.9);
      b.label.visible = chip > 0.01;
    }
  }

  // links recede while a page is open
  const sel = lineMat.uniforms.uSelected;
  sel.value = THREE.MathUtils.lerp(sel.value, selected ? 1 : 0, 0.08);

  // links attach to each panel's top-left corner (panels face the camera, so that is camera-left / camera-up)
  right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  for (const n of nodes) {
    const m = n.mesh;
    n.anchor.copy(m.position)
      .addScaledVector(right, -PANEL_W / 2 * m.scale.x)
      .addScaledVector(up, PANEL_H / 2 * m.scale.y);
    n.icon.position.copy(n.anchor);
    const pulse = n === selected ? 1 + Math.sin(t * 4) * 0.12 : 1;
    const size = (n === selected ? 0.34 : n === hovered ? 0.3 : 0.24) * pulse;
    n.icon.scale.set(size, size, 1);
    n.icon.material.opacity = Math.min(1, m.material.uniforms.uOpacity.value + 0.05);
  }
  edges.forEach(([a, b], i) => {
    // gentle arc: quadratic curve whose control point is nudged sideways in screen space
    edgeHot[i] += (edgeHotGoal[i] - edgeHot[i]) * 0.1;
    edgeVis[i] += (edgeVisGoal[i] - edgeVis[i]) * 0.1;
    lineVis.fill(edgeVis[i], i * LINE_SEG * 2, (i + 1) * LINE_SEG * 2);
    mid.addVectors(a.anchor, b.anchor).multiplyScalar(0.5);
    const bulge = a.anchor.distanceTo(b.anchor) * 0.14;
    ctrl.copy(mid)
      .addScaledVector(right, Math.cos(edgeBend[i]) * bulge)
      .addScaledVector(up, Math.sin(edgeBend[i]) * bulge);
    for (let k = 0; k <= LINE_SEG; k++) {
      const s = k / LINE_SEG, r = 1 - s;
      curvePt.set(
        r * r * a.anchor.x + 2 * r * s * ctrl.x + s * s * b.anchor.x,
        r * r * a.anchor.y + 2 * r * s * ctrl.y + s * s * b.anchor.y,
        r * r * a.anchor.z + 2 * r * s * ctrl.z + s * s * b.anchor.z,
      );
      // each point is the end of segment k-1 and the start of segment k
      if (k > 0) curvePt.toArray(linePos, ((i * LINE_SEG + k - 1) * 2 + 1) * 3);
      if (k < LINE_SEG) curvePt.toArray(linePos, ((i * LINE_SEG + k) * 2) * 3);
    }
    lineHot.fill(edgeHot[i], i * LINE_SEG * 2, (i + 1) * LINE_SEG * 2);
  });
  lineGeo.attributes.position.needsUpdate = true;
  lineGeo.attributes.aHot.needsUpdate = true;
  lineGeo.attributes.aVis.needsUpdate = true;

  // Tethers: threads from each bead of the hovered mini graph to the real note it stands for
  {
    let count = 0;
    if (miniFocus > 0.01) {
      selected.mesh.updateMatrixWorld(true);
      for (const b of mini.beads) {
        if (b.node === selected) continue;
        b.soft.getWorldPosition(tetherStart);
        const end = b.node.anchor;
        mid.addVectors(tetherStart, end).multiplyScalar(0.5);
        const bulge = tetherStart.distanceTo(end) * 0.18;
        ctrl.copy(mid).addScaledVector(up, bulge).addScaledVector(right, (count % 2 ? 1 : -1) * bulge * 0.4);
        for (let k = 0; k <= TETHER_SEG; k++) {
          const s = k / TETHER_SEG, r = 1 - s;
          curvePt.set(
            r * r * tetherStart.x + 2 * r * s * ctrl.x + s * s * end.x,
            r * r * tetherStart.y + 2 * r * s * ctrl.y + s * s * end.y,
            r * r * tetherStart.z + 2 * r * s * ctrl.z + s * s * end.z,
          );
          if (k > 0) curvePt.toArray(tetherPos, ((count * TETHER_SEG + k - 1) * 2 + 1) * 3);
          if (k < TETHER_SEG) curvePt.toArray(tetherPos, (count * TETHER_SEG + k) * 2 * 3);
        }
        const lo = count * TETHER_SEG * 2, hi = lo + TETHER_SEG * 2;
        tetherHot.fill(miniBead ? (b.node === miniBead ? 1 : 0.3) : 0.85, lo, hi);
        tetherVis.fill(miniFocus, lo, hi);
        count++;
      }
    }
    tetherGeo.setDrawRange(0, count * TETHER_SEG * 2);
    tetherGeo.attributes.position.needsUpdate = true;
    tetherGeo.attributes.aHot.needsUpdate = true;
    tetherGeo.attributes.aVis.needsUpdate = true;
  }

  if (selected?.detailed) renderBackdrop(selected); // blurred copy of everything behind the open page
  // VFX decay, then the whole frame goes through bloom + the lens pass
  warp *= Math.exp(-dt * 3.2);
  flash *= Math.exp(-dt * 5);
  lensOf('uWarp').value = warp;
  lensOf('uFlash').value = flash;
  lensOf('uShock').value.z = t - shockAt;
  updateMotionBlur(dt);
  updateHoverTag(t, dt);
  composer.render();
});
