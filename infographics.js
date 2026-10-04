// 3D infographics that float beside an open story. Each one is a self-contained Three.js group with the same small API:
//   update(dt, time, show)   advance animation; show is 0..1 and eases the whole thing in and out
//   hover(raycaster)         pointer hover (null clears it); returns true when the pointer is over the graphic
//   click(raycaster)         a click; returns true when it landed on the graphic
//
// Every figure below comes from the article itself. Nothing is estimated: "other sports" is simply total minus athletics.
import * as THREE from 'three';

const FONT = '"SF Pro Display", "Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif';
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeOut = (p) => 1 - Math.pow(1 - p, 3);

// "Bahrain tops Arab nations at Asian Games with 22 medals" (Arab News)
export const BAHRAIN_MEDALS = {
  nation: 'BAHRAIN',
  event: 'Aichi-Nagoya 2026 Asian Games · top-ranked Arab nation',
  total: 22,
  columns: [ // podium order is set by COL_X below: gold in the middle, silver left, bronze right
    { label: 'GOLD', color: '#f2c14e', total: 11, athletics: 9 },
    { label: 'SILVER', color: '#d5dcec', total: 5, athletics: 2 },
    { label: 'BRONZE', color: '#d68b4f', total: 6, athletics: 2 },
  ],
  highlight: ['FIRST HANDBALL GOLD', '33–32 over Qatar in the final'],
};

const UNIT = 0.2;              // world height of one medal
const COL_X = [0, -1.3, 1.3];  // gold centre, silver left, bronze right
const GAP = 0.016;             // between the athletics block and the other-sports block

function makeLabel(w, h, pxPerUnit = 200) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * pxPerUnit);
  canvas.height = Math.round(h * pxPerUnit);
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // tinted just under the bloom threshold so the text stays crisp
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, color: 0xe6e6e6, opacity: 0 });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(w, h, 1);
  return {
    sprite, mat,
    redraw(fn) { ctx.clearRect(0, 0, canvas.width, canvas.height); fn(ctx, canvas.width, canvas.height); tex.needsUpdate = true; },
  };
}

// Glass-like column material: lit body, vertical gradient, fresnel rim picked up from the theme accent, a slow sheen
function glassMaterial(color, alpha, accent, time) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uAlpha: { value: alpha }, uShow: { value: 0 }, uGlow: { value: 0 },
      uTime: time, uAccent: { value: accent },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main() {
        vUv = uv;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uAccent;
      uniform float uAlpha, uShow, uGlow, uTime;
      varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main() {
        vec3 N = normalize(vN), V = normalize(vV);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 2.3);
        float lambert = 0.5 + 0.5 * max(dot(N, normalize(vec3(-0.45, 0.85, 0.5))), 0.0);
        vec3 col = uColor * lambert * 0.82;
        col += uColor * 0.22 * vUv.y;                                       // lighter toward the top of each block
        col += mix(uColor, uAccent, 0.4) * fres * (0.5 + 0.7 * uGlow);      // glassy rim
        float sheen = exp(-pow((vUv.y * 0.9 + vUv.x * 0.35 - fract(uTime * 0.1)) * 4.5, 2.0));
        col += vec3(1.0, 0.98, 0.92) * sheen * (0.07 + 0.12 * uGlow);
        col += uColor * 0.25 * uGlow;
        gl_FragColor = vec4(col, clamp(uAlpha + fres * 0.25, 0.0, 1.0) * uShow);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: alpha > 0.9,
  });
}

function platformMaterial(accent) {
  return new THREE.ShaderMaterial({
    uniforms: { uShow: { value: 0 }, uAccent: { value: accent } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main() {
        vUv = uv; vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uAccent; uniform float uShow;
      varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main() {
        vec3 N = normalize(vN), V = normalize(vV);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        float r = length(vUv - 0.5) * 2.0;
        float ring = 1.0 - smoothstep(0.0, 0.012, abs(fract(r * 4.0) - 0.5) - 0.488);   // thin concentric guide rings on the top face
        float top = step(0.5, N.y);
        vec3 col = vec3(0.04, 0.055, 0.13) + uAccent * (0.05 + 0.04 * top) + uAccent * fres * 0.5 * (1.0 - top) + uAccent * ring * 0.22 * top;
        gl_FragColor = vec4(col, 0.8 * uShow);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
}

export function createMedalInfographic({ accent, reduceMotion = () => false, scale = 1, data = BAHRAIN_MEDALS }) {
  const group = new THREE.Group();
  const time = { value: 0 };
  const pickables = [];
  let age = 0;           // seconds since it started to appear
  let hoverCol = -1;
  let shownCaption = null; // null until the legend has been drawn once

  // platform: a glass disc with a glowing edge
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(2.45, 2.45, 0.1, 72), platformMaterial(accent));
  platform.position.y = -0.05;
  platform.userData.col = -1;
  group.add(platform);
  pickables.push(platform);
  const edge = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.014, 8, 144), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
  edge.rotation.x = Math.PI / 2;
  group.add(edge);

  // the medal columns: an athletics block with the other sports stacked on top
  const cyl = new THREE.CylinderGeometry(0.46, 0.46, 1, 56, 1);
  cyl.translate(0, 0.5, 0); // grows upward from y = 0
  const cols = data.columns.map((c, i) => {
    const g = new THREE.Group();
    g.position.x = COL_X[i];
    const ath = new THREE.Mesh(cyl, glassMaterial(c.color, 0.96, accent, time));
    const oth = new THREE.Mesh(cyl, glassMaterial(c.color, 0.5, accent, time));
    ath.userData.col = oth.userData.col = i;
    g.add(ath, oth);
    group.add(g);
    pickables.push(ath, oth);
    const label = makeLabel(1.3, 0.95);
    group.add(label.sprite);
    return { c, g, ath, oth, label, other: c.total - c.athletics, grow: 0, hover: 0, pulse: 0, shownCount: -1 };
  });

  // the handball gold: a small orb with its caption
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 40, 28), glassMaterial('#f2c14e', 0.95, accent, time));
  orb.position.set(-1.95, 3.15, 0.1);
  orb.userData.col = -2;
  group.add(orb);
  pickables.push(orb);
  const badge = makeLabel(2.7, 0.8);
  badge.sprite.position.set(-1.95, 2.58, 0.1);
  badge.redraw((ctx, w, h) => {
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#f6cf6b'; ctx.font = `700 ${h * 0.2}px ${FONT}`; ctx.letterSpacing = '3px';
    ctx.fillText(data.highlight[0], w / 2, h * 0.14);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)'; ctx.font = `500 ${h * 0.2}px ${FONT}`;
    ctx.fillText(data.highlight[1], w / 2, h * 0.5);
  });
  group.add(badge.sprite);

  // title above the podium
  const title = makeLabel(5, 1.1);
  title.sprite.position.set(0, 4.0, 0);
  title.redraw((ctx, w, h) => {
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'; ctx.font = `700 ${h * 0.15}px ${FONT}`; ctx.letterSpacing = '5px';
    ctx.fillText(data.nation, w / 2, h * 0.04);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = '#fff'; ctx.font = `700 ${h * 0.46}px ${FONT}`;
    ctx.fillText(`${data.total} medals`, w / 2, h * 0.19);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'; ctx.font = `500 ${h * 0.13}px ${FONT}`;
    ctx.fillText(data.event, w / 2, h * 0.82);
  });
  group.add(title.sprite);

  // legend at the front of the platform; shows the breakdown of whichever column the pointer is over
  const legend = makeLabel(4.8, 0.5);
  legend.sprite.position.set(0, -0.62, 1.7);
  function drawLegend() {
    const col = cols[hoverCol];
    const text = col ? `${col.c.label} · ${col.c.total} medals — ${col.c.athletics} in athletics, ${col.other} in other sports` : '';
    if (text === shownCaption) return;
    shownCaption = text;
    legend.redraw((ctx, w, h) => {
      ctx.textBaseline = 'middle';
      if (col) {
        ctx.textAlign = 'center'; ctx.fillStyle = col.c.color; ctx.font = `600 ${h * 0.34}px ${FONT}`;
        ctx.fillText(text, w / 2, h / 2);
        return;
      }
      ctx.font = `600 ${h * 0.32}px ${FONT}`; ctx.textAlign = 'left';
      const sw = h * 0.3, y = h / 2;
      let x = w * 0.5 - 1.45 * (w / 4.8);
      ctx.fillStyle = 'rgba(235, 238, 250, 0.95)'; ctx.fillRect(x, y - sw / 2, sw, sw);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'; ctx.fillText('Athletics', x + sw * 1.5, y);
      x += 1.45 * (w / 4.8);
      ctx.fillStyle = 'rgba(235, 238, 250, 0.4)'; ctx.fillRect(x, y - sw / 2, sw, sw);
      ctx.strokeStyle = 'rgba(235, 238, 250, 0.9)'; ctx.lineWidth = 2; ctx.strokeRect(x, y - sw / 2, sw, sw);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'; ctx.fillText('Other sports', x + sw * 1.5, y);
    });
  }
  drawLegend();
  group.add(legend.sprite);

  function drawCount(col, n) {
    col.shownCount = n;
    col.label.redraw((ctx, w, h) => {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#fff'; ctx.font = `700 ${h * 0.58}px ${FONT}`;
      ctx.fillText(String(n), w / 2, h * 0.0);
      ctx.fillStyle = col.c.color; ctx.font = `700 ${h * 0.17}px ${FONT}`; ctx.letterSpacing = '4px';
      ctx.fillText(col.c.label, w / 2, h * 0.68);
      ctx.letterSpacing = '0px';
    });
  }

  group.visible = false;
  const tmpAccent = new THREE.Color();

  return {
    group,

    update(dt, t, show) {
      time.value = t;
      group.visible = show > 0.003;
      if (!group.visible) { age = 0; return; }
      if (show > 0.05) age += dt;
      group.scale.setScalar(scale * (0.88 + 0.12 * show));
      group.rotation.y = 0.3 + (reduceMotion() ? 0 : Math.sin(t * 0.35) * 0.16);

      platform.material.uniforms.uShow.value = show;
      tmpAccent.setRGB(accent.x, accent.y, accent.z);
      edge.material.color.copy(tmpAccent);
      edge.material.opacity = 0.75 * show;
      title.mat.opacity = badge.mat.opacity = legend.mat.opacity = show;
      title.sprite.position.y = 4.0 + (reduceMotion() ? 0 : Math.sin(t * 0.8) * 0.03);

      cols.forEach((col, i) => {
        const p = easeOut(clamp01((age - i * 0.2) / 1.3)); // gold rises first, then silver, then bronze
        col.grow = p;
        col.hover += ((hoverCol === i ? 1 : 0) - col.hover) * Math.min(1, dt * 10);
        col.pulse = Math.max(0, col.pulse - dt * 1.4);
        const aH = col.c.athletics * UNIT * easeOut(clamp01(p * 1.7));
        const oH = col.other * UNIT * easeOut(clamp01(p * 1.7 - 0.7));
        col.ath.scale.set(1 + 0.07 * col.hover, Math.max(aH, 0.001), 1 + 0.07 * col.hover);
        col.oth.scale.set(1 + 0.07 * col.hover, Math.max(oH, 0.001), 1 + 0.07 * col.hover);
        col.oth.position.y = aH + (oH > 0.002 ? GAP : 0);
        col.g.position.y = col.pulse > 0 ? Math.sin(col.pulse * Math.PI) * 0.2 : 0;
        for (const m of [col.ath, col.oth]) {
          m.material.uniforms.uShow.value = show;
          m.material.uniforms.uGlow.value = col.hover;
        }
        const top = col.oth.position.y + oH;
        col.label.sprite.position.set(COL_X[i], top + 0.55 + col.g.position.y, 0.15);
        col.label.mat.opacity = show * clamp01(p * 3);
        const n = Math.round(col.c.total * p);
        if (n !== col.shownCount) drawCount(col, n);
      });

      const bob = reduceMotion() ? 0 : Math.sin(t * 1.3) * 0.06;
      orb.position.y = 3.15 + bob;
      orb.rotation.y = t * 0.8;
      orb.material.uniforms.uShow.value = show;
      orb.material.uniforms.uGlow.value = 0.3;
      drawLegend();
    },

    hover(raycaster) {
      if (!raycaster || !group.visible) { hoverCol = -1; return false; }
      const hit = raycaster.intersectObjects(pickables, false)[0];
      hoverCol = hit && hit.object.userData.col >= 0 ? hit.object.userData.col : -1;
      return !!hit;
    },

    click(raycaster) {
      if (!group.visible) return false;
      const hit = raycaster.intersectObjects(pickables, false)[0];
      if (!hit) return false;
      const i = hit.object.userData.col;
      if (i >= 0) cols[i].pulse = 1;
      return true;
    },
  };
}
