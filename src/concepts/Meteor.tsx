import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import {
  BAKE, COLUMNS, COUNT, FLOOR, FOV_SCALE, IMPACT_POINT, INTRO_TIME, METEOR, PITCH, RIM_HEIGHT, RIM_DEPTH, RIM_LAND, RIM_WIDTH, ROWS,
  SIM_FPS, SIM_YAW, SIZE, START_LOOK, STRIKE_DIR, STRIKE_START, TRAY_X, TRAY_Z, OUTLINE_SIZE, cells, frameBreath, introPose, loneStar, skyStar, meteorHandles, meteorPoint, startDistance, type Pose, type Vec,
} from './meteor.data'

// The box assembles from falling stars, and the one star left over breaks it apart.
// Everything after the impact is a Rapier bake played back by the scroll, so it reverses exactly.

const IMPACT = 0.17
const SETTLED = 0.7
const CUBES = 64
const STARS = 1500
const SPARKS = 520
const EMBERS = 5000
const PUFFS = 150
const FLIGHT_CLOCK = 3.2
const TRAIL = 44
const GHOSTS = 14
const STREAK_STEP = 0.032
const END_LOOK = 1.03
const END_TURN = -0.24

const SIM_END = (BAKE.frames - 1) / SIM_FPS
const THUD = BAKE.landed[METEOR]
const simClock = (progress: number) => {
  const u = (progress - IMPACT) / (SETTLED - IMPACT)
  return SIM_END * (0.45 * u + 0.55 * u * u)
}

const decode = (text: string) => {
  const raw = atob(text)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return new Int16Array(bytes.buffer)
}
const positions = decode(BAKE.positions)
const rotations = decode(BAKE.rotations)
const POSITION = BAKE.range / 32767

const last = (BAKE.frames - 1) * COUNT
const home = Array.from({ length: COUNT }, (_, i) => {
  const x = positions[(last + i) * 3] * POSITION
  const z = positions[(last + i) * 3 + 2] * POSITION
  return { x, z, column: Math.round((x - TRAY_X) / PITCH + (COLUMNS - 1) / 2), row: Math.round((z - TRAY_Z) / PITCH + (ROWS - 1) / 2) }
})
const meteorHome = home[METEOR]
const struckBy = cells.map(([x, y, z]) => {
  const cos = Math.cos(SIM_YAW)
  const sin = Math.sin(SIM_YAW)
  return Math.hypot(x * cos + z * sin - IMPACT_POINT[0], y - IMPACT_POINT[1], -x * sin + z * cos - IMPACT_POINT[2])
})
const reach = home.map((key) => Math.hypot(key.x - meteorHome.x, key.z - meteorHome.z))

const KEY_ROWS = [
  'Escape F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12',
  'Backquote Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal',
  'Tab KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight',
  'CapsLock KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote Enter',
  'ShiftLeft KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash ShiftRight ArrowUp',
].map((row) => row.split(' '))
const codes = home.map(({ column, row }, i) => (i === METEOR ? 'Space' : KEY_ROWS[row][column]))

// A single diagonal stroke of cream across the blue, like a brush mark.
const tints = home.map((key, i) => (i === METEOR ? -1 : Math.abs((key.x - TRAY_X) * 0.5 + (key.z - TRAY_Z) * 1.1 - 0.6) < 0.86 ? 1 : 0))

let seed = 5
const random = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}

const palette = /* glsl */ `
  uniform float uTheme;
  const vec3 BLUE = vec3(0.0116, 0.162, 0.838);
  const vec3 CREAM = vec3(1.0, 0.973, 0.871);
  const vec3 INK = vec3(0.0024, 0.0027, 0.0037);
`

const cubeVertex = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec4 aQuat;
  attribute vec4 aState; // scale, heat, hover, settled
  attribute vec3 aHome;
  attribute float aTint; // 0 blue, 1 cream, -1 stays black

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vHome;
  varying vec3 vCubeNormal;
  varying vec4 vState;
  varying float vTint;

  vec3 rotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  void main() {
    float radius = aState.x * 0.087; // keeps its hard edge at every size
    vec3 local = sign(position) * (aState.x * 0.5 - radius) + normal * radius;
    vec3 world = rotate(aQuat, local) + aOffset;
    vWorld = world;
    vNormal = rotate(aQuat, normal);
    vCubeNormal = normal;
    vHome = aHome + local;
    vState = aState;
    vTint = aTint;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const cubeFragment = /* glsl */ `
  ${palette}
  uniform float uTime;
  uniform float uFront;
  uniform float uLeak;
  uniform float uSweep;
  uniform vec3 uLeaks[3];
  uniform vec3 uImpact;
  uniform vec3 uLight;
  uniform float uPower;
  uniform float uHot;

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vHome;
  varying vec3 vCubeNormal;
  varying vec4 vState;
  varying float vTint;

  // Repeated warping gives the slow, folding look of water.
  float liquid(vec3 p) {
    float t = uTime * 0.24;
    for (int i = 0; i < 4; i++) p += 0.6 * sin(p.yzx * 1.7 + t + float(i) * 1.3);
    return 0.5 + 0.5 * sin(p.x + p.y * 0.7 - p.z * 0.6);
  }

  vec3 aces(vec3 x) {
    return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  float softbox(vec3 r) {
    float top = smoothstep(0.3, 0.95, r.y);
    float strip = smoothstep(0.12, 0.0, abs(r.x - 0.55)) * smoothstep(-0.6, 0.3, r.y);
    return top * 0.9 + strip * 0.7;
  }

  void main() {
    if (vState.x < 0.002) discard;

    vec3 view = normalize(cameraPosition - vWorld);
    vec3 geometric = normalize(vNormal);
    float settled = vState.w;
    float hover = clamp(vState.z, 0.0, 1.0);

    // Riding on the cube while it tumbles, shared across the board once it lands.
    vec3 q = mix(vHome * 0.62, vWorld * 0.62, settled);
    float field = liquid(q);
    vec2 slope = vec2(liquid(q + vec3(0.05, 0.0, 0.0)), liquid(q + vec3(0.0, 0.0, 0.05))) - field;

    // The colour runs out from the impact, and rides the cubes while they fly apart.
    // Every edge is pixel sharp: black gloss, a thin bright rim, then chrome.
    float reach = uFront - length(vHome - uImpact) + (field - 0.5) * 1.5;
    float frontWidth = fwidth(reach) * 1.1;
    float front = vTint < 0.0 ? 0.0 : smoothstep(-frontWidth, frontWidth, reach);
    float rim = vTint < 0.0 ? 0.0 : 1.0 - smoothstep(frontWidth * 0.35, frontWidth * 1.2, abs(reach));

    // The idle leak: patches placed in view space each frame, so they stay on the near sides.
    float patchEdge = -1.0;
    vec3 outward = normalize(vWorld);
    for (int i = 0; i < 3; i++) patchEdge = max(patchEdge, dot(outward, uLeaks[i]));
    // Grows out of the gloss and melts away at its edge, with no line around it.
    float leakEdge = (patchEdge - 0.93) * 2.0 + (field - 0.5) * 0.95 - (1.0 - uLeak) * 1.1;
    float leak = smoothstep(-0.34, 0.42, leakEdge) * uLeak;

    float mask = max(max(front, leak), hover);

    vec3 bent = normalize(geometric + vec3(slope.x, 0.0, slope.y) * mix(3.4, 2.2, settled) * mask);
    vec3 reflected = reflect(-view, bent);
    float facing = max(dot(geometric, view), 0.0);
    float fresnel = pow(1.0 - facing, 3.5);
    float pearl = max(vTint, 0.0) * max(front, hover); // the leak on the shut box is always blue

    // Black gloss, the surface the box starts with.
    vec3 rippled = normalize(geometric + vec3(slope.x, 0.0, slope.y) * 0.7);
    float light = softbox(reflect(-view, rippled));
    float sheen = smoothstep(0.25, 0.8, field);
    vec3 gloss = INK + mix(BLUE, CREAM, 0.5) * light * sheen * mix(0.05, 0.06, uTheme);
    gloss += fresnel * mix(BLUE * 0.1, CREAM * 0.1, uTheme);
    float seam = 1.0 - smoothstep(0.8, 0.98, max(abs(vCubeNormal.x), max(abs(vCubeNormal.y), abs(vCubeNormal.z))));
    float keystone = vTint < 0.0 ? settled : 0.0; // the meteor must read as a black key, not a missing one
    gloss += seam * mix(mix(BLUE, CREAM, 0.25) * mix(0.13, 0.5, keystone), CREAM * 0.14, uTheme);
    gloss += mix(BLUE, CREAM, 0.5) * keystone * light * 0.06;

    // Chrome: hard folded bands of the studio, led by the cube's own colour.
    float wave = reflected.y * 0.8 + reflected.x * 0.3 + field * mix(1.7, 1.15, settled);
    float band = 0.5 + 0.5 * sin(wave * 6.283);
    float vein = smoothstep(0.08, 0.0, abs(fract(wave + 0.1) - 0.5));
    vec3 cobalt = mix(INK * 3.0, BLUE * 0.3, smoothstep(0.0, 0.14, band));
    cobalt = mix(cobalt, BLUE, smoothstep(0.1, 0.5, band));
    cobalt = mix(cobalt, mix(BLUE, CREAM, 0.3), smoothstep(0.8, 0.93, band));
    cobalt = mix(cobalt, CREAM, smoothstep(0.95, 0.998, band));
    vec3 pale = mix(mix(BLUE, CREAM, 0.34), CREAM * 0.84, smoothstep(0.0, 0.4, band));
    pale = mix(pale, CREAM, smoothstep(0.6, 0.9, band));
    pale = mix(pale, BLUE * 0.7, vein * 0.75);
    vec3 chrome = mix(cobalt, pale, pearl);
    chrome = mix(chrome, mix(BLUE * 0.55, BLUE * 0.75 + CREAM * 0.25, pearl), fresnel * 0.6);
    chrome = mix(chrome, mix(BLUE * 1.15 + CREAM * 0.1, CREAM * 0.72 + BLUE * 0.2, pearl), seam);

    vec3 color = mix(gloss, chrome, mask);
    color = mix(color, mix(BLUE, CREAM, 0.85), rim * 0.95);

    // A band of light crosses the finished board.
    float sweep = exp(-pow(vWorld.x * 0.4 - uSweep, 2.0) * 9.0);
    color += mix(CREAM * 0.22, BLUE * 0.22, uTheme) * sweep * mask;

    float highlight = pow(max(dot(reflected, normalize(vec3(0.4, 0.8, 0.45))), 0.0), 160.0);
    color += CREAM * highlight * (0.25 + mask * 0.6);

    // The meteor is a real point light: inverse square, lit side only, tone mapped.
    vec3 toLight = uLight - vWorld;
    float reachLight = dot(toLight, toLight);
    vec3 ray = toLight / sqrt(reachLight);
    float fall = vTint < 0.0 ? 0.0 : uPower / (reachLight + 0.9); // the meteor does not light itself
    float diffuse = max(dot(bent, ray), 0.0) * mix(0.012, 0.4, mask);
    float glance = pow(max(dot(mix(rippled, bent, mask), normalize(ray + view)), 0.0), mix(260.0, 180.0, mask));
    float edgeCatch = seam * max(dot(geometric, ray), 0.0) * 0.26;
    vec3 tone = mix(mix(BLUE * 1.5, CREAM, uHot), BLUE, uTheme);
    color += aces(tone * fall * (diffuse + glance * 2.4 + edgeCatch));

    // Stars burn hot at the edges, and cool to gloss on the way in.
    float heat = vState.y;
    vec3 hot = mix(mix(BLUE * 1.2, CREAM, smoothstep(0.1, 0.8, heat)), BLUE, uTheme);
    float burn = clamp(seam * 1.1 + pow(1.0 - facing, 4.0) * 0.5, 0.0, 1.0);
    color = mix(color, hot, clamp(heat * 1.6, 0.0, 1.0) * burn);

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`

const starVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPixel;
  uniform float uDim;
  attribute vec4 aStar; // size, phase, speed, tint
  varying float vLight;
  varying float vTint;

  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.05 + aStar.y) * 1.6;
    p.y += cos(uTime * 0.04 + aStar.y * 1.7) * 1.2;
    float twinkle = 0.5 + 0.5 * sin(uTime * aStar.z + aStar.y * 6.0);
    vLight = (0.28 + 0.72 * twinkle * twinkle) * uDim;
    vTint = aStar.w;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aStar.x * uPixel * (0.8 + 0.3 * twinkle);
  }
`

const starFragment = /* glsl */ `
  ${palette}
  varying float vLight;
  varying float vTint;

  void main() {
    float alpha = 1.0 - smoothstep(0.2, 0.5, length(gl_PointCoord - 0.5));
    vec3 dark = mix(CREAM, BLUE * 2.2, vTint);
    vec3 color = mix(dark, mix(BLUE, INK, vTint * 0.6), uTheme);
    gl_FragColor = vec4(color, alpha * vLight * mix(0.95, 0.75, uTheme));
    #include <colorspace_fragment>
  }
`

const headVertex = /* glsl */ `
  uniform float uPixel;
  attribute float aSize;
  attribute float aLight;
  varying float vLight;
  void main() {
    vLight = aSize > 0.01 ? aLight : 0.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixel;
  }
`

const headFragment = /* glsl */ `
  ${palette}
  varying float vLight;
  void main() {
    if (vLight <= 0.004) discard;
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float alpha = exp(-d * d * 7.0) * (1.0 - smoothstep(0.8, 1.0, d)) * vLight;
    vec3 color = mix(mix(BLUE * 1.7, CREAM, smoothstep(0.1, 0.7, vLight)), mix(BLUE, INK * 4.0, 1.0 - vLight), uTheme);
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`

const trailVertex = /* glsl */ `
  attribute vec2 aTrail; // along, across
  varying vec2 vTrail;
  void main() {
    vTrail = aTrail;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const trailFragment = /* glsl */ `
  ${palette}
  varying vec2 vTrail;
  void main() {
    float across = 1.0 - vTrail.y * vTrail.y;
    float along = pow(1.0 - vTrail.x, 2.2);
    vec3 color = mix(mix(CREAM, BLUE * 1.5, vTrail.x * 1.4), mix(BLUE, INK, vTrail.x), uTheme);
    gl_FragColor = vec4(color, across * across * along);
    #include <colorspace_fragment>
  }
`

// Grit shed along the flight path. Age comes from the scroll, so it rewinds exactly.
const plumeVertex = /* glsl */ `
  uniform float uClock;
  uniform float uPixel;
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uC;
  uniform vec3 uD;
  attribute vec4 aEmber; // path position, life, size, seed
  varying float vCool;
  varying float vFade;

  void main() {
    float u = aEmber.x;
    float seed = aEmber.w;
    float born = pow(u, 1.0 / 2.6) * ${FLIGHT_CLOCK.toFixed(2)};
    float age = uClock - born;
    float t = age / aEmber.y;
    float k = 1.0 - u;
    vec3 p = k * k * k * uA + 3.0 * k * k * u * uB + 3.0 * k * u * u * uC + u * u * u * uD;
    vec3 tangent = normalize(k * k * (uB - uA) + 2.0 * k * u * (uC - uB) + u * u * (uD - uC));
    vec4 base = modelViewMatrix * vec4(p, 1.0);
    float depth = clamp(-base.z / 16.0, 0.6, 3.5);

    float a = max(age, 0.0);
    vec3 turbulence = sin(seed * vec3(12.9, 78.2, 37.7) + a * vec3(1.3, 1.9, 1.1) + p.zxy * 0.7)
      + 0.5 * sin(seed * vec3(41.0, 9.0, 63.0) + a * vec3(3.1, 2.3, 3.7) + p.yzx * 1.9);
    p += turbulence * (0.025 + a * 0.5) * depth;
    p += vec3(sin(u * 46.0), sin(u * 31.0 + 2.0), cos(u * 39.0)) * a * 0.42 * depth; // the whole plume curls
    p += tangent * (1.0 - exp(-a * 3.0)) * 0.7 * depth;
    p.y -= a * a * 0.3;

    // Bursts and gaps along the path, so it never reads as a band.
    float clump = smoothstep(0.05, 0.7, 0.5 + 0.35 * sin(u * 83.0 + seed) + 0.3 * sin(u * 211.0 + sin(u * 37.0) * 3.0));
    vCool = clamp(t, 0.0, 1.0);
    vFade = age < 0.0 || t > 1.0 ? 0.0 : pow(1.0 - t, 1.4) * clump;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aEmber.z * 1.25 * uPixel * (1.0 - t * 0.45);
  }
`

const plumeFragment = /* glsl */ `
  ${palette}
  varying float vCool;
  varying float vFade;
  void main() {
    if (vFade <= 0.004) discard;
    vec2 c = gl_PointCoord - 0.5;
    float alpha = exp(-dot(c, c) * 9.0) * min(vFade * 1.1, 1.0);
    vec3 dark = mix(CREAM, BLUE * 1.7, smoothstep(0.0, 0.2, vCool));
    vec3 light = mix(BLUE, INK * 6.0, smoothstep(0.2, 0.9, vCool));
    gl_FragColor = vec4(mix(dark, light, uTheme), alpha);
    #include <colorspace_fragment>
  }
`

const glintVertex = /* glsl */ `
  uniform vec3 uLight;
  uniform float uPower;
  uniform float uPixel;
  varying float vGlint;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 toLight = uLight - world.xyz;
    vGlint = clamp(uPower / (dot(toLight, toLight) + 2.0) * 0.24, 0.0, 0.8);
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_PointSize = (9.0 + vGlint * 2.0) * uPixel;
  }
`

const glintFragment = /* glsl */ `
  ${palette}
  uniform float uDot;
  varying float vGlint;
  void main() {
    float shape = uDot > 0.5 ? 1.0 - smoothstep(0.3, 0.5, length(gl_PointCoord - 0.5)) : 1.0;
    gl_FragColor = vec4(mix(CREAM, BLUE, uTheme), shape * vGlint);
    #include <colorspace_fragment>
  }
`

const dustVertex = /* glsl */ `
  uniform float uAge;
  uniform float uPixel;
  uniform float uProject;
  uniform vec3 uFrom;
  attribute vec3 aVelocity;
  attribute vec3 aPuff; // life, size, seed
  varying float vFade;

  void main() {
    float age = max(uAge, 0.0);
    float spread = (1.0 - exp(-age * 1.5)) / 1.5;
    vec3 p = uFrom + aVelocity * spread;
    p += sin(aPuff.z * vec3(9.0, 17.0, 5.0) + age * vec3(0.9, 0.6, 0.7)) * age * 0.35;
    p.y += age * 0.28;
    float t = age / aPuff.x;
    vFade = uAge <= 0.0 || t >= 1.0 ? 0.0 : smoothstep(0.0, 0.12, t) * pow(1.0 - t, 2.0);
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * view;
    gl_PointSize = aPuff.y * (0.5 + age * 0.8) * uProject * uPixel / -view.z;
  }
`

const dustFragment = /* glsl */ `
  ${palette}
  varying float vFade;
  void main() {
    if (vFade <= 0.002) discard;
    vec2 c = gl_PointCoord - 0.5;
    float alpha = exp(-dot(c, c) * 12.0) * (1.0 - smoothstep(0.32, 0.5, length(c)));
    gl_FragColor = vec4(mix(mix(BLUE, CREAM, 0.16) * 0.5, INK * 10.0, uTheme), alpha * vFade * mix(0.05, 0.06, uTheme));
    #include <colorspace_fragment>
  }
`

const sparkVertex = /* glsl */ `
  uniform float uAge;
  uniform float uPixel;
  uniform vec3 uFrom;
  attribute vec3 aVelocity;
  attribute vec3 aSpark; // life, size, tint
  varying float vFade;
  varying float vTint;

  void main() {
    float age = max(uAge, 0.0);
    float fall = (1.0 - exp(-age * 3.0)) / 3.0;
    vec3 p = uFrom + aVelocity * fall + vec3(0.0, -7.0, 0.0) * age * age;
    float left = 1.0 - age / aSpark.x;
    vFade = uAge <= 0.0 ? 0.0 : max(left, 0.0);
    vTint = 1.0 - vFade; // cools as it flies
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSpark.y * uPixel * (0.35 + 0.65 * vFade);
  }
`

const sparkFragment = /* glsl */ `
  ${palette}
  varying float vFade;
  varying float vTint;
  void main() {
    if (vFade <= 0.0) discard;
    float alpha = 1.0 - smoothstep(0.15, 0.5, length(gl_PointCoord - 0.5));
    vec3 color = mix(mix(CREAM, BLUE * 1.8, smoothstep(0.1, 0.6, vTint)), mix(BLUE, INK * 5.0, vTint), uTheme);
    gl_FragColor = vec4(color, alpha * smoothstep(0.0, 0.25, vFade));
    #include <colorspace_fragment>
  }
`

const shadowVertex = /* glsl */ `
  attribute vec3 aShadow; // x, z, strength
  varying vec2 vUv;
  varying float vStrength;
  void main() {
    vUv = uv * 2.0 - 1.0;
    vStrength = aShadow.z;
    gl_Position = projectionMatrix * viewMatrix * vec4(position + vec3(aShadow.x, 0.0, aShadow.y), 1.0);
  }
`

const shadowFragment = /* glsl */ `
  ${palette}
  varying vec2 vUv;
  varying float vStrength;
  void main() {
    if (vStrength <= 0.002) discard;
    float edge = max(abs(vUv.x), abs(vUv.y));
    float alpha = (1.0 - smoothstep(0.42, 1.0, edge)) * vStrength;
    gl_FragColor = vec4(mix(BLUE * 1.4, INK, uTheme), alpha * mix(0.17, 0.4, uTheme));
    #include <colorspace_fragment>
  }
`

const frameDotVertex = /* glsl */ `
  uniform float uPixel;
  attribute float aPulse;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = 9.0 * uPixel * aPulse;
  }
`

const frameDotFragment = /* glsl */ `
  ${palette}
  uniform float uOpacity;
  void main() {
    float alpha = 1.0 - smoothstep(0.42, 0.5, length(gl_PointCoord - 0.5));
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(BLUE, alpha * uOpacity);
    #include <colorspace_fragment>
  }
`

const CORNERS = [
  [-0.5, -0.5, -0.5],
  [0.5, -0.5, -0.5],
  [0.5, -0.5, 0.5],
  [-0.5, -0.5, 0.5],
  [-0.5, 0.5, -0.5],
  [0.5, 0.5, -0.5],
  [0.5, 0.5, 0.5],
  [-0.5, 0.5, 0.5],
]
const EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]
const FRAME_POINTS = EDGES.map((corner) => CORNERS[corner] as [number, number, number])
const CREAM_LINE = new THREE.Color('#FFFCF0')
const BLUE_LINE = new THREE.Color('#1C70EC')
const offsets = new Float32Array(24)

// The outline, with corners of its own so it can float around the box while idle.
// Once scrolled it is a plain box again, driven by `follow`.
function Frame({ follow, pixel, children }: { follow: React.RefObject<THREE.Group | null>; pixel: { value: number }; children: React.ReactNode }) {
  const box = useRef<THREE.Group>(null)
  const line = useRef<React.ComponentRef<typeof Line>>(null)
  const rest = useRef(false)
  const dots = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(CORNERS.flat(), 3))
    geometry.setAttribute('aPulse', new THREE.Float32BufferAttribute(new Float32Array(8).fill(1), 1))
    const material = new THREE.ShaderMaterial({
      vertexShader: frameDotVertex,
      fragmentShader: frameDotFragment,
      uniforms: { uTheme: { value: 0 }, uPixel: pixel, uOpacity: { value: 0 } },
      transparent: true,
    })
    return { geometry, material }
  }, [pixel])

  useFrame(({ clock }) => {
    if (!box.current || !line.current || !follow.current) return
    const time = clock.elapsedTime
    const alive = hero.still ? 0 : 1 - smooth(0, 0.02, hero.progress)
    const breath = frameBreath(time, offsets)
    const size = 1 + (breath - 1) * alive

    box.current.quaternion.copy(follow.current.quaternion)
    box.current.position.copy(follow.current.position)
    box.current.scale.copy(follow.current.scale).multiplyScalar(OUTLINE_SIZE * size)

    const appear = smooth(0.35, 1, hero.intro)
    const material = line.current.material
    material.color.lerpColors(CREAM_LINE, BLUE_LINE, hero.theme)
    material.opacity = appear * 0.82
    dots.material.uniforms.uTheme.value = hero.theme
    dots.material.uniforms.uOpacity.value = appear

    // Only rewrites the corners while they are moving.
    if (alive > 0 || !rest.current) {
      rest.current = alive <= 0
      const corners = dots.geometry.getAttribute('position') as THREE.BufferAttribute
      const pulse = dots.geometry.getAttribute('aPulse') as THREE.BufferAttribute
      for (let i = 0; i < 8; i++) {
        corners.setXYZ(
          i,
          CORNERS[i][0] + (offsets[i * 3] * alive) / OUTLINE_SIZE,
          CORNERS[i][1] + (offsets[i * 3 + 1] * alive) / OUTLINE_SIZE,
          CORNERS[i][2] + (offsets[i * 3 + 2] * alive) / OUTLINE_SIZE,
        )
        pulse.setX(i, 1 + 0.2 * alive * Math.sin(time * (0.7 + i * 0.05) + i * 1.9))
      }
      corners.needsUpdate = true
      pulse.needsUpdate = true
      const shared = line.current.geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute
      const array = shared.data.array as Float32Array
      for (let e = 0; e < EDGES.length; e++) array.set([corners.getX(EDGES[e]), corners.getY(EDGES[e]), corners.getZ(EDGES[e])], e * 3)
      shared.data.needsUpdate = true
    }
  })

  return (
    <group ref={box}>
      <Line ref={line} points={FRAME_POINTS} segments lineWidth={1.1} transparent frustumCulled={false} />
      <points geometry={dots.geometry} material={dots.material} frustumCulled={false} />
      {children}
    </group>
  )
}

const pose: Pose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, scale: 0, heat: 0, sky: 0 }
const boxQuat = new THREE.Quaternion()
const cubeQuat = new THREE.Quaternion()
const simQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), SIM_YAW)
const rimTilt = new THREE.Quaternion()
const point = new THREE.Vector3()
const side = new THREE.Vector3()
const along = new THREE.Vector3()
const look = new THREE.Vector3()
const eye = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const STRIKE = new THREE.Vector3(...STRIKE_DIR)
const KNOCK_AXIS = new THREE.Vector3().crossVectors(STRIKE, UP).normalize()
const lone: Vec = [0, 0, 0]
const spot: Vec = [0, 0, 0]
const view = new THREE.Vector3()
const head: Vec = [0, 0, 0]
const behind: Vec = [0, 0, 0]
const flightPose = (x: number, y: number, z: number, angle: number) => {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  point.set(x * cos + z * sin, y, -x * sin + z * cos)
}

function Stars({ uniforms }: { uniforms: Record<string, THREE.IUniform> }) {
  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const at = new Float32Array(STARS * 3)
    const star = new Float32Array(STARS * 4)
    for (let i = 0; i < STARS; i++) {
      const z = random() * 2 - 1
      const angle = random() * Math.PI * 2
      const radius = 34 + Math.pow(random(), 0.6) * 130
      const ring = Math.sqrt(1 - z * z)
      at[i * 3] = Math.cos(angle) * ring * radius
      at[i * 3 + 1] = z * radius
      at[i * 3 + 2] = Math.sin(angle) * ring * radius
      star[i * 4] = 1.3 + Math.pow(random(), 3) * 2.4
      star[i * 4 + 1] = random() * 10
      star[i * 4 + 2] = 0.5 + random() * 2.2
      star[i * 4 + 3] = random() < 0.3 ? 1 : 0
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(at, 3))
    geometry.setAttribute('aStar', new THREE.BufferAttribute(star, 4))
    return geometry
  }, [])
  const material = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: starVertex, fragmentShader: starFragment, uniforms, transparent: true, depthWrite: false }),
    [uniforms],
  )
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={-1} />
}

function Sparks({ material, count, speed, up }: { material: THREE.ShaderMaterial; count: number; speed: number; up: number }) {
  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const velocity = new Float32Array(count * 3)
    const spark = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const z = random() * 2 - 1
      const angle = random() * Math.PI * 2
      const ring = Math.sqrt(1 - z * z)
      const pace = speed * (0.25 + Math.pow(random(), 2) * 1.2)
      velocity[i * 3] = (Math.cos(angle) * ring - STRIKE_DIR[0] * 0.5) * pace
      velocity[i * 3 + 1] = Math.abs(z) * pace * up + 0.4 * pace * (1 - up)
      velocity[i * 3 + 2] = (Math.sin(angle) * ring - STRIKE_DIR[2] * 0.5) * pace
      spark[i * 3] = 0.35 + Math.pow(random(), 1.6) * 1.7
      spark[i * 3 + 1] = 1.1 + Math.pow(random(), 4) * 3.6
      spark[i * 3 + 2] = random() < 0.45 ? 1 : 0
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    geometry.setAttribute('aVelocity', new THREE.BufferAttribute(velocity, 3))
    geometry.setAttribute('aSpark', new THREE.BufferAttribute(spark, 3))
    return geometry
  }, [count, speed, up])
  return <points geometry={geometry} material={material} frustumCulled={false} />
}

function Plume({ material }: { material: THREE.ShaderMaterial }) {
  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const ember = new Float32Array(EMBERS * 4)
    for (let i = 0; i < EMBERS; i++) {
      const fine = random()
      ember[i * 4] = i % 2 ? 0.004 + random() * 0.996 : 1 - 0.34 * Math.pow(random(), 2)
      ember[i * 4 + 1] = fine < 0.1 ? 1.4 + random() * 1.2 : 0.24 + Math.pow(random(), 1.4) * 1.3
      ember[i * 4 + 2] = fine < 0.1 ? 2.4 + random() * 1.8 : 1 + Math.pow(random(), 3) * 2
      ember[i * 4 + 3] = random() * 10
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(EMBERS * 3), 3))
    geometry.setAttribute('aEmber', new THREE.BufferAttribute(ember, 4))
    return geometry
  }, [])
  return <points geometry={geometry} material={material} frustumCulled={false} />
}

function Dust({ uniforms }: { uniforms: Record<string, THREE.IUniform> }) {
  const { geometry, material } = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const velocity = new Float32Array(PUFFS * 3)
    const puff = new Float32Array(PUFFS * 3)
    for (let i = 0; i < PUFFS; i++) {
      const z = random() * 2 - 1
      const angle = random() * Math.PI * 2
      const ring = Math.sqrt(1 - z * z)
      const pace = 0.5 + Math.pow(random(), 1.5) * 3
      velocity[i * 3] = (Math.cos(angle) * ring - STRIKE_DIR[0] * 0.8) * pace
      velocity[i * 3 + 1] = (z * 0.7 + 0.25) * pace
      velocity[i * 3 + 2] = (Math.sin(angle) * ring - STRIKE_DIR[2] * 0.8) * pace
      puff[i * 3] = 1.1 + random() * 2
      puff[i * 3 + 1] = 0.9 + random() * 1.9
      puff[i * 3 + 2] = random() * 10
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PUFFS * 3), 3))
    geometry.setAttribute('aVelocity', new THREE.BufferAttribute(velocity, 3))
    geometry.setAttribute('aPuff', new THREE.BufferAttribute(puff, 3))
    const material = new THREE.ShaderMaterial({ vertexShader: dustVertex, fragmentShader: dustFragment, uniforms, transparent: true, depthWrite: false })
    return { geometry, material }
  }, [uniforms])
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />
}

export function Scene() {
  const { geometry, offset, quat, state } = useMemo(() => {
    const geometry = new RoundedBoxGeometry(1, 1, 1, 3, 0.2)
    const attribute = (name: string, itemSize: number) => {
      const buffer = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * itemSize), itemSize)
      geometry.setAttribute(name, buffer)
      return buffer
    }
    const offset = attribute('aOffset', 3)
    const quat = attribute('aQuat', 4)
    const state = attribute('aState', 4)
    const homes = attribute('aHome', 3)
    const tint = attribute('aTint', 1)
    offset.setUsage(THREE.DynamicDrawUsage)
    quat.setUsage(THREE.DynamicDrawUsage)
    state.setUsage(THREE.DynamicDrawUsage)
    for (let i = 0; i < COUNT; i++) {
      const cell = cells[i] ?? [1.4, -1.2, 1.9]
      homes.setXYZ(i, cell[0], cell[1], cell[2])
      tint.setX(i, tints[i])
    }
    return { geometry, offset, quat, state }
  }, [])

  const theme = useMemo(() => ({ value: 0 }), [])
  const pixel = useMemo(() => ({ value: 1 }), [])
  const time = useMemo(() => ({ value: 0 }), [])

  const cubes = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: cubeVertex,
        fragmentShader: cubeFragment,
        uniforms: {
          uTheme: theme,
          uTime: time,
          uFront: { value: -9 },
          uLeak: { value: 0 },
          uSweep: { value: -9 },
          uLeaks: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
          uImpact: { value: new THREE.Vector3(...IMPACT_POINT).applyQuaternion(simQuat.clone().invert()) },
          uLight: { value: new THREE.Vector3() },
          uPower: { value: 0 },
          uHot: { value: 1 },
        },
      }),
    [theme, time],
  )

  const starUniforms = useMemo(() => ({ uTheme: theme, uTime: time, uPixel: pixel, uDim: { value: 1 } }), [theme, time, pixel])
  const impactSparks = useMemo(() => ({ uTheme: theme, uPixel: pixel, uAge: { value: -1 }, uFrom: { value: new THREE.Vector3(...IMPACT_POINT) } }), [theme, pixel])
  const thudSparks = useMemo(
    () => ({ uTheme: theme, uPixel: pixel, uAge: { value: -1 }, uFrom: { value: new THREE.Vector3(meteorHome.x, FLOOR + SIZE, meteorHome.z) } }),
    [theme, pixel],
  )

  // Travelling stars: a point of light, and a short fine streak of grit behind it.
  const flight = useMemo(() => {
    const total = CUBES * (1 + GHOSTS)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(total), 1))
    geometry.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(total), 1))
    const material = new THREE.ShaderMaterial({ vertexShader: headVertex, fragmentShader: headFragment, uniforms: { uTheme: theme, uPixel: pixel }, transparent: true, depthWrite: false })
    const dots = new THREE.Points(geometry, material)
    dots.frustumCulled = false
    const grit = Float32Array.from({ length: total * 4 }, () => random())
    return { geometry, material, dots, grit }
  }, [theme, pixel])

  const trail = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const vertices = TRAIL * 2
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3))
    const marks = new Float32Array(vertices * 2)
    const index: number[] = []
    for (let i = 0; i < TRAIL; i++) {
      marks[i * 4] = i / (TRAIL - 1)
      marks[i * 4 + 1] = -1
      marks[i * 4 + 2] = i / (TRAIL - 1)
      marks[i * 4 + 3] = 1
      if (i < TRAIL - 1) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
    }
    geometry.setAttribute('aTrail', new THREE.BufferAttribute(marks, 2))
    geometry.setIndex(index)
    const material = new THREE.ShaderMaterial({
      vertexShader: trailVertex,
      fragmentShader: trailFragment,
      uniforms: { uTheme: theme },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    return { geometry, material }
  }, [theme])

  const additive = useMemo(
    () => (vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, depthWrite: false }),
    [],
  )
  const plumeUniforms = useMemo(() => {
    const zero = () => ({ value: new THREE.Vector3() })
    return { uTheme: theme, uPixel: pixel, uClock: { value: 0 }, uA: zero(), uB: zero(), uC: zero(), uD: zero() }
  }, [theme, pixel])
  const plume = useMemo(() => additive(plumeVertex, plumeFragment, plumeUniforms), [additive, plumeUniforms])
  const sparkHit = useMemo(() => additive(sparkVertex, sparkFragment, impactSparks), [additive, impactSparks])
  const sparkThud = useMemo(() => additive(sparkVertex, sparkFragment, thudSparks), [additive, thudSparks])
  const dustUniforms = useMemo(
    () => ({ uTheme: theme, uPixel: pixel, uProject: { value: 1 }, uAge: { value: -1 }, uFrom: { value: new THREE.Vector3(...IMPACT_POINT) } }),
    [theme, pixel],
  )

  // The tip of the meteor: a tight hot point, and the same light glancing off the outline.
  const core = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(1), 1))
    geometry.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array([1]), 1))
    const material = additive(headVertex, headFragment, { uTheme: theme, uPixel: pixel })
    material.depthTest = false
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    points.renderOrder = 6
    return points
  }, [additive, theme, pixel])

  const glint = useMemo(() => {
    const corners = [-0.5, 0.5]
    const edge: number[] = []
    const dot: number[] = []
    const STEPS = 10
    corners.forEach((a) =>
      corners.forEach((b) => {
        for (let i = 0; i < STEPS; i++) {
          const from = i / STEPS - 0.5
          const to = from + 1 / STEPS
          edge.push(from, a, b, to, a, b, a, from, b, a, to, b, a, b, from, a, b, to)
        }
        dot.push(a, b, -0.5, a, b, 0.5)
      }),
    )
    const light = { uLight: cubes.uniforms.uLight, uPower: cubes.uniforms.uPower }
    const make = (points: number[], isDot: number) => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
      return { geometry, material: additive(glintVertex, glintFragment, { uTheme: theme, uPixel: pixel, ...light, uDot: { value: isDot } }) }
    }
    const lines = make(edge, 0)
    const dots = make(dot, 1)
    const group = new THREE.Group()
    group.add(new THREE.LineSegments(lines.geometry, lines.material), new THREE.Points(dots.geometry, dots.material))
    group.traverse((child) => (child.frustumCulled = false))
    return { group, materials: [lines.material, dots.material] }
  }, [additive, theme, pixel, cubes])

  const shadows = useMemo(() => {
    const geometry = new THREE.InstancedBufferGeometry()
    const plane = new THREE.PlaneGeometry(SIZE * 1.9, SIZE * 1.9).rotateX(-Math.PI / 2).translate(0, FLOOR - 0.01, 0)
    geometry.index = plane.index
    geometry.setAttribute('position', plane.getAttribute('position'))
    geometry.setAttribute('uv', plane.getAttribute('uv'))
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3)
    attribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('aShadow', attribute)
    geometry.instanceCount = COUNT
    const material = new THREE.ShaderMaterial({ vertexShader: shadowVertex, fragmentShader: shadowFragment, uniforms: { uTheme: theme }, transparent: true, depthWrite: false })
    return { geometry, material, attribute }
  }, [theme])

  const frame = useRef<THREE.Group>(null)
  const yaw = useRef(SIM_YAW - 0.7)
  const clockIn = useRef(0)
  const invite = useRef(0)
  const scrolled = useRef(false)
  const sky = useRef({ aspect: 0, at: new Float32Array(CUBES * 3) })
  const keyLift = useRef(new Float32Array(COUNT))
  const keySpeed = useRef(new Float32Array(COUNT))
  const gl = useThree((state) => state.gl)

  useEffect(() => {
    const move = (event: PointerEvent) => {
      hero.pointerX = (event.clientX / window.innerWidth) * 2 - 1
      hero.pointerY = 1 - (event.clientY / window.innerHeight) * 2
      hero.pointerActive = true
    }
    const up = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') hero.pointerActive = false
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      geometry.dispose()
      cubes.dispose()
    }
  }, [geometry, cubes])

  useFrame(({ camera, clock, size }, delta) => {
    const dt = Math.min(delta, 1 / 30)
    const now = hero.still ? 3 : clock.elapsedTime
    const progress = hero.progress
    const aspect = size.width / size.height
    const dpr = gl.getPixelRatio()
    const struck = progress >= IMPACT
    const rawTime = simClock(progress)
    const simTime = struck ? clamp(rawTime, 0, SIM_END - 0.0001) : 0
    const sinceThud = rawTime - THUD

    // Load runs on its own clock, and hurries if the visitor scrolls during it.
    if (!hero.still) clockIn.current += dt
    const built = hero.still ? INTRO_TIME + 9 : Math.max(clockIn.current, INTRO_TIME * smooth(0, 0.09, progress))
    const done = built >= INTRO_TIME

    // The box spins while idle, and the cubes are identical, so any quarter turn can be
    // swapped for another: it only ever has a short way to go to match the sim's first frame.
    if (!hero.still && progress < 0.02) yaw.current += dt * 0.14
    if (hero.still) yaw.current = SIM_YAW
    else if (done && progress > 0) yaw.current = SIM_YAW + ((((yaw.current - SIM_YAW + Math.PI / 4) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) - Math.PI / 4
    const angle = lerp(yaw.current, SIM_YAW, smooth(0.02, 0.125, progress))
    boxQuat.setFromAxisAngle(UP, angle)
    const peek = hero.still ? 0 : hero.peek * (1 - smooth(0, 0.006, progress))

    // Camera, in three moves: a slow lean in, the kick, and the long pull out.
    const startFit = startDistance(aspect) * 1.1
    const endFit = (RIM_WIDTH * Math.cos(END_TURN) + RIM_DEPTH * Math.abs(Math.sin(END_TURN))) / ((aspect < 0.85 ? 0.82 : 0.5) * FOV_SCALE * aspect)
    const pullOut = 1 - Math.pow(1 - clamp((progress - IMPACT) / 0.34), 2.4)
    const lean = 1 - 0.1 * smooth(0.02, IMPACT, progress)
    const distance = Math.exp(lerp(Math.log(startFit * lean), Math.log(endFit), pullOut))
    const elevation = lerp(START_LOOK, END_LOOK, smooth(IMPACT + 0.04, 0.66, progress))
    const turn = END_TURN * smooth(IMPACT, 0.66, progress) + 0.05 * smooth(0.02, IMPACT, progress)
    const shift = smooth(IMPACT + 0.1, 0.6, progress)
    look.set(lerp(0, TRAY_X, shift), lerp(0, FLOOR + 0.55, shift), lerp(0, TRAY_Z, shift))

    const kickAge = struck ? rawTime : -1
    const kick = kickAge > 0 ? Math.exp(-kickAge * 6) * Math.sin(kickAge * 46) * 0.42 : 0
    const thudKick = sinceThud > 0 ? Math.exp(-sinceThud * 7) * Math.sin(sinceThud * 34) * 0.32 : 0
    const parallax = hero.pointerActive && !hero.still ? 1 : 0
    eye.set(Math.sin(turn) * Math.cos(elevation), Math.sin(elevation), Math.cos(turn) * Math.cos(elevation)).multiplyScalar(distance).add(look)
    eye.x += STRIKE_DIR[0] * kick + hero.pointerX * parallax * distance * 0.012
    eye.y += STRIKE_DIR[1] * kick * 0.6 + thudKick + hero.pointerY * parallax * distance * 0.008
    eye.z += STRIKE_DIR[2] * kick
    look.y += thudKick * 0.7 + 1.5 * smooth(0.18, 0.27, progress) * (1 - smooth(0.32, 0.5, progress))
    camera.position.copy(eye)
    camera.up.set(0, 1, 0)
    camera.lookAt(look)
    camera.rotateZ(kick * 0.05)
    camera.near = 0.5
    camera.far = 420
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    loneStar(aspect, lone)
    if (sky.current.aspect !== aspect) {
      sky.current.aspect = aspect
      for (let i = 0; i < CUBES; i++) sky.current.at.set(skyStar(i, aspect, spot), i * 3)
    }
    const skies = sky.current.at

    // Before the first scroll the star keeps leaning towards the box and drifting back,
    // and even a small scroll pulls it visibly closer.
    if (progress > 0.003) scrolled.current = true
    const idle = clockIn.current - INTRO_TIME - 3
    const pulse = idle > 0 && !scrolled.current && !hero.still ? Math.pow(Math.sin((idle / 6) * Math.PI), 2) : 0
    invite.current += (pulse * 0.022 - invite.current) * Math.min(1, dt * (scrolled.current ? 7 : 12))
    const pull = 1 - Math.pow(1 - clamp(progress / 0.03), 3)
    const flightU = clamp(invite.current + 0.09 * pull + 0.91 * Math.pow(clamp(progress / IMPACT), 2.6))
    const flightS = Math.pow(flightU, 1 / 2.6)

    const offsets = offset.array as Float32Array
    const quats = quat.array as Float32Array
    const states = state.array as Float32Array
    const shadow = shadows.attribute.array as Float32Array
    const lightAttribute = flight.geometry.getAttribute('aLight') as THREE.BufferAttribute
    const sizeAttribute = flight.geometry.getAttribute('aSize') as THREE.BufferAttribute
    const positionAttribute = flight.geometry.getAttribute('position') as THREE.BufferAttribute
    const dotAt = positionAttribute.array as Float32Array
    const dotSize = sizeAttribute.array as Float32Array
    const dotLight = lightAttribute.array as Float32Array
    const inFlight = !struck && built < INTRO_TIME + 0.1
    const place = (i: number) => {
      flightPose(pose.x, pose.y, pose.z, angle)
      point.lerp(view.set(skies[i * 3], skies[i * 3 + 1], skies[i * 3 + 2]), pose.sky)
    }

    const frameNumber = simTime * SIM_FPS
    const a = Math.floor(frameNumber)
    const k = frameNumber - a
    const end = progress > SETTLED - 0.09 ? smooth(SETTLED - 0.04, SETTLED + 0.06, progress) : 0

    for (let i = 0; i < COUNT; i++) {
      let scale = SIZE
      let heat = 0
      let hover = 0
      let settled = 0
      let x = 0
      let y = 0
      let z = 0
      let w = 1
      cubeQuat.identity()

      if (struck) {
        const ia = (a * COUNT + i) * 3
        const ib = ((a + 1) * COUNT + i) * 3
        x = lerp(positions[ia], positions[ib], k) * POSITION
        y = lerp(positions[ia + 1], positions[ib + 1], k) * POSITION
        z = lerp(positions[ia + 2], positions[ib + 2], k) * POSITION
        const ra = (a * COUNT + i) * 4
        const rb = ((a + 1) * COUNT + i) * 4
        const qx = lerp(rotations[ra], rotations[rb], k)
        const qy = lerp(rotations[ra + 1], rotations[rb + 1], k)
        const qz = lerp(rotations[ra + 2], rotations[rb + 2], k)
        w = lerp(rotations[ra + 3], rotations[rb + 3], k)
        const length = Math.hypot(qx, qy, qz, w)
        cubeQuat.set(qx / length, qy / length, qz / length, w / length)
        settled = smooth(BAKE.landed[i], BAKE.landed[i] + 0.35, rawTime)
        if (i < CUBES) heat = 0.9 * Math.exp(-rawTime * 4.8) * Math.exp(-Math.max(struckBy[i] - 0.5, 0) * 1.3)
        if (i === METEOR) heat = Math.max(Math.exp(-rawTime * 7), 0.5 * (1 - smooth(THUD - 0.05, THUD + 0.3, rawTime)))
      } else if (i < CUBES) {
        const u = introPose(i, built, pose)
        scale = pose.scale
        heat = pose.heat
        place(i)
        const out = 1 + peek * (0.025 + 0.015 * Math.sin(i * 2.4))
        x = point.x * out
        y = point.y * out
        z = point.z * out
        cubeQuat.set(pose.qx, pose.qy, pose.qz, pose.qw).premultiply(boxQuat)

        if (inFlight) {
          // Dies as the cube condenses out of it.
          const glow = u >= 1 ? 0 : 1 - smooth(0.84, 0.95, u)
          const grit = flight.grit
          const twinkle = 0.75 + 0.35 * Math.sin(now * (1 + grit[i * 4]) * 2 + grit[i * 4 + 1] * 9)
          const base = i * (1 + GHOSTS)
          dotAt[base * 3] = x
          dotAt[base * 3 + 1] = y
          dotAt[base * 3 + 2] = z
          dotSize[base] = (3 + grit[i * 4 + 2] * 3.2 + smooth(0, 0.25, u) * 7) * twinkle * glow
          dotLight[base] = glow > 0 ? 1 : 0
          for (let g = 1; g <= GHOSTS; g++) {
            const v = base + g
            const age = g / GHOSTS
            const trailing = introPose(i, built - g * STREAK_STEP, pose)
            place(i)
            const loose = (0.03 + pose.sky * 0.9) * age
            dotAt[v * 3] = point.x + (flight.grit[v * 4] - 0.5) * loose
            dotAt[v * 3 + 1] = point.y + (flight.grit[v * 4 + 1] - 0.5) * loose
            dotAt[v * 3 + 2] = point.z + (flight.grit[v * 4 + 2] - 0.5) * loose
            const on = trailing > 0 && trailing < 0.93 && u < 1 ? 1 : 0
            dotSize[v] = (2 + flight.grit[v * 4 + 3] * 3) * (1 - age * 0.5) * on
            dotLight[v] = (1 - age) * (0.35 + flight.grit[v * 4] * 0.65) * glow
          }
        }
      } else {
        meteorPoint(flightU, lone, head)
        x = head[0]
        y = head[1]
        z = head[2]
        scale = SIZE * smooth(0.42, 0.86, flightS)
        heat = 1
        const spin = (1 - flightS) * (1 - flightS) * 9
        cubeQuat.setFromAxisAngle(KNOCK_AXIS, spin).multiply(simQuat)
      }

      // The finished board: vertical rails only, so keys cannot touch.
      if (struck && end + clamp(sinceThud * 4) > 0) {
        const key = home[i]
        const swell = smooth(0.82, 1, Math.sin(key.x * 0.42 + key.z * 0.3 - now * 1.1)) * 0.11 * end
        let goal = hero.pressed.has(codes[i]) ? -0.28 : 0
        if (end > 0.9 && hero.pointerActive && !goal) {
          point.set(key.x, FLOOR + SIZE, key.z).project(camera)
          const near = Math.hypot((point.x - hero.pointerX) * aspect, point.y - hero.pointerY)
          goal = smooth(0.13, 0.03, near) * 0.85
        }
        const lift = keyLift.current
        const speed = keySpeed.current
        speed[i] += ((goal - lift[i]) * 190 - speed[i] * 15) * dt
        lift[i] += speed[i] * dt
        hover = clamp(lift[i] * 2.4)

        // The last cube lands, and the blow runs out through the board.
        const wave = sinceThud - reach[i] * 0.032
        const ripple = wave > 0 ? -0.34 * Math.exp(-wave * 5.5) * Math.sin(wave * 26) * (i === METEOR ? 0 : 1) : 0
        y += ripple + swell + lift[i]
      }

      offsets[i * 3] = x
      offsets[i * 3 + 1] = y
      offsets[i * 3 + 2] = z
      quats[i * 4] = cubeQuat.x
      quats[i * 4 + 1] = cubeQuat.y
      quats[i * 4 + 2] = cubeQuat.z
      quats[i * 4 + 3] = cubeQuat.w
      states[i * 4] = scale
      states[i * 4 + 1] = heat
      states[i * 4 + 2] = hover
      states[i * 4 + 3] = settled

      const height = y - FLOOR - SIZE / 2
      shadow[i * 3] = x
      shadow[i * 3 + 1] = z
      shadow[i * 3 + 2] = struck ? smooth(9, 0.2, height) * smooth(RIM_LAND - 0.3, RIM_LAND + 0.2, rawTime) : 0
    }

    offset.needsUpdate = true
    quat.needsUpdate = true
    state.needsUpdate = true
    shadows.attribute.needsUpdate = true
    flight.dots.visible = inFlight
    if (inFlight) {
      positionAttribute.needsUpdate = true
      sizeAttribute.needsUpdate = true
      lightAttribute.needsUpdate = true
    }

    // The frame: knocked loose, it wobbles, drops, and opens out into the tray rim.
    if (frame.current) {
      const age = struck ? Math.max(rawTime, 0) : 0
      const fall = clamp(age / RIM_LAND)
      const open = smooth(0.14, RIM_LAND, age)
      const loose = 1 - smooth(RIM_LAND * 0.6, RIM_LAND, age)
      const shove = age > 0 ? Math.exp(-age * 4) * Math.sin(age * 15) * 0.95 * loose : 0
      const landed = age - RIM_LAND
      const bounce = landed > 0 ? Math.abs(Math.sin(landed * 11)) * Math.exp(-landed * 7.5) * 0.3 : 0
      const blow = sinceThud > 0 ? -Math.exp(-sinceThud * 6) * Math.sin(sinceThud * 28) * 0.1 : 0

      frame.current.position.set(
        lerp(0, TRAY_X, open) + STRIKE_DIR[0] * shove,
        lerp(0, FLOOR + RIM_HEIGHT / 2, fall * fall) + STRIKE_DIR[1] * shove + bounce + blow,
        lerp(0, TRAY_Z, open) + STRIKE_DIR[2] * shove,
      )
      rimTilt.setFromAxisAngle(KNOCK_AXIS, age > 0 ? Math.exp(-age * 2.4) * Math.sin(age * 11) * 0.62 * loose : 0)
      frame.current.quaternion.copy(boxQuat).slerp(cubeQuat.identity(), open).premultiply(rimTilt)
      frame.current.scale.set(
        lerp(1, RIM_WIDTH / OUTLINE_SIZE, open),
        lerp(1, RIM_HEIGHT / OUTLINE_SIZE, open),
        lerp(1, RIM_DEPTH / OUTLINE_SIZE, open),
      )
    }

    // A very thin hot filament at the head. Everything behind it is the plume.
    meteorPoint(flightU, lone, head)
    meteorPoint(Math.max(flightU - 0.01, 0), lone, behind)
    const pace = Math.hypot(head[0] - behind[0], head[1] - behind[1], head[2] - behind[2]) * 100 + 0.001
    const retreat = struck ? 1 - smooth(0, 0.1, rawTime) : smooth(0.02, 0.2, flightS)
    const filament = (2.5 + 3.5 * flightS) * retreat
    const ribbon = trail.geometry.getAttribute('position').array as Float32Array
    for (let i = 0; i < TRAIL; i++) {
      const fraction = i / (TRAIL - 1)
      const u = Math.max(flightU - (filament * fraction * fraction) / pace, 0)
      meteorPoint(u, lone, head)
      meteorPoint(Math.max(u - 0.002, 0), lone, behind)
      point.set(head[0], head[1], head[2])
      along.set(head[0] - behind[0], head[1] - behind[1], head[2] - behind[2])
      side.copy(camera.position).sub(point)
      const onScreen = side.length() * 0.0016 // about two pixels, however close it gets
      side.cross(along).normalize().multiplyScalar(onScreen * Math.pow(1 - fraction, 1.6) * retreat + 0.0002)
      ribbon[i * 6] = point.x - side.x
      ribbon[i * 6 + 1] = point.y - side.y
      ribbon[i * 6 + 2] = point.z - side.z
      ribbon[i * 6 + 3] = point.x + side.x
      ribbon[i * 6 + 4] = point.y + side.y
      ribbon[i * 6 + 5] = point.z + side.z
    }
    trail.geometry.getAttribute('position').needsUpdate = true

    const handles = meteorHandles(lone)
    plumeUniforms.uA.value.set(...lone)
    plumeUniforms.uB.value.set(...handles.far)
    plumeUniforms.uC.value.set(...handles.near)
    plumeUniforms.uD.value.set(...STRIKE_START)
    plumeUniforms.uClock.value = flightS * FLIGHT_CLOCK + (struck ? rawTime : 0)

    // Small and tight. It is the cubes catching the light that sells how bright this is.
    meteorPoint(flightU, lone, head)
    const hit = struck ? rawTime : -1
    const breathe = 0.88 + 0.2 * Math.sin(now * 1.15)
    core.position.set(head[0], head[1], head[2])
    core.visible = hit < 0.09
    const coreSize = core.geometry.getAttribute('aSize') as THREE.BufferAttribute
    coreSize.setX(0, struck ? 26 * (1 - smooth(0, 0.09, hit)) : lerp(9, 22, smooth(0.4, 1, flightS)) * breathe)
    coreSize.needsUpdate = true

    // Arrives as inverse square, spikes for a few frames on contact, then decays and cools.
    const contact = struck ? Math.exp(-hit * 42) * 46 : 0
    const embers = struck ? Math.exp(-hit * 6.5) * 5 : 0
    const power = struck ? contact + embers : 22 * smooth(0.5, 0.95, flightS)
    const lightAt = cubes.uniforms.uLight.value as THREE.Vector3
    if (struck) lightAt.set(...STRIKE_START).addScaledVector(STRIKE, -0.3)
    else lightAt.set(head[0], head[1], head[2])
    cubes.uniforms.uPower.value = power
    cubes.uniforms.uHot.value = struck ? Math.exp(-hit * 4.5) : 1
    glint.group.visible = power > 0.01

    const blending = hero.theme > 0.5 ? THREE.NormalBlending : THREE.AdditiveBlending
    for (const material of [plume, sparkHit, sparkThud, trail.material, core.material as THREE.Material, flight.material, ...glint.materials]) material.blending = blending

    dustUniforms.uAge.value = struck ? rawTime + 0.001 : -1
    dustUniforms.uProject.value = size.height / FOV_SCALE

    impactSparks.uAge.value = struck ? rawTime + 0.001 : -1
    thudSparks.uAge.value = sinceThud > 0 ? sinceThud : -1

    const uniforms = cubes.uniforms
    uniforms.uFront.value = struck ? -0.6 + rawTime * 5.6 : -9
    uniforms.uLeak.value = (hero.still ? 1 : smooth(0, 3, built - INTRO_TIME - 0.2)) * (1 - smooth(0.01, 0.1, progress))
    view.copy(camera.position).normalize()
    ;(uniforms.uLeaks.value as THREE.Vector3[]).forEach((patch, n) => {
      patch.set(Math.sin(now * 0.47 + n * 2.1), Math.sin(now * 0.39 + n * 1.3) * 0.8, Math.cos(now * 0.43 + n * 4)).multiplyScalar(0.95).add(view).normalize()
    })
    uniforms.uSweep.value = lerp(-6, 6, smooth(0.72, 0.9, progress))

    theme.value = hero.theme
    time.value = now
    pixel.value = dpr
    starUniforms.uDim.value = lerp(1, 0.55, smooth(0.4, 0.8, progress))
  })

  return (
    <>
      <Stars uniforms={starUniforms} />
      <primitive object={flight.dots} />
      <mesh geometry={trail.geometry} material={trail.material} frustumCulled={false} />
      <mesh geometry={shadows.geometry} material={shadows.material} frustumCulled={false} />
      <instancedMesh args={[geometry, cubes, COUNT]} frustumCulled={false} />
      <Plume material={plume} />
      <Dust uniforms={dustUniforms} />
      <primitive object={core} />
      <Sparks material={sparkHit} count={SPARKS} speed={17} up={0.6} />
      <Sparks material={sparkThud} count={90} speed={7} up={1} />
      <group ref={frame} />
      <Frame follow={frame} pixel={pixel}>
        <primitive object={glint.group} />
      </Frame>
    </>
  )
}

