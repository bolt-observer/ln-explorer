// "/" — the map. Query parameters retain the inspector, density, and graph filters.
import { int } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { go, homeUrl } from "../lib/router.js";
import { DENSITY_STEPS, map } from "../map/map.js";
import { getStatus, onStatus, statusLine } from "../ui/chrome.js";
import { mountGraphFilters } from "../ui/graph-filters.js";
import { mountNodeInspector } from "../ui/inspector.js";

const MOBILE = "(max-width: 720px)";

/** Map area covered by the inspector: right column on desktop, bottom sheet on phones. */
export function inspectorInsets() {
  if (window.matchMedia(MOBILE).matches) return { top: 64, bottom: Math.round(window.innerHeight * 0.62) };
  return { right: 368 + 40, top: 72 };
}

export function mapChrome(el, { inspector = false } = {}) {
  const card = document.createElement("section");
  card.className = "mapcard glass";
  if (window.matchMedia(MOBILE).matches) card.classList.add("collapsed");
  card.setAttribute("aria-label", "Network and map settings");
  el.appendChild(card);
  const zoom = document.createElement("div");
  zoom.className = "zoom glass";
  zoom.innerHTML = `
    <button type="button" class="btn icon" data-z="in" aria-label="Zoom in">${icon("plus")}</button>
    <button type="button" class="btn icon" data-z="out" aria-label="Zoom out">${icon("minus")}</button>
    <hr class="hr" />
    <button type="button" class="btn icon" data-z="fit" aria-label="Fit the whole network">${icon("fit")}</button>`;
  zoom.addEventListener("click", (event) => {
    const which = event.target.closest("[data-z]")?.dataset.z;
    if (which === "in") map.zoomIn();
    if (which === "out") map.zoomOut();
    if (which === "fit") map.fit();
  });
  el.appendChild(zoom);
  document.body.dataset.inspector = inspector ? "1" : "";

  const limit = Number(new URL(homeUrl(), location.origin).searchParams.get("limit")) || 400;
  const step = Math.max(0, DENSITY_STEPS.indexOf(DENSITY_STEPS.reduce((a, b) => (Math.abs(b - limit) < Math.abs(a - limit) ? b : a))));
  card.innerHTML = `
    <div class="head"><span class="dot idle"></span><b>Lightning Network</b>
      <button type="button" class="btn sm icon ghost toggle" aria-label="Expand network card" aria-expanded="false">${icon("chevD")}</button></div>
    <div class="sub when"></div>
    <div class="stats">
      <div><div class="lbl">Network nodes</div><div class="v" data-count="total">—</div></div>
      <div><div class="lbl">Matching</div><div class="v" data-count="matched">—</div></div>
      <div><div class="lbl">Shown</div><div class="v" data-count="shown">—</div></div>
    </div>
    <div class="map-channel-count sub"></div>
    <label class="density lbl" for="density"><span>Hub density</span><span class="mono" data-density-label></span></label>
    <input id="density" class="range" type="range" min="0" max="${DENSITY_STEPS.length - 1}" step="1" value="${step}" style="--p:${(step / (DENSITY_STEPS.length - 1)) * 100}%" aria-valuetext="${DENSITY_STEPS[step]} hubs" />
    <div class="map-cutoff sub"></div>
    <div class="legend"><span class="sz"><i style="width:4px;height:4px"></i><i style="width:7px;height:7px"></i><i style="width:11px;height:11px"></i></span>Size = capacity<span style="margin-left:auto">Lines = channels</span></div>
    <div class="foot"><span>Data: LDK rapid gossip sync · mempool.space</span><a href="https://github.com/bolt-observer/ln-explorer" target="_blank" rel="noopener">Source</a><span>No cookies</span></div>`;
  const cleanupFilters = mountGraphFilters(card);
  const range = card.querySelector("#density");
  const updateDensity = () => {
    const hubs = DENSITY_STEPS[Number(range.value)];
    range.style.setProperty("--p", `${(range.value / (DENSITY_STEPS.length - 1)) * 100}%`);
    range.setAttribute("aria-valuetext", `Up to ${hubs} hubs`);
    card.querySelector("[data-density-label]").textContent = `Up to ${int(hubs)} hubs`;
  };
  updateDensity();
  range.addEventListener("input", updateDensity);
  range.addEventListener("change", () => {
    const params = new URLSearchParams(location.search);
    // Include remembered map filters when these controls appear on a map sheet.
    const saved = new URL(homeUrl(), location.origin).searchParams;
    for (const [key, value] of saved) if (key !== "node") params.set(key, value);
    params.set("limit", String(DENSITY_STEPS[Number(range.value)]));
    go(`${location.pathname}?${params.toString()}`);
  });
  const toggle = card.querySelector(".toggle");
  const updateToggle = () => {
    const collapsed = card.classList.contains("collapsed");
    toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} network card`);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.innerHTML = icon(collapsed ? "chevD" : "minus");
  };
  updateToggle();
  toggle.addEventListener("click", () => {
    card.classList.toggle("collapsed");
    updateToggle();
  });
  // Update only live statistics, never controls: polling must not disturb a draft.
  const paint = () => {
    const s = getStatus();
    const payload = map.info();
    card.querySelector(".head .dot").classList.toggle("idle", !s?.ready);
    card.querySelector(".when").textContent = s ? statusLine(s) : "";
    card.querySelector('[data-count="total"]').textContent = payload ? int(payload.total_nodes) : s?.ready ? int(s.nodes) : "—";
    card.querySelector('[data-count="matched"]').textContent = payload ? int(payload.matched_nodes) : "—";
    card.querySelector('[data-count="shown"]').textContent = payload ? int(payload.shown_nodes) : "—";
    card.querySelector(".map-channel-count").textContent = s?.ready ? `${int(s.channels)} channels across the network` : "";
    card.querySelector(".map-cutoff").textContent = payload ? `Showing hubs with ≥ ${int(payload.min_channels)} channels` : "";
  };
  paint();
  const offStatus = onStatus(paint);
  const offLoad = map.onLoad(paint);
  return () => {
    offStatus();
    offLoad();
    cleanupFilters();
    document.body.dataset.inspector = "";
  };
}

export async function mount(ctx) {
  const { params } = ctx.route;
  const pubkey = (params.get("node") || "").toLowerCase();
  const inspecting = /^[0-9a-f]{66}$/.test(pubkey);

  const cleanupChrome = mapChrome(ctx.el, { inspector: inspecting });
  map.setDim(false);
  const wasCovered = map.setInsets(inspecting ? inspectorInsets() : { top: 72 });
  const loaded = map.ensure(ctx.route.params);

  if (inspecting) {
    const onMap = loaded.then(() => ctx.alive() && map.focusNode(pubkey)).catch(() => false);
    mountNodeInspector(ctx.el, pubkey, { signal: ctx.signal, onMap });
  } else {
    loaded
      .then(() => {
        if (!ctx.alive()) return;
        map.clear();
        if (wasCovered) map.frame();
      })
      .catch(() => {});
  }
  return cleanupChrome;
}
