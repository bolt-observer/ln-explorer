// Number, unit and date formatting. One unit policy for the whole UI:
// amounts are BTC (exact sats in the title attribute), fees are ppm,
// base fees are sat when they are whole sats and msat otherwise.

const EN = "en-US";

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function int(value) {
  const n = finite(value);
  return n === null ? "—" : Math.round(n).toLocaleString(EN);
}

export function num(value, digits = 0) {
  const n = finite(value);
  return n === null ? "—" : n.toLocaleString(EN, { maximumFractionDigits: digits });
}

/** BTC amount without unit. Small amounts keep enough decimals to stay non-zero. */
export function btc(sats) {
  const n = finite(sats);
  if (n === null) return "—";
  const v = n / 1e8;
  if (v === 0) return "0";
  if (v >= 1) return v.toLocaleString(EN, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 0.01) return v.toLocaleString(EN, { maximumFractionDigits: 3 });
  return v.toLocaleString(EN, { maximumFractionDigits: 6 });
}

/** `<span title="exact sats">1.23 BTC</span>` */
export function btcHtml(sats, unit = true) {
  const n = finite(sats);
  if (n === null || n === 0) return n === 0 ? `0${unit ? " BTC" : ""}` : "—";
  return `<span title="${int(n)} sats">${btc(n)}${unit ? '<small class="unit">BTC</small>' : ""}</span>`;
}

export function btcText(sats) {
  const value = btc(sats);
  return value === "—" ? value : `${value} BTC`;
}

export function ppm(value) {
  const n = finite(value);
  return n === null ? "—" : `${num(n, n < 10 ? 1 : 0)} ppm`;
}

export function baseFee(msat) {
  const n = finite(msat);
  if (n === null) return "—";
  if (n % 1000 === 0) return `${int(n / 1000)} sat`;
  return `${int(n)} msat`;
}

export function htlc(msat) {
  const n = finite(msat);
  if (n === null) return "—";
  if (n >= 1e8) return `${btc(n / 1000)} BTC`;
  if (n >= 1000) return `${int(n / 1000)} sat`;
  return `${int(n)} msat`;
}

export function shortKey(pubkey) {
  if (!pubkey) return "";
  return `${pubkey.slice(0, 6)}…${pubkey.slice(-6)}`;
}

export function displayName(alias, pubkey) {
  return alias || shortKey(pubkey) || "Unnamed node";
}

function toDate(ts) {
  const n = finite(ts);
  if (n === null || n === 0) return null;
  const date = new Date(n * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function date(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleDateString(EN, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
}

export function monthYear(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleDateString(EN, { month: "long", year: "numeric", timeZone: "UTC" }) : "—";
}

export function dateTime(ts) {
  const d = toDate(ts);
  return d
    ? d.toLocaleString(EN, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC"
    : "—";
}

export function isoDay(ts) {
  const d = toDate(ts);
  return d ? d.toISOString().slice(0, 10) : "";
}

export function relTime(ts) {
  const d = toDate(ts);
  if (!d) return "—";
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const sign = seconds < 0 ? "in " : "";
  const tail = seconds < 0 ? "" : " ago";
  if (abs < 60) return seconds < 0 ? "in a moment" : "just now";
  if (abs < 3600) return `${sign}${Math.round(abs / 60)} min${tail}`;
  if (abs < 86400) return `${sign}${Math.round(abs / 3600)}h${tail}`;
  return `${sign}${Math.round(abs / 86400)}d${tail}`;
}
