// "/search?q=" — the map with the search palette open on the query.
import { map } from "../map/map.js";
import { closePalette, openPalette } from "../ui/palette.js";
import { mapChrome } from "./home.js";

export async function mount(ctx) {
  const cleanupChrome = mapChrome(ctx.el);
  map.setDim(false);
  map.setInsets({ top: 72 });
  map.ensure(ctx.route.params).then(() => ctx.alive() && map.clear()).catch(() => {});
  openPalette(ctx.route.params.get("q") || "");
  return () => {
    cleanupChrome();
    closePalette({ navigate: false });
  };
}
