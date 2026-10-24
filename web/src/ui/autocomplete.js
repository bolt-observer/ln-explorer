// Node suggestions for pubkey inputs (reference node, route source).
import { api } from "../lib/api.js";
import { esc, int, shortKey } from "../lib/format.js";

let seqId = 0;

export function attachAutocomplete(input, onPick, { signal } = {}) {
  const host = input.parentElement;
  host.classList.add("ac-host");
  seqId += 1;
  const boxId = `ac-list-${seqId}`;
  const box = document.createElement("ul");
  box.className = "ac-list glass";
  box.id = boxId;
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", "Node suggestions");
  box.hidden = true;
  host.appendChild(box);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", boxId);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  let items = [];
  let active = -1;
  let timer = null;
  let blurTimer = null;
  let request = null;
  let disposed = false;
  const lifecycle = new AbortController();
  const options = { signal: lifecycle.signal };
  let seq = 0;

  const cancelRequest = () => {
    clearTimeout(timer);
    request?.abort();
    seq += 1;
  };

  const close = () => {
    box.hidden = true;
    active = -1;
    items = [];
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const render = () => {
    if (!items.length) return close();
    box.innerHTML = items
      .map(
        (item, index) => `<li role="option" id="${boxId}-${index}" class="${index === active ? "on" : ""}" aria-selected="${index === active}" data-index="${index}">
          <span class="ellipsis">${esc(item.alias || "Unnamed node")}</span><span class="mono sub">${esc(shortKey(item.pubkey))}</span><span class="sub">${int(item.num_channels)} ch</span></li>`,
      )
      .join("");
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", `${boxId}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  };

  const pick = (index) => {
    const item = items[index];
    if (!item) return;
    cancelRequest();
    input.value = item.pubkey;
    close();
    onPick?.(item);
  };

  input.addEventListener("input", () => {
    cancelRequest();
    const text = input.value.trim();
    clearTimeout(blurTimer);
    if (text.length < 2) return close();
    const mine = seq;
    timer = setTimeout(async () => {
      request = new AbortController();
      try {
        const rows = await api(`/api/autocomplete?q=${encodeURIComponent(text)}&limit=8`, { signal: request.signal });
        if (mine !== seq || disposed) return;
        items = rows;
        active = -1;
        render();
      } catch {
        if (mine === seq && !disposed) close();
      }
    }, 200);
  }, options);

  input.addEventListener("keydown", (event) => {
    if (box.hidden || !items.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = (active + 1) % items.length;
      render();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = active <= 0 ? items.length - 1 : active - 1;
      render();
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      pick(active);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }, options);

  box.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const option = event.target.closest("li[data-index]");
    if (option) pick(Number(option.dataset.index));
  }, options);
  input.addEventListener("blur", () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      cancelRequest();
      close();
    }, 150);
  }, options);

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    cancelRequest();
    clearTimeout(blurTimer);
    lifecycle.abort();
    signal?.removeEventListener("abort", cleanup);
    close();
    box.remove();
    host.classList.remove("ac-host");
    for (const name of ["role", "aria-expanded", "aria-controls", "aria-autocomplete", "aria-activedescendant"]) input.removeAttribute(name);
  };
  signal?.addEventListener("abort", cleanup, { once: true });
  if (signal?.aborted) cleanup();
  return cleanup;
}
