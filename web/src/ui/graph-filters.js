import { esc } from "../lib/format.js";
import { GRAPH_FILTER_KEYS } from "../lib/graph-query.js";
import { icon } from "../lib/icons.js";
import { go, homeUrl, mapUrl } from "../lib/router.js";

const NETWORKS = [["", "Any network"], ["clearnet", "Clearnet only"], ["tor", "Tor only"], ["hybrid", "Clearnet + Tor"]];
const IP_FAMILIES = [["", "Any IP family"], ["ipv4", "IPv4"], ["ipv6", "IPv6"]];
const FEATURES = [["", "Any feature"], ["wumbo", "Wumbo"], ["anchors", "Anchors"], ["dual_fund", "Dual funding"], ["onion_messages", "Onion messages"], ["route_blinding", "Route blinding"]];
const BTC_PATTERN = "([0-9]+([.][0-9]{0,8})?|[.][0-9]{1,8})";

// Work in decimal strings: floating-point multiplication can lose a satoshi.
function satsToBtc(value) {
  if (!/^[0-9]+$/.test(value || "")) return "";
  const digits = value.padStart(9, "0");
  const whole = digits.slice(0, -8).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-8).replace(/0+$/, "");
  return whole + (fraction ? `.${fraction}` : "");
}

function btcToSats(value) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole || "0"}${fraction.padEnd(8, "0")}`).toString();
}

const options = (items, value) => items.map(([key, label]) => `<option value="${key}"${key === value ? " selected" : ""}>${label}</option>`).join("");

/** Keep this form outside status repaints so draft values and focus survive polling. */
export function mountGraphFilters(card) {
  const params = new URL(homeUrl(), location.origin).searchParams;
  const active = GRAPH_FILTER_KEYS.filter((key) => params.get(key) && !(key === "min_channels" && params.get(key) === "auto"));
  const summary = active.map((key) => {
    const value = params.get(key);
    if (key === "network") return NETWORKS.find(([id]) => id === value)?.[1] || value;
    if (key === "ip") return IP_FAMILIES.find(([id]) => id === value)?.[1] || value;
    if (key === "feature") return FEATURES.find(([id]) => id === value)?.[1] || value;
    if (key === "min_capacity") return `≥ ${satsToBtc(value)} BTC`;
    return `≥ ${value} channels`;
  }).join(" · ") || "All public nodes";
  const bar = document.createElement("div");
  bar.className = "map-filter-bar";
  bar.innerHTML = `<button type="button" class="chip${active.length ? " on" : ""}" data-map-filters aria-expanded="false" aria-controls="graph-filter-form">${icon("filter")}Filters${active.length ? `<span class="map-filter-count">${active.length}</span>` : ""}</button><span class="map-filter-summary" title="${esc(summary)}">${esc(summary)}</span>`;
  card.querySelector(".when").after(bar);
  const trigger = bar.querySelector("button");
  const form = document.createElement("form");
  form.id = "graph-filter-form";
  form.className = "map-filter-form glass";
  form.hidden = true;
  form.setAttribute("aria-labelledby", "graph-filter-title");
  form.innerHTML = `
    <div class="map-filter-heading"><div><div class="lbl">Map selection</div><h2 id="graph-filter-title">Filter the network</h2></div><button type="button" class="btn icon ghost" data-filter-close aria-label="Close filters">${icon("x")}</button></div>
    <p class="sub">Match all filters, then show the largest hubs.</p>
    <div class="map-filter-fields">
      <label class="field"><span>Network</span><select class="input" name="network">${options(NETWORKS, params.get("network") || "")}</select></label>
      <label class="field"><span>IP family</span><select class="input" name="ip" aria-describedby="graph-ip-note">${options(IP_FAMILIES, params.get("ip") || "")}</select></label>
      <p class="sub map-filter-wide" id="graph-ip-note">Based on announced addresses, not reachability.</p>
      <label class="field"><span>Minimum capacity <span class="muted">BTC</span></span><input class="input mono" type="text" inputmode="decimal" name="min_capacity" pattern="${BTC_PATTERN}" title="Enter a nonnegative BTC amount with up to 8 decimal places." placeholder="No minimum" value="${esc(satsToBtc(params.get("min_capacity")))}" aria-describedby="graph-capacity-note" /></label>
      <label class="field"><span>Minimum channels</span><input class="input mono" type="number" inputmode="numeric" name="min_channels" min="1" step="1" placeholder="Auto" value="${esc(params.get("min_channels") === "auto" ? "" : params.get("min_channels") || "")}" /></label>
      <label class="field map-filter-wide"><span>Announced feature</span><select class="input" name="feature">${options(FEATURES, params.get("feature") || "")}</select></label>
    </div>
    <div class="map-filter-notes"><p id="graph-capacity-note">Capacity can be incomplete. Blank minimum channels uses automatic hub selection.</p><p>Only channels between selected nodes are shown.</p></div>
    <div class="map-filter-actions"><button type="button" class="btn ghost" data-filter-reset>Reset filters</button><button type="submit" class="btn primary">Apply filters</button></div>`;
  // A sibling avoids the card's backdrop/animation creating a fixed containing block.
  card.parentElement.appendChild(form);
  const network = form.elements.namedItem("network");
  const ip = form.elements.namedItem("ip");
  const channels = form.elements.namedItem("min_channels");
  const capacity = form.elements.namedItem("min_capacity");
  const syncIp = () => {
    ip.disabled = network.value === "tor";
    if (ip.disabled) ip.value = "";
    form.querySelector("#graph-ip-note").textContent = ip.disabled ? "Tor-only nodes have no announced IPv4 or IPv6 address." : "Based on announced addresses, not reachability.";
  };
  syncIp();
  network.addEventListener("change", syncIp);
  const close = () => {
    form.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus({ preventScroll: true });
  };
  trigger.addEventListener("click", () => {
    if (!form.hidden) return close();
    form.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    network.focus({ preventScroll: true });
  });
  form.querySelector("[data-filter-close]").addEventListener("click", close);
  const onEscape = (event) => {
    if (event.key !== "Escape" || form.hidden || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener("keydown", onEscape, true);
  channels.addEventListener("input", () => {
    channels.setCustomValidity(channels.value && !/^[0-9]+$/.test(channels.value) ? "Enter a whole number of channels, at least 1." : "");
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const filters = Object.fromEntries(GRAPH_FILTER_KEYS.map((key) => [key, form.elements.namedItem(key).value || null]));
    filters.ip = ip.disabled ? null : ip.value || null;
    filters.min_capacity = capacity.value ? btcToSats(capacity.value) : null;
    go(mapUrl(location.pathname.startsWith("/channel/") ? location.pathname : "/", { ...filters, node: new URLSearchParams(location.search).get("node") }));
  });
  form.querySelector("[data-filter-reset]").addEventListener("click", () => {
    const filters = Object.fromEntries(GRAPH_FILTER_KEYS.map((key) => [key, null]));
    go(mapUrl(location.pathname.startsWith("/channel/") ? location.pathname : "/", { ...filters, node: new URLSearchParams(location.search).get("node") }));
  });
  return () => {
    document.removeEventListener("keydown", onEscape, true);
    form.remove();
  };
}
