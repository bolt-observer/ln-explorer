// WebGL detection and the lazily loaded renderer bundles that need it.

let webgl;

/** True when the browser can create a WebGL context sigma and three.js can use. */
export function hasWebGL() {
  if (webgl !== undefined) return webgl;
  webgl = false;
  try {
    // sigma reads WebGL2RenderingContext constants on load, even when it renders with WebGL1.
    if (typeof WebGL2RenderingContext === "undefined" || typeof WebGLRenderingContext === "undefined") return webgl;
    const canvas = document.createElement("canvas");
    webgl = Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    webgl = false;
  }
  return webgl;
}

const loading = new Map();

/** Inject /static/<name>.js once and resolve with the global it defines. */
export function loadBundle(name, global) {
  if (window[global]) return Promise.resolve(window[global]);
  if (!loading.has(name)) {
    loading.set(
      name,
      new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `/static/${name}.js`;
        script.async = true;
        script.onload = () => {
          if (window[global]) return resolve(window[global]);
          loading.delete(name);
          reject(new Error(`${name} failed to load`));
        };
        script.onerror = () => {
          loading.delete(name);
          script.remove();
          reject(new Error(`${name} failed to load`));
        };
        document.head.appendChild(script);
      }),
    );
  }
  return loading.get(name);
}

/** The sigma class, or null without WebGL or when its bundle fails to load. */
export async function loadSigma() {
  if (!hasWebGL()) return null;
  try {
    return await loadBundle("sigma2d", "__boltSigma");
  } catch (error) {
    console.warn("2D WebGL map unavailable", error);
    return null;
  }
}
