// Top bar, navigation state, status polling and the sync banner.
import { api } from "../lib/api.js";
import { esc, int, relTime } from "../lib/format.js";
import { icon, LOGO } from "../lib/icons.js";

const NAV = [
  ["map", "/", "Map", "map"],
  ["nodes", "/nodes", "Nodes", "list"],
  ["route", "/route", "Route", "route"],
  ["rankings", "/rankings", "Rankings", "trophy"],
  ["stats", "/stats", "Stats", "chart"],
];

let status = null;
const listeners = new Set();

export function getStatus() {
  return status;
}

export function onStatus(fn) {
  listeners.add(fn);
  if (status) fn(status);
  return () => listeners.delete(fn);
}

export function initChrome({ onSearch }) {
  const bar = document.getElementById("topbar");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  bar.innerHTML = `
    <a class="brand" href="/" aria-label="bolt.observer home">${LOGO}<span class="wordmark">bolt<span class="tld">.observer</span></span></a>
    <button type="button" class="search-trigger glass" id="search-open" aria-label="Search nodes, channels and keys" aria-keyshortcuts="${mac ? "Meta+K" : "Control+K"} /">
      ${icon("search")}<span class="ph">Search nodes, channels, keys</span><span class="kbd">${mac ? "⌘K" : "Ctrl K"}</span>
    </button>
    <nav class="nav glass" aria-label="Main">${NAV.filter(([id]) => id !== "map")
      .map(([id, href, label]) => `<a href="${href}" data-nav="${id}">${label}</a>`)
      .join("")}</nav>
    <details class="menu">
      <summary class="glass" aria-label="Menu">${icon("menu")}</summary>
      <nav class="glass" aria-label="Main">${NAV.map(([id, href, label, ico]) => `<a href="${href}" data-nav="${id}">${icon(ico)}${label}</a>`).join("")}</nav>
    </details>`;
  bar.querySelector("#search-open").addEventListener("click", () => onSearch());
  const menu = bar.querySelector(".menu");
  menu.addEventListener("click", (event) => {
    if (event.target.closest("a")) menu.open = false;
  });
  document.addEventListener("click", (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  refreshStatus();
  setInterval(refreshStatus, 60_000);
}

export function setNav(name) {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

// The banner is reserved for problems (API down, snapshot failing). Normal progress
// (syncing, ranks computing) lives in statusLine() and the map's own loading state.
let dismissed = "";

export async function refreshStatus() {
  const banner = document.getElementById("banner");
  try {
    status = await api("/api/status");
    if (!status.ready && status.last_error) showBanner(banner, "warn", `Waiting for graph data. Last error: ${status.last_error}`);
    else banner.hidden = true;
  } catch {
    showBanner(banner, "neg", "The explorer API is not reachable right now.");
  }
  listeners.forEach((fn) => status && fn(status));
  return status;
}

function showBanner(el, tone, text) {
  if (dismissed === text) return;
  el.hidden = false;
  el.className = "banner glass";
  el.innerHTML = `<span class="dot ${tone}"></span><span>${esc(text)}</span><button type="button" class="btn sm icon ghost" aria-label="Dismiss">${icon("x")}</button>`;
  el.querySelector("button").addEventListener("click", () => {
    dismissed = text;
    el.hidden = true;
  });
}

/** One-line status used in the map card and footer. */
export function statusLine(s = status) {
  if (!s) return "";
  const bits = [];
  if (!s.ready) bits.push("fetching the graph…");
  else if (s.updated_at) bits.push(`synced ${relTime(s.updated_at)}`);
  if (s.ready && !s.metrics_ready) bits.push("ranks computing");
  else if (s.source) bits.push(s.source === "rgs" ? "rapid gossip sync" : s.source);
  return bits.join(" · ");
}

export function siteFooter() {
  const s = status;
  return `<footer class="site-foot">
    <span>© bolt.observer ${new Date().getFullYear()}</span>
    <span>Data: <a href="https://github.com/lightningdevkit/rust-lightning/tree/main/lightning-rapid-gossip-sync" target="_blank" rel="noopener">LDK rapid gossip sync</a> · <a href="https://mempool.space" target="_blank" rel="noopener">mempool.space</a></span>
    <span>No cookies, no tracking</span>
    <span class="sp"></span>
    ${s && s.ready ? `<span class="mono">${int(s.nodes)} nodes · ${int(s.channels)} channels · ${esc(statusLine(s))}</span>` : ""}
    <a href="https://github.com/bolt-observer/ln-explorer" target="_blank" rel="noopener">Source on GitHub</a>
  </footer>`;
}
