import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";

const app = document.getElementById("app");
const banner = document.getElementById("sync-banner");
const footerMeta = document.getElementById("footer-meta");
const footerYear = document.getElementById("footer-year");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");

if (footerYear) footerYear.textContent = String(new Date().getFullYear());

let renderer = null;
let pollTimer = null;

function go(url) {
  if (location.pathname + location.search === url) {
    draw();
    return;
  }
  history.pushState({}, "", url);
  draw();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link || link.target || link.origin !== location.origin) return;
  if (link.hasAttribute("download")) return;
  event.preventDefault();
  go(link.pathname + link.search);
});

window.addEventListener("popstate", draw);
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = searchInput.value.trim();
  go(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
});

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `request failed (${response.status})`);
  }
  return response.json();
}

function sats(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return n === 0 ? "0" : "—";
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} BTC`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString();
}

function fullSats(value) {
  if (value === null || value === undefined) return "—";
  return `${Number(value).toLocaleString()} sats`;
}

function num(value, digits = 0) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function shortKey(pubkey) {
  if (!pubkey) return "";
  return `${pubkey.slice(0, 10)}…${pubkey.slice(-6)}`;
}

function when(ts) {
  if (!ts) return "—";
  const date = new Date(Number(ts) * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pubkeyChip(pubkey) {
  return `<button class="pubkey mono" type="button" data-copy="${esc(pubkey)}" title="Copy public key">${esc(shortKey(pubkey))}</button>`;
}

// --- Node autocomplete (reference inputs, path box, header search) ---------

function attachAutocomplete(input, onPick) {
  const host = input.parentElement;
  if (!host) return;
  host.classList.add("ac-host");
  const box = document.createElement("ul");
  const boxId = `ac-list-${Math.random().toString(36).slice(2, 8)}`;
  box.className = "ac-list";
  box.id = boxId;
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", "Node suggestions");
  box.hidden = true;
  host.appendChild(box);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", boxId);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("autocomplete", "off");
  let items = [];
  let active = -1;
  let timer = null;
  let seq = 0;

  const close = () => {
    box.hidden = true;
    active = -1;
    items = [];
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const render = () => {
    if (!items.length) {
      close();
      return;
    }
    box.innerHTML = items
      .map(
        (item, index) => `<li role="option" id="${boxId}-opt-${index}" class="ac-opt${index === active ? " active" : ""}" aria-selected="${index === active}" data-index="${index}"><span class="ac-alias">${esc(item.alias || "[no alias]")}</span><span class="hint mono">${esc(shortKey(item.pubkey))}</span><span class="hint">${num(item.num_channels)} ch</span></li>`
      )
      .join("");
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", `${boxId}-opt-${active}`);
    else input.removeAttribute("aria-activedescendant");
  };

  const pick = (index) => {
    const item = items[index];
    if (!item) return;
    input.value = item.pubkey;
    close();
    if (onPick) onPick(item);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if (text.length < 2) {
      seq += 1;
      close();
      return;
    }
    const mine = seq;
    timer = setTimeout(async () => {
      try {
        const rows = await api(`/api/autocomplete?q=${encodeURIComponent(text)}&limit=8`);
        if (mine !== seq) return;
        items = rows;
        active = -1;
        render();
      } catch (error) {
        if (mine !== seq) return;
        close();
      }
    }, 250);
  });

  input.addEventListener("keydown", (event) => {
    if (box.hidden || !items.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = (active + 1) % items.length;
      render();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = active <= 0 ? items.length - 1 : active - 1;
      render();
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      pick(active);
    } else if (event.key === "Escape") {
      close();
    }
  });

  box.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const option = event.target.closest("li.ac-opt");
    if (option) pick(Number(option.dataset.index));
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

// Enter in the header box still runs the full /search; picking a suggestion
// jumps straight to the node page.
attachAutocomplete(searchInput, (item) => go(`/node/${item.pubkey}`));

function destroyGraph() {
  if (renderer) {
    renderer.kill();
    renderer = null;
  }
}

function setNav(name) {
  document.querySelectorAll(".topbar nav a").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === name);
  });
}

async function refreshChrome() {
  try {
    const status = await api("/api/status");
    window.__explorerStatus = status;
    const bits = [];
    if (status.ready) {
      bits.push(`${status.nodes.toLocaleString()} nodes`);
      bits.push(`${status.channels.toLocaleString()} channels`);
    }
    if (status.updated_at) bits.push(`synced ${when(status.updated_at)}`);
    if (status.source) bits.push(status.source);
    footerMeta.textContent = bits.join(" · ");
    if (!status.ready) {
      banner.hidden = false;
      banner.textContent = status.last_error
        ? `Waiting for graph data. Last error: ${status.last_error}`
        : "Fetching the public Lightning graph. The map will appear as soon as the snapshot is in.";
    } else if (!status.metrics_ready) {
      banner.hidden = false;
      banner.textContent = "Graph is live. Centrality ranks are still being computed.";
    } else {
      banner.hidden = true;
    }
    return status;
  } catch (error) {
    banner.hidden = false;
    banner.textContent = "Explorer API is not reachable yet.";
    return null;
  }
}

function layoutRadial(nodes) {
  const ordered = [...nodes].sort((a, b) => b.channels - a.channels);
  ordered.forEach((node, index) => {
    if (index === 0) {
      node.x = 0;
      node.y = 0;
      return;
    }
    const ring = 1 + Math.floor(Math.log2(index + 1));
    let hash = 0;
    for (let i = 0; i < node.pubkey.length; i += 1) {
      hash = (hash * 33 + node.pubkey.charCodeAt(i)) >>> 0;
    }
    const angle = (hash / 0xffffffff) * Math.PI * 2 + ring * 0.35;
    const radius = 6 + ring * 9;
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
  });
}

function colorFor(node, maxChannels) {
  if (node.color && /^#[0-9a-fA-F]{6}$/.test(node.color)) return node.color;
  const t = Math.min(1, Math.sqrt(node.channels / Math.max(1, maxChannels)));
  if (t > 0.72) return "#FAD228";
  if (t > 0.28) return "#1DFEBB";
  return "#7ddec4";
}

function drawCanvas(payload) {
  const canvas = document.createElement("canvas");
  canvas.id = "fallback";
  const wrap = document.getElementById("sigma");
  wrap.replaceChildren(canvas);
  const paint = () => {
    const width = wrap.clientWidth || 800;
    const height = wrap.clientHeight || 640;
    canvas.width = width * devicePixelRatio;
    canvas.height = height * devicePixelRatio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    payload.nodes.forEach((node) => {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    });
    const scale = Math.min(width, height) / (Math.max(maxX - minX, maxY - minY) + 8);
    const cx = width / 2;
    const cy = height / 2;
    const project = (node) => ({
      x: cx + (node.x - (minX + maxX) / 2) * scale,
      y: cy + (node.y - (minY + maxY) / 2) * scale,
    });
    const pos = new Map(payload.nodes.map((node) => [node.pubkey, project(node)]));
    // Same capacity scaling as the sigma view: thick edges are big channels.
    const maxCapacity = Math.max(1, ...payload.edges.map((edge) => edge.capacity || 0));
    payload.edges.forEach((edge) => {
      const a = pos.get(edge.a);
      const b = pos.get(edge.b);
      if (!a || !b) return;
      const width =
        edge.capacity > 0 ? 0.4 + 2.2 * Math.sqrt(edge.capacity / maxCapacity) : 0.4;
      const share = Math.min(1, width / 2.6);
      ctx.strokeStyle = `rgba(29, 254, 187, ${(0.3 + 0.55 * share).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.5, width);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
    ctx.lineWidth = 1;
    const maxChannels = Math.max(...payload.nodes.map((node) => node.channels));
    payload.nodes.forEach((node) => {
      const point = pos.get(node.pubkey);
      ctx.fillStyle = colorFor(node, maxChannels);
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(2, node.size * 0.55), 0, Math.PI * 2);
      ctx.fill();
    });
  };
  paint();
  canvas.addEventListener("click", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // Hit testing uses the same projection as paint. Recompute quickly.
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    payload.nodes.forEach((node) => {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    });
    const scale = Math.min(width, height) / (Math.max(maxX - minX, maxY - minY) + 8);
    const cx = width / 2;
    const cy = height / 2;
    let best = null;
    let bestDist = 18;
    payload.nodes.forEach((node) => {
      const px = cx + (node.x - (minX + maxX) / 2) * scale;
      const py = cy + (node.y - (minY + maxY) / 2) * scale;
      const dist = Math.hypot(px - x, py - y);
      if (dist < bestDist) {
        best = node;
        bestDist = dist;
      }
    });
    if (best) go(`/node/${best.pubkey}`);
  });
}

async function renderGraph(root) {
  const params = new URLSearchParams(location.search);
  const min = params.get("min_channels") || "auto";
  const requested = Number(params.get("limit"));
  const limit = String(
    Math.min(800, Math.max(50, Number.isFinite(requested) && requested > 0 ? Math.round(requested) : 400))
  );
  root.innerHTML = `
    <div class="graph-layout">
      <div class="canvas-wrap">
        <div id="sigma"></div>
        <div class="graph-toolbar">
          <label>Min channels <input id="min-channels" type="number" min="1" value="${esc(min === "auto" ? "" : min)}" placeholder="auto" style="width:5rem"></label>
          <button type="button" id="apply-min">Apply</button>
          <button type="button" class="ghost" id="reset-cam">Reset view</button>
          <span class="hint" id="graph-count"></span>
        </div>
      </div>
      <aside class="card" id="graph-side"><p class="hint">Loading hubs…</p></aside>
    </div>`;
  document.getElementById("apply-min").onclick = () => {
    const value = document.getElementById("min-channels").value.trim();
    const next = new URLSearchParams();
    if (value) next.set("min_channels", value);
    next.set("limit", limit);
    go(`/?${next.toString()}`);
  };
  const payload = await api(`/api/graph?min_channels=${encodeURIComponent(min)}&limit=${encodeURIComponent(limit)}`);
  document.getElementById("graph-count").textContent =
    `${payload.shown_nodes.toLocaleString()} nodes · ${payload.shown_edges.toLocaleString()} edges`;
  layoutRadial(payload.nodes);
  const maxChannels = Math.max(1, ...payload.nodes.map((node) => node.channels));
  const labeled = new Set(
    [...payload.nodes]
      .sort((a, b) => b.channels - a.channels)
      .slice(0, 18)
      .map((node) => node.pubkey)
  );
  const container = document.getElementById("sigma");
  try {
    const graph = new Graph({ type: "undirected", multi: false });
    payload.nodes.forEach((node) => {
      graph.addNode(node.pubkey, {
        x: node.x,
        y: node.y,
        size: Math.max(4, node.size * 1.25),
        label: node.alias,
        color: colorFor(node, maxChannels),
        forceLabel: labeled.has(node.pubkey),
      });
    });
    const hubs = new Set(
      [...payload.nodes]
        .sort((a, b) => b.channels - a.channels)
        .slice(0, 40)
        .map((node) => node.pubkey)
    );
    // Edge width grows with capacity, like the original bokeh view.
    const maxCapacity = Math.max(1, ...payload.edges.map((edge) => edge.capacity || 0));
    payload.edges.forEach((edge) => {
      if (!graph.hasNode(edge.a) || !graph.hasNode(edge.b) || edge.a === edge.b) return;
      if (graph.hasEdge(edge.a, edge.b)) return;
      const bothHubs = hubs.has(edge.a) && hubs.has(edge.b);
      if (!bothHubs) {
        let hash = 0;
        const key = String(edge.scid);
        for (let i = 0; i < key.length; i += 1) hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
        if (hash % 4 !== 0) return;
      }
      const size =
        edge.capacity > 0 ? 0.4 + 2.2 * Math.sqrt(edge.capacity / maxCapacity) : 0.4;
      graph.addEdgeWithKey(edge.scid, edge.a, edge.b, {
        size,
        color: bothHubs ? "#1DFEBB" : "#14685a",
        scid: edge.scid,
      });
    });
    if (graph.order > 0 && graph.order <= 1400) {
      forceAtlas2.assign(graph, {
        iterations: graph.order > 900 ? 40 : 80,
        settings: {
          barnesHutOptimize: true,
          strongGravityMode: true,
          gravity: 0.8,
          scalingRatio: 10,
          slowDown: 3,
          outboundAttractionDistribution: true,
          linLogMode: true,
        },
      });
    }
    renderer = new Sigma(graph, container, {
      renderLabels: true,
      labelRenderedSizeThreshold: 5,
      labelSize: 16,
      labelWeight: "600",
      labelDensity: 1,
      labelColor: { color: "#ffffff" },
      defaultEdgeColor: "#1DFEBB",
      minEdgeThickness: 0.4,
      enableEdgeEvents: true,
      hideEdgesOnMove: true,
      allowInvalidContainer: true,
    });
    renderer.on("clickNode", ({ node }) => go(`/node/${node}`));
    renderer.on("clickEdge", ({ edge }) => {
      const scid = graph.getEdgeAttribute(edge, "scid");
      if (scid) go(`/channel/${scid}`);
    });
    document.getElementById("reset-cam").onclick = () => renderer.getCamera().animatedReset();
    window.__explorerLayout = "sigma";
  } catch (error) {
    console.warn("WebGL graph failed, using canvas", error);
    drawCanvas(payload);
    document.getElementById("reset-cam").onclick = () => {};
    window.__explorerLayout = "canvas";
  }
  window.__explorerLayoutDone = true;
  const side = document.getElementById("graph-side");
  const ranked = [...payload.nodes].sort((a, b) => b.channels - a.channels).slice(0, 12);
  side.innerHTML = `
    <h2>Largest nodes in view</h2>
    <p class="hint">Showing nodes with at least ${payload.min_channels} channels. Click a point or a name.</p>
    <ol class="side-list">
      ${ranked
        .map(
          (node) => `<li><a href="/node/${node.pubkey}">${esc(node.alias)}</a><span class="mono">${sats(node.capacity)}</span></li>`
        )
        .join("")}
    </ol>`;
}

const FILTER_FIELDS = [
  ["num_channels", "Channels"],
  ["total_capacity", "Total capacity (sats)"],
  ["med_out_ppm", "Median outgoing fee (ppm)"],
  ["avg_out_ppm", "Average outgoing fee (ppm)"],
  ["med_out_base", "Median base fee (msat)"],
  ["avg_capacity", "Average channel capacity"],
  ["betweenness_rank", "Betweenness rank"],
  ["closeness_rank", "Closeness rank"],
  ["closeness_weighted_rank", "Closeness rank (weighted)"],
  ["eigenvector_rank", "Eigenvector rank"],
  ["eigenvector_weighted_rank", "Eigenvector rank (weighted)"],
];

const FEATURE_FILTERS = [
  ["", "any"],
  ["wumbo", "wumbo"],
  ["anchors", "anchors"],
  ["dual_fund", "dual funding"],
  ["onion_messages", "onion messages"],
  ["route_blinding", "route blinding"],
];

function featureMiniBadges(node) {
  if (!node.features || !node.features.length) return "";
  const defs = [
    ["wumbo", "W", "wumbo (large channels)"],
    ["anchors", "A", "anchor channels"],
    ["dual_fund", "D", "dual funding"],
    ["onion_messages", "O", "onion messages"],
    ["route_blinding", "R", "route blinding"],
  ];
  return defs
    .filter(([key]) => node[key])
    .map(([key, letter, title]) => `<span class="tag feat-mini${key === "wumbo" ? " hl" : ""}" title="${title}">${letter}</span>`)
    .join("");
}

async function renderNodes(root) {
  const params = new URLSearchParams(location.search);
  root.innerHTML = `
    <section class="card filters">
      <h2>Node explorer</h2>
      <div class="filter-row">
        <label class="field">Alias or pubkey
          <input id="q" type="search" value="${esc(params.get("q") || "")}" />
        </label>
        <label class="field">Protocols
          <select id="protocol">
            <option value="">any</option>
            <option value="ipv4">ipv4</option>
            <option value="tor">tor</option>
            <option value="ipv6">ipv6</option>
          </select>
        </label>
        <label class="field">Features
          <select id="feature">${FEATURE_FILTERS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>
        </label>
        <label class="field">Match
          <select id="quantifier">
            <option value="all">all conditions</option>
            <option value="any">any condition</option>
            <option value="none">none of the conditions</option>
          </select>
        </label>
      </div>
      <div class="filter-row">
        <label class="field">Field
          <select id="field">${FILTER_FIELDS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>
        </label>
        <label class="field">Relation
          <select id="rel">
            <option value="gt">is greater than</option>
            <option value="lt">is less than</option>
            <option value="eq">equals</option>
          </select>
        </label>
        <label class="field">Value
          <input id="value" type="number" value="${esc(params.get("value") || "")}" />
        </label>
        <label class="field">Sort
          <select id="sort">
            <option value="total_capacity">capacity</option>
            <option value="num_channels">channels</option>
            <option value="med_out_ppm">fee rate</option>
            <option value="betweenness_rank">betweenness</option>
            <option value="closeness_rank">closeness</option>
            <option value="closeness_weighted_rank">closeness (weighted)</option>
            <option value="eigenvector_rank">eigenvector</option>
            <option value="alias">alias</option>
          </select>
        </label>
        <button class="btn" id="apply" type="button">Apply</button>
      </div>
      <p class="hint">Betweenness and closeness are sampled. Rank 1 is the most central node. Reference node limits the table to its reachable neighborhood.</p>
      <div class="filter-row">
        <label class="field">Reference node pubkey
          <input id="reference" type="text" value="${esc(params.get("reference") || "")}" placeholder="02… type an alias" style="min-width:22rem" />
        </label>
        <label class="field"><span>Reachable only</span>
          <input id="reachable" type="checkbox" ${params.get("reachable") === "1" ? "checked" : ""} />
        </label>
      </div>
    </section>
    <div id="node-table" class="card"><p class="hint">Loading nodes…</p></div>`;
  ["protocol", "quantifier", "field", "rel", "sort", "feature"].forEach((id) => {
    const value = params.get(id);
    if (value) document.getElementById(id).value = value;
  });
  attachAutocomplete(document.getElementById("reference"));
  document.getElementById("apply").onclick = () => {
    const next = new URLSearchParams();
    const q = document.getElementById("q").value.trim();
    if (q) next.set("q", q);
    const protocol = document.getElementById("protocol").value;
    if (protocol) next.set("protocol", protocol);
    const feature = document.getElementById("feature").value;
    if (feature) next.set("feature", feature);
    next.set("quantifier", document.getElementById("quantifier").value);
    const field = document.getElementById("field").value;
    const value = document.getElementById("value").value;
    if (value !== "") {
      next.set("field", field);
      next.set("rel", document.getElementById("rel").value);
      next.set("value", value);
      next.append("condition", `${field}|${document.getElementById("rel").value}|${value}`);
    }
    const sort = document.getElementById("sort").value;
    next.set("sort", sort);
    next.set("dir", sort.endsWith("_rank") || sort === "alias" ? "asc" : "desc");
    const reference = document.getElementById("reference").value.trim();
    if (reference) next.set("reference", reference);
    if (document.getElementById("reachable").checked) next.set("reachable", "1");
    go(`/nodes?${next.toString()}`);
  };
  await loadNodeTable(params);
}

async function loadNodeTable(params) {
  const query = new URLSearchParams(params);
  if (!query.get("sort")) query.set("sort", "total_capacity");
  if (!query.get("dir")) query.set("dir", "desc");
  if (!query.get("page")) query.set("page", "1");
  const data = await api(`/api/nodes?${query.toString()}`);
  const host = document.getElementById("node-table");
  if (!data.objects.length) {
    host.innerHTML = `<p class="empty">No nodes match this filter.</p>`;
    return;
  }
  host.innerHTML = `
    <table>
      <thead><tr>
        <th class="left">Alias</th><th class="left">Public key</th><th>Channels</th><th>Capacity</th>
        <th>Median fee ppm</th><th>Median base msat</th><th>Betweenness</th><th>Closeness</th><th>Eigenvector</th><th class="left">Clearnet</th><th class="left">Features</th>
      </tr></thead>
      <tbody>
        ${data.objects
          .map(
            (node) => `<tr>
            <td class="left"><a href="/node/${node.pubkey}">${esc(node.alias || "[no alias]")}</a></td>
            <td class="left">${pubkeyChip(node.pubkey)}</td>
            <td>${num(node.num_channels)}</td>
            <td>${sats(node.total_capacity)}</td>
            <td>${num(node.med_out_ppm, 1)}</td>
            <td>${num(node.med_out_base, 0)}</td>
            <td>${num(node.betweenness_rank)}</td>
            <td>${num(node.closeness_rank)}</td>
            <td>${num(node.eigenvector_rank)}</td>
            <td class="left">${node.ipv4 ? "v4 " : ""}${node.ipv6 ? "v6 " : ""}${node.tor ? "tor" : ""}</td>
            <td class="left">${featureMiniBadges(node)}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
    <div class="pager">
      <button class="btn ghost" type="button" id="prev" ${data.page <= 1 ? "disabled" : ""}>Previous</button>
      <span>Page ${data.page} of ${data.pages} · ${data.total_count.toLocaleString()} nodes</span>
      <button class="btn ghost" type="button" id="next" ${data.page >= data.pages ? "disabled" : ""}>Next</button>
    </div>`;
  const turn = (page) => {
    const next = new URLSearchParams(params);
    next.set("page", String(page));
    go(`/nodes?${next.toString()}`);
  };
  document.getElementById("prev").onclick = () => turn(data.page - 1);
  document.getElementById("next").onclick = () => turn(data.page + 1);
}

function protocols(node) {
  return [
    node.ipv4 ? `<span class="tag">ipv4</span>` : "",
    node.ipv6 ? `<span class="tag">ipv6</span>` : "",
    node.tor ? `<span class="tag">tor</span>` : "",
  ].join("");
}

function connectivityLabel(node) {
  const clearnet = node.ipv4 || node.ipv6;
  if (clearnet && node.tor) return "Clearnet and Tor";
  if (clearnet) return "Clearnet only";
  if (node.tor) return "Tor only";
  return "none announced";
}

function featureBadges(node) {
  // Nothing at all when this node's features are unknown.
  if (!node.features || !node.features.length) return "";
  return `<div class="feat-badges">${node.features
    .map(
      (feature) =>
        `<span class="feat${feature.name === "option_support_large_channel" ? " hl" : ""}" title="bit ${feature.bit}${feature.required ? " (required)" : " (optional)"}">${esc(feature.name)}${feature.required ? " *" : ""}</span>`
    )
    .join("")}</div>`;
}

function statRows(rows) {
  return `<table><tbody>${rows
    .map(([label, value]) => `<tr><td class="left">${label}</td><td>${value}</td></tr>`)
    .join("")}</tbody></table>`;
}

async function renderNode(root, pubkey) {
  root.innerHTML = `<p class="hint">Loading node…</p>`;
  const node = await api(`/api/nodes/${pubkey}`);
  const page = new URLSearchParams(location.search).get("page") || "1";
  const channels = await api(`/api/nodes/${pubkey}/channels?page=${page}&page_size=25`);
  const addresses = node.addresses.length
    ? `<ul class="side-list">${node.addresses
        .map((address) => `<li class="mono" style="justify-content:flex-start;overflow-wrap:anywhere">${esc(address)}</li>`)
        .join("")}</ul>`
    : `<p class="hint">No announced addresses yet.</p>`;
  root.innerHTML = `
    <div class="title-row">
      <span class="swatch" style="background:${esc(node.color || "#1DFEBB")}"></span>
      <h1>${esc(node.alias || "Unnamed node")}</h1>
      ${protocols(node)}
    </div>
    <p>${pubkeyChip(node.pubkey)} ${node.city || node.country ? `<span class="hint">${esc([node.city, node.country].filter(Boolean).join(", "))}</span>` : ""}</p>
    ${featureBadges(node)}
    <div class="stats-row" style="margin-top:0.6rem">
      <div class="card">
        <div class="stat-label">Channels</div>
        <div class="stat-value">${num(node.num_channels)}</div>
        <div class="hint">${num(node.active_channels)} routable</div>
      </div>
      <div class="card">
        <div class="stat-label">Total capacity</div>
        <div class="stat-value">${fullSats(node.total_capacity)}</div>
        <div class="hint">source: ${esc(node.capacity_source)}</div>
      </div>
      <div class="card">
        <div class="stat-label">Connectivity</div>
        <div class="stat-value" style="font-size:1.2rem">${esc(connectivityLabel(node))}</div>
        <div class="hint">first seen ${when(node.first_seen)}</div>
      </div>
    </div>
    <div class="two" style="margin-top:0.8rem">
      <section class="card">
        <h2>Addresses</h2>
        ${addresses}
      </section>
      <section class="card">
        <h2>Centrality</h2>
        <table>
          <thead><tr><th class="left">Metric</th><th>Rank</th><th>Weighted rank</th></tr></thead>
          <tbody>
            <tr><td class="left">Betweenness</td><td>${num(node.betweenness_rank)}</td><td>${num(node.betweenness_weighted_rank)}</td></tr>
            <tr><td class="left">Closeness</td><td>${num(node.closeness_rank)}</td><td>${num(node.closeness_weighted_rank)}</td></tr>
            <tr><td class="left">Eigenvector</td><td>${num(node.eigenvector_rank)}</td><td>${num(node.eigenvector_weighted_rank)}</td></tr>
          </tbody>
        </table>
        <p class="hint">Rank 1 is the most central node${node.metrics_ready ? ", sampled from this snapshot" : " (still being computed)"}. Weighted ranks prefer paths over high-capacity channels.</p>
      </section>
    </div>
    <div class="two" style="margin-top:0.8rem">
      <section class="card">
        <h2>Outgoing fee rate (ppm)</h2>
        ${statRows([
          ["Average", num(node.avg_out_ppm, 1)],
          ["Median", num(node.med_out_ppm, 1)],
          ["Maximum", num(node.max_out_ppm)],
        ])}
      </section>
      <section class="card">
        <h2>Incoming fee rate (ppm)</h2>
        ${statRows([
          ["Average", num(node.avg_in_ppm, 1)],
          ["Median", num(node.med_in_ppm, 1)],
        ])}
      </section>
    </div>
    <div class="two" style="margin-top:0.8rem">
      <section class="card">
        <h2>Outgoing base fee (msat)</h2>
        ${statRows([
          ["Average", num(node.avg_out_base)],
          ["Median", num(node.med_out_base)],
          ["Maximum", num(node.max_out_base)],
        ])}
      </section>
      <section class="card">
        <h2>Incoming base fee (msat)</h2>
        ${statRows([
          ["Average", num(node.avg_in_base)],
          ["Median", num(node.med_in_base)],
        ])}
      </section>
    </div>
    <section class="card" style="margin-top:0.8rem">
      <h2>Channel capacity (sats)</h2>
      ${statRows([
        ["Average", num(node.avg_capacity)],
        ["Median", num(node.med_capacity)],
        ["Maximum", num(node.max_capacity)],
      ])}
      <p class="hint">Averages of fee fields drop far-out outliers (Tukey fences); maxima stay raw.</p>
    </section>
    <form id="path-form" class="filter-row" style="margin:0.8rem 0">
      <label class="field">Shortest path from
        <input id="path-from" type="text" placeholder="source pubkey or alias" style="min-width:22rem" />
      </label>
      <button class="btn" type="submit">Find path</button>
      <span id="path-result" class="hint"></span>
    </form>
    <div class="card">
      <h2>Channels</h2>
      <table>
        <thead><tr><th class="left">Peer</th><th class="left">Short channel id</th><th>Capacity</th><th>Out ppm</th><th>In ppm</th><th>State</th></tr></thead>
        <tbody>
          ${channels.objects
            .map((channel) => {
              const outDisabled = channel.outgoing && channel.outgoing.disabled;
              const inDisabled = channel.incoming && channel.incoming.disabled;
              return `<tr>
                <td class="left"><a href="/node/${channel.peer_pubkey}">${esc(channel.peer_alias || shortKey(channel.peer_pubkey))}</a></td>
                <td class="left"><a class="mono" href="/channel/${channel.scid}">${esc(channel.short_id)}</a></td>
                <td>${sats(channel.capacity)}</td>
                <td>${channel.outgoing ? num(channel.outgoing.fee_rate_ppm) : "—"}</td>
                <td>${channel.incoming ? num(channel.incoming.fee_rate_ppm) : "—"}</td>
                <td>${outDisabled && inDisabled ? '<span class="tag off">disabled</span>' : '<span class="tag">open</span>'}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
      <div class="pager">
        <button class="btn ghost" id="prev" type="button" ${channels.page <= 1 ? "disabled" : ""}>Previous</button>
        <span>Page ${channels.page} of ${channels.pages}</span>
        <button class="btn ghost" id="next" type="button" ${channels.page >= channels.pages ? "disabled" : ""}>Next</button>
      </div>
    </div>
    <div class="card" id="node-history"><h2>History</h2><p class="hint">Loading events…</p></div>`;
  attachAutocomplete(document.getElementById("path-from"));
  document.getElementById("path-form").onsubmit = async (event) => {
    event.preventDefault();
    const source = document.getElementById("path-from").value.trim();
    const result = document.getElementById("path-result");
    try {
      const path = await api(`/api/path?source=${encodeURIComponent(source)}&target=${pubkey}`);
      if (path.hops === null) result.textContent = "No public path.";
      else {
        result.innerHTML = `${path.hops} hops: ${path.path
          .map((hop) => `<a href="/node/${hop.pubkey}">${esc(hop.alias || shortKey(hop.pubkey))}</a>`)
          .join(" → ")}`;
      }
    } catch (error) {
      result.textContent = error.message;
    }
  };
  document.getElementById("prev").onclick = () => go(`/node/${pubkey}?page=${channels.page - 1}`);
  document.getElementById("next").onclick = () => go(`/node/${pubkey}?page=${channels.page + 1}`);
  fillNodeHistory(pubkey);
}

function policyBlock(side) {
  const policy = side.policy;
  if (!policy) return `<p class="hint">No channel update announced.</p>`;
  return `<div class="policy">
    <div>${policy.disabled ? '<span class="tag off">disabled</span>' : '<span class="tag">enabled</span>'}</div>
    <div>Base fee ${num(policy.base_fee_msat)} msat</div>
    <div>Fee rate ${num(policy.fee_rate_ppm)} ppm</div>
    <div>CLTV delta ${num(policy.cltv_delta)}</div>
    <div>HTLC ${num(policy.min_htlc_msat)} – ${num(policy.max_htlc_msat)} msat</div>
  </div>`;
}

async function renderChannel(root, channelId) {
  root.innerHTML = `<p class="hint">Loading channel…</p>`;
  const channel = await api(`/api/channels/${encodeURIComponent(channelId)}`);
  root.innerHTML = `
    <div class="title-row"><h1 class="mono">${esc(channel.short_id)}</h1></div>
    <p class="hint">Channel id ${esc(channel.scid)} · capacity ${fullSats(channel.capacity)}</p>
    <div class="two">
      <article class="card">
        <h2><a href="/node/${channel.node1.pubkey}">${esc(channel.node1.alias || "Node 1")}</a></h2>
        <p>${pubkeyChip(channel.node1.pubkey)}</p>
        <h3>Policy towards the peer</h3>
        ${policyBlock(channel.node1)}
      </article>
      <article class="card">
        <h2><a href="/node/${channel.node2.pubkey}">${esc(channel.node2.alias || "Node 2")}</a></h2>
        <p>${pubkeyChip(channel.node2.pubkey)}</p>
        <h3>Policy towards the peer</h3>
        ${policyBlock(channel.node2)}
      </article>
    </div>`;
}

async function renderSearch(root) {
  const q = new URLSearchParams(location.search).get("q") || "";
  searchInput.value = q;
  root.innerHTML = `<h1>Search</h1><div id="results" class="card"><p class="hint">${q ? "Searching…" : "Type an alias, pubkey, or channel id."}</p></div>`;
  if (!q) return;
  const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const host = document.getElementById("results");
  if (!data.nodes.length && !data.channels.length) {
    host.innerHTML = `<p class="empty">Nothing matched “${esc(q)}”.</p>`;
    return;
  }
  host.innerHTML = `
    ${
      data.nodes.length
        ? `<h2>Nodes</h2><ul class="side-list">${data.nodes
            .map(
              (node) =>
                `<li><a href="/node/${node.pubkey}">${esc(node.alias || shortKey(node.pubkey))}</a><span>${num(node.num_channels)} ch · ${sats(node.total_capacity)}</span></li>`
            )
            .join("")}</ul>`
        : ""
    }
    ${
      data.channels.length
        ? `<h2>Channels</h2><ul class="side-list">${data.channels
            .map(
              (channel) =>
                `<li><a class="mono" href="/channel/${channel.scid}">${esc(channel.short_id)}</a><span>${sats(channel.capacity)}</span></li>`
            )
            .join("")}</ul>`
        : ""
    }`;
}

const PANEL_HEIGHT = 112;
const PANEL_GAP = 14;
const AXIS_HEIGHT = 24;
const HISTORY_GAP_SECONDS = 10 * 86400;
const CAP_COLORS = { capacity: "#1DFEBB", channels: "#FAD228", nodes: "#ffffff" };

function drawHistory(payload, opts = {}) {
  const canvas = document.getElementById("history");
  if (!canvas) return;
  const points = (payload && payload.points) || [];
  const currency = opts.currency === "usd" ? "usd" : "btc";
  const width = canvas.clientWidth || 900;
  const padLeft = 60;
  const padRight = 14;
  const padTop = 16;
  const height = padTop + 3 * PANEL_HEIGHT + 2 * PANEL_GAP + AXIS_HEIGHT + 6;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!points.length) {
    ctx.fillStyle = "#9aa39c";
    ctx.font = "13px sans-serif";
    ctx.fillText("No history yet. The first refresh records a snapshot.", padLeft, height / 2);
    return;
  }
  // The two sources are never joined: mempool's totals and our own gossip
  // snapshots count different things, so local runs as a dashed series.
  const mempool = points.filter((point) => point.source !== "local");
  const local = points.filter((point) => point.source === "local");
  const tMin = Math.min(...points.map((point) => point.ts));
  const tMax = Math.max(...points.map((point) => point.ts));
  const span = Math.max(1, tMax - tMin);
  const plotWidth = width - padLeft - padRight;
  const x = (ts) => padLeft + ((ts - tMin) / span) * plotWidth;

  ctx.strokeStyle = "#2c2c2c";
  ctx.fillStyle = "#9aa39c";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  const firstYear = Math.max(2018, new Date(tMin * 1000).getUTCFullYear());
  const lastYear = new Date(tMax * 1000).getUTCFullYear();
  for (let year = firstYear; year <= lastYear; year += 1) {
    const ts = Date.UTC(year, 0, 1) / 1000;
    if (ts < tMin || ts > tMax) continue;
    const px = x(ts);
    ctx.beginPath();
    ctx.moveTo(px, padTop - 4);
    ctx.lineTo(px, height - AXIS_HEIGHT);
    ctx.stroke();
    ctx.fillText(String(year), px, height - 8);
  }
  ctx.textAlign = "left";

  const capacityValue = (point) => {
    if (currency === "usd") return point.capacity_usd == null ? null : point.capacity_usd;
    return point.total_capacity == null ? null : point.total_capacity / 1e8;
  };
  const panels = [
    {
      label: currency === "usd" ? "Capacity (USD)" : "Capacity (BTC)",
      color: CAP_COLORS.capacity,
      value: capacityValue,
      format: (v) => (currency === "usd" ? `$${num(v, 0)}` : `${num(v, 0)} BTC`),
    },
    { label: "Channels", color: CAP_COLORS.channels, value: (p) => p.channel_count, format: (v) => num(v, 0) },
    { label: "Nodes", color: CAP_COLORS.nodes, value: (p) => p.node_count, format: (v) => num(v, 0) },
  ];

  panels.forEach((panel, index) => {
    const top = padTop + index * (PANEL_HEIGHT + PANEL_GAP);
    const series = [
      { points: mempool, dash: [] },
      { points: local, dash: [5, 4] },
    ].map((entry) => ({
      ...entry,
      points: entry.points.filter((point) => {
        const value = panel.value(point);
        return value != null && Number.isFinite(Number(value)) && Number(value) >= 0;
      }),
    }));
    const values = series.flatMap((entry) => entry.points.map((point) => Number(panel.value(point))));
    let lo = values.length ? Math.min(...values) : 0;
    let hi = values.length ? Math.max(...values) : 1;
    if (hi === lo) hi = lo + 1;
    const y = (value) => top + PANEL_HEIGHT - 6 - ((value - lo) / (hi - lo)) * (PANEL_HEIGHT - 16);
    ctx.strokeStyle = "#2c2c2c";
    ctx.strokeRect(padLeft, top, plotWidth, PANEL_HEIGHT);
    ctx.fillStyle = panel.color;
    ctx.font = "11px sans-serif";
    ctx.fillText(panel.label, padLeft + 6, top + 14);
    ctx.fillStyle = "#9aa39c";
    ctx.textAlign = "right";
    if (values.length) {
      ctx.fillText(panel.format(hi), width - padRight - 4, top + 14);
      ctx.fillText(panel.format(lo), width - padRight - 4, top + PANEL_HEIGHT - 4);
    } else {
      ctx.fillText("no data", width - padRight - 4, top + 14);
    }
    ctx.textAlign = "left";
    for (const entry of series) {
      if (!entry.points.length) continue;
      ctx.strokeStyle = panel.color;
      ctx.lineWidth = 1.8;
      ctx.setLineDash(entry.dash);
      ctx.beginPath();
      let previousTs = null;
      entry.points.forEach((point) => {
        const px = x(point.ts);
        const py = y(Number(panel.value(point)));
        // mempool's backends have gaps of weeks; do not draw across them.
        if (previousTs === null || point.ts - previousTs > HISTORY_GAP_SECONDS) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        previousTs = point.ts;
      });
      ctx.stroke();
      ctx.setLineDash([]);
      if (entry.points.length === 1) {
        // A lone snapshot has no line yet; mark the point itself.
        const point = entry.points[0];
        ctx.fillStyle = panel.color;
        ctx.beginPath();
        ctx.arc(x(point.ts), y(Number(panel.value(point))), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.lineWidth = 1;
  });
}

function historyNote(history) {
  return history.notes || "";
}

// --- Change events, flows, and rankings ------------------------------------

const EVENT_KIND_LABELS = {
  channel_open: "opened",
  channel_reappeared: "re-announced",
  channel_close: "closed or pruned",
  policy_fee: "fee change",
  alias: "alias",
  color: "color",
  addresses: "addresses",
};

const CHANNEL_EVENT_KINDS = new Set(["channel_open", "channel_reappeared", "channel_close"]);

function eventRow(event) {
  const label = EVENT_KIND_LABELS[event.kind] || event.kind;
  const tone = event.kind === "channel_close" ? "close" : CHANNEL_EVENT_KINDS.has(event.kind) ? "open" : "info";
  const who = event.pubkey
    ? `<a href="/node/${event.pubkey}">${esc(event.pubkey_alias || shortKey(event.pubkey))}</a>`
    : "<span class=\"hint\">network</span>";
  const peer = event.peer
    ? ` <span class="hint">↔</span> <a href="/node/${event.peer}">${esc(event.peer_alias || shortKey(event.peer))}</a>`
    : "";
  let detail = "";
  if (event.kind === "policy_fee") {
    detail = `${esc(event.field)}: ${num(event.old)} → ${num(event.new)}${event.field === "ppm" ? " ppm" : " msat"}`;
  } else if (CHANNEL_EVENT_KINDS.has(event.kind)) {
    detail = sats(event.capacity);
  } else {
    detail = `${esc(event.old)} → ${esc(event.new)}`;
  }
  const channel = event.scid
    ? `<a class="mono" href="/channel/${event.scid}">${esc(event.short_id)}</a>`
    : "";
  return `<li><span class="ev-kind ${tone}">${label}</span><span class="ev-body">${who}${peer} <span class="hint">${detail}</span> ${channel}</span><span class="hint">${when(event.ts)}</span></li>`;
}

function drawFlows(flows) {
  const canvas = document.getElementById("flows");
  if (!canvas) return;
  const opens = new Map((flows.series.channel_open || []).map((point) => [point.day, point.count]));
  const closes = new Map((flows.series.channel_close || []).map((point) => [point.day, point.count]));
  const today = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const start = today - 89 * 86400;
  const days = [];
  for (let day = start; day <= today; day += 86400) days.push(day);
  const width = canvas.clientWidth || 900;
  const height = 240;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const padLeft = 52;
  const padRight = 8;
  const plotWidth = width - padLeft - padRight;
  const zero = Math.floor(height / 2);
  const maxCount = Math.max(1, ...days.map((day) => Math.max(opens.get(day) || 0, closes.get(day) || 0)));
  const half = Math.max(24, zero - 26);
  const scale = (count) => (count / maxCount) * half;
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#9aa39c";
  ctx.strokeStyle = "#2c2c2c";
  ctx.textAlign = "right";
  ctx.fillText(num(maxCount, 0), padLeft - 6, 30);
  ctx.fillText("0", padLeft - 6, zero + 4);
  ctx.fillText(num(maxCount, 0), padLeft - 6, height - 14);
  ctx.beginPath();
  ctx.moveTo(padLeft, zero);
  ctx.lineTo(width - padRight, zero);
  ctx.stroke();
  const barWidth = Math.max(1, plotWidth / days.length - 1);
  days.forEach((day, index) => {
    const x = padLeft + (index / days.length) * plotWidth;
    const openCount = opens.get(day) || 0;
    const closeCount = closes.get(day) || 0;
    if (openCount) {
      ctx.fillStyle = "#1DFEBB";
      ctx.fillRect(x, zero - scale(openCount), barWidth, scale(openCount));
    }
    if (closeCount) {
      ctx.fillStyle = "#FAD228";
      ctx.fillRect(x, zero + 1, barWidth, scale(closeCount));
    }
  });
  ctx.fillStyle = "#9aa39c";
  ctx.textAlign = "left";
  ctx.fillText("opens ↑", padLeft + 4, 30);
  ctx.fillText("closes ↓", padLeft + 4, height - 14);
  ctx.textAlign = "center";
  days.forEach((day, index) => {
    const date = new Date(day * 1000);
    if (date.getUTCDate() <= 3 || index === 0) {
      const x = padLeft + (index / days.length) * plotWidth;
      if (x < padLeft + 14 || x > width - padRight - 22) return;
      ctx.fillText(date.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }), x, height - 2);
    }
  });
}

function closeTypesBlock(flows) {
  const reasons = flows.close_reasons || {};
  const rows = Object.entries(flows.close_types || {})
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `<li><span>${esc(reasons[key] || key)}</span><span>${num(count)}</span></li>`);
  if (!rows.length) return `<p class="hint">No closes recorded in this window yet.</p>`;
  return `<ul class="side-list">${rows.join("")}</ul>`;
}

function sparkline(values, width = 64, height = 18) {
  const points = (values || []).filter((value) => Number.isFinite(Number(value)));
  if (points.length < 2) {
    return `<svg class="spark" width="${width}" height="${height}" aria-hidden="true"></svg>`;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const pad = 2;
  const x = (i) => pad + (i / (points.length - 1)) * (width - 2 * pad);
  const y = (v) => (max === min ? height / 2 : pad + ((v - min) / (max - min)) * (height - 2 * pad));
  const path = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  // A rank that fell (better rank) is drawn in mint.
  const improved = points[points.length - 1] <= points[0];
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline points="${path}" fill="none" stroke="${improved ? "#1DFEBB" : "#FAD228"}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function changeCell(value) {
  if (value === null || value === undefined) return `<td class="chg new">new</td>`;
  if (value === 0) return `<td class="chg">·</td>`;
  const up = value > 0;
  return `<td class="chg ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(value).toLocaleString()}</td>`;
}

const RANK_METRIC_LABELS = {
  total_capacity: "Capacity",
  num_channels: "Channels",
  betweenness: "Betweenness",
  betweenness_weighted: "Betweenness (w)",
  closeness: "Closeness",
  closeness_weighted: "Closeness (w)",
  eigenvector: "Eigenvector",
  eigenvector_weighted: "Eigenvector (w)",
};

function dayLabel(day) {
  if (!day) return "";
  return new Date(Number(day) * 1000).toISOString().slice(0, 10);
}

function moversList(rows) {
  if (!rows || !rows.length) return `<p class="hint">Not enough stored days yet.</p>`;
  return `<ol class="side-list">${rows
    .map(
      (row) =>
        `<li><a href="/node/${row.pubkey}">${esc(row.alias || shortKey(row.pubkey))}</a><span class="chg ${row.change > 0 ? "up" : "down"}">${row.change > 0 ? "▲" : "▼"} ${Math.abs(row.change)} · #${num(row.rank)}</span></li>`
    )
    .join("")}</ol>`;
}

async function renderRankings(root) {
  const params = new URLSearchParams(location.search);
  const requested = params.get("metric") || "total_capacity";
  root.innerHTML = `<p class="hint">Loading rankings…</p>`;
  const [payload, movers] = await Promise.all([
    api(`/api/rankings?metric=${encodeURIComponent(requested)}&limit=100`),
    api(`/api/rankings/movers?metric=${encodeURIComponent(requested)}&days=7&limit=10`).catch(() => null),
  ]);
  const metric = payload.metrics.includes(requested) ? requested : "total_capacity";
  const tabs = payload.metrics
    .map(
      (name) =>
        `<button type="button" data-metric="${name}" class="${name === metric ? "active" : ""}">${esc(RANK_METRIC_LABELS[name] || name)}</button>`
    )
    .join("");
  const formatValue = (value) =>
    metric === "total_capacity" ? sats(value) : num(value, metric === "num_channels" ? 0 : 3);
  const isCentrality = metric !== "total_capacity" && metric !== "num_channels";
  const emptyRow = `<tr><td colspan="7" class="hint">${
    isCentrality ? "Centrality ranks are still being computed." : "No nodes yet."
  }</td></tr>`;
  const rows = payload.objects.length
    ? payload.objects
        .map(
          (entry) => `<tr>
        <td>${num(entry.rank)}</td>
        <td class="left"><a href="/node/${entry.pubkey}">${esc(entry.alias || shortKey(entry.pubkey))}</a></td>
        <td>${formatValue(entry.value)}</td>
        ${changeCell(entry.rank_change_1d)}
        ${changeCell(entry.rank_change_7d)}
        ${changeCell(entry.rank_change_30d)}
        <td>${sparkline(entry.history)}</td>
      </tr>`
        )
        .join("")
    : emptyRow;
  const range = payload.days && payload.days.first
    ? `stored days: ${dayLabel(payload.days.first)} – ${dayLabel(payload.days.last)}`
    : "no stored days yet";
  root.innerHTML = `
    <div class="title-row"><h1>Rankings</h1></div>
    <p class="hint">The live top list per metric. Change columns compare against the daily snapshot of ranks (positive = climbed); “new” means the node was outside the stored top that day. ${esc(range)}.</p>
    <div class="seg rank-tabs" role="group" aria-label="Metric">${tabs}</div>
    <div class="card"><table>
      <thead><tr><th>Rank</th><th class="left">Node</th><th>Value</th><th>1d</th><th>7d</th><th>30d</th><th>90 days</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="two">
      <section class="card"><h2>Climbers (7 days)</h2>${moversList(movers && movers.climbers)}</section>
      <section class="card"><h2>Fallers (7 days)</h2>${moversList(movers && movers.fallers)}</section>
    </div>`;
  root.querySelectorAll("[data-metric]").forEach((button) => {
    button.onclick = () => go(`/rankings?metric=${button.dataset.metric}`);
  });
}

async function fillNodeHistory(pubkey) {
  const host = document.getElementById("node-history");
  if (!host) return;
  try {
    const [events, ranks] = await Promise.all([
      api(`/api/nodes/${pubkey}/events?limit=100`),
      api(`/api/nodes/${pubkey}/ranks?days=90`),
    ]);
    const list = events.events.length
      ? `<ul class="event-list">${events.events.slice(0, 30).map(eventRow).join("")}</ul>`
      : `<p class="hint">No recorded events yet. Opens, closes, fee changes, and alias or address changes appear here after the first snapshot diff.</p>`;
    const sparkMetrics = Object.entries(ranks.series || {}).filter(([, points]) => points.length > 1);
    const sparks = sparkMetrics.length
      ? `<div class="rank-sparks">${sparkMetrics
          .map(
            ([metric, points]) =>
              `<div class="rank-spark"><span class="hint">${esc(RANK_METRIC_LABELS[metric] || metric)}</span>${sparkline(
                points.map((point) => point.rank)
              )}<span class="hint">#${num(points[points.length - 1].rank)}</span></div>`
          )
          .join("")}</div>`
      : "";
    host.innerHTML = `<h2>History</h2>${list}${sparks}`;
  } catch (error) {
    host.innerHTML = `<h2>History</h2><p class="hint">${esc(error.message)}</p>`;
  }
}

function btcPriceText(rates) {
  if (!rates || !rates.USD) return "—";
  const parts = [`$${num(rates.USD, 0)}`];
  if (rates.EUR) parts.push(`€${num(rates.EUR, 0)}`);
  return parts.join(" / ");
}

function feeTableRow(label, series) {
  const cell = (value, digits = 1) => `<td>${num(value, digits)}</td>`;
  return `<tr><td class="left">${label}</td>${cell(series.median)}${cell(series.mean_filtered)}${cell(
    series.mean_capweighted
  )}${cell(series.p90)}${cell(series.std)}${cell(series.min, 0)}${cell(series.max, 0)}${cell(series.mean)}</tr>`;
}

async function renderStats(root) {
  root.innerHTML = `<p class="hint">Loading statistics…</p>`;
  const params = new URLSearchParams(location.search);
  const range = ["1y", "3y", "all"].includes(params.get("range")) ? params.get("range") : "all";
  const currency = params.get("cap") === "usd" ? "usd" : "btc";
  const [stats, history, flows, recent] = await Promise.all([
    api("/api/stats"),
    api(`/api/history?range=${range}`),
    api("/api/flows?days=90").catch(() => null),
    api("/api/events?limit=60").catch(() => ({ events: [] })),
  ]);
  const reported = stats.reported || {};
  const latestNet = stats.network_latest || {};
  const fees = stats.fees || {};
  const feeRate = fees.rate || {};
  const feeBase = fees.base || {};
  root.innerHTML = `
    <div class="stats-row">
      <div class="card"><div class="stat-label">Gossip nodes</div><div class="stat-value">${num(stats.gossip_nodes)}</div></div>
      <div class="card"><div class="stat-label">Gossip channels</div><div class="stat-value">${num(stats.gossip_channels)}</div></div>
      <div class="card"><div class="stat-label">Network capacity (mempool.space${latestNet.ts ? `, ${new Date(latestNet.ts * 1000).toISOString().slice(0, 10)}` : ""})</div><div class="stat-value">${sats(latestNet.total_capacity || reported.total_capacity || stats.gossip_capacity)}</div></div>
      <div class="card"><div class="stat-label">Median fee</div><div class="stat-value">${num(stats.median_fee_rate_ppm, 0)} ppm</div></div>
      <div class="card"><div class="stat-label">BTC price</div><div class="stat-value">${esc(btcPriceText(history.currency_rates))}</div></div>
    </div>
    <section class="card" style="margin-bottom:0.8rem">
      <div class="chart-head">
        <h2>Network history 2018–now</h2>
        <div class="chart-tools">
          <div class="seg" role="group" aria-label="Capacity unit">${[
            ["btc", "BTC"],
            ["usd", "USD"],
          ]
            .map(([value, label]) => `<button type="button" data-cap="${value}" class="${currency === value ? "active" : ""}">${label}</button>`)
            .join("")}</div>
          <div class="seg" role="group" aria-label="Time range">${[
            ["1y", "1y"],
            ["3y", "3y"],
            ["all", "all"],
          ]
            .map(([value, label]) => `<button type="button" data-range="${value}" class="${range === value ? "active" : ""}">${label}</button>`)
            .join("")}</div>
        </div>
      </div>
      <p class="hint">Solid lines are mempool.space statistics${
        history.external_until
          ? `, which stop on ${new Date(history.external_until * 1000).toISOString().slice(0, 10)}`
          : ""
      }. Dashed lines continue with this explorer's own rapid-gossip-sync snapshots (about 5.1k nodes / 26.7k channels, capacity only partially known), which are not directly comparable with mempool's totals (16k nodes including unannounced and channel-less, 32.5k channels).</p>
      <canvas class="chart" id="history"></canvas>
      <p class="chart-legend hint"><span class="legend-line solid"></span> mempool.space&nbsp;&nbsp;<span class="legend-line dashed"></span> this explorer (rapid gossip sync snapshot)</p>
      <p class="hint">${esc(historyNote(history))}</p>
    </section>
    ${
      flows
        ? `<section class="card" style="margin-bottom:0.8rem">
      <div class="chart-head">
        <h2>Channel opens and closes</h2>
        <span class="hint">last 90 days · from this explorer's snapshot diffs</span>
      </div>
      ${
        flows.accumulating
          ? `<p class="hint">Opens and closes start accumulating from the first snapshot diff (${flows.events_since ? dayLabel(flows.events_since) : "next refresh"}). Snapshots refresh every 3 hours.</p>`
          : `<canvas class="chart flows" id="flows"></canvas>
      <p class="chart-legend hint"><span class="legend-line solid mint"></span> opens&nbsp;&nbsp;<span class="legend-line solid yellow"></span> closes (closed or pruned from gossip)</p>`
      }
      <div class="kv three">
        <div><div class="k">Opens 7d</div><div class="v">${num((stats.flows_7d || {}).opens)}</div></div>
        <div><div class="k">Closes 7d</div><div class="v">${num((stats.flows_7d || {}).closes)}</div></div>
        <div><div class="k">Net channels 7d</div><div class="v">${(stats.flows_7d || {}).net_channels > 0 ? "+" : ""}${num((stats.flows_7d || {}).net_channels)}</div></div>
      </div>
      <div class="two">
        <div>
          <h3>Close reasons in window</h3>
          ${closeTypesBlock(flows)}
          <p class="hint">Close reasons come from mempool.space, whose Lightning indexer stopped around 2026-08-30; closes after that usually show “unknown / not yet indexed”.</p>
        </div>
        <div>
          <h3>Recent opens and closes</h3>
          ${
            recent.events.filter((event) => CHANNEL_EVENT_KINDS.has(event.kind)).length
              ? `<ul class="event-list">${recent.events
                  .filter((event) => CHANNEL_EVENT_KINDS.has(event.kind))
                  .slice(0, 20)
                  .map(eventRow)
                  .join("")}</ul>`
              : `<p class="hint">No opens or closes recorded yet.</p>`
          }
        </div>
      </div>
    </section>`
        : ""
    }
    <section class="card" style="margin-bottom:0.8rem">
      <h2>Routing fees across ${num(feeRate.count)} directed policies</h2>
      <table>
        <thead><tr>
          <th class="left">Series</th><th>Median</th><th>Filtered mean</th><th>Cap-weighted mean</th><th>p90</th><th>Std dev</th><th>Min</th><th>Max</th><th>Raw mean</th>
        </tr></thead>
        <tbody>
          ${feeTableRow("Fee rate (ppm)", feeRate)}
          ${feeTableRow("Base fee (msat)", feeBase)}
        </tbody>
      </table>
      <p class="hint">Raw mean is distorted by a few placeholder fees such as 2147483647 ppm; filtered mean drops values outside Tukey far-out fences. ${num(
        stats.enabled_channels
      )} channels have at least one non-disabled policy, ${num(stats.disabled_channels)} are disabled both ways.</p>
    </section>
    <div class="two">
      <section class="card"><h2>By capacity</h2><ol class="side-list">${(stats.top_capacity || [])
        .map((node) => `<li><a href="/node/${node.pubkey}">${esc(node.alias || shortKey(node.pubkey))}</a><span>${sats(node.total_capacity)}</span></li>`)
        .join("")}</ol></section>
      <section class="card"><h2>By betweenness</h2><ol class="side-list">${(stats.top_betweenness || [])
        .map((node) => `<li><a href="/node/${node.pubkey}">${esc(node.alias || shortKey(node.pubkey))}</a><span>#${num(node.betweenness_rank)}</span></li>`)
        .join("")}</ol></section>
    </div>
    <p class="hint" style="margin-top:0.8rem">Median base fee ${num(stats.median_base_fee_msat)} msat. Disabled both ways: ${num(stats.disabled_channels)} channels. Capacity known for ${(stats.capacity_coverage * 100).toFixed(0)}% of channels. Snapshot ${when(stats.graph_timestamp)}.</p>`;
  drawHistory(history, { currency });
  if (flows && !flows.accumulating) drawFlows(flows);
  root.querySelectorAll("[data-range]").forEach((button) => {
    button.onclick = () => go(`/stats?range=${button.dataset.range}&cap=${currency}`);
  });
  root.querySelectorAll("[data-cap]").forEach((button) => {
    button.onclick = () => go(`/stats?range=${range}&cap=${button.dataset.cap}`);
  });
}

async function draw() {
  clearInterval(pollTimer);
  destroyGraph();
  window.__explorerLayoutDone = false;
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean);
  try {
    const status = await refreshChrome();
    if (parts.length === 0) {
      setNav("graph");
      if (!status || !status.ready) {
        app.innerHTML = `<section class="card empty"><h1>Syncing the Lightning graph</h1><p>The explorer downloads a public rapid gossip sync snapshot on startup. This page refreshes itself.</p></section>`;
        pollTimer = setInterval(draw, 3000);
        return;
      }
      await renderGraph(app);
      return;
    }
    if (parts[0] === "nodes") {
      setNav("nodes");
      await renderNodes(app);
      return;
    }
    if (parts[0] === "rankings") {
      setNav("rankings");
      await renderRankings(app);
      return;
    }
    if (parts[0] === "stats") {
      setNav("stats");
      await renderStats(app);
      return;
    }
    if (parts[0] === "search") {
      setNav("");
      await renderSearch(app);
      return;
    }
    if (parts[0] === "node" && parts[1]) {
      setNav("");
      await renderNode(app, parts[1]);
      return;
    }
    if (parts[0] === "channel" && parts[1]) {
      setNav("");
      await renderChannel(app, parts[1]);
      return;
    }
    setNav("");
    app.innerHTML = `<section class="card empty"><h1>Not found</h1><p><a href="/">Back to the graph</a></p></section>`;
  } catch (error) {
    app.innerHTML = `<section class="card empty"><h1>Something went wrong</h1><p>${esc(error.message)}</p></section>`;
  }
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const value = button.getAttribute("data-copy");
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "copied";
    setTimeout(() => {
      button.textContent = shortKey(value);
    }, 900);
  } catch (error) {
    button.textContent = "copy failed";
  }
});

draw();
