// "/channel/<id>" — the map with the channel highlighted and explained.
import { map } from "../map/map.js";
import { mountChannelInspector } from "../ui/inspector.js";
import { inspectorInsets, mapChrome } from "./home.js";

export async function mount(ctx) {
  const id = decodeURIComponent(ctx.route.parts[1] || "");
  const cleanupChrome = mapChrome(ctx.el, { inspector: true });
  map.setDim(false);
  map.setInsets(inspectorInsets());
  const loaded = map.ensure(ctx.route.params);
  const inspector = mountChannelInspector(ctx.el, id, {
    signal: ctx.signal,
    onLoaded: (channel) => {
      loaded
        .then(() => {
          if (!ctx.alive() || map.focusEdge(channel.node1.pubkey, channel.node2.pubkey)) return;
          const note = document.createElement("div");
          note.className = "notice";
          note.textContent = "This channel is outside the current map selection. Adjust the graph filters or raise the hub limit to include both endpoints.";
          inspector.querySelector(".head").appendChild(note);
        })
        .catch(() => {});
    },
  });
  return cleanupChrome;
}
