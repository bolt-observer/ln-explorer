// Small inline SVG charts shared by several views.

/** Bar histogram. `highlight` is a bar index drawn in the accent colour. */
export function histogram(counts, { width = 320, height = 64, highlight = -1, label = "" } = {}) {
  const max = Math.max(1, ...counts);
  const bw = width / Math.max(1, counts.length);
  const bars = counts
    .map((count, i) => {
      const h = count ? Math.max(2, (count / max) * (height - 2)) : 1;
      return `<rect x="${(i * bw + 1.5).toFixed(1)}" y="${(height - h).toFixed(1)}" width="${Math.max(1, bw - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="2" class="${i === highlight ? "h-acc" : count ? "h-bar" : "h-empty"}"><title>${count}</title></rect>`;
    })
    .join("");
  return `<svg class="chart-hist" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${label}">${bars}</svg>`;
}

/** Index of the bucket holding the median item. */
export function medianBucket(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  let seen = 0;
  for (let i = 0; i < counts.length; i += 1) {
    seen += counts[i];
    if (seen * 2 >= total && total) return i;
  }
  return -1;
}

/**
 * Sparkline. For ranks pass invert=true so a better (lower) rank draws higher.
 * Colour follows the trend: accent when it improved, negative when it got worse.
 */
export function sparkline(values, { width = 72, height = 18, invert = false } = {}) {
  const points = (values || []).map(Number).filter(Number.isFinite);
  if (points.length < 2) return `<svg class="spark" width="${width}" height="${height}" aria-hidden="true"></svg>`;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const pad = 2;
  const x = (i) => pad + (i / (points.length - 1)) * (width - 2 * pad);
  const y = (v) => {
    if (max === min) return height / 2;
    const t = (v - min) / (max - min);
    return pad + (invert ? t : 1 - t) * (height - 2 * pad);
  };
  const path = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const better = invert ? last <= first : last >= first;
  return `<svg class="spark ${better ? "spark-up" : "spark-down"}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline points="${path}"/></svg>`;
}
