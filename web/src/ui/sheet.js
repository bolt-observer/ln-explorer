// Glass sheet over the map. `placement`: "left" (tables) or "bottom" (dashboards).
import { esc } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { homeUrl } from "../lib/router.js";

let counter = 0;

export function openSheet(host, { title, subtitle = "", placement = "left", width = 820, actions = "" }) {
  counter += 1;
  const id = `sheet-title-${counter}`;
  const root = document.createElement("section");
  root.className = `sheet glass sheet-${placement}`;
  root.setAttribute("aria-labelledby", id);
  root.style.setProperty("--sheet-w", `${width}px`);
  root.innerHTML = `
    ${placement === "bottom" ? '<div class="grip" aria-hidden="true"></div>' : ""}
    <header class="sheet-h">
      <h1 id="${id}">${esc(title)}</h1>
      <div class="sheet-sub">${subtitle}</div>
      <div class="sheet-actions">${actions}</div>
      <a class="btn sm icon ghost" href="${homeUrl()}" aria-label="Close and return to the map">${icon("x")}</a>
    </header>
    <div class="sheet-body"></div>`;
  host.appendChild(root);
  return {
    root,
    body: root.querySelector(".sheet-body"),
    sub: root.querySelector(".sheet-sub"),
    actions: root.querySelector(".sheet-actions"),
    /** Map inset (px) this sheet covers, for map.setInsets. */
    insets() {
      const rect = root.getBoundingClientRect();
      if (placement === "left" && window.innerWidth > 720) return { left: rect.right + 12, top: 72 };
      return { top: 72, bottom: Math.max(0, window.innerHeight - rect.top) };
    },
  };
}
