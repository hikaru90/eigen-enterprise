/**
 * Brand water-flow shader assets — the signature monochrome fluid used on
 * landing/website surfaces. Pure logic only (GLSL sources + tint parsing) so
 * it is unit-testable without a GL context; the canvas lifecycle lives in
 * water-flow.svelte.
 *
 * Weight budget: WebGL1, one fullscreen triangle, no textures, no per-frame
 * allocations. Motion is three domain-warped fbm evaluations per pixel
 * (classic water warp), which reads as flowing water at grayscale contrast
 * without multi-pass caustics cost.
 */

export const WATER_FLOW_VERTEX_SHADER = `
attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

export const WATER_FLOW_FRAGMENT_SHADER = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_from;
uniform vec3 u_to;
uniform float u_scale;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);

float fbm(vec2 p) {
  float v = 0.0;
  float amplitude = 0.5;
  // 3 octaves: the 4th octave's apparent motion is 8x the base scroll and
  // flickers at coarse sampling — dropped for a smoother flow.
  for (int i = 0; i < 3; i++) {
    v += amplitude * noise(p);
    p = ROT * p * 2.0;
    amplitude *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution) / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  // Bottom-to-top travel: sampling the field below the screen point makes
  // features rise; the small scalar time terms keep a subordinate smoke wobble.
  vec2 p = uv * u_scale - vec2(0.0, t * 0.6);

  vec2 q = vec2(
    fbm(p + t * 0.03),
    fbm(p + vec2(5.2, 1.3) - t * 0.02)
  );
  vec2 r = vec2(
    fbm(p + 2.0 * q + vec2(1.7, 9.2) + t * 0.05),
    fbm(p + 2.0 * q + vec2(8.3, 2.8) - t * 0.03)
  );
  float f = fbm(p + 2.2 * r);

  float value = clamp(f * f * 1.85 + 0.10 * q.y, 0.0, 1.0);
  vec3 color = mix(u_from, u_to, value);
  color += u_to * 0.05 * smoothstep(0.62, 0.98, f);

  gl_FragColor = vec4(color, 1.0);
}
`

const HEX_TINT = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * Parse a brand tint into normalized sRGB floats for GLSL. Monochrome is a
 * brand invariant of the water-flow asset (not a styling suggestion), so
 * non-grayscale input fails loud instead of rendering.
 */
export function parseMonochromeTint(input: string): [number, number, number] {
  const match = HEX_TINT.exec(input.trim())
  if (!match) {
    throw new Error(
      `water-flow tint "${input}" is not a #rgb / #rrggbb hex color (brand water-flow tints are hex only; no silent fallback)`,
    )
  }
  const hex = match[1]
  const full =
    hex.length === 3
      ? (hex[0] ?? '') + (hex[0] ?? '') + (hex[1] ?? '') + (hex[1] ?? '') + (hex[2] ?? '') + (hex[2] ?? '')
      : hex
  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255
  if (r !== g || g !== b) {
    throw new Error(
      `water-flow tint "${input}" is not monochrome (brand rule: the water-flow asset renders in grayscale tints only)`,
    )
  }
  return [r, g, b]
}

export type WaterFlowColors = {
  from: [number, number, number]
  to: [number, number, number]
}

export function resolveWaterFlowColors(from: string, to: string): WaterFlowColors {
  return { from: parseMonochromeTint(from), to: parseMonochromeTint(to) }
}
