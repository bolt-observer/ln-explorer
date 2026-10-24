// History-API router: intercepts same-origin links and re-renders on navigation.
import { graphQuery, MAP_QUERY_KEYS } from "./graph-query.js";

let render = () => {};
let rememberedMapQuery = graphQuery();
const isMapPath = (path) => path === "/" || /^\/(channel|search)(\/|$)/.test(path);

function rememberMapQuery() {
  if (isMapPath(location.pathname)) rememberedMapQuery = graphQuery(new URLSearchParams(location.search));
}

export function currentRoute() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  return {
    path,
    parts: path.split("/").filter(Boolean),
    params: new URLSearchParams(location.search),
  };
}

export function go(url, { replace = false } = {}) {
  const current = location.pathname + location.search;
  if (current !== url) history[replace ? "replaceState" : "pushState"]({}, "", url);
  render();
}

/** Rewrite the current query string without re-rendering (view-local state such as filters). */
export function setQuery(params, { replace = true } = {}) {
  const qs = params.toString();
  const url = location.pathname + (qs ? `?${qs}` : "");
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  rememberMapQuery();
}

/** Map URLs retain graph selection without borrowing filters from the nodes table. */
export function mapUrl(path, extra = {}) {
  const route = currentRoute();
  const params = graphQuery(isMapPath(route.path) ? route.params : rememberedMapQuery);
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined || value === "") params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function homeUrl(extra = {}) {
  return mapUrl("/", extra);
}

export function startRouter(draw) {
  render = () => {
    rememberMapQuery();
    draw();
  };
  window.addEventListener("popstate", render);
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest("a[href]");
    if (!link || link.target || link.origin !== location.origin || link.hasAttribute("download")) return;
    if (link.pathname.startsWith("/api/") || link.dataset.native !== undefined) return;
    event.preventDefault();
    const params = new URLSearchParams(link.search);
    const explicitMapQuery = MAP_QUERY_KEYS.some((key) => params.has(key));
    go(isMapPath(link.pathname) && !explicitMapQuery
      ? mapUrl(link.pathname, Object.fromEntries(params))
      : link.pathname + link.search);
  });
  render();
}
