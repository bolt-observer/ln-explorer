import { icon } from "./icons.js";

// Any element with data-copy="value" copies on click and briefly shows a check.
export function initCopy() {
  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("aria-live", "polite");
  document.body.appendChild(live);

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-copy]");
    if (!target) return;
    event.preventDefault();
    const value = target.getAttribute("data-copy");
    const slot = target.querySelector(".ico") || null;
    try {
      await navigator.clipboard.writeText(value);
      live.textContent = "Copied to clipboard";
      target.classList.add("copied");
      if (slot) slot.outerHTML = icon("check");
      setTimeout(() => {
        target.classList.remove("copied");
        const done = target.querySelector(".ico");
        if (done) done.outerHTML = icon("copy");
      }, 1200);
    } catch {
      live.textContent = "Copy failed";
    }
  });
}

/** Inline copyable key: `03864e…7a3f8f [copy]`. Pass full=true to show the whole value. */
export function copyKey(value, { full = false, label = "" } = {}) {
  const shown = label || (full ? value : `${value.slice(0, 6)}…${value.slice(-6)}`);
  return `<button type="button" class="key" data-copy="${value}" title="Copy ${value}"><span>${shown}</span>${icon("copy")}</button>`;
}
