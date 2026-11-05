import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { CUBE_SIZE, ROWS, TINT, tiles } from '../layout'
import { Outline } from '../scene/Outline'

// The box is a mould. It drops onto the floor of its frame and chrome bleeds out of every seam,
// floods a tray, and the empty mould sinks under its own pool. Silence. Then the keyboard presses
// up from beneath the mirror and breaks the surface, and the chrome drains away from the cast.
//
// Nothing solid ever meets: the box and every key ride their own vertical rail, keys are narrower
// than their pitch, and no key exists until the box is fully below the deepest key.

const FLOOR = 0
const FRAME_Y = CUBE_SIZE * 0.58 // the frame stands on the floor, the box starts centred inside it
const BOX_REST = CUBE_SIZE / 2
const BOX_GONE = -3.1

const KEY = 0.6
const PITCH = 0.68
const KEY_DEEP = -0.9 // centre height while waiting under the pool, clear of the sunken box
const KEY_REST = KEY / 2
const TRAY_X = 7.5 * PITCH + 0.5
const TRAY_Z = 3 * PITCH + 0.5
const TRAY_HEIGHT = 1.1

const DRAG_SPEED = 0.006
const HOVER_RADIUS = 0.05

const THUD_START = 0.012
const THUD_END = 0.036
const POUR_START = 0.03
const POUR_END = 0.17
const FLOOD_START = 0.09
const FLOOD_END = 0.27
const SINK_START = 0.25
const SINK_END = 0.345
const RISE_START = 0.365
const RISE_LENGTH = 0.05
const DRAIN_START = 0.5
const DRAIN_END = 0.69
const CAMERA_END = 0.74

const FOV_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(14))
const DARK = new THREE.Color('#08090C')
const CREAM = new THREE.Color('#FFFCF0')

const keys = ROWS.flatMap((row, rowIndex) =>
  row.map((code, column) => {
    const x = (column - (row.length - 1) / 2) * PITCH
    const z = (rowIndex - (ROWS.length - 1) / 2) * PITCH
    return {
      code,
      x,
      z,
      column,
      row: rowIndex,
      reach: 0.5 * (Math.hypot(x, z * 1.9) + Math.max(Math.abs(x), Math.abs(z * 1.9))),
      tint: Math.abs(x * 0.55 - z) < PITCH * 0.85 ? TINT.cream : TINT.blue,
    }
  }),
)
const count = tiles.length + keys.length

const commonShader = /* glsl */ `
  uniform float uTime;
  uniform float uTheme;
  uniform vec3 uBlue;
  uniform vec3 uCream;

  // Repeated warping gives the slow, folding look of water.
  float liquid(vec3 p) {
    float t = uTime * 0.28;
    for (int i = 0; i < 4; i++) {
      p += 0.6 * sin(p.yzx * 1.7 + t + float(i) * 1.3);
    }
    return 0.5 + 0.5 * sin(p.x + p.y * 0.7 - p.z * 0.6);
  }

  // A jagged edge at two scales, the torn lip of the reference.
  float tear(vec3 p) {
    p += 0.35 * sin(p.yzx * 3.1 + 1.7);
    float a = abs(fract(p.x * 4.3 + p.z * 3.1 + p.y * 3.7) - 0.5);
    float b = abs(fract(p.x * 13.0 - p.z * 11.0 + p.y * 9.0) - 0.5);
    return a * 0.1 + b * 0.03;
  }

  // Chrome has no color of its own: it is a mirror of a room with a blue cove, black flags and
  // cream softboxes. The folds of the liquid decide which part of the room each pixel sees.
  vec3 chrome(vec3 r, float folds) {
    float v = r.y * 1.1 + r.x * 0.4 + folds * 1.15;
    float s = 0.5 + 0.5 * sin(v * 4.2);
    s = mix(s, 0.5 + 0.5 * sin(v * 9.5 + r.z * 2.0), 0.16);
    vec3 deep = mix(uBlue * 0.1, uBlue * 0.42, uTheme);
    vec3 c = mix(deep, uBlue, smoothstep(0.08, 0.5, s));
    c = mix(c, mix(uBlue, uCream, 0.32), smoothstep(0.6, 0.86, s));
    c = mix(c, uCream, smoothstep(0.88, 0.97, s));
    // Fine filaments of light, the caustics that sell it as liquid metal.
    float filament = pow(1.0 - abs(sin(v * 2.1 + r.z * 1.4)), 40.0);
    c += uCream * filament * 0.5;
    // The room falls away into blue below the horizon.
    return mix(c, c * uBlue * 1.6, smoothstep(0.1, -0.7, r.y) * 0.7);
  }

  float highlight(vec3 r) {
    return pow(max(dot(r, normalize(vec3(0.4, 0.8, 0.45))), 0.0), 120.0);
  }
`

const vertexShader = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec3 aSize;
  attribute vec4 aQuat;
  attribute vec3 aSurface; // chrome amount, tint, heat
  attribute float aHide;
  attribute float aMould; // 1 on the tiles of the box

  uniform float uRadius;

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vSurface;
  varying vec2 vTile;
  varying float vEdge;
  varying float vHide;
  varying float vMould;

  vec3 rotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  void main() {
    // Rebuild the rounded box at this piece's size, so the corners never stretch.
    float radius = min(uRadius, min(aSize.x, min(aSize.y, aSize.z)) * 0.5);
    vec3 local = sign(position) * (aSize * 0.5 - radius) + normal * radius;

    vec4 world = modelMatrix * vec4(rotate(aQuat, local) + aOffset, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * rotate(aQuat, normal));
    vSurface = aSurface;
    vTile = local.xz / aSize.xz * 2.0;
    vEdge = 1.0 - abs(normal.y);
    vHide = aHide;
    vMould = aMould;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uPour;
  uniform vec3 uBox;
  uniform vec3 uBg;

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vSurface;
  varying vec2 vTile;
  varying float vEdge;
  varying float vHide;
  varying float vMould;

  ${commonShader}

  // Dark studio with one wide softbox above and one strip on the side.
  float studio(vec3 r) {
    float top = smoothstep(0.35, 0.95, r.y);
    float strip = smoothstep(0.1, 0.0, abs(r.x - 0.55)) * smoothstep(-0.6, 0.3, r.y);
    return top * 0.9 + strip * 0.7;
  }

  void main() {
    if (vHide > 0.995 || vWorld.y < 0.0) discard; // nothing shows below the floor

    vec3 view = normalize(cameraPosition - vWorld);
    vec3 geometric = normalize(vNormal);
    float scale = mix(0.5, 1.15, step(vMould, 0.5));
    vec3 q = vWorld * scale;
    float field = liquid(q);
    vec2 slope = vec2(liquid(q + vec3(0.05, 0.0, 0.0)), liquid(q + vec3(0.0, 0.05, 0.0))) - field;

    float amount = vSurface.x;
    float tint = vSurface.y;
    float heat = clamp(vSurface.z, 0.0, 1.0);
    float pearl = smoothstep(1.5, 2.0, tint);
    float grow = max(amount, heat * 0.96);

    float mask;
    float rim;
    float roll = 0.0;
    vec3 rollDirection = vec3(0.0);

    if (vMould > 0.5) {
      // The pour starts at the top corner and runs over the faces under gravity, in fingers.
      vec3 local = vWorld - uBox;
      vec3 source = vec3(-1.5, 1.5, 1.5);
      vec3 away = local - source;
      float along = local.x + local.z * 0.8;
      float fingers = 0.09 * sin(along * 3.1 + 0.6) + 0.05 * sin(along * 7.3 + 2.0) + 0.03 * sin(along * 15.0);
      fingers *= smoothstep(1.5, 0.2, local.y);
      float distance = length(away * vec3(1.0, 0.9, 1.0)) / 5.6 + fingers;

      // Seams lead: the liquid is already in the gaps before it wells over the tiles.
      float tile = max(abs(vTile.x), abs(vTile.y));
      float seam = smoothstep(0.82, 0.99, tile);
      float front = uPour * 1.75 - distance + seam * 0.16 * smoothstep(0.0, 0.25, uPour) - 0.03;
      front -= (1.0 - smoothstep(0.75, 1.0, uPour)) * (tear(local * 0.8) * 0.8 + field * 0.08);
      float poured = smoothstep(0.0, 0.012, front);

      // Idle: the wandering leak of the closed box.
      float idle = smoothstep(0.0, 0.14, grow * 1.14 - field * (1.0 - grow));

      mask = max(poured, idle);
      // Only the pour has a thick lip, which bends the reflection and catches light.
      float lip = 1.0 - smoothstep(0.0, 0.2, front);
      roll = lip * poured;
      rollDirection = normalize(away);
      rim = max(poured * (1.0 - smoothstep(0.0, 0.022, front)), smoothstep(0.0, 0.1, idle) * (1.0 - smoothstep(0.1, 0.65, idle)));
    } else {
      // The chrome tears away from each key as it sets, and flashes back when it is reheated.
      float torn = grow * 1.2 - (field * 0.72 + tear(vWorld * 2.4) * 2.0) * (1.0 - grow);
      mask = smoothstep(0.0, 0.05, torn);
      rim = smoothstep(0.0, 0.05, torn) * (1.0 - smoothstep(0.05, 0.24, torn)) * (1.0 - step(0.999, grow));
    }

    vec3 flow = vec3(slope.x, slope.y, slope.x - slope.y) * mix(2.6, 1.4, step(vMould, 0.5));
    vec3 normal = normalize(geometric + (flow - rollDirection * roll * 0.9) * mask);
    vec3 reflected = reflect(-view, normal);
    float facing = max(dot(geometric, view), 0.0);
    float fresnel = pow(1.0 - facing, 3.5);

    // Black gloss: the surface the box starts with.
    vec3 rippled = normalize(geometric + vec3(slope * 0.9, 0.0));
    float light = studio(reflect(-view, rippled));
    float sheen = smoothstep(0.3, 0.75, field);
    vec3 gloss = vec3(0.005, 0.006, 0.01) + mix(uBlue, uCream, 0.35) * light * sheen * mix(0.09, 0.045, uTheme);
    gloss += fresnel * mix(uBlue * 0.34, uCream * 0.16, uTheme);
    gloss += mix(uBlue, uCream, pearl) * smoothstep(0.5, 1.0, vEdge) * 0.16;

    // Set: the finished cube, plain brand color lit like an object, no chrome left in it.
    vec3 solid = mix(uBlue, uCream, pearl);
    float lit = 0.62 + 0.38 * smoothstep(0.1, 0.95, geometric.y);
    solid *= lit;
    solid = mix(solid, uBlue, pearl * uTheme * 0.5 * (1.0 - smoothstep(0.1, 0.95, geometric.y)));
    // Still a polished casting: a slow glint crosses the lacquer.
    solid += uCream * pow(field, 7.0) * 0.09 * smoothstep(0.3, 0.9, geometric.y);
    solid += uBlue * fresnel * 0.12;
    vec3 base = mix(solid, gloss, vMould);

    vec3 surface = chrome(reflected, field * 1.1);
    surface *= mix(0.22, 1.0, smoothstep(0.0, 0.3, max(uPour, amount)) * step(0.5, vMould) + step(vMould, 0.5));
    surface += uCream * fresnel * 0.35;

    vec3 color = mix(base, surface, mask);
    color += uCream * rim * 0.8;
    color += uCream * highlight(reflected) * (0.3 + mask * 0.8);

    gl_FragColor = vec4(mix(color, uBg, vHide), 1.0);
    #include <colorspace_fragment>
  }
`

const poolVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const poolFragment = /* glsl */ `
  uniform float uFlood; // how far the pool has spread from the foot of the box
  uniform float uDrain; // how far the hole has opened from the middle
  uniform float uCalm; // 1 = dead flat mirror
  uniform float uRing; // age of the ripple left by the sinking box, 0 before it
  uniform float uBoxTop;
  uniform vec2 uTray;
  uniform sampler2D uKeys; // height of the top of every key
  uniform float uRows[6];

  varying vec3 vWorld;

  ${commonShader}

  const float PITCH = ${PITCH.toFixed(3)};
  const float HALF = ${(KEY / 2).toFixed(3)};

  // The drain and the setting of the keys share this measure, so they stay in step.
  float reach(vec2 p) {
    vec2 q = abs(p) * vec2(1.0, 1.9);
    return 0.5 * (length(q) + max(q.x, q.y));
  }

  float keyTop(vec2 p, out float inside) {
    float row = clamp(floor(p.y / PITCH + 3.0), 0.0, 5.0);
    float middle = uRows[int(row)];
    float column = floor(p.x / PITCH + middle + 0.5);
    inside = 9.0;
    if (column < 0.0 || column > middle * 2.0) return -1.0;
    vec2 local = p - vec2((column - middle) * PITCH, (row - 2.5) * PITCH);
    vec2 away = abs(local) - HALF;
    inside = length(max(away, 0.0)) + min(max(away.x, away.y), 0.0);
    return texelFetch(uKeys, ivec2(int(column), int(row)), 0).r;
  }

  // Liquid height. The keys are under this skin: first they push it up, then they come through it.
  float height(vec2 p) {
    float h = (1.0 - uCalm) * liquid(vec3(p.x, 0.0, p.y) * 0.5) * 0.32;
    float r = length(p);
    if (uRing > 0.0) {
      float wave = r - uRing * 9.0;
      h += sin(wave * 5.0) * exp(-wave * wave * 1.1) * 0.07 * exp(-uRing * 1.4);
    }
    float inside;
    float top = keyTop(p, inside);
    if (top > -0.9) {
      float push = smoothstep(-0.62, -0.04, top);
      h += push * (1.0 - smoothstep(-0.05, 0.16, inside)) * 0.17;
    }
    return h;
  }

  void main() {
    vec2 p = vWorld.xz;

    // Spreads from the foot of the box, in slow lobes with a torn lip.
    vec2 foot = abs(p) - 1.5;
    float boxDistance = length(max(foot, 0.0));
    float lobes = liquid(vec3(p.x * 0.35, 0.4, p.y * 0.35)) * 1.5;
    vec3 worn = vec3(p.x, 0.0, p.y) * 0.8;
    float flood = uFlood * 12.5 - boxDistance * (1.0 + lobes * 0.45) - tear(worn) * 1.2;

    // The hole left by the drain opens from the middle, with the same torn lip.
    float drain = reach(p) + lobes * 0.5 + tear(worn) * 1.2 - uDrain * 13.0 + 0.8;

    vec2 walls = abs(p) - uTray;
    float wall = -max(walls.x, walls.y);
    float edge = min(min(flood, drain), wall);
    float alpha = smoothstep(0.0, 0.025, edge);
    if (alpha < 0.01) discard;

    float e = 0.04;
    float h = height(p);
    vec3 normal = normalize(vec3(height(p - vec2(e, 0.0)) - height(p + vec2(e, 0.0)), 2.0 * e, height(p - vec2(0.0, e)) - height(p + vec2(0.0, e))));

    // The thick lip of the liquid rolls down to the floor at any open edge.
    float lip = 1.0 - smoothstep(0.0, 0.42, min(flood, drain));
    vec2 outward = normalize(p + 0.001) * (flood < drain ? 1.0 : -1.0);
    normal = normalize(normal + vec3(outward.x, 0.0, outward.y) * lip * lip * 0.7);

    vec3 view = normalize(cameraPosition - vWorld);
    vec3 reflected = reflect(-view, normal);
    vec3 color = chrome(reflected, h * 2.4 + (1.0 - uCalm) * 0.3 + p.x * 0.015);

    // What is above the mirror shows in it: the sinking box, and the keys when they arrive.
    vec3 ray = normalize(vec3(reflected.x, max(reflected.y, 0.05), reflected.z));
    vec3 invert = 1.0 / ray;
    vec3 near = (vec3(-1.5, -9.0, -1.5) - vWorld) * invert;
    vec3 far = (vec3(1.5, uBoxTop, 1.5) - vWorld) * invert;
    vec3 small = min(near, far);
    vec3 big = max(near, far);
    float enter = max(small.x, max(small.y, small.z));
    float leave = min(big.x, min(big.y, big.z));
    if (uBoxTop > 0.0 && leave > max(enter, 0.0)) {
      vec3 hit = vWorld + ray * enter;
      color = mix(color, chrome(vec3(-ray.x, ray.y, ray.z), hit.y * 0.6 + hit.x * 0.2 + h) * vec3(0.4, 0.58, 0.95), 0.55);
    }

    float span = ${(KEY + 0.25).toFixed(2)} / ray.y;
    for (int i = 1; i <= 7; i++) {
      float along = span * float(i) / 7.0;
      vec3 q = vWorld + ray * along;
      float inside;
      float top = keyTop(q.xz, inside);
      if (inside < 0.0 && q.y < top) {
        color = mix(color, chrome(vec3(-ray.x, ray.y, ray.z), q.y * 1.4 + q.x * 0.08) * vec3(0.35, 0.5, 0.9), 0.8);
        break;
      }
    }

    float rim = 1.0 - smoothstep(0.0, 0.05, edge);
    color += uCream * rim * 0.9;
    color += uCream * highlight(reflected) * 0.9;

    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`

const heroQuat = new THREE.Quaternion()
const tileQuat = new THREE.Quaternion()
const point = new THREE.Vector3()
const target = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const color = new THREE.Color()

export function Scene() {
  const { geometry, offset, surface, hide } = useMemo(() => {
    const geometry = new RoundedBoxGeometry(1, 1, 1, 3, 0.2)
    const attribute = (name: string, itemSize: number) => {
      const buffer = new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize)
      geometry.setAttribute(name, buffer)
      return buffer
    }
    const offset = attribute('aOffset', 3)
    const surface = attribute('aSurface', 3)
    const hide = attribute('aHide', 1)
    const sizes = attribute('aSize', 3)
    const quats = attribute('aQuat', 4)
    const mould = attribute('aMould', 1)
    tiles.forEach((tile, i) => {
      sizes.setXYZ(i, tile.size.x, tile.size.y, tile.size.z)
      quats.setXYZW(i, tile.quaternion.x, tile.quaternion.y, tile.quaternion.z, tile.quaternion.w)
      mould.setX(i, 1)
    })
    keys.forEach((_, k) => {
      const i = tiles.length + k
      sizes.setXYZ(i, KEY, KEY, KEY)
      quats.setXYZW(i, 0, 0, 0, 1)
    })
    offset.setUsage(THREE.DynamicDrawUsage)
    surface.setUsage(THREE.DynamicDrawUsage)
    hide.setUsage(THREE.DynamicDrawUsage)
    return { geometry, offset, surface, hide }
  }, [])

  const heights = useMemo(() => {
    const texture = new THREE.DataTexture(new Float32Array(16 * 6), 16, 6, THREE.RedFormat, THREE.FloatType)
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    return texture
  }, [])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uTime: { value: 0 },
          uTheme: { value: 0 },
          uPour: { value: 0 },
          uBox: { value: new THREE.Vector3() },
          uBg: { value: DARK.clone() },
          uRadius: { value: 0.055 },
          uBlue: { value: new THREE.Color('#1C70EC') },
          uCream: { value: CREAM.clone() },
        },
      }),
    [],
  )
  const pool = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: poolVertex,
        fragmentShader: poolFragment,
        transparent: true,
        uniforms: {
          uTime: { value: 0 },
          uTheme: { value: 0 },
          uFlood: { value: 0 },
          uDrain: { value: 0 },
          uCalm: { value: 0 },
          uRing: { value: 0 },
          uBoxTop: { value: 3 },
          uTray: { value: new THREE.Vector2() },
          uKeys: { value: heights },
          uRows: { value: ROWS.map((row) => (row.length - 1) / 2) },
          uBlue: { value: new THREE.Color('#1C70EC') },
          uCream: { value: CREAM.clone() },
        },
      }),
    [heights],
  )
  const frame = useRef<THREE.Group>(null)
  const surfaceMesh = useRef<THREE.Mesh>(null)
  const gl = useThree((state) => state.gl)

  const yaw = useRef(0.68)
  const spin = useRef(0)
  // Spring state: one per key for the bounce, one per key for the heat, one per tile of the box.
  const keyHover = useRef(new Float32Array(keys.length))
  const keyVelocity = useRef(new Float32Array(keys.length))
  const keyHeat = useRef(new Float32Array(keys.length))
  const tileHover = useRef(new Float32Array(tiles.length))
  const tileVelocity = useRef(new Float32Array(tiles.length))

  useEffect(() => {
    const canvas = gl.domElement
    let dragging = false
    let lastX = 0
    const move = (event: PointerEvent) => {
      hero.pointerX = (event.clientX / window.innerWidth) * 2 - 1
      hero.pointerY = 1 - (event.clientY / window.innerHeight) * 2
      hero.pointerActive = true
      if (dragging) {
        spin.current = (event.clientX - lastX) * DRAG_SPEED
        yaw.current += spin.current
        lastX = event.clientX
      }
    }
    const down = (event: PointerEvent) => {
      move(event)
      dragging = true
      lastX = event.clientX
    }
    const up = (event: PointerEvent) => {
      dragging = false
      if (event.pointerType !== 'mouse') hero.pointerActive = false
    }
    canvas.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      geometry.dispose()
      material.dispose()
      pool.dispose()
      heights.dispose()
    }
  }, [gl, geometry, material, pool, heights])

  useFrame(({ camera, clock, size }, delta) => {
    const dt = Math.min(delta, 1 / 30)
    const time = hero.still ? 3 : clock.elapsedTime
    const { progress, intro } = hero
    const aspect = size.width / size.height
    const scrolling = smooth(0, 0.004, progress)
    const peek = hero.peek * (1 - scrolling) // the box only breathes before the scroll begins

    // The box turns freely until the scroll, then squares up to its tray while the camera
    // orbits the other way, so it keeps showing a corner to the viewer.
    if (!hero.still && progress < 0.002) yaw.current += dt * 0.14
    if (progress < 0.002) yaw.current += spin.current * dt * 30
    spin.current *= Math.pow(0.03, dt)
    if (progress < 0.002) yaw.current = Math.atan2(Math.sin(yaw.current), Math.cos(yaw.current))
    const square = Math.round(yaw.current / (Math.PI / 2)) * (Math.PI / 2)
    const squared = smooth(0, 0.09, progress)
    const angle = lerp(yaw.current, square, squared)
    heroQuat.setFromAxisAngle(UP, angle)

    // Drops the last of its height under gravity onto the floor of the frame: that opens the seams.
    const thud = clamp((progress - THUD_START) / (THUD_END - THUD_START))
    const sink = clamp((progress - SINK_START) / (SINK_END - SINK_START))
    const boxY = FRAME_Y + (BOX_REST - FRAME_Y) * thud * thud + (BOX_GONE - BOX_REST) * sink * sink * (3 - 2 * sink) * lerp(sink, 1, 0.35)
    const impact = progress > THUD_END ? Math.exp(-(progress - THUD_END) * 150) * Math.sin((progress - THUD_END) * 300) : 0

    const pour = clamp((progress - POUR_START) / (POUR_END - POUR_START))
    const flood = smooth(FLOOD_START, FLOOD_END, progress)
    const drain = smooth(DRAIN_START, DRAIN_END, progress)

    // Each key rises on its rail from the middle out, and sets as the drain passes it.
    const rise = (k: number) => {
      const t = clamp((progress - RISE_START - keys[k].reach * 0.0075) / RISE_LENGTH)
      const eased = 1 - Math.pow(1 - t, 3)
      return lerp(KEY_DEEP, KEY_REST, eased + Math.sin(t * Math.PI) * 0.06 * t)
    }
    const settled = (k: number) => clamp((drain * 13 - 0.8 - keys[k].reach) / 2.2)

    // Camera: starts on the box like the other concepts, ends high above a small board.
    const fitStart = Math.max(14, 5.4 / (0.74 * FOV_SCALE * Math.min(aspect, 1)))
    const fitEnd = Math.max((TRAY_X * 2.4) / ((aspect < 0.85 ? 0.92 : 0.46) * FOV_SCALE * aspect), 30)
    const travel = smooth(0.07, CAMERA_END, progress)
    // The frame is the tray: it opens ahead of the liquid and walls it in, and the camera keeps it all in shot.
    const openX = lerp(FRAME_Y, TRAY_X, smooth(0.06, 0.2, progress))
    const openZ = lerp(FRAME_Y, TRAY_Z, smooth(0.06, 0.2, progress))
    const fitTray = (openX * 2.5) / (0.92 * FOV_SCALE * aspect)
    const distance = Math.max(Math.exp(lerp(Math.log(fitStart), Math.log(fitEnd), travel)), fitTray)
    const look = lerp(0.52, 1.22, smooth(0.06, CAMERA_END, progress))
    const orbit = lerp(0, -0.62, squared) * (1 - smooth(0.2, 0.5, progress))
    const shake = hero.still ? 0 : impact * 0.1
    target.set(0, lerp(FRAME_Y, 0, smooth(0.1, 0.5, progress)) + shake, 0)
    const flat = Math.cos(look) * distance
    camera.position.set(
      target.x + Math.sin(orbit) * flat + (hero.pointerX * travel * distance) / 70,
      target.y + Math.sin(look) * distance,
      target.z + Math.cos(orbit) * flat,
    )
    camera.lookAt(target)
    camera.near = 1
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    leakAt.set(Math.sin(time * 0.31), Math.sin(time * 0.23 + 1) * 0.8, Math.cos(time * 0.27)).normalize()

    const project = (x: number, y: number, z: number) => {
      point.set(x, y, z).project(camera)
      return Math.hypot((point.x - hero.pointerX) * aspect, point.y - hero.pointerY)
    }
    const spring = (value: Float32Array, velocity: Float32Array, i: number, goal: number) => {
      velocity[i] += ((goal - value[i]) * 190 - velocity[i] * 15) * dt
      value[i] += velocity[i] * dt
    }

    const offsets = offset.array as Float32Array
    const surfaces = surface.array as Float32Array
    const hides = hide.array as Float32Array
    const quats = geometry.getAttribute('aQuat') as THREE.InstancedBufferAttribute
    const keyTops = heights.image.data as Float32Array

    // The mould: the same tile box as every other concept.
    const boxHidden = sink >= 1 ? 1 : 1 - smooth(0, 0.5, intro)
    tiles.forEach((tile, t) => {
      const lift = (1 - smooth(0, 1, intro * 1.7 - t * 0.007)) * 7
      const near = progress < 0.02 && hero.pointerActive
      point.copy(tile.position).applyQuaternion(heroQuat)
      const facing = point.dot(camera.position) > 0
      const hoverGoal = near && facing ? smooth(0.22, 0.07, project(point.x, boxY + point.y, point.z)) : 0
      spring(tileHover.current, tileVelocity.current, t, hoverGoal)
      const h = tileHover.current[t]
      const out = lift + peek * (0.4 + 0.2 * Math.sin(t * 2.4)) + h * 0.5

      point.copy(tile.position).addScaledVector(tile.normal, out).applyQuaternion(heroQuat)
      offsets[t * 3] = point.x
      offsets[t * 3 + 1] = boxY + point.y
      offsets[t * 3 + 2] = point.z
      tileQuat.copy(heroQuat).multiply(tile.quaternion)
      quats.setXYZW(t, tileQuat.x, tileQuat.y, tileQuat.z, tileQuat.w)

      const toward = point.copy(tile.position).normalize().applyQuaternion(heroQuat).dot(leakAt)
      surfaces[t * 3] = smooth(0.55, 0.98, toward + peek * 0.3) * 0.9 * (1 - smooth(0, 0.05, progress))
      surfaces[t * 3 + 1] = TINT.blue
      surfaces[t * 3 + 2] = h
      hides[t] = boxHidden
    })

    // The keys exist only once the box is below every one of them.
    keys.forEach((key, k) => {
      const i = tiles.length + k
      const pressed = hero.pressed.has(key.code)
      let goal = pressed ? -0.14 : 0
      if (hero.pointerActive && progress > DRAIN_END && !goal) {
        goal = smooth(HOVER_RADIUS, HOVER_RADIUS * 0.3, project(key.x, 0.4, key.z)) * 0.32
      }
      spring(keyHover.current, keyVelocity.current, k, goal)
      const heatGoal = goal === 0 ? 0 : 1
      keyHeat.current[k] += (heatGoal - keyHeat.current[k]) * (1 - Math.pow(0.0015, dt))

      const y = rise(k) + keyHover.current[k]
      offsets[i * 3] = key.x
      offsets[i * 3 + 1] = y
      offsets[i * 3 + 2] = key.z
      surfaces[i * 3] = 1 - settled(k)
      surfaces[i * 3 + 1] = key.tint
      surfaces[i * 3 + 2] = keyHeat.current[k]
      hides[i] = sink >= 1 ? 0 : 1
      keyTops[key.row * 16 + key.column] = sink >= 1 ? y + KEY / 2 : -1
    })

    offset.needsUpdate = true
    surface.needsUpdate = true
    hide.needsUpdate = true
    quats.needsUpdate = true
    heights.needsUpdate = true

    const openY = lerp(FRAME_Y, TRAY_HEIGHT / 2, smooth(0.3, 0.42, progress))
    if (frame.current) {
      frame.current.position.set(0, openY + impact * 0.03, 0)
      frame.current.quaternion.copy(heroQuat)
      // The frame turned with the box, so a quarter turn swaps which of its sides is the long one.
      const turned = Math.abs(Math.round(square / (Math.PI / 2))) % 2 === 1
      frame.current.scale.set((turned ? openZ : openX) / FRAME_Y, openY / FRAME_Y, (turned ? openX : openZ) / FRAME_Y)
    }

    if (surfaceMesh.current) surfaceMesh.current.visible = flood > 0 && drain < 1

    const uniforms = material.uniforms
    uniforms.uTime.value = time
    uniforms.uTheme.value = hero.theme
    uniforms.uPour.value = pour
    uniforms.uBox.value.set(0, boxY, 0)
    uniforms.uBg.value.copy(color.lerpColors(DARK, CREAM, hero.theme))

    const poolUniforms = pool.uniforms
    poolUniforms.uTime.value = time
    poolUniforms.uTheme.value = hero.theme
    poolUniforms.uFlood.value = flood
    poolUniforms.uDrain.value = drain
    poolUniforms.uCalm.value = smooth(SINK_END - 0.03, RISE_START, progress) * (1 - smooth(DRAIN_START - 0.04, DRAIN_START + 0.04, progress) * 0.7)
    poolUniforms.uRing.value = sink > 0.9 ? (progress - SINK_START - (SINK_END - SINK_START) * 0.9) * 22 : 0
    poolUniforms.uBoxTop.value = sink >= 1 ? -1 : boxY + CUBE_SIZE / 2
    poolUniforms.uTray.value.set(openX - 0.02, openZ - 0.02)
  })

  return (
    <>
      <instancedMesh args={[geometry, material, count]} frustumCulled={false} />
      <mesh ref={surfaceMesh} rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR, 0]} renderOrder={-1} frustumCulled={false}>
        <planeGeometry args={[80, 80]} />
        <primitive object={pool} attach="material" />
      </mesh>
      <group ref={frame} />
      <Outline follow={frame} morph={false} />
    </>
  )
}
