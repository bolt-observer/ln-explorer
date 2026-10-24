// ⌘K / "/" search palette: nodes (alias or pubkey), channels (SCID), and jumps.
import { api } from "../lib/api.js";
import { btc, displayName, esc, int, shortKey } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { go, homeUrl, mapUrl, currentRoute } from "../lib/router.js";

const RECENT_KEY = "bolt.observer:recent";
const COMMANDS = [
  { label: "Map", href: "/", icon: "map" },
  { label: "All nodes", href: "/nodes", icon: "list" },
  { label: "Rankings", href: "/rankings", icon: "trophy" },
  { label: "Network stats", href: "/stats", icon: "chart" },
];
const SCID_RE = /^(\d+x\d+x\d+|\d{8,})$/;

let root;
let input;
let list;
let meta;
let items = [];
let active = 0;
let seq = 0;
let timer = null;
let lastFocus = null;
let query = "";

function recent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, 5);
  } catch {
    return [];
  }
}

function remember(item) {
  const entry = item.kind === "node"
    ? { kind: "node", pubkey: item.pubkey, alias: item.alias, capacity: item.capacity, channels: item.channels }
    : { kind: "channel", scid: item.scid, short_id: item.short_id, label: item.label, capacity: item.capacity };
  const id = (x) => x.pubkey || x.scid;
  const next = [entry, ...recent().filter((x) => id(x) !== id(entry))].slice(0, 5);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

function highlight(text, q) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}

function nodeItem(row) {
  return { kind: "node", pubkey: row.pubkey, alias: row.alias, capacity: row.total_capacity, channels: row.num_channels };
}

function channelItem(row) {
  return {
    kind: "channel",
    scid: row.scid,
    short_id: row.short_id,
    capacity: row.capacity,
    label: `${displayName(row.node1?.alias, row.node1?.pubkey)} ↔ ${displayName(row.node2?.alias, row.node2?.pubkey)}`,
  };
}

function render(state = "") {
  const groups = [];
  const nodes = items.filter((x) => x.kind === "node");
  const channels = items.filter((x) => x.kind === "channel");
  const cmds = items.filter((x) => x.kind === "cmd");
  let index = 0;
  const row = (item) => {
    const i = index++;
    const on = i === active ? " on" : "";
    const id = `palette-opt-${i}`;
    if (item.kind === "node") {
      return `<div class="res${on}" role="option" id="${id}" aria-selected="${i === active}" data-i="${i}">
        <span class="av"><i></i></span>
        <span class="ellipsis"><span class="nm">${highlight(displayName(item.alias, item.pubkey), query)}</span> <span class="pk">${esc(shortKey(item.pubkey))}</span></span>
        <span class="rt">${item.capacity ? `${btc(item.capacity)} BTC` : ""}<small>${item.channels != null ? `${int(item.channels)} channels` : ""}</small></span>
        <span class="kbd enter">↵</span></div>`;
    }
    if (item.kind === "channel") {
      return `<div class="res${on}" role="option" id="${id}" aria-selected="${i === active}" data-i="${i}">
        <span class="av">${icon("hash")}</span>
        <span class="ellipsis"><span class="nm">${esc(item.label)}</span> <span class="pk">${esc(item.short_id)}</span></span>
        <span class="rt">${item.capacity ? `${btc(item.capacity)} BTC` : ""}</span>
        <span class="kbd enter">↵</span></div>`;
    }
    return `<div class="go${on}" role="option" id="${id}" aria-selected="${i === active}" data-i="${i}"><span class="av">${icon(item.icon)}</span><span>${esc(item.label)}</span><span class="kbd enter">↵</span></div>`;
  };
  // Order in `items` matches render order: nodes, channels, commands.
  items = [...nodes, ...channels, ...cmds];
  const recentMode = !query && nodes.length + channels.length > 0;
  if (nodes.length) groups.push(`<div class="grp"><div class="lbl">${recentMode ? "Recent" : "Nodes"}</div>${nodes.map(row).join("")}</div>`);
  if (channels.length) groups.push(`<div class="grp"><div class="lbl">${recentMode && !nodes.length ? "Recent" : "Channels"}</div>${channels.map(row).join("")}</div>`);
  if (query && !nodes.length && !channels.length) {
    groups.push(`<div class="grp"><div class="hint">${state === "loading" ? '<span class="pulse sm"></span>Searching…' : `${icon("search")}No node or channel matches “${esc(query)}”.`}</div></div>`);
  }
  if (!query || (!SCID_RE.test(query) && query.length < 3)) {
    groups.push(`<div class="grp"><div class="hint">${icon("hash")}Paste a pubkey or a channel id like <span class="mono">811984x2037x0</span></div></div>`);
  }
  if (cmds.length) groups.push(`<div class="grp"><div class="lbl">Go to</div>${cmds.map(row).join("")}</div>`);
  list.innerHTML = groups.join("");
  input.setAttribute("aria-activedescendant", items.length ? `palette-opt-${active}` : "");
  list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

function commandsFor(q) {
  const needle = q.toLowerCase();
  return COMMANDS.filter((c) => !needle || c.label.toLowerCase().includes(needle)).map((c) => ({ kind: "cmd", ...c }));
}

async function search(q) {
  const mine = ++seq;
  query = q;
  active = 0;
  if (!q) {
    items = [...recent(), ...commandsFor("")];
    render();
    return;
  }
  items = commandsFor(q);
  render("loading");
  const isScid = SCID_RE.test(q);
  try {
    let nodes = [];
    let channels = [];
    if (q.length >= 2 && !isScid) {
      nodes = (await api(`/api/autocomplete?q=${encodeURIComponent(q)}&limit=8`)).map(nodeItem);
    }
    if (mine !== seq) return;
    if (isScid || (nodes.length < 3 && q.length >= 3)) {
      const found = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return;
      const seen = new Set(nodes.map((n) => n.pubkey));
      for (const row of found.nodes || []) {
        if (!seen.has(row.pubkey) && nodes.length < 8) nodes.push(nodeItem(row));
      }
      channels = (found.channels || []).map(channelItem);
    }
    items = [...nodes, ...channels, ...commandsFor(q)];
    render();
  } catch {
    if (mine === seq) render();
  }
}

function choose(item, { profile = false } = {}) {
  if (!item) return;
  if (item.kind === "node" || item.kind === "channel") remember(item);
  closePalette({ navigate: false });
  if (item.kind === "node") go(profile ? `/node/${item.pubkey}` : homeUrl({ node: item.pubkey }));
  else if (item.kind === "channel") go(mapUrl(`/channel/${item.scid}`));
  else go(item.href === "/" ? homeUrl() : item.href);
}

export function isPaletteOpen() {
  return Boolean(root && !root.hidden);
}

export function openPalette(q = "") {
  if (!root) return;
  lastFocus = document.activeElement;
  root.hidden = false;
  document.body.dataset.palette = "1";
  input.value = q;
  search(q.trim());
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

export function closePalette({ navigate = true } = {}) {
  if (!root || root.hidden) return;
  root.hidden = true;
  document.body.dataset.palette = "";
  clearTimeout(timer);
  seq += 1;
  // The /search route is the palette itself; closing it returns to the map.
  if (navigate && currentRoute().parts[0] === "search") go(homeUrl());
  else lastFocus?.focus?.();
}

export function initPalette() {
  root = document.createElement("div");
  root.className = "palette-root";
  root.hidden = true;
  root.innerHTML = `
    <div class="scrim" data-close></div>
    <div class="palette glass" role="dialog" aria-modal="true" aria-label="Search">
      <div class="palette-input">${icon("search")}
        <input type="text" placeholder="Search alias, pubkey or channel id" aria-label="Search alias, pubkey or channel id" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" />
        <button type="button" class="kbd" data-close aria-label="Close search">esc</button>
      </div>
      <div class="palette-list" id="palette-list" role="listbox" aria-label="Results"></div>
      <footer class="palette-foot">
        <span><span class="kbd">↑</span><span class="kbd">↓</span> navigate</span>
        <span><span class="kbd">↵</span> show on map</span>
        <span><span class="kbd">shift ↵</span> open profile</span>
        <span class="sp"></span><span id="palette-meta"></span>
      </footer>
    </div>`;
  document.body.appendChild(root);
  input = root.querySelector("input");
  list = root.querySelector(".palette-list");
  meta = root.querySelector("#palette-meta");

  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) closePalette();
    const opt = event.target.closest("[data-i]");
    if (opt) choose(items[Number(opt.dataset.i)], { profile: event.shiftKey });
  });
  list.addEventListener("mousemove", (event) => {
    const opt = event.target.closest("[data-i]");
    if (!opt || Number(opt.dataset.i) === active) return;
    active = Number(opt.dataset.i);
    list.querySelectorAll("[data-i]").forEach((el) => {
      const on = Number(el.dataset.i) === active;
      el.classList.toggle("on", on);
      el.setAttribute("aria-selected", String(on));
    });
  });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    timer = setTimeout(() => search(q), q ? 140 : 0);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      active = (active + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(items[active], { profile: event.shiftKey });
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  });

  document.addEventListener("keydown", (event) => {
    const typing = event.target.closest?.("input, textarea, select, [contenteditable]");
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (isPaletteOpen()) closePalette();
      else openPalette();
    } else if (event.key === "/" && !typing && !isPaletteOpen()) {
      event.preventDefault();
      openPalette();
    }
  });
}

export function setPaletteMeta(text) {
  if (meta) meta.textContent = text;
}
