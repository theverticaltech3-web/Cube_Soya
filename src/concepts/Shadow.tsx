import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { ROWS, TINT, tiles } from '../layout'
import { createLiquidMaterial } from '../scene/liquidMaterial'
import { Outline } from '../scene/Outline'

// After Shigeo Fukuda. The box holds a packed block of smaller cubes. They spread into a mess,
// and only one light, from one angle, shows what the mess is: its shadow is a keyboard.
// Every cube sits on its own ray from the final light to its key, sized for its depth on that ray.
// The rays fan apart and the sculpture then turns as one rigid body, so nothing can touch.

const FLOOR_Y = -4.6
const LIGHT_RANGE = 15
const LIGHT_ANGLE = THREE.MathUtils.degToRad(50) // above the horizon, behind the object
const LIGHT_HEIGHT = Math.sin(LIGHT_ANGLE) * LIGHT_RANGE
const LIGHT_BACK = Math.cos(LIGHT_ANGLE) * LIGHT_RANGE
const LIGHT_SWING = -3.7 // radians around the object
const BEAM_TILT = 0.3 // half angle of the pool of light

const KEY_PITCH = 0.55
const KEY_FILL = 0.88 // the rest is the gap between keys
const NEAREST = 0.6 // how far along its ray a cube may hang, 0 = light, 1 = floor
const FARTHEST = 0.84
const BLOCK_PITCH = 0.5
const BLOCK_GRID = [5, 5, 5] as const
const OPEN_RATIO = 2.1 // the block first opens evenly to this pitch, so the cubes have room to turn
const OPEN_SHARE = 0.42 // of the spread
const SHELL_TRAVEL = 15
const CASE_SCALE = 1.75 // the frame opens to hold the sculpture

const STRIKE = 0.035 // the light comes on
const SHELL_START = 0.075
const SHELL_END = 0.2
const SPREAD_START = 0.13
const SPREAD_END = 0.32
const LOCK = 0.45 // the shadow resolves
const IGNITE_END = 0.62
const SETTLE_END = 0.72
const CAMERA_END = 0.5
const CAMERA_ANGLE = 0.8 // ends above the object
const CAMERA_YAW = 0.55 // and off to one side, so the mess never lines up for the viewer

const DRAG_SPEED = 0.006
const HOVER_RADIUS = 0.05
const FOV_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(14))
const DARK = new THREE.Color('#08090C')
const CREAM = new THREE.Color('#FFFCF0')

// Key widths in key units, so the shadow has the proportions of a real board.
const WIDE: Record<string, number> = {
  Backspace: 2,
  Tab: 1.5,
  Backslash: 1.5,
  CapsLock: 1.75,
  Enter: 2.25,
  ShiftLeft: 2.25,
  ShiftRight: 1.75,
  ControlLeft: 1.25,
  MetaLeft: 1.25,
  AltLeft: 1.25,
  Space: 5.25,
}

const LIGHT_END = new THREE.Vector3(0, LIGHT_HEIGHT, -LIGHT_BACK)
const DROP = (LIGHT_HEIGHT - FLOOR_Y) / LIGHT_HEIGHT // light to floor, through the origin
const BOARD_Z = -LIGHT_BACK + LIGHT_BACK * DROP
const ROW_PITCH = KEY_PITCH / Math.sin(LIGHT_ANGLE) // cancels the slant of the shadow on the floor

let seed = 41 // chosen: the path check passes with a 4% margin
const random = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}

// One entry per key, and one cube for each shadow it needs. Wide keys are overlapping shadows.
const keys = ROWS.flatMap((row, rowIndex) => {
  let cursor = -7.5
  return row.map((code) => {
    const width = WIDE[code] ?? 1
    const x = cursor + width / 2
    cursor += width
    const z = rowIndex - (ROWS.length - 1) / 2
    return { code, x, z, width, tint: Math.abs(x * 0.55 - z) < 1 ? TINT.cream : TINT.blue }
  })
})

type Cube = {
  key: number
  end: THREE.Vector3
  start: THREE.Vector3
  quat: THREE.Quaternion
  ray: THREE.Vector3
  size: number
  reach: number
}

const X_AXIS = new THREE.Vector3(1, 0, 0)
const IDENTITY = new THREE.Quaternion()

const cubes: Cube[] = keys.flatMap((key, k) => {
  const shadows = key.width > 1 ? Math.ceil(key.width) + 1 : 1
  return Array.from({ length: shadows }, (_, n) => {
    const across = shadows > 1 ? (n / (shadows - 1) - 0.5) * (key.width - 1) : 0
    const hit = new THREE.Vector3((key.x + across) * KEY_PITCH, FLOOR_Y, BOARD_Z + key.z * ROW_PITCH)
    return { key: k, hit }
  })
})
  .map((entry) => ({ entry, order: random() }))
  .sort((a, b) => a.order - b.order)
  .map(({ entry }) => entry)
  .reduce<Cube[]>((placed, { key, hit }) => {
    const toFloor = hit.clone().sub(LIGHT_END)
    const length = toFloor.length()
    const ray = toFloor.clone().normalize()
    const size = (t: number) => (KEY_PITCH * KEY_FILL * t) / (1 + (KEY_PITCH * KEY_FILL) / (2 * length))
    // Try depths until this cube clears everything already hanging in the sculpture.
    let best = { clearance: -Infinity, t: 0.66 }
    for (let attempt = 0; attempt < 90; attempt++) {
      const t = lerp(NEAREST, FARTHEST, random())
      const at = LIGHT_END.clone().addScaledVector(toFloor, t)
      const clearance = placed.reduce(
        (least, other) => Math.min(least, at.distanceTo(other.end) - (size(t) + other.size) * 0.9),
        Infinity,
      )
      if (clearance > best.clearance) best = { clearance, t }
      if (clearance > 0.05) break
    }
    const side = X_AXIS.clone().addScaledVector(ray, -X_AXIS.dot(ray)).normalize()
    const depth = new THREE.Vector3().crossVectors(side, ray)
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, ray, depth))
    placed.push({
      key,
      end: LIGHT_END.clone().addScaledVector(toFloor, best.t),
      start: new THREE.Vector3(),
      quat,
      ray,
      size: size(best.t),
      reach: Math.hypot(keys[key].x, keys[key].z * 2) / 8,
    })
    return placed
  }, [])

// Packed block: sorted slab by slab, so neighbours in the block stay neighbours in the sculpture.
{
  const [nx, ny, nz] = BLOCK_GRID
  const cell = (n: number, size: number) => (n - (size - 1) / 2) * BLOCK_PITCH
  const sorted = [...cubes].sort((a, b) => a.end.x - b.end.x)
  const perSlab = Math.ceil(cubes.length / nx)
  for (let a = 0; a < nx; a++) {
    const slab = sorted.slice(a * perSlab, (a + 1) * perSlab).sort((p, q) => p.end.y - q.end.y)
    const perColumn = Math.ceil(slab.length / ny)
    for (let b = 0; b < ny; b++) {
      const column = slab.slice(b * perColumn, (b + 1) * perColumn).sort((p, q) => p.end.z - q.end.z)
      column.forEach((cube, c) => cube.start.set(cell(a, nx), cell(b, ny), cell(c, nz)))
    }
  }
}

// Two rigid stages: the block dilates evenly, which can't collide, then each cube runs a straight
// rail to its place while squaring up to the light. Checked with box against box tests along the path.
const placeCube = (cube: Cube, spread: number, position: THREE.Vector3, quat: THREE.Quaternion) => {
  const opened = smooth(0, OPEN_SHARE, spread)
  const run = smooth(OPEN_SHARE, 1, spread)
  position.copy(cube.start).multiplyScalar(lerp(1, OPEN_RATIO, opened)).lerp(cube.end, run)
  quat.slerpQuaternions(IDENTITY, cube.quat, smooth(OPEN_SHARE * 0.8, 1, spread))
}

const count = tiles.length + cubes.length

const heroQuat = new THREE.Quaternion()
const tiltQuat = new THREE.Quaternion()
const tileQuat = new THREE.Quaternion()
const point = new THREE.Vector3()
const aim = new THREE.Vector3()
const target = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const RIGHT = new THREE.Vector3(1, 0, 0)
const color = new THREE.Color()

const pool = /* glsl */ `
  uniform vec3 uLight;
  uniform vec3 uAim;
  uniform float uPower;
  float pool(vec3 p) {
    float c = dot(normalize(p - uLight), normalize(uAim - uLight));
    return smoothstep(${Math.cos(BEAM_TILT).toFixed(4)}, ${Math.cos(BEAM_TILT * 0.4).toFixed(4)}, c) * uPower;
  }
`

const floorVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const floorFragment = /* glsl */ `
  uniform vec3 uBlue;
  varying vec3 vWorld;
  ${pool}
  void main() {
    float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) / 90.0;
    gl_FragColor = vec4(uBlue, clamp(pool(vWorld) + grain - 0.005, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`

// Every cube again, flattened onto the floor along its ray from the light: an exact, crisp shadow
// that costs almost nothing compared with a shadow map.
const shadowVertex = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec3 aSize;
  attribute vec4 aQuat;
  attribute vec3 aSurface;
  attribute float aHide;

  uniform vec3 uLight;
  uniform float uFloor;
  uniform float uRadius;

  varying vec3 vWorld;
  varying float vPop;

  vec3 rotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  void main() {
    float radius = min(uRadius, min(aSize.x, min(aSize.y, aSize.z)) * 0.5);
    vec3 local = sign(position) * (aSize * 0.5 - radius) + normal * radius;
    vec3 world = rotate(aQuat, local) + aOffset;
    vec3 ray = world - uLight;
    vPop = aSurface.z;
    if (aHide > 0.5 || ray.y > -0.05) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vWorld = uLight + ray * (uFloor - uLight.y) / ray.y;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`

const shadowFragment = /* glsl */ `
  uniform vec3 uInk;
  uniform vec3 uCream;
  varying vec3 vWorld;
  varying float vPop;
  ${pool}
  void main() {
    gl_FragColor = vec4(mix(uInk, uCream, smoothstep(0.3, 0.6, vPop)), clamp(pool(vWorld) * 1.6, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`

export function Scene() {
  const { geometry, offset, surface, hide, quats } = useMemo(() => {
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
    tiles.forEach((tile, i) => sizes.setXYZ(i, tile.size.x, tile.size.y, tile.size.z))
    cubes.forEach((cube, c) => sizes.setXYZ(tiles.length + c, cube.size, cube.size, cube.size))
    offset.setUsage(THREE.DynamicDrawUsage)
    surface.setUsage(THREE.DynamicDrawUsage)
    hide.setUsage(THREE.DynamicDrawUsage)
    quats.setUsage(THREE.DynamicDrawUsage)
    return { geometry, offset, surface, hide, quats }
  }, [])
  const material = useMemo(createLiquidMaterial, [])
  const light = useMemo(
    () => ({
      uLight: { value: new THREE.Vector3() },
      uAim: { value: new THREE.Vector3() },
      uPower: { value: 0 },
      uFloor: { value: FLOOR_Y + 0.01 },
      uRadius: { value: 0.03 },
      uBlue: { value: new THREE.Color('#1C70EC') },
      uCream: { value: CREAM.clone() },
      uInk: { value: DARK.clone() },
    }),
    [],
  )
  const floorMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: floorVertex,
        fragmentShader: floorFragment,
        uniforms: light,
        transparent: true,
        depthWrite: false,
      }),
    [light],
  )
  const shadowMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: shadowVertex,
        fragmentShader: shadowFragment,
        uniforms: light,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [light],
  )
  const frame = useRef<THREE.Group>(null)
  const gl = useThree((state) => state.gl)

  const yaw = useRef(0.68)
  const spin = useRef(0)
  const twist = useRef(0) // a drag after the lock pulls the shadow apart, then it springs back
  const twistVelocity = useRef(0)
  const dragging = useRef(false)
  const keyPress = useRef(new Float32Array(keys.length))
  const keyVelocity = useRef(new Float32Array(keys.length))
  const tileHover = useRef(new Float32Array(tiles.length))
  const tileVelocity = useRef(new Float32Array(tiles.length))

  useEffect(() => {
    const canvas = gl.domElement
    let lastX = 0
    const move = (event: PointerEvent) => {
      hero.pointerX = (event.clientX / window.innerWidth) * 2 - 1
      hero.pointerY = 1 - (event.clientY / window.innerHeight) * 2
      hero.pointerActive = true
      if (dragging.current) {
        spin.current = (event.clientX - lastX) * DRAG_SPEED
        yaw.current += spin.current
        twist.current += spin.current
        lastX = event.clientX
      }
    }
    const down = (event: PointerEvent) => {
      move(event)
      dragging.current = true
      lastX = event.clientX
    }
    const up = (event: PointerEvent) => {
      dragging.current = false
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
      floorMaterial.dispose()
      shadowMaterial.dispose()
    }
  }, [gl, geometry, material, floorMaterial, shadowMaterial])

  useFrame(({ camera, clock, size }, delta) => {
    const dt = Math.min(delta, 1 / 30)
    const time = hero.still ? 3 : clock.elapsedTime
    const { progress, intro } = hero
    const aspect = size.width / size.height
    const scrolling = smooth(0, 0.015, progress)
    const peek = hero.peek * (1 - smooth(0, 0.004, progress)) // stops the moment the scroll begins

    // The object and the light both travel, and arrive at the same instant.
    if (!hero.still && progress < 0.005) yaw.current += dt * 0.14
    if (!dragging.current) {
      yaw.current += spin.current * dt * 30
      spin.current *= Math.pow(0.03, dt)
    }
    if (progress < 0.005) yaw.current = Math.atan2(Math.sin(yaw.current), Math.cos(yaw.current))
    twistVelocity.current += (-twist.current * 60 - twistVelocity.current * 9) * dt
    twist.current += twistVelocity.current * dt
    if (progress < LOCK) twist.current = 0

    const arrive = smooth(0.06, LOCK, progress)
    const past = progress - LOCK
    const clunk = past > 0 && !hero.still ? Math.exp(-past * 70) * Math.sin(past * 190) : 0 // a tumbler dropping
    heroQuat.setFromAxisAngle(UP, (yaw.current - Math.PI * 2) * (1 - arrive) + clunk * 0.035 + twist.current)
    tiltQuat.setFromAxisAngle(RIGHT, Math.sin(arrive * Math.PI) * 0.8 * (1 - arrive))
    heroQuat.multiply(tiltQuat)

    // The light swings around on a level rail. Its pool slides across the floor with it.
    const swing = LIGHT_SWING * (1 - smooth(0.02, LOCK, progress))
    light.uLight.value.set(Math.sin(swing) * LIGHT_BACK, LIGHT_HEIGHT, -Math.cos(swing) * LIGHT_BACK)
    aim.copy(light.uLight.value).multiplyScalar(-(DROP - 1))
    aim.y = FLOOR_Y
    light.uAim.value.copy(aim)
    const strike = smooth(STRIKE, STRIKE + 0.012, progress)
    const flicker = hero.still ? 1 : 1 - 0.75 * Math.exp(-(progress - STRIKE) * 90) * Math.abs(Math.sin(progress * 700))
    light.uPower.value = strike * flicker * (1 + 0.35 * Math.exp(-Math.max(past, 0) * 40) * smooth(LOCK - 0.01, LOCK, progress))

    // Starts on the same shot as the box, ends high and far, on the object and its shadow together.
    const fitStart = Math.max(14, 5.4 / (0.74 * FOV_SCALE * Math.min(aspect, 1)))
    const orbit = smooth(0.04, CAMERA_END, progress)
    const look = lerp(0.52, CAMERA_ANGLE, orbit)
    const turn = orbit * (aspect < 0.85 ? CAMERA_YAW * 0.45 : CAMERA_YAW)
    const below = -FLOOR_Y * Math.cos(look) + BOARD_Z * Math.sin(look) * Math.cos(turn) // the shadow, on screen
    const beside = BOARD_Z * Math.sin(turn)
    const fitEnd = Math.max((below + 7.6) / (0.84 * FOV_SCALE), (beside + 9.6) / ((aspect < 0.85 ? 0.96 : 0.56) * FOV_SCALE * aspect))
    const travel = smooth(0.03, CAMERA_END, progress)
    const distance = Math.exp(lerp(Math.log(fitStart), Math.log(fitEnd * (1 + 0.24 * smooth(CAMERA_END, 1, progress))), travel))
    target.set(0, FLOOR_Y, BOARD_Z).multiplyScalar(travel * 0.42)
    camera.position.set(
      target.x + Math.sin(turn) * Math.cos(look) * distance + (hero.pointerX * travel * distance) / 70,
      target.y + Math.sin(look) * distance + clunk * 0.05,
      target.z + Math.cos(turn) * Math.cos(look) * distance,
    )
    camera.lookAt(target)
    camera.near = 1
    camera.far = 300
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

    // The shell leaves on straight rails along its normals, so its tiles only ever move apart.
    const blast = clamp((progress - SHELL_START) / (SHELL_END - SHELL_START))
    const shellOut = blast * blast * blast * SHELL_TRAVEL

    tiles.forEach((tile, t) => {
      const lift = (1 - smooth(0, 1, intro * 1.7 - t * 0.007)) * 7
      const near = progress < SHELL_START && hero.pointerActive
      point.copy(tile.position).applyQuaternion(heroQuat)
      const facing = point.dot(camera.position) > 0
      const hoverGoal = near && facing ? smooth(0.22, 0.07, project(point.x, point.y, point.z)) : 0
      spring(tileHover.current, tileVelocity.current, t, hoverGoal)
      const h = tileHover.current[t]
      const out = lift + peek * (0.4 + 0.2 * Math.sin(t * 2.4)) + h * 0.5 + shellOut

      point.copy(tile.position).addScaledVector(tile.normal, out).applyQuaternion(heroQuat)
      offsets[t * 3] = point.x
      offsets[t * 3 + 1] = point.y
      offsets[t * 3 + 2] = point.z
      tileQuat.copy(heroQuat).multiply(tile.quaternion)
      quats.setXYZW(t, tileQuat.x, tileQuat.y, tileQuat.z, tileQuat.w)
      surfaces[t * 3] = smooth(0.55, 0.98, point.copy(tile.position).normalize().applyQuaternion(heroQuat).dot(leakAt) + peek * 0.3) * 0.9 * (1 - scrolling)
      surfaces[t * 3 + 1] = TINT.blue
      surfaces[t * 3 + 2] = h
      hides[t] = Math.max(1 - smooth(0, 0.5, intro), smooth(SHELL_TRAVEL * 0.45, SHELL_TRAVEL * 0.8, shellOut))
    })

    const typing = hero.still ? 0 : smooth(SETTLE_END - 0.04, SETTLE_END + 0.04, progress)
    const typed = Math.floor(time * 6.5)
    const ghost = Math.floor(((Math.sin(typed * 12.9898) * 43758.5453) % 1 + 1) * 0.5 * keys.length)

    keys.forEach((key, k) => {
      let goal = hero.pressed.has(key.code) ? 1 : 0
      if (!goal && hero.pointerActive && progress > LOCK && hero.pointerY < 0) {
        point.set(key.x * KEY_PITCH, FLOOR_Y, BOARD_Z + key.z * ROW_PITCH)
        goal = smooth(HOVER_RADIUS, HOVER_RADIUS * 0.3, project(point.x, point.y, point.z))
      }
      if (!goal && typing > 0.5 && k === ghost && (time * 6.5) % 1 < 0.6) goal = 1
      spring(keyPress.current, keyVelocity.current, k, goal)
    })

    const spread = smooth(SPREAD_START, SPREAD_END, progress)

    cubes.forEach((cube, c) => {
      const i = tiles.length + c
      const press = keyPress.current[cube.key]
      // Pressing slides a cube down its own ray, so its shadow shrinks like a key going down
      // and stays inside its own cone, clear of every other cube.
      const slide = Math.max(press, 0) * 0.5
      placeCube(cube, spread, point, tileQuat)
      point.addScaledVector(cube.ray, slide).applyQuaternion(heroQuat)
      offsets[i * 3] = point.x
      offsets[i * 3 + 1] = point.y
      offsets[i * 3 + 2] = point.z
      tileQuat.premultiply(heroQuat)
      quats.setXYZW(i, tileQuat.x, tileQuat.y, tileQuat.z, tileQuat.w)
      const ignited = smooth(0, 0.07, progress - LOCK - cube.reach * (IGNITE_END - LOCK - 0.07))
      surfaces[i * 3] = Math.max(ignited, clamp(press))
      surfaces[i * 3 + 1] = lerp(TINT.blue, keys[cube.key].tint, ignited) // stays black until the light finds it
      surfaces[i * 3 + 2] = clamp(press)
      hides[i] = progress > SHELL_START * 0.8 ? 0 : 1 // sealed in until the shell is about to go
    })

    offset.needsUpdate = true
    surface.needsUpdate = true
    hide.needsUpdate = true
    quats.needsUpdate = true

    if (frame.current) {
      frame.current.position.set(0, 0, 0)
      frame.current.quaternion.copy(heroQuat)
      frame.current.scale.setScalar(lerp(1, CASE_SCALE, smooth(SHELL_START, SPREAD_END, progress)))
    }

    material.uniforms.uTime.value = time
    material.uniforms.uTheme.value = hero.theme
    material.uniforms.uScale.value = lerp(0.42, 1.1, smooth(LOCK, IGNITE_END, progress)) // finer bands on the small cubes
    material.uniforms.uBg.value.copy(color.lerpColors(DARK, CREAM, hero.theme))
  })

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y, 0]} material={floorMaterial} renderOrder={1}>
        <planeGeometry args={[220, 220]} />
      </mesh>
      <instancedMesh args={[geometry, shadowMaterial, count]} frustumCulled={false} renderOrder={2} />
      <instancedMesh args={[geometry, material, count]} frustumCulled={false} />
      <group ref={frame} />
      <Outline follow={frame} morph={false} />
    </>
  )
}
