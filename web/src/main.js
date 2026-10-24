import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";

const app = document.getElementById("app");
const banner = document.getElementById("sync-banner");
const footerMeta = document.getElementById("footer-meta");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");

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
    ctx.strokeStyle = "rgba(29, 254, 187, 0.45)";
    ctx.lineWidth = 1;
    payload.edges.forEach((edge) => {
      const a = pos.get(edge.a);
      const b = pos.get(edge.b);
      if (!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
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
      graph.addEdgeWithKey(edge.scid, edge.a, edge.b, {
        size: bothHubs ? 1.3 : 0.6,
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
      minEdgeThickness: 0.7,
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
  ["eigenvector_rank", "Eigenvector rank"],
  ["eigenvector_weighted_rank", "Eigenvector rank (weighted)"],
];

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
            <option value="eigenvector_rank">eigenvector</option>
            <option value="alias">alias</option>
          </select>
        </label>
        <button class="btn" id="apply" type="button">Apply</button>
      </div>
      <p class="hint">Betweenness and closeness are sampled. Rank 1 is the most central node. Reference node limits the table to its reachable neighborhood.</p>
      <div class="filter-row">
        <label class="field">Reference node pubkey
          <input id="reference" type="text" value="${esc(params.get("reference") || "")}" placeholder="02…" style="min-width:22rem" />
        </label>
        <label class="field"><span>Reachable only</span>
          <input id="reachable" type="checkbox" ${params.get("reachable") === "1" ? "checked" : ""} />
        </label>
      </div>
    </section>
    <div id="node-table" class="card"><p class="hint">Loading nodes…</p></div>`;
  ["protocol", "quantifier", "field", "rel", "sort"].forEach((id) => {
    const value = params.get(id);
    if (value) document.getElementById(id).value = value;
  });
  document.getElementById("apply").onclick = () => {
    const next = new URLSearchParams();
    const q = document.getElementById("q").value.trim();
    if (q) next.set("q", q);
    const protocol = document.getElementById("protocol").value;
    if (protocol) next.set("protocol", protocol);
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
        <th>Median fee ppm</th><th>Median base msat</th><th>Betweenness</th><th>Closeness</th><th>Eigenvector</th><th class="left">Clearnet</th>
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

async function renderNode(root, pubkey) {
  root.innerHTML = `<p class="hint">Loading node…</p>`;
  const node = await api(`/api/nodes/${pubkey}`);
  const page = new URLSearchParams(location.search).get("page") || "1";
  const channels = await api(`/api/nodes/${pubkey}/channels?page=${page}&page_size=25`);
  root.innerHTML = `
    <div class="title-row">
      <span class="swatch" style="background:${esc(node.color || "#1DFEBB")}"></span>
      <h1>${esc(node.alias || "Unnamed node")}</h1>
      ${protocols(node)}
    </div>
    <p>${pubkeyChip(node.pubkey)} ${node.city || node.country ? `<span class="hint">${esc([node.city, node.country].filter(Boolean).join(", "))}</span>` : ""}</p>
    <div class="kv">
      <div><div class="k">Capacity</div><div class="v">${fullSats(node.total_capacity)}</div></div>
      <div><div class="k">Channels</div><div class="v">${num(node.num_channels)} <span class="hint">(${num(node.active_channels)} routable)</span></div></div>
      <div><div class="k">Median outgoing fee</div><div class="v">${num(node.med_out_ppm, 1)} ppm</div></div>
      <div><div class="k">Median base fee</div><div class="v">${num(node.med_out_base)} msat</div></div>
      <div><div class="k">Betweenness rank</div><div class="v">${num(node.betweenness_rank)}</div></div>
      <div><div class="k">Closeness rank</div><div class="v">${num(node.closeness_rank)}</div></div>
      <div><div class="k">Eigenvector rank</div><div class="v">${num(node.eigenvector_rank)}</div></div>
      <div><div class="k">Weighted eigenvector</div><div class="v">${num(node.eigenvector_weighted_rank)}</div></div>
    </div>
    <p class="hint">Capacity source: ${esc(node.capacity_source)}. First seen ${when(node.first_seen)}. ${node.addresses.length ? `Addresses: ${node.addresses.map(esc).join(", ")}` : "No announced addresses yet."}</p>
    <form id="path-form" class="filter-row" style="margin-bottom:1rem">
      <label class="field">Shortest path from
        <input id="path-from" type="text" placeholder="source pubkey" style="min-width:22rem" />
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
    </div>`;
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

function drawHistory(points) {
  const canvas = document.getElementById("history");
  if (!canvas || !points.length) return;
  const width = canvas.clientWidth || 800;
  const height = 260;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const rows = points.filter((point) => point.total_capacity && point.channel_count);
  if (rows.length < 2) return;
  const caps = rows.map((point) => point.total_capacity);
  const chans = rows.map((point) => point.channel_count);
  const minC = Math.min(...caps);
  const maxC = Math.max(...caps);
  const minH = Math.min(...chans);
  const maxH = Math.max(...chans);
  const pad = 28;
  const x = (index) => pad + (index / (rows.length - 1)) * (width - pad * 2);
  const yCap = (value) => height - pad - ((value - minC) / (maxC - minC || 1)) * (height - pad * 2);
  const yChan = (value) => height - pad - ((value - minH) / (maxH - minH || 1)) * (height - pad * 2);
  ctx.strokeStyle = "#333";
  ctx.strokeRect(pad, pad, width - pad * 2, height - pad * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#1DFEBB";
  ctx.beginPath();
  caps.forEach((value, index) => {
    const px = x(index);
    const py = yCap(value);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.strokeStyle = "#FAD228";
  ctx.beginPath();
  chans.forEach((value, index) => {
    const px = x(index);
    const py = yChan(value);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.fillStyle = "#9aa39c";
  ctx.font = "12px sans-serif";
  ctx.fillText("capacity", pad, 16);
  ctx.fillStyle = "#FAD228";
  ctx.fillText("channels", pad + 70, 16);
}

async function renderStats(root) {
  root.innerHTML = `<p class="hint">Loading statistics…</p>`;
  const [stats, history] = await Promise.all([api("/api/stats"), api("/api/history")]);
  const reported = stats.reported || {};
  root.innerHTML = `
    <div class="stats-row">
      <div class="card"><div class="stat-label">Gossip nodes</div><div class="stat-value">${num(stats.gossip_nodes)}</div></div>
      <div class="card"><div class="stat-label">Gossip channels</div><div class="stat-value">${num(stats.gossip_channels)}</div></div>
      <div class="card"><div class="stat-label">Reported capacity</div><div class="stat-value">${sats(reported.total_capacity || stats.gossip_capacity)}</div></div>
      <div class="card"><div class="stat-label">Median fee</div><div class="stat-value">${num(stats.median_fee_rate_ppm, 0)} ppm</div></div>
    </div>
    <section class="card" style="margin-bottom:0.8rem">
      <h2>Network over the past year</h2>
      <p class="hint">Mint is capacity, yellow is channel count. The long series comes from the public mempool Lightning statistics. Gossip counts above are the live snapshot and are smaller than mempool's historical node total, which still includes nodes without a currently announced channel.</p>
      <canvas class="chart" id="history"></canvas>
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
  drawHistory(history.points || []);
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
