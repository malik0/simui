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

// ?data=news switches to the generated news dataset (npm run news); the default is the VR notes
const DATASET = new URLSearchParams(location.search).get('data') === 'news' ? 'news' : 'vr';
const DIR = DATASET === 'news' ? 'database-news' : 'database';
const SPACE = DATASET === 'news' ? "Today's News" : 'Knowledge Space';
const allFiles = {
  vr: import.meta.glob('./database/*.md', { query: '?raw', import: 'default', eager: true }),
  news: import.meta.glob('./database-news/*.md', { query: '?raw', import: 'default', eager: true }),
};
const allImages = {
  vr: import.meta.glob('./database/images/*', { query: '?url', import: 'default', eager: true }),
  news: import.meta.glob('./database-news/images/*', { query: '?url', import: 'default', eager: true }),
};
const files = allFiles[DATASET];

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
    if (/^\[video\]\(youtube:/.test(l)) return null; // picked up as node.video below
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
  n.video = n.body.match(/^\[video\]\(youtube:([\w-]{6,})\)/m)?.[1] ?? null; // YouTube id, played in an overlay
}

// Images referenced from notes as ![caption](images/file.svg), resolved relative to database/
const imageUrls = allImages[DATASET];
const images = new Map();
await Promise.all(nodes.filter((n) => n.image).map(async (n) => {
  const url = imageUrls[`./${DIR}/${n.image.src}`];
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
  world: Globe, tech: Cpu, business: Gauge, sport: Timer, video: Radar, section: LayoutGrid,
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

// ---------- Themes ----------

// A theme is a palette plus a few knobs. Every colour a shader reads lives in `T`, which eases toward the goal
// values in `G` whenever the theme changes, so switching blends smoothly instead of popping. Colours baked into
// textures (page text, tiles, icons) are simply redrawn.
const THEMES = {
  nebula: {
    label: 'Nebula',
    clear: '#070b24', fog: '#141a45',
    sky: { navy: '#060a22', blue: '#2a63ff', violet: '#9442ff', teal: '#12c9c4', pink: '#ff4f9c', ray: '#ffffff' },
    pane: [0.50, 0.58, 0.80], frost: [0.05, 0.06, 0.085], rim: [1, 1, 1], accent: [0.55, 0.68, 1.0],
    line: [0.45, 0.60, 1.0], dust: [0.78, 0.86, 1.0],
    nums: [0, 0.55, 1.4],  // god rays, bloom strength, twinkle speed
    nums2: [0.15, 1, 0],   // dust drift, dust size
    text: { link: '#8ccbff', linkLine: 'rgba(140, 203, 255, 0.5)', bullet: '#7cc0ff' },
    chip: 'rgba(24, 32, 84, 0.86)', chipSoft: 'rgba(40, 52, 120, 0.82)', miniLine: '#a9c1ff',
    hue: (h) => h, trailHue: [0.58, 0.2],
    // page view: the paper itself and the ink printed on it
    paper: { base: '#ece8f0', edge: '#bdb6cf', ink: '#241f33', link: '#2b4fb8', sub: 'rgba(36, 31, 51, 0.62)', rule: 'rgba(36, 31, 51, 0.30)', plate: 'rgba(22, 30, 70, 0.94)' },
    css: {
      '--bg': '#0b1233', '--pill-top': 'rgba(255, 255, 255, 0.20)', '--pill-bot': 'rgba(255, 255, 255, 0.08)',
      '--pill-edge': 'rgba(255, 255, 255, 0.28)', '--pill-text': 'rgba(255, 255, 255, 0.92)',
      '--vignette': 'rgba(2, 4, 18, 0.55)', '--tint': 'rgba(70, 90, 210, 0.35)',
    },
  },
  forest: {
    label: 'Forest',
    clear: '#03100a', fog: '#0b2a1b',
    sky: { navy: '#030d08', blue: '#0e5233', violet: '#1d7a3d', teal: '#1fb89a', pink: '#e0b84c', ray: '#ffe7a0' },
    pane: [0.42, 0.70, 0.52], frost: [0.025, 0.075, 0.04], rim: [1.0, 0.96, 0.78], accent: [0.65, 1.0, 0.70],
    line: [0.55, 0.90, 0.60], dust: [1.0, 0.88, 0.45], // fireflies
    nums: [1.0, 0.62, 2.2],
    nums2: [1.0, 1.35, 0],
    text: { link: '#a9f0b8', linkLine: 'rgba(169, 240, 184, 0.5)', bullet: '#ffd57a' },
    chip: 'rgba(8, 44, 26, 0.88)', chipSoft: 'rgba(10, 60, 34, 0.85)', miniLine: '#b9f0c0',
    hue: (h) => 0.06 + h * 0.44, // amber, gold, moss, jade, teal: nothing outside the forest palette
    trailHue: [0.12, 0.18],
    paper: { base: '#ece8cc', edge: '#b9b88a', ink: '#1c2a1a', link: '#1f7a45', sub: 'rgba(28, 42, 26, 0.62)', rule: 'rgba(28, 42, 26, 0.30)', plate: 'rgba(8, 40, 24, 0.94)' },
    css: {
      '--bg': '#04100a', '--pill-top': 'rgba(210, 255, 225, 0.20)', '--pill-bot': 'rgba(210, 255, 225, 0.07)',
      '--pill-edge': 'rgba(220, 255, 230, 0.28)', '--pill-text': 'rgba(240, 255, 244, 0.94)',
      '--vignette': 'rgba(1, 10, 4, 0.62)', '--tint': 'rgba(40, 150, 80, 0.35)',
    },
  },
  // near-black sky, a faint cold glow where the nebula would be, silvery glass; pages are printed on dark stock
  eclipse: {
    label: 'Eclipse',
    clear: '#020204', fog: '#07080f',
    sky: { navy: '#020204', blue: '#10162e', violet: '#1c1534', teal: '#0a2a30', pink: '#2e1424', ray: '#ffffff' },
    pane: [0.40, 0.42, 0.52], frost: [0.012, 0.014, 0.022], rim: [0.92, 0.94, 1], accent: [0.78, 0.84, 1.0],
    line: [0.62, 0.68, 0.88], dust: [0.82, 0.86, 1.0],
    nums: [0, 0.42, 1.0],
    nums2: [0.1, 0.9, 0],
    text: { link: '#a9bdff', linkLine: 'rgba(169, 189, 255, 0.5)', bullet: '#c9b2ff' },
    chip: 'rgba(8, 9, 16, 0.9)', chipSoft: 'rgba(18, 20, 34, 0.86)', miniLine: '#b8c4ee',
    hue: (h) => 0.56 + h * 0.4, // cool blues through violet to magenta
    trailHue: [0.6, 0.1],
    paper: { base: '#1b1c26', edge: '#0c0d14', ink: '#e8e9f2', link: '#93b0ff', sub: 'rgba(232, 233, 242, 0.62)', rule: 'rgba(232, 233, 242, 0.24)', plate: 'rgba(255, 255, 255, 0.06)' },
    css: {
      '--bg': '#030306', '--pill-top': 'rgba(255, 255, 255, 0.11)', '--pill-bot': 'rgba(255, 255, 255, 0.04)',
      '--pill-edge': 'rgba(255, 255, 255, 0.18)', '--pill-text': 'rgba(240, 242, 252, 0.92)',
      '--vignette': 'rgba(0, 0, 0, 0.72)', '--tint': 'rgba(120, 132, 210, 0.30)',
    },
  },
};

// ?theme=forest wins, then the last theme you picked, then nebula
let themeName = 'nebula';
try {
  const asked = new URLSearchParams(location.search).get('theme'), saved = localStorage.getItem('kg-theme');
  themeName = THEMES[asked] ? asked : THEMES[saved] ? saved : 'nebula';
} catch { /* storage blocked */ }
let theme = THEMES[themeName];
const hueOf = (n) => theme.hue(n.hue); // a note's colour, mapped into the current theme's palette

const C = (hex) => new THREE.Color(hex);
const V = (a) => new THREE.Vector3().fromArray(a);
const T = { // live values, read by the shaders
  clear: C(theme.clear), fog: C(theme.fog),
  navy: C(theme.sky.navy), blue: C(theme.sky.blue), violet: C(theme.sky.violet), teal: C(theme.sky.teal),
  pink: C(theme.sky.pink), ray: C(theme.sky.ray),
  pane: V(theme.pane), frost: V(theme.frost), rim: V(theme.rim), accent: V(theme.accent),
  line: V(theme.line), dust: V(theme.dust), nums: V(theme.nums), nums2: V(theme.nums2),
  paper: C(theme.paper.base), paperEdge: C(theme.paper.edge),
};
const G = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.clone()])); // where they are heading

function setThemeGoals(th) {
  G.clear.set(th.clear); G.fog.set(th.fog);
  for (const k of ['navy', 'blue', 'violet', 'teal', 'pink', 'ray']) G[k].set(th.sky[k]);
  for (const k of ['pane', 'frost', 'rim', 'accent', 'line', 'dust', 'nums', 'nums2']) G[k].fromArray(th[k]);
  G.paper.set(th.paper.base); G.paperEdge.set(th.paper.edge);
  for (const [k, v] of Object.entries(th.css)) document.documentElement.style.setProperty(k, v);
}
setThemeGoals(theme);

// ---------- Scene ----------

const scene = new THREE.Scene();
scene.background = T.clear;
scene.fog = new THREE.Fog(0x141a45, 10, 40);
scene.fog.color = T.fog;

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
      uNavy: { value: T.navy },
      uBlue: { value: T.blue },
      uViolet: { value: T.violet },
      uTeal: { value: T.teal },
      uPink: { value: T.pink },
      uRayColor: { value: T.ray },
      uNums: { value: T.nums }, // x = how strong the god rays are (0 in the nebula, 1 in the forest)
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uNavy, uBlue, uViolet, uTeal, uPink, uRayColor, uNums;
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

        // god rays: shafts of light falling through a canopy, drifting slowly (forest theme only)
        float azimuth = atan(d.x, d.z);
        float shafts = pow(fbm(vec3(azimuth * 2.6, uTime * 0.05, 4.0)), 3.0);
        col += uRayColor * uNums.x * shafts * 2.4 * smoothstep(0.02, 0.95, d.y);

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
    // stars in the nebula, drifting fireflies in the forest: same particles, different colour / twinkle / wander
    uniforms: {
      uTime: timeUniform, uPx: { value: renderer.getPixelRatio() },
      uDust: { value: T.dust }, uNums: { value: T.nums }, uNums2: { value: T.nums2 },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      uniform float uPx;
      uniform vec3 uNums;   // z = twinkle speed
      uniform vec3 uNums2;  // x = wander amount, y = size
      varying float vTw;
      varying float vDepth;
      void main() {
        vec3 wander = uNums2.x * 0.6 * vec3(sin(uTime * 0.31 + aPhase), cos(uTime * 0.23 + aPhase * 1.7), sin(uTime * 0.19 + aPhase * 0.6));
        vec4 mv = modelViewMatrix * vec4(position + wander, 1.0);
        vDepth = -mv.z;
        vTw = 0.55 + 0.45 * sin(uTime * uNums.z + aPhase);
        gl_PointSize = aSize * uNums2.y * uPx * 70.0 / max(vDepth, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uDust;
      varying float vTw;
      varying float vDepth;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        a *= a * vTw * (1.0 - smoothstep(18.0, 38.0, vDepth));
        gl_FragColor = vec4(uDust, a * 0.9);
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
  uPane: { value: T.pane },     // tints that make the glass feel like the current theme
  uFrost: { value: T.frost },
  uRim: { value: T.rim },
  uAccent: { value: T.accent },
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
      uHide: { value: 0 },                              // 1 = the glass is gone because the note has turned into paper
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
      uniform float uHide;
      uniform float uTime;
      uniform float uSeed;
      uniform vec2 uPointer;
      uniform vec3 uPane;
      uniform vec3 uFrost;
      uniform vec3 uRim;
      uniform vec3 uAccent;
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
        vec3 frost = back * 0.84 + uFrost;

        // light pane for panels that are not backed by the live blur
        vec3 pane = uPane;
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
        col += uRim * (rimLit * 0.95 + glow + sheen + uHover * 0.07);
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
        col += mix(vec3(1.0), uRim, 0.5) * sweep * (0.05 + 0.10 * uHover + 0.05 * uBackdropMix);
        a += sweep * 0.05;

        // touch light: the pane catches a soft highlight where the cursor is
        vec2 dp = (vUv - uPointer) * uSize;
        float touch = exp(-dot(dp, dp) * 2.6) * uHover;
        col += uAccent * touch * 0.24 + irid * touch * rim * 0.4;
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
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * mask * uOpacity * (1.0 - uHide));
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

// play badge drawn over a video note's thumbnail (cx, cy = centre of the picture, r = radius)
function playBadge(ctx, cx, cy, r) {
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fill();
  ctx.lineWidth = r * 0.07; ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - r * 0.28, cy - r * 0.42); ctx.lineTo(cx + r * 0.5, cy); ctx.lineTo(cx - r * 0.28, cy + r * 0.42); ctx.closePath();
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.restore();
}

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
// News-style card for notes with a photo: the picture fills the panel and the headline sits on a dark gradient so it stays readable
function drawPoster(node, picture, blur) {
  const W = 512, H = 640, m = 10, r = 30, pad = 30;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.beginPath(); ctx.roundRect(m, m, W - m * 2, H - m * 2, r);
  ctx.fillStyle = 'rgba(10, 14, 36, 0.9)'; ctx.fill();
  ctx.save();
  ctx.clip();
  if (picture) {
    const fit = Math.max((W - m * 2) / picture.width, (H - m * 2) / picture.height); // cover
    ctx.drawImage(picture, (W - picture.width * fit) / 2, (H - picture.height * fit) / 2, picture.width * fit, picture.height * fit);
  } else { // no photo: a soft wash of the category colour behind the headline
    const hue = Math.round(hueOf(node) * 360);
    const wash = ctx.createLinearGradient(0, 0, W, H);
    wash.addColorStop(0, `hsl(${hue}, 55%, 34%)`); wash.addColorStop(1, `hsl(${(hue + 40) % 360}, 60%, 16%)`);
    ctx.fillStyle = wash; ctx.fillRect(0, 0, W, H);
  }
  const top = ctx.createLinearGradient(0, 0, 0, 170);
  top.addColorStop(0, 'rgba(4, 6, 20, 0.6)'); top.addColorStop(1, 'rgba(4, 6, 20, 0)');
  ctx.fillStyle = top; ctx.fillRect(0, 0, W, 170);
  const bottom = ctx.createLinearGradient(0, H * 0.36, 0, H);
  bottom.addColorStop(0, 'rgba(6, 8, 24, 0)'); bottom.addColorStop(0.45, 'rgba(6, 8, 24, 0.72)'); bottom.addColorStop(1, 'rgba(6, 8, 24, 0.95)');
  ctx.fillStyle = bottom; ctx.fillRect(0, H * 0.36, W, H * 0.64);
  ctx.restore();

  ctx.textBaseline = 'top';
  // headline, bottom-aligned
  ctx.font = `650 34px ${FONT}`;
  let lines = wrap(ctx, node.title, W - pad * 2);
  if (lines.length > 4) { lines = lines.slice(0, 4); lines[3] = lines[3].replace(/[ ,.;:]*$/, '') + '…'; }
  const lh = 42, textTop = H - m - 30 - lines.length * lh;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'; ctx.shadowBlur = 10;
  ctx.fillStyle = '#fff';
  lines.forEach((l, i) => ctx.fillText(l, pad, textTop + i * lh));
  ctx.shadowBlur = 0;
  // kicker above the headline: category and source
  ctx.font = `600 14px ${FONT}`;
  ctx.letterSpacing = '2px';
  ctx.fillStyle = new THREE.Color().setHSL(hueOf(node), 0.85, 0.72).getStyle();
  ctx.fillText(node.tags.slice(0, 2).join('  ·  ').toUpperCase(), pad, textTop - 28);
  ctx.letterSpacing = '0px';
  if (node.video) playBadge(ctx, W / 2, H * 0.36, 46);
  return toTexture(c, blur, 1);
}

function drawPanel(node, detailed, blur = 0, scroll = 0) {
  const lead = node.image && !node.image.src.endsWith('.svg') && images.get(node.image.src);
  const story = DATASET === 'news' && !node.tags.includes('index') && !node.tags.includes('section');
  if (!detailed && (lead || story)) { // photo notes (and every news story) are drawn as poster cards
    node.hits = [];
    node.hitSize = [512, 640];
    node.scrollMax = 0;
    return drawPoster(node, lead || null, blur);
  }
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
  let pictureRect = null; // the thumbnail's box, clickable on a video note
  if (picture) {
    const bw = W - pad * 2, bh = (detailed ? 290 : 140) * s, inset = 14 * s;
    pictureRect = { x: pad, y, w: bw, h: bh, video: true };
    pill(pad, y, bw, bh, 18 * s);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
    ctx.fill();
    ctx.save();
    ctx.clip();
    const photo = !/\.svg$/i.test(node.image.src); // photos fill the frame, diagrams stay whole
    const fit = photo ? Math.max(bw / picture.width, bh / picture.height) : Math.min((bw - inset * 2) / picture.width, (bh - inset * 2) / picture.height);
    const iw = picture.width * fit, ih = picture.height * fit;
    ctx.drawImage(picture, pad + (bw - iw) / 2, y + (bh - ih) / 2, iw, ih);
    ctx.restore();
    if (node.video) playBadge(ctx, pad + bw / 2, y + bh / 2, Math.min(bh * 0.2, 44 * s));
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
  const hits = detailed && node.video && pictureRect ? [pictureRect] : [];
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
        ctx.fillStyle = theme.text.bullet;
        ctx.beginPath();
        ctx.arc(pad + 7 * s, y + fontPx * 0.62, 3 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const w of wrapped[i]) {
        const wx = pad + indent + w.x;
        ctx.fillStyle = w.link ? theme.text.link : isH ? 'rgba(255, 255, 255, 0.98)' : 'rgba(255, 255, 255, 0.86)';
        ctx.fillText(w.word, wx, y);
        if (w.link) {
          ctx.fillStyle = theme.text.linkLine;
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
  const cx = W / 2, hue = Math.round(hueOf(node) * 360);

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
  const cx = W / 2, cy = 245 * s, hue = Math.round(hueOf(node) * 360);

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
  uniforms: { uTime: timeUniform, uFog: shared.uFog, uSelected: { value: 0 }, uLineColor: { value: T.line } },
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
    uniform vec3 uLineColor;
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
      vec3 col = mix(uLineColor, vec3(1.0), clamp(vHot * 0.55 + pulse * 0.5, 0.0, 1.0));
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

function flyTo(target, dist, dirOverride) {
  const dir = (dirOverride ? dirOverride.clone() : new THREE.Vector3().subVectors(camera.position, controls.target)).normalize();
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
const playBtn = document.getElementById('play');
const player = document.getElementById('player');
const updatePlay = () => { playBtn.hidden = !(selected && selected.video && !graphMode); };
function openVideo(id) {
  player.querySelector('.frame').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  player.querySelector('.yt').href = `https://www.youtube.com/watch?v=${id}`;
  player.classList.add('open');
}
function closeVideo() {
  player.classList.remove('open');
  player.querySelector('.frame').innerHTML = ''; // drops the iframe, which stops playback
}
playBtn.addEventListener('click', () => selected?.video && openVideo(selected.video));
player.addEventListener('click', (e) => { if (e.target === player || e.target.closest('.close')) closeVideo(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && player.classList.contains('open')) { closeVideo(); e.stopImmediatePropagation(); } }, true);
document.querySelectorAll('#dataset a').forEach((a) => a.classList.toggle('on', a.dataset.data === DATASET));
document.title = SPACE;
crumb.textContent = SPACE;
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
    const c = `hsl(${Math.round(hueOf(want) * 360)} 92% 70%)`;
    tagEl.style.setProperty('--c', c);
    leaderEl.style.setProperty('--c', c);
    if (fresh) { // start at the node and spring outward
      tagProj.copy(want.anchor).project(camera);
      tagPos.x = (tagProj.x + 1) / 2 * innerWidth;
      tagPos.y = (1 - tagProj.y) / 2 * innerHeight;
      tagPos.vx = tagPos.vy = 0;
    }
    emitSparks(want.anchor, 6, { speed: 1.6, size: 1.0, life: 0.7, hue: hueOf(want) });
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
  if (node && layoutMode === 'rail') { railGoal = railCur = node.group.index; railV = 0; } // closing the note returns to its category
  graphMode = false;
  mzGoal = mz = mzV = 0;
  miniBead = null;
  graphSet.clear();
  edgeVisGoal.fill(!node && layoutMode === 'rail' ? 0.06 : 1); // links are noise between flat walls, so they hide until a note is open
  backBtn.hidden = true;
  setHint(layoutMode === 'rail' ? railHint : defaultHint);
  controls.autoRotate = !node && layoutMode === 'graph';
  if (node) applyOrbitLimits();
  crumb.textContent = node ? `${SPACE}  ›  ${node.title}` : SPACE;
  updatePlay();
  history.replaceState(null, '', node ? `#${encodeURIComponent(node.title)}` : location.pathname + location.search);
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
  if (node) { setupMini(node); attachPaper(node); }
  if (node) flyTo(node.pos, 6.5);
  else goHome();
  if (!instant) {
    // opening a note: the view warps as the camera dives in, then a shockwave and a burst of sparks land with it
    fxImpact({ warpAmt: node ? 0.55 : 0.25 });
    if (node) {
      setTimeout(() => {
        if (selected !== node) return;
        fxImpact({ warpAmt: 0, shockUV: { x: 0.5, y: 0.5 } });
        emitSparks(node.pos, 90, { speed: 7, size: 1.8, life: 1.2, hue: hueOf(node) });
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

const makeLabelTex = () => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.roundRect(6, 6, 308, 52, 26);
  ctx.fillStyle = theme.chipSoft;
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
};
const labelTex = makeLabelTex();

const mini = (() => {
  const root = new THREE.Group();   // position / scale / lift
  const tilt = new THREE.Group();   // leans toward the cursor
  const inner = new THREE.Group();  // spins; holds the beads and threads
  root.add(tilt);
  tilt.add(inner);

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(MINI_R * 1.15, 64), // a little larger than the bubble, so its wobbling edge has room
    new THREE.ShaderMaterial({
      uniforms: { uHover: { value: 0 }, uZoom: { value: 0 }, uWobble: { value: 0 }, uTime: timeUniform },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uHover;
        uniform float uZoom;
        uniform float uWobble;
        uniform float uTime;
        varying vec2 vUv;
        ${NOISE_GLSL}

        // Thin-film interference: light reflecting off the front and back of a soap film of thickness d (nm)
        // interferes differently for each wavelength, so the film shows swirling spectral colours.
        vec3 thinFilm(float d, float cosT) {
          const vec3 lambda = vec3(650.0, 532.0, 460.0);          // red, green, blue in nm
          const float n = 1.33;                                    // refractive index of soapy water
          float cosR = sqrt(max(1.0 - (1.0 - cosT * cosT) / (n * n), 0.0));
          vec3 phase = 4.0 * 3.14159265 * n * d * cosR / lambda;
          return 0.5 + 0.5 * cos(phase + 3.14159265);              // half-wave phase flip on the front surface
        }

        void main() {
          vec2 p = (vUv - 0.5) * 2.0 * 1.15;
          float ang = atan(p.y, p.x);

          // the silhouette wobbles like a bubble after it has been poked, driven by uWobble
          float w = uWobble;
          float wob = 1.0 + w * (0.05 * sin(2.0 * ang + uTime * 3.1) + 0.035 * sin(3.0 * ang - uTime * 4.3) + 0.02 * sin(5.0 * ang + uTime * 6.2));
          float r = length(p) / wob;
          float aa = max(fwidth(r), 1e-4);
          float mask = 1.0 - smoothstep(1.0 - aa, 1.0, r);
          if (mask <= 0.0) discard;

          // treat the disc as a sphere: the viewing angle at each point sets how the film reflects
          float z = sqrt(max(1.0 - r * r, 0.0));
          float cosT = clamp(z, 0.03, 1.0);

          // film thickness: flowing swirls that drain toward the bottom, and thin out as you zoom in
          // (so the colours sweep through the spectrum while you scroll)
          vec3 q = vec3(p * 1.4, uTime * (0.09 + 0.5 * w));
          float swirl = fbm(q + 2.2 * vec3(fbm(q + 5.0), fbm(q + 9.0), 0.0));
          float d = (240.0 + 420.0 * swirl + 240.0 * (0.5 - 0.5 * p.y)) * (1.0 - 0.5 * uZoom);
          vec3 film = thinFilm(d, cosT);

          float fres = pow(1.0 - cosT, 2.4);                       // glancing angles reflect far more
          float rim = exp(-(1.0 - r) * 26.0);
          vec3 col = film * (0.22 + 1.25 * fres) + film * rim * 0.9 + vec3(rim * 0.22);

          // soft window reflections, as on a real bubble
          float hl = exp(-pow(length(p - vec2(-0.42, 0.46)) / 0.17, 2.0));
          float hl2 = exp(-pow(length(p - vec2(0.46, -0.52)) / 0.09, 2.0));
          col += vec3(1.0) * (hl * 0.85 + hl2 * 0.45);

          // nearly clear in the middle (so the beads read), solid-looking at the rim
          float a = 0.16 + 0.10 * uHover + fres * 0.85 + rim * 0.35 + hl * 0.55 + hl2 * 0.3;
          a *= 1.0 - 0.35 * uZoom;
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
    ctx.fillStyle = theme.chip;
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
function setupMini(node, rebuild = false) { // rebuild: same page, new look (theme change), keep the bubble's state
  if (mini.owner === node && !rebuild) return;
  mini.owner?.mesh.remove(mini.root, mini.shadow);
  node.mesh.add(mini.root, mini.shadow);
  mini.owner = node;
  // a fresh bubble on the new page: it starts empty-handed and blows itself up from nothing
  if (!rebuild) mini.show = mini.showV = mini.hover = mini.hoverV = mini.wobble = 0;

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
    color: new THREE.Color(theme.miniLine), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
  }));
  mini.lines.renderOrder = 6;
  mini.inner.add(mini.lines);

  for (const [n, p] of pos) {
    const color = n === node ? new THREE.Color(1, 1, 1) : new THREE.Color().setHSL(hueOf(n), 0.85, 0.66);
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
  crumb.textContent = `${SPACE}  ›  ${center.title}  ›  Graph`;
  backBtn.hidden = false;
  updatePlay();
  controls.autoRotate = true;
  flyTo(center.pos, R * 1.5 + 3.2);
  mini.root.getWorldPosition(beadPos); // the bubble pops: iridescent droplets fly out of it
  emitSparks(beadPos, 55, { speed: 3.2, size: 1.1, life: 0.9, hue: 0.5, sat: 0.9, white: 0.5 });
  emitSparks(beadPos, 55, { speed: 3.2, size: 1.1, life: 0.9, hue: 0.88, sat: 0.9, white: 0.5 });
  fxImpact({ warpAmt: 1, flashAmt: 0.3, shockUV: { x: 0.5, y: 0.5 } }); // bigger bang for the graph
  emitSparks(center.pos, 220, { speed: 9, size: 1.6, life: 1.5, hue: hueOf(center) });
  setHint('<b>Drag</b> orbit &nbsp;·&nbsp; <b>Hover</b> a note to trace its links &nbsp;·&nbsp; <b>Click</b> a note to open it &nbsp;·&nbsp; <b>Esc</b> back to the page');
}

// Clicking a node inside the zoomed bubble bursts it: iridescent droplets fly out from the bubble and from
// the node you picked, the view jolts, and the camera carries you to that note.
function popBubbleTo(node) {
  const burst = (origin, count) => {
    emitSparks(origin, count, { speed: 4.2, size: 1.2, life: 1.0, hue: 0.5, sat: 0.9, white: 0.5 });
    emitSparks(origin, count, { speed: 4.2, size: 1.2, life: 1.0, hue: 0.88, sat: 0.9, white: 0.5 });
    emitSparks(origin, count, { speed: 4.2, size: 1.2, life: 1.0, hue: 0.12, sat: 0.9, white: 0.5 });
  };
  mini.root.getWorldPosition(beadPos);
  burst(beadPos, 40);
  const bead = mini.beads.find((b) => b.node === node);
  if (bead) {
    bead.soft.getWorldPosition(beadPos);
    burst(beadPos, 55);
  }
  fxImpact({ warpAmt: 0.5, flashAmt: 0.25 });
  select(node);
}

function exitGraph() {
  if (graphMode) select(selected); // reopens the page with the usual depth arrangement
}

controls.addEventListener('start', () => { flying = false; });
refreshLinks();

// ---------- Page view: the note turns into paper ----------
// Two ways to read an open note: the scrolling glass page, or a book. In page view the note is paginated onto
// paper; dragging turns the leaf, which curls around a moving cylinder fold (done in the vertex shader) and
// throws a soft shadow onto the page below it.

// ?read=page wins, then the mode you last used, then scroll
let readMode = 'scroll';
try {
  const asked = new URLSearchParams(location.search).get('read');
  readMode = asked === 'page' || asked === 'scroll' ? asked : localStorage.getItem('kg-read') === 'page' ? 'page' : 'scroll';
} catch { /* storage blocked */ }

const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif';
const PG = { W: 1024, H: 1280, pad: 104, font: 33, line: 50, gap: 16, headTop: 190, bottom: 1130 };

// Splits a note into pages at block boundaries (paragraphs, bullets, figures stay whole)
function paginate(node) {
  if (node.pages) return node.pages;
  const ctx = document.createElement('canvas').getContext('2d');
  const bodyW = PG.W - PG.pad * 2;
  ctx.font = `700 64px ${SERIF}`;
  const titleLines = wrap(ctx, node.title, bodyW);
  const pages = [{ items: [] }];
  let y = PG.pad + titleLines.length * 76 + 112;
  for (const item of node.lines) {
    let h, lines = null;
    if (item.type === 'img') {
      if (!images.get(item.src)) continue;
      h = 300 + (item.alt ? 44 : 0) + 22;
    } else {
      const isLi = item.type === 'li', isH = item.type === 'h';
      ctx.font = `${isH ? '700' : '400'} ${PG.font}px ${SERIF}`;
      lines = layoutWords(ctx, item.raw, bodyW - (isLi ? 40 : 0));
      h = lines.length * PG.line + PG.gap + (isH ? 22 : 0);
    }
    let page = pages.at(-1);
    if (y + h > PG.bottom && page.items.length) { // does not fit: start the next page
      pages.push({ items: [] });
      page = pages.at(-1);
      y = PG.headTop;
    }
    page.items.push({ item, lines, y, h });
    y += h;
  }
  node.pages = pages;
  node.pageTex = [];
  node.pageHits = [];
  return pages;
}

// Ink only, on a transparent canvas: the paper itself (fibres, aged edges, spine shadow) is shaded by the GPU.
function drawPaperPage(node, idx) {
  const pg = paginate(node)[idx], P = theme.paper;
  const c = document.createElement('canvas');
  c.width = PG.W; c.height = PG.H;
  const ctx = c.getContext('2d');
  const bodyW = PG.W - PG.pad * 2, hits = [];
  ctx.textBaseline = 'top';

  if (idx === 0) { // title page: big title, tags in small caps, a rule
    ctx.font = `700 64px ${SERIF}`;
    ctx.fillStyle = P.ink;
    let y = PG.pad;
    for (const l of wrap(ctx, node.title, bodyW)) { ctx.fillText(l, PG.pad, y); y += 76; }
    ctx.font = `600 22px ${SERIF}`;
    ctx.fillStyle = P.sub;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
    ctx.fillText(node.tags.join('   ·   ').toUpperCase(), PG.pad, y + 6);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.fillStyle = P.rule;
    ctx.fillRect(PG.pad, y + 54, bodyW, 2);
  } else { // later pages: running head
    ctx.font = `italic 400 26px ${SERIF}`;
    ctx.fillStyle = P.sub;
    ctx.textAlign = 'center';
    ctx.fillText(node.title, PG.W / 2, 96);
    ctx.textAlign = 'left';
    ctx.fillStyle = P.rule;
    ctx.fillRect(PG.pad, 142, bodyW, 2);
  }

  for (const { item, lines, y } of pg.items) {
    if (item.type === 'img') { // figures sit on a dark plate, since the diagrams are drawn in light ink
      const img = images.get(item.src);
      ctx.beginPath(); ctx.roundRect(PG.pad, y, bodyW, 300, 20);
      ctx.fillStyle = P.plate; ctx.fill();
      const photo = !/\.svg$/i.test(item.src);
      const fit = photo ? Math.max(bodyW / img.width, 300 / img.height) : Math.min((bodyW - 40) / img.width, 260 / img.height);
      ctx.save(); ctx.clip(); // the plate path from above
      ctx.drawImage(img, PG.pad + (bodyW - img.width * fit) / 2, y + (300 - img.height * fit) / 2, img.width * fit, img.height * fit);
      ctx.restore();
      if (node.video) { playBadge(ctx, PG.pad + bodyW / 2, y + 150, 46); hits.push({ x: PG.pad, y, w: bodyW, h: 300, video: true }); }
      if (item.alt) {
        ctx.font = `italic 400 24px ${SERIF}`; ctx.fillStyle = P.sub;
        ctx.fillText(item.alt, PG.pad, y + 312);
      }
      continue;
    }
    const isLi = item.type === 'li', isH = item.type === 'h', indent = isLi ? 40 : 0, top = y + (isH ? 22 : 0);
    ctx.font = `${isH ? '700' : '400'} ${PG.font}px ${SERIF}`;
    if (isLi) { // a small diamond for bullets
      ctx.fillStyle = P.link;
      ctx.beginPath();
      const bx = PG.pad + 10, by = top + PG.font * 0.62;
      ctx.moveTo(bx, by - 6); ctx.lineTo(bx + 6, by); ctx.lineTo(bx, by + 6); ctx.lineTo(bx - 6, by); ctx.closePath();
      ctx.fill();
    }
    lines.forEach((line, i) => {
      const ly = top + i * PG.line;
      for (const w of line) {
        const wx = PG.pad + indent + w.x;
        ctx.fillStyle = w.link ? P.link : P.ink;
        ctx.fillText(w.word, wx, ly);
        if (w.link) {
          ctx.fillRect(wx, ly + PG.font * 1.12, w.w, 2);
          hits.push({ x: wx, y: ly, w: w.w, h: PG.line, link: w.link });
        }
      }
    });
  }

  ctx.font = `400 26px ${SERIF}`;
  ctx.fillStyle = P.sub;
  ctx.textAlign = 'center';
  ctx.fillText(`—  ${idx + 1}  —`, PG.W / 2, PG.H - 100);

  node.pageHits[idx] = hits;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function getPageTex(node, i) {
  paginate(node);
  return (node.pageTex[i] ??= drawPaperPage(node, i));
}

// Paper: fibres, mottling, aged edges, a shadowed spine, rounded corners
const PAPER_GLSL = /* glsl */ `
  uniform sampler2D uInk;
  uniform vec3 uPaper, uEdge;
  uniform float uTime, uShine;
  uniform vec2 uSize;
  ${NOISE_GLSL}
  float sdBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  vec3 paperSurface(vec2 uv, vec4 ink) {
    float fibre = fbm(vec3(uv * vec2(64.0, 80.0), 1.0));
    float mottle = fbm(vec3(uv * 4.0, 7.0));
    vec2 e = abs(uv - 0.5) * 2.0;
    float age = smoothstep(0.80, 1.0, max(e.x, e.y));
    vec3 base = mix(uPaper, uEdge, age * 0.85) * 0.97;
    base *= 0.93 + 0.11 * fibre + 0.06 * (mottle - 0.5);
    vec3 col = mix(base, ink.rgb * (0.9 + 0.1 * fibre), ink.a);
    return col * (1.0 - exp(-uv.x * 16.0) * 0.22);                   // the gutter of the book
  }
  float shineBand(vec2 uv) {
    float diag = uv.x * 0.7 + (1.0 - uv.y) * 0.7;
    return exp(-pow((diag - (1.7 * (1.0 - uShine) - 0.25)) / 0.07, 2.0)) * uShine;
  }`;

const paper = (() => {
  const geo = new THREE.PlaneGeometry(PANEL_W, PANEL_H, 72, 90);
  const common = () => ({
    uInk: { value: null }, uPaper: { value: T.paper }, uEdge: { value: T.paperEdge }, uTime: timeUniform,
    uShine: { value: 0 }, uSize: { value: new THREE.Vector2(PANEL_W, PANEL_H) },
    uC: { value: 1 }, uN: { value: new THREE.Vector2(1, 0) }, uR: { value: 0.15 }, uP: { value: 0 },
  });

  // the turning leaf: bent around a cylinder whose axis is the fold line
  const leafMat = new THREE.ShaderMaterial({
    uniforms: common(),
    vertexShader: /* glsl */ `
      uniform float uC;      // where the fold sits, measured along uN
      uniform vec2 uN;       // direction the fold travels (unit)
      uniform float uR;      // radius of the curl
      varying vec2 vUv;
      varying vec3 vNormal;
      varying float vCurl;
      void main() {
        vUv = uv;
        vec3 pos = position;
        vec3 nrm = vec3(0.0, 0.0, 1.0);
        float curl = 0.0;
        float t = dot(pos.xy, uN) - uC;                      // distance past the fold
        if (t > 0.0) {
          float th = t / uR;                                 // how far round the cylinder this point has travelled
          vec2 base = pos.xy - uN * dot(pos.xy, uN);         // the part along the fold line does not move
          float along, z;
          if (th <= 3.14159265) {                            // rolling up and over
            along = uC + uR * sin(th);
            z = uR * (1.0 - cos(th));
            nrm = vec3(-uN * sin(th), cos(th));
            curl = sin(th);
          } else {                                           // folded flat again, lying face down on top
            along = uC - (t - 3.14159265 * uR);
            z = 2.0 * uR;
            nrm = vec3(0.0, 0.0, -1.0);
          }
          pos = vec3(base + uN * along, z);
        }
        vNormal = normalize(nrm);
        vCurl = curl;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying float vCurl;
      ${PAPER_GLSL}
      void main() {
        vec2 p = (vUv - 0.5) * uSize;
        float d = sdBox(p, uSize * 0.5, 0.045);
        if (d > 0.0) discard;
        bool front = gl_FrontFacing;

        // the back of the leaf: blank paper with the other side faintly showing through
        vec2 uv = front ? vUv : vec2(1.0 - vUv.x, vUv.y);
        vec4 ink = texture2D(uInk, uv);
        if (!front) ink.a *= 0.13;
        vec3 col = paperSurface(uv, ink);

        vec3 N = normalize(front ? vNormal : -vNormal);
        vec3 L = normalize(vec3(-0.35, 0.5, 0.8));
        float light = 0.58 + 0.42 * max(dot(N, L), 0.0);
        if (!front) light *= 0.94;
        float spec = pow(max(reflect(-L, N).z, 0.0), 26.0) * (0.10 + 0.9 * vCurl);   // sheen along the curl
        col = col * light + vec3(1.0, 0.97, 0.90) * spec * 0.22;
        col += vec3(1.0, 0.98, 0.90) * shineBand(vUv) * 0.16;
        col += vec3(1.0, 0.98, 0.9) * smoothstep(-0.007, 0.0, d) * 0.10;             // cut edge of the sheet

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
  });

  // the page underneath: flat, but shadowed near and under the lifting leaf
  const underMat = new THREE.ShaderMaterial({
    uniforms: common(),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uC, uP;
      uniform vec2 uN;
      varying vec2 vUv;
      ${PAPER_GLSL}
      void main() {
        vec2 q = (vUv - 0.5) * uSize;
        float d = sdBox(q, uSize * 0.5, 0.045);
        if (d > 0.0) discard;
        vec3 col = paperSurface(vUv, texture2D(uInk, vUv));
        float t = dot(q, uN) - uC;
        // The leaf only hides the part of this page left of the fold; what is revealed lies in the shadow of the
        // roll, which is darkest right at the fold and fades with distance from it.
        float shadow = 0.62 * exp(-max(t, 0.0) / 0.30);
        shadow *= smoothstep(0.0, 0.12, uP);
        col *= (1.0 - shadow) * 0.92;                              // 0.92 matches the lit front of the leaf
        col += vec3(1.0, 0.98, 0.9) * shineBand(vUv) * 0.16;
        col += vec3(1.0, 0.98, 0.9) * smoothstep(-0.007, 0.0, d) * 0.10;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });

  const group = new THREE.Group();
  const under = new THREE.Mesh(geo, underMat);
  const leaf = new THREE.Mesh(geo, leafMat);
  under.position.z = 0.02;
  leaf.position.z = 0.03;
  under.frustumCulled = leaf.frustumCulled = false;
  group.add(under, leaf);
  group.visible = false;
  return { group, leaf, under, owner: null };
})();

const book = { cur: 0, active: false, dir: 0, L: 0, U: 0, p: 0, pV: 0, goal: 0, dragging: false, tilt: 0.12, shine: 0, lastP: 0, key: '' };
let paperShow = 0, paperShowV = 0; // 0 = still glass, 1 = fully paper
const modesEl = document.getElementById('modes');
const fitEl = document.getElementById('fs');
const modeBtns = [...modesEl.querySelectorAll('button[data-mode]')];
const pageNoEl = document.getElementById('pageno');

function updatePageNo() {
  const n = paper.owner ? paginate(paper.owner).length : 1;
  pageNoEl.textContent = n > 1 ? `${book.cur + 1} / ${n}` : '';
}

// The paper group rides on whichever note is open
function attachPaper(node) {
  if (paper.owner === node) return;
  paper.owner?.mesh.remove(paper.group);
  node.mesh.add(paper.group);
  paper.owner = node;
  Object.assign(book, { cur: 0, active: false, dir: 0, L: 0, U: 0, p: 0, pV: 0, goal: 0, dragging: false, key: '' });
  paperShow = paperShowV = 0; // the new page unfurls from nothing
  updatePageNo();
}

function startTurn(dir) {
  if (book.active || !paper.owner) return false;
  const count = paginate(paper.owner).length;
  if ((dir > 0 && book.cur >= count - 1) || (dir < 0 && book.cur <= 0)) return false;
  book.active = true;
  book.dir = dir;
  book.dragging = false;
  if (dir > 0) { book.L = book.cur; book.U = book.cur + 1; book.p = 0; book.goal = 1; }
  else { book.L = book.cur - 1; book.U = book.cur; book.p = 1; book.goal = 0; }
  book.pV = 0;
  book.lastP = book.p;
  return true;
}

function endTurn() {
  const done = book.dir > 0 ? book.goal >= 0.999 : book.goal <= 0.001;
  if (done) { book.cur = book.dir > 0 ? book.U : book.L; book.shine = 1; } // a glint runs over the new page
  Object.assign(book, { active: false, dir: 0, p: 0, pV: 0, goal: 0 });
  updatePageNo();
}

const foldPt = new THREE.Vector3();

function bookStep(t, dt) {
  const node = paper.owner;
  const want = readMode === 'page' && node && node === selected && node.detailed && !graphMode;
  paperShow = THREE.MathUtils.clamp(dampTo(paperShow, paperShowV, want ? 1 : 0, 7, dt), 0, 1);
  paperShowV = dampV;
  paper.group.visible = !!node && paperShow > 0.01;
  if (!paper.group.visible) return;

  if (book.active && !book.dragging) { // let go: the leaf springs the rest of the way (or back)
    book.p = dampTo(book.p, book.pV, book.goal, 8, dt);
    book.pV = dampV;
    if (Math.abs(book.p - book.goal) < 0.004) endTurn();
  }
  if (!book.dragging) book.tilt += (0.12 - book.tilt) * (1 - Math.exp(-dt * 4));
  const speed = Math.abs(book.p - book.lastP) / Math.max(dt, 1e-3);
  book.lastP = book.p;

  // an unfurling intro / outro: while the paper fades in or out, the leaf rolls up toward the spine side
  const pe = book.p + (1 - paperShow) * (1 - book.p);
  const a = book.tilt, nx = Math.cos(a), ny = Math.sin(a);
  const reach = PANEL_W / 2 * Math.abs(nx) + PANEL_H / 2 * Math.abs(ny);
  const R = THREE.MathUtils.lerp(0.40, 0.18, pe); // a wide, soft roll rather than a hard crease
  const c = reach - pe * (2 * reach + Math.PI * R * 1.05);

  const key = `${node.index}:${book.active ? book.L : book.cur}:${book.U}:${themeName}`;
  if (key !== book.key) {
    book.key = key;
    paper.leaf.material.uniforms.uInk.value = getPageTex(node, book.active ? book.L : book.cur);
    paper.under.material.uniforms.uInk.value = getPageTex(node, book.active ? book.U : book.cur);
  }
  for (const m of [paper.leaf.material, paper.under.material]) {
    m.uniforms.uC.value = c;
    m.uniforms.uN.value.set(nx, ny);
    m.uniforms.uR.value = R;
    m.uniforms.uP.value = pe;
  }
  book.shine *= Math.exp(-dt * 1.8);
  paper.leaf.material.uniforms.uShine.value = paper.under.material.uniforms.uShine.value = book.shine;
  paper.leaf.visible = pe < 0.995;
  paper.under.visible = book.active || pe > 0.001;

  // VFX while a page is moving: paper dust shed along the fold, and a faint whoosh of warp
  if (book.active && pe > 0.04 && pe < 0.96 && speed > 0.7) {
    if (Math.random() < Math.min(1, speed * dt * 3)) {
      const along = (Math.random() - 0.5) * PANEL_H * 0.8;
      foldPt.set(nx * (c + R * 0.6) - ny * along, ny * (c + R * 0.6) + nx * along, R);
      paper.group.localToWorld(foldPt);
      emitSparks(foldPt, 1, { speed: 0.9, size: 0.7, life: 0.7, hue: 0.1, sat: 0.3, white: 0.8 });
    }
    if (speed > 1.2) warp = Math.max(warp, Math.min(0.1, speed * 0.025));
  }
}

function updateModeButtons() {
  modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === readMode));
  modesEl.dataset.mode = readMode;
}
updateModeButtons();

function setReadMode(mode) {
  if (mode === readMode) return;
  readMode = mode;
  try { localStorage.setItem('kg-read', mode); } catch { /* storage blocked */ }
  updateModeButtons();
  if (selected?.detailed && !graphMode) {
    fxImpact({ warpAmt: 0.35 });
    emitSparks(selected.pos, 50, { speed: 4.5, size: 1.2, life: 1.0, hue: 0.11, sat: 0.4, white: 0.7 });
  }
}
modeBtns.forEach((b) => b.addEventListener('click', () => setReadMode(b.dataset.mode)));

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
  let link = null, video = false;
  if (node === selected && node.detailed) {
    const [W, H] = node.hitSize;
    const px = hit.uv.x * W, py = (1 - hit.uv.y) * H;
    // in page view the links are the ones printed on the current paper page (and only while it lies flat)
    const inBook = readMode === 'page' && paperShow > 0.5;
    const hits = inBook ? (book.active ? [] : node.pageHits?.[book.cur] ?? []) : node.hits;
    const r = hits.find((h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h);
    link = r?.link ?? null;
    video = !!r?.video;
  }
  return { node, link, video, uv: hit.uv };
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

// Dragging on the paper turns the page
let pageDrag = null;
const pagePt = new THREE.Vector3();

function startPageDrag(e, hit) {
  if (!(readMode === 'page' && selected?.detailed && !graphMode && paperShow > 0.5 && hit.node === selected)) return;
  // how wide the page is on screen decides how far you have to drag to turn it
  const m = selected.mesh;
  pagePt.copy(selected.anchor).project(camera);
  const left = (pagePt.x + 1) / 2 * innerWidth;
  pagePt.copy(selected.anchor).addScaledVector(right, PANEL_W * m.scale.x).project(camera);
  const pagePx = Math.max(200, (pagePt.x + 1) / 2 * innerWidth - left);
  pageDrag = { x0: e.clientX, y0: e.clientY, x: e.clientX, t: e.timeStamp, vx: 0, pagePx };
  renderer.domElement.setPointerCapture(e.pointerId);
  e.stopImmediatePropagation(); // no orbiting while you turn pages
}

function movePageDrag(e) {
  const d = pageDrag, dx = e.clientX - d.x0;
  const dtms = e.timeStamp - d.t;
  if (dtms > 0) d.vx = THREE.MathUtils.lerp(d.vx, (e.clientX - d.x) / dtms, 0.4);
  d.x = e.clientX; d.t = e.timeStamp;
  if (!book.dragging && !book.active && Math.abs(dx) > 8 && startTurn(dx < 0 ? 1 : -1)) book.dragging = true;
  if (!book.dragging) return;
  book.p = THREE.MathUtils.clamp(book.dir > 0 ? -dx / (d.pagePx * 0.95) : 1 - dx / (d.pagePx * 0.95), 0, 1);
  book.pV = 0;
  book.tilt = THREE.MathUtils.clamp((e.clientY - d.y0) / d.pagePx * 0.9, -0.45, 0.45); // the fold leans with your hand
}

function finishPageDrag() {
  const d = pageDrag;
  pageDrag = null;
  if (!d || !book.dragging) return;
  book.dragging = false;
  // past a third of the way, or flicked hard enough: it carries on; otherwise it falls back
  const flick = 0.5; // px per ms
  const carry = book.dir > 0 ? book.p > 0.3 || d.vx < -flick : book.p < 0.7 || d.vx > flick;
  book.goal = book.dir > 0 ? (carry ? 1 : 0) : (carry ? 0 : 1);
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY];
  const hit0 = pick(e);
  if (!hit0.onMini) { startPageDrag(e, hit0); return; }
  miniDrag = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  miniSpin.set(0, 0);
  renderer.domElement.setPointerCapture(e.pointerId);
  renderer.domElement.style.cursor = 'grabbing';
  e.stopImmediatePropagation();
}, { capture: true });

const endMiniDrag = () => { miniDrag = null; finishPageDrag(); };
addEventListener('pointerup', endMiniDrag);
addEventListener('pointercancel', endMiniDrag);
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const { node, link, video, onMini, bead } = pick(e);
  if (graphMode) { // on the graph screen: a tile opens that note, anything else steps back to the page
    if (node && node !== selected) select(node);
    else exitGraph();
    return;
  }
  if (onMini) {
    if (bead) popBubbleTo(bead);           // zoomed in: a bead bursts the bubble and takes you to its note
    else if (mz < 0.25) enterGraph();      // a plain click on the widget opens the isolated graph
  }
  else if (video && node.video) openVideo(node.video);
  else if (link) select(link);
  else if (node === selected && readMode === 'page' && paperShow > 0.5 && !book.active) {
    // tapping the outer edge of the paper turns the page, like a thumb on the corner of a book
    const u = pick(e).uv?.x ?? 0.5;
    if (u > 0.72) startTurn(1);
    else if (u < 0.28) startTurn(-1);
  }
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
    emitSparks(trailPoint, 2, { speed: 0.9, size: 0.8, life: 0.8, hue: theme.trailHue[0] + Math.random() * theme.trailHue[1], sat: 0.8, white: 0.55 });
  }
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!miniDrag && !pageDrag && e.buttons === 0) emitTrail(e);
  if (pageDrag) { movePageDrag(e); renderer.domElement.style.cursor = 'grabbing'; return; }
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
  const { node, link, video, uv, onMini, miniUV, bead } = pick(e);
  hovered = node;
  miniHovered = !!onMini;
  miniBead = bead ?? null;
  if (onMini) miniPointer.set(miniUV.x * 2 - 1, miniUV.y * 2 - 1);
  else if (node) node.mesh.material.uniforms.uPointer.value.copy(uv); // the glass lights up under the cursor
  const onPaper = node === selected && readMode === 'page' && paperShow > 0.5 && !graphMode;
  renderer.domElement.style.cursor = onMini ? (bead ? 'pointer' : 'grab')
    : link || video ? 'pointer' : onPaper ? 'grab'
    : node && (node !== selected || graphMode) ? 'pointer' : 'default';
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
    mzGoal = THREE.MathUtils.clamp(mzGoal - dy * 0.0016, 0, 1); // capped: scrolling past the maximum does nothing
    return;
  }
  if (node !== selected) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // keep OrbitControls from zooming
  if (readMode === 'page' && paperShow > 0.5) { // on paper, the wheel turns pages (with a short cooldown)
    const now = performance.now();
    if (Math.abs(e.deltaY) > 8 && now > wheelReady && startTurn(e.deltaY > 0 ? 1 : -1)) wheelReady = now + 650;
    return;
  }
  scrollPage(e.deltaY * (e.deltaMode === 1 ? 40 : 1.4));
}, { capture: true, passive: false });
let wheelReady = 0;

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
  if (e.key.toLowerCase() === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey && selected?.detailed) {
    setReadMode(readMode === 'page' ? 'scroll' : 'page');
    return;
  }
  if (readMode === 'page' && selected?.detailed && !graphMode) { // on paper the arrows turn pages
    const dir = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
    if (dir) { e.preventDefault(); startTurn(dir); }
    return;
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

// ---------- Category rail ----------
// The other way to lay the notes out: grouped by first tag into walls stacked one behind another in depth. The wheel
// flies the camera forward through them (shift / ctrl + wheel still zooms), arrows and the pill bar jump.

const graphPos = new Map(nodes.map((n) => [n, n.pos.clone()])); // the force-directed positions
const CELL_W = PANEL_W * 1.3, CELL_H = PANEL_H * 1.22, RAIL_DEPTH = 10; // walls are stacked this far apart in depth
const railHint = '<b>Scroll</b> fly through categories &nbsp;·&nbsp; <b>Left+right drag</b> zoom to the panel under the pointer &nbsp;·&nbsp; <b>Left-drag</b> orbit &nbsp;·&nbsp; <b>Right-drag</b> pan &nbsp;·&nbsp; <b>Middle-drag</b> roll &nbsp;·&nbsp; <b>Click</b> a panel to open';
const groups = [];
const RAIL_DIR = new THREE.Vector3(0.05, 0.04, 1).normalize(); // nearly front-on, so a flat wall keeps even column sizes
const RAIL_LOOK = new THREE.Vector3(0, 1.0, 0); // focus a little above the wall's middle so its title fits in view too

(function buildRail() {
  const hub = nodes.find((n) => n.tags.includes('index')) ?? nodes[0];
  // categories follow the index: the hub's own link order first, then everything else breadth-first
  const listed = [...hub.body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => byTitle.get(m[1].trim().toLowerCase())).filter(Boolean);
  const order = [...new Set([hub, ...listed, ...hopsFrom(hub).keys()])];
  const byKey = new Map();
  for (const n of order) {
    const key = n.tags[0] ?? 'notes';
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(n);
  }
  if (byKey.size > 1 && byKey.get(hub.tags[0] ?? 'notes').length === 1) { // a lone hub would waste the first wall: it leads the next category instead
    const hubKey = hub.tags[0] ?? 'notes';
    byKey.delete(hubKey);
    const [firstKey] = byKey.keys();
    byKey.get(firstKey).unshift(hub);
  }
  for (const [key, list] of byKey) {
    const header = (n) => (n.tags.includes('index') ? 0 : n.tags.includes('section') ? 1 : 2);
    list.sort((a, b) => header(a) - header(b)); // stable: section / index notes lead their wall
    // wider screens get wider walls, so the grid fills the view instead of standing in the middle of it
    const cols = list.length <= 1 ? 1 : Math.min(list.length, THREE.MathUtils.clamp(Math.round(Math.sqrt(list.length * (innerWidth / innerHeight) * (CELL_H / CELL_W) * 0.8)), 2, 5));
    const rows = Math.ceil(list.length / cols);
    const W = cols * CELL_W, H = rows * CELL_H;
    const g = { key, label: key.charAt(0).toUpperCase() + key.slice(1), nodes: list, cols, rows, W, H, lat: W * 1.3 + 2.5, off: 0 }; // lat: how far to the side the wall floats while it is still ahead of you
    // each wall sits deeper than the last, nudged around a small spiral so the next one peeks out from behind the current
    const k = groups.length;
    g.c = new THREE.Vector3(Math.sin(k * 1.9) * 2.4, Math.cos(k * 1.9) * 1.3, -k * RAIL_DEPTH);
    list.forEach((n, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const inRow = Math.min(cols, list.length - r * cols); // a short last row is centred
      n.group = g;
      n.railPos = new THREE.Vector3(g.c.x + (c - (inRow - 1) / 2) * CELL_W, g.c.y + ((rows - 1) / 2 - r) * CELL_H, g.c.z + [0, -0.8, 0.5][(r * 2 + c) % 3]);
    });
    groups.push(g);
  }
})();
groups.forEach((g, i) => { g.index = i; });

// Category titles hang above each wall as sprites, so they live in the scene with the panels
function drawRailLabel(g) {
  const c = g.labelCanvas ?? (g.labelCanvas = document.createElement('canvas'));
  c.width = 1024; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const col = new THREE.Color().setHSL(hueOf(g.nodes[0]), 0.75, 0.68).getStyle();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = col; ctx.shadowBlur = 36;
  ctx.fillStyle = '#fff';
  ctx.font = `700 120px ${FONT}`;
  ctx.fillText(g.label, 512, 105);
  ctx.shadowBlur = 0;
  ctx.fillStyle = col;
  ctx.fillRect(512 - 60, 190, 120, 6);
  ctx.font = `500 34px ${FONT}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.fillText(`${g.nodes.length} ${g.nodes.length === 1 ? 'note' : 'notes'}`, 512, 232);
  return c;
}
for (const g of groups) {
  g.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(drawRailLabel(g)), transparent: true, depthWrite: false, fog: false, opacity: 0 }));
  g.sprite.scale.set(8, 2, 1);
  g.sprite.position.set(g.c.x, g.c.y + g.H / 2 + 1.5, g.c.z);
  g.sprite.renderOrder = 4;
  g.sprite.visible = false;
  scene.add(g.sprite);
}
function redrawRailLabels() {
  for (const g of groups) { drawRailLabel(g); g.sprite.material.map.needsUpdate = true; }
}

let layoutMode = new URLSearchParams(location.search).get('layout');
if (layoutMode !== 'rail' && layoutMode !== 'graph') layoutMode = DATASET === 'news' ? 'rail' : 'graph';
for (const n of nodes) n.pos.copy(layoutMode === 'rail' ? n.railPos : graphPos.get(n));
for (const n of nodes) { n.cur.copy(n.pos); n.goal.copy(n.pos); n.mesh.position.copy(n.pos); }

let railGoal = 0, railCur = 0, railV = 0; // category scroll position (fractional), eased
let railStart = 0, snapTimer = 0;
const railTmp = new THREE.Vector3();
const clampRail = (v) => THREE.MathUtils.clamp(v, 0, groups.length - 1);
const railIndex = () => Math.round(clampRail(railCur));

// where the camera looks at a (fractional) scroll position: glides straight from one wall to the next, through the depth between them
function railPoint(f, out = new THREE.Vector3()) {
  const i = Math.min(Math.floor(f), groups.length - 2);
  if (i < 0) return out.copy(groups[0].c).add(RAIL_LOOK);
  return out.lerpVectors(groups[i].c, groups[i + 1].c, f - i).add(RAIL_LOOK);
}
// distance at which a wall fills the view comfortably
function railDist(g) {
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return Math.max((g.H + 3.4) * 0.55 / t, g.W * 0.56 / (t * camera.aspect), 8);
}
const railTarget = () => railPoint(railGoal);

// Orbiting is limited while browsing the walls (they're flat), and free again when a note is open
function applyFog() {
  scene.fog.near = layoutMode === 'rail' ? 14 : 10;
  scene.fog.far = layoutMode === 'rail' ? 75 : 40;
}
applyFog();

function applyOrbitLimits() {
  const on = layoutMode === 'rail' && !selected;
  controls.minAzimuthAngle = on ? -1.0 : -Infinity;
  controls.maxAzimuthAngle = on ? 1.0 : Infinity;
  controls.minPolarAngle = on ? 1.0 : 0;
  controls.maxPolarAngle = on ? 1.95 : Math.PI;
}
applyOrbitLimits();

function goHome() {
  if (layoutMode === 'rail') {
    railGoal = railCur = Math.round(clampRail(railGoal));
    railV = 0;
    railPan.set(0, 0, 0);
    flyTo(railTarget(), railDist(groups[railGoal]), RAIL_DIR);
  } else flyTo(new THREE.Vector3(), HOME_DIST);
}

function gotoCategory(i) {
  panDecay = true; // a pan eases back to the middle of the new wall
  railGoal = Math.round(clampRail(i));
  railStart = railGoal;
  clearTimeout(snapTimer);
  snapTimer = 0;
  flying = false;
  zoomCur = camera.position.distanceTo(controls.target); // ease to this wall's fitting distance too
  zoomGoal = railDist(groups[railGoal]);
  zoomV = 0;
  zoomActive = true;
}

// Pill bar: one button per category
const catsEl = document.getElementById('cats');
const catBtns = groups.map((g) => {
  const b = document.createElement('button');
  b.textContent = g.label;
  b.addEventListener('click', () => gotoCategory(g.index));
  catsEl.appendChild(b);
  return b;
});
let shownIndex = -1;
function updateRailUI() {
  const show = layoutMode === 'rail' && !selected && !graphMode;
  catsEl.classList.toggle('show', show);
  const i = railIndex();
  if (i !== shownIndex) { shownIndex = i; catBtns.forEach((b, k) => b.classList.toggle('on', k === i)); }
}

// Scrolling the rail by an amount (in categories). Once the input goes quiet (or the chord is released) it settles on a wall:
// a notch or a swipe always moves at least one wall.
let railHold = false;
function snapRail() {
  snapTimer = 0;
  railHold = false;
  const moved = railGoal - railStart;
  gotoCategory(railStart + (Math.abs(moved) < 0.06 ? 0 : Math.sign(moved) * Math.max(1, Math.round(Math.abs(moved)))));
}
function nudgeRail(d, hold = false) {
  if (!snapTimer && !railHold) railStart = Math.round(clampRail(railGoal));
  flying = false;
  railGoal = clampRail(railGoal + d);
  clearTimeout(snapTimer);
  railHold = hold;
  snapTimer = hold ? 0 : setTimeout(snapRail, 140);
}

// Wheel: scroll between categories.
renderer.domElement.addEventListener('wheel', (e) => {
  if (layoutMode !== 'rail' || selected || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 40 : 1);
  nudgeRail(d * 0.002);
}, { capture: true, passive: false });

addEventListener('keydown', (e) => {
  if (layoutMode !== 'rail' || selected || player.classList.contains('open') || e.metaKey || e.ctrlKey || e.altKey) return;
  const i = Math.round(railGoal);
  const to = { ArrowRight: i + 1, ArrowDown: i + 1, PageDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, PageUp: i - 1, Home: 0, End: groups.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  gotoCategory(to);
});

// Graph / Categories switch
const layoutBtns = [...document.querySelectorAll('#layout button')];
const markLayout = () => layoutBtns.forEach((b) => b.classList.toggle('on', b.dataset.layout === layoutMode));
markLayout();
function setLayout(mode) {
  if (mode === layoutMode) return;
  layoutMode = mode;
  for (const n of nodes) n.pos.copy(mode === 'rail' ? n.railPos : graphPos.get(n));
  const q = new URLSearchParams(location.search);
  q.set('layout', mode);
  history.replaceState(null, '', `${location.pathname}?${q}`);
  markLayout();
  applyFog();
  applyOrbitLimits();
  select(null); // lays the notes out in their new places and flies home
}
layoutBtns.forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));

// ---------- Mouse combinations ----------
//   left-drag            orbit (OrbitControls)
//   right-drag           pan (OrbitControls); in the rail the pan eases back when you move to another wall
//   left + right drag    in the category view: zoom toward the panel under the pointer (without opening it);
//                        in the graph: fly forward / back; with a note open: zoom
//   middle-drag          roll the view around the line of sight; it levels out again on release
// OrbitControls only looks at the button that went down first, so a chord is spotted here from the buttons bitmask
// while the pointer moves, and takes the camera over until every button is up.
controls.mouseButtons.MIDDLE = -1; // middle is ours (roll), not OrbitControls' dolly
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

const PAN_STATE = 2; // OrbitControls' internal state number for panning
const railPan = new THREE.Vector3();
let panDecay = false;
const mouse = { chord: false, lastY: 0, roll: false, lastX: 0, focus: new THREE.Vector3() };
let roll = 0, rollGoal = 0, rollV = 0;
const flyDir = new THREE.Vector3();

// The point a zoom heads for: the panel under the pointer, else the spot on the focus plane under it
const focusPlane = new THREE.Plane();
function chordFocus(e) {
  const { node } = pick(e);
  if (node) return mouse.focus.copy(node.mesh.position);
  camera.getWorldDirection(flyDir);
  focusPlane.setFromNormalAndCoplanarPoint(flyDir, controls.target);
  return ray.ray.intersectPlane(focusPlane, mouse.focus) ?? mouse.focus.copy(controls.target);
}

function flyBy(d) { // d > 0 flies forward
  flying = false;
  if (selected) { // reading a note: forward means closer
    if (!zoomActive) { zoomCur = zoomGoal = camera.position.distanceTo(controls.target); zoomV = 0; zoomActive = true; }
    zoomGoal = THREE.MathUtils.clamp(zoomGoal * Math.exp(-d * 0.006), controls.minDistance, controls.maxDistance);
  } else if (layoutMode === 'rail') {
    // zoom about the focus point: camera and look-at point both scale toward (or away from) it, so the panel drifts to the middle as you close in
    zoomActive = false; // the zoom spring must not fight the drag
    const dist = camera.position.distanceTo(mouse.focus);
    const k = THREE.MathUtils.clamp(Math.exp(-d * 0.006), Math.min(3 / dist, 1), Math.max(40 / dist, 1)); // stays 3 to 40 units from it
    camera.position.sub(mouse.focus).multiplyScalar(k).add(mouse.focus);
    controls.target.sub(mouse.focus).multiplyScalar(k).add(mouse.focus);
    panDecay = false; // the new framing stays until you move to another category
  } else {
    camera.getWorldDirection(flyDir);
    controls.target.addScaledVector(flyDir, d * 0.03);
    camera.position.addScaledVector(flyDir, d * 0.03);
  }
}

function endChord() {
  mouse.chord = false;
  controls.enabled = true;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 2) panDecay = false; // a fresh pan stays where you leave it
  if (e.button !== 1) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // nothing else should treat a middle press as a click or a drag
  mouse.roll = true;
  mouse.lastX = e.clientX;
  renderer.domElement.setPointerCapture(e.pointerId);
}, true);

document.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  if (mouse.roll && e.buttons & 4) {
    rollGoal = THREE.MathUtils.clamp(rollGoal + (e.clientX - mouse.lastX) * 0.006, -Math.PI, Math.PI);
    mouse.lastX = e.clientX;
    return;
  }
  if (e.buttons === 3) {
    if (!mouse.chord) { // the second button just joined the first
      mouse.chord = true;
      mouse.lastY = e.clientY;
      chordFocus(e);
      controls.enabled = false; // stops the orbit / pan that the first button started
      downAt = null;            // and this is no longer a click
    }
    flyBy(mouse.lastY - e.clientY); // drag up = forward
    mouse.lastY = e.clientY;
  }
}, true);

addEventListener('pointerup', (e) => {
  if (e.button === 1 && mouse.roll) { mouse.roll = false; rollGoal = 0; }
  if (mouse.chord && e.buttons === 0) endChord();
}, true);
addEventListener('blur', () => { mouse.roll = false; rollGoal = 0; if (mouse.chord) endChord(); });

// Starting view: the first wall in rail mode
if (layoutMode === 'rail') {
  controls.autoRotate = false;
  setHint(railHint);
  edgeVisGoal.fill(0.06);
  edgeVis.set(edgeVisGoal);
  controls.target.copy(railTarget());
  camera.position.copy(controls.target).addScaledVector(RAIL_DIR, railDist(groups[0]));
}

// Deep link: index.html#Three.js opens that note straight away
{
  const target = byTitle.get(decodeURIComponent(location.hash.slice(1)).toLowerCase());
  if (target) select(target, true);
}

// ---------- Loop ----------

// ---------- Theme switching ----------

const themeBtns = [...document.querySelectorAll('#themes button')];
const markTheme = () => themeBtns.forEach((b) => b.classList.toggle('on', b.dataset.theme === themeName));
markTheme();

function setTheme(name) {
  if (!THEMES[name] || name === themeName) return;
  themeName = name;
  theme = THEMES[name];
  setThemeGoals(theme); // shader colours and the page chrome ease over by themselves
  try { localStorage.setItem('kg-theme', name); } catch { /* storage blocked */ }
  markTheme();
  redrawRailLabels();

  // anything with colour painted into a texture is redrawn in the new palette
  const blurFor = { soft: 2.5, heavy: 5 };
  for (const n of nodes) {
    if (n.state === 'tile') setPanelTexture(n, drawTile(n));
    else if (n.detailed) setPanelTexture(n, drawPanel(n, true, 0, n.scroll || 0));
    else setPanelTexture(n, drawPanel(n, false, blurFor[n.state] ?? 0));
    const u = n.mesh.material.uniforms;
    u.uMap2.value?.dispose();
    u.uMap2.value = drawFace(n);
  }
  chipCache.clear();
  for (const n of nodes) { // paper pages carry theme colours in their ink, so they are re-typeset
    n.pageTex?.forEach((tex) => tex?.dispose());
    n.pages = n.pageTex = n.pageHits = null;
  }
  mini.label.material.map?.dispose();
  mini.label.material.map = makeLabelTex();
  mini.label.material.needsUpdate = true;
  if (mini.owner) setupMini(mini.owner, true);
  tagNode = null;

  // a change of scenery deserves a little ceremony
  fxImpact({ warpAmt: 0.9, flashAmt: 0.3, shockUV: { x: 0.5, y: 0.5 } });
  emitSparks(controls.target, 120, { speed: 8, size: 1.5, life: 1.3, hue: theme.trailHue[0] + 0.08, white: 0.4 });
}

themeBtns.forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.theme)));
addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const names = Object.keys(THEMES);
    setTheme(names[(names.indexOf(themeName) + 1) % names.length]);
  }
});

function stepTheme(dt) {
  const k = 1 - Math.exp(-dt * 3.5);
  for (const key in T) T[key].lerp(G[key], k);
  bloom.strength = T.nums.y;
}

const startMs = performance.now();
let lastT = 0;
let modesShown = false;

renderer.setAnimationLoop(() => {
  const t = (performance.now() - startMs) / 1000;
  const dt = Math.min(0.05, t - lastT);
  lastT = t;
  timeUniform.value = t;
  stepTheme(dt);
  sky.position.copy(camera.position); // the sky has no parallax

  if (flying) {
    flightT = Math.min(1, flightT + dt / flightDur);
    const k = easeInOutCubic(flightT);
    controls.target.lerpVectors(flightFromTarget, goalTarget, k);
    camera.position.lerpVectors(flightFromCam, goalCam, k);
    if (flightT >= 1) flying = false;
  }

  // category rail: the camera glides sideways to the scrolled-to wall (keeping its angle and distance)
  if (layoutMode === 'rail' && !selected && !flying) {
    railCur = dampTo(railCur, railV, railGoal, 6, dt);
    railV = dampV;
    railPoint(clampRail(railCur), railTmp);
    if (controls.state === PAN_STATE || mouse.chord) { panDecay = false; railPan.copy(controls.target).sub(railTmp); } // being panned: the offset is wherever you put it
    else {
      if (panDecay) { railPan.multiplyScalar(Math.exp(-dt * 4)); if (railPan.lengthSq() < 1e-4) railPan.set(0, 0, 0); }
      railTmp.add(railPan).sub(controls.target); // how far the focus has to travel this frame
      controls.target.add(railTmp);
      camera.position.add(railTmp);
    }
    applyOrbitLimits();
  }
  updateRailUI();
  for (const g of groups) {
    const want = layoutMode === 'rail' && !selected ? THREE.MathUtils.clamp(1.15 - Math.abs(g.index - railCur) * 0.75, 0, 1) : 0;
    // walls ahead float out to alternating sides behind the current one, and slide to the middle as you reach them
    const near = Math.min(Math.abs(g.index - railCur), 1);
    const goalOff = layoutMode === 'rail' && !selected ? (g.index % 2 ? 1 : -1) * g.lat * near * near * (3 - 2 * near) : 0;
    g.off += (goalOff - g.off) * Math.min(1, dt * 5);
    g.sprite.position.x = g.c.x + g.off;
    const m = g.sprite.material;
    m.opacity += (want - m.opacity) * 0.12;
    g.sprite.visible = m.opacity > 0.01;
  }

  // eased scroll-zoom: a spring on the camera's distance from its focus point
  if (zoomActive) {
    zoomCur = dampTo(zoomCur, zoomV, zoomGoal, 7, dt);
    zoomV = dampV;
    zoomDir.subVectors(camera.position, controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(zoomDir, zoomCur);
    if (Math.abs(zoomCur - zoomGoal) < 0.004) zoomActive = false;
  }
  roll = dampTo(roll, rollV, rollGoal, mouse.roll ? 18 : 4, dt); // levels itself again after a roll
  rollV = dampV;
  controls.update();
  if (Math.abs(roll) > 1e-4) camera.rotateZ(roll); // roll sits on top of OrbitControls, which re-aims the camera every update

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
    m.position.set(n.cur.x + n.group.off, n.cur.y + Math.sin(t * 0.8 + n.index) * 0.06 * bob, n.cur.z);
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
    if (layoutMode === 'rail' && !selected) {
      og *= THREE.MathUtils.smoothstep(camDist, 1.5, 5.5);                              // panels dissolve as the camera flies through their wall
      const rel = n.group.index - railCur; // walls you've passed vanish quickly; the ones ahead stay visible but dimmer the further away
      og *= rel < 0 ? THREE.MathUtils.clamp(1 + rel * 1.5, 0, 1) : (1 - 0.4 * Math.min(rel, 1)) * THREE.MathUtils.clamp(2.6 - rel, 0, 1); // only the next two walls show
    }
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
    u.uHide.value = n === selected ? paperShow : 0; // the glass gives way to paper in page view
    u.uBackdropMix.value = THREE.MathUtils.lerp(u.uBackdropMix.value, n === selected && n.detailed ? 1 : 0, 0.1);
    n.icon.visible = m.visible = u.uOpacity.value > 0.01 || n.opacityGoal > 0.01; // fully faded notes are neither drawn nor pickable
  }

  bookStep(t, dt);
  const showModes = !!(selected?.detailed && !graphMode);
  if (showModes !== modesShown) { modesShown = showModes; modesEl.classList.toggle('show', showModes); if (!showModes) fitEl.classList.remove('on'); }

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
    const showTarget = selected?.detailed && !graphMode && readMode === 'scroll' ? 1 : 0; // the bubble belongs to the glass page
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
    const grow = mini.show * (1 + 0.6 * e) * (1 + 3.4 * z);
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

    // bubble physics: any sudden change (hover, zoom, a drag) sets the film wobbling, and it rings down slowly
    const energy = Math.min(1.4, Math.abs(mini.hoverV || 0) * 0.5 + Math.abs(mzV) * 1.2 + miniSpin.length() * 0.04 + (miniDrag ? 0.45 : 0));
    mini.wobble = Math.max((mini.wobble || 0) * Math.exp(-dt * 1.6), energy);
    mini.disc.material.uniforms.uWobble.value = mini.wobble;
    const squash = 0.06 * mini.wobble * Math.sin(t * 9); // jelly-like squash and stretch
    mini.tilt.scale.set(1 + squash, 1 - squash, 1);
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

  if (selected?.detailed && paperShow < 0.98) renderBackdrop(selected); // blurred copy of everything behind the glass page
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

// ---------- Fit the open page to the screen height ----------
const FIT_MARGIN = 0.94; // leave a sliver of space above and below
fitEl.addEventListener('click', () => {
  if (!selected?.detailed || graphMode) return;
  const fitDist = PANEL_H * selected.mesh.scale.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * FIT_MARGIN);
  const fitted = Math.abs(camera.position.distanceTo(controls.target) - fitDist) < 0.05 && !flying;
  flyTo(selected.pos, fitted ? 6.5 : fitDist);
  fitEl.classList.toggle('on', !fitted);
});
