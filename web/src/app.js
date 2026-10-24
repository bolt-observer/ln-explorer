// Entry point: shell, router and view lifecycle.
import { isAbort } from "./lib/api.js";
import { initCopy } from "./lib/copy.js";
import { esc } from "./lib/format.js";
import { icon } from "./lib/icons.js";
import { currentRoute, go, homeUrl, startRouter } from "./lib/router.js";
import { map } from "./map/map.js";
import { initChrome, setNav } from "./ui/chrome.js";
import { initPalette, isPaletteOpen, openPalette } from "./ui/palette.js";
import * as channelView from "./views/channel.js";
import * as homeView from "./views/home.js";
import * as nodeView from "./views/node.js";
import * as nodesView from "./views/nodes.js";
import * as rankingsView from "./views/rankings.js";
import * as searchView from "./views/search.js";
import * as statsView from "./views/stats.js";

const TITLE = "bolt.observer — Lightning Network explorer";

// mode "map": the view floats over the persistent map. mode "page": a scrolling document.
const ROUTES = {
  "": { view: homeView, nav: "map", mode: "map" },
  nodes: { view: nodesView, nav: "nodes", mode: "map" },
  rankings: { view: rankingsView, nav: "rankings", mode: "map" },
  stats: { view: statsView, nav: "stats", mode: "map" },
  search: { view: searchView, nav: "", mode: "map" },
  channel: { view: channelView, nav: "", mode: "map", id: true },
  node: { view: nodeView, nav: "", mode: "page", id: true },
};

const viewEl = document.getElementById("view");
let active = null;

function resolve(route) {
  const head = route.parts[0] || "";
  const def = ROUTES[head];
  if (!def || (def.id && !route.parts[1]) || (!def.id && route.parts.length > 1)) return null;
  return def;
}

function renderProblem(title, message) {
  viewEl.innerHTML = `<section class="center-card glass" role="alert">
    ${icon("alert")}<h1>${esc(title)}</h1><p>${esc(message)}</p>
    <a class="btn" href="/">${icon("map")}Back to the map</a></section>`;
}

async function draw() {
  if (active) {
    active.controller.abort();
    try {
      active.cleanup?.();
    } catch (error) {
      console.error(error);
    }
  }
  const controller = new AbortController();
  const current = { controller, cleanup: null };
  active = current;
  const route = currentRoute();
  const def = resolve(route);
  document.title = TITLE;
  viewEl.replaceChildren();
  document.body.dataset.mode = def ? def.mode : "map";
  document.body.dataset.dim = "";
  setNav(def ? def.nav : "");
  if (def?.mode === "page") window.scrollTo(0, 0);
  if (!def) {
    map.setInsets({ top: 72 });
    map.ensure().then(() => map.clear()).catch(() => {});
    renderProblem("Not found", "This page does not exist. The map is still here.");
    return;
  }
  const ctx = {
    route,
    el: viewEl,
    signal: controller.signal,
    alive: () => !controller.signal.aborted,
    setTitle: (text) => {
      if (!controller.signal.aborted) document.title = text ? `${text} · bolt.observer` : TITLE;
    },
  };
  try {
    const cleanup = await def.view.mount(ctx);
    if (controller.signal.aborted) cleanup?.();
    else current.cleanup = cleanup || null;
  } catch (error) {
    if (isAbort(error) || controller.signal.aborted) return;
    console.error(error);
    renderProblem("Something went wrong", error.message || String(error));
  }
}

map.mount(document.getElementById("map-layer"));
initChrome({ onSearch: () => openPalette() });
initPalette();
initCopy();

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || isPaletteOpen() || event.defaultPrevented) return;
  if (event.target.closest?.("input, textarea, select")) return;
  const route = currentRoute();
  if (document.body.dataset.mode !== "map") return;
  if (route.parts.length || route.params.get("node")) go(homeUrl());
});

startRouter(draw);
