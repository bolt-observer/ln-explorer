// "/nodes" — every public node in a sortable, filterable table on a left sheet
// over the live map. All filter, sort and page state lives in the URL and maps
// one-to-one onto /api/nodes parameters; changes re-fetch the table only.
import { api, cached, isAbort } from "../lib/api.js";
import { baseFee, btc, btcHtml, esc, int, num, shortKey } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { go, homeUrl, setQuery } from "../lib/router.js";
import { map } from "../map/map.js";
import { attachAutocomplete } from "../ui/autocomplete.js";
import { openSheet } from "../ui/sheet.js";

const PUBKEY_RE = /^[0-9a-f]{66}$/;
const DEFAULT_SORT = "total_capacity";

// Every numeric /api/nodes field. kind drives unit hints, value entry and chip text.
const FIELDS = {
  num_channels: { label: "Channels", kind: "count", group: "Size" },
  active_channels: { label: "Active channels", kind: "count", group: "Size" },
  total_capacity: { label: "Capacity", kind: "sats", group: "Size" },
  avg_capacity: { label: "Average channel size", kind: "sats", group: "Size" },
  med_capacity: { label: "Median channel size", kind: "sats", group: "Size" },
  max_capacity: { label: "Largest channel", kind: "sats", group: "Size" },
  med_out_ppm: { label: "Median out fee", kind: "ppm", group: "Fees" },
  avg_out_ppm: { label: "Average out fee", kind: "ppm", group: "Fees" },
  max_out_ppm: { label: "Highest out fee", kind: "ppm", group: "Fees" },
  med_in_ppm: { label: "Median inbound fee", kind: "ppm", group: "Fees" },
  avg_in_ppm: { label: "Average inbound fee", kind: "ppm", group: "Fees" },
  med_out_base: { label: "Median out base fee", kind: "msat", group: "Fees" },
  avg_out_base: { label: "Average out base fee", kind: "msat", group: "Fees" },
  max_out_base: { label: "Highest out base fee", kind: "msat", group: "Fees" },
  med_in_base: { label: "Median inbound base fee", kind: "msat", group: "Fees" },
  avg_in_base: { label: "Average inbound base fee", kind: "msat", group: "Fees" },
  betweenness_rank: { label: "Betweenness rank", kind: "rank", group: "Centrality" },
  betweenness_weighted_rank: { label: "Betweenness rank, weighted", kind: "rank", group: "Centrality" },
  closeness_rank: { label: "Closeness rank", kind: "rank", group: "Centrality" },
  closeness_weighted_rank: { label: "Closeness rank, weighted", kind: "rank", group: "Centrality" },
  eigenvector_rank: { label: "Eigenvector rank", kind: "rank", group: "Centrality" },
  eigenvector_weighted_rank: { label: "Eigenvector rank, weighted", kind: "rank", group: "Centrality" },
  shortest_path: { label: "Hops from reference", kind: "hops", group: "Reference" },
};
const SORT_ONLY = { alias: { label: "Alias", kind: "text", group: "Name" } };
const GROUPS = ["Size", "Fees", "Centrality", "Reference"];

const UNIT = { count: "", sats: "BTC", ppm: "ppm", msat: "msat", rank: "", hops: "hops" };
const HINT = {
  count: "Number of public channels.",
  sats: "Enter BTC; it is converted to sats.",
  ppm: "Parts per million of the forwarded amount.",
  msat: "Millisatoshi; 1,000 msat = 1 sat.",
  rank: "Rank 1 is the most central node. Use < to keep the top of the list.",
  hops: "Shortest path length from the reference node.",
};
const REL = { gt: ">", lt: "<", eq: "=" };
const REL_LABEL = { gt: "more than  >", lt: "less than  <", eq: "exactly  =" };

const PROTOCOLS = [
  ["ipv4", "IPv4"],
  ["ipv6", "IPv6"],
  ["tor", "Tor"],
];
const FEATURES = [
  ["wumbo", "Wumbo", "W", "Large channels (wumbo)"],
  ["anchors", "Anchors", "A", "Anchor channels"],
  ["dual_fund", "Dual funding", "D", "Dual-funded channels"],
  ["onion_messages", "Onion messages", "O", "Onion messages"],
  ["route_blinding", "Route blinding", "R", "Route blinding"],
];
const QUANTIFIERS = [
  ["all", "All", "Nodes matching every condition"],
  ["any", "Any", "Nodes matching at least one condition"],
  ["none", "None", "Nodes matching none of the conditions"],
];

// Optional columns, toggled in the Columns menu and remembered per browser.
const OPTIONAL = [
  ["active_channels", "Active channels"],
  ["avg_out_ppm", "Average out fee"],
  ["med_out_base", "Median base fee"],
  ["med_capacity", "Median channel size"],
  ["closeness_rank", "Closeness rank"],
  ["eigenvector_rank", "Eigenvector rank"],
  ["betweenness_weighted_rank", "Betweenness, weighted"],
  ["closeness_weighted_rank", "Closeness, weighted"],
  ["eigenvector_weighted_rank", "Eigenvector, weighted"],
  ["features", "Feature tags"],
];
const COLUMNS_KEY = "bolt.nodes.columns";
const DEFAULT_COLUMNS = ["features"];

const OWNED = ["q", "condition", "quantifier", "protocol", "feature", "sort", "dir", "reference", "reachable", "page"];
// The old form also wrote its raw inputs next to `condition`; they are redundant.
const LEGACY = ["field", "rel", "value"];

const fieldInfo = (key) => FIELDS[key] || SORT_ONLY[key];
const defaultDir = (sort) => (sort === "alias" || sort === "shortest_path" || sort.endsWith("_rank") ? "asc" : "desc");

function loadColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMNS_KEY));
    if (Array.isArray(saved)) return new Set(saved.filter((id) => OPTIONAL.some(([key]) => key === id)));
  } catch {
    /* unreadable or blocked storage: defaults */
  }
  return new Set(DEFAULT_COLUMNS);
}

function saveColumns(columns) {
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify([...columns]));
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
}

function readState(params) {
  const reference = (params.get("reference") || "").trim().toLowerCase();
  const conditions = [];
  for (const raw of params.getAll("condition")) {
    const [field, rel, value] = raw.split("|");
    const n = Number(value);
    if (FIELDS[field] && REL[rel] && value !== "" && Number.isFinite(n)) conditions.push({ field, rel, value: n });
  }
  const protocols = new Set(
    params
      .getAll("protocol")
      .flatMap((v) => v.split(","))
      .filter((v) => PROTOCOLS.some(([key]) => key === v)),
  );
  const feature = params.get("feature") || "";
  let sort = params.get("sort") || DEFAULT_SORT;
  if (!fieldInfo(sort) || (sort === "shortest_path" && !reference)) sort = DEFAULT_SORT;
  const dir = ["asc", "desc"].includes(params.get("dir")) ? params.get("dir") : defaultDir(sort);
  const quantifier = ["all", "any", "none"].includes(params.get("quantifier")) ? params.get("quantifier") : "all";
  return {
    q: (params.get("q") || "").trim(),
    conditions,
    quantifier,
    protocols,
    feature: FEATURES.some(([key]) => key === feature) ? feature : "",
    sort,
    dir,
    reference,
    reachable: params.get("reachable") === "1",
    page: Math.max(1, Number.parseInt(params.get("page"), 10) || 1),
    pageSize: params.get("page_size") || "",
  };
}

const filtersActive = (st) => Boolean(st.q || st.conditions.length || st.protocols.size || st.feature || st.reference);

function writeParams(st, base) {
  const params = new URLSearchParams(base);
  for (const key of [...OWNED, ...LEGACY]) params.delete(key);
  if (st.q) params.set("q", st.q);
  for (const c of st.conditions) params.append("condition", `${c.field}|${c.rel}|${c.value}`);
  if (st.quantifier !== "all" && st.conditions.length) params.set("quantifier", st.quantifier);
  if (st.protocols.size) params.set("protocol", [...st.protocols].join(","));
  if (st.feature) params.set("feature", st.feature);
  if (st.sort !== DEFAULT_SORT || st.dir !== defaultDir(st.sort)) params.set("sort", st.sort);
  if (st.dir !== defaultDir(st.sort)) params.set("dir", st.dir);
  if (st.reference) params.set("reference", st.reference);
  if (st.reference && st.reachable) params.set("reachable", "1");
  if (st.page > 1) params.set("page", String(st.page));
  return params;
}

function apiQuery(st) {
  const params = writeParams(st, "");
  params.set("sort", st.sort);
  params.set("dir", st.dir);
  params.set("page", String(st.page));
  if (st.pageSize) params.set("page_size", st.pageSize);
  return params.toString();
}

function valueText(kind, value) {
  if (kind === "sats") return `${btc(value)} BTC`;
  if (kind === "ppm") return `${num(value, 2)} ppm`;
  if (kind === "msat") return baseFee(value);
  if (kind === "hops") return `${num(value, 2)} ${Number(value) === 1 ? "hop" : "hops"}`;
  return num(value, 2);
}

/** Input value for the editor (BTC for capacities, raw otherwise). */
const editValue = (kind, value) => (kind === "sats" ? String(Number(value) / 1e8) : String(value));

function fieldOptions(selected, { reference, sortable = false }) {
  const groups = sortable ? ["Name", ...GROUPS] : GROUPS;
  const all = sortable ? { ...SORT_ONLY, ...FIELDS } : FIELDS;
  return groups
    .map((group) => {
      const rows = Object.entries(all).filter(([key, f]) => f.group === group && (key !== "shortest_path" || reference));
      if (!rows.length) return "";
      return `<optgroup label="${group}">${rows
        .map(([key, f]) => `<option value="${key}"${key === selected ? " selected" : ""}>${esc(f.label)}</option>`)
        .join("")}</optgroup>`;
    })
    .join("");
}

const dash = '<span class="sub">—</span>';
const rankCell = (v) => (v === null || v === undefined ? dash : `#${int(v)}`);

function networkCell(node, showFeatures) {
  const tags = PROTOCOLS.filter(([key]) => node[key]).map(([, label]) => `<span class="tag">${label}</span>`);
  const feats = showFeatures ? FEATURES.filter(([key]) => node[key]) : [];
  if (feats.length) {
    // One compact tag of letters; the full names are in the title.
    tags.push(
      `<span class="tag nl-ft" title="${esc(feats.map(([, , , title]) => title).join(", "))}">${feats
        .map(([key, , letter]) => (key === "wumbo" ? `<b>${letter}</b>` : letter))
        .join("")}</span>`,
    );
  }
  return tags.length ? `<span class="nl-tags">${tags.join("")}</span>` : dash;
}

/** Column list for the current state: id, header, sort field, cell renderer. */
function columnDefs(st, enabled) {
  const on = (id) => enabled.has(id);
  const cols = [
    { id: "idx", head: "#", cls: "nl-idx", cell: (n, i) => `<span class="mono sub">${int(i)}</span>` },
    {
      id: "node",
      head: "Node",
      sort: "alias",
      cls: "nl-node",
      cell: (n) =>
        `<span class="name"><b><a href="/node/${esc(n.pubkey)}">${esc(n.alias || "Unnamed node")}</a></b><span>${esc(shortKey(n.pubkey))}</span></span>`,
    },
    {
      id: "capacity",
      head: 'Capacity <small class="unit">BTC</small>',
      sort: "total_capacity",
      cls: "nl-cap",
      cell: (n, i, max) =>
        `<span class="capcell"><span class="bar"><i style="width:${max && n.total_capacity ? Math.max(1, (n.total_capacity / max) * 100).toFixed(1) : 0}%"></i></span><span class="mono">${btcHtml(n.total_capacity, false)}</span></span>`,
    },
    { id: "num_channels", head: "Channels", sort: "num_channels", cls: "r mono", cell: (n) => int(n.num_channels) },
    on("active_channels") && { id: "active_channels", head: "Active", title: "Active channels", sort: "active_channels", cls: "r mono", cell: (n) => int(n.active_channels) },
    { id: "med_out_ppm", head: 'Out fee <small class="unit">ppm</small>', title: "Median outgoing fee rate", sort: "med_out_ppm", cls: "r mono", cell: (n) => num(n.med_out_ppm, 1) },
    on("avg_out_ppm") && { id: "avg_out_ppm", head: 'Avg out <small class="unit">ppm</small>', title: "Average outgoing fee rate", sort: "avg_out_ppm", cls: "r mono", cell: (n) => num(n.avg_out_ppm, 1) },
    on("med_out_base") && { id: "med_out_base", head: "Base fee", title: "Median outgoing base fee", sort: "med_out_base", cls: "r mono", cell: (n) => baseFee(n.med_out_base) },
    on("med_capacity") && { id: "med_capacity", head: 'Median ch. <small class="unit">BTC</small>', title: "Median channel size", sort: "med_capacity", cls: "r mono", cell: (n) => btcHtml(n.med_capacity, false) },
    st.reference && { id: "shortest_path", head: "Hops", title: "Shortest path length from the reference node", sort: "shortest_path", cls: "r mono", cell: (n) => (n.shortest_path === null || n.shortest_path === undefined ? dash : int(n.shortest_path)) },
    { id: "betweenness_rank", head: "Centrality", title: "Betweenness rank; 1 is the most central node", sort: "betweenness_rank", cls: "r mono", cell: (n) => rankCell(n.betweenness_rank) },
    on("betweenness_weighted_rank") && { id: "betweenness_weighted_rank", head: "Betw. wt.", title: "Betweenness rank, weighted by capacity", sort: "betweenness_weighted_rank", cls: "r mono", cell: (n) => rankCell(n.betweenness_weighted_rank) },
    on("closeness_rank") && { id: "closeness_rank", head: "Closeness", title: "Closeness rank", sort: "closeness_rank", cls: "r mono", cell: (n) => rankCell(n.closeness_rank) },
    on("closeness_weighted_rank") && { id: "closeness_weighted_rank", head: "Clos. wt.", title: "Closeness rank, weighted", sort: "closeness_weighted_rank", cls: "r mono", cell: (n) => rankCell(n.closeness_weighted_rank) },
    on("eigenvector_rank") && { id: "eigenvector_rank", head: "Eigenvector", title: "Eigenvector rank", sort: "eigenvector_rank", cls: "r mono", cell: (n) => rankCell(n.eigenvector_rank) },
    on("eigenvector_weighted_rank") && { id: "eigenvector_weighted_rank", head: "Eigen. wt.", title: "Eigenvector rank, weighted", sort: "eigenvector_weighted_rank", cls: "r mono", cell: (n) => rankCell(n.eigenvector_weighted_rank) },
    { id: "network", head: "Network", title: on("features") ? "Address types, then announced features: W wumbo, A anchors, D dual funding, O onion messages, R route blinding" : "", cls: "r nl-net", cell: (n) => networkCell(n, on("features")) },
  ];
  return cols.filter(Boolean);
}

function headCell(col, st) {
  const title = col.title ? ` title="${esc(col.title)}"` : "";
  if (!col.sort) return `<th scope="col" class="${col.cls}"${title}>${col.head}</th>`;
  const active = st.sort === col.sort;
  const aria = active ? ` aria-sort="${st.dir === "asc" ? "ascending" : "descending"}"` : "";
  const arrow = active ? icon("chevD", st.dir === "asc" ? "nl-up" : "") : "";
  return `<th scope="col" class="${col.cls}"${aria}${title}><button type="button" data-sort="${col.sort}">${col.head}${arrow}</button></th>`;
}

function skeletonRows(count, width) {
  return Array.from(
    { length: count },
    () => `<tr><td colspan="${width}"><span class="skel line" style="width:${40 + Math.round(Math.random() * 50)}%"></span></td></tr>`,
  ).join("");
}

export async function mount(ctx) {
  ctx.setTitle("Nodes");
  let st = readState(ctx.route.params);
  const columns = loadColumns();
  let pop = null; // open popover: "add" | "edit:<i>" | "sort" | "cols" | "ref"
  let data = null;
  let fetchCtrl = null;
  let hovered = null;
  const refAlias = new Map();

  const sheet = openSheet(ctx.el, {
    title: "Nodes",
    placement: "left",
    width: 860,
    actions: `<details class="info right"><summary aria-label="About this table">${icon("info")}</summary><div>
      <p>Every node with at least one public channel. Hover a row to find it on the map; click it to inspect it there.</p>
      <p>Centrality ranks are sampled: rank 1 is the most central node. A reference node adds a Hops column with the shortest path from it, and can limit the table to nodes it can reach.</p></div></details>`,
  });
  sheet.root.classList.add("nl-sheet");

  const filters = document.createElement("div");
  filters.className = "nl-filters";
  filters.innerHTML = `
    <div class="nl-row">
      <label class="nl-search">${icon("search")}<span class="sr-only">Filter by alias or public key</span>
        <input class="nl-q" type="search" placeholder="Filter by alias or key" value="${esc(st.q)}" autocomplete="off" spellcheck="false" /></label>
      <div class="nl-dyn"></div>
    </div>
    <div class="nl-row nl-row2"></div>`;
  sheet.root.insertBefore(filters, sheet.body);
  const dyn = filters.querySelector(".nl-dyn");
  const row2 = filters.querySelector(".nl-row2");
  const qInput = filters.querySelector(".nl-q");

  sheet.body.classList.add("nl-body");
  sheet.body.innerHTML = `<table class="dtable nl-table"><thead></thead><tbody></tbody></table><div class="nl-empty" hidden></div>`;
  const table = sheet.body.querySelector("table");
  const thead = table.tHead;
  const tbody = table.tBodies[0];
  const empty = sheet.body.querySelector(".nl-empty");

  const foot = document.createElement("footer");
  foot.className = "nl-foot";
  sheet.root.appendChild(foot);

  // ---------- map ----------
  const syncInsets = () => map.setInsets(sheet.insets());
  syncInsets();
  sheet.root.addEventListener("animationend", syncInsets, { once: true });
  window.addEventListener("resize", syncInsets);
  map
    .ensure()
    .then(() => {
      if (!ctx.alive()) return;
      map.clear();
      map.frame();
    })
    .catch(() => {});

  // ---------- state ----------
  function commit(next, { resetPage = true } = {}) {
    st = { ...st, ...next };
    if (resetPage && !("page" in next)) st.page = 1;
    if (!st.reference) st.reachable = false;
    if (st.sort === "shortest_path" && !st.reference) {
      st.sort = DEFAULT_SORT;
      st.dir = defaultDir(DEFAULT_SORT);
    }
    pop = null;
    setQuery(writeParams(st, location.search));
    renderBar();
    load();
  }

  // ---------- filter bar ----------
  function condChip(c, i) {
    const f = FIELDS[c.field];
    const label = `${f.label} ${REL[c.rel]} ${valueText(f.kind, c.value)}`;
    return `<span class="nl-anchor"><span class="chip on nl-cond">
        <button type="button" class="nl-chiptext" data-act="edit" data-i="${i}" aria-expanded="${pop === `edit:${i}`}" aria-haspopup="dialog" aria-label="Edit filter: ${esc(label)}">${esc(label)}</button>
        <button type="button" class="x" data-act="rmcond" data-i="${i}" aria-label="Remove filter: ${esc(label)}">${icon("x")}</button>
      </span>${pop === `edit:${i}` ? condForm(c) : ""}</span>`;
  }

  function condForm(c) {
    const field = c ? c.field : "num_channels";
    const kind = FIELDS[field].kind;
    return `<form class="nl-pop glass" data-form="cond" data-i="${c ? st.conditions.indexOf(c) : -1}" novalidate>
        <label class="field"><span>Field</span><select class="input sm" name="field">${fieldOptions(field, st)}</select></label>
        <div class="nl-relval">
          <select class="input sm" name="rel" aria-label="Relation">${Object.entries(REL_LABEL)
            .map(([key, label]) => `<option value="${key}"${c && c.rel === key ? " selected" : ""}>${label}</option>`)
            .join("")}</select>
          <span class="nl-val"><input class="input sm mono" name="value" type="number" step="any" inputmode="decimal" aria-label="Value" required value="${c ? esc(editValue(kind, c.value)) : ""}" /><span class="nl-unit">${UNIT[kind]}</span></span>
        </div>
        <p class="sub nl-hint">${HINT[kind]}</p>
        <p class="nl-err" role="alert" hidden></p>
        <div class="nl-pop-act"><button type="button" class="btn sm ghost" data-act="close">Cancel</button><button type="submit" class="btn sm primary">${c ? "Update" : "Add filter"}</button></div>
      </form>`;
  }

  function sortPop() {
    const info = fieldInfo(st.sort);
    const isText = info.kind === "text";
    return `<div class="nl-pop glass nl-pop-r" data-form="sort">
        <label class="field"><span>Sort by</span><select class="input sm" name="sort">${fieldOptions(st.sort, { ...st, sortable: true })}</select></label>
        <div class="seg nl-dir" role="group" aria-label="Direction">
          <button type="button" data-act="dir" data-v="desc" aria-pressed="${st.dir === "desc"}">${isText ? "Z → A" : "High → low"}</button>
          <button type="button" data-act="dir" data-v="asc" aria-pressed="${st.dir === "asc"}">${isText ? "A → Z" : "Low → high"}</button>
        </div>
      </div>`;
  }

  function colsPop() {
    return `<div class="nl-pop glass nl-pop-r nl-cols" data-form="cols" role="group" aria-label="Optional columns">
        ${OPTIONAL.map(
          ([id, label]) => `<label class="check"><input type="checkbox" data-col="${id}"${columns.has(id) ? " checked" : ""} />${esc(label)}</label>`,
        ).join("")}
      </div>`;
  }

  function refPop() {
    return `<form class="nl-pop glass" data-form="ref" novalidate>
        <label class="field"><span>Reference node</span><span class="nl-acwrap"><input class="input sm" name="ref" placeholder="Alias or public key" value="${esc(st.reference)}" spellcheck="false" /></span></label>
        <label class="check"><input type="checkbox" name="reachable"${st.reachable ? " checked" : ""} />Only nodes it can reach</label>
        <p class="sub nl-hint">Adds a Hops column: the shortest path from this node to each row.</p>
        <p class="nl-err" role="alert" hidden></p>
        <div class="nl-pop-act">${st.reference ? '<button type="button" class="btn sm ghost" data-act="rmref">Remove</button>' : ""}<span class="nl-sp"></span><button type="button" class="btn sm ghost" data-act="close">Cancel</button><button type="submit" class="btn sm primary">Apply</button></div>
      </form>`;
  }

  function refLabel() {
    const alias = refAlias.get(st.reference);
    return alias || shortKey(st.reference);
  }

  function renderBar() {
    const n = st.conditions.length;
    const sortInfo = fieldInfo(st.sort);
    dyn.innerHTML = `
      <div class="nl-conds">
        ${st.conditions.map(condChip).join("")}
        <span class="nl-anchor"><button type="button" class="chip add" data-act="add" aria-expanded="${pop === "add"}" aria-haspopup="dialog">${icon("plus")}Add filter</button>${pop === "add" ? condForm(null) : ""}</span>
      </div>
      <div class="nl-tools">
        <span class="nl-anchor"><button type="button" class="chip" data-act="sort" aria-expanded="${pop === "sort"}" aria-haspopup="dialog" aria-label="Sort: ${esc(sortInfo.label)}, ${st.dir === "asc" ? "ascending" : "descending"}">${icon("sort")}${esc(sortInfo.label)}<span class="nl-dirmark" aria-hidden="true">${st.dir === "asc" ? "↑" : "↓"}</span></button>${pop === "sort" ? sortPop() : ""}</span>
        <span class="nl-anchor"><button type="button" class="chip" data-act="cols" aria-expanded="${pop === "cols"}" aria-haspopup="dialog">Columns${icon("chevD")}</button>${pop === "cols" ? colsPop() : ""}</span>
      </div>`;

    const protoTitle = "Pick several to show nodes that announce all of them";
    row2.innerHTML = `
      <div class="nl-group" role="group" aria-label="Network address types" title="${protoTitle}">
        ${PROTOCOLS.map(
          ([key, label]) =>
            `<button type="button" class="chip nl-tog${st.protocols.has(key) ? " on" : ""}" data-act="proto" data-v="${key}" aria-pressed="${st.protocols.has(key)}" title="${protoTitle}">${label}</button>`,
        ).join("")}
      </div>
      <label class="nl-feat${st.feature ? " on" : ""}"><span class="sr-only">Feature</span>
        <select class="input sm" data-act="feature">
          <option value="">Any feature</option>
          ${FEATURES.map(([key, label]) => `<option value="${key}"${st.feature === key ? " selected" : ""}>${label}</option>`).join("")}
        </select></label>
      <span class="nl-anchor">${
        st.reference
          ? `<span class="chip on nl-cond"><button type="button" class="nl-chiptext" data-act="ref" aria-expanded="${pop === "ref"}" aria-haspopup="dialog">${icon("route")}Hops from ${esc(refLabel())}${st.reachable ? '<span class="sub"> · reachable only</span>' : ""}</button><button type="button" class="x" data-act="rmref" aria-label="Remove reference node">${icon("x")}</button></span>`
          : `<button type="button" class="chip add" data-act="ref" aria-expanded="${pop === "ref"}" aria-haspopup="dialog">${icon("route")}Reference node</button>`
      }${pop === "ref" ? refPop() : ""}</span>
      ${
        n >= 2 || (n === 1 && st.quantifier === "none")
          ? `<div class="nl-match"><span class="lbl" id="nl-match-l">Match</span><div class="seg" role="group" aria-labelledby="nl-match-l">${QUANTIFIERS.map(
              ([key, label, title]) => `<button type="button" data-act="quant" data-v="${key}" aria-pressed="${st.quantifier === key}" title="${title}">${label}</button>`,
            ).join("")}</div></div>`
          : ""
      }
      <span class="nl-sp"></span>
      ${filtersActive(st) ? '<button type="button" class="btn sm ghost" data-act="clear">Clear all</button>' : ""}`;

    const form = filters.querySelector(".nl-pop");
    if (!form) return;
    if (form.dataset.form === "ref") {
      const input = form.querySelector('[name="ref"]');
      attachAutocomplete(input, (item) => {
        refAlias.set(item.pubkey, item.alias || "");
      });
      input.focus();
    } else {
      (form.querySelector('[name="value"]') || form.querySelector("select, input"))?.focus();
    }
  }

  function setPop(next) {
    if (pop === next) return closePop();
    pop = next;
    renderBar();
  }

  function closePop({ focus = true } = {}) {
    if (!pop) return;
    const was = pop;
    pop = null;
    renderBar();
    if (focus) {
      const sel = was.startsWith("edit:") ? `[data-act="edit"][data-i="${was.slice(5)}"]` : `[data-act="${was}"]`;
      filters.querySelector(sel)?.focus();
    }
  }

  function showError(form, message) {
    const el = form.querySelector(".nl-err");
    el.textContent = message;
    el.hidden = false;
  }

  filters.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-act]");
    if (!btn || btn.tagName === "SELECT") return;
    const act = btn.dataset.act;
    if (act === "add" || act === "sort" || act === "cols" || act === "ref") setPop(act);
    else if (act === "edit") setPop(`edit:${btn.dataset.i}`);
    else if (act === "close") closePop();
    else if (act === "rmcond") commit({ conditions: st.conditions.filter((_, i) => i !== Number(btn.dataset.i)) });
    else if (act === "rmref") commit({ reference: "", reachable: false });
    else if (act === "quant") commit({ quantifier: btn.dataset.v });
    else if (act === "dir") commit({ dir: btn.dataset.v });
    else if (act === "proto") {
      const protocols = new Set(st.protocols);
      if (protocols.has(btn.dataset.v)) protocols.delete(btn.dataset.v);
      else protocols.add(btn.dataset.v);
      commit({ protocols });
    } else if (act === "clear") {
      qInput.value = "";
      commit({ q: "", conditions: [], quantifier: "all", protocols: new Set(), feature: "", reference: "", reachable: false });
    }
  });

  filters.addEventListener("change", (event) => {
    const target = event.target;
    if (target.dataset.act === "feature") commit({ feature: target.value });
    else if (target.dataset.col) {
      if (target.checked) columns.add(target.dataset.col);
      else columns.delete(target.dataset.col);
      saveColumns(columns);
      renderTable();
    } else if (target.name === "sort" && target.closest('[data-form="sort"]')) {
      commit({ sort: target.value, dir: defaultDir(target.value) });
      pop = "sort";
      renderBar();
    } else if (target.name === "field" && target.closest('[data-form="cond"]')) {
      const form = target.form;
      const kind = FIELDS[target.value].kind;
      form.querySelector(".nl-unit").textContent = UNIT[kind];
      form.querySelector(".nl-hint").textContent = HINT[kind];
    }
  });

  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.dataset.form === "cond") {
      const field = form.elements.field.value;
      const rel = form.elements.rel.value;
      const raw = form.elements.value.value.trim();
      const entered = Number(raw);
      if (raw === "" || !Number.isFinite(entered)) return showError(form, "Enter a number.");
      const value = FIELDS[field].kind === "sats" ? Math.round(entered * 1e8) : entered;
      const conditions = [...st.conditions];
      const index = Number(form.dataset.i);
      if (index >= 0) conditions[index] = { field, rel, value };
      else conditions.push({ field, rel, value });
      commit({ conditions });
    } else if (form.dataset.form === "ref") {
      const reference = form.elements.ref.value.trim().toLowerCase();
      if (!PUBKEY_RE.test(reference)) return showError(form, "Pick a node from the suggestions or paste a 66-character public key.");
      const reachable = form.elements.reachable.checked;
      commit({ reference, reachable });
    }
  });

  filters.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pop && !event.defaultPrevented) {
      event.preventDefault();
      closePop();
    }
  });

  const onDocClick = (event) => {
    if (pop && !event.target.closest(".nl-anchor, .nl-cond, .nl-pop")) closePop({ focus: false });
  };
  document.addEventListener("click", onDocClick);

  let qTimer = null;
  qInput.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      const q = qInput.value.trim();
      if (q !== st.q) commit({ q });
    }, 280);
  });

  // ---------- table ----------
  function renderTable() {
    const cols = columnDefs(st, columns);
    thead.innerHTML = `<tr>${cols.map((col) => headCell(col, st)).join("")}</tr>`;
    if (!data) {
      tbody.innerHTML = skeletonRows(10, cols.length);
      return;
    }
    const rows = data.objects;
    table.hidden = !rows.length;
    empty.hidden = Boolean(rows.length);
    if (!rows.length) {
      empty.innerHTML = `<div class="empty-line">${icon("filter")}<span>No nodes match these filters.</span>${
        filtersActive(st) ? '<button type="button" class="btn sm" data-act="clear-empty">Clear filters</button>' : ""
      }</div>`;
      tbody.innerHTML = "";
      return;
    }
    const max = Math.max(0, ...rows.map((n) => n.total_capacity || 0));
    const offset = (data.page - 1) * data.page_size;
    tbody.innerHTML = rows
      .map(
        (node, i) =>
          `<tr class="rowlink" tabindex="0" data-pk="${esc(node.pubkey)}">${cols
            .map((col) => `<td class="${col.cls}">${col.cell(node, offset + i + 1, max)}</td>`)
            .join("")}</tr>`,
      )
      .join("");
  }

  function renderFoot() {
    if (!data || !data.total_count) {
      foot.hidden = true;
      return;
    }
    foot.hidden = false;
    const from = (data.page - 1) * data.page_size + 1;
    const to = from + data.objects.length - 1;
    foot.innerHTML = `
      <span class="mono">${int(from)}–${int(to)} <span class="sub">of</span> ${int(data.total_count)}</span>
      <span class="nl-sp"></span>
      ${data.pages > 1 ? `<span class="sub">Page ${int(data.page)} of ${int(data.pages)}</span>` : ""}
      <button type="button" class="btn sm icon" data-page="${data.page - 1}" aria-label="Previous page"${data.page <= 1 ? " disabled" : ""}>${icon("arrowL")}</button>
      <button type="button" class="btn sm icon" data-page="${data.page + 1}" aria-label="Next page"${data.page >= data.pages ? " disabled" : ""}>${icon("arrowR")}</button>`;
  }

  function renderSub() {
    if (!data) return;
    if (!filtersActive(st)) {
      sheet.sub.textContent = `${int(data.total_count)} public`;
      return;
    }
    const matched = data.total_count;
    sheet.sub.textContent = `${int(matched)} match`;
    cached("/api/nodes?page_size=1", 300_000)
      .then((all) => {
        if (ctx.alive() && data && data.total_count === matched && filtersActive(st)) {
          sheet.sub.textContent = `${int(matched)} of ${int(all.total_count)} match`;
        }
      })
      .catch(() => {});
  }

  function resolveReference() {
    const pk = st.reference;
    if (!PUBKEY_RE.test(pk) || refAlias.has(pk)) return;
    cached(`/api/nodes/${pk}`, 300_000)
      .then((node) => {
        refAlias.set(pk, node.alias || "");
        // Never re-render under an open popover: it would drop what is being typed.
        if (ctx.alive() && st.reference === pk && !pop) renderBar();
      })
      .catch(() => {});
  }

  async function load() {
    fetchCtrl?.abort();
    const mine = new AbortController();
    fetchCtrl = mine;
    const signal = AbortSignal.any([ctx.signal, mine.signal]);
    resolveReference();
    if (!data) renderTable();
    sheet.body.setAttribute("aria-busy", "true");
    sheet.root.classList.add("nl-busy");
    try {
      const next = await api(`/api/nodes?${apiQuery(st)}`, { signal });
      if (!ctx.alive() || fetchCtrl !== mine) return;
      data = next;
      if (data.page !== st.page && data.objects.length) {
        st.page = data.page;
        setQuery(writeParams(st, location.search));
      }
      renderTable();
      renderFoot();
      renderSub();
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      data = null;
      table.hidden = true;
      foot.hidden = true;
      empty.hidden = false;
      empty.innerHTML = `<div class="empty-line">${icon("alert")}<span>${esc(error.message || "The node list could not load.")}</span>${
        filtersActive(st) ? '<button type="button" class="btn sm" data-act="clear-empty">Clear filters</button>' : ""
      }</div>`;
    } finally {
      if (fetchCtrl === mine) {
        sheet.body.removeAttribute("aria-busy");
        sheet.root.classList.remove("nl-busy");
      }
    }
  }

  thead.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-sort]");
    if (!btn) return;
    const sort = btn.dataset.sort;
    const dir = st.sort === sort ? (st.dir === "asc" ? "desc" : "asc") : defaultDir(sort);
    commit({ sort, dir });
  });

  empty.addEventListener("click", (event) => {
    if (!event.target.closest('[data-act="clear-empty"]')) return;
    qInput.value = "";
    commit({ q: "", conditions: [], quantifier: "all", protocols: new Set(), feature: "", reference: "", reachable: false });
  });

  foot.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-page]");
    if (!btn || btn.disabled) return;
    commit({ page: Number(btn.dataset.page) }, { resetPage: false });
    sheet.body.scrollTop = 0;
  });

  const preview = (pk) => {
    if (pk === hovered) return;
    hovered = pk;
    map.preview(pk);
  };
  tbody.addEventListener("mouseover", (event) => {
    const row = event.target.closest("tr[data-pk]");
    if (row) preview(row.dataset.pk);
  });
  tbody.addEventListener("mouseleave", () => preview(null));
  tbody.addEventListener("focusin", (event) => {
    const row = event.target.closest("tr[data-pk]");
    if (row) preview(row.dataset.pk);
  });
  tbody.addEventListener("focusout", (event) => {
    if (!tbody.contains(event.relatedTarget)) preview(null);
  });
  tbody.addEventListener("click", (event) => {
    if (event.target.closest("a, button")) return;
    const row = event.target.closest("tr[data-pk]");
    if (row) go(homeUrl({ node: row.dataset.pk }));
  });
  tbody.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target.tagName !== "TR") return;
    event.preventDefault();
    go(homeUrl({ node: event.target.dataset.pk }));
  });

  renderBar();
  load();

  return () => {
    clearTimeout(qTimer);
    fetchCtrl?.abort();
    window.removeEventListener("resize", syncInsets);
    document.removeEventListener("click", onDocClick);
    map.preview(null);
  };
}
