// "/route?from=&to=&amount=" — exact public-policy routes, with a local map.
import Graph from "graphology";
import { api, isAbort } from "../lib/api.js";
import { btcHtml, displayName, esc, int, num } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { go, homeUrl, mapUrl } from "../lib/router.js";
import { attachAutocomplete } from "../ui/autocomplete.js";
import { loadSigma } from "../lib/webgl.js";

const DEFAULT_AMOUNT = 100000;
const PUBKEY_RE = /^[0-9a-f]{66}$/;

function htlcWindow(min, max) {
  return `${min > 0 ? `${int(min)} msat` : "any"} – ${max > 0 ? `${int(max)} msat` : "none announced"}`;
}

function hopRow(hop, index) {
  return `<tr>
    <td class="rt-hop"><a href="/node/${esc(hop.from)}" title="${esc(hop.from)}">${esc(displayName(hop.from_alias, hop.from))}</a><span class="muted" aria-label="to"> → </span><a href="/node/${esc(hop.to)}" title="${esc(hop.to)}">${esc(displayName(hop.to_alias, hop.to))}</a></td>
    <td><a class="mono" href="${esc(mapUrl(`/channel/${encodeURIComponent(hop.scid)}`))}">${esc(hop.short_id)}</a></td>
    <td class="mono r">${int(hop.base_fee_msat)} msat + ${int(hop.fee_rate_ppm)} ppm</td>
    <td class="mono r">${int(hop.fee_msat)} msat${index === 0 ? '<small class="rt-sender muted">sender</small>' : ""}</td>
    <td class="mono r">${int(hop.amount_msat)} msat</td>
    <td class="mono r">${int(hop.cltv_delta)}</td>
    <td class="mono r">${hop.capacity == null ? '<span class="muted">unknown</span>' : btcHtml(hop.capacity)}</td>
    <td class="mono r">${esc(htlcWindow(hop.min_htlc_msat, hop.max_htlc_msat))}</td>
  </tr>`;
}

function routeCard(path, index, best) {
  const bottleneck = path.bottleneck_capacity == null
    ? `<span class="muted">Unknown on ${int(path.unknown_capacity_hops)} hop${path.unknown_capacity_hops === 1 ? "" : "s"}</span>`
    : btcHtml(path.bottleneck_capacity);
  return `<article class="panel rt-card" data-route="${index + 1}" aria-labelledby="route-title-${index + 1}">
    <header class="panel-h rt-card-head"><h2 id="route-title-${index + 1}">Route <span class="mono">${index + 1}</span></h2>
      ${index === 0 ? '<span class="tag acc">Cheapest</span>' : `<span class="tag">+${int(path.total_fee_msat - best.total_fee_msat)} msat vs route 1</span>`}
    </header>
    <dl class="rt-metrics">
      <div><dt>Total fee</dt><dd class="rt-fee mono">${int(path.total_fee_msat)} <small class="unit">msat</small></dd><dd class="sub mono">${num(path.total_fee_ppm, 1)} ppm</dd></div>
      <div><dt>Hops</dt><dd class="mono">${int(path.hop_count)}</dd></div>
      <div><dt>Total CLTV</dt><dd class="mono">${int(path.total_cltv)} <small class="unit">blocks</small></dd></div>
      <div><dt>Bottleneck capacity</dt><dd class="mono">${bottleneck}</dd></div>
      <div><dt>HTLC limits</dt><dd class="mono rt-htlc">${esc(htlcWindow(path.path_min_htlc, path.path_max_htlc))}</dd></div>
    </dl>
    <div class="rt-table-scroll" tabindex="0" role="region" aria-label="Route ${index + 1} hop breakdown; scroll horizontally for all columns">
      <table class="dtable rt-hops"><caption class="sr-only">Route ${index + 1}: exact hop fees, forwarded amounts and channel constraints</caption>
        <thead><tr><th scope="col">Hop (from → to)</th><th scope="col">Channel</th><th scope="col" class="r" title="Fee policy of the forwarding node">Fee policy</th><th scope="col" class="r">Fee charged</th><th scope="col" class="r">Amount forwarded</th><th scope="col" class="r">CLTV Δ</th><th scope="col" class="r">Capacity</th><th scope="col" class="r">HTLC min – max</th></tr></thead>
        <tbody>${path.hops.map(hopRow).join("")}</tbody>
      </table>
    </div>
    <p class="rt-card-note muted">Fees are computed backwards like a real payment: each hop forwards the next hop’s amount plus its fee. The sender’s first channel charges no fee and adds no CLTV to the total. Capacity values show exact sats on hover.</p>
  </article>`;
}

// Keep shared nodes together, route 1 in the middle and alternatives on either side.
// This renderer belongs to this view, never to the persistent Atlas network map.
function drawRouteGraph(Sigma, container, paths) {
  const source = paths[0].hops[0].from;
  const target = paths[0].hops.at(-1).to;
  const nodes = new Map();
  const edges = new Map();
  paths.forEach((path, index) => {
    const keys = [path.hops[0].from, ...path.hops.map((hop) => hop.to)];
    keys.forEach((key, position) => {
      const node = nodes.get(key) || { x: 0, count: 0, tier: index, alias: "" };
      node.x += position / (keys.length - 1);
      node.count += 1;
      nodes.set(key, node);
    });
    path.hops.forEach((hop) => {
      if (!nodes.get(hop.from).alias && hop.from_alias) nodes.get(hop.from).alias = hop.from_alias;
      if (!nodes.get(hop.to).alias && hop.to_alias) nodes.get(hop.to).alias = hop.to_alias;
      // The cheapest route wins shared channels, both for colour and navigation.
      if (!edges.has(hop.scid)) edges.set(hop.scid, { from: hop.from, to: hop.to, index });
    });
  });
  const style = getComputedStyle(container);
  const accent = style.getPropertyValue("--accent").trim();
  const endpointColor = style.getPropertyValue("--warn").trim();
  const textColor = style.getPropertyValue("--text").trim();
  const alternateColor = style.getPropertyValue("--muted").trim();
  const graph = new Graph({ type: "undirected", multi: false });
  for (const [key, node] of nodes) {
    let y = 0;
    if (node.tier > 0) {
      let hash = 0;
      for (let i = 0; i < key.length; i += 1) hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
      const side = node.tier % 2 === 1 ? 1 : -1;
      y = side * (1.2 + Math.floor((node.tier - 1) / 2) * 1.7) + (hash / 0xffffffff - 0.5) * 0.8;
    }
    const endpoint = key === source || key === target;
    graph.addNode(key, {
      x: (node.x / node.count) * 12, y,
      size: endpoint ? 9 : 6,
      label: displayName(node.alias, key),
      color: endpoint ? endpointColor : node.tier === 0 ? accent : alternateColor,
      forceLabel: endpoint,
    });
  }
  for (const [scid, edge] of edges) {
    if (edge.from === edge.to || graph.hasEdge(edge.from, edge.to)) continue;
    graph.addEdgeWithKey(scid, edge.from, edge.to, {
      size: edge.index === 0 ? 3.2 : 2,
      color: edge.index === 0 ? accent : alternateColor,
      scid,
    });
  }
  const renderer = new Sigma(graph, container, {
    renderLabels: true,
    labelRenderedSizeThreshold: 7,
    labelSize: 13,
    labelWeight: "500",
    labelFont: style.getPropertyValue("--sans").trim(),
    labelColor: { color: textColor },
    defaultEdgeColor: accent,
    minEdgeThickness: 0.6,
    enableEdgeEvents: true,
    allowInvalidContainer: true,
  });
  renderer.on("clickNode", ({ node }) => go(`/node/${encodeURIComponent(node)}`));
  renderer.on("clickEdge", ({ edge }) => go(mapUrl(`/channel/${encodeURIComponent(graph.getEdgeAttribute(edge, "scid"))}`)));
  return renderer;
}

function renderResults(host, payload, amount, Sigma) {
  const timedNote = payload.timed_out
    ? '<p class="notice warn rt-timeout" role="status">The search hit its time budget. These are the best routes found before the cutoff; the results may be incomplete.</p>'
    : "";
  if (!payload.paths.length) {
    host.innerHTML = `<section class="panel rt-empty"><h2>No route found</h2><p class="muted">${esc(payload.reason || "No path connects these nodes for this amount.")}</p>${timedNote}</section>`;
    return;
  }
  const first = payload.paths[0].hops[0];
  const last = payload.paths[0].hops.at(-1);
  host.innerHTML = `<section class="panel rt-map" aria-labelledby="route-map-title">
      <header class="panel-h"><h2 id="route-map-title">Route map</h2><span class="mono muted">${int(amount)} sats</span></header>
      <p class="rt-endpoints text-2">${esc(displayName(first.from_alias, first.from))} <span class="muted">→</span> ${esc(displayName(last.to_alias, last.to))}</p>
      <div class="rt-graph"><div id="route-sigma" role="img" aria-label="Map of candidate routes. Node and channel links are also available in the hop tables below."></div></div>
      <div class="rt-legend muted"><span><i class="rt-legend-line"></i>Route 1 · cheapest</span><span><i class="rt-legend-line alternate"></i>Alternates</span><span><i class="rt-legend-node"></i>Sender / receiver</span></div>
      <p class="sub">Click a node or channel to explore it. Drag to pan, scroll to zoom. Keyboard-accessible links are in each hop table.</p>
    </section>
    <p class="rt-result-count muted" role="status">${int(payload.paths.length)} route${payload.paths.length === 1 ? "" : "s"} found in <span class="mono">${int(payload.elapsed_ms)} ms</span></p>
    ${timedNote}
    ${payload.paths.map((path, index) => routeCard(path, index, payload.paths[0])).join("")}`;
  try {
    if (!Sigma) throw new Error("WebGL unavailable");
    return drawRouteGraph(Sigma, host.querySelector("#route-sigma"), payload.paths);
  } catch (error) {
    console.warn("Route mini-graph failed", error);
    host.querySelector(".rt-graph").innerHTML = '<p class="rt-graph-fallback muted">The route map needs WebGL. The tables below list every hop, with links to every node and channel.</p>';
  }
}

export async function mount(ctx) {
  const params = ctx.route.params;
  const from = (params.get("from") || "").trim().toLowerCase();
  const to = (params.get("to") || "").trim().toLowerCase();
  const rawAmount = Number(params.get("amount"));
  const amount = Number.isFinite(rawAmount) && Number.isInteger(rawAmount) && rawAmount >= 1 ? rawAmount : DEFAULT_AMOUNT;
  ctx.setTitle("Route explorer");
  ctx.el.innerHTML = `<div class="page rt-page"><div class="wrap rt-wrap">
    <header class="rt-header"><div><p class="rt-eyebrow mono">PUBLIC CHANNEL GRAPH</p><h1>Route explorer</h1><p class="muted">Follow the fees. Compare up to five cheapest paths for a payment.</p></div><a class="btn ghost" href="${esc(homeUrl())}">${icon("map")}Back to map</a></header>
    <section class="panel rt-search" aria-label="Find routes">
      <form id="route-form" class="rt-form">
        <label class="field"><span>From · sender</span><input class="input mono" id="route-from" name="from" type="text" value="${esc(from)}" placeholder="Pubkey or alias" required aria-describedby="route-query-help" /></label>
        <label class="field"><span>To · receiver</span><input class="input mono" id="route-to" name="to" type="text" value="${esc(to)}" placeholder="Pubkey or alias" required aria-describedby="route-query-help" /></label>
        <label class="field"><span>Amount · sats</span><input class="input mono" id="route-amount" name="amount" type="number" min="1" step="1" value="${amount}" required /></label>
        <button class="btn primary" type="submit">Find routes</button>
      </form>
      <p id="route-query-help" class="rt-query-help muted">Type an alias and choose a node, or paste a public key. Each hop must satisfy its fee policy, HTLC limits and known capacity. The query lives in the URL, so links are shareable.</p>
    </section>
    <p class="rt-caveat muted">Public policies do not reveal channel balances. A route is not a guarantee that a payment will succeed.</p>
    <div id="route-results" aria-busy="${Boolean(from && to)}"><p class="empty-line" role="status">${from && to ? "Searching routes…" : "Pick a sender and receiver, then find routes."}</p></div>
  </div></div>`;
  const form = ctx.el.querySelector("#route-form");
  const fromInput = form.elements.namedItem("from");
  const toInput = form.elements.namedItem("to");
  const disposeFrom = attachAutocomplete(fromInput, undefined, { signal: ctx.signal });
  const disposeTo = attachAutocomplete(toInput, undefined, { signal: ctx.signal });
  let renderer;
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    disposeFrom?.();
    disposeTo?.();
    renderer?.kill();
    ctx.signal.removeEventListener("abort", cleanup);
  };
  ctx.signal.addEventListener("abort", cleanup, { once: true });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = new URLSearchParams();
    const sender = fromInput.value.trim().toLowerCase();
    const receiver = toInput.value.trim().toLowerCase();
    const value = Number(form.elements.namedItem("amount").value);
    if (sender) next.set("from", sender);
    if (receiver) next.set("to", receiver);
    next.set("amount", String(Number.isFinite(value) && value >= 1 ? Math.round(value) : DEFAULT_AMOUNT));
    go(`/route?${next}`);
  }, { signal: ctx.signal });
  const host = ctx.el.querySelector("#route-results");
  if (!from || !to) return cleanup;
  if (!PUBKEY_RE.test(from) || !PUBKEY_RE.test(to)) {
    host.setAttribute("aria-busy", "false");
    host.innerHTML = '<p class="notice warn" role="alert">Sender and receiver must be node pubkeys (66 hex characters). Type an alias and select an autocomplete suggestion.</p>';
    return cleanup;
  }
  try {
    const query = new URLSearchParams({ from, to, amount_sat: String(amount), k: "5" });
    const [payload, Sigma] = await Promise.all([api(`/api/route?${query}`, { signal: ctx.signal }), loadSigma()]);
    if (ctx.alive() && !disposed) {
      host.setAttribute("aria-busy", "false");
      renderer = renderResults(host, payload, amount, Sigma);
    }
  } catch (error) {
    if (ctx.alive() && !disposed && !isAbort(error)) {
      host.setAttribute("aria-busy", "false");
      host.innerHTML = `<p class="notice warn" role="alert">${esc(error.message)}</p>`;
    }
  }
  return cleanup;
}
