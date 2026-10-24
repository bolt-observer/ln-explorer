// Entry for the lazily loaded 3D map bundle (static/map3d.js). map.js injects it on demand.
import { create } from "./map3d/scene.js";

window.__boltMap3d = { create };
