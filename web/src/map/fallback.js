// 2D canvas renderer used when WebGL is unavailable. Static fit-to-view, same
// reducers as the sigma renderer so selection states look identical.

export class Fallback {
  constructor(container, graph, { nodeReducer, edgeReducer, onNode, onEdge }) {
    this.container = container;
    this.graph = graph;
    this.nodeReducer = nodeReducer;
    this.edgeReducer = edgeReducer;
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    container.appendChild(this.canvas);
    this.onResize = () => this.draw();
    window.addEventListener("resize", this.onResize);
    this.canvas.addEventListener("click", (event) => {
      const hit = this.hit(event.offsetX, event.offsetY);
      if (hit?.node) onNode(hit.node);
      else if (hit?.edge) onEdge(hit.edge);
    });
    this.draw();
  }

  project() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    this.graph.forEachNode((_, a) => {
      minX = Math.min(minX, a.x);
      maxX = Math.max(maxX, a.x);
      minY = Math.min(minY, a.y);
      maxY = Math.max(maxY, a.y);
    });
    const scale = (Math.min(w, h) - 96) / Math.max(1e-9, Math.max(maxX - minX, maxY - minY));
    const ox = w / 2 - ((minX + maxX) / 2) * scale;
    const oy = h / 2 + ((minY + maxY) / 2) * scale;
    // Graph y grows upwards, like sigma.
    return { w, h, x: (a) => ox + a.x * scale, y: (a) => oy - a.y * scale };
  }

  draw() {
    const p = this.project();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = p.w * dpr;
    this.canvas.height = p.h * dpr;
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, p.w, p.h);
    this.points = new Map();
    this.graph.forEachNode((node, attrs) => {
      this.points.set(node, { x: p.x(attrs), y: p.y(attrs), d: this.nodeReducer(node, attrs) });
    });
    this.graph.forEachEdge((edge, attrs, a, b) => {
      const d = this.edgeReducer(edge, attrs);
      const pa = this.points.get(a);
      const pb = this.points.get(b);
      ctx.strokeStyle = d.color;
      ctx.lineWidth = d.size;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    });
    const ordered = [...this.points.entries()].sort((l, r) => (l[1].d.zIndex || 0) - (r[1].d.zIndex || 0) || l[1].d.size - r[1].d.size);
    for (const [, pt] of ordered) {
      ctx.fillStyle = pt.d.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.d.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = '500 12px "IBM Plex Sans", system-ui, sans-serif';
    const labelled = ordered.filter(([, pt]) => pt.d.label && (pt.d.forceLabel || pt.d.size > 7));
    for (const [, pt] of labelled.slice(-24)) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(7,9,8,0.9)";
      ctx.strokeText(pt.d.label, pt.x + pt.d.size + 6, pt.y + 4);
      ctx.fillStyle = pt.d.pill ? "#1dfebb" : "rgba(232,238,235,0.88)";
      ctx.fillText(pt.d.label, pt.x + pt.d.size + 6, pt.y + 4);
    }
  }

  hit(x, y) {
    let best = null;
    let bestDist = 14;
    for (const [node, pt] of this.points || []) {
      const dist = Math.hypot(pt.x - x, pt.y - y) - pt.d.size;
      if (dist < bestDist) {
        best = node;
        bestDist = dist;
      }
    }
    if (best) return { node: best };
    let edgeHit = null;
    let edgeDist = 4;
    this.graph.forEachEdge((edge, _attrs, a, b) => {
      const pa = this.points.get(a);
      const pb = this.points.get(b);
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const t = Math.max(0, Math.min(1, ((x - pa.x) * dx + (y - pa.y) * dy) / (dx * dx + dy * dy || 1)));
      const dist = Math.hypot(pa.x + t * dx - x, pa.y + t * dy - y);
      if (dist < edgeDist) {
        edgeHit = edge;
        edgeDist = dist;
      }
    });
    return edgeHit ? { edge: edgeHit } : null;
  }

  destroy() {
    window.removeEventListener("resize", this.onResize);
    this.canvas.remove();
  }
}
