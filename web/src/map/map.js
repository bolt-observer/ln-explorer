// The map: one persistent sigma renderer behind every map-mode view.
// Views talk to it through the exported `map` object; it never renders views.
import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { api } from "../lib/api.js";
import { btc, displayName, esc, int } from "../lib/format.js";
import { go, homeUrl, mapUrl, currentRoute } from "../lib/router.js";
import { graphQuery, GRAPH_FILTER_KEYS } from "../lib/graph-query.js";
import { refreshStatus, getStatus } from "../ui/chrome.js";
import { Fallback } from "./fallback.js";

export const ACCENT = "#1dfebb";
// sigma blends with premultiplied alpha (ONE, ONE_MINUS_SRC_ALPHA), so translucent
// colours must carry rgb already multiplied by alpha or they render at full strength.
const premul = (r, g, b, a) => `rgba(${Math.round(r * a)},${Math.round(g * a)},${Math.round(b * a)},${a})`;
const DIM_NODE = premul(200, 214, 209, 0.16);
const LIT_NODE = "#e6f2ee";
const EDGE = premul(29, 254, 187, 0.24);
const EDGE_DIM = premul(29, 254, 187, 0.03);
const EDGE_LIT = premul(29, 254, 187, 0.42);
const EDGE_HOVER = premul(232, 238, 235, 0.85);
export const DENSITY_STEPS = [100, 200, 400, 600, 800];

const s = {
  container: null,
  layer: null,
  tip: null,
  renderer: null,
  fallback: null,
  graph: null,
  payload: null,
  byKey: new Map(),
  key: "",
  loading: null,
  controller: null,
  focus: null,
  edge: null,
  preview: null,
  hover: null,
  hoverEdge: null,
  lit: new Set(),
  insets: { left: 0, right: 0, top: 0, bottom: 0 },
  loadListeners: new Set(),
};

// ---------- colour + size ----------
function mix(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}
const capBtc = (node) => (node.capacity || 0) / 1e8;
const nodeSize = (node) => Math.min(17, 2.2 + Math.sqrt(capBtc(node)) * 0.62);
const nodeColor = (node) => mix("#33403c", "#dbe6e2", Math.min(1, Math.log10(1 + capBtc(node)) / 2.6));

// ---------- canvas label drawers ----------
function trimLabel(text) {
  return text.length > 26 ? `${text.slice(0, 25)}…` : text;
}

// Labels already drawn this frame; sigma's label grid ignores label width, so
// overlapping labels are dropped here. Reset on every "beforeRender".
let frameLabels = [];
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function drawLabel(ctx, data, settings, force = false) {
  if (!data.label) return;
  const text = trimLabel(data.label);
  if (data.pill) {
    ctx.font = `600 12.5px ${settings.labelFont}`;
    const w = ctx.measureText(text).width + 18;
    const x = data.x + data.size + 7;
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.roundRect(x, data.y - 12, w, 24, 7);
    ctx.fill();
    ctx.fillStyle = "#02281d";
    ctx.fillText(text, x + 9, data.y + 4.5);
    return;
  }
  ctx.font = `500 ${settings.labelSize}px ${settings.labelFont}`;
  const x = data.x + data.size + 6;
  const y = data.y + settings.labelSize / 3;
  const box = { x: x - 3, y: data.y - 10, w: ctx.measureText(text).width + 6, h: 20 };
  if (!force && frameLabels.some((other) => overlaps(box, other))) return;
  frameLabels.push(box);
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(7,9,8,0.92)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = data.labelTone || "rgba(232,238,235,0.88)";
  ctx.fillText(text, x, y);
}

function drawHover(ctx, data, settings) {
  const ring = data.pill ? ACCENT : "rgba(232,238,235,0.85)";
  ctx.strokeStyle = ring;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(data.x, data.y, data.size + 4.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = data.pill ? "rgba(29,254,187,0.22)" : "rgba(232,238,235,0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(data.x, data.y, data.size + 12, 0, Math.PI * 2);
  ctx.stroke();
  drawLabel(ctx, data, settings, true);
}

// ---------- reducers ----------
function selectionActive() {
  return s.focus !== null || s.edge !== null || s.preview !== null;
}

function nodeReducer(node, data) {
  const res = { ...data };
  const center = s.focus ?? s.preview;
  if (s.edge) {
    if (s.edge.includes(node)) Object.assign(res, { color: ACCENT, pill: true, forceLabel: true, highlighted: true, zIndex: 3 });
    else Object.assign(res, { color: DIM_NODE, label: null, zIndex: 0 });
  } else if (center !== null) {
    if (node === center) Object.assign(res, { color: ACCENT, pill: true, forceLabel: true, highlighted: true, zIndex: 3, size: Math.max(data.size, 6) });
    else if (s.lit.has(node)) Object.assign(res, { color: LIT_NODE, zIndex: 2 });
    else Object.assign(res, { color: DIM_NODE, label: null, zIndex: 0 });
  }
  if (node === s.hover) Object.assign(res, { highlighted: true, forceLabel: true, zIndex: 4, labelTone: "#ffffff" });
  return res;
}

function edgeReducer(edge, data) {
  const res = { ...data };
  if (edge === s.hoverEdge) return Object.assign(res, { color: EDGE_HOVER, size: data.size + 1, zIndex: 3 });
  if (s.edge) {
    const [a, b] = s.graph.extremities(edge);
    const on = s.edge.includes(a) && s.edge.includes(b);
    return Object.assign(res, on ? { color: ACCENT, size: 3, zIndex: 2 } : { color: EDGE_DIM });
  }
  const center = s.focus ?? s.preview;
  if (center !== null) {
    const [a, b] = s.graph.extremities(edge);
    return Object.assign(res, a === center || b === center ? { color: EDGE_LIT, size: data.size + 0.4, zIndex: 1 } : { color: EDGE_DIM });
  }
  return res;
}

// ---------- layout ----------
function seedPositions(nodes) {
  const ordered = [...nodes].sort((a, b) => b.channels - a.channels);
  ordered.forEach((node, index) => {
    if (index === 0) {
      node.x = 0;
      node.y = 0;
      return;
    }
    const ring = 1 + Math.floor(Math.log2(index + 1));
    let hash = 0;
    for (let i = 0; i < node.pubkey.length; i += 1) hash = (hash * 33 + node.pubkey.charCodeAt(i)) >>> 0;
    const angle = (hash / 0xffffffff) * Math.PI * 2 + ring * 0.35;
    node.x = Math.cos(angle) * (6 + ring * 9);
    node.y = Math.sin(angle) * (6 + ring * 9);
  });
}

function buildGraph(payload) {
  seedPositions(payload.nodes);
  const graph = new Graph({ type: "undirected", multi: false });
  payload.nodes.forEach((node) => {
    graph.addNode(node.pubkey, {
      x: node.x,
      y: node.y,
      size: nodeSize(node),
      color: nodeColor(node),
      label: displayName(node.alias, node.pubkey),
    });
  });
  const maxCap = Math.max(1, ...payload.edges.map((edge) => edge.capacity || 0));
  payload.edges.forEach((edge) => {
    if (edge.a === edge.b || !graph.hasNode(edge.a) || !graph.hasNode(edge.b)) return;
    if (graph.hasEdge(edge.a, edge.b)) return;
    graph.addEdgeWithKey(String(edge.scid), edge.a, edge.b, {
      scid: String(edge.scid),
      capacity: edge.capacity || 0,
      count: edge.count || 1,
      size: 0.35 + 1.1 * Math.sqrt((edge.capacity || 0) / maxCap),
      color: EDGE,
    });
  });
  if (graph.order > 1 && graph.order <= 1400) {
    forceAtlas2.assign(graph, {
      iterations: graph.order > 600 ? 160 : 300,
      settings: {
        barnesHutOptimize: true,
        strongGravityMode: true,
        gravity: 0.6,
        scalingRatio: 14,
        slowDown: 4,
        linLogMode: true,
        outboundAttractionDistribution: true,
      },
    });
  }
  return graph;
}

// ---------- tooltip ----------
function showTipForNode(node) {
  const info = s.byKey.get(node);
  const view = viewportOf(node);
  if (!info || !view) return hideTip();
  s.tip.innerHTML = `<b>${esc(displayName(info.alias, info.pubkey))}</b>
    <div class="mono text-2" style="margin-top:2px">${btc(info.capacity)} BTC · ${int(info.channels)} channels</div>
    <div class="sub" style="margin-top:4px">Click to inspect</div>`;
  placeTip(view.x + 16, view.y + 16);
}

function showTipForEdge(edge) {
  const [a, b] = s.graph.extremities(edge);
  const attrs = s.graph.getEdgeAttributes(edge);
  const na = s.byKey.get(a);
  const nb = s.byKey.get(b);
  s.tip.innerHTML = `<b>${esc(displayName(na?.alias, a))} ↔ ${esc(displayName(nb?.alias, b))}</b>
    <div class="mono text-2" style="margin-top:2px">${attrs.capacity ? `${btc(attrs.capacity)} BTC` : "capacity unknown"}${attrs.count > 1 ? ` · ${attrs.count} channels` : ""}</div>
    <div class="sub" style="margin-top:4px">Click to inspect the channel</div>`;
  const pa = viewportOf(a);
  const pb = viewportOf(b);
  if (pa && pb) placeTip((pa.x + pb.x) / 2 + 12, (pa.y + pb.y) / 2 + 12);
}

function placeTip(x, y) {
  s.tip.hidden = false;
  const w = s.tip.offsetWidth;
  const h = s.tip.offsetHeight;
  s.tip.style.left = `${Math.min(x, window.innerWidth - w - 12)}px`;
  s.tip.style.top = `${Math.min(y, window.innerHeight - h - 12)}px`;
}

function hideTip() {
  if (s.tip) s.tip.hidden = true;
}

function viewportOf(node) {
  if (!s.renderer) return null;
  const data = s.renderer.getNodeDisplayData(node);
  return data ? s.renderer.framedGraphToViewport(data) : null;
}

// ---------- state rendering ----------
function setMapState(html) {
  s.container.style.visibility = html ? "hidden" : "";
  let el = s.layer.querySelector(".map-state");
  if (!html) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "map-state";
    s.layer.appendChild(el);
  }
  el.innerHTML = `<div class="box">${html}</div>`;
}

function refresh() {
  if (s.renderer) s.renderer.refresh();
  if (s.fallback) s.fallback.draw();
}

function recomputeLit() {
  s.lit = new Set();
  const center = s.focus ?? s.preview;
  if (center !== null && s.graph?.hasNode(center)) s.graph.forEachNeighbor(center, (n) => s.lit.add(n));
}

// ---------- camera ----------
// fitNeighbors: zoom so the node and its lit neighbours fit; fitSelf: zoom so `nodes` fit.
function centerOn(nodes, { fitNeighbors = false, fitSelf = false, duration = 550 } = {}) {
  if (!s.renderer || !nodes.length) return;
  const camera = s.renderer.getCamera();
  const { width, height } = s.renderer.getDimensions();
  const pts = nodes.map((n) => s.renderer.getNodeDisplayData(n)).filter(Boolean);
  if (!pts.length) return;
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const freeW = Math.max(120, width - s.insets.left - s.insets.right);
  const freeH = Math.max(120, height - s.insets.top - s.insets.bottom);
  let ratio = camera.ratio;
  if (fitNeighbors || fitSelf) {
    const extentPts = fitSelf ? pts : [...pts, ...[...s.lit].map((n) => s.renderer.getNodeDisplayData(n)).filter(Boolean)];
    const ex = Math.max(...extentPts.map((p) => Math.abs(p.x - cx))) * 2;
    const ey = Math.max(...extentPts.map((p) => Math.abs(p.y - cy))) * 2;
    const minDim = Math.min(width, height);
    ratio = Math.max(0.2, Math.min(fitSelf ? 3 : 1.1, Math.max((ex * minDim) / freeW, (ey * minDim) / freeH) * 1.08));
  }
  const probe = { x: cx, y: cy, ratio, angle: 0 };
  const freeX = s.insets.left + freeW / 2;
  const freeY = s.insets.top + freeH / 2;
  const at = s.renderer.viewportToFramedGraph({ x: freeX, y: freeY }, { cameraState: probe });
  camera.animate({ x: cx + (cx - at.x), y: cy + (cy - at.y), ratio, angle: 0 }, { duration, easing: "quadraticInOut" });
}

// ---------- renderer lifecycle ----------
function createRenderer() {
  s.renderer?.kill();
  s.renderer = null;
  s.fallback?.destroy();
  s.fallback = null;
  s.container.replaceChildren();
  if (!s.graph.order) {
    window.__explorerLayoutDone = true;
    return;
  }
  try {
    s.renderer = new Sigma(s.graph, s.container, {
      renderLabels: true,
      labelFont: '"IBM Plex Sans", system-ui, sans-serif',
      labelSize: 12,
      labelWeight: "500",
      labelColor: { color: "#e8eeeb" },
      labelDensity: 0.55,
      labelGridCellSize: 120,
      labelRenderedSizeThreshold: 7,
      defaultDrawNodeLabel: drawLabel,
      defaultDrawNodeHover: drawHover,
      defaultEdgeColor: EDGE,
      minEdgeThickness: 0.6,
      enableEdgeEvents: true,
      hideEdgesOnMove: false,
      zIndex: true,
      stagePadding: 48,
      minCameraRatio: 0.06,
      maxCameraRatio: 3,
      nodeReducer,
      edgeReducer,
      allowInvalidContainer: true,
    });
    wireEvents();
    window.__explorerLayout = "sigma";
  } catch (error) {
    console.warn("WebGL map failed, using canvas fallback", error);
    s.fallback = new Fallback(s.container, s.graph, {
      nodeReducer,
      edgeReducer,
      onNode: (node) => go(homeUrl({ node })),
      onEdge: (edge) => go(mapUrl(`/channel/${s.graph.getEdgeAttribute(edge, "scid")}`)),
    });
    window.__explorerLayout = "canvas";
  }
  window.__explorerLayoutDone = true;
}

function wireEvents() {
  const r = s.renderer;
  r.on("beforeRender", () => {
    frameLabels = [];
  });
  r.on("enterNode", ({ node }) => {
    s.hover = node;
    s.container.style.cursor = "pointer";
    showTipForNode(node);
    refresh();
  });
  r.on("leaveNode", () => {
    s.hover = null;
    s.container.style.cursor = "";
    hideTip();
    refresh();
  });
  r.on("enterEdge", ({ edge }) => {
    if (s.hover) return;
    s.hoverEdge = edge;
    s.container.style.cursor = "pointer";
    showTipForEdge(edge);
    refresh();
  });
  r.on("leaveEdge", () => {
    s.hoverEdge = null;
    if (!s.hover) {
      s.container.style.cursor = "";
      hideTip();
    }
    refresh();
  });
  r.on("clickNode", ({ node }) => {
    hideTip();
    go(homeUrl({ node }));
  });
  r.on("clickEdge", ({ edge }) => {
    hideTip();
    go(mapUrl(`/channel/${s.graph.getEdgeAttribute(edge, "scid")}`));
  });
  r.on("clickStage", () => {
    const route = currentRoute();
    const inspecting = (route.parts.length === 0 && route.params.get("node")) || route.parts[0] === "channel";
    if (inspecting) go(homeUrl());
  });
  r.getCamera().on("updated", hideTip);
}

async function load(query, signal) {
  setMapState(`<span class="pulse"></span><h1>Loading the network</h1><p>Selecting hubs that match your map settings.</p>`);
  let status = getStatus() || (await refreshStatus());
  if (signal.aborted) throw new DOMException("Map request superseded", "AbortError");
  while (!status || !status.ready) {
    setMapState(`<span class="pulse"></span><h1>Syncing the Lightning graph</h1><p>The explorer downloads a public rapid gossip sync snapshot on startup. The map appears by itself as soon as it is in.</p>`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (signal.aborted) throw new DOMException("Map request superseded", "AbortError");
    status = await refreshStatus();
    if (signal.aborted) throw new DOMException("Map request superseded", "AbortError");
  }
  const payload = await api(`/api/graph?${query}`, { signal });
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  if (signal.aborted) throw new DOMException("Map request superseded", "AbortError");
  s.payload = payload;
  s.byKey = new Map(payload.nodes.map((node) => [node.pubkey, node]));
  s.graph = buildGraph(payload);
  if (!s.graph.hasNode(s.focus)) s.focus = null;
  if (s.edge && !s.edge.every((node) => s.graph.hasNode(node))) s.edge = null;
  s.preview = null;
  s.hover = null;
  s.hoverEdge = null;
  hideTip();
  recomputeLit();
  createRenderer();
  const route = currentRoute();
  const resetUrl = mapUrl(route.parts[0] === "channel" ? route.path : "/", {
    node: route.params.get("node"),
    ...Object.fromEntries(GRAPH_FILTER_KEYS.map((key) => [key, null])),
  });
  setMapState(payload.nodes.length ? null : `<h1>No nodes match these filters</h1><p>Lower the minimum size or choose a different network.</p><a class="btn" href="${esc(resetUrl)}">Clear graph filters</a>`);
  refresh();
  centerOn(s.graph.nodes(), { fitSelf: true, duration: 0 });
  s.loadListeners.forEach((fn) => fn(payload));
  return payload;
}

// ---------- public API ----------
export const map = {
  mount(layer) {
    s.layer = layer;
    s.container = layer.querySelector("#map");
    s.tip = document.createElement("div");
    s.tip.className = "map-tip glass";
    s.tip.hidden = true;
    document.body.appendChild(s.tip);
  },

  /** Explicit URL parameters select a graph; omitting them retains the current selection. */
  ensure(params) {
    const key = params ? graphQuery(params).toString() : s.key || graphQuery().toString();
    if (key === s.key && s.loading) return s.loading;
    s.controller?.abort();
    const controller = new AbortController();
    s.controller = controller;
    s.key = key;
    s.loading = load(key, controller.signal).catch((error) => {
      if (controller.signal.aborted) throw error;
      s.key = "";
      s.loading = null;
      const retryUrl = location.pathname + location.search;
      setMapState(`<h1>The map could not load</h1><p>${esc(error.message)}</p><a class="btn" href="${esc(retryUrl)}" data-native>Try again</a>`);
      throw error;
    });
    return s.loading;
  },

  onLoad(fn) {
    s.loadListeners.add(fn);
    return () => s.loadListeners.delete(fn);
  },

  info() {
    return s.payload;
  },

  node(pubkey) {
    return s.byKey.get(pubkey) || null;
  },

  has(pubkey) {
    return Boolean(s.graph?.hasNode(pubkey));
  },

  /** Set the panel-covered margins. Returns true if a left panel was covering the map before. */
  setInsets(insets) {
    const wasLeft = s.insets.left > 0;
    s.insets = { left: 0, right: 0, top: 0, bottom: 0, ...insets };
    return wasLeft;
  },

  setDim(on) {
    document.body.dataset.dim = on ? "1" : "";
  },

  /** Select a node: highlight its neighbourhood and pan it into the free area. */
  focusNode(pubkey, { camera = true } = {}) {
    s.edge = null;
    s.preview = null;
    s.focus = s.graph?.hasNode(pubkey) ? pubkey : null;
    recomputeLit();
    refresh();
    if (s.focus && camera) centerOn([pubkey], { fitNeighbors: true });
    return s.focus !== null;
  },

  focusEdge(a, b, { camera = true } = {}) {
    s.focus = null;
    s.preview = null;
    const ok = Boolean(s.graph?.hasNode(a) && s.graph?.hasNode(b));
    s.edge = ok ? [a, b] : null;
    recomputeLit();
    refresh();
    if (ok && camera) centerOn([a, b]);
    return ok;
  },

  /** Temporary highlight (table hover). Does not move the camera. */
  preview(pubkey) {
    const next = pubkey && s.graph?.hasNode(pubkey) ? pubkey : null;
    if (next === s.preview) return;
    s.preview = next;
    recomputeLit();
    refresh();
  },

  reveal(pubkey) {
    if (s.graph?.hasNode(pubkey)) centerOn([pubkey], { duration: 400 });
  },

  /** Fit the whole network into the area not covered by panels (see setInsets). */
  frame() {
    if (s.graph) centerOn(s.graph.nodes(), { fitSelf: true, duration: 450 });
  },

  clear() {
    if (!selectionActive()) return;
    s.focus = null;
    s.edge = null;
    s.preview = null;
    recomputeLit();
    refresh();
  },

  zoomIn() {
    s.renderer?.getCamera().animatedZoom({ duration: 250 });
  },
  zoomOut() {
    s.renderer?.getCamera().animatedUnzoom({ duration: 250 });
  },
  fit() {
    s.renderer?.getCamera().animatedReset({ duration: 400 });
  },
};
