// Right-hand inspector over the map: node summary or channel explained by direction.
import { api, cached } from "../lib/api.js";
import { histogram, medianBucket } from "../lib/charts.js";
import { copyKey } from "../lib/copy.js";
import { baseFee, btc, btcHtml, displayName, esc, htlc, int, num } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { homeUrl } from "../lib/router.js";
import { attachAutocomplete } from "./autocomplete.js";

const ROUTE_AMOUNT = 100_000;

function shell(kind, extraActions = "") {
  const el = document.createElement("aside");
  el.className = "inspector glass";
  el.setAttribute("aria-label", `${kind} details`);
  el.innerHTML = `
    <div class="head">
      <div class="eyebrow"><span>${kind}</span><span class="acts">${extraActions}<a class="btn sm icon ghost" href="${homeUrl()}" aria-label="Close">${icon("x")}</a></span></div>
      <div class="body-head"><span class="skel num" style="width:60%;margin-top:6px"></span><span class="skel line" style="width:45%"></span></div>
    </div>
    <div class="scroll"><div class="sect"><span class="skel line"></span><span class="skel line" style="width:80%"></span><span class="skel line" style="width:65%"></span></div></div>`;
  return el;
}

export function protocolTags(node) {
  const tags = [];
  if (node.ipv4 || node.ipv6) tags.push(`<span class="tag">Clearnet</span>`);
  if (node.ipv6) tags.push(`<span class="tag">IPv6</span>`);
  if (node.tor) tags.push(`<span class="tag">Tor</span>`);
  return tags.join("");
}

function capacityTicks() {
  return `<div class="ticks mono sub"><span>&lt;100k sat</span><span>1M</span><span>10M</span><span>≥5 BTC</span></div>`;
}

/** Peers list with bars, scaled to the largest. */
export function peerRows(peers, { limit = 5 } = {}) {
  if (!peers.length) return `<div class="empty-line">${icon("node")}No channels with known capacity.</div>`;
  const max = Math.max(1, ...peers.map((p) => p.capacity));
  return peers
    .slice(0, limit)
    .map(
      (p, i) => `<a class="peer" href="${homeUrl({ node: p.pubkey })}">
        <span class="n ellipsis">${esc(displayName(p.alias, p.pubkey))}</span>
        <span class="bar${i ? "" : " acc"}"><i style="width:${Math.max(2, (p.capacity / max) * 100).toFixed(1)}%"></i></span>
        <span class="c mono">${p.capacity ? btc(p.capacity) : "—"} <span class="sub">${int(p.channels)}</span></span></a>`,
    )
    .join("");
}

function feePosition(nodePpm, networkPpm, alias) {
  if (nodePpm == null || networkPpm == null) return `<div class="empty-line">No fee policy announced.</div>`;
  const scale = Math.max(1000, nodePpm * 1.15, networkPpm * 1.4);
  const at = (v) => `${Math.min(100, Math.sqrt(Math.max(0, v) / scale) * 100).toFixed(1)}%`;
  const ratio = networkPpm > 0 ? nodePpm / networkPpm : null;
  let sentence = "";
  if (ratio !== null) {
    if (ratio >= 1.15) sentence = `${num(ratio, 1)}× the network median to route out through ${esc(alias)}.`;
    else if (ratio <= 0.87) sentence = `${ratio < 0.05 ? "Almost free" : `${num(ratio * 100, 0)}% of the network median`} to route out through ${esc(alias)}.`;
    else sentence = `About the network median.`;
  }
  return `<div class="feepos">
      <div class="track"></div>
      <div class="mark" style="left:${at(networkPpm)}"></div>
      <div class="mark-l mono" style="left:${at(networkPpm)}">network ${num(networkPpm)}</div>
      <div class="pin" style="left:${at(nodePpm)}"></div>
      <div class="pin-l mono" style="left:${at(nodePpm)}">${num(nodePpm, 1)}</div>
    </div>
    <div class="sub">${sentence}</div>`;
}

let routeIds = 0;

/** "Find route from…" disclosure. Pair with wireRouteFinder(root, targetPubkey, signal). */
export function routeFinder({ open = false } = {}) {
  routeIds += 1;
  const id = `route-from-${routeIds}`;
  return `<details class="routefind"${open ? " open" : ""}>
      <summary class="btn block">${icon("route")}Find route from…</summary>
      <form class="routeform">
        <label class="sr-only" for="${id}">Source node</label>
        <div class="ac-wrap"><input id="${id}" class="input sm" placeholder="Alias or pubkey of the source" /></div>
        <button class="btn sm primary" type="submit">Find</button>
      </form>
      <div class="route-result" aria-live="polite"></div>
      <a class="btn sm block ghost" data-payment-route href="/route">${icon("route")}Compare payment routes ${icon("arrowR")}</a>
    </details>`;
}

export function wireRouteFinder(root, targetPubkey, signal) {
  const form = root.querySelector(".routeform");
  if (!form) return;
  const inputEl = form.querySelector("input");
  const out = root.querySelector(".route-result");
  const explore = root.querySelector("[data-payment-route]");
  const updateExplore = () => {
    const params = new URLSearchParams({ to: targetPubkey, amount: ROUTE_AMOUNT });
    const source = inputEl.value.trim().toLowerCase();
    if (/^[0-9a-f]{66}$/.test(source)) params.set("from", source);
    explore.href = `/route?${params}`;
  };
  updateExplore();
  inputEl.addEventListener("input", updateExplore, { signal });
  attachAutocomplete(inputEl, updateExplore, { signal });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const source = inputEl.value.trim().toLowerCase();
    if (!/^[0-9a-f]{66}$/.test(source)) {
      out.innerHTML = `<div class="sub">Pick a node from the suggestions or paste a 66-character pubkey.</div>`;
      return;
    }
    out.innerHTML = `<span class="skel line"></span>`;
    try {
      const path = await api(`/api/path?source=${source}&target=${targetPubkey}`, { signal });
      if (path.hops === null) {
        out.innerHTML = `<div class="sub">No public path between these nodes.</div>`;
        return;
      }
      out.innerHTML = `<div class="lbl">${path.hops} hop${path.hops === 1 ? "" : "s"}</div><ol class="hops">${path.path
        .map((hop) => `<li><a href="${homeUrl({ node: hop.pubkey })}">${esc(displayName(hop.alias, hop.pubkey))}</a></li>`)
        .join("")}</ol>`;
    } catch (error) {
      out.innerHTML = `<div class="sub">${esc(error.message)}</div>`;
    }
  });
}

export function mountNodeInspector(host, pubkey, { signal, onMap }) {
  const el = shell("Node", `<a class="btn sm icon ghost" href="/node/${pubkey}" aria-label="Open full profile" title="Open full profile">${icon("ext")}</a>`);
  host.appendChild(el);
  Promise.all([
    api(`/api/nodes/${pubkey}`, { signal }),
    api(`/api/nodes/${pubkey}/summary?peers=5`, { signal }),
    cached("/api/stats", 300_000).catch(() => null),
  ])
    .then(([node, summary, stats]) => {
      const name = displayName(node.alias, node.pubkey);
      const hist = summary.capacity_histogram;
      const known = hist.counts.reduce((a, b) => a + b, 0);
      el.querySelector(".body-head").outerHTML = `
        <h2 class="title"><span class="dot"></span><span class="ellipsis">${esc(name)}</span></h2>
        <div class="meta">${copyKey(node.pubkey)}<span class="sp"></span>${protocolTags(node)}${node.country ? `<span class="tag">${esc(node.country)}</span>` : ""}</div>
        <div class="offmap"></div>`;
      Promise.resolve(onMap).then((isOnMap) => {
        const slot = el.querySelector(".offmap");
        if (slot && isOnMap === false) {
          slot.innerHTML = `<div class="notice" style="margin-top:12px">${icon("info")}<span>This node is outside the current map selection. Adjust the graph filters or raise the hub limit to include it.</span></div>`;
        }
      });
      el.querySelector(".scroll").innerHTML = `
        <div class="sect"><div class="kpis">
          <div class="kpi"><div class="lbl">Capacity</div><div class="v">${btcHtml(node.total_capacity)}</div><div class="sub">${node.capacity_source === "mempool" ? "via mempool.space" : esc(node.capacity_source || "")}</div></div>
          <div class="kpi"><div class="lbl">Channels</div><div class="v">${int(node.num_channels)}</div><div class="sub">${int(node.active_channels)} active</div></div>
          <div class="kpi"><div class="lbl">Centrality</div><div class="v">${node.betweenness_rank ? `#${int(node.betweenness_rank)}` : "—"}</div><div class="sub">betweenness</div></div>
        </div></div>
        <div class="sect"><div class="sect-h"><b>Largest peers</b><span class="lbl">BTC · channels</span></div><div class="peers">${peerRows(summary.peers)}</div>
          ${summary.peer_count > 5 ? `<div class="sub" style="margin-top:6px">${int(summary.peer_count)} peers in total</div>` : ""}</div>
        <div class="sect"><div class="sect-h"><b>Channel sizes</b><span class="lbl">${known ? `median ${btc(node.med_capacity)} BTC` : ""}</span></div>
          ${known ? `${histogram(hist.counts, { width: 330, height: 52, highlight: medianBucket(hist.counts), label: "Channel capacity distribution" })}${capacityTicks()}` : `<div class="empty-line">Capacities not known yet.</div>`}
          ${hist.unknown ? `<div class="sub" style="margin-top:6px">${int(hist.unknown)} channel${hist.unknown === 1 ? "" : "s"} with unknown capacity</div>` : ""}</div>
        <div class="sect"><div class="sect-h"><b>Outgoing fee</b><span class="lbl">median, ppm</span></div>${feePosition(node.med_out_ppm, stats?.median_fee_rate_ppm, name)}</div>
        ${node.features && node.features.length ? `<div class="sect"><div class="sect-h"><b>Features</b></div><div class="tags">${featureTags(node)}</div></div>` : ""}`;
      const foot = document.createElement("div");
      foot.className = "foot";
      foot.innerHTML = `<a class="btn primary block" href="/node/${node.pubkey}">Open full profile ${icon("arrowR")}</a>${routeFinder()}`;
      el.appendChild(foot);
      wireRouteFinder(el, node.pubkey, signal);
    })
    .catch((error) => {
      if (error.name === "AbortError") return;
      el.querySelector(".body-head").innerHTML = `<h2 class="title">Node not found</h2>`;
      el.querySelector(".scroll").innerHTML = `<div class="sect"><div class="empty-line">${icon("alert")}${esc(error.message)}</div></div>`;
    });
  return el;
}

export function featureTags(node) {
  const defs = [
    ["wumbo", "Wumbo"],
    ["anchors", "Anchors"],
    ["dual_fund", "Dual funding"],
    ["route_blinding", "Route blinding"],
    ["onion_messages", "Onion messages"],
  ];
  return defs.map(([key, label]) => `<span class="tag${node[key] ? (key === "wumbo" ? " acc" : "") : " off"}">${label}</span>`).join("");
}

function laneHtml(from, to, side, reverse) {
  const p = side.policy;
  const arrow = reverse
    ? `${icon("arrowL")}<span class="ln rev"></span>`
    : `<span class="ln"></span>${icon("arrowR")}`;
  const head = `<div class="arrow">${arrow}<span class="who ellipsis">${esc(from)} → ${esc(to)}</span></div>`;
  if (!p) return `<div class="lane">${head}<div class="empty-line" style="padding:4px 0">No channel update announced.</div></div>`;
  return `<div class="lane${p.disabled ? " off" : ""}">${head}
    <div class="fee">${int(p.fee_rate_ppm)} ppm<small>+ ${baseFee(p.base_fee_msat)} base</small>${p.disabled ? '<span class="tag neg">Disabled</span>' : ""}</div>
    <div class="meta"><span>CLTV<b>${int(p.cltv_delta)}</b></span><span>Min HTLC<b>${htlc(p.min_htlc_msat)}</b></span><span>Max HTLC<b>${htlc(p.max_htlc_msat)}</b></span></div>
  </div>`;
}

function routeCost(policy, amount) {
  if (!policy || policy.disabled) return null;
  return policy.base_fee_msat / 1000 + (amount * policy.fee_rate_ppm) / 1e6;
}

function satAmount(value) {
  if (value === null) return "—";
  return `${num(value, value < 10 ? 1 : 0)} sat`;
}

export function mountChannelInspector(host, channelId, { signal, onLoaded }) {
  const el = shell("Channel");
  host.appendChild(el);
  api(`/api/channels/${encodeURIComponent(channelId)}`, { signal })
    .then((ch) => {
      const n1 = displayName(ch.node1.alias, ch.node1.pubkey);
      const n2 = displayName(ch.node2.alias, ch.node2.pubkey);
      const block = ch.short_id.split("x")[0];
      el.querySelector(".body-head").outerHTML = `
        <h2 class="title">${esc(n1)} <span class="muted" style="font-weight:400">↔</span> ${esc(n2)}</h2>
        <div class="meta">${copyKey(ch.short_id, { label: ch.short_id })}<span class="sp"></span>${ch.capacity ? `<span class="tag">${btc(ch.capacity)} BTC</span>` : `<span class="tag">capacity unknown</span>`}<span class="tag">block ${int(block)}</span></div>`;
      const c1 = routeCost(ch.node1.policy, ROUTE_AMOUNT);
      const c2 = routeCost(ch.node2.policy, ROUTE_AMOUNT);
      const cmax = Math.max(c1 || 0, c2 || 0, 0.0001);
      let compare = "";
      if (c1 !== null && c2 !== null && c1 > 0 && c2 > 0 && Math.abs(c1 - c2) / Math.max(c1, c2) > 0.1) {
        // c1 is the cost of sending node1 → node2, i.e. routing toward node2.
        const [pricey, cheap, factor] = c1 < c2 ? [n1, n2, c2 / c1] : [n2, n1, c1 / c2];
        compare = `<div class="sub" style="margin-top:6px">Routing toward ${esc(pricey)} costs ${num(factor, factor < 10 ? 1 : 0)}× more than routing toward ${esc(cheap)}.</div>`;
      }
      el.querySelector(".scroll").innerHTML = `
        <div class="sect"><div class="lanes">
          <div class="ends"><a href="${homeUrl({ node: ch.node1.pubkey })}"><i class="nd"></i>${esc(n1)}</a><a href="${homeUrl({ node: ch.node2.pubkey })}">${esc(n2)}<i class="nd acc"></i></a></div>
          ${laneHtml(n1, n2, ch.node1, false)}
          ${laneHtml(n2, n1, ch.node2, true)}
        </div></div>
        <div class="sect"><div class="sect-h"><b>Cost to route ${int(ROUTE_AMOUNT)} sats</b>
          <details class="info right"><summary aria-label="How this is calculated">${icon("info")}</summary><div><p>Base fee plus the proportional fee (ppm × amount ÷ 1,000,000) that each side charges to forward a payment out over this channel.</p></div></details></div>
          <div class="peers">
            <div class="peer static"><span class="n ellipsis">${esc(n1)} → ${esc(n2)}</span><span class="bar"><i style="width:${c1 === null ? 0 : Math.max(2, (c1 / cmax) * 100).toFixed(1)}%"></i></span><span class="c mono">${c1 === null ? "disabled" : satAmount(c1)}</span></div>
            <div class="peer static"><span class="n ellipsis">${esc(n2)} → ${esc(n1)}</span><span class="bar acc"><i style="width:${c2 === null ? 0 : Math.max(2, (c2 / cmax) * 100).toFixed(1)}%"></i></span><span class="c mono">${c2 === null ? "disabled" : satAmount(c2)}</span></div>
          </div>${compare}
        </div>
        <div class="sect"><div class="sect-h"><b>Identifiers</b></div>
          <div class="kv"><span class="lbl">Short channel id</span>${copyKey(ch.short_id, { label: ch.short_id })}</div>
          <div class="kv"><span class="lbl">Numeric id</span>${copyKey(String(ch.scid), { label: String(ch.scid) })}</div>
          ${ch.capacity ? `<div class="kv"><span class="lbl">Capacity</span><span class="mono">${int(ch.capacity)} sats</span></div>` : ""}
        </div>`;
      const foot = document.createElement("div");
      foot.className = "foot two";
      foot.innerHTML = `<a class="btn" href="/node/${ch.node1.pubkey}"><span class="ellipsis">${esc(n1)}</span>${icon("arrowR")}</a><a class="btn" href="/node/${ch.node2.pubkey}"><span class="ellipsis">${esc(n2)}</span>${icon("arrowR")}</a>`;
      el.appendChild(foot);
      onLoaded?.(ch);
    })
    .catch((error) => {
      if (error.name === "AbortError") return;
      el.querySelector(".body-head").innerHTML = `<h2 class="title">Channel not found</h2>`;
      el.querySelector(".scroll").innerHTML = `<div class="sect"><div class="empty-line">${icon("alert")}${esc(error.message)}</div></div>`;
    });
  return el;
}
