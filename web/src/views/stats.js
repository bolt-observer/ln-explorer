// "/stats" — network dashboard as a bottom sheet over the dimmed map.
// `?metric=capacity|channels|nodes|fees`, `?range=1y|3y|all`, `?cap=btc|usd`.
import { api, isAbort } from "../lib/api.js";
import { baseFee, btcHtml, date, dateTime, displayName, esc, int, isoDay, num, relTime } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { homeUrl, setQuery } from "../lib/router.js";
import { map } from "../map/map.js";
import { openSheet } from "../ui/sheet.js";

// mempool.space's backends have gaps of weeks; lines never bridge more than this.
const HISTORY_GAP = 10 * 86400;
// Fee history sources from /api/fees/history, oldest first; `cls` picks the stroke colour.
const FEE_SOURCES = {
  lnresearch: { cls: "fs-a", short: "lnresearch archive" },
  "gossip-archive": { cls: "fs-b", short: "gossip archive" },
  live: { cls: "fs-live", short: "this explorer" },
};
const DAY = 86400;
const FLOW_DAYS = 90;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const METRICS = {
  capacity: { label: "Capacity" },
  channels: { label: "Channels" },
  nodes: { label: "Nodes" },
  fees: { label: "Fees", hint: "Median fee rate" },
};
const RANGES = { "1y": "1y", "3y": "3y", all: "All" };
const CURRENCIES = { btc: "BTC", usd: "USD" };

const CHANNEL_KINDS = {
  channel_open: { label: "opened", tone: "acc" },
  channel_reappeared: { label: "re-announced", tone: "" },
  channel_close: { label: "closed", tone: "neg" },
};

let chartCounter = 0;

function pick(value, allowed, fallback) {
  return Object.hasOwn(allowed, value) ? value : fallback;
}

// ---------- value formatting ----------

function usdCompact(v) {
  if (v >= 1e9) return `$${num(v / 1e9, 2)}B`;
  if (v >= 1e6) return `$${num(v / 1e6, v >= 1e8 ? 0 : 1)}M`;
  if (v >= 1e3) return `$${num(v / 1e3, 0)}k`;
  return `$${int(v)}`;
}

function metricValue(metric, cap, point) {
  if (metric === "capacity") {
    if (cap === "usd") return point.capacity_usd;
    return point.total_capacity == null ? null : point.total_capacity / 1e8;
  }
  if (metric === "channels") return point.channel_count;
  if (metric === "nodes") return point.node_count;
  return point.med_fee_rate;
}

function metricTitle(metric, cap) {
  if (metric === "capacity") return `Network capacity (${cap === "usd" ? "USD" : "BTC"})`;
  if (metric === "fees") return "Median fee rate (ppm)";
  return METRICS[metric].label;
}

function formatValue(metric, cap, v) {
  if (metric === "capacity") return cap === "usd" ? usdCompact(v) : `${int(v)} BTC`;
  if (metric === "fees") return `${num(v, v < 10 ? 1 : 0)} ppm`;
  return int(v);
}

function formatAxis(metric, cap, v, top) {
  if (v === 0) return "0";
  if (metric === "capacity") return cap === "usd" ? usdCompact(v) : `${int(v)}${top ? " BTC" : ""}`;
  if (metric === "fees") return `${num(v, 1)}${top ? " ppm" : ""}`;
  return v >= 1000 ? `${num(v / 1000, 1)}k` : int(v);
}

function shortDay(ts) {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ---------- chart geometry ----------

function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
}

function splitGaps(points) {
  const segments = [];
  let prev = null;
  for (const point of points) {
    if (!prev || point.ts - prev.ts > HISTORY_GAP) segments.push([]);
    segments[segments.length - 1].push(point);
    prev = point;
  }
  return segments;
}

/** Month-aligned ticks; `maxTicks` bounds density. Step ≥ 12 months labels years only. */
function timeTicks(t0, t1, maxTicks) {
  const months = (t1 - t0) / (30.44 * DAY);
  const step = [1, 2, 3, 6, 12, 24, 36].find((s) => months / s <= maxTicks) || 48;
  const start = new Date(t0 * 1000);
  let index = start.getUTCFullYear() * 12 + start.getUTCMonth() + 1;
  const ticks = [];
  for (;;) {
    const year = Math.floor(index / 12);
    const month = index % 12;
    const ts = Date.UTC(year, month, 1) / 1000;
    if (ts > t1) break;
    if (index % step === 0) ticks.push({ ts, label: step >= 12 || month === 0 ? String(year) : MONTHS[month] });
    index += 1;
  }
  return ticks;
}

/** History chart SVG plus the point list used for hover lookups. */
function historyChart(points, { metric, cap, width, height }) {
  const peakValue = Math.max(...points.map((p) => Math.max(p.v, p.hi ?? 0)));
  const step = niceStep((peakValue || 1) / 4);
  const yTop = Math.max(step, Math.ceil((peakValue * 1.04) / step) * step);
  const count = Math.round(yTop / step);
  const yTicks = Array.from({ length: count + 1 }, (_, i) => ({ v: i * step, label: formatAxis(metric, cap, i * step, i === count) }));
  // Room for the longest y label (11px mono ≈ 6.7px per glyph).
  const longest = Math.max(...yTicks.map((tick) => tick.label.length));
  const pad = { l: 6, r: Math.max(40, Math.ceil(longest * 6.7) + 14), t: 12, b: 26 };
  const plotW = Math.max(10, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const first = points[0].ts;
  const lastTs = points[points.length - 1].ts;
  // A single day of data gets a month of context so it sits mid-chart.
  const lone = lastTs - first < 2 * DAY;
  const t0 = lone ? first - 15 * DAY : first;
  const t1 = lone ? lastTs + 15 * DAY : lastTs;
  const X = (ts) => pad.l + ((ts - t0) / (t1 - t0)) * plotW;
  const Y = (v) => pad.t + (1 - v / yTop) * plotH;
  const y0 = Y(0);
  const f = (n) => n.toFixed(1);
  const id = `st-grad-${++chartCounter}`;

  const grid = yTicks.map(({ v, label }) => {
    const y = f(Y(v));
    return (
      `<line class="st-grid${v ? "" : " zero"}" x1="${pad.l}" x2="${pad.l + plotW}" y1="${y}" y2="${y}"/>` +
      `<text class="st-ax" x="${pad.l + plotW + 10}" y="${f(Y(v) + 4)}">${esc(label)}</text>`
    );
  });
  const xTicks = timeTicks(t0, t1, Math.max(2, Math.floor(plotW / 64)))
    .map((tick) => `<text class="st-ax" x="${f(X(tick.ts))}" y="${height - 6}" text-anchor="middle">${tick.label}</text>`)
    .join("");

  const fees = metric === "fees";
  const mempool = fees ? [] : points.filter((p) => p.source !== "local");
  const local = fees ? [] : points.filter((p) => p.source === "local");
  const path = (seg) => seg.map((p, i) => `${i ? "L" : "M"}${f(X(p.ts))},${f(Y(p.v))}`).join("");
  const series = [];
  const feeGroups = [];
  if (fees) {
    // One colour per source; each gap-free run gets an interquartile band and a median line.
    for (const source of Object.keys(FEE_SOURCES)) {
      const own = points.filter((p) => p.source === source);
      if (!own.length) continue;
      feeGroups.push({ source, own });
      const cls = FEE_SOURCES[source].cls;
      for (const seg of splitGaps(own)) {
        if (seg.length === 1) {
          series.push(`<circle class="st-fdot ${cls}" cx="${f(X(seg[0].ts))}" cy="${f(Y(seg[0].v))}" r="2.5"/>`);
          continue;
        }
        if (seg.every((p) => p.lo != null && p.hi != null)) {
          const upper = seg.map((p, i) => `${i ? "L" : "M"}${f(X(p.ts))},${f(Y(p.hi))}`).join("");
          const lower = seg.slice().reverse().map((p) => `L${f(X(p.ts))},${f(Y(p.lo))}`).join("");
          series.push(`<path class="st-fband ${cls}" d="${upper}${lower}Z"/>`);
        }
        series.push(`<path class="st-fline ${cls}" d="${path(seg)}"/>`);
      }
    }
  }
  for (const seg of splitGaps(mempool)) {
    if (seg.length === 1) {
      series.push(`<circle class="st-dot" cx="${f(X(seg[0].ts))}" cy="${f(Y(seg[0].v))}" r="2.5"/>`);
      continue;
    }
    const line = path(seg);
    series.push(
      `<path d="${line}L${f(X(seg[seg.length - 1].ts))},${f(y0)}L${f(X(seg[0].ts))},${f(y0)}Z" fill="url(#${id})"/>` +
        `<path class="st-line" d="${line}"/>`
    );
  }
  for (const seg of splitGaps(local)) {
    if (seg.length > 1) series.push(`<path class="st-local" d="${path(seg)}"/>`);
    const end = seg[seg.length - 1];
    series.push(`<circle class="st-ring" cx="${f(X(end.ts))}" cy="${f(Y(end.v))}" r="4"/>`);
  }

  const fmt = (v) => formatValue(metric, cap, v);
  const span = lone ? `on ${date(lastTs)}` : `${date(first)} to ${date(lastTs)}`;
  const summary = [`${metricTitle(metric, cap)}, ${span}.`];
  if (mempool.length) {
    const peak = mempool.reduce((a, b) => (b.v > a.v ? b : a));
    const last = mempool[mempool.length - 1];
    summary.push(
      `mempool.space: ${fmt(mempool[0].v)} on ${date(mempool[0].ts)}, ${fmt(last.v)} on ${date(last.ts)}, peak ${fmt(peak.v)} on ${date(peak.ts)}.`
    );
  }
  for (const { source, own } of feeGroups) {
    const last = own[own.length - 1];
    summary.push(`${FEE_SOURCES[source].short}: ${date(own[0].ts)} to ${date(last.ts)}, latest median ${fmt(last.v)}.`);
  }
  if (local.length) {
    const last = local[local.length - 1];
    summary.push(`This explorer's snapshots: ${int(local.length)} point${local.length === 1 ? "" : "s"}, latest ${fmt(last.v)} on ${date(last.ts)}.`);
  }
  const label = summary.join(" ");

  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
    <title>${esc(label)}</title>
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#1dfebb" stop-opacity=".22"/><stop offset="1" stop-color="#1dfebb" stop-opacity="0"/></linearGradient></defs>
    ${grid.join("")}${xTicks}${series.join("")}
    <g class="st-hover" visibility="hidden"><line class="st-cross" x1="0" x2="0" y1="${pad.t}" y2="${f(y0)}"/><circle class="st-hdot" r="4.5"/></g>
  </svg>`;
  return { svg, pts: points.map((p) => ({ ...p, x: X(p.ts), y: Y(p.v) })) };
}

/** 90-day diverging bars: opens up, closes down. */
function flowsChart(flows, width) {
  const height = 150;
  const pad = { l: 34, r: 2, t: 8, b: 20 };
  const opens = new Map((flows.series?.channel_open || []).map((p) => [p.day, p.count]));
  const closes = new Map((flows.series?.channel_close || []).map((p) => [p.day, p.count]));
  const today = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const days = [];
  for (let i = FLOW_DAYS - 1; i >= 0; i -= 1) days.push(today - i * DAY);
  const max = Math.max(1, ...days.map((d) => Math.max(opens.get(d) || 0, closes.get(d) || 0)));
  const plotW = width - pad.l - pad.r;
  const zero = pad.t + (height - pad.t - pad.b) / 2;
  const half = zero - pad.t - 1;
  const slot = plotW / days.length;
  const bw = Math.max(1, slot - 1);
  const f = (n) => n.toFixed(1);
  const bars = days
    .map((day, i) => {
      const x = pad.l + i * slot;
      const o = opens.get(day) || 0;
      const c = closes.get(day) || 0;
      const ho = (o / max) * half;
      const hc = (c / max) * half;
      return `<g><title>${shortDay(day)}: ${int(o)} opened, ${int(c)} closed</title><rect class="st-hit" x="${f(x)}" y="${pad.t}" width="${f(slot)}" height="${f(2 * half + 2)}"/>${
        o ? `<rect class="st-open" x="${f(x)}" y="${f(zero - ho)}" width="${f(bw)}" height="${f(ho)}" rx="1"/>` : ""
      }${c ? `<rect class="st-close" x="${f(x)}" y="${f(zero + 1)}" width="${f(bw)}" height="${f(hc)}" rx="1"/>` : ""}</g>`;
    })
    .join("");
  const months = days
    .map((day, i) => [day, i])
    .filter(([day]) => new Date(day * 1000).getUTCDate() === 1)
    .map(([day, i]) => `<text class="st-ax" x="${f(pad.l + i * slot)}" y="${height - 4}">${MONTHS[new Date(day * 1000).getUTCMonth()]}</text>`)
    .join("");
  const sumO = days.reduce((a, d) => a + (opens.get(d) || 0), 0);
  const sumC = days.reduce((a, d) => a + (closes.get(d) || 0), 0);
  const label = `Channel opens and closes per day, last ${FLOW_DAYS} days: ${int(sumO)} opened, ${int(sumC)} closed; busiest day ${int(max)}.`;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
    <text class="st-ax" x="${pad.l - 6}" y="${pad.t + 9}" text-anchor="end">${int(max)}</text>
    <text class="st-ax" x="${pad.l - 6}" y="${f(zero + 4)}" text-anchor="end">0</text>
    <text class="st-ax" x="${pad.l - 6}" y="${f(zero + half)}" text-anchor="end">${int(max)}</text>
    <line class="st-grid zero" x1="${pad.l}" x2="${width - pad.r}" y1="${f(zero + 0.5)}" y2="${f(zero + 0.5)}"/>
    ${bars}${months}
  </svg>`;
}

// ---------- static fragments ----------

function segHtml(key, options, value, label) {
  return `<div class="seg" role="group" aria-label="${label}" data-seg="${key}">${Object.entries(options)
    .map(
      ([k, v]) =>
        `<button type="button" data-k="${key}" data-v="${k}" aria-pressed="${k === value}"${v.hint ? ` title="${v.hint}"` : ""}>${esc(v.label || v)}</button>`
    )
    .join("")}</div>`;
}

function kpi(label, value, sub, cls = "") {
  return `<div class="st-kpi ${cls}"><div class="lbl">${label}</div><div class="v">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}

function nodeLink(pubkey, alias) {
  return `<a href="${homeUrl({ node: pubkey })}">${esc(displayName(alias, pubkey))}</a>`;
}

function eventRow(event) {
  const kind = CHANNEL_KINDS[event.kind];
  const who = event.pubkey ? nodeLink(event.pubkey, event.pubkey_alias) : '<span class="muted">network</span>';
  const peer = event.peer ? ` <span class="sub">↔</span> ${nodeLink(event.peer, event.peer_alias)}` : "";
  const channel = event.scid ? `<a class="mono" href="/channel/${encodeURIComponent(event.scid)}">${esc(event.short_id || event.scid)}</a>` : "";
  return `<li class="st-ev">
    <span class="tag ${kind.tone}">${kind.label}</span>
    <span class="st-ev-who ellipsis">${who}${peer}</span>
    <time class="sub" datetime="${new Date(event.ts * 1000).toISOString()}" title="${esc(dateTime(event.ts))}">${relTime(event.ts)}</time>
    <span class="st-ev-meta"><span class="mono">${btcHtml(event.capacity)}</span>${channel}</span>
  </li>`;
}

function feeScale(rate) {
  const marks = [
    ["min", rate.min],
    ["median", rate.median],
    ["mean", rate.mean_filtered],
    ["p90", rate.p90],
  ].filter(([, v]) => Number.isFinite(Number(v)));
  const max = Math.max(1, Number(rate.p90) || 0, ...marks.map(([, v]) => Number(v)));
  const pos = (v) => Math.min(100, Math.sqrt(Math.max(0, v) / max) * 100);
  const label = `Fee rate percentiles: ${marks.map(([k, v]) => `${k === "mean" ? "filtered mean" : k} ${num(v, 0)} ppm`).join(", ")}.`;
  return `<div class="st-scale" role="img" aria-label="${esc(label)}">
    <div class="st-track"><i></i></div>
    ${marks
      .map(([k, v], i) => {
        const align = i === 0 ? "start" : i === marks.length - 1 ? "end" : "mid";
        return `<div class="st-mark ${align}${k === "median" ? " acc" : ""}" style="left:${pos(v).toFixed(2)}%"><i></i><b class="mono">${int(v)}</b><span class="sub">${k}</span></div>`;
      })
      .join("")}
  </div>`;
}

function feeTable(rate, base) {
  const rows = [
    ["Median", "median", 1],
    ["Filtered mean", "mean_filtered", 1],
    ["Cap-weighted mean", "mean_capweighted", 1],
    ["p90", "p90", 1],
    ["Std dev", "std", 1],
    ["Min", "min", 0],
    ["Max", "max", 0],
    ["Raw mean", "mean", 1],
  ];
  return `<table class="dtable st-feetable">
    <thead><tr><th scope="col">Statistic</th><th scope="col" class="r">Fee rate <span class="sub">ppm</span></th><th scope="col" class="r">Base fee <span class="sub">msat</span></th></tr></thead>
    <tbody>${rows
      .map(([label, key, digits]) => `<tr><th scope="row">${label}</th><td class="r mono">${num(rate[key], digits)}</td><td class="r mono">${num(base[key], digits)}</td></tr>`)
      .join("")}</tbody>
  </table>`;
}

// ---------- view ----------

export async function mount(ctx) {
  const { signal } = ctx;
  const params = ctx.route.params;
  const state = {
    metric: pick(params.get("metric"), METRICS, "capacity"),
    range: pick(params.get("range"), RANGES, "all"),
    cap: params.get("cap") === "usd" ? "usd" : "btc",
    top: "capacity",
  };
  ctx.setTitle("Network stats");

  const sheet = openSheet(ctx.el, {
    title: "Network",
    placement: "bottom",
    actions: `${segHtml("metric", METRICS, state.metric, "Chart metric")}${segHtml("range", RANGES, state.range, "Time range")}${segHtml("cap", CURRENCIES, state.cap, "Capacity currency")}`,
  });
  sheet.root.classList.add("st-sheet");
  map.setDim(true);
  map.setInsets(sheet.insets());
  map.ensure().catch(() => {});

  sheet.body.innerHTML = `<div class="st-body">
    <div class="st-top">
      <div class="st-main">
        <div class="st-chart" tabindex="0"><span class="skel" style="height:300px"></span></div>
        <div class="st-legend lbl"></div>
      </div>
      <div class="st-kpis">${["Network capacity", "Public channels", "Announced nodes", "Median fee rate", "BTC price"]
        .map((l) => kpi(l, '<span class="skel num"></span>', '<span class="skel line" style="width:60%"></span>'))
        .join("")}</div>
    </div>
    <div class="st-row">${'<section class="panel st-panel"><span class="skel line"></span><span class="skel line" style="width:70%"></span><span class="skel line" style="width:50%"></span></section>'.repeat(3)}</div>
    <p class="st-facts sub"></p>
  </div>`;
  const $ = (sel) => sheet.body.querySelector(sel);
  const chartHost = $(".st-chart");
  const legendHost = $(".st-legend");
  const capSeg = sheet.actions.querySelector('[data-seg="cap"]');
  // Keep the currency toggle's box in the layout for every metric so the header
  // controls never shift; it is only invisible and inert when not on Capacity.
  const syncCapSeg = () => {
    const off = state.metric !== "capacity";
    capSeg.classList.toggle("is-off", off);
    capSeg.inert = off;
    capSeg.setAttribute("aria-hidden", String(off));
  };
  syncCapSeg();

  const soft = (promise) => promise.catch((error) => (isAbort(error) ? Promise.reject(error) : null));
  const statsP = api("/api/stats", { signal });
  const historyP = api(`/api/history?range=${state.range}`, { signal });
  const feeHistoryP = soft(api(`/api/fees/history?range=${state.range}`, { signal }));
  const flowsP = soft(api(`/api/flows?days=${FLOW_DAYS}`, { signal }));
  const eventsP = soft(api("/api/events?limit=60", { signal }));

  let stats;
  let history = null;
  let feeHistory = null;
  let historyError = null;
  let flows = null;
  let events = null;
  let hover = null;
  let chartWidth = 0;
  let chartH = 0;
  let flowsWidth = 0;
  let historySeq = 0;

  // ----- main chart -----
  const tip = () => chartHost.querySelector(".st-tip");

  function hideHover() {
    const g = chartHost.querySelector(".st-hover");
    if (g) g.setAttribute("visibility", "hidden");
    const t = tip();
    if (t) t.hidden = true;
    if (hover) hover.index = -1;
  }

  function showHover(index, mx, my) {
    if (!hover || !hover.pts.length) return;
    hover.index = index;
    const p = hover.pts[index];
    const g = chartHost.querySelector(".st-hover");
    g.setAttribute("visibility", "visible");
    const line = g.querySelector("line");
    line.setAttribute("x1", p.x.toFixed(1));
    line.setAttribute("x2", p.x.toFixed(1));
    const dot = g.querySelector("circle");
    dot.setAttribute("cx", p.x.toFixed(1));
    dot.setAttribute("cy", p.y.toFixed(1));
    dot.classList.toggle("local", p.source === "local");
    const t = tip();
    const fee = FEE_SOURCES[p.source];
    const where = fee ? fee.short : p.source === "local" ? "this explorer" : "mempool.space";
    const band = fee && p.lo != null ? `<div class="lbl">p25–p75 ${esc(num(p.lo, 0))}–${esc(num(p.hi, 0))} ppm · base ${esc(num(p.base ?? 0, 0))} msat</div>` : "";
    t.innerHTML = `<div class="lbl">${esc(date(p.ts))} · ${esc(where)}</div><div class="v mono">${esc(formatValue(state.metric, state.cap, p.v))}</div>${band}`;
    t.hidden = false;
    const x = mx ?? p.x;
    const y = my ?? p.y;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    let left = x + 14;
    if (left + w > chartWidth) left = x - 14 - w;
    let top = y - h - 12;
    if (top < 0) top = y + 16;
    t.style.transform = `translate(${Math.max(0, left).toFixed(0)}px, ${top.toFixed(0)}px)`;
  }

  function nearest(mx) {
    const pts = hover.pts;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].x < mx) lo = mid;
      else hi = mid;
    }
    return Math.abs(pts[lo].x - mx) <= Math.abs(pts[hi].x - mx) ? lo : hi;
  }

  function renderLegend() {
    if (!history) {
      legendHost.innerHTML = "";
      return;
    }
    if (state.metric === "fees") {
      const list = feeHistory?.series || [];
      legendHost.innerHTML = `
        ${list.map((s) => `<span class="st-key"><i class="st-sw ${FEE_SOURCES[s.source]?.cls || ""}"></i>${esc(s.label)}</span>`).join("")}
        <span class="st-key"><i class="st-sw band"></i>p25–p75</span>
        <span class="st-legend-r">Median fee rate
          <details class="info right"><summary aria-label="About the fee data">${icon("info")}</summary><div>
            ${feeHistory?.definitions ? `<p>${esc(feeHistory.definitions)}</p>` : ""}
            ${list.map((s) => `<p><b>${esc(s.label)}</b> (${esc(isoDay(s.first))} to ${esc(isoDay(s.last))}): ${esc(s.note)}</p>`).join("")}
            <p>Breaks in a line are days without data.</p>
          </div></details>
        </span>`;
      return;
    }
    const until = history.external_until;
    const latest = stats?.network_latest || {};
    const localLabel = state.metric === "capacity" ? "this explorer, known capacity" : "this explorer's snapshots";
    legendHost.innerHTML = `
      <span class="st-key"><i class="st-sw"></i>mempool.space</span>
      <span class="st-key"><i class="st-sw dash"></i>${localLabel}</span>
      <span class="st-legend-r">${until ? `mempool data ${history.external_stale ? "stops" : "through"} ${shortDay(until)}` : "Sources"}
        <details class="info right"><summary aria-label="About the data sources">${icon("info")}</summary><div>
          ${history.notes ? `<p>${esc(history.notes)}</p>` : ""}
          <p>Solid lines are mempool.space statistics${until ? `, which stop on ${isoDay(until)}` : ""}. Dashed lines continue with this explorer's own rapid-gossip-sync snapshots (about ${int(stats?.gossip_nodes)} nodes / ${int(stats?.gossip_channels)} channels, capacity only partially known), which are not directly comparable with mempool's totals (${int(latest.node_count)} nodes including unannounced and channel-less, ${int(latest.channel_count)} channels).</p>
        </div></details>
      </span>`;
  }

  /** Beside the KPI column the chart fills its height; stacked or narrow it uses a fixed height. */
  function chartHeight(width) {
    if (width < 560) return 220;
    const side = $(".st-kpis");
    const beside = Math.abs(side.getBoundingClientRect().top - chartHost.getBoundingClientRect().top) < 40;
    if (!beside) return 300;
    return Math.round(Math.min(440, Math.max(280, side.offsetHeight - legendHost.offsetHeight - 10)));
  }

  function renderChart() {
    chartWidth = chartHost.clientWidth;
    hover = null;
    if (historyError) {
      chartHost.innerHTML = `<div class="notice warn">${icon("alert")}<span>History could not load: ${esc(historyError.message)}</span></div>`;
      return;
    }
    if (!history || !chartWidth) return;
    const height = chartHeight(chartWidth);
    chartH = height;
    const points = (state.metric === "fees" ? feePoints() : history.points
      .map((p) => ({ ts: p.ts, source: p.source === "local" ? "local" : "mempool", v: Number(metricValue(state.metric, state.cap, p)) })))
      .filter((p) => p.v != null && Number.isFinite(p.v) && p.v > 0)
      .sort((a, b) => a.ts - b.ts);
    if (!points.length) {
      const what =
        state.metric === "fees"
          ? "No median fee-rate history in this range yet. This explorer records it with every snapshot."
          : state.metric === "capacity" && state.cap === "usd"
            ? "No USD prices for this range yet."
            : "No history in this range yet. The first refresh records a snapshot.";
      chartHost.innerHTML = `<div class="empty-line st-empty" style="height:${height}px">${icon("chart")}<span>${what}</span></div>`;
      return;
    }
    const chart = historyChart(points, { metric: state.metric, cap: state.cap, width: chartWidth, height });
    chartHost.innerHTML = `${chart.svg}<div class="st-tip" hidden aria-live="polite"></div>`;
    chartHost.setAttribute("aria-label", `${metricTitle(state.metric, state.cap)} chart. Use the arrow keys to read values.`);
    hover = { pts: chart.pts, index: -1 };
  }

  const track = (event) => {
    if (!hover) return;
    const rect = chartHost.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    showHover(nearest(mx), mx, event.clientY - rect.top);
  };
  chartHost.addEventListener("pointermove", track);
  chartHost.addEventListener("pointerdown", track);
  // A tap keeps its readout until focus leaves the chart.
  chartHost.addEventListener("pointerleave", (event) => event.pointerType !== "touch" && hideHover());
  chartHost.addEventListener("blur", hideHover);
  chartHost.addEventListener("keydown", (event) => {
    if (!hover) return;
    const last = hover.pts.length - 1;
    const current = hover.index < 0 ? last : hover.index;
    const next = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: last }[event.key];
    if (next === undefined) {
      if (event.key === "Escape") hideHover();
      return;
    }
    event.preventDefault();
    showHover(Math.max(0, Math.min(last, hover.index < 0 && event.key.startsWith("Arrow") ? last : next)));
  });

  /** Daily fee rows as chart points: median line, p25–p75 band. */
  function feePoints() {
    const out = [];
    for (const s of feeHistory?.series || []) {
      const col = Object.fromEntries((feeHistory.columns || []).map((name, i) => [name, i]));
      for (const row of s.points) {
        out.push({ ts: row[col.ts], source: s.source, v: Number(row[col.p50]), lo: row[col.p25], hi: row[col.p75], base: row[col.med_base_msat] });
      }
    }
    return out;
  }

  async function loadHistory() {
    const seq = ++historySeq;
    chartHost.classList.add("st-busy");
    try {
      const [payload, fees] = await Promise.all([
        api(`/api/history?range=${state.range}`, { signal }),
        api(`/api/fees/history?range=${state.range}`, { signal }).catch((error) => (isAbort(error) ? Promise.reject(error) : null)),
      ]);
      if (seq !== historySeq || !ctx.alive()) return;
      history = payload;
      feeHistory = fees;
      historyError = null;
    } catch (error) {
      if (isAbort(error) || seq !== historySeq) return;
      historyError = error;
    }
    chartHost.classList.remove("st-busy");
    renderLegend();
    renderChart();
  }

  // ----- header controls -----
  sheet.actions.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-k]");
    if (!button) return;
    const { k, v } = button.dataset;
    if (state[k] === v) return;
    state[k] = v;
    button.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    syncCapSeg();
    const query = new URLSearchParams(location.search);
    query.set(k, v);
    setQuery(query);
    if (k === "range") loadHistory();
    else {
      renderLegend();
      renderChart();
    }
  });

  // ----- KPIs, panels, facts -----
  function renderKpis() {
    const latest = stats.network_latest || {};
    const rates = history?.currency_rates || {};
    const capacity = latest.total_capacity || stats.reported?.total_capacity;
    const capKpi = capacity
      ? kpi(
          "Network capacity",
          `<span title="${int(capacity)} sats">${int(capacity / 1e8)}</span><small>BTC</small>`,
          `${rates.USD ? `≈ ${usdCompact((capacity / 1e8) * rates.USD)} · ` : ""}mempool.space${latest.ts ? `, as of ${shortDay(latest.ts)}` : ""}`,
          "lead"
        )
      : kpi("Network capacity", `${btcHtml(stats.gossip_capacity)}`, "this explorer, known capacity only", "lead");
    $(".st-kpis").innerHTML = [
      capKpi,
      kpi("Public channels", int(stats.gossip_channels), `${int(stats.disabled_channels)} disabled both ways`),
      kpi("Announced nodes", int(stats.gossip_nodes), latest.node_count ? `${int(latest.node_count)} incl. unannounced (mempool.space)` : ""),
      kpi("Median fee rate", `${num(stats.median_fee_rate_ppm, 0)}<small>ppm</small>`, `base ${baseFee(stats.median_base_fee_msat)}`),
      kpi("BTC price", rates.USD ? `$${int(rates.USD)}` : "—", rates.EUR ? `€${int(rates.EUR)}${rates.time ? ` · ${shortDay(rates.time)}` : ""}` : ""),
    ].join("");
  }

  function feesPanel() {
    const rate = stats.fees?.rate || {};
    const base = stats.fees?.base || {};
    return `<section class="panel st-panel st-fees" aria-labelledby="st-fees-h">
      <div class="sect-h"><h3 id="st-fees-h">Routing fee rates</h3><span class="lbl">${int(rate.count)} policies</span></div>
      ${feeScale(rate)}
      <p class="sub st-note">ppm, square-root scale. Placeholder fees (2,147,483,647 ppm) are filtered out of the mean.</p>
      <details class="st-more"><summary>${icon("chevD")}All fee statistics</summary>
        ${feeTable(rate, base)}
        <p class="sub st-note">Raw mean is distorted by a few placeholder fees such as 2,147,483,647 ppm; filtered mean drops values outside Tukey far-out fences. ${int(stats.enabled_channels)} channels have at least one non-disabled policy, ${int(stats.disabled_channels)} are disabled both ways.</p>
      </details>
    </section>`;
  }

  function topList() {
    const byCapacity = state.top === "capacity";
    const rows = (byCapacity ? stats.top_capacity : stats.top_betweenness) || [];
    if (!rows.length) {
      return `<div class="empty-line">${icon("clock")}<span>${byCapacity ? "No nodes yet." : "Centrality ranks are still being computed."}</span></div>`;
    }
    const max = Math.max(1, ...rows.map((n) => n.total_capacity || 0));
    return `<div class="peers st-top-list">${rows
      .map(
        (n, i) => `<a class="peer" href="${homeUrl({ node: n.pubkey })}">
          <span class="n ellipsis">${byCapacity ? "" : `<span class="st-rank mono">#${int(n.betweenness_rank)}</span>`}${esc(displayName(n.alias, n.pubkey))}</span>
          <span class="bar${i ? "" : " acc"}"><i style="width:${(((n.total_capacity || 0) / max) * 100).toFixed(1)}%"></i></span>
          <span class="c mono" title="${int(n.total_capacity)} sats">${btcHtml(n.total_capacity, false)}</span></a>`
      )
      .join("")}</div>
      <p class="sub st-note">${byCapacity ? "Total channel capacity, BTC." : "Ranked by betweenness centrality; bars show capacity in BTC."}</p>`;
  }

  function nodesPanel() {
    return `<section class="panel st-panel st-nodes" aria-labelledby="st-nodes-h">
      <div class="sect-h"><h3 id="st-nodes-h">Top nodes</h3>${segHtml("top", { capacity: "Capacity", betweenness: "Betweenness" }, state.top, "Rank nodes by").replace('class="seg"', 'class="seg st-mini"')}</div>
      <div class="st-top-body">${topList()}</div>
    </section>`;
  }

  function closeReasons() {
    const labels = flows.close_reasons || {};
    const rows = Object.entries(flows.close_types || {}).filter(([, count]) => count > 0);
    const until = history?.external_until ? isoDay(history.external_until) : "";
    const caveat = `<details class="info right"><summary aria-label="About close reasons">${icon("info")}</summary><div><p>Close reasons come from mempool.space, whose Lightning indexer stopped${until ? ` around ${until}` : ""}; closes after that usually show “unknown / not yet indexed”.</p></div></details>`;
    const total = rows.reduce((a, [, c]) => a + c, 0);
    const body = rows.length
      ? `<ul class="st-reasons">${rows
          .sort((a, b) => b[1] - a[1])
          .map(
            ([key, count]) =>
              `<li><span class="ellipsis">${esc(labels[key] || key)}</span><span class="bar"><i style="width:${((count / total) * 100).toFixed(1)}%"></i></span><span class="mono">${int(count)}</span></li>`
          )
          .join("")}</ul>`
      : '<p class="empty-line">No closes recorded in this window yet.</p>';
    return `<div class="st-sub-h"><h4>Close reasons</h4>${caveat}</div>${body}`;
  }

  function recentEvents() {
    const rows = (events?.events || []).filter((e) => CHANNEL_KINDS[e.kind]).slice(0, 20);
    return `<div class="st-sub-h"><h4>Recent opens and closes</h4></div>${
      rows.length ? `<ul class="st-events">${rows.map(eventRow).join("")}</ul>` : '<p class="empty-line">No opens or closes recorded yet.</p>'
    }`;
  }

  function flowsPanel() {
    const head = `<div class="sect-h"><h3 id="st-flows-h">Opens &amp; closes</h3><span class="lbl">${flows && !flows.accumulating ? `last ${FLOW_DAYS} days · snapshot diffs` : "7 days"}</span></div>`;
    if (!flows) {
      return `<section class="panel st-panel st-flows" aria-labelledby="st-flows-h">${head}<p class="empty-line">${icon("alert")}<span>Opens and closes could not load.</span></p></section>`;
    }
    if (flows.accumulating) {
      const since = flows.events_since ? `Collecting since ${esc(date(flows.events_since))}` : "Collecting";
      return `<section class="panel st-panel st-flows" aria-labelledby="st-flows-h">${head}<p class="empty-line st-collect">${icon("clock")}<span>${since} — first snapshot diff lands within 3 hours.</span></p></section>`;
    }
    const f7 = stats.flows_7d || {};
    const net = Number(f7.net_channels) || 0;
    return `<section class="panel st-panel st-flows full" aria-labelledby="st-flows-h">${head}
      <div class="st-flows-grid">
        <div class="st-flows-main">
          <div class="st-flowchart"></div>
          <div class="st-legend lbl"><span class="st-key"><i class="st-sq"></i>opens</span><span class="st-key"><i class="st-sq neg"></i>closes (closed or pruned from gossip)</span></div>
          <div class="st-f7">
            ${kpi("Opens 7d", int(f7.opens), f7.opened_capacity ? `+${btcHtml(f7.opened_capacity)}` : "")}
            ${kpi("Closes 7d", int(f7.closes), f7.closed_capacity ? `−${btcHtml(f7.closed_capacity)}` : "")}
            ${kpi("Net channels 7d", `<span class="${net > 0 ? "up" : net < 0 ? "down" : ""}">${net > 0 ? "+" : ""}${int(net)}</span>`, "")}
          </div>
        </div>
        <div class="st-flows-reasons">${closeReasons()}</div>
        <div class="st-flows-events">${recentEvents()}</div>
      </div>
    </section>`;
  }

  function renderFlowChart() {
    const host = $(".st-flowchart");
    if (!host) return;
    flowsWidth = host.clientWidth;
    if (flowsWidth) host.innerHTML = flowsChart(flows, flowsWidth);
  }

  function renderLower() {
    const row = $(".st-row");
    row.innerHTML = feesPanel() + nodesPanel() + flowsPanel();
    row.classList.toggle("st-row-2", Boolean(flows && !flows.accumulating));
    $(".st-nodes").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-k='top']");
      if (!button || state.top === button.dataset.v) return;
      state.top = button.dataset.v;
      button.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      $(".st-top-body").innerHTML = topList();
    });
    const flowHost = $(".st-flowchart");
    if (flowHost) observer.observe(flowHost);
    renderFlowChart();
  }

  function renderFacts() {
    $(".st-facts").innerHTML = `Capacity known for ${num((stats.capacity_coverage || 0) * 100, 0)}% of channels · Snapshot ${esc(dateTime(stats.graph_timestamp))} · Data: LDK rapid gossip sync · mempool.space`;
  }

  const observer = new ResizeObserver((entries) => {
    let chart = false;
    for (const entry of entries) {
      if (entry.target.classList.contains("st-flowchart")) {
        if (entry.target.clientWidth !== flowsWidth) renderFlowChart();
      } else chart = true;
    }
    const width = chartHost.clientWidth;
    if (chart && history && (width !== chartWidth || chartHeight(width) !== chartH)) renderChart();
  });
  observer.observe(chartHost);
  observer.observe($(".st-kpis"));
  const cleanup = () => {
    observer.disconnect();
    map.setDim(false);
  };

  // ----- load -----
  const seq = ++historySeq;
  const [statsResult, historyResult, feeResult] = await Promise.allSettled([statsP, historyP, feeHistoryP]);
  if (!ctx.alive()) return cleanup;
  if (statsResult.status === "rejected") {
    if (isAbort(statsResult.reason)) return cleanup;
    sheet.body.innerHTML = `<div class="st-body"><div class="notice warn">${icon("alert")}<span>Network statistics could not load: ${esc(statsResult.reason.message)}</span></div></div>`;
    return cleanup;
  }
  stats = statsResult.value;
  if (seq === historySeq) {
    if (historyResult.status === "fulfilled") history = historyResult.value;
    else if (!isAbort(historyResult.reason)) historyError = historyResult.reason;
    if (feeResult.status === "fulfilled") feeHistory = feeResult.value;
    renderLegend();
  }
  renderKpis();
  renderChart();
  renderFacts();
  try {
    [flows, events] = await Promise.all([flowsP, eventsP]);
  } catch (error) {
    if (isAbort(error)) return cleanup;
    throw error;
  }
  if (!ctx.alive()) return cleanup;
  renderLower();
  return cleanup;
}
