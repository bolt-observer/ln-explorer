// Channel lines with per-channel pixel width, as one instanced draw call.
// WebGL lines are always 1 px, and tube/cylinder meshes per channel would cost
// ~12k meshes (or ~1M triangles merged). Each channel here is a camera-facing
// quad expanded in screen space by the vertex shader: 2 triangles per channel.
import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector2,
} from "three";

const vertexShader = /* glsl */ `
uniform vec2 uResolution; // drawing buffer, device px
uniform float uNear;
uniform float uPixelRatio;
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec4 aColor;
attribute float aWidth; // CSS px
varying vec4 vColor;
varying float vAcross; // device px from the centre line
varying float vHalf;   // half the visible width, device px
void main() {
  vec4 va = modelViewMatrix * vec4(aStart, 1.0);
  vec4 vb = modelViewMatrix * vec4(aEnd, 1.0);
  // Clip the segment against the near plane so ends behind the camera project sanely.
  if (va.z > -uNear && vb.z > -uNear) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (va.z > -uNear) va = mix(va, vb, (-uNear - va.z) / (vb.z - va.z));
  if (vb.z > -uNear) vb = mix(vb, va, (-uNear - vb.z) / (va.z - vb.z));
  vec4 a = projectionMatrix * va;
  vec4 b = projectionMatrix * vb;
  vec2 dir = (b.xy / b.w - a.xy / a.w) * uResolution;
  float len = length(dir);
  vec2 normal = len > 1e-5 ? vec2(-dir.y, dir.x) / len : vec2(0.0, 1.0);
  // Sub-pixel channels draw at 1 px with proportionally lower opacity.
  float w = max(aWidth * uPixelRatio, 1.0);
  vHalf = w * 0.5;
  float half = vHalf + 0.75; // room for the antialiased edge
  vAcross = position.y * half;
  vec4 p = mix(a, b, position.x);
  p.xy += normal * vAcross * 2.0 / uResolution * p.w;
  gl_Position = p;
  vColor = vec4(aColor.rgb, aColor.a * min(1.0, aWidth * uPixelRatio));
}`;

const fragmentShader = /* glsl */ `
varying vec4 vColor;
varying float vAcross;
varying float vHalf;
void main() {
  float edge = clamp(vHalf + 0.5 - abs(vAcross), 0.0, 1.0);
  gl_FragColor = vec4(vColor.rgb, vColor.a * edge);
}`;

/** Ribbons for `count` channels. Fill with setSegment/setStyle, then call commit(). */
export function createEdges(count) {
  const geo = new InstancedBufferGeometry();
  // Unit quad: x 0..1 along the channel, y -1..1 across it.
  geo.setAttribute("position", new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  const n = Math.max(1, count);
  const start = new InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage);
  const end = new InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage);
  const color = new InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const width = new InstancedBufferAttribute(new Float32Array(n), 1);
  geo.setAttribute("aStart", start);
  geo.setAttribute("aEnd", end);
  geo.setAttribute("aColor", color);
  geo.setAttribute("aWidth", width);
  geo.instanceCount = count;
  const material = new ShaderMaterial({
    uniforms: { uResolution: { value: new Vector2(1, 1) }, uNear: { value: 0.1 }, uPixelRatio: { value: 1 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
  });
  const mesh = new Mesh(geo, material);
  mesh.frustumCulled = false;
  return {
    mesh,
    setSegment(i, a, b) {
      start.array[i * 3] = a.x;
      start.array[i * 3 + 1] = a.y;
      start.array[i * 3 + 2] = a.z;
      end.array[i * 3] = b.x;
      end.array[i * 3 + 1] = b.y;
      end.array[i * 3 + 2] = b.z;
    },
    setStyle(i, rgba, px) {
      color.array.set(rgba, i * 4);
      width.array[i] = px;
    },
    commitPositions() {
      start.needsUpdate = true;
      end.needsUpdate = true;
    },
    commitStyles() {
      color.needsUpdate = true;
      width.needsUpdate = true;
    },
    /** Call before each render: buffer size in device px, camera near plane. */
    setView(widthPx, heightPx, near, pixelRatio) {
      material.uniforms.uResolution.value.set(widthPx, heightPx);
      material.uniforms.uNear.value = near;
      material.uniforms.uPixelRatio.value = pixelRatio;
    },
    dispose() {
      geo.dispose();
      material.dispose();
    },
  };
}

/**
 * Channel width in CSS px from its capacity in sats, on a log scale:
 * ≤100k sat 0.8 px · 1M 1 px · 10M 1.9 px · 1 BTC 2.8 px · ≥ ~10 BTC 3.6 px.
 * Unknown capacity draws at the thin default.
 */
export function channelWidth(sats) {
  if (!(sats > 0)) return 0.8;
  return Math.min(3.6, Math.max(0.8, 1 + 0.9 * Math.log10(sats / 1e6)));
}
