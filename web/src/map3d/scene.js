// 3D network map: a lazily loaded alternative renderer for the map (see map.js).
// One InstancedMesh draws every node and one LineSegments draws every channel, so
// the ~600 node / ~12k edge hub graph costs two draw calls. TrackballControls give
// free rotation on all axes; rendering runs only while something moves.
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshLambertMaterial,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import { forceCenter, forceLink, forceManyBody, forceSimulation } from "d3-force-3d";

const BG = [9, 12, 11]; // map background behind translucent node colours
const FOV = 50;
const RADIUS = 260; // layout radius in world units
const LAYOUT_TICKS = 170;
const WARMUP_TICKS = 30;
const MAX_LABELS = 36;

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// "#rrggbb" or "rgba(r,g,b,a)" (premultiplied, as map.js uses for sigma).
function parseColor(text) {
  if (text.startsWith("#")) {
    const v = [1, 3, 5].map((i) => parseInt(text.slice(i, i + 2), 16));
    return { rgb: v, a: 1 };
  }
  const m = text.match(/rgba?\(([^)]+)\)/);
  if (!m) return { rgb: [255, 255, 255], a: 1 };
  const [r, g, b, a = 1] = m[1].split(",").map(Number);
  return { rgb: [r, g, b], a };
}
const colorCache = new Map();
/** Opaque colour a premultiplied colour shows over the map background. */
function solid(text) {
  let hit = colorCache.get(text);
  if (!hit) {
    const { rgb, a } = parseColor(text); // rgba() values are already premultiplied
    hit = new Color(...rgb.map((v, i) => Math.min(255, v + BG[i] * (1 - a)) / 255));
    colorCache.set(text, hit);
  }
  return hit;
}
// Lines overlap far more in 3D (the whole depth of the graph stacks up), so each
// channel is drawn a little fainter than its 2D colour.
const EDGE_ALPHA_3D = 0.55;
/** Straight-alpha RGBA for a channel line (2D colours arrive premultiplied). */
function lineRgba(text) {
  const key = `l${text}`;
  let hit = colorCache.get(key);
  if (!hit) {
    const { rgb, a } = parseColor(text);
    const straight = text.startsWith("#") ? rgb : rgb.map((v) => (a > 0 ? v / a : 0));
    const alpha = text.startsWith("#") ? 0.9 : Math.min(1, a * EDGE_ALPHA_3D);
    hit = [...straight.map((v) => Math.min(1, v / 255)), alpha];
    colorCache.set(key, hit);
  }
  return hit;
}

function hash01(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h / 0xffffffff;
}

export function create(container, hooks) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = "map3d-canvas";
  container.appendChild(renderer.domElement);
  const labelLayer = document.createElement("div");
  labelLayer.className = "map3d-labels";
  labelLayer.setAttribute("aria-hidden", "true");
  container.appendChild(labelLayer);

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 20000);
  scene.add(new AmbientLight(0xffffff, 1.1));
  const sun = new DirectionalLight(0xffffff, 1.5);
  sun.position.set(0.4, 0.8, 1);
  camera.add(sun); // light follows the viewer so the front is always lit
  scene.add(camera);

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 3;
  controls.zoomSpeed = 1.1;
  controls.panSpeed = 0.7;
  controls.dynamicDampingFactor = 0.14;
  controls.minDistance = 30;
  controls.maxDistance = 4000;
  controls.keys = []; // no A/S/D modifier keys: they would fire while typing in search

  const st = {
    graph: null,
    ids: [],
    index: new Map(),
    nodes: [],
    links: [],
    mesh: null,
    lines: null,
    sim: null,
    ticks: 0,
    styles: [],
    insets: { left: 0, right: 0, top: 0, bottom: 0 },
    width: 1,
    height: 1,
    active: true,
    running: false,
    idle: 0,
    dirty: true,
    anim: null,
    touched: false,
    hover: null,
    pointer: null,
    labels: new Map(),
    frames: 0,
    renders: 0,
    renderMs: 0,
  };

  camera.position.set(0, 0, fitDistance(RADIUS));

  /** Camera distance at which a sphere of `radius` fits the panel-free area. */
  function fitDistance(radius) {
    const tanV = Math.tan(((FOV / 2) * Math.PI) / 180);
    const freeW = Math.max(120, st.width - st.insets.left - st.insets.right);
    const freeH = Math.max(120, st.height - st.insets.top - st.insets.bottom);
    // Half-angles the free area subtends; the narrower one limits the fit
    // (portrait and phone viewports are width-limited).
    const half = Math.min(Math.atan((tanV * freeH) / st.height), Math.atan((tanV * freeW) / st.height));
    return (radius / Math.sin(half)) * 1.08;
  }

  // ---------- graph ----------
  function setGraph(graph) {
    disposeGraph();
    st.graph = graph;
    st.ids = graph.nodes();
    st.index = new Map(st.ids.map((id, i) => [id, i]));
    // Seed from the 2D layout so the 3D view starts from a familiar shape.
    let maxR = 1;
    let cx = 0;
    let cy = 0;
    st.ids.forEach((id) => {
      cx += graph.getNodeAttribute(id, "x");
      cy += graph.getNodeAttribute(id, "y");
    });
    cx /= st.ids.length || 1;
    cy /= st.ids.length || 1;
    st.ids.forEach((id) => {
      const a = graph.getNodeAttributes(id);
      maxR = Math.max(maxR, Math.hypot(a.x - cx, a.y - cy));
    });
    const k = RADIUS / maxR;
    st.nodes = st.ids.map((id) => {
      const a = graph.getNodeAttributes(id);
      return { id, x: (a.x - cx) * k, y: -(a.y - cy) * k, z: (hash01(id) - 0.5) * RADIUS * 1.4 };
    });
    st.links = [];
    graph.forEachEdge((key, attrs, source, target) => {
      st.links.push({ key, source: st.index.get(source), target: st.index.get(target) });
    });

    const n = st.nodes.length;
    const mesh = new InstancedMesh(new SphereGeometry(1, 16, 12), new MeshLambertMaterial({ color: 0xffffff }), Math.max(1, n));
    mesh.count = n;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    st.mesh = mesh;
    scene.add(mesh);

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(st.links.length * 6), 3).setUsage(DynamicDrawUsage));
    // RGBA vertex colours (itemSize 4) so selected and dimmed channels differ in opacity.
    geo.setAttribute("color", new BufferAttribute(new Float32Array(st.links.length * 8), 4));
    const lines = new LineSegments(geo, new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    lines.frustumCulled = false;
    st.lines = lines;
    scene.add(lines);

    // Hub graphs are dense (~20 channels per node), so links pull gently
    // (d3's default 1/min-degree strength, scaled down) and charge spreads them.
    const degree = new Array(n).fill(0);
    st.links.forEach((l) => {
      degree[l.source] += 1;
      degree[l.target] += 1;
    });
    const sim = forceSimulation(st.nodes, 3)
      .alphaDecay(1 - Math.pow(0.001, 1 / LAYOUT_TICKS))
      .force(
        "link",
        forceLink(st.links.map((l) => ({ source: l.source, target: l.target })))
          .distance(34)
          .strength((l) => 0.6 / Math.max(1, Math.min(degree[l.source.index], degree[l.target.index]))),
      )
      .force("charge", forceManyBody().strength(-70).distanceMax(RADIUS * 2.2))
      .force("center", forceCenter(0, 0, 0))
      .stop();
    sim.tick(WARMUP_TICKS);
    st.sim = sim;
    st.ticks = WARMUP_TICKS;
    refreshStyles();
    writePositions();
    if (!st.touched) reset(0);
    kick();
  }

  function disposeGraph() {
    st.sim?.stop();
    st.sim = null;
    for (const obj of [st.mesh, st.lines]) {
      if (!obj) continue;
      scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
      obj.dispose?.(); // InstancedMesh: frees instanceMatrix / instanceColor buffers
    }
    st.mesh = null;
    st.lines = null;
    st.hover = null;
    labelLayer.replaceChildren();
    st.labels.clear();
  }

  const m4 = new Matrix4();
  const q0 = new Quaternion();
  const v3 = new Vector3();
  const s3 = new Vector3();
  function writePositions() {
    if (!st.mesh) return;
    st.nodes.forEach((node, i) => {
      const r = st.styles[i]?.radius ?? 1;
      m4.compose(v3.set(node.x, node.y, node.z), q0, s3.set(r, r, r));
      st.mesh.setMatrixAt(i, m4);
    });
    st.mesh.instanceMatrix.needsUpdate = true;
    st.mesh.computeBoundingSphere();
    const pos = st.lines.geometry.attributes.position.array;
    st.links.forEach((l, i) => {
      const a = st.nodes[l.source];
      const b = st.nodes[l.target];
      pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    });
    st.lines.geometry.attributes.position.needsUpdate = true;
    st.dirty = true;
  }

  /** Re-read colours and sizes from map.js's reducers (selection, hover, dimming). */
  function refreshStyles() {
    if (!st.graph || !st.mesh) return;
    st.styles = st.ids.map((id) => {
      const style = hooks.nodeStyle(id);
      return { ...style, radius: Math.max(1.6, style.size * 0.62) };
    });
    st.styles.forEach((style, i) => st.mesh.setColorAt(i, solid(style.color)));
    if (st.mesh.instanceColor) st.mesh.instanceColor.needsUpdate = true;
    const col = st.lines.geometry.attributes.color.array;
    st.links.forEach((l, i) => {
      const c = lineRgba(hooks.edgeStyle(l.key));
      col.set(c, i * 8);
      col.set(c, i * 8 + 4);
    });
    st.lines.geometry.attributes.color.needsUpdate = true;
    writePositions();
    kick();
  }

  // ---------- labels ----------
  const pv = new Vector3();
  function project(i) {
    const node = st.nodes[i];
    pv.set(node.x, node.y, node.z).project(camera);
    if (pv.z > 1 || pv.z < -1) return null;
    return { x: ((pv.x + 1) / 2) * st.width, y: ((1 - pv.y) / 2) * st.height, depth: pv.z };
  }

  function drawLabels() {
    if (!st.mesh) return;
    const order = st.ids
      .map((id, i) => ({ i, style: st.styles[i] }))
      .filter(({ style }) => style.label)
      .sort((a, b) => (b.style.forceLabel ? 1 : 0) - (a.style.forceLabel ? 1 : 0) || b.style.size - a.style.size);
    const taken = [];
    const shown = new Set();
    for (const { i, style } of order) {
      if (shown.size >= MAX_LABELS && !style.forceLabel) break;
      const p = project(i);
      if (!p) continue;
      const text = style.label.length > 26 ? `${style.label.slice(0, 25)}…` : style.label;
      const r = (st.styles[i].radius / (camera.position.distanceTo(v3.set(st.nodes[i].x, st.nodes[i].y, st.nodes[i].z)) || 1)) * (st.height / (2 * Math.tan((FOV * Math.PI) / 360)));
      const box = { x: p.x + r + 4, y: p.y - 10, w: text.length * 6.6 + 12, h: 20 };
      if (box.x > st.width || box.x + box.w < 0 || box.y > st.height || box.y + box.h < 0) continue; // offscreen: no budget
      if (!style.forceLabel && (r < 2.2 || taken.some((t) => box.x < t.x + t.w && t.x < box.x + box.w && box.y < t.y + t.h && t.y < box.y + box.h))) continue;
      taken.push(box);
      const id = st.ids[i];
      shown.add(id);
      let el = st.labels.get(id);
      if (!el) {
        el = document.createElement("span");
        el.className = "map3d-label";
        labelLayer.appendChild(el);
        st.labels.set(id, el);
      }
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle("pill", Boolean(style.pill));
      el.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(p.y)}px) translateY(-50%)`;
      el.style.opacity = String(Math.max(0.55, 1 - (p.depth - 0.9) * 4));
    }
    for (const [id, el] of st.labels) {
      if (!shown.has(id)) {
        el.remove();
        st.labels.delete(id);
      }
    }
  }

  // ---------- picking ----------
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  function pick(clientX, clientY) {
    if (!st.mesh) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(st.mesh, false)[0];
    return hit && hit.instanceId !== undefined ? st.ids[hit.instanceId] : null;
  }

  let down = null;
  // Pointers currently pressed; a gesture that ever had two (pinch, two-finger
  // pan) is a camera move, never a click.
  const pressed = new Set();
  let multi = false;
  const el = renderer.domElement;
  const release = (event) => {
    pressed.delete(event.pointerId);
    if (!pressed.size) multi = false;
  };
  el.addEventListener("pointercancel", (event) => {
    release(event);
    down = null;
  });
  el.addEventListener("pointerdown", (event) => {
    pressed.add(event.pointerId);
    if (pressed.size > 1) multi = true;
    down = { x: event.clientX, y: event.clientY, button: event.button };
    st.touched = true;
    st.anim = null;
    kick();
  });
  el.addEventListener("pointerup", (event) => {
    const wasMulti = multi;
    release(event);
    if (!down) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    const button = down.button;
    down = null;
    if (wasMulti || button !== 0 || moved > 5) return;
    const node = pick(event.clientX, event.clientY);
    if (node) hooks.onClick(node);
    else hooks.onStage();
  });
  el.addEventListener("pointermove", (event) => {
    st.pointer = { x: event.clientX, y: event.clientY, buttons: event.buttons };
    kick();
  });
  el.addEventListener("pointerleave", () => {
    st.pointer = null;
    setHover(null);
  });
  el.addEventListener("wheel", () => {
    st.touched = true;
    st.anim = null;
    kick();
  }, { passive: true });
  controls.addEventListener("change", () => {
    st.dirty = true;
    st.idle = 0;
    hooks.onCamera?.();
  });

  function setHover(node) {
    if (node === st.hover) return;
    st.hover = node;
    el.style.cursor = node ? "pointer" : "";
    hooks.onHover(node);
  }

  // ---------- camera animation ----------
  function animate(duration, step) {
    st.anim = { start: performance.now(), duration: Math.max(1, duration), step };
    kick();
  }
  function rotateBy(rad) {
    const axis = camera.up.clone().normalize();
    const offset = camera.position.clone().sub(controls.target);
    const q = new Quaternion();
    animate(320, (t) => {
      q.setFromAxisAngle(axis, rad * ease(t));
      camera.position.copy(controls.target).add(offset.clone().applyQuaternion(q));
      camera.lookAt(controls.target);
    });
  }
  function zoom(factor) {
    const offset = camera.position.clone().sub(controls.target);
    animate(260, (t) => {
      const f = 1 + (factor - 1) * ease(t);
      camera.position.copy(controls.target).add(offset.clone().multiplyScalar(f));
    });
  }
  function moveTo(target, position, up, duration) {
    const t0 = controls.target.clone();
    const p0 = camera.position.clone();
    const u0 = camera.up.clone();
    const step = (t) => {
      const e = ease(t);
      controls.target.lerpVectors(t0, target, e);
      camera.position.lerpVectors(p0, position, e);
      camera.up.lerpVectors(u0, up, e).normalize();
      camera.lookAt(controls.target);
    };
    if (!duration) {
      step(1);
      st.dirty = true;
      return;
    }
    animate(duration, step);
  }
  function graphRadius() {
    let r = 1;
    for (const node of st.nodes) r = Math.max(r, Math.hypot(node.x, node.y, node.z));
    return r;
  }
  function reset(duration = 500) {
    st.touched = false;
    moveTo(new Vector3(0, 0, 0), new Vector3(0, 0, fitDistance(graphRadius())), new Vector3(0, 1, 0), duration);
  }
  /** Fly to one node, or to the midpoint of several (a channel's endpoints). */
  function focus(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((id) => st.index.get(id)).filter((i) => i !== undefined);
    if (!list.length) return;
    const target = new Vector3();
    for (const i of list) target.add(v3.set(st.nodes[i].x, st.nodes[i].y, st.nodes[i].z));
    target.divideScalar(list.length);
    const offset = camera.position.clone().sub(controls.target);
    const dist = Math.min(offset.length(), RADIUS * 1.9);
    st.touched = true;
    moveTo(target, target.clone().add(offset.normalize().multiplyScalar(dist)), camera.up.clone(), 600);
  }

  // ---------- sizing ----------
  function applyView() {
    const { width, height } = container.getBoundingClientRect();
    st.width = Math.max(1, width);
    st.height = Math.max(1, height);
    renderer.setSize(st.width, st.height, false);
    camera.aspect = st.width / st.height;
    const ox = (st.insets.right - st.insets.left) / 2;
    const oy = (st.insets.bottom - st.insets.top) / 2;
    camera.setViewOffset(st.width, st.height, ox, oy, st.width, st.height);
    camera.updateProjectionMatrix();
    controls.handleResize();
    st.dirty = true;
    kick();
  }
  const resizeObserver = new ResizeObserver(applyView);
  resizeObserver.observe(container);
  applyView(); // size synchronously so the first setGraph() frames correctly

  // ---------- loop ----------
  function kick() {
    st.idle = 0;
    if (st.running || !st.active || document.hidden) return;
    st.running = true;
    requestAnimationFrame(frame);
  }
  function frame(now) {
    if (!st.active || document.hidden) {
      st.running = false;
      return;
    }
    st.frames += 1;
    if (st.anim) {
      const t = Math.min(1, (now - st.anim.start) / st.anim.duration);
      st.anim.step(t);
      st.dirty = true;
      if (t >= 1) st.anim = null;
    }
    controls.update();
    if (st.sim && st.ticks < LAYOUT_TICKS + WARMUP_TICKS) {
      // Spend up to ~6 ms of each frame on layout so it settles in about a second.
      const t0 = performance.now();
      do {
        st.sim.tick();
        st.ticks += 1;
      } while (st.ticks < LAYOUT_TICKS + WARMUP_TICKS && performance.now() - t0 < 6);
      writePositions();
      if (!st.touched && !st.anim) {
        const d = fitDistance(graphRadius());
        camera.position.setLength(d); // keep the settling graph framed until the user takes over
      }
    }
    if (st.pointer && !st.pointer.buttons) setHover(pick(st.pointer.x, st.pointer.y));
    if (st.dirty) {
      st.dirty = false;
      st.idle = 0;
      const t0 = performance.now();
      renderer.render(scene, camera);
      drawLabels();
      st.renderMs = st.renderMs * 0.9 + (performance.now() - t0) * 0.1;
      st.renders += 1;
    } else {
      st.idle += 1;
    }
    const settling = st.sim && st.ticks < LAYOUT_TICKS + WARMUP_TICKS;
    if (settling || st.anim || st.idle < 20) requestAnimationFrame(frame);
    else st.running = false;
  }
  const onVisibility = () => {
    if (!document.hidden) kick();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    setGraph,
    refreshStyles,
    setActive(on) {
      st.active = on;
      if (on) {
        st.dirty = true;
        kick();
      }
    },
    setInsets(insets) {
      st.insets = { left: 0, right: 0, top: 0, bottom: 0, ...insets };
      applyView();
    },
    viewportOf(id) {
      const i = st.index.get(id);
      if (i === undefined) return null;
      const p = project(i);
      if (!p) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      return { x: p.x + rect.left, y: p.y + rect.top };
    },
    rotateBy,
    zoomIn: () => zoom(0.7),
    zoomOut: () => zoom(1 / 0.7),
    reset: () => reset(500),
    focus,
    stats: () => ({ renderMs: Math.round(st.renderMs * 10) / 10, renders: st.renders, hover: st.hover, frames: st.frames, nodes: st.nodes.length, links: st.links.length, ticks: st.ticks, running: st.running }),
    destroy() {
      document.removeEventListener("visibilitychange", onVisibility);
      resizeObserver.disconnect();
      disposeGraph();
      controls.dispose();
      renderer.dispose();
      container.replaceChildren();
    },
  };
}
