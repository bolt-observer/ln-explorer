// Table view of the map: the nodes the map currently shows (same filters and hub
// density, from the loaded /api/graph payload) as a sortable table. A row opens
// the same inspector a map click does. Styling reuses the /nodes table (.dtable).
import { btcHtml, esc, int, num, shortKey } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { currentRoute, go, homeUrl } from "../lib/router.js";
import { map } from "../map/map.js";

const SORT_KEY = "bolt.maptable.sort";
const NETWORK = { clearnet: "Clearnet", tor: "Tor", hybrid: "Hybrid" };
const dash = '<span class="sub">—</span>';

// Rank and alias read best ascending; sizes and fees descending.
const COLUMNS = [
  { id: "alias", head: "Node", dir: "asc", value: (n) => (n.alias || "").toLowerCase() },
  { id: "capacity", head: 'Capacity <small class="unit">BTC</small>', dir: "desc", cls: "nl-cap", value: (n) => n.capacity ?? null },
  { id: "channels", head: "Channels", dir: "desc", cls: "r mono", value: (n) => n.channels ?? null },
  { id: "betweenness_rank", head: "Centrality", title: "Betweenness rank; 1 is the most central node", dir: "asc", cls: "r mono", value: (n) => n.betweenness_rank ?? null },
  { id: "network", head: "Network", dir: "asc", cls: "r", value: (n) => n.network || null },
  { id: "med_out_ppm", head: 'Out fee <small class="unit">ppm</small>', title: "Median outgoing fee rate", dir: "desc", cls: "r mono", value: (n) => n.med_out_ppm ?? null },
];
const byId = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));

// Survives re-mounts (every navigation re-creates the chrome) so a row click
// does not lose the reader's place.
const view = { sort: "capacity", dir: "desc", scroll: 0 };
try {
  const saved = JSON.parse(localStorage.getItem(SORT_KEY) || "null");
  if (saved && byId[saved.sort] && ["asc", "desc"].includes(saved.dir)) Object.assign(view, saved);
} catch {
  // no saved sort
}

function sorted(nodes) {
  const col = byId[view.sort];
  const sign = view.dir === "asc" ? 1 : -1;
  return [...nodes].sort((a, b) => {
    const x = col.value(a);
    const y = col.value(b);
    // Missing values always sink to the bottom, whatever the direction.
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    if (x < y) return -sign;
    if (x > y) return sign;
    return (b.capacity || 0) - (a.capacity || 0);
  });
}

function cells(n, maxCap) {
  const pct = maxCap && n.capacity ? Math.max(1, (n.capacity / maxCap) * 100).toFixed(1) : 0;
  return [
    `<td class="nl-node"><span class="name"><b>${esc(n.alias || "Unnamed node")}</b><span>${esc(shortKey(n.pubkey))}</span></span></td>`,
    `<td class="nl-cap"><span class="capcell"><span class="bar"><i style="width:${pct}%"></i></span><span class="mono">${btcHtml(n.capacity, false)}</span></span></td>`,
    `<td class="r mono">${int(n.channels)}</td>`,
    `<td class="r mono">${n.betweenness_rank == null ? dash : `#${int(n.betweenness_rank)}`}</td>`,
    `<td class="r">${n.network ? `<span class="tag">${NETWORK[n.network] || esc(n.network)}</span>` : dash}</td>`,
    `<td class="r mono">${n.med_out_ppm == null ? dash : num(n.med_out_ppm, 0)}</td>`,
  ].join("");
}

/** Mount the table panel into `host`. Returns a cleanup function. */
export function mountMapTable(host) {
  const panel = document.createElement("section");
  panel.className = "maptable glass";
  panel.setAttribute("aria-label", "Nodes on the map");
  panel.innerHTML = `
    <header class="mt-head"><div><b>Nodes on the map</b><div class="sub mt-sub"></div></div>
      <a class="btn sm ghost" href="/nodes">All nodes ${icon("arrowR")}</a></header>
    <div class="mt-body"><table class="dtable nl-table mt-table"><thead></thead><tbody></tbody></table><div class="mt-empty sub" hidden></div></div>`;
  host.appendChild(panel);
  const body = panel.querySelector(".mt-body");
  const thead = panel.querySelector("thead");
  const tbody = panel.querySelector("tbody");
  const empty = panel.querySelector(".mt-empty");
  const sub = panel.querySelector(".mt-sub");

  const selected = () => (currentRoute().params.get("node") || "").toLowerCase();

  function head() {
    thead.innerHTML = `<tr>${COLUMNS.map((c) => {
      const active = c.id === view.sort;
      const aria = active ? ` aria-sort="${view.dir === "asc" ? "ascending" : "descending"}"` : "";
      const arrow = active ? icon("chevD", view.dir === "asc" ? "nl-up" : "") : "";
      const title = c.title ? ` title="${esc(c.title)}"` : "";
      return `<th scope="col" class="${c.cls || ""}"${aria}${title}><button type="button" data-sort="${c.id}">${c.head}${arrow}</button></th>`;
    }).join("")}</tr>`;
  }

  function paint() {
    head();
    const payload = map.info();
    if (!payload) {
      tbody.innerHTML = "";
      sub.textContent = "Loading the network…";
      empty.hidden = true;
      return;
    }
    const nodes = payload.nodes || [];
    sub.textContent = `${int(nodes.length)} shown of ${int(payload.matched_nodes)} matching · hubs with ≥ ${int(payload.min_channels)} channels`;
    empty.hidden = nodes.length > 0;
    empty.textContent = nodes.length ? "" : "No nodes match these filters.";
    const maxCap = Math.max(0, ...nodes.map((n) => n.capacity || 0));
    const sel = selected();
    tbody.innerHTML = sorted(nodes)
      .map((n) => `<tr class="rowlink${n.pubkey === sel ? " sel" : ""}" tabindex="0" data-pk="${esc(n.pubkey)}">${cells(n, maxCap)}</tr>`)
      .join("");
    body.scrollTop = view.scroll;
    const row = sel && tbody.querySelector("tr.sel");
    if (row) {
      const r = row.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      if (r.top < b.top + 36 || r.bottom > b.bottom) row.scrollIntoView({ block: "center" });
    }
  }

  const open = (row) => {
    view.scroll = body.scrollTop;
    go(homeUrl({ node: row.dataset.pk }));
  };
  panel.addEventListener("click", (event) => {
    const sortBtn = event.target.closest("[data-sort]");
    if (sortBtn) {
      const id = sortBtn.dataset.sort;
      if (view.sort === id) view.dir = view.dir === "asc" ? "desc" : "asc";
      else Object.assign(view, { sort: id, dir: byId[id].dir });
      view.scroll = 0;
      try {
        localStorage.setItem(SORT_KEY, JSON.stringify({ sort: view.sort, dir: view.dir }));
      } catch {
        // not remembered
      }
      paint();
      return;
    }
    const row = event.target.closest("tr[data-pk]");
    if (row) open(row);
  });
  panel.addEventListener("keydown", (event) => {
    const row = event.target.closest?.("tr[data-pk]");
    if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      open(row);
    }
  });
  // Hovering a row previews its neighbourhood on the dimmed map behind.
  panel.addEventListener("pointerover", (event) => map.preview(event.target.closest?.("tr[data-pk]")?.dataset.pk || null));
  panel.addEventListener("pointerleave", () => map.preview(null));
  body.addEventListener("scroll", () => (view.scroll = body.scrollTop), { passive: true });

  paint();
  const offLoad = map.onLoad(paint);
  return () => {
    offLoad();
    map.preview(null);
    panel.remove();
  };
}
