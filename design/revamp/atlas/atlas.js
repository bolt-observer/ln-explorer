// Atlas hi-fi mockup renderer. Reads window.ATLAS (live API snapshot) and draws every screen.
(() => {
  const A = window.ATLAS;
  const N = A.N; // [alias, pubkey, x, y, channels, capacityBTC, betweennessRank]
  const E = A.E; // [a, b, scid]
  const byPk = new Map(N.map((n, i) => [n[1], i]));
  const adj = N.map(() => []);
  E.forEach(([a, b]) => { adj[a].push(b); adj[b].push(a); });
  const ACINQ = byPk.get(A.node.pubkey);
  const PEER = byPk.get(A.channel.node1.pubkey);
  const BINANCE = N.findIndex((n) => n[0] === "Binance");
  const KRAKEN = N.findIndex((n) => n[0].startsWith("Kraken"));
  const ACCENT = "#1dfebb";

  // ---------- formatting ----------
  const int = (v) => Math.round(v).toLocaleString("en-US");
  const btc = (sats, d = 2) => (sats / 1e8).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const short = (pk) => `${pk.slice(0, 6)}…${pk.slice(-6)}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const month = (ts) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

  // ---------- icons ----------
  const I = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
    route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/>',
    arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    arrowL: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    ext: '<path d="M7 17 17 7M8 7h9v9"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM17 6h3v2a3 3 0 0 1-3 3M7 6H4v2a3 3 0 0 0 3 3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    sort: '<path d="M7 4v16M3 8l4-4 4 4M17 20V4M21 16l-4 4-4-4"/>',
  };
  const ico = (name, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24">${I[name]}</svg>`;

  // ---------- logo concepts ----------
  const LOGOS = {
    "graph-bolt": {
      name: "A · Graph bolt",
      note: "A lightning bolt drawn as a path through four nodes. It reads as “bolt” and as a network route, and the mint end node is the observed node.",
      svg: `<path d="M14.6 2.9 6.6 12.9l9-1.8-7.1 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>
            <circle cx="14.6" cy="2.9" r="2" fill="currentColor"/><circle cx="6.6" cy="12.9" r="2" fill="currentColor"/>
            <circle cx="15.6" cy="11.1" r="2" fill="currentColor"/><circle cx="8.5" cy="21.1" r="2.4" fill="${ACCENT}"/>`,
    },
    aperture: {
      name: "B · Aperture",
      note: "An observer's lens with one node caught inside it. The quietest option, and it scales down to a dot-in-ring favicon.",
      svg: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/>
            <circle cx="12" cy="12" r="4.6" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".45"/>
            <circle cx="14.4" cy="9.6" r="2.4" fill="${ACCENT}"/>`,
    },
    constellation: {
      name: "C · Constellation",
      note: "Three nodes and their channels, one of them lit. The most literal “network” mark, and the closest to the map itself.",
      svg: `<path d="M5 18 12 5l7 11.5Z M12 5v8.5 M5 18l7-4.5 7 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity=".9"/>
            <circle cx="5" cy="18" r="2" fill="currentColor"/><circle cx="19" cy="16.5" r="2" fill="currentColor"/>
            <circle cx="12" cy="13.5" r="1.6" fill="currentColor"/><circle cx="12" cy="5" r="2.6" fill="${ACCENT}"/>`,
    },
    wordmark: {
      name: "D · Wordmark only",
      note: "No symbol, just a tight lowercase wordmark with a mint full stop. The favicon becomes the dot. It's the most minimal option but has the least recognition as an icon.",
      svg: `<circle cx="12" cy="12" r="4" fill="${ACCENT}"/>`,
    },
  };
  const logo = (k = "graph-bolt") => `<svg viewBox="0 0 24 24">${LOGOS[k].svg}</svg>`;
  document.querySelectorAll("[data-logo]").forEach((el) => { el.innerHTML = LOGOS[el.dataset.logo].svg; });

  function renderLogoBoard() {
    const host = document.getElementById("logo-board");
    host.innerHTML = Object.entries(LOGOS).map(([k, L], i) => {
      const word = k === "wordmark"
        ? `<span style="font-family:var(--sans);font-weight:600;font-size:15px;letter-spacing:-.03em">bolt<span style="color:${ACCENT}">.</span>observer</span>`
        : `${logo(k)}<span>bolt<span style="color:var(--muted);font-weight:500">.observer</span></span>`;
      const stage = k === "wordmark"
        ? `<span style="font-weight:600;font-size:34px;letter-spacing:-.04em">bolt<span style="color:${ACCENT}">.</span>observer</span>`
        : `<svg viewBox="0 0 24 24" style="width:64px;height:64px;color:var(--text)">${L.svg}</svg>`;
      return `<div class="tile logo-tile">
        ${i === 0 ? '<span class="pick">Chosen</span>' : '<span class="pick" style="color:transparent">·</span>'}
        <div class="stage">${stage}</div>
        <div class="lockup">${word}</div>
        <div class="sizes"><div class="fav">${logo(k)}</div><svg viewBox="0 0 24 24" style="width:16px;height:16px">${L.svg}</svg><span class="sub">favicon · 16px</span></div>
        <b style="font-weight:600">${L.name}</b>
        <p>${L.note}</p>
      </div>`;
    }).join("");
  }

  function renderTokens() {
    const sw = [
      ["Canvas", "#070908"], ["Raised", "#0d1110"], ["Glass", "rgba(13,17,16,.74)"], ["Line", "rgba(255,255,255,.07)"],
      ["Text", "#e8eeeb"], ["Text 2", "#b0bab6"], ["Muted", "#808b87"], ["Faint", "#59635f"],
      ["Accent", "#1dfebb"], ["Accent soft", "rgba(29,254,187,.12)"], ["Negative", "#ff8f70"], ["Warning", "#f2c14e"],
    ];
    document.getElementById("token-board").innerHTML = `
      <div class="tile"><h3>Colour</h3><div class="swatches">${sw.map(([n, c]) => `<div class="swatch"><i style="background:${c}"></i>${n}<code>${c}</code></div>`).join("")}</div></div>
      <div class="tile typescale"><h3>Type</h3>
        <div><code>Display 48</code><span style="font-size:34px;font-weight:600;letter-spacing:-.035em;line-height:1">ACINQ</span></div>
        <div><code>Title 22</code><span style="font-size:22px;font-weight:600;letter-spacing:-.02em">Network</span></div>
        <div><code>Body 13</code><span>Runs 1,900 public channels</span></div>
        <div><code>Label 11.5</code><span class="lbl">Median outgoing fee</span></div>
        <div><code>Number 30</code><span class="mono" style="font-size:30px;font-weight:500;letter-spacing:-.03em">361.11</span></div>
        <div><code>Key 12</code><span class="key">03864e…7a3f8f ${ico("copy")}</span></div>
      </div>
      <div class="tile"><h3>Components</h3>
        <div class="comps">
          <span class="btn primary">Open full profile ${ico("arrowR")}</span><span class="btn">${ico("route")}Find route</span><span class="btn icon">${ico("copy")}</span>
          <span class="seg"><span class="on">Capacity</span><span>Channels</span><span>Nodes</span></span>
          <span class="chip on">Channels ≥ 30 ${ico("x")}</span><span class="chip add">${ico("plus")}Add filter</span>
          <span class="tag">Tor</span><span class="tag acc">#1</span><span class="kbd">⌘K</span>
          <span style="display:flex;align-items:center;gap:8px;width:100%"><span class="lbl" style="width:80px">Capacity</span><span class="bar acc" style="flex:1"><i style="width:82%"></i></span><span class="mono" style="font-size:12px">43.61</span></span>
          <span style="display:flex;align-items:center;gap:8px;width:100%"><span class="lbl" style="width:80px">Peer</span><span class="bar" style="flex:1"><i style="width:48%"></i></span><span class="mono" style="font-size:12px">11.76</span></span>
        </div>
      </div>`;
  }

  // ---------- map renderer ----------
  function setupCanvas(cv, W, H) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const c = cv.getContext("2d");
    c.scale(dpr, dpr);
    return c;
  }

  function backdrop(c, W, H, cx = W * 0.5, cy = H * 0.45) {
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.75);
    g.addColorStop(0, "#0e1715"); g.addColorStop(0.55, "#090c0b"); g.addColorStop(1, "#070908");
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.fillStyle = "rgba(255,255,255,0.03)";
    for (let x = 14; x < W; x += 28) for (let y = 14; y < H; y += 28) c.fillRect(x, y, 1, 1);
  }

  const overlap = (a, b) => !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);

  function label(c, text, x, y, r, boxes, W, H, style) {
    const t = text.length > 24 ? `${text.slice(0, 23)}…` : text;
    c.font = style.pill ? '600 12.5px "IBM Plex Sans"' : '500 12px "IBM Plex Sans"';
    const w = c.measureText(t).width + (style.pill ? 18 : 0), h = style.pill ? 24 : 16;
    const tries = [[x + r + 7, y - h / 2], [x - r - 7 - w, y - h / 2], [x - w / 2, y + r + 5], [x - w / 2, y - r - 5 - h]];
    for (const [bx, by] of tries) {
      const b = { x: bx - 2, y: by - 2, w: w + 4, h: h + 4 };
      if (b.x < 10 || b.y < 10 || b.x + b.w > W - 10 || b.y + b.h > H - 10) continue;
      if (boxes.some((q) => overlap(b, q))) continue;
      boxes.push(b);
      if (style.pill) {
        c.fillStyle = ACCENT; c.beginPath(); c.roundRect(bx, by, w, h, 7); c.fill();
        c.fillStyle = "#02281d"; c.fillText(t, bx + 9, by + 16.5);
      } else {
        c.lineJoin = "round"; c.lineWidth = 4; c.strokeStyle = "rgba(7,9,8,0.9)"; c.strokeText(t, bx, by + 12);
        c.fillStyle = style.color; c.fillText(t, bx, by + 12);
      }
      return true;
    }
    return false;
  }

  // o: { zoom, center (node idx), at [x,y], point [nx,ny], focus, edge [a,b], hover, dim, labels, avoid: [rects] }
  function drawMap(cv, W, H, o = {}) {
    const c = setupCanvas(cv, W, H);
    const zoom = o.zoom ?? 1;
    const s = Math.min(W, H) * 0.9 * zoom;
    const [ax, ay] = o.at ?? [W / 2, H / 2];
    const [px, py] = o.center != null ? [N[o.center][2], N[o.center][3]] : (o.point ?? [0.5, 0.5]);
    const ox = ax - px * s, oy = ay - py * s;
    const X = (i) => ox + N[i][2] * s, Y = (i) => oy + N[i][3] * s;
    const R = (i) => (1.25 + Math.sqrt(N[i][5]) * 0.5) * (0.8 + 0.2 * zoom);
    backdrop(c, W, H, ax, ay);

    const focus = o.focus ?? null;
    const edge = o.edge ?? null;
    const lit = new Set(focus != null ? [focus, ...adj[focus]] : edge ?? []);
    const dimmed = focus != null || edge != null || o.dim;

    c.globalCompositeOperation = "lighter";
    c.lineWidth = 0.6;
    c.strokeStyle = dimmed ? "rgba(29,254,187,0.014)" : "rgba(29,254,187,0.042)";
    c.beginPath();
    for (const [a, b] of E) {
      if (focus != null && (a === focus || b === focus)) continue;
      c.moveTo(X(a), Y(a)); c.lineTo(X(b), Y(b));
    }
    c.stroke();
    if (focus != null) {
      c.strokeStyle = "rgba(29,254,187,0.30)"; c.lineWidth = 0.9; c.beginPath();
      for (const b of adj[focus]) { c.moveTo(X(focus), Y(focus)); c.lineTo(X(b), Y(b)); }
      c.stroke();
    }
    c.globalCompositeOperation = "source-over";
    if (edge) {
      const [a, b] = edge;
      c.lineCap = "round";
      c.strokeStyle = "rgba(29,254,187,0.18)"; c.lineWidth = 9; c.beginPath(); c.moveTo(X(a), Y(a)); c.lineTo(X(b), Y(b)); c.stroke();
      c.strokeStyle = ACCENT; c.lineWidth = 2; c.beginPath(); c.moveTo(X(a), Y(a)); c.lineTo(X(b), Y(b)); c.stroke();
    }

    if (!dimmed) {
      [...N.keys()].sort((a, b) => N[b][5] - N[a][5]).slice(0, 10).forEach((i) => {
        const r = R(i) * 5, g = c.createRadialGradient(X(i), Y(i), 0, X(i), Y(i), r);
        g.addColorStop(0, "rgba(29,254,187,0.10)"); g.addColorStop(1, "rgba(29,254,187,0)");
        c.fillStyle = g; c.fillRect(X(i) - r, Y(i) - r, r * 2, r * 2);
      });
    }

    const order = [...N.keys()].sort((a, b) => N[a][5] - N[b][5]);
    for (const i of order) {
      const t = Math.min(1, Math.log10(1 + N[i][5]) / 2.7);
      let a = 0.32 + 0.6 * t, col = "200,214,209";
      if (dimmed && !lit.has(i)) a *= o.dim ? 0.45 : 0.24;
      if (lit.has(i)) { a = 0.95; col = "226,240,235"; }
      c.fillStyle = `rgba(${col},${a})`;
      if (i === focus || (edge && edge.includes(i))) c.fillStyle = ACCENT;
      c.beginPath(); c.arc(X(i), Y(i), R(i), 0, Math.PI * 2); c.fill();
    }

    const ring = (i, color, gap, w = 1.5) => { c.strokeStyle = color; c.lineWidth = w; c.beginPath(); c.arc(X(i), Y(i), R(i) + gap, 0, Math.PI * 2); c.stroke(); };
    if (focus != null) { ring(focus, ACCENT, 5); ring(focus, "rgba(29,254,187,0.22)", 13, 1); }
    if (edge) edge.forEach((i) => ring(i, ACCENT, 4));
    if (o.hover != null) { ring(o.hover, "rgba(232,238,235,0.85)", 4); ring(o.hover, "rgba(232,238,235,0.18)", 10, 1); }

    const boxes = [...(o.avoid ?? [])];
    const pinned = [];
    if (focus != null) pinned.push([focus, { pill: true }]);
    if (edge) edge.forEach((i) => pinned.push([i, { pill: true }]));
    if (o.hover != null) pinned.push([o.hover, { color: "rgba(255,255,255,0.98)" }]);
    pinned.forEach(([i, st]) => label(c, N[i][0], X(i), Y(i), R(i), boxes, W, H, st));
    const pool = dimmed && !o.dim ? [...lit] : [...N.keys()];
    const skip = new Set(pinned.map(([i]) => i));
    let n = 0;
    for (const i of pool.sort((a, b) => N[b][5] - N[a][5])) {
      if (n >= (o.labels ?? 16)) break;
      if (skip.has(i)) continue;
      if (label(c, N[i][0], X(i), Y(i), R(i), boxes, W, H, { color: dimmed ? "rgba(232,238,235,0.78)" : "rgba(232,238,235,0.86)" })) n++;
    }
    return { X, Y, R };
  }

  // Peer "sunflower" for the profile hero: every ACINQ peer, ordered by capacity.
  function drawEgo(cv, W, H, cx, cy, avoid = []) {
    const c = setupCanvas(cv, W, H);
    backdrop(c, W, H, cx, cy);
    const caps = A.peerCaps, golden = Math.PI * (3 - Math.sqrt(5));
    const pts = caps.map((cap, i) => {
      const rad = 50 + 13.5 * Math.sqrt(i), ang = i * golden - 0.6;
      return { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad, r: cap > 0 ? 1.5 + Math.sqrt(cap) * 0.95 : 1.2, cap };
    });
    c.globalCompositeOperation = "lighter";
    c.strokeStyle = "rgba(29,254,187,0.03)"; c.lineWidth = 0.6; c.beginPath();
    pts.forEach((p, i) => { if (i >= 8) { c.moveTo(cx, cy); c.lineTo(p.x, p.y); } });
    c.stroke();
    c.strokeStyle = "rgba(29,254,187,0.42)"; c.lineWidth = 1; c.beginPath();
    pts.slice(0, 8).forEach((p) => { c.moveTo(cx, cy); c.lineTo(p.x, p.y); });
    c.stroke();
    c.globalCompositeOperation = "source-over";
    pts.forEach((p, i) => {
      const t = Math.min(1, Math.log10(1 + p.cap) / 1.7);
      c.fillStyle = i < 8 ? "rgba(232,240,236,0.96)" : `rgba(196,216,209,${0.5 + 0.45 * t})`;
      c.beginPath(); c.arc(p.x, p.y, p.r, 0, Math.PI * 2); c.fill();
    });
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, 70);
    g.addColorStop(0, "rgba(29,254,187,0.28)"); g.addColorStop(1, "rgba(29,254,187,0)");
    c.fillStyle = g; c.fillRect(cx - 70, cy - 70, 140, 140);
    c.fillStyle = ACCENT; c.beginPath(); c.arc(cx, cy, 12, 0, Math.PI * 2); c.fill();
    c.strokeStyle = ACCENT; c.lineWidth = 1.5; c.beginPath(); c.arc(cx, cy, 19, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = "rgba(29,254,187,0.2)"; c.lineWidth = 1; c.beginPath(); c.arc(cx, cy, 30, 0, Math.PI * 2); c.stroke();
    const boxes = [{ x: cx - 34, y: cy - 34, w: 68, h: 68 }, ...avoid];
    A.peers.slice(0, 8).forEach(([alias], i) => label(c, alias, pts[i].x, pts[i].y, pts[i].r, boxes, W, H, { color: "rgba(232,238,235,0.92)" }));
  }

  // ---------- small charts (SVG) ----------
  function histogram(values, w, h, hi = -1) {
    const max = Math.max(...values), bw = w / values.length;
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${values.map((v, i) => {
      const bh = Math.max(2, (v / max) * (h - 4));
      return `<rect x="${i * bw + 2}" y="${h - bh}" width="${bw - 4}" height="${bh}" rx="2" fill="${i === hi ? ACCENT : "rgba(200,214,209,0.32)"}"/>`;
    }).join("")}</svg>`;
  }

  function sparkline(values, w, h, color = ACCENT) {
    const min = Math.min(...values), max = Math.max(...values);
    const p = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / (max - min || 1)) * (h - 4)}`).join(" ");
    return `<svg width="${w}" height="${h}"><polyline points="${p}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }

  function historyChart(w, h) {
    const pad = { l: 8, r: 64, t: 14, b: 28 };
    const pts = A.H.filter((p) => !p[1] && p[2] > 0);
    const t0 = pts[0][0], t1 = A.stats.ts, yMax = 6000;
    const X = (t) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - v / yMax) * (h - pad.t - pad.b);
    const segs = [[]];
    pts.forEach((p, i) => {
      if (i && p[0] - pts[i - 1][0] > 60 * 86400) segs.push([]);
      segs.at(-1).push(p);
    });
    const line = (seg) => seg.map((p) => `${X(p[0]).toFixed(1)},${Y(p[2]).toFixed(1)}`).join(" ");
    const area = (seg) => `M${X(seg[0][0])},${Y(0)} L${line(seg).replaceAll(" ", " L")} L${X(seg.at(-1)[0])},${Y(0)}Z`;
    const peak = pts.reduce((a, b) => (b[2] > a[2] ? b : a));
    const years = [];
    for (let y = 2019; y <= 2026; y++) years.push([Date.UTC(y, 0, 1) / 1000, y]);
    const last = pts.at(-1);
    const local = A.stats.capacity / 1e8;
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;overflow:visible">
      <defs><linearGradient id="hg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${ACCENT}" stop-opacity=".22"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/></linearGradient></defs>
      ${[0, 2000, 4000, 6000].map((v) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,${v ? 0.06 : 0.12})"/><text x="${w - pad.r + 10}" y="${Y(v) + 4}" fill="#59635f" font-size="11" font-family="IBM Plex Mono">${v ? int(v) : "0"}${v === 6000 ? " BTC" : ""}</text>`).join("")}
      ${years.map(([t, y]) => `<text x="${X(t)}" y="${h - 6}" fill="#59635f" font-size="11" font-family="IBM Plex Mono" text-anchor="middle">${y}</text>`).join("")}
      ${segs.filter((s) => s.length > 1).map((s) => `<path d="${area(s)}" fill="url(#hg)"/><polyline points="${line(s)}" fill="none" stroke="${ACCENT}" stroke-width="1.6" stroke-linejoin="round"/>`).join("")}
      <line x1="${X(last[0])}" x2="${X(t1)}" y1="${Y(last[2])}" y2="${Y(local)}" stroke="rgba(232,238,235,.45)" stroke-dasharray="3 4"/>
      <circle cx="${X(t1)}" cy="${Y(local)}" r="4" fill="#070908" stroke="#e8eeeb" stroke-width="1.5"/>
      <line x1="${X(peak[0])}" x2="${X(peak[0])}" y1="${pad.t}" y2="${Y(0)}" stroke="rgba(232,238,235,.25)"/>
      <circle cx="${X(peak[0])}" cy="${Y(peak[2])}" r="5" fill="${ACCENT}" stroke="#070908" stroke-width="2"/>
      <g transform="translate(${X(peak[0]) > w - pad.r - 170 ? X(peak[0]) - 162 : X(peak[0]) + 12},${Y(peak[2]) + 10})">
        <rect width="150" height="50" rx="9" fill="rgba(13,17,16,.95)" stroke="rgba(255,255,255,.12)"/>
        <text x="12" y="20" fill="#808b87" font-size="11.5" font-family="IBM Plex Sans">${month(peak[0])}</text>
        <text x="12" y="39" fill="#e8eeeb" font-size="15" font-family="IBM Plex Mono" font-weight="500">${int(peak[2])} BTC</text>
      </g>
    </svg>`;
  }

  // ---------- shared chrome ----------
  const topbar = (active = "", extra = "") => `
    <div class="topbar">
      <div class="brand">${logo()}<span>bolt<span class="tld">.observer</span></span>${extra}</div>
      <div class="search-trigger glass">${ico("search")}<span class="ph-text">Search nodes, channels, keys</span><span class="kbd">⌘K</span></div>
      <nav class="nav glass">${["Nodes", "Rankings", "Stats"].map((n) => `<a class="${n === active ? "on" : ""}">${n}</a>`).join("")}</nav>
    </div>`;

  const mapcard = () => `
    <div class="mapcard glass">
      <div style="display:flex;align-items:center;gap:9px"><span class="dot"></span><b style="font-weight:600">Lightning Network</b><span class="sub" style="margin-left:auto">snapshot 12:00 UTC</span></div>
      <div class="stats">
        <div><div class="lbl">Nodes</div><div class="v">${int(A.stats.nodes)}</div></div>
        <div><div class="lbl">Channels</div><div class="v">${int(A.stats.channels)}</div></div>
        <div><div class="lbl">Median fee</div><div class="v">${A.stats.med_ppm}<small class="sub"> ppm</small></div></div>
      </div>
      <div class="lbl" style="display:flex;justify-content:space-between"><span>Showing ${A.meta.shown_nodes} largest hubs</span><span class="mono">≥ ${A.meta.min_channels} channels</span></div>
      <div class="slider"><div class="track"><i style="width:34%"></i></div><div class="thumb" style="left:34%"></div></div>
      <div class="legend"><span class="sz"><i style="width:4px;height:4px"></i><i style="width:7px;height:7px"></i><i style="width:11px;height:11px"></i></span>Size = capacity<span style="margin-left:auto">Lines = channels</span></div>
    </div>`;

  const zoomctl = (right) => `<div class="zoom glass" style="right:${right}px"><span class="btn icon">${ico("plus")}</span><span class="btn icon">${ico("minus")}</span><div class="hr" style="margin:2px 6px"></div><span class="btn icon">${ico("fit")}</span></div>`;

  const AVOID_TOP = { x: 0, y: 0, w: 99999, h: 72 };

  // ---------- screens ----------
  const S = {};

  S.mapIdle = () => ({
    W: 1440, H: 900,
    html: `<canvas class="map"></canvas>${topbar()}${mapcard()}${zoomctl(20)}<div class="tip glass" id="tip"></div>`,
    after(root) {
      const v = drawMap(root.querySelector("canvas"), 1440, 900, { hover: KRAKEN, labels: 18, point: [0.5, 0.52], at: [720, 480], avoid: [AVOID_TOP, { x: 0, y: 640, w: 340, h: 260 }] });
      const k = N[KRAKEN], tip = root.querySelector("#tip");
      tip.innerHTML = `<b>${esc(k[0])}</b><div class="mono" style="color:var(--text-2);margin-top:2px">${k[5].toFixed(2)} BTC · ${int(k[4])} channels</div><div class="sub" style="margin-top:4px">Click to inspect</div>`;
      tip.style.left = `${v.X(KRAKEN) + 16}px`; tip.style.top = `${v.Y(KRAKEN) + 16}px`;
    },
  });

  S.search = () => {
    const q = "acin";
    const hl = (s) => { const i = s.toLowerCase().indexOf(q); return i < 0 ? esc(s) : `${esc(s.slice(0, i))}<mark>${esc(s.slice(i, i + q.length))}</mark>${esc(s.slice(i + q.length))}`; };
    const rows = A.search.map(([alias, pk, cap, ch], i) => `
      <div class="res ${i === 0 ? "on" : ""}"><span class="av"><i></i></span>
        <span><span class="nm">${hl(alias)}</span> <span class="pk">${short(pk)}</span></span>
        <span class="rt">${btc(cap)} BTC<small>${int(ch)} channels</small></span>
        <span class="kbd" style="visibility:${i === 0 ? "visible" : "hidden"}">↵</span></div>`).join("");
    return {
      W: 1440, H: 900,
      html: `<canvas class="map"></canvas>${topbar()}${mapcard()}${zoomctl(20)}<div class="scrim"></div>
        <div class="palette glass">
          <div class="input">${ico("search")}<span>${q}</span><span class="caret"></span><span style="flex:1"></span><span class="kbd">esc</span></div>
          <div class="grp"><div class="lbl">Nodes</div>${rows}</div>
          <div class="grp"><div class="lbl">Channels</div><div class="hint">${ico("hash")}Paste a channel id like <span class="mono" style="color:var(--text-2)">811984x2037x0</span> or its numeric form</div></div>
          <div class="grp"><div class="lbl">Go to</div>
            <div class="go"><span class="av">${ico("list")}</span>All nodes<span class="kbd">G N</span></div>
            <div class="go"><span class="av">${ico("trophy")}</span>Rankings<span class="kbd">G R</span></div>
            <div class="go"><span class="av">${ico("chart")}</span>Network stats<span class="kbd">G S</span></div>
          </div>
          <footer><span><span class="kbd">↑</span><span class="kbd">↓</span> navigate</span><span><span class="kbd">↵</span> show on map</span><span><span class="kbd">shift ↵</span> open profile</span><span style="margin-left:auto">Searches 5,110 nodes · 26,654 channels</span></footer>
        </div>`,
      after(root) { drawMap(root.querySelector("canvas"), 1440, 900, { labels: 18, point: [0.5, 0.52], at: [720, 480], avoid: [AVOID_TOP] }); },
    };
  };

  const nodeInspector = () => {
    const nd = A.node, peers = A.peers.slice(0, 5), pmax = peers[0][2];
    const feeX = (v) => `${(Math.sqrt(v / 1000) * 100).toFixed(1)}%`;
    const ratio = (nd.med_out_ppm / A.stats.med_ppm).toFixed(1);
    return `<aside class="inspector glass">
      <div class="head">
        <div class="eyebrow"><span>Node</span><span style="margin-left:auto;display:flex;gap:2px"><span class="btn icon sm ghost">${ico("ext")}</span><span class="btn icon sm ghost">${ico("x")}</span></span></div>
        <div class="title" style="display:flex;align-items:center;gap:10px;margin-top:2px"><span class="dot"></span>${esc(nd.alias)}</div>
        <div style="margin-top:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="key">${short(nd.pubkey)} ${ico("copy")}</span><span style="flex:1"></span><span class="tag">Clearnet</span><span class="tag">Tor</span><span class="tag">US</span></div>
      </div>
      <div class="sect"><div class="kpis">
        <div class="kpi"><div class="lbl">Capacity</div><div class="v">${btc(nd.total_capacity)}<small>BTC</small></div><div class="sub">#3 largest</div></div>
        <div class="kpi"><div class="lbl">Channels</div><div class="v">${int(nd.num_channels)}</div><div class="sub">${int(nd.active_channels)} active</div></div>
        <div class="kpi"><div class="lbl">Centrality</div><div class="v">#${nd.betweenness_rank}</div><div class="sub">betweenness</div></div>
      </div></div>
      <div class="sect"><div class="sect-h"><b>Largest peers</b><span class="lbl">BTC · channels</span></div><div class="peers">
        ${peers.map(([a, , cap, n], i) => `<div class="peer"><span class="n">${esc(a)}</span><span class="bar ${i ? "" : "acc"}"><i style="width:${(cap / pmax) * 100}%"></i></span><span class="c">${cap.toFixed(2)} <span style="color:var(--faint)">${n}</span></span></div>`).join("")}
      </div></div>
      <div class="sect"><div class="sect-h"><b>Channel sizes</b><span class="lbl">median ${btc(nd.med_capacity)} BTC</span></div>
        ${histogram(A.capHist, 330, 52, 5)}
        <div class="sub mono" style="display:flex;justify-content:space-between;margin-top:6px"><span>100k sat</span><span>1M</span><span>10M</span><span>5 BTC</span></div>
      </div>
      <div class="sect"><div class="sect-h"><b>Outgoing fee</b><span class="lbl">median, ppm</span></div>
        <div style="position:relative;height:46px;margin-top:4px">
          <div class="bar" style="position:absolute;left:0;right:0;top:20px"><i style="width:0"></i></div>
          <div style="position:absolute;left:${feeX(A.stats.med_ppm)};top:12px;width:2px;height:20px;background:#808b87;border-radius:1px"></div>
          <div class="lbl mono" style="position:absolute;left:${feeX(A.stats.med_ppm)};top:34px;transform:translateX(-50%)">network ${A.stats.med_ppm}</div>
          <div style="position:absolute;left:${feeX(nd.med_out_ppm)};top:9px;width:12px;height:12px;margin-left:-6px;margin-top:5px;border-radius:50%;background:${ACCENT};box-shadow:0 0 0 4px rgba(29,254,187,.18)"></div>
          <div class="mono" style="position:absolute;left:${feeX(nd.med_out_ppm)};top:-6px;transform:translateX(-50%);font-size:12px;color:var(--accent)">${nd.med_out_ppm}</div>
        </div>
        <div class="sub" style="margin-top:6px">${ratio}× the network median to route out through ${esc(nd.alias)}.</div>
      </div>
      <div class="foot">
        <span class="btn primary">Open full profile ${ico("arrowR")}</span>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><span class="btn">${ico("route")}Find route</span><span class="btn">${ico("copy")}Copy key</span></div>
      </div>
    </aside>`;
  };

  S.nodeSelected = () => ({
    W: 1440, H: 900,
    html: `<canvas class="map"></canvas>${topbar()}${nodeInspector()}${zoomctl(408)}${mapcard()}`,
    after(root) {
      drawMap(root.querySelector("canvas"), 1440, 900, { focus: ACINQ, center: ACINQ, at: [560, 440], zoom: 1.5, labels: 14, avoid: [AVOID_TOP, { x: 1030, y: 0, w: 500, h: 900 }, { x: 0, y: 640, w: 340, h: 260 }] });
    },
  });

  S.channel = () => {
    const ch = A.channel, p1 = ch.node1.policy, p2 = ch.node2.policy;
    const amt = 100000;
    const cost = (p) => p.base_fee_msat / 1000 + (amt * p.fee_rate_ppm) / 1e6;
    const c1 = cost(p1), c2 = cost(p2), cmax = Math.max(c1, c2);
    const htlc = (msat) => (msat >= 1e8 ? `${btc(msat / 1000, msat >= 1e10 ? 1 : 2)} BTC` : msat >= 1000 ? `${int(msat / 1000)} sat` : `${msat} msat`);
    const block = ch.short_id.split("x")[0];
    const lane = (from, to, p, rev) => `
      <div class="lane">
        <div class="arrow">${rev ? ico("arrowL") : ""}<span class="ln ${rev ? "rev" : ""}"></span>${rev ? "" : ico("arrowR")}<span style="white-space:nowrap">${esc(from)} → ${esc(to)}</span></div>
        <div class="fee">${int(p.fee_rate_ppm)} ppm<small>+ ${p.base_fee_msat / 1000} sat base</small></div>
        <div class="meta"><span>CLTV<b>${p.cltv_delta}</b></span><span>Min HTLC<b>${htlc(p.min_htlc_msat)}</b></span><span>Max HTLC<b>${htlc(p.max_htlc_msat)}</b></span></div>
      </div>`;
    return {
      W: 1440, H: 900,
      html: `<canvas class="map"></canvas>${topbar()}${zoomctl(408)}${mapcard()}
        <aside class="inspector glass">
          <div class="head">
            <div class="eyebrow"><span>Channel</span><span style="margin-left:auto;display:flex;gap:2px"><span class="btn icon sm ghost">${ico("ext")}</span><span class="btn icon sm ghost">${ico("x")}</span></span></div>
            <div class="title" style="margin-top:2px">${esc(ch.node1.alias)} <span style="color:var(--muted);font-weight:400">↔</span> ${esc(ch.node2.alias)}</div>
            <div style="margin-top:10px;display:flex;gap:6px;align-items:center"><span class="key">${ch.short_id} ${ico("copy")}</span><span style="flex:1"></span><span class="tag">${btc(ch.capacity)} BTC</span><span class="tag">block ${int(block)}</span></div>
          </div>
          <div class="sect"><div class="lanes">
            <div class="ends"><span><i class="nd"></i>${esc(ch.node1.alias)}</span><span>${esc(ch.node2.alias)}<i class="nd acc"></i></span></div>
            ${lane(ch.node1.alias, ch.node2.alias, p1, false)}
            ${lane(ch.node2.alias, ch.node1.alias, p2, true)}
          </div></div>
          <div class="sect"><div class="sect-h"><b>Cost to route ${int(amt)} sats</b>${ico("info", "")}</div>
            <div class="peers">
              <div class="peer" style="grid-template-columns:1fr 90px 74px"><span class="n">${esc(ch.node1.alias)} → ${esc(ch.node2.alias)}</span><span class="bar"><i style="width:${Math.max(2, (c1 / cmax) * 100)}%"></i></span><span class="c">${c1.toFixed(1)} sat</span></div>
              <div class="peer" style="grid-template-columns:1fr 90px 74px"><span class="n">${esc(ch.node2.alias)} → ${esc(ch.node1.alias)}</span><span class="bar acc"><i style="width:100%"></i></span><span class="c">${c2.toFixed(1)} sat</span></div>
            </div>
            <div class="sub" style="margin-top:6px">Routing toward ${esc(ch.node1.alias)} costs ${Math.round(c2 / c1)}× more than routing toward ${esc(ch.node2.alias)}.</div>
          </div>
          <div class="foot"><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><span class="btn">${esc(ch.node1.alias)} ${ico("arrowR")}</span><span class="btn">${esc(ch.node2.alias)} ${ico("arrowR")}</span></div></div>
        </aside>`,
      after(root) {
        const a = N[ACINQ], b = N[PEER];
        drawMap(root.querySelector("canvas"), 1440, 900, { edge: [PEER, ACINQ], point: [(a[2] + b[2]) / 2, (a[3] + b[3]) / 2], at: [560, 440], zoom: 1.7, labels: 10, avoid: [AVOID_TOP, { x: 1030, y: 0, w: 500, h: 900 }, { x: 0, y: 640, w: 340, h: 260 }] });
      },
    };
  };

  S.profile = () => {
    const nd = A.node, capBins = ["100k", "250k", "500k", "1M", "2M", "5M", "10M", "20M", "50M", "1 BTC", "2 BTC", "5 BTC"];
    const known = A.capHist.reduce((a, b) => a + b, 0);
    const medianBin = 5;
    const pmax = A.peers[0][2];
    const since = new Date(nd.first_seen * 1000).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    const feeRow = (label, v, max, acc) => `<div style="display:grid;grid-template-columns:92px 1fr 54px;gap:12px;align-items:center;height:30px"><span class="lbl" style="color:${acc ? "var(--text-2)" : ""}">${label}</span><span class="bar ${acc ? "acc" : ""}"><i style="width:${(v / max) * 100}%"></i></span><span class="mono" style="text-align:right;font-size:12.5px;color:${acc ? "var(--accent)" : "var(--text-2)"}">${v}</span></div>`;
    const feats = [["Anchors", nd.anchors], ["Wumbo", nd.wumbo], ["Route blinding", nd.route_blinding], ["Onion messages", nd.onion_messages], ["Dual funding", nd.dual_fund]];
    return {
      W: 1440, H: 1480,
      html: `<canvas class="map" style="height:480px"></canvas>
        <div style="position:absolute;left:0;right:0;top:0;height:480px;background:linear-gradient(90deg,var(--bg) 8%,rgba(7,9,8,.55) 38%,rgba(7,9,8,0) 60%)"></div>
        <div style="position:absolute;left:0;right:0;top:300px;height:180px;background:linear-gradient(rgba(7,9,8,0),var(--bg))"></div>
        ${topbar("Nodes", `<span class="btn sm ghost" style="margin-left:14px">${ico("arrowL")}Back to map</span>`)}
        <div class="wrap" style="padding-top:226px">
          <div class="ph">
            <div>
              <div class="eyebrow"><span class="tag acc">#1 betweenness</span><span class="tag">#3 capacity</span></div>
              <h1>${esc(nd.alias)}</h1>
              <div style="display:flex;gap:8px;align-items:center;color:var(--text-2)"><span class="tag">Clearnet</span><span class="tag">Tor</span><span>${esc(nd.country)} · announced since ${since}</span></div>
              <div class="key" style="margin-top:14px">${nd.pubkey} ${ico("copy")}</div>
            </div>
            <div style="display:flex;gap:8px"><span class="btn">${ico("route")}Find route</span><span class="btn">${ico("copy")}Copy key</span><span class="btn primary">${ico("layers")}Show on map</span></div>
          </div>
          <div class="tabs"><span class="on">Overview</span><span>Channels<b>${int(nd.num_channels)}</b></span><span>Fees</span><span>Rankings</span><span>History</span></div>
          <div class="bigkpis">
            <div><div class="lbl">Capacity</div><div class="v">${btc(nd.total_capacity)}<small>BTC</small></div><div class="sub">${int(nd.total_capacity)} sats</div></div>
            <div><div class="lbl">Channels</div><div class="v">${int(nd.num_channels)}</div><div class="sub">${int(nd.active_channels)} active · ${int(A.peerCaps.length)} peers</div></div>
            <div><div class="lbl">Median outgoing fee</div><div class="v">${nd.med_out_ppm}<small>ppm</small></div><div class="sub">base ${nd.med_out_base / 1000} sat · incoming ${nd.med_in_ppm} ppm</div></div>
            <div><div class="lbl">Centrality</div><div class="v">#${nd.betweenness_rank}</div><div class="sub">closeness #${nd.closeness_rank} · eigenvector #${nd.eigenvector_rank}</div></div>
          </div>
          <div class="grid3">
            <div class="panel"><div class="sect-h"><h3>Channel sizes</h3><span class="lbl">${int(known)} with known capacity</span></div>
              <div style="margin-top:14px">${histogram(A.capHist, 410, 140, medianBin)}</div>
              <div style="display:flex;justify-content:space-between;margin-top:8px" class="sub mono">${capBins.filter((_, i) => i % 3 === 0).map((b) => `<span>${b}</span>`).join("")}</div>
              <div class="sub" style="margin-top:12px">Median channel ${btc(nd.med_capacity)} BTC · largest ${btc(nd.max_capacity)} BTC</div>
            </div>
            <div class="panel"><div class="sect-h"><h3>Largest peers</h3><span class="lbl">BTC · channels</span></div>
              <div class="peers" style="margin-top:8px">${A.peers.map(([a, , cap, n], i) => `<div class="peer" style="grid-template-columns:1fr 110px 64px"><span class="n">${esc(a)}</span><span class="bar ${i ? "" : "acc"}"><i style="width:${(cap / pmax) * 100}%"></i></span><span class="c">${cap.toFixed(2)} <span style="color:var(--faint)">${n}</span></span></div>`).join("")}</div>
            </div>
            <div class="panel"><div class="sect-h"><h3>Fees vs network</h3><span class="lbl">median ppm</span></div>
              <div style="margin-top:12px">
                ${feeRow(`${esc(nd.alias)} out`, nd.med_out_ppm, 600, true)}
                ${feeRow(`${esc(nd.alias)} in`, nd.med_in_ppm, 600, false)}
                ${feeRow("Network", A.stats.med_ppm, 600, false)}
              </div>
              <div class="hr" style="margin:16px 0 14px"></div>
              <div class="lbl" style="margin-bottom:8px">Features</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px">${feats.map(([f, on]) => `<span class="tag ${on ? "" : ""}" style="${on ? "" : "opacity:.4;text-decoration:line-through"}">${f}</span>`).join("")}</div>
            </div>
          </div>
          <div class="grid2">
            <div class="panel" style="padding:20px 0 6px"><div class="sect-h" style="padding:0 22px"><h3>Largest channels</h3><span class="btn sm">View all ${int(nd.num_channels)} ${ico("arrowR")}</span></div>
              <div class="table" style="--cols:1.5fr 1.2fr .9fr .7fr .7fr .6fr;margin-top:6px">
                <div class="tr th"><span>Peer</span><span>Channel</span><span class="r">Capacity</span><span class="r">Out ppm</span><span class="r">In ppm</span><span class="r">State</span></div>
                ${A.topChannels.slice(0, 8).map(([peer, scid, cap, out, inn, on]) => `<div class="tr" style="height:42px"><span style="font-weight:500">${esc(peer)}</span><span class="mono" style="color:var(--muted)">${scid}</span><span class="r mono">${btc(cap)}</span><span class="r mono">${int(out)}</span><span class="r mono" style="color:var(--text-2)">${int(inn)}</span><span class="r">${on ? '<span class="tag acc">Active</span>' : '<span class="tag" style="color:var(--neg)">Disabled</span>'}</span></div>`).join("")}
              </div>
            </div>
            <div style="display:grid;gap:16px;align-content:start">
              <div class="panel"><div class="sect-h"><h3>Centrality</h3>${ico("info")}</div>
                ${[["Betweenness", nd.betweenness_rank], ["Closeness", nd.closeness_rank], ["Eigenvector", nd.eigenvector_rank]].map(([k, v]) => `<div style="display:flex;justify-content:space-between;height:32px;align-items:center;border-top:1px solid var(--line)"><span style="color:var(--text-2)">${k}</span><span class="mono">#${v}</span></div>`).join("")}
                <div class="sub" style="margin-top:8px">Rank 1 is the most central. Betweenness and closeness are sampled.</div>
              </div>
              <div class="panel"><div class="sect-h"><h3>Addresses</h3><span class="lbl">${nd.addresses.length}</span></div>
                ${nd.addresses.map((a) => `<div class="key" style="display:flex;justify-content:space-between;height:30px;border-top:1px solid var(--line)"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px">${esc(a)}</span>${ico("copy")}</div>`).join("")}
              </div>
            </div>
          </div>
          <div class="panel" style="margin-top:16px;padding:6px 22px"><div class="empty-line">${ico("clock")}<span><b style="color:var(--text-2);font-weight:500">History</b> · opens, closes and fee changes appear here after the next snapshot diff.</span></div></div>
        </div>`,
      after(root) { drawEgo(root.querySelector("canvas"), 1440, 480, 1010, 250, [{ x: 930, y: 318, w: 420, h: 64 }, { x: 0, y: 0, w: 1440, h: 70 }]); },
    };
  };

  S.nodes = () => {
    const rows = A.nodesTable.slice(0, 12), max = rows[0][3];
    return {
      W: 1440, H: 900,
      html: `<canvas class="map"></canvas>${topbar("Nodes")}${zoomctl(20)}
        <div class="sheet glass" style="left:20px;top:76px;bottom:20px;width:820px">
          <div class="sheet-h"><h2>Nodes</h2><span class="lbl" style="margin-top:4px">${int(A.stats.nodes)} public</span><span style="flex:1"></span><span class="btn icon sm ghost">${ico("x")}</span></div>
          <div style="display:flex;gap:8px;padding:0 24px 14px;align-items:center">
            <span class="chip" style="width:220px;color:var(--muted)">${ico("search")}Filter by alias or key</span>
            <span class="chip on">Channels ≥ 30 ${ico("x")}</span><span class="chip add">${ico("plus")}Add filter</span>
            <span style="flex:1"></span><span class="chip">${ico("sort")}Capacity</span><span class="chip">Columns ${ico("chev")}</span>
          </div>
          <div class="table" style="--cols:22px 1.5fr 1.6fr .65fr .65fr .65fr .8fr">
            <div class="tr th"><span>#</span><span>Node</span><span>Capacity, BTC</span><span class="r">Channels</span><span class="r">Out ppm</span><span class="r">Central.</span><span class="r">Network</span></div>
            ${rows.map(([alias, pk, ch, cap, ppm, rank, tor, ipv4], i) => `
              <div class="tr ${i === 1 ? "hover" : ""}"><span class="mono sub">${i + 1}</span>
                <span class="nm"><b>${esc(alias)}</b><span>${short(pk)}</span></span>
                <span class="capc"><span class="bar ${i === 1 ? "acc" : ""}"><i style="width:${(cap / max) * 100}%"></i></span><span class="mono">${btc(cap)}</span></span>
                <span class="r mono">${int(ch)}</span><span class="r mono">${int(ppm)}</span><span class="r mono">#${rank}</span>
                <span class="r" style="display:flex;gap:4px;justify-content:flex-end">${ipv4 ? '<span class="tag">IPv4</span>' : ""}${tor ? '<span class="tag">Tor</span>' : ""}${!ipv4 && !tor ? '<span class="sub">—</span>' : ""}</span>
              </div>`).join("")}
          </div>
          <div style="margin-top:auto;display:flex;align-items:center;gap:10px;padding:14px 24px;border-top:1px solid var(--line)" class="lbl"><span>1–12 of ${int(A.stats.nodes)}</span><span style="flex:1"></span><span class="btn sm">${ico("arrowL")}</span><span class="btn sm">${ico("arrowR")}</span></div>
        </div>`,
      after(root) {
        drawMap(root.querySelector("canvas"), 1440, 900, { focus: BINANCE, center: BINANCE, at: [1130, 470], zoom: 1.35, labels: 8, avoid: [AVOID_TOP, { x: 0, y: 0, w: 860, h: 900 }] });
      },
    };
  };

  S.stats = () => {
    const st = A.stats, fee = st.fee;
    const fx = (v) => `${(Math.sqrt(v / 2000) * 100).toFixed(1)}%`;
    const usd = (st.net_capacity / 1e8) * st.usd;
    const top = st.top_cap.slice(0, 5), tmax = top[0][1];
    const asOf = new Date(st.net_ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return {
      W: 1440, H: 900,
      html: `<canvas class="map"></canvas>${topbar("Stats")}
        <div class="sheet glass" style="left:56px;right:56px;top:84px;bottom:-1px;border-radius:22px 22px 0 0">
          <div class="grip"></div>
          <div class="sheet-h" style="padding-top:10px"><h2>Network</h2><span style="color:var(--muted)">${ico("info")}</span><span style="flex:1"></span>
            <span class="seg"><span class="on">Capacity</span><span>Channels</span><span>Nodes</span><span>Fees</span></span>
            <span class="seg"><span>1y</span><span>3y</span><span class="on">All</span></span>
            <span class="seg"><span class="on">BTC</span><span>USD</span></span>
            <span class="btn icon sm ghost">${ico("x")}</span></div>
          <div style="display:grid;grid-template-columns:1fr 260px;gap:32px;padding:4px 24px 0">
            <div>
              <div id="hist"></div>
              <div style="display:flex;gap:18px;margin-top:10px" class="lbl"><span style="display:inline-flex;align-items:center;gap:6px"><i style="width:16px;height:2px;background:${ACCENT};display:inline-block"></i>mempool.space</span><span style="display:inline-flex;align-items:center;gap:6px"><i style="width:16px;border-top:1.5px dashed #b0bab6;display:inline-block"></i>this explorer, known capacity</span><span style="margin-left:auto">mempool data stops ${asOf} ${ico("info")}</span></div>
            </div>
            <div style="display:grid;gap:0;align-content:start">
              <div style="padding:6px 0 16px"><div class="lbl">Network capacity</div><div class="mono" style="font-size:28px;font-weight:500;letter-spacing:-.03em">${int(st.net_capacity / 1e8)}<span style="font:400 13px var(--sans);color:var(--muted);margin-left:6px">BTC</span></div><div class="sub">≈ $${(usd / 1e6).toFixed(0)}M · as of ${asOf}</div></div>
              <div style="padding:14px 0 16px;border-top:1px solid var(--line)"><div class="lbl">Public channels</div><div class="mono" style="font-size:22px;font-weight:500">${int(st.channels)}</div><div class="sub">${int(st.disabled)} disabled both ways</div></div>
              <div style="padding:14px 0 16px;border-top:1px solid var(--line)"><div class="lbl">Announced nodes</div><div class="mono" style="font-size:22px;font-weight:500">${int(st.nodes)}</div><div class="sub">${int(st.net_nodes)} incl. unannounced</div></div>
              <div style="padding:14px 0 0;border-top:1px solid var(--line)"><div class="lbl">BTC price</div><div class="mono" style="font-size:22px;font-weight:500">$${int(st.usd)}</div><div class="sub">€${int(st.eur)}</div></div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:16px;padding:22px 24px 0">
            <div class="panel"><div class="sect-h"><h3>Routing fee rates</h3><span class="lbl">${int(fee.count)} policies</span></div>
              <div style="position:relative;height:62px;margin-top:18px">
                <div class="bar" style="position:absolute;left:0;right:0;top:14px"><i style="width:${fx(fee.p90)};background:linear-gradient(90deg,rgba(29,254,187,.15),rgba(29,254,187,.55))"></i></div>
                ${[["min", fee.min], ["median", fee.median], ["mean", fee.mean], ["p90", fee.p90]].map(([k, v]) => `<div style="position:absolute;left:${fx(v)};top:6px;width:2px;height:20px;background:${k === "median" ? ACCENT : "#808b87"};border-radius:1px"></div><div style="position:absolute;left:${fx(v)};top:32px;transform:translateX(${k === "min" ? "0" : k === "p90" ? "-80%" : "-50%"});text-align:center"><div class="mono" style="font-size:13px;color:${k === "median" ? "var(--accent)" : "var(--text)"}">${int(v)}</div><div class="sub">${k}</div></div>`).join("")}
              </div>
              <div class="sub" style="margin-top:12px">ppm, square-root scale. Placeholder fees (2,147,483,647 ppm) are filtered out of the mean.</div>
            </div>
            <div class="panel"><div class="sect-h"><h3>Largest nodes</h3><span class="lbl">BTC</span></div>
              <div class="peers" style="margin-top:6px">${top.map(([a, c], i) => `<div class="peer" style="grid-template-columns:1fr 90px 56px;height:26px"><span class="n">${esc(a)}</span><span class="bar ${i ? "" : "acc"}"><i style="width:${(c / tmax) * 100}%"></i></span><span class="c">${btc(c)}</span></div>`).join("")}</div>
            </div>
            <div class="panel"><div class="sect-h"><h3>Opens & closes</h3><span class="lbl">7 days</span></div>
              <div class="empty-line" style="padding:22px 0 6px">${ico("clock")}<span>Collecting. The first snapshot diff lands within 3 hours.</span></div>
            </div>
          </div>
        </div>`,
      after(root) {
        drawMap(root.querySelector("canvas"), 1440, 900, { dim: true, labels: 0, point: [0.5, 0.5], at: [720, 400] });
        root.querySelector("#hist").innerHTML = historyChart(1000, 300);
      },
    };
  };

  const phoneChrome = () => `<div class="statusbar"><span>9:41</span><span style="display:flex;gap:6px;align-items:center"><svg width="18" height="11" viewBox="0 0 18 11"><rect x="0" y="7" width="3" height="4" rx="1" fill="#e8eeeb"/><rect x="5" y="5" width="3" height="6" rx="1" fill="#e8eeeb"/><rect x="10" y="2.5" width="3" height="8.5" rx="1" fill="#e8eeeb"/><rect x="15" y="0" width="3" height="11" rx="1" fill="#e8eeeb"/></svg><svg width="26" height="12" viewBox="0 0 26 12"><rect x=".5" y=".5" width="22" height="11" rx="3" fill="none" stroke="#e8eeeb" opacity=".5"/><rect x="2" y="2" width="16" height="8" rx="1.5" fill="#e8eeeb"/></svg></span></div><div class="homebar"></div>`;

  S.mobileMap = () => {
    const nd = A.node;
    return {
      W: 390, H: 844, mobile: true,
      html: `<canvas class="map"></canvas>${phoneChrome()}
        <div class="m-top"><div class="m-search glass">${logo()}<span>Search the network</span></div><div class="m-btn glass">${ico("menu")}</div></div>
        <div class="m-sheet">
          <div class="grip" style="margin-bottom:14px"></div>
          <div style="display:flex;align-items:center;gap:10px"><span class="dot"></span><span class="title" style="font-size:20px">${esc(nd.alias)}</span><span style="flex:1"></span><span class="tag acc">#1</span><span class="btn icon sm ghost">${ico("x")}</span></div>
          <div class="key" style="margin-top:6px">${short(nd.pubkey)} ${ico("copy")}</div>
          <div class="kpis" style="margin-top:16px">
            <div class="kpi"><div class="lbl">Capacity</div><div class="v" style="font-size:17px">${btc(nd.total_capacity)}</div><div class="sub">BTC</div></div>
            <div class="kpi"><div class="lbl">Channels</div><div class="v" style="font-size:17px">${int(nd.num_channels)}</div><div class="sub">${int(nd.active_channels)} active</div></div>
            <div class="kpi"><div class="lbl">Out fee</div><div class="v" style="font-size:17px">${nd.med_out_ppm}</div><div class="sub">ppm</div></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 46px;gap:8px;margin-top:18px"><span class="btn primary" style="height:46px;border-radius:13px">Open profile ${ico("arrowR")}</span><span class="btn icon" style="height:46px;width:46px;border-radius:13px">${ico("route")}</span></div>
        </div>`,
      after(root) {
        drawMap(root.querySelector("canvas"), 390, 844, { focus: ACINQ, center: ACINQ, at: [195, 330], zoom: 1.9, labels: 6, avoid: [{ x: 0, y: 0, w: 390, h: 110 }, { x: 0, y: 560, w: 390, h: 300 }] });
      },
    };
  };

  S.mobileSearch = () => {
    const q = "acin";
    return {
      W: 390, H: 844, mobile: true,
      html: `<canvas class="map"></canvas>${phoneChrome()}<div class="scrim" style="background:rgba(4,6,5,.86)"></div>
        <div style="position:absolute;inset:0;z-index:7;padding:54px 14px 0">
          <div style="display:flex;gap:10px;align-items:center"><div class="m-search glass" style="color:var(--text);border-color:rgba(29,254,187,.4)">${ico("search")}<span>${q}</span><span class="caret" style="width:1.5px;height:20px;background:${ACCENT};margin-left:-8px"></span></div><span style="color:var(--accent);font-weight:500">Cancel</span></div>
          <div class="lbl" style="margin:20px 6px 6px">Nodes</div>
          ${A.search.map(([alias, pk, cap, ch], i) => `<div style="display:grid;grid-template-columns:34px 1fr auto;gap:12px;align-items:center;height:60px;padding:0 6px;border-bottom:1px solid var(--line)"><span style="width:34px;height:34px;border-radius:10px;background:var(--fill-2);display:grid;place-items:center"><i style="width:9px;height:9px;border-radius:50%;background:${i ? "#c7d2ce" : ACCENT}"></i></span><span><div style="font-weight:500;font-size:15px">${esc(alias)}</div><div class="mono sub">${short(pk)}</div></span><span class="mono" style="text-align:right;font-size:13px;color:var(--text-2)">${btc(cap)}<div class="sub">${int(ch)} ch</div></span></div>`).join("")}
          <div class="lbl" style="margin:22px 6px 6px">Recent</div>
          ${["bfx-lnd0", "811984x2037x0", "LNBiG [Hub-2]"].map((r) => `<div style="display:flex;gap:12px;align-items:center;height:48px;padding:0 6px;color:var(--text-2)">${ico("clock")}<span class="${r.includes("x") ? "mono" : ""}">${r}</span></div>`).join("")}
        </div>
        <div style="position:absolute;left:0;right:0;bottom:0;height:290px;background:#1b1f1e;z-index:8;border-top:1px solid var(--line);padding:8px 4px 0">
          ${["qwertyuiop", "asdfghjkl", "zxcvbnm"].map((row, r) => `<div style="display:flex;justify-content:center;gap:6px;margin:10px 0;padding:0 ${r * 18}px">${[...row].map((k) => `<span style="flex:1;max-width:33px;height:42px;border-radius:6px;background:#3a403e;display:grid;place-items:center;font-size:17px;color:#e8eeeb">${k}</span>`).join("")}</div>`).join("")}
          <div style="display:flex;gap:6px;margin:10px 4px;padding:0 4px"><span style="width:90px;height:42px;border-radius:6px;background:#2a2f2d;display:grid;place-items:center;font-size:14px">123</span><span style="flex:1;height:42px;border-radius:6px;background:#3a403e;display:grid;place-items:center;font-size:14px">space</span><span style="width:90px;height:42px;border-radius:6px;background:${ACCENT};color:#02281d;font-weight:600;display:grid;place-items:center;font-size:14px">Go</span></div>
        </div>`,
      after(root) { drawMap(root.querySelector("canvas"), 390, 844, { dim: true, labels: 0, at: [195, 400], zoom: 1.4 }); },
    };
  };

  // ---------- mount ----------
  function mount() {
    renderLogoBoard();
    renderTokens();
    document.querySelectorAll("[data-screen]").forEach((host) => {
      const sc = S[host.dataset.screen]();
      const frame = document.createElement("div");
      frame.className = "frame";
      const app = document.createElement("div");
      app.className = "app";
      app.style.width = `${sc.W}px`; app.style.height = `${sc.H}px`;
      app.innerHTML = sc.html;
      frame.appendChild(app);
      host.appendChild(frame);
      const fit = () => {
        const z = sc.mobile ? 1 : Math.min(1, host.clientWidth / sc.W);
        frame.style.width = `${sc.W * z}px`; frame.style.height = `${sc.H * z}px`;
        app.style.zoom = z;
      };
      fit();
      window.addEventListener("resize", fit);
      sc.after(app);
    });
    document.body.dataset.ready = "1";
  }

  Promise.all([
    document.fonts.load('500 12px "IBM Plex Sans"'),
    document.fonts.load('600 12.5px "IBM Plex Sans"'),
    document.fonts.load('500 12px "IBM Plex Mono"'),
  ]).catch(() => {}).finally(mount);
})();
