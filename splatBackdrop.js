// A story's photo, turned into a 3D Gaussian splat by SHARP (see scripts/make-splats.py), drawn as the scene's background in
// place of the sky. It renders into its own texture (with alpha) that main.js composites over the sky, so it can fade in and out.
//
// The splat is a small 3D world seen from the photo's original viewpoint. Orbiting the camera, or just moving the cursor,
// slides a virtual camera a little way sideways inside that world, which is what produces the parallax.
//
// Memory: nothing is loaded until a story is open in page view, at most ONE splat is ever held (they are ~66 MB each), and it
// is disposed as soon as it has faded out, together with Spark's GPU buffers. A load that is still in flight when the story
// is left is cancelled. Spark itself (a large library) is only fetched the first time a splat is needed.
import * as THREE from 'three';

const PIVOT_Z = -4;       // the camera slides around a point this deep in the scene (scene units, after the axis flip)
const ORBIT_RANGE = 0.14; // sideways camera travel for a full radian of orbiting
const CURSOR_RANGE = 0.06;
const SHARP_FOCAL_MM = 30, FRAME_DIAGONAL_MM = 43.27; // SHARP's assumption when a photo carries no focal length (30 mm on a 35 mm frame)

// Disposing Spark rejects the requests its worker still had in flight with "Worker terminate". That is expected when a splat is
// let go of, so it should not show up as an error.
addEventListener('unhandledrejection', (e) => {
  if (String(e.reason?.message ?? e.reason).includes('Worker terminate')) e.preventDefault();
});

const MIN_FRAME_MS = 33; // the backdrop is redrawn at most ~30 times a second (it is a slow-moving background) and only when its view changed

export function createSplatBackdrop({ renderer, scale = 0.6 }) {
  const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
  let sparkModule = null;    // the Spark library (code only), fetched once
  let spark = null;          // the SparkRenderer; exists only while a splat does
  let wanted = null;         // { key, load, w, h } the story that should be showing, or null
  let cur = null;            // the one splat held: { key, w, h, mesh, ready, cancelled }
  let failed = null;         // key of a splat that failed to load, so it is not retried every frame
  let base = null;           // camera heading when the splat started to fade in; parallax is measured from here
  let lastDraw = -1e9, lastPose = '';
  let show = 0;
  const tmp = new THREE.Vector3();

  function disposeMesh(mesh) {
    if (!mesh) return;
    scene.remove(mesh);
    mesh.dispose?.();
  }

  // let go of the held splat, and of Spark's GPU buffers once nothing is left
  function release() {
    if (cur) {
      cur.cancelled = true;
      disposeMesh(cur.mesh);
      cur = null;
    }
    if (spark) {
      scene.remove(spark);
      try { spark.dispose?.(); } catch { /* already torn down */ }
      spark = null;
    }
    show = 0;
    base = null;
    lastPose = '';
  }

  async function load(spec) {
    const mine = { key: spec.key, w: spec.w, h: spec.h, mesh: null, ready: false, cancelled: false };
    cur = mine;
    try {
      sparkModule ??= await import('@sparkjsdev/spark');
      if (mine.cancelled) return;
      if (!spark) { spark = new sparkModule.SparkRenderer({ renderer }); scene.add(spark); }
      const mesh = new sparkModule.SplatMesh({ url: await spec.load() });
      mesh.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0)); // OpenCV (y down, z forward) -> three.js (y up, z toward the viewer)
      mesh.visible = false;
      scene.add(mesh);
      mine.mesh = mesh;
      await mesh.initialized;
      if (mine.cancelled) { disposeMesh(mesh); return; } // the story was left while this was still loading
      mine.ready = true;
    } catch (err) {
      console.warn('splat backdrop failed to load', spec.key, err);
      failed = spec.key;
      if (cur === mine) release();
    }
  }

  return {
    texture: rt.texture,
    get show() { return show; },

    // tell it which story's splat should be on screen (null = none). Cheap to call every frame.
    setWanted(spec) {
      if (spec?.key !== wanted?.key) { wanted = spec; failed = null; }
    },

    resize(w, h) {
      rt.setSize(Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale)));
    },

    // free everything now (the setting was turned off)
    clear() {
      wanted = null;
      release();
    },

    update(dt, time, mainCamera, target, cursor, motion = true) {
      // the splat we hold is no longer the one wanted: fade it out, then free it
      if (cur && (!wanted || cur.key !== wanted.key)) {
        if (!cur.ready) { release(); } // still loading (or failed): nothing on screen yet, so cancel at once
        else {
          show += (0 - show) * (1 - Math.exp(-dt * 7));
          if (show < 0.02) release();
        }
      }
      if (!cur && wanted && wanted.key !== failed) load(wanted);
      if (!cur) { show = 0; return; }
      if (!cur.ready) return;

      cur.mesh.visible = true;
      if (wanted && cur.key === wanted.key) show += (1 - show) * (1 - Math.exp(-dt * 3));

      // frame the photo so the window is filled by it (cover), a little tighter than the photo's own field of view
      const aspect = mainCamera.aspect;
      const f = SHARP_FOCAL_MM * Math.hypot(cur.w, cur.h) / FRAME_DIAGONAL_MM;
      const tanFit = Math.min(cur.h / 2 / f, cur.w / 2 / f / aspect) * 0.9;
      cam.fov = (2 * Math.atan(tanFit) * 180) / Math.PI;
      cam.aspect = aspect;
      cam.updateProjectionMatrix();

      // how far the main camera has orbited since the splat appeared
      tmp.subVectors(mainCamera.position, target);
      const az = Math.atan2(tmp.x, tmp.z), el = Math.asin(THREE.MathUtils.clamp(tmp.y / Math.max(tmp.length(), 1e-4), -1, 1));
      if (!base) base = { az, el };
      const dAz = THREE.MathUtils.clamp(az - base.az, -1, 1), dEl = THREE.MathUtils.clamp(el - base.el, -0.6, 0.6);
      const sway = motion ? Math.sin(time * 0.3) * 0.025 : 0;
      cam.position.set(dAz * ORBIT_RANGE + cursor.x * CURSOR_RANGE + sway, dEl * ORBIT_RANGE + cursor.y * CURSOR_RANGE * 0.6, 0);
      cam.lookAt(0, 0, PIVOT_Z);
    },

    // draw into the backdrop texture; returns whether there is anything to composite
    render() {
      if (!cur?.ready || show < 0.004) return false;
      // an unchanged view, or one drawn a moment ago, keeps the texture it already has
      const pose = [cam.position.x, cam.position.y, cam.fov, cam.aspect, rt.width].map((v) => v.toFixed(4)).join();
      const now = performance.now();
      if (pose === lastPose || now - lastDraw < MIN_FRAME_MS) return true;
      lastPose = pose;
      lastDraw = now;
      const prevColor = new THREE.Color(), prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(prevColor);
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      renderer.setClearColor(prevColor, prevAlpha);
      return true;
    },
  };
}
