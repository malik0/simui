// Experiment: look at SHARP's single-image 3D Gaussian splats in the browser.
// The camera sits at the photo's original viewpoint (SHARP's scenes are in OpenCV coordinates, camera at the origin looking
// down +z), with the focal length SHARP predicted. Moving the mouse slides the camera sideways a little: that is the parallax.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const NAMES = ['bahrain_tops_arab_nations', 'two_mongolian_saker_falcons', 'saudi_project_clears_1', 'uk_green_party', 'closing_bell', 'alula_expands'];
// intrinsics read from the .ply files: focal length in pixels for a 1280 px wide image
const IMG_W = 1280, FOCAL = 1016.26;

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 200);
const spark = new SparkRenderer({ renderer });
scene.add(spark);

let splat = null;
let imgAspect = 1280 / 714;
const mouse = new THREE.Vector2(0, 0), smooth = new THREE.Vector2(0, 0);
let range = 0.35; // how far (in scene units) the camera slides at the screen edge
const info = document.getElementById('info');
const flat = document.getElementById('flat');

function fitCamera() {
  // vertical fov that reproduces the photo's framing: tan(fov/2) = (h/2) / focal, in a 1280 px wide image
  const h = IMG_W / imgAspect;
  const fovV = 2 * Math.atan(h / 2 / FOCAL) * 180 / Math.PI;
  // letterbox: keep the photo's aspect inside the window
  const winAspect = innerWidth / innerHeight;
  camera.fov = winAspect >= imgAspect ? fovV : 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fovV / 2)) * imgAspect / winAspect) * 180 / Math.PI;
  camera.aspect = winAspect;
  camera.updateProjectionMatrix();
}

async function load(name) {
  info.textContent = `loading ${name}…`;
  flat.src = `./splats/${name}.jpg`;
  if (splat) { scene.remove(splat); splat.dispose?.(); splat = null; }
  const t0 = performance.now();
  const s = new SplatMesh({ url: `./splats/${name}.ply` });
  s.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0)); // OpenCV (y down, z forward) -> three.js (y up, z toward viewer)
  await s.initialized;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  scene.add(s);
  splat = s;
  info.textContent = `${name}\n${(s.numSplats ?? 0).toLocaleString()} splats · loaded in ${secs}s\nmove the mouse to look around · wheel: parallax range (${range.toFixed(2)})`;
  document.querySelectorAll('#bar button').forEach((b) => b.classList.toggle('on', b.dataset.name === name));
}

const bar = document.getElementById('bar');
NAMES.forEach((n) => {
  const b = document.createElement('button');
  b.textContent = n.replaceAll('_', ' ');
  b.dataset.name = n;
  b.addEventListener('click', () => load(n));
  bar.appendChild(b);
});

addEventListener('pointermove', (e) => {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
});
addEventListener('wheel', (e) => {
  range = THREE.MathUtils.clamp(range * Math.exp(-e.deltaY * 0.001), 0.05, 3);
  if (splat) info.textContent = info.textContent.replace(/\(.*\)$/, `(${range.toFixed(2)})`);
});
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  fitCamera();
});

fitCamera();
const hash = decodeURIComponent(location.hash.slice(1));
load(NAMES.includes(hash) ? hash : NAMES[0]);

let last = performance.now(), frames = 0, fpsAt = last;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  smooth.lerp(mouse, 1 - Math.exp(-(now - last) / 90));
  last = now;
  // slide the camera on a shallow arc around a point in the middle of the scene, always looking at it
  const pivotZ = -4;
  camera.position.set(smooth.x * range, smooth.y * range * 0.6, 0);
  camera.lookAt(0, 0, pivotZ);
  renderer.render(scene, camera);
  frames++;
  if (now - fpsAt > 1000 && splat) {
    const fps = Math.round((frames * 1000) / (now - fpsAt));
    info.textContent = info.textContent.replace(/\n\d+ fps$/, '') + `\n${fps} fps`;
    frames = 0; fpsAt = now;
  }
});
