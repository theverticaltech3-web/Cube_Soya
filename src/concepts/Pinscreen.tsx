import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { CUBE_SIZE, ROWS, TINT } from '../layout'
import { Outline } from '../scene/Outline'

// The background was the object all along. Every tile of the box is the end of one square pin
// in an enormous pin-art wall, painted the color of the page until the box lands and a wave shows it.
// Each pin owns one grid cell and only ever changes its height, so no two can touch: only the
// wall as a whole turns, and only while it is still invisible.

const PITCH = CUBE_SIZE / 4 // one pin is exactly one tile of the box
const PIN_WIDTH = PITCH - 0.024
const PIN_LENGTH = CUBE_SIZE
const NX = 104
const NZ = 100
const WALL_Y = -1.8 // just under the outline, so the frame floats clear of the hidden wall
const BOX_RAISE = CUBE_SIZE / 2 - WALL_Y
const KEY_RAISE = PITCH // a key shows exactly one cube above the wall
const DRAG_SPEED = 0.006

const IMPACT = 0.13 // the box bottoms out
const WAVE_SPEED = 170 // world units per unit of progress
const DRAIN = 0.6 // the wall goes back to being the background
const DRAIN_SPEED = 280
const SETTLE_END = 0.44

const FOV_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(14))
const DARK = new THREE.Color('#08090C')
const CREAM = new THREE.Color('#FFFCF0')

const count = NX * NZ
const pinX = (column: number) => (column - NX / 2 + 0.5) * PITCH
const pinZ = (row: number) => (row - NZ / 2 + 0.5) * PITCH

// The keyboard sits in the same grid, one empty cell between keys, away from the box.
const BOARD_COLUMN = NX / 2 + 12
const BOARD_ROW = NZ / 2 - 11
const boardX = pinX(BOARD_COLUMN)
const boardZ = pinZ(BOARD_ROW)
const BOARD_WIDTH = 30 * PITCH
const BOARD_DEPTH = 12 * PITCH

const keys = ROWS.flatMap((row, rowIndex) =>
  row.map((code, column) => {
    const gridX = BOARD_COLUMN + 2 * column - row.length + 1
    const gridZ = BOARD_ROW + 2 * rowIndex - (ROWS.length - 1)
    const x = pinX(gridX) - boardX
    const z = pinZ(gridZ) - boardZ
    return { code, pin: gridZ * NX + gridX, tint: Math.abs(x * 0.55 - z) < 2 ? TINT.cream : TINT.blue }
  }),
)

const px = new Float32Array(count)
const pz = new Float32Array(count)
const fromBox = new Float32Array(count)
const fromBoard = new Float32Array(count)
const edge = new Float32Array(count)
const keyOf = new Int16Array(count).fill(-1)
const isBox = new Uint8Array(count)
for (let i = 0; i < count; i++) {
  const x = pinX(i % NX)
  const z = pinZ(Math.floor(i / NX))
  px[i] = x
  pz[i] = z
  fromBox[i] = Math.hypot(x, z)
  fromBoard[i] = Math.hypot(x - boardX, z - boardZ)
  edge[i] = smooth(0.82, 1, Math.max(Math.abs(x) / pinX(NX - 1), Math.abs(z) / pinZ(NZ - 1)))
  isBox[i] = Math.max(Math.abs(x), Math.abs(z)) < CUBE_SIZE / 2 ? 1 : 0
}
keys.forEach((key, k) => (keyOf[key.pin] = k))

// Heavy at the front, then ringing out behind it.
const wave = (s: number, size: number) => {
  if (s < -7) return 0
  if (s < 0) return size * Math.exp(-(s * s) / 5)
  return size * Math.exp(-s * 0.13) * Math.cos(s * 0.72)
}

const vertexShader = /* glsl */ `
  attribute vec2 aCell;
  attribute float aHeight;
  attribute vec3 aSurface; // liquid amount, tint, hover
  attribute vec2 aState; // fades into the background, reads as wall rather than box

  uniform vec3 uSize;
  uniform float uRadius;

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vSurface;
  varying vec2 vState;
  varying vec2 vCell;
  varying float vRod;
  varying float vTop;

  void main() {
    vec3 local = sign(position) * (uSize * 0.5 - uRadius) + normal * uRadius;
    vec3 placed = local + vec3(aCell.x, aHeight - uSize.y * 0.5, aCell.y);
    vec4 world = modelMatrix * vec4(placed, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vSurface = aSurface;
    vState = aState;
    vCell = aCell;
    vRod = uSize.y * 0.5 - local.y;
    vTop = normal.y;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uTheme;
  uniform float uScale;
  uniform float uPitch;
  uniform vec3 uBg;
  uniform vec3 uBlue;
  uniform vec3 uCream;
  uniform vec4 uLeak; // direction in box space, strength

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vSurface;
  varying vec2 vState;
  varying vec2 vCell;
  varying float vRod;
  varying float vTop;

  float liquid(vec3 p) {
    float t = uTime * 0.28;
    for (int i = 0; i < 4; i++) {
      p += 0.6 * sin(p.yzx * 1.7 + t + float(i) * 1.3);
    }
    return 0.5 + 0.5 * sin(p.x + p.y * 0.7 - p.z * 0.6);
  }

  float studio(vec3 r) {
    float top = smoothstep(0.35, 0.95, r.y);
    float strip = smoothstep(0.1, 0.0, abs(r.x - 0.55)) * smoothstep(-0.6, 0.3, r.y);
    return top * 0.9 + strip * 0.7;
  }

  void main() {
    vec3 color = uBg;

    // A hidden pin is just the page, which keeps the whole-screen wall cheap.
    if (vState.x < 0.995) {
      vec3 view = normalize(cameraPosition - vWorld);
      vec3 geometric = normalize(vNormal);

      float amount = vSurface.x;
      float tint = vSurface.y;
      float hover = clamp(vSurface.z, 0.0, 1.0);

      // The liquid leak on the box, one tile at a time.
      if (uLeak.w > 0.0 && max(abs(vCell.x), abs(vCell.y)) < 1.5) {
        float row = floor(vRod / uPitch);
        float height = vTop > 0.5 ? 1.5 : 1.5 - (row + 0.5) * uPitch;
        amount = max(amount, smoothstep(0.55, 0.98, dot(normalize(vec3(vCell.x, height, vCell.y)), uLeak.xyz)) * 0.9 * uLeak.w);
      }

      float field = 0.5 + 0.5 * sin(vWorld.x * 0.31 + vWorld.z * 0.23 + uTime * 0.4);
      vec2 slope = vec2(0.0);
      if (amount > 0.0005 || hover > 0.001) {
        vec3 q = vWorld * uScale;
        field = liquid(q);
        slope = vec2(liquid(q + vec3(0.06, 0.0, 0.0)), liquid(q + vec3(0.0, 0.06, 0.0))) - field;
      }

      float grow = max(amount, hover * 0.92);
      float mask = smoothstep(0.0, 0.14, grow * 1.14 - field * (1.0 - grow));
      float rim = smoothstep(0.0, 0.1, mask) * (1.0 - smoothstep(0.1, 0.65, mask));

      vec3 normal = normalize(geometric + vec3(slope * 2.6, 0.0) * mask);
      vec3 reflected = reflect(-view, normal);
      float facing = max(dot(geometric, view), 0.0);
      float fresnel = pow(1.0 - facing, 3.5);
      float pearl = smoothstep(1.5, 2.0, tint) * (1.0 - uTheme * 0.65); // cream keys must not melt into a cream page

      // The stacked cubes of a pin: a seam every pitch along its length, and around its top.
      float along = abs(fract(vRod / uPitch + 0.5) - 0.5) * uPitch;
      float seam = (1.0 - smoothstep(0.008, 0.02, along)) * smoothstep(0.03, 0.05, vRod);
      float lip = smoothstep(0.5, 1.0, 1.0 - abs(vTop)) * (1.0 - smoothstep(0.0, 0.06, vRod));
      seam = max(seam, lip) * mix(1.0, 0.4, smoothstep(0.03, 0.08, length(fwidth(vWorld.xz)))); // no shimmer when the grid gets small

      vec3 rippled = normalize(geometric + vec3(slope * 0.9, 0.0));
      float light = studio(reflect(-view, rippled));
      float sheen = smoothstep(0.3, 0.75, field);
      vec3 gloss = vec3(0.005, 0.006, 0.01) + mix(uBlue, uCream, 0.35) * light * sheen * mix(0.09, 0.045, uTheme) * (1.0 - vState.y * 0.8);
      gloss += fresnel * mix(uBlue * 0.34, uCream * 0.16, uTheme);
      gloss += mix(uBlue, uCream, pearl) * seam * 0.16;

      // On a light page the wall is cream, shaded only by its own relief.
      float sun = max(dot(geometric, normalize(vec3(-0.4, 0.8, 0.45))), 0.0);
      vec3 paper = uBg * (0.8 + 0.2 * sun);
      paper = mix(paper, uBlue, seam * 0.26 + (1.0 - sun) * 0.1);
      gloss = mix(gloss, paper, vState.y * uTheme);

      float band = fract(reflected.y * 0.5 + 0.4 + field * 0.85);
      vec3 deep = uBlue * mix(0.12, 0.62, pearl);
      vec3 surface = mix(deep, uBlue, smoothstep(0.06, 0.5, band));
      surface = mix(surface, uCream, smoothstep(mix(0.8, 0.24, pearl), mix(0.92, 0.52, pearl), band));
      surface = mix(surface, mix(uBlue, deep, pearl), smoothstep(0.92, 1.0, band) * (1.0 - pearl * 0.6));
      surface *= mix(0.22, 1.0, smoothstep(0.3, 0.75, amount));
      surface = mix(surface, uBlue, hover * 0.6 * (1.0 - smoothstep(0.65, 0.8, band)));
      surface += uCream * fresnel * 0.3 * amount;

      color = mix(gloss, surface, mask);
      color += uCream * rim * 0.55;

      float highlight = pow(max(dot(reflected, normalize(vec3(0.4, 0.8, 0.45))), 0.0), 90.0);
      color += uCream * highlight * (0.35 + mask * 0.5);
      color = mix(color, uBg, vState.x);
    }

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`

const point = new THREE.Vector3()
const target = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const color = new THREE.Color()

export function Scene() {
  const { geometry, height, surface, state } = useMemo(() => {
    // One rounded segment, and no underside, because there are thousands of these.
    const rounded = new RoundedBoxGeometry(1, 1, 1, 1, 0.2)
    rounded.deleteAttribute('uv')
    const geometry = mergeVertices(rounded)
    rounded.dispose()
    const position = geometry.getAttribute('position')
    const index = Array.from(geometry.getIndex()!.array)
    const kept: number[] = []
    for (let i = 0; i < index.length; i += 3) {
      const triangle = index.slice(i, i + 3)
      if (triangle.some((vertex) => position.getY(vertex) > 0)) kept.push(...triangle)
    }
    geometry.setIndex(kept)

    const attribute = (name: string, itemSize: number) => {
      const buffer = new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize)
      geometry.setAttribute(name, buffer)
      return buffer
    }
    const cell = attribute('aCell', 2)
    const height = attribute('aHeight', 1)
    const surface = attribute('aSurface', 3)
    const state = attribute('aState', 2)
    for (let i = 0; i < count; i++) cell.setXY(i, px[i], pz[i])
    height.setUsage(THREE.DynamicDrawUsage)
    surface.setUsage(THREE.DynamicDrawUsage)
    state.setUsage(THREE.DynamicDrawUsage)
    return { geometry, height, surface, state }
  }, [])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uTime: { value: 0 },
          uTheme: { value: 0 },
          uScale: { value: 0.42 },
          uPitch: { value: PITCH },
          uBg: { value: DARK.clone() },
          uRadius: { value: 0.055 },
          uSize: { value: new THREE.Vector3(PIN_WIDTH, PIN_LENGTH, PIN_WIDTH) },
          uBlue: { value: new THREE.Color('#1C70EC') },
          uCream: { value: new THREE.Color('#FFFCF0') },
          uLeak: { value: new THREE.Vector4() },
        },
      }),
    [],
  )
  const wall = useRef<THREE.Group>(null)
  const frame = useRef<THREE.Group>(null)
  const gl = useThree((state) => state.gl)

  const turn = useRef(0.68)
  const spin = useRef(0)
  const lift = useRef(new Float32Array(count))
  const velocity = useRef(new Float32Array(count))

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
        turn.current += spin.current
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
    }
  }, [gl, geometry, material])

  useFrame(({ camera, clock, size }, delta) => {
    const dt = Math.min(delta, 1 / 30)
    const time = hero.still ? 3 : clock.elapsedTime
    const { progress, intro } = hero
    const aspect = size.width / size.height
    const scrolling = smooth(0, 0.015, progress)
    const peek = hero.peek * (1 - scrolling) // the box only breathes before the scroll begins

    // The box turns freely until the scroll. The grid looks the same every quarter turn, so the
    // wall can always square up the short way and leave the keyboard the right way round.
    if (!hero.still && progress < 0.005) turn.current += dt * 0.14
    turn.current += spin.current * dt * 30
    spin.current *= Math.pow(0.03, dt)
    const quarters = Math.round(turn.current / (Math.PI / 2)) * (Math.PI / 2)
    const angle = lerp(turn.current - quarters, 0, smooth(0, 0.1, progress))
    wall.current?.rotation.set(0, angle, 0)

    // Falls under gravity, through a surface nobody can see yet.
    const fall = clamp((progress - 0.015) / (IMPACT - 0.015))
    const raise = BOX_RAISE * (1 - fall * fall)

    const since = progress - IMPACT
    const front = since * WAVE_SPEED
    const drain = (progress - DRAIN) * DRAIN_SPEED

    // Camera: starts close on the box and rides it down, then is thrown back by the impact.
    const fitStart = Math.max(14, 5.4 / (0.74 * FOV_SCALE * Math.min(aspect, 1)))
    const fitEnd = Math.max(BOARD_WIDTH / ((aspect < 0.85 ? 0.74 : 0.4) * FOV_SCALE * aspect), 40)
    const travel = smooth(IMPACT - 0.02, SETTLE_END, progress)
    const eased = 1 - Math.pow(1 - travel, 2.4)
    const distance = Math.exp(lerp(Math.log(fitStart), Math.log(fitEnd), eased))
    const look = lerp(0.52, 1.36, smooth(0.05, SETTLE_END, progress))
    const shake = hero.still || since < 0 ? 0 : -0.34 * Math.exp(-since * 30) * Math.sin(since * 90)
    const drop = smooth(0.02, IMPACT + 0.02, progress)
    target.set(boardX * eased, lerp(0, WALL_Y, drop), boardZ * eased)
    camera.position.set(
      target.x + (hero.pointerX * eased * distance) / 60,
      target.y + Math.sin(look) * distance + shake,
      target.z + Math.cos(look) * distance,
    )
    camera.lookAt(target)
    camera.near = 1
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    leakAt.set(Math.sin(time * 0.31), Math.sin(time * 0.23 + 1) * 0.8, Math.cos(time * 0.27)).normalize()
    leakAt.applyAxisAngle(UP, -angle)

    // Where the pointer meets the top of the box, then the wall.
    let hoverX = 1e6
    let hoverZ = 1e6
    if (hero.pointerActive && (progress < 0.01 || since > 0.03)) {
      const plane = since > 0 ? WALL_Y + KEY_RAISE : CUBE_SIZE / 2
      point.set(hero.pointerX, hero.pointerY, 0.5).unproject(camera).sub(camera.position)
      const reach = (plane - camera.position.y) / point.y
      point.multiplyScalar(reach).add(camera.position)
      point.y = 0
      point.applyAxisAngle(UP, -angle)
      hoverX = point.x
      hoverZ = point.z
    }
    const hoverRadius = since > 0 ? 3.4 : 1.1

    const heights = height.array as Float32Array
    const surfaces = surface.array as Float32Array
    const states = state.array as Float32Array
    const springs = lift.current
    const speeds = velocity.current

    for (let i = 0; i < count; i++) {
      const k = keyOf[i]
      const box = isBox[i] === 1
      const s = front - fromBox[i]
      const behind = drain - fromBoard[i]
      let top = WALL_Y

      let tint: number = TINT.blue
      const woke = since > 0 ? smooth(-5, 0, s) : 0

      const crest = since > 0 ? wave(s, 2.3 * Math.exp(-fromBox[i] * 0.014)) : 0
      const tail = behind > -7 && behind < 8 ? wave(Math.min(behind, 0), 0.9) * (behind > 0 ? Math.exp(-behind) : 1) : 0
      const roll = hero.still ? 0 : Math.sin(px[i] * 0.22 - pz[i] * 0.17 + time * 0.9) * smooth(0.3, 0.42, progress) * 0.14
      top += crest + tail + (box || k >= 0 ? 0 : roll)
      let liquid = smooth(0.3, 1, crest + tail) + (box && since < 0 ? 0.002 : 0)

      if (k >= 0) {
        const key = keys[k]
        const rise = smooth(0, 3, s)
        const swell = hero.still ? 0 : smooth(0.8, 1, Math.sin(px[i] * 0.3 + pz[i] * 0.2 - time * 1.2)) * smooth(0.5, 0.7, progress) * 0.16
        top += rise * KEY_RAISE + swell
        liquid = Math.max(liquid, smooth(1, 9, s))
        tint = key.tint
      }

      // Pointer and real keys. Only the pins near either bother with the spring.
      const near = Math.abs(px[i] - hoverX) + Math.abs(pz[i] - hoverZ) < hoverRadius * 1.5
      if (near || springs[i] !== 0 || speeds[i] !== 0 || k >= 0) {
        let goal = near ? smooth(hoverRadius, hoverRadius * 0.3, Math.hypot(px[i] - hoverX, pz[i] - hoverZ)) : 0
        if (since <= 0 && !box) goal = 0
        if (k >= 0 && s > 3 && hero.pressed.has(keys[k].code)) goal = -0.5
        speeds[i] += ((goal - springs[i]) * 190 - speeds[i] * 15) * dt
        springs[i] += speeds[i] * dt
        if (Math.abs(springs[i]) + Math.abs(speeds[i]) < 0.0005 && !goal) springs[i] = speeds[i] = 0
      }
      const pop = springs[i]
      top += pop * (k >= 0 ? 0.7 : 0.6)
      const lit = clamp(Math.abs(pop))

      let hide = 1 - woke
      let paper = 1
      if (box) {
        const landing = 1 - smooth(0, 1, intro * 1.7 - (px[i] + pz[i] + 3) * 0.03)
        top += raise + landing * 7 + peek * (0.35 + 0.25 * Math.sin(px[i] * 2.1) * Math.cos(pz[i] * 2.1))
        hide = 1 - smooth(0, 0.5, intro)
        paper = smooth(0, 0.015, since)
      }
      if (k >= 0) paper = 1 - smooth(-2, 3, s)
      else hide = Math.max(hide, smooth(-1, 3, behind))
      hide = Math.max(hide * (1 - lit), edge[i])

      heights[i] = top
      surfaces[i * 3] = Math.max(liquid, k >= 0 ? clamp(pop) : 0)
      surfaces[i * 3 + 1] = tint
      surfaces[i * 3 + 2] = lit
      states[i * 2] = hide
      states[i * 2 + 1] = paper
    }

    height.needsUpdate = true
    surface.needsUpdate = true
    state.needsUpdate = true

    // The frame sinks with the box, then rises out of the wall around the keyboard.
    if (frame.current) {
      if (since < 0.02) {
        frame.current.position.set(0, WALL_Y + raise - CUBE_SIZE / 2 - fall * 0.3, 0)
        frame.current.rotation.set(0, angle + quarters, 0)
        frame.current.scale.setScalar(1)
      } else {
        const up = smooth(0.26, 0.36, progress)
        frame.current.position.set(boardX, lerp(WALL_Y - 3.4, WALL_Y + 1, up), boardZ)
        frame.current.rotation.set(0, 0, 0)
        frame.current.scale.set((BOARD_WIDTH + 2.6) / (CUBE_SIZE * 1.16), 0.5, (BOARD_DEPTH + 2.6) / (CUBE_SIZE * 1.16))
      }
    }

    material.uniforms.uTime.value = time
    material.uniforms.uTheme.value = hero.theme
    material.uniforms.uBg.value.copy(color.lerpColors(DARK, CREAM, hero.theme))
    material.uniforms.uLeak.value.set(leakAt.x, leakAt.y, leakAt.z, 1 - scrolling)
  })

  return (
    <>
      <group ref={wall}>
        <instancedMesh args={[geometry, material, count]} frustumCulled={false} />
      </group>
      <group ref={frame} />
      <Outline follow={frame} morph={false} />
    </>
  )
}
