// "/node/<pubkey>" — the full node profile: a scrolling page (map hidden) with a
// peer-spiral hero, header, tabs (state in ?tab=, channel paging in ?page=) and footer.
import { api, cached, isAbort } from "../lib/api.js";
import { histogram, medianBucket, sparkline } from "../lib/charts.js";
import { copyKey } from "../lib/copy.js";
import { baseFee, btc, btcHtml, date, dateTime, displayName, esc, int, isoDay, monthYear, num, ppm, relTime, shortKey } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { homeUrl, setQuery } from "../lib/router.js";
import { siteFooter } from "../ui/chrome.js";
import { peerRows, protocolTags, routeFinder, wireRouteFinder } from "../ui/inspector.js";

const PUBKEY_RE = /^[0-9a-f]{66}$/;
const PAGE_SIZE = 50;
const HERO_PEERS = 50;
const RANK_LIST = 100;
const TABS = [
  ["overview", "Overview"],
  ["channels", "Channels"],
  ["fees", "Fees"],
  ["rankings", "Rankings"],
  ["history", "History"],
];
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
const LIST_METRICS = ["total_capacity", "num_channels"];
const EVENT_KIND_LABELS = {
  channel_open: "Opened",
  channel_reappeared: "Re-announced",
  channel_close: "Closed or pruned",
  policy_fee: "Fee change",
  alias: "Alias",
  color: "Color",
  addresses: "Addresses",
};
const CHANNEL_EVENT_KINDS = new Set(["channel_open", "channel_reappeared", "channel_close"]);
const LARGE_CHANNEL_FEATURE = "option_support_large_channel";

export async function mount(ctx) {
  const pubkey = decodeURIComponent(ctx.route.parts[1] || "").toLowerCase();
  if (!PUBKEY_RE.test(pubkey)) {
    notFound(ctx, "That is not a node public key. A pubkey is 66 hexadecimal characters.");
    return undefined;
  }

  const state = readState(ctx.route.params);
  ctx.el.innerHTML = `<div class="page nd-page">
      <div class="nd-hero" aria-hidden="true"><canvas></canvas></div>
      <div class="wrap nd-wrap">${headerSkeleton()}</div>
    </div>`;
  const page = ctx.el.firstElementChild;
  const hero = page.querySelector(".nd-hero");
  const wrap = page.querySelector(".nd-wrap");
  const painter = heroPainter(hero, page);

  let node;
  let summary;
  try {
    [node, summary] = await Promise.all([
      api(`/api/nodes/${pubkey}`, { signal: ctx.signal }),
      api(`/api/nodes/${pubkey}/summary?peers=${HERO_PEERS}`, { signal: ctx.signal }),
    ]);
  } catch (error) {
    painter.stop();
    if (isAbort(error) || !ctx.alive()) return undefined;
    if (error.status === 404 || error.status === 400) {
      notFound(ctx, "No node with this public key is in the current gossip snapshot. It may have closed all its channels.");
    } else {
      wrap.innerHTML = `<div class="notice warn nd-error" role="alert">${icon("alert")}<span>Could not load this node: ${esc(error.message)}</span></div>${siteFooter()}`;
    }
    return undefined;
  }
  if (!ctx.alive()) {
    painter.stop();
    return undefined;
  }

  const name = displayName(node.alias, node.pubkey);
  ctx.setTitle(name);
  const routeId = `nd-route-${pubkey.slice(0, 8)}`;
  wrap.innerHTML = `${header(node, routeId)}
    <div class="nd-route" id="${routeId}" hidden>${routeFinder({ open: true })}</div>
    <nav class="tabs nd-tabs" role="tablist" aria-label="Node sections">${TABS.map(
      ([key, label]) =>
        `<a role="tab" id="nd-tab-${key}" href="${esc(urlFor(key, 1))}" data-tab="${key}" aria-controls="nd-panel" aria-selected="${key === state.tab}"${key === state.tab ? ' class="on"' : ""}>${label}${key === "channels" ? `<span class="count">${int(node.num_channels)}</span>` : ""}</a>`,
    ).join("")}</nav>
    <section class="nd-panel" id="nd-panel" role="tabpanel" aria-labelledby="nd-tab-${state.tab}"></section>
    ${siteFooter()}`;
  painter.set(node, summary);

  const routeBox = wrap.querySelector(".nd-route");
  wireRouteFinder(routeBox, pubkey, ctx.signal);
  const panel = wrap.querySelector(".nd-panel");
  const tabs = wrap.querySelector(".nd-tabs");

  fillRankTags(wrap.querySelector(".nd-ranks"), node).then(() => ctx.alive() && painter.redraw());

  // Payloads are fetched once per mount and reused when switching tabs.
  const memo = new Map();
  const once = (key, load) => {
    if (!memo.has(key)) memo.set(key, load().catch((error) => {
      memo.delete(key);
      throw error;
    }));
    return memo.get(key);
  };
  const data = {
    stats: () => once("stats", () => cached("/api/stats", 300_000).catch(() => null)),
    topChannels: () => once("top", () => api(`/api/nodes/${pubkey}/channels?page=1&page_size=8`, { signal: ctx.signal })),
    channels: (n) => once(`ch${n}`, () => api(`/api/nodes/${pubkey}/channels?page=${n}&page_size=${PAGE_SIZE}`, { signal: ctx.signal })),
    ranks: () => once("ranks", () => api(`/api/nodes/${pubkey}/ranks?days=90`, { signal: ctx.signal })),
    events: () => once("events", () => api(`/api/nodes/${pubkey}/events?limit=100`, { signal: ctx.signal })),
  };

  let seq = 0;
  async function showTab() {
    seq += 1;
    const mine = seq;
    panel.setAttribute("aria-labelledby", `nd-tab-${state.tab}`);
    panel.innerHTML = panelSkeleton(state.tab);
    try {
      const html = await RENDERERS[state.tab]({ node, summary, data, state });
      if (mine !== seq || !ctx.alive()) return;
      panel.innerHTML = html;
    } catch (error) {
      if (isAbort(error) || mine !== seq || !ctx.alive()) return;
      panel.innerHTML = `<div class="empty-line" role="alert">${icon("alert")}${esc(error.message)}</div>`;
    }
  }

  function navigate(tab, pageNo) {
    state.tab = tab;
    state.page = tab === "channels" ? Math.max(1, pageNo || 1) : 1;
    setQuery(urlFor(state.tab, state.page, true), { replace: false });
    tabs.querySelectorAll("[data-tab]").forEach((a) => {
      const on = a.dataset.tab === state.tab;
      a.classList.toggle("on", on);
      a.setAttribute("aria-selected", String(on));
    });
    if (tabs.getBoundingClientRect().top < 0) tabs.scrollIntoView({ block: "start" });
    showTab();
  }

  function toggleRoute(open) {
    const btn = wrap.querySelector("[data-route-toggle]");
    routeBox.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      routeBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
      routeBox.querySelector("input")?.focus({ preventScroll: true });
    }
  }

  wrap.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const tabLink = event.target.closest("[data-tab]");
    if (tabLink) {
      event.preventDefault();
      const pageNo = Number(tabLink.dataset.page) || 1;
      if (tabLink.dataset.tab !== state.tab || pageNo !== state.page) navigate(tabLink.dataset.tab, pageNo);
      return;
    }
    if (event.target.closest("[data-route-toggle]")) toggleRoute(routeBox.hidden);
  });
  wrap.addEventListener("submit", (event) => {
    const form = event.target.closest(".nd-jump");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector("input");
    const target = Math.round(Number(input.value));
    const max = Number(input.max) || 1;
    if (Number.isFinite(target) && target >= 1 && target <= max && target !== state.page) navigate("channels", target);
  });
  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const links = [...tabs.querySelectorAll("[data-tab]")];
    const at = links.indexOf(document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    links[(at + (event.key === "ArrowRight" ? 1 : links.length - 1)) % links.length].focus();
  });

  showTab();
  return () => painter.stop();
}

/* ------------------------------------------------------------------ state */

function readState(params) {
  const tab = TABS.some(([key]) => key === params.get("tab")) ? params.get("tab") : "overview";
  const pageNo = Math.floor(Number(params.get("page")));
  return { tab, page: tab === "channels" && pageNo > 1 ? pageNo : 1 };
}

/** Query for a tab, keeping unrelated params (map density). Returns a "?…" string, or URLSearchParams when raw. */
function urlFor(tab, pageNo, raw = false) {
  const params = new URLSearchParams(location.search);
  params.delete("tab");
  params.delete("page");
  if (tab !== "overview") params.set("tab", tab);
  if (tab === "channels" && pageNo > 1) params.set("page", String(pageNo));
  if (raw) return params;
  const qs = params.toString();
  return `${location.pathname}${qs ? `?${qs}` : ""}`;
}

function notFound(ctx, message) {
  ctx.setTitle("Node not found");
  ctx.el.innerHTML = `<div class="page nd-page nd-missing">
      <section class="center-card glass" role="alert">
        ${icon("alert")}<h1>Node not found</h1><p>${esc(message)}</p>
        <a class="btn" href="${homeUrl()}">${icon("map")}Back to the map</a>
      </section>
    </div>`;
}

/* ------------------------------------------------------------------ header */

function headerSkeleton() {
  return `<header class="nd-head"><div class="nd-id">
      <span class="skel line" style="width:140px"></span>
      <span class="skel nd-skel-h1"></span>
      <span class="skel line" style="width:280px"></span>
      <span class="skel line" style="width:420px;max-width:100%"></span>
    </div></header>
    <div class="tabs nd-tabs">${TABS.map(([, label]) => `<span class="nd-tab-skel">${label}</span>`).join("")}</div>
    ${panelSkeleton("overview")}`;
}

function header(node, routeId) {
  const place = [node.city, node.country].filter(Boolean).map(esc).join(", ");
  const facts = [place, node.first_seen ? `announced since ${monthYear(node.first_seen)}` : ""].filter(Boolean).join(" · ");
  return `<header class="nd-head">
      <div class="nd-id">
        <div class="tags nd-ranks" hidden></div>
        <h1>${esc(displayName(node.alias, node.pubkey))}</h1>
        <div class="nd-meta">${protocolTags(node)}${facts ? `<span>${facts}</span>` : ""}</div>
        <div class="nd-key">${copyKey(node.pubkey, { full: true })}</div>
      </div>
      <div class="nd-actions">
        <button type="button" class="btn" data-route-toggle aria-expanded="false" aria-controls="${routeId}">${icon("route")}Find route</button>
        <button type="button" class="btn" data-copy="${esc(node.pubkey)}">${icon("copy")}Copy key</button>
        <a class="btn primary" href="${esc(homeUrl({ node: node.pubkey }))}">${icon("layers")}Show on map</a>
      </div>
    </header>`;
}

/** Rank tags: betweenness from the node itself, capacity/channels from the live top lists. */
async function fillRankTags(host, node) {
  const lists = await Promise.all(LIST_METRICS.map((metric) => rankList(metric)));
  const tags = [];
  if (node.betweenness_rank) tags.push(`<span class="tag acc">#${int(node.betweenness_rank)} betweenness</span>`);
  LIST_METRICS.forEach((metric, i) => {
    const rank = lists[i]?.get(node.pubkey);
    if (rank) tags.push(`<span class="tag">#${int(rank)} ${RANK_METRIC_LABELS[metric].toLowerCase()}</span>`);
  });
  if (!tags.length || !host.isConnected) return;
  host.innerHTML = tags.join("");
  host.hidden = false;
}

/** Map pubkey → current rank for the live top list of a metric, or null when unavailable. */
function rankList(metric) {
  return cached(`/api/rankings?metric=${metric}&limit=${RANK_LIST}`, 300_000)
    .then((payload) => new Map(payload.objects.map((row) => [row.pubkey, row.rank])))
    .catch(() => null);
}

/* ------------------------------------------------------------------ hero */

const ACCENT = "#1dfebb";

/** Peer spiral behind the header. Redraws on resize and once fonts are ready. */
function heroPainter(hero, page) {
  const canvas = hero.querySelector("canvas");
  let model = null;
  let frame = 0;
  let stopped = false;
  const draw = () => {
    frame = 0;
    if (stopped) return;
    const W = hero.clientWidth;
    const H = hero.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mobile = W < 720;
    const cx = mobile ? W * 0.56 : W * 0.7;
    const cy = mobile ? H * 0.36 : H * 0.47;
    backdrop(c, W, H, cx, cy);
    if (model) drawPeers(c, W, H, cx, cy, mobile, model, avoidRects(hero, page));
  };
  const redraw = () => {
    if (!frame && !stopped) frame = requestAnimationFrame(draw);
  };
  const observer = new ResizeObserver(redraw);
  observer.observe(hero);
  document.fonts?.ready.then(redraw);
  return {
    set(node, summary) {
      model = { node, summary };
      redraw();
    },
    redraw,
    stop() {
      stopped = true;
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    },
  };
}

function backdrop(c, W, H, cx, cy) {
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.75);
  g.addColorStop(0, "#0e1715");
  g.addColorStop(0.55, "#090c0b");
  g.addColorStop(1, "#070908");
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  c.fillStyle = "rgba(255,255,255,0.03)";
  for (let x = 14; x < W; x += 28) for (let y = 14; y < H; y += 28) c.fillRect(x, y, 1, 1);
}

/** Header blocks (and the top bar strip) that peer labels must not cover, in hero coordinates. */
function avoidRects(hero, page) {
  const origin = hero.getBoundingClientRect();
  const rects = [{ x: 0, y: 0, w: origin.width, h: 72 }];
  page.querySelectorAll(".nd-ranks:not([hidden]), .nd-head h1, .nd-meta, .nd-key, .nd-actions").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top - origin.top < origin.height) rects.push({ x: r.left - origin.left - 8, y: r.top - origin.top - 6, w: r.width + 16, h: r.height + 12 });
  });
  return rects;
}

const overlap = (a, b) => !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);

function placeLabel(c, text, x, y, r, boxes, W, H) {
  const t = text.length > 24 ? `${text.slice(0, 23)}…` : text;
  const w = c.measureText(t).width;
  const h = 16;
  const tries = [
    [x + r + 7, y - h / 2],
    [x - r - 7 - w, y - h / 2],
    [x - w / 2, y + r + 5],
    [x - w / 2, y - r - 5 - h],
  ];
  for (const [bx, by] of tries) {
    const box = { x: bx - 2, y: by - 2, w: w + 4, h: h + 4 };
    if (box.x < 10 || box.y < 10 || box.x + box.w > W - 10 || box.y + box.h > H - 10) continue;
    if (boxes.some((q) => overlap(box, q))) continue;
    boxes.push(box);
    c.lineJoin = "round";
    c.lineWidth = 4;
    c.strokeStyle = "rgba(7,9,8,0.9)";
    c.strokeText(t, bx, by + 12);
    c.fillStyle = "rgba(232,238,235,0.92)";
    c.fillText(t, bx, by + 12);
    return true;
  }
  return false;
}

function drawPeers(c, W, H, cx, cy, mobile, { node, summary }, avoid) {
  const sized = summary.peers;
  const total = Math.max(summary.peer_count || 0, sized.length);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const inner = mobile ? 38 : 50;
  const step = mobile ? 10 : 13.5;
  const scale = mobile ? 0.8 : 1;
  const at = (i) => {
    const rad = inner + step * Math.sqrt(i);
    const ang = i * golden - 0.6;
    return [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad];
  };
  const pts = sized.map((p, i) => {
    const [x, y] = at(i);
    const capBtc = (p.capacity || 0) / 1e8;
    return { x, y, r: capBtc > 0 ? Math.min(16, 1.5 + Math.sqrt(capBtc) * 0.95) * scale : 1.2, capBtc };
  });

  // Edges: faint for everyone, brighter for the eight largest peers.
  c.globalCompositeOperation = "lighter";
  c.lineWidth = 0.6;
  c.strokeStyle = "rgba(29,254,187,0.03)";
  c.beginPath();
  for (let i = 8; i < total; i += 1) {
    const [x, y] = i < pts.length ? [pts[i].x, pts[i].y] : at(i);
    c.moveTo(cx, cy);
    c.lineTo(x, y);
  }
  c.stroke();
  c.strokeStyle = "rgba(29,254,187,0.42)";
  c.lineWidth = 1;
  c.beginPath();
  pts.slice(0, 8).forEach((p) => {
    c.moveTo(cx, cy);
    c.lineTo(p.x, p.y);
  });
  c.stroke();
  c.globalCompositeOperation = "source-over";

  // Peers beyond the sized set: their capacity was not fetched, so they are uniform dots.
  c.fillStyle = "rgba(196,216,209,0.34)";
  c.beginPath();
  for (let i = pts.length; i < total; i += 1) {
    const [x, y] = at(i);
    if (x < -2 || y < -2 || x > W + 2 || y > H + 2) continue;
    c.moveTo(x + 1.1, y);
    c.arc(x, y, 1.1, 0, Math.PI * 2);
  }
  c.fill();
  pts.forEach((p, i) => {
    const t = Math.min(1, Math.log10(1 + p.capBtc) / 1.7);
    c.fillStyle = i < 8 ? "rgba(232,240,236,0.96)" : `rgba(196,216,209,${0.5 + 0.45 * t})`;
    c.beginPath();
    c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    c.fill();
  });

  const g = c.createRadialGradient(cx, cy, 0, cx, cy, 70);
  g.addColorStop(0, "rgba(29,254,187,0.28)");
  g.addColorStop(1, "rgba(29,254,187,0)");
  c.fillStyle = g;
  c.fillRect(cx - 70, cy - 70, 140, 140);
  c.fillStyle = ACCENT;
  c.beginPath();
  c.arc(cx, cy, 12 * scale, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = ACCENT;
  c.lineWidth = 1.5;
  c.beginPath();
  c.arc(cx, cy, 19 * scale, 0, Math.PI * 2);
  c.stroke();
  c.strokeStyle = "rgba(29,254,187,0.2)";
  c.lineWidth = 1;
  c.beginPath();
  c.arc(cx, cy, 30 * scale, 0, Math.PI * 2);
  c.stroke();

  c.font = '500 12px "IBM Plex Sans", system-ui, sans-serif';
  const boxes = [{ x: cx - 34, y: cy - 34, w: 68, h: 68 }, ...avoid];
  const want = mobile ? 4 : 8;
  let placed = 0;
  for (let i = 0; i < Math.min(pts.length, 20) && placed < want; i += 1) {
    if (placeLabel(c, displayName(sized[i].alias, sized[i].pubkey), pts[i].x, pts[i].y, pts[i].r, boxes, W, H)) placed += 1;
  }
}

/* ------------------------------------------------------------------ tabs */

const RENDERERS = { overview, channels, fees, rankings, history };

function panelSkeleton(tab) {
  if (tab === "overview") {
    return `<div class="nd-kpis">${'<div><span class="skel line" style="width:40%"></span><span class="skel num"></span><span class="skel line" style="width:60%"></span></div>'.repeat(4)}</div>
      <div class="nd-grid3">${'<div class="panel"><span class="skel line" style="width:40%"></span><span class="skel nd-skel-block"></span></div>'.repeat(3)}</div>`;
  }
  return `<div class="nd-tabbody">${'<span class="skel line"></span>'.repeat(6)}</div>`;
}

function kpi(label, value, sub) {
  return `<div><div class="lbl">${label}</div><div class="v">${value}</div><div class="sub">${sub}</div></div>`;
}

function rankText(rank) {
  return rank ? `#${int(rank)}` : "—";
}

async function overview({ node, summary, data }) {
  const [stats, top] = await Promise.all([data.stats(), data.topChannels()]);
  const centralSub = node.betweenness_rank
    ? `closeness ${rankText(node.closeness_rank)} · eigenvector ${rankText(node.eigenvector_rank)}`
    : node.metrics_ready
      ? "not ranked in this snapshot"
      : "still being computed";
  return `<div class="nd-kpis">
      ${kpi("Capacity", node.total_capacity ? `<span title="${int(node.total_capacity)} sats">${btc(node.total_capacity)}</span><small>BTC</small>` : "—", node.total_capacity ? `${int(node.total_capacity)} sats` : "capacity unknown")}
      ${kpi("Channels", int(node.num_channels), `${int(node.active_channels)} active · ${int(summary.peer_count)} peers`)}
      ${kpi("Median outgoing fee", node.med_out_ppm == null ? "—" : `${num(node.med_out_ppm, 1)}<small>ppm</small>`, `base ${baseFee(node.med_out_base)} · incoming ${ppm(node.med_in_ppm)}`)}
      ${kpi("Centrality", rankText(node.betweenness_rank), centralSub)}
    </div>
    <div class="nd-grid3">
      ${sizesPanel(node, summary.capacity_histogram)}
      <div class="panel"><div class="panel-h"><h3>Largest peers</h3><span class="lbl">BTC · channels</span></div>
        <div class="peers nd-peers">${peerRows(summary.peers, { limit: 8 })}</div>
        ${summary.peer_count > 8 ? `<div class="sub nd-foot-note">${int(summary.peer_count)} peers in total</div>` : ""}
      </div>
      ${feesPanel(node, stats)}
    </div>
    <div class="nd-grid2">
      <div class="panel nd-flush">
        <div class="panel-h"><h3>Largest channels</h3><a class="btn sm" href="${esc(urlFor("channels", 1))}" data-tab="channels">View all ${int(node.num_channels)}${icon("arrowR")}</a></div>
        ${top.objects.length ? `<div class="nd-scroll">${channelTable(top.objects, node, { compact: true })}</div>` : `<div class="empty-line nd-pad">${icon("node")}No public channels.</div>`}
      </div>
      <div class="nd-stack">
        ${centralityPanel(node)}
        ${addressesPanel(node)}
        ${factsPanel(node)}
      </div>
    </div>
    ${featuresPanel(node)}`;
}

function edgeLabel(sats) {
  if (sats >= 1e8) return `${num(sats / 1e8, 2)} BTC`;
  if (sats >= 1e6) return `${num(sats / 1e6, 1)}M`;
  return `${num(sats / 1e3, 0)}k`;
}

function sizesPanel(node, hist) {
  const known = hist.counts.reduce((a, b) => a + b, 0);
  const n = hist.counts.length;
  // Bucket i spans [edges[i-1], edges[i]), so edge j sits on the left side of bucket j+1.
  const ticks = hist.edges
    .map((edge, j) => [edge, j])
    .filter(([edge]) => Number.isInteger(Math.log10(edge)))
    .map(([edge, j]) => `<span style="left:${(((j + 1) / n) * 100).toFixed(2)}%">${edgeLabel(edge)}</span>`)
    .join("");
  const body = known
    ? `<div class="nd-hist">${histogram(hist.counts, { width: 410, height: 140, highlight: medianBucket(hist.counts), label: "Channel capacity distribution, sats" })}</div>
      <div class="nd-ticks mono sub" aria-hidden="true">${ticks}</div>
      <div class="sub nd-foot-note">Median channel ${btc(node.med_capacity)} BTC · largest ${btc(node.max_capacity)} BTC${hist.unknown ? ` · ${int(hist.unknown)} unknown` : ""}</div>`
    : `<div class="empty-line">${icon("chart")}Channel capacities are not known yet${hist.unknown ? ` (${int(hist.unknown)} channels)` : ""}.</div>`;
  return `<div class="panel"><div class="panel-h"><h3>Channel sizes</h3><span class="lbl">${int(known)} with known capacity</span></div>${body}</div>`;
}

function barRow(label, value, max, display, accent) {
  const width = value == null || !max ? 0 : Math.max(1.5, Math.min(100, (value / max) * 100));
  return `<div class="nd-barrow${accent ? " acc" : ""}"><span class="ellipsis">${label}</span><span class="bar${accent ? " acc" : ""}"><i style="width:${width.toFixed(1)}%"></i></span><span class="mono">${display}</span></div>`;
}

function feesPanel(node, stats) {
  const net = stats?.median_fee_rate_ppm ?? null;
  const netBase = stats?.median_base_fee_msat ?? null;
  const rateMax = Math.max(1, node.med_out_ppm || 0, node.med_in_ppm || 0, net || 0) * 1.1;
  const baseMax = Math.max(1, node.med_out_base || 0, node.med_in_base || 0, netBase || 0) * 1.1;
  let sentence = "";
  if (node.med_out_ppm != null && net) {
    const ratio = node.med_out_ppm / net;
    if (ratio >= 1.15) sentence = `Routing out costs ${num(ratio, 1)}× the network median.`;
    else if (ratio <= 0.87) sentence = `Routing out costs ${ratio < 0.05 ? "almost nothing" : `${num(ratio * 100)}% of the network median`}.`;
    else sentence = "Outgoing fees sit at about the network median.";
  }
  return `<div class="panel"><div class="panel-h"><h3>Fees vs network</h3><span class="lbl">medians</span></div>
      <div class="lbl nd-minor">Fee rate, ppm</div>
      ${barRow("Outgoing", node.med_out_ppm, rateMax, num(node.med_out_ppm, 1), true)}
      ${barRow("Incoming", node.med_in_ppm, rateMax, num(node.med_in_ppm, 1), false)}
      ${barRow("Network", net, rateMax, num(net, 1), false)}
      <div class="hr nd-hr"></div>
      <div class="lbl nd-minor">Base fee</div>
      ${barRow("Outgoing", node.med_out_base, baseMax, baseFee(node.med_out_base), false)}
      ${barRow("Incoming", node.med_in_base, baseMax, baseFee(node.med_in_base), false)}
      ${barRow("Network", netBase, baseMax, baseFee(netBase), false)}
      ${sentence ? `<div class="sub nd-foot-note">${sentence}</div>` : ""}
    </div>`;
}

function channelState(ch) {
  if (!ch.outgoing && !ch.incoming) return `<span class="tag">No policy</span>`;
  const outOff = !!ch.outgoing?.disabled;
  const inOff = !!ch.incoming?.disabled;
  if (outOff && inOff) return `<span class="tag neg">Disabled</span>`;
  if (outOff) return `<span class="tag warn" title="This node disabled its side">Disabled out</span>`;
  if (inOff) return `<span class="tag warn" title="The peer disabled its side">Disabled in</span>`;
  return `<span class="tag acc">Active</span>`;
}

function channelTable(rows, node, { compact = false } = {}) {
  const max = Math.max(1, node.max_capacity || 0, ...rows.map((r) => r.capacity || 0));
  return `<table class="dtable nd-table">
      <thead><tr>
        <th scope="col">Peer</th><th scope="col">Channel</th><th scope="col" class="r">Capacity</th>
        <th scope="col" class="r">Out ppm</th>${compact ? "" : '<th scope="col" class="r">Out base</th>'}<th scope="col" class="r">In ppm</th><th scope="col" class="r">State</th>
      </tr></thead>
      <tbody>${rows
        .map((ch) => {
          const peerName = displayName(ch.peer_alias, ch.peer_pubkey);
          let cap = `<span class="mono muted" title="Capacity not known yet">—</span>`;
          if (ch.capacity && compact) cap = `<span class="mono">${btcHtml(ch.capacity, false)}</span>`;
          else if (ch.capacity) cap = `<div class="capcell"><span class="bar"><i style="width:${Math.max(2, (ch.capacity / max) * 100).toFixed(1)}%"></i></span><span class="mono">${btcHtml(ch.capacity, false)}</span></div>`;
          return `<tr>
            <td><div class="nd-peercell">
              <a class="name" href="/node/${esc(ch.peer_pubkey)}"><b>${esc(peerName)}</b>${compact ? "" : `<span>${esc(shortKey(ch.peer_pubkey))}</span>`}</a>
              ${compact ? "" : `<a class="btn sm icon ghost" href="${esc(homeUrl({ node: ch.peer_pubkey }))}" aria-label="Show ${esc(peerName)} on the map" title="Show on map">${icon("map")}</a>`}
            </div></td>
            <td><a class="mono nd-scid" href="/channel/${esc(ch.scid)}">${esc(ch.short_id)}</a></td>
            <td class="r">${cap}</td>
            <td class="r mono">${ch.outgoing ? int(ch.outgoing.fee_rate_ppm) : "—"}</td>
            ${compact ? "" : `<td class="r mono">${ch.outgoing ? baseFee(ch.outgoing.base_fee_msat) : "—"}</td>`}
            <td class="r mono text-2">${ch.incoming ? int(ch.incoming.fee_rate_ppm) : "—"}</td>
            <td class="r">${channelState(ch)}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;
}

function centralityPanel(node) {
  const rows = [
    ["Betweenness", node.betweenness_rank, node.betweenness_weighted_rank],
    ["Closeness", node.closeness_rank, node.closeness_weighted_rank],
    ["Eigenvector", node.eigenvector_rank, node.eigenvector_weighted_rank],
  ];
  return `<div class="panel"><div class="panel-h"><h3>Centrality</h3>
      <details class="info right"><summary aria-label="About centrality ranks">${icon("info")}</summary><div>
        <p>Rank 1 is the most central node. Betweenness and closeness are sampled from this snapshot; eigenvector uses the whole graph.</p>
        <p>Weighted ranks prefer paths over high-capacity channels.</p>
        <p>${node.metrics_ready ? "Ranks are ready for the current snapshot." : "Ranks for the current snapshot are still being computed."}</p>
      </div></details></div>
      <table class="nd-kv-table"><thead><tr><th scope="col"><span class="sr-only">Metric</span></th><th scope="col" class="r">Rank</th><th scope="col" class="r">Weighted</th></tr></thead>
        <tbody>${rows.map(([label, rank, weighted]) => `<tr><th scope="row">${label}</th><td class="r mono">${rankText(rank)}</td><td class="r mono text-2">${rankText(weighted)}</td></tr>`).join("")}</tbody></table>
      ${node.metrics_ready ? "" : '<div class="sub nd-foot-note">Still being computed for this snapshot.</div>'}
    </div>`;
}

function addressKind(address) {
  if (/\.onion(:\d+)?$/i.test(address)) return "Tor";
  if (address.startsWith("[") || (address.match(/:/g) || []).length > 1) return "IPv6";
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(address)) return "IPv4";
  return "DNS";
}

function addressesPanel(node) {
  const list = node.addresses || [];
  return `<div class="panel"><div class="panel-h"><h3>Addresses</h3><span class="lbl">${int(list.length)}</span></div>
      ${list.length
        ? `<ul class="nd-lines">${list.map((a) => `<li><span class="tag">${addressKind(a)}</span>${copyKey(a, { full: true })}</li>`).join("")}</ul>`
        : `<div class="empty-line">${icon("node")}No announced addresses.</div>`}
    </div>`;
}

function connectivity(node) {
  const clearnet = node.ipv4 || node.ipv6;
  if (clearnet && node.tor) return "Clearnet and Tor";
  if (clearnet) return "Clearnet only";
  if (node.tor) return "Tor only";
  return "None announced";
}

function factsPanel(node) {
  const source = node.capacity_source === "mempool" ? "mempool.space" : node.capacity_source || "Unknown";
  const color = /^#[0-9a-f]{6}$/i.test(node.color || "") ? node.color : "";
  return `<div class="panel"><div class="panel-h"><h3>Node</h3></div>
      <dl class="nd-dl">
        <div><dt>Connectivity</dt><dd>${connectivity(node)}</dd></div>
        <div><dt>Capacity source</dt><dd>${esc(source)}</dd></div>
        <div><dt>First seen</dt><dd class="mono">${date(node.first_seen)}</dd></div>
        <div><dt>Color</dt><dd>${color ? `<span class="nd-swatch" style="background:${color}"></span><span class="mono">${esc(color)}</span>` : "—"}</dd></div>
      </dl>
    </div>`;
}

function featuresPanel(node) {
  const list = node.features || [];
  return `<div class="panel nd-features"><div class="panel-h"><h3>Features</h3><span class="lbl">${list.length ? `${int(list.length)} announced · <b class="nd-req">*</b> required` : ""}</span></div>
      ${list.length
        ? `<div class="tags">${list
            .map(
              (f) =>
                `<span class="tag${f.name === LARGE_CHANNEL_FEATURE ? " acc" : ""}" title="bit ${int(f.bit)} (${f.required ? "required" : "optional"})">${esc(f.name)}${f.required ? '<b class="nd-req" aria-label="required">*</b>' : ""}</span>`,
            )
            .join("")}</div>`
        : `<div class="empty-line">${icon("info")}Features unknown: this node's announcement has not been seen yet.</div>`}
    </div>`;
}

async function channels({ node, data, state }) {
  const payload = await data.channels(state.page);
  if (!payload.objects.length) {
    if (payload.total_count && state.page > payload.pages) {
      return `<div class="empty-line nd-tabbody">${icon("list")}Page ${int(state.page)} is past the end.&nbsp;<a class="text-2" href="${esc(urlFor("channels", payload.pages))}" data-tab="channels" data-page="${payload.pages}">Go to page ${int(payload.pages)}</a></div>`;
    }
    return `<div class="empty-line nd-tabbody">${icon("node")}No public channels.</div>`;
  }
  const pageLink = (n, label, aria) =>
    n >= 1 && n <= payload.pages && n !== payload.page
      ? `<a class="btn sm" href="${esc(urlFor("channels", n))}" data-tab="channels" data-page="${n}" aria-label="${aria}">${label}</a>`
      : `<button type="button" class="btn sm" disabled aria-label="${aria}">${label}</button>`;
  const first = (payload.page - 1) * payload.page_size + 1;
  const last = first + payload.objects.length - 1;
  return `<div class="nd-tabbody">
      <div class="nd-scroll">${channelTable(payload.objects, node)}</div>
      <nav class="pager nd-pager" aria-label="Channel pages">
        <span>${int(first)}–${int(last)} of ${int(payload.total_count)} · largest first</span>
        <span class="sp"></span>
        ${pageLink(payload.page - 1, `${icon("chevL")}Previous`, "Previous page")}
        <form class="nd-jump"><label>Page <input class="input sm mono" type="number" inputmode="numeric" min="1" max="${payload.pages}" value="${payload.page}" aria-label="Page number" /></label><span>of ${int(payload.pages)}</span></form>
        ${pageLink(payload.page + 1, `Next${icon("chevR")}`, "Next page")}
      </nav>
    </div>`;
}

function statTable(title, unit, rows) {
  const withNet = rows.some((r) => r.length > 2);
  return `<section class="nd-stat">
      <h3>${title}${unit ? ` <span class="lbl">${unit}</span>` : ""}</h3>
      <table class="nd-kv-table">
        <thead><tr><th scope="col"><span class="sr-only">Statistic</span></th><th scope="col" class="r">This node</th>${withNet ? '<th scope="col" class="r">Network</th>' : ""}</tr></thead>
        <tbody>${rows.map(([label, value, net]) => `<tr><th scope="row">${label}</th><td class="r mono">${value}</td>${withNet ? `<td class="r mono text-2">${net ?? "—"}</td>` : ""}</tr>`).join("")}</tbody>
      </table>
    </section>`;
}

async function fees({ node, data }) {
  const stats = await data.stats();
  const rate = (v) => num(v, 1);
  const net = {
    avgPpm: stats ? rate(stats.average_fee_rate_ppm) : null,
    medPpm: stats ? rate(stats.median_fee_rate_ppm) : null,
    avgBase: stats ? baseFee(Math.round(stats.average_base_fee_msat)) : null,
    medBase: stats ? baseFee(stats.median_base_fee_msat) : null,
  };
  return `<div class="nd-tabbody">
      <div class="nd-stats">
        ${statTable("Outgoing fee rate", "ppm", [["Average", rate(node.avg_out_ppm), net.avgPpm], ["Median", rate(node.med_out_ppm), net.medPpm], ["Maximum", int(node.max_out_ppm)]])}
        ${statTable("Incoming fee rate", "ppm", [["Average", rate(node.avg_in_ppm), net.avgPpm], ["Median", rate(node.med_in_ppm), net.medPpm]])}
        ${statTable("Channel capacity", "BTC", [["Average", btcHtml(node.avg_capacity, false)], ["Median", btcHtml(node.med_capacity, false)], ["Maximum", btcHtml(node.max_capacity, false)]])}
        ${statTable("Outgoing base fee", "", [["Average", baseFee(round(node.avg_out_base)), net.avgBase], ["Median", baseFee(round(node.med_out_base)), net.medBase], ["Maximum", baseFee(node.max_out_base)]])}
        ${statTable("Incoming base fee", "", [["Average", baseFee(round(node.avg_in_base)), net.avgBase], ["Median", baseFee(round(node.med_in_base)), net.medBase]])}
      </div>
      <p class="sub nd-note">${icon("info")}<span>Outgoing fees are what this node charges to forward; incoming fees are what its peers charge to forward into it. Averages and medians of fee fields drop far-out outliers (Tukey fences); maxima stay raw. The network column covers every announced channel policy.</span></p>
    </div>`;
}

function round(v) {
  return v == null ? v : Math.round(v);
}

async function rankings({ node, data }) {
  const [payload, ...lists] = await Promise.all([data.ranks(), ...LIST_METRICS.map((metric) => rankList(metric))]);
  const series = payload.series || {};
  const hasHistory = Object.values(series).some((points) => points.length > 0);
  const current = (metric) => {
    const i = LIST_METRICS.indexOf(metric);
    if (i >= 0) {
      const rank = lists[i]?.get(node.pubkey);
      return rank ? `#${int(rank)}` : `<span class="muted" title="Only the top ${RANK_LIST} are ranked live">outside top ${RANK_LIST}</span>`;
    }
    return rankText(node[`${metric}_rank`]);
  };
  const rows = Object.entries(RANK_METRIC_LABELS)
    .map(([metric, label]) => {
      const points = series[metric] || [];
      const ranks = points.map((p) => p.rank);
      let trend = "";
      if (hasHistory) {
        const change = ranks.length > 1 ? ranks[0] - ranks[ranks.length - 1] : null;
        trend = `<td class="nd-spark">${ranks.length > 1 ? sparkline(ranks, { width: 160, height: 22, invert: true }) : '<span class="sub">—</span>'}</td>
          <td class="r mono">${change ? `<span class="${change > 0 ? "up" : "down"}">${change > 0 ? "▲" : "▼"} ${int(Math.abs(change))}</span>` : change === 0 ? '<span class="muted">·</span>' : "—"}</td>
          <td class="r mono text-2">${ranks.length ? `#${int(Math.min(...ranks))}` : "—"}</td>
          <td class="r mono sub"${points.length ? ` title="${isoDay(points[0].day)} → ${isoDay(points[points.length - 1].day)}"` : ""}>${int(points.length)}</td>`;
      }
      return `<tr><th scope="row"><a href="/rankings?metric=${metric}">${label}</a></th><td class="r mono">${current(metric)}</td>${trend}</tr>`;
    })
    .join("");
  return `<div class="nd-tabbody">
      <div class="nd-scroll"><table class="nd-kv-table nd-ranktable">
        <thead><tr><th scope="col">Metric</th><th scope="col" class="r">Current</th>${hasHistory ? '<th scope="col">90 days</th><th scope="col" class="r">Change</th><th scope="col" class="r">Best</th><th scope="col" class="r">Days</th>' : ""}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${hasHistory
        ? `<p class="sub nd-note">${icon("info")}<span>Daily snapshots of the rank, rank 1 is best; ▲ means the node climbed. (w) = capacity-weighted.</span></p>`
        : `<div class="empty-line">${icon("clock")}No rank history yet: daily ranks are stored from the first snapshot and trends appear after two days.</div>`}
    </div>`;
}

function nodeLink(pubkey, alias) {
  return `<a href="/node/${esc(pubkey)}">${esc(displayName(alias, pubkey))}</a>`;
}

function parseList(value) {
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function eventItem(ev, pubkey) {
  const label = EVENT_KIND_LABELS[ev.kind] || ev.kind;
  const tone = ev.kind === "channel_close" ? "neg" : CHANNEL_EVENT_KINDS.has(ev.kind) ? "acc" : "idle";
  const otherKey = ev.pubkey === pubkey ? ev.peer : ev.pubkey;
  const otherAlias = ev.pubkey === pubkey ? ev.peer_alias : ev.pubkey_alias;
  const channel = ev.scid ? `<a class="mono nd-scid" href="/channel/${esc(ev.scid)}">${esc(ev.short_id)}</a>` : "";
  let body = "";
  if (CHANNEL_EVENT_KINDS.has(ev.kind)) {
    body = `${otherKey ? `with ${nodeLink(otherKey, otherAlias)}` : ""}<span class="mono text-2">${btcHtml(ev.capacity)}</span>`;
  } else if (ev.kind === "policy_fee") {
    const fmt = ev.field === "ppm" ? (v) => ppm(v) : (v) => baseFee(v);
    const side = ev.pubkey === pubkey ? `Outgoing ${ev.field === "ppm" ? "rate" : "base fee"} toward ${nodeLink(ev.peer, ev.peer_alias)}` : `${nodeLink(ev.pubkey, ev.pubkey_alias)} changed its ${ev.field === "ppm" ? "rate" : "base fee"} toward this node`;
    body = `${side}<span class="mono text-2">${fmt(ev.old)} → ${fmt(ev.new)}</span>`;
  } else if (ev.kind === "color") {
    const swatch = (c) => (/^#[0-9a-f]{6}$/i.test(c || "") ? `<span class="nd-swatch" style="background:${c}"></span>` : "");
    body = `<span class="mono text-2">${swatch(ev.old)}${esc(ev.old)} → ${swatch(ev.new)}${esc(ev.new)}</span>`;
  } else if (ev.kind === "addresses") {
    const before = parseList(ev.old);
    const after = parseList(ev.new);
    const added = after.filter((a) => !before.includes(a));
    const removed = before.filter((a) => !after.includes(a));
    body = [...added.map((a) => `<span class="mono up">+ ${esc(a)}</span>`), ...removed.map((a) => `<span class="mono down">− ${esc(a)}</span>`)].join("");
  } else {
    body = `<span class="text-2">${esc(ev.old)} → ${esc(ev.new)}</span>`;
  }
  return `<li class="nd-ev">
      <time class="mono sub" datetime="${new Date(ev.ts * 1000).toISOString()}" title="${esc(relTime(ev.ts))}">${esc(dateTime(ev.ts).replace(/^.*?, /, ""))}</time>
      <span class="dot ${tone === "acc" ? "" : tone}"></span>
      <div class="nd-ev-body"><b>${esc(label)}</b>${body}${channel}</div>
    </li>`;
}

async function history({ node, data }) {
  const { events } = await data.events();
  if (!events.length) {
    return `<div class="nd-tabbody"><div class="empty-line">${icon("clock")}No recorded events yet: opens, closes, fee changes and alias or address changes appear after the next snapshot diff.</div></div>`;
  }
  const groups = [];
  for (const ev of events) {
    const day = isoDay(ev.ts);
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, ts: ev.ts, items: [] });
    groups[groups.length - 1].items.push(ev);
  }
  return `<div class="nd-tabbody">
      <ol class="nd-timeline">${groups
        .map((g) => `<li class="nd-day"><h3 class="lbl">${date(g.ts)}</h3><ol>${g.items.map((ev) => eventItem(ev, node.pubkey)).join("")}</ol></li>`)
        .join("")}</ol>
      ${events.length >= 100 ? `<p class="sub nd-note">${icon("info")}<span>Showing the latest 100 events.</span></p>` : ""}
    </div>`;
}
