// "/rankings" — live top 100 per metric with rank changes, as a left sheet over the map.
import { api, isAbort } from "../lib/api.js";
import { sparkline } from "../lib/charts.js";
import { btcHtml, date, esc, int, num, shortKey } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { go, homeUrl, setQuery } from "../lib/router.js";
import { map } from "../map/map.js";
import { openSheet } from "../ui/sheet.js";

const LABELS = {
  total_capacity: "Capacity",
  num_channels: "Channels",
  betweenness: "Betweenness",
  betweenness_weighted: "Betweenness (w)",
  closeness: "Closeness",
  closeness_weighted: "Closeness (w)",
  eigenvector: "Eigenvector",
  eigenvector_weighted: "Eigenvector (w)",
};
const BASES = ["total_capacity", "num_channels", "betweenness", "closeness", "eigenvector"];
const DEFAULT_METRIC = "total_capacity";
const LIMIT = 100;
const MOVER_DAYS = 7;
const MOVER_LIMIT = 5;

const baseOf = (metric) => metric.replace(/_weighted$/, "");
const isCentrality = (metric) => metric !== "total_capacity" && metric !== "num_channels";
const lowerLabel = (metric) =>
  isCentrality(metric) && metric.endsWith("_weighted")
    ? `${LABELS[baseOf(metric)].toLowerCase()} (capacity-weighted)`
    : LABELS[metric].toLowerCase();

function valueHeader(metric) {
  if (metric === "total_capacity") return "Capacity, BTC";
  if (metric === "num_channels") return "Channels";
  return "Score";
}

function value(metric, v) {
  if (metric === "total_capacity") return btcHtml(v, false);
  if (metric === "num_channels") return int(v);
  return num(v, 3);
}

function delta(change, { since } = {}) {
  if (change === null || change === undefined) {
    return `<span class="rk-new" title="Outside the stored top list ${since}">new</span>`;
  }
  if (change === 0) return `<span class="rk-same" title="Unchanged ${since}">–</span>`;
  const up = change > 0;
  const n = int(Math.abs(change));
  const title = `${up ? "Climbed" : "Fell"} ${n} place${Math.abs(change) === 1 ? "" : "s"}${since ? ` ${since}` : ""}`;
  return `<span class="${up ? "up" : "down"}" title="${title}"><span aria-hidden="true">${up ? "▲" : "▼"}</span><span class="sr-only">${up ? "up " : "down "}</span>${n}</span>`;
}

const SPANS = [
  [1, "rank_change_1d", "since yesterday"],
  [7, "rank_change_7d", "over 7 days"],
  [30, "rank_change_30d", "over 30 days"],
];

function nodeName(alias, pubkey) {
  return `<a class="name" href="/node/${esc(pubkey)}"><b>${esc(alias || shortKey(pubkey))}</b><span>${esc(shortKey(pubkey))}</span></a>`;
}

function tableHtml(payload) {
  const { metric, objects } = payload;
  const changes = objects.some((row) => SPANS.some(([, key]) => row[key] !== null && row[key] !== undefined));
  const sparks = objects.some((row) => (row.history || []).length > 1);
  const max = Math.max(...objects.map((row) => Number(row.value) || 0));
  const width = (v) => (max > 0 ? Math.max(0, ((Number(v) || 0) / max) * 100).toFixed(1) : 0);
  const head = `<tr>
      <th class="r rk-rank" scope="col">#</th>
      <th scope="col">Node</th>
      <th class="r rk-val" scope="col">${valueHeader(metric)}</th>
      ${changes ? SPANS.map(([days]) => `<th class="r rk-chg rk-d${days}" scope="col">${days}d</th>`).join("") : ""}
      ${sparks ? '<th class="rk-spark" scope="col"><span class="rk-long">90-day rank</span><span class="rk-short" aria-hidden="true">90d</span></th>' : ""}
    </tr>`;
  const rows = objects
    .map(
      (row) => `<tr class="rowlink" tabindex="0" data-pk="${esc(row.pubkey)}">
        <td class="r mono rk-rank">${int(row.rank)}</td>
        <td>${nodeName(row.alias, row.pubkey)}</td>
        <td class="rk-val"><span class="capcell"><span class="bar"><i style="width:${width(row.value)}%"></i></span><span class="mono">${value(metric, row.value)}</span></span></td>
        ${changes ? SPANS.map(([days, key, since]) => `<td class="r mono rk-chg rk-d${days}">${delta(row[key], { since })}</td>`).join("") : ""}
        ${sparks ? `<td class="rk-spark">${sparkline(row.history, { width: 84, height: 20, invert: true })}</td>` : ""}
      </tr>`
    )
    .join("");
  return `<table class="dtable rk-table">
      <caption class="sr-only">Top ${LIMIT} nodes by ${esc(lowerLabel(metric))}. Select a row to show the node on the map.</caption>
      <thead>${head}</thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function moverList(rows, kind) {
  if (!rows.length) return `<p class="empty-line">No ${kind} in this window.</p>`;
  return `<ol class="rk-mlist">${rows
    .map(
      (row) => `<li><a class="rk-mrow" href="/node/${esc(row.pubkey)}" data-pk="${esc(row.pubkey)}">
        <span class="n ellipsis">${esc(row.alias || shortKey(row.pubkey))}</span>
        ${delta(row.change, { since: `from #${int(row.previous_rank)}` })}
        <span class="mono rk-mrank" title="Current rank">#${int(row.rank)}</span>
      </a></li>`
    )
    .join("")}</ol>`;
}

function moversHtml(payload, movers) {
  const climbers = (movers?.climbers || []).filter((row) => row.change > 0);
  const fallers = (movers?.fallers || []).filter((row) => row.change < 0);
  const windowed = movers && movers.from_day && movers.to_day && movers.to_day > movers.from_day;
  if (!windowed) {
    const since = payload.days.first ? `history since ${date(payload.days.first)}` : "none stored yet";
    return `<p class="empty-line rk-note">${icon("clock")}<span>Rank changes appear after a few daily snapshots — ${since}.</span></p>`;
  }
  if (!climbers.length && !fallers.length) {
    return `<p class="empty-line rk-note">${icon("clock")}<span>No rank changes between ${date(movers.from_day)} and ${date(movers.to_day)}.</span></p>`;
  }
  return `<section class="rk-movers" aria-label="Biggest rank changes over ${MOVER_DAYS} days">
      <div class="rk-mov"><div class="sect-h"><b>Climbers</b><span class="lbl">${MOVER_DAYS} days</span></div>${moverList(climbers, "climbers")}</div>
      <div class="rk-mov"><div class="sect-h"><b>Fallers</b><span class="lbl">${MOVER_DAYS} days</span></div>${moverList(fallers, "fallers")}</div>
    </section>`;
}

function infoHtml(payload, movers) {
  const days = payload.days.first
    ? `Daily snapshots stored from ${date(payload.days.first)} to ${date(payload.days.last)}.`
    : "No daily snapshots stored yet; the first is written after today's metrics run.";
  const window =
    movers && movers.from_day && movers.to_day
      ? ` Currently ${date(movers.from_day)} → ${date(movers.to_day)}.`
      : "";
  return `<details class="info rk-info">
      <summary aria-label="How rankings are computed">${icon("info")}</summary>
      <div>
        <p>The live top ${LIMIT}, recomputed with every graph refresh. Centrality: betweenness counts shortest paths through a node, closeness is harmonic closeness, eigenvector rewards links to well-connected nodes. Weighted variants use capacity-weighted path lengths.</p>
        <p>1d, 7d and 30d compare the current rank with the stored daily snapshot from that many days ago (▲ climbed, ▼ fell). “new” means the node was outside the stored top list that day. The sparkline shows the last 90 daily ranks; higher is better.</p>
        <p>Climbers and fallers compare the latest snapshot with the one ${MOVER_DAYS} days earlier, among nodes present in both.${window}</p>
        <p>${days}</p>
      </div>
    </details>`;
}

function skeletonHtml() {
  const row = `<tr><td class="r"><span class="skel line rk-sk-rank"></span></td><td><span class="skel line rk-sk-name"></span><span class="skel line rk-sk-key"></span></td><td class="r"><span class="skel line rk-sk-val"></span></td></tr>`;
  return `<p class="empty-line rk-note"><span class="skel line rk-sk-note"></span></p>
    <table class="dtable rk-table" aria-hidden="true"><tbody>${row.repeat(12)}</tbody></table>`;
}

export async function mount(ctx) {
  ctx.setTitle("Rankings");
  const sheet = openSheet(ctx.el, { title: "Rankings", placement: "left", width: 820 });
  map.setInsets(sheet.insets());
  map.clear();
  map
    .ensure()
    .then(() => {
      if (!ctx.alive()) return;
      map.clear();
      map.frame();
    })
    .catch(() => {});

  const requested = ctx.route.params.get("metric") || DEFAULT_METRIC;
  let metric = LABELS[requested] ? requested : DEFAULT_METRIC;
  let metrics = ["total_capacity", "num_channels"];
  let weightedPref = metric.endsWith("_weighted");
  let loader = null;

  sheet.body.innerHTML = `<div class="rk-bar"></div><div class="rk-content" aria-live="polite"></div>`;
  const bar = sheet.body.querySelector(".rk-bar");
  const content = sheet.body.querySelector(".rk-content");

  function renderSub(payload, movers) {
    sheet.sub.innerHTML = `<span class="rk-sub">Top ${LIMIT} by ${esc(lowerLabel(metric))}</span>${payload ? infoHtml(payload, movers) : ""}`;
  }

  function renderBar() {
    const available = new Set([...metrics, metric]);
    const bases = BASES.filter((base) => available.has(base) || available.has(`${base}_weighted`));
    const hasWeighted = [...available].some((name) => name.endsWith("_weighted"));
    const weighted = metric.endsWith("_weighted");
    bar.innerHTML = `<div class="seg" role="group" aria-label="Ranking metric">${bases
      .map(
        (base) =>
          `<button type="button" data-base="${base}" aria-pressed="${baseOf(metric) === base}">${LABELS[base]}</button>`
      )
      .join("")}</div>${
      hasWeighted
        ? `<button type="button" class="chip${weighted ? " on" : ""}" data-weighted aria-pressed="${weighted}"${
            isCentrality(metric) ? "" : " disabled"
          } title="Rank centrality by capacity-weighted path lengths">Weighted</button>`
        : ""
    }`;
  }

  function pick(base) {
    if (!isCentrality(base)) return base;
    const available = new Set([...metrics, metric]);
    const weighted = `${base}_weighted`;
    if (weightedPref && available.has(weighted)) return weighted;
    return available.has(base) ? base : weighted;
  }

  function setMetric(next) {
    if (next === metric) return;
    metric = next;
    const params = new URLSearchParams(location.search);
    if (metric === DEFAULT_METRIC) params.delete("metric");
    else params.set("metric", metric);
    setQuery(params);
    renderBar();
    load();
  }

  async function load() {
    loader?.abort();
    const controller = new AbortController();
    loader = controller;
    const signal = controller.signal;
    renderSub(null);
    content.setAttribute("aria-busy", "true");
    content.innerHTML = skeletonHtml();
    map.preview(null);
    const query = `metric=${encodeURIComponent(metric)}`;
    try {
      const [payload, movers] = await Promise.all([
        api(`/api/rankings?${query}&limit=${LIMIT}`, { signal }),
        api(`/api/rankings/movers?${query}&days=${MOVER_DAYS}&limit=${MOVER_LIMIT}`, { signal }).catch((error) => {
          if (isAbort(error)) throw error;
          return null;
        }),
      ]);
      if (!ctx.alive() || signal.aborted) return;
      metric = payload.metric;
      metrics = payload.metrics;
      renderBar();
      renderSub(payload, movers);
      if (!payload.objects.length) {
        content.innerHTML = `<p class="empty-line rk-note">${icon("clock")}<span>${
          isCentrality(metric) ? "Centrality ranks are still being computed." : "No nodes yet."
        }</span></p>`;
      } else {
        content.innerHTML = moversHtml(payload, movers) + tableHtml(payload);
      }
    } catch (error) {
      if (isAbort(error) || !ctx.alive() || signal.aborted) return;
      renderSub(null);
      content.innerHTML = `<div class="notice warn rk-error">${icon("alert")}<span>Rankings could not load: ${esc(error.message)}</span></div>`;
    } finally {
      if (loader === controller) content.removeAttribute("aria-busy");
    }
  }

  bar.addEventListener("click", (event) => {
    const base = event.target.closest("[data-base]");
    if (base) return setMetric(pick(base.dataset.base));
    if (event.target.closest("[data-weighted]")) {
      weightedPref = !metric.endsWith("_weighted");
      setMetric(pick(baseOf(metric)));
    }
  });

  const previewFrom = (event) => {
    const target = event.target.closest("[data-pk]");
    map.preview(target ? target.dataset.pk : null);
  };
  content.addEventListener("mouseover", previewFrom);
  content.addEventListener("focusin", previewFrom);
  content.addEventListener("mouseleave", () => map.preview(null));
  content.addEventListener("focusout", (event) => {
    if (!content.contains(event.relatedTarget)) map.preview(null);
  });
  content.addEventListener("click", (event) => {
    if (event.target.closest("a, button")) return;
    const row = event.target.closest("tr[data-pk]");
    if (row) go(homeUrl({ node: row.dataset.pk }));
  });
  content.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target.tagName !== "TR" || !event.target.dataset.pk) return;
    event.preventDefault();
    go(homeUrl({ node: event.target.dataset.pk }));
  });

  const onResize = () => map.setInsets(sheet.insets());
  window.addEventListener("resize", onResize);
  ctx.signal.addEventListener("abort", () => loader?.abort());

  renderBar();
  renderSub(null);
  load();

  return () => {
    window.removeEventListener("resize", onResize);
    loader?.abort();
    map.preview(null);
  };
}
