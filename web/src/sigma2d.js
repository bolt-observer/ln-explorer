// Entry for the lazily loaded 2D WebGL map bundle (static/sigma2d.js). sigma reads
// WebGL2RenderingContext constants when it is evaluated, so it must stay out of
// app.js: browsers without WebGL2 would otherwise fail to run the app at all.
import Sigma from "sigma";

window.__boltSigma = Sigma;
