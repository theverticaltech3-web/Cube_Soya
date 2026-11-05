import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { CUBE_SIZE, ROWS, TINT } from '../layout'
import { createLiquidMaterial } from '../scene/liquidMaterial'
import { Outline } from '../scene/Outline'

// The box is 64 small robots, black on the outside and chrome on every face that was hidden.
// One tips off the top alone. The rest follow it, layer by layer, in lines along a floor grid.
// Nothing here is animated freely: a planner books the grid cells for every roll before the
// page starts, so all motion is a lookup of rigid pivots and straight falls on a shared clock.

const CELLS = 4
const P = CUBE_SIZE / CELLS // one floor cell
const SIZE = P - 0.024 // the same seam as the tile box
const SCOUT_TICKS = 6 // the scout walks alone for this long
const SCOUT_LANDS = 3 // tip, tip, fall
const ROCK_TICKS = 3 // it hesitates on the edge before committing
const SPREAD = 0.13 // the slab finally clicks apart into separate keys
const STAGGER = [-0.3, 0, 0.35, 0.65, 0.2] // sideways slide of each row, in cells
const DRAG_SPEED = 0.006
const HOVER_RADIUS = 0.065

// The scroll, as shots. The keyboard has landed by BOARD_AT.
const WAKE = 0.02
const SCOUT_END = 0.15
const BOARD_AT = 0.47
const CLICK_END = 0.53
const SETTLE_END = 0.6

const FOV_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(14))
const DARK = new THREE.Color('#08090C')
const CREAM = new THREE.Color('#FFFCF0')
const UP = new THREE.Vector3(0, 1, 0)

type Cell = [number, number, number]
type Step = { to: Cell; kind: 'roll' | 'tip' | 'drop'; dir: Cell; closing?: boolean }
type Move = {
  start: number
  span: number
  from: THREE.Vector3
  to: THREE.Vector3
  pivot: THREE.Vector3
  axis: THREE.Vector3
  angle: number // 0 for a straight fall
  before: THREE.Quaternion
  after: THREE.Quaternion
}
type Cube = {
  home: Cell
  end: Cell
  route: Step[]
  moves: Move[]
  skin: Cell // which of the cube's own faces were outside the box
  rail: Cell // the axis it may slide out along when hovered
  surface: boolean
  tint: number
  code: string
  wake: number
  settled: number
}

const add = (a: Cell, b: Cell, scale = 1): Cell => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale]
const name = (c: Cell) => c.join()
const world = (c: Cell, out = new THREE.Vector3()) => out.set((c[0] - 1.5) * P, (c[1] - 1.5) * P, (c[2] - 1.5) * P)

const below: Cell = [0, -1, 0]
const above: Cell = [0, 1, 0]

// Every cell a move can touch, including the arc of the far corner past the cube's own cell.
const footprint = (from: Cell, step: Step): Cell[] => {
  if (step.kind === 'drop') {
    const cells: Cell[] = []
    for (let y = from[1]; y >= step.to[1]; y--) cells.push([from[0], y, from[2]])
    return cells
  }
  const next = add(from, step.dir)
  if (step.kind === 'roll') return [from, next, add(from, above), add(next, above)]
  // A tip books the whole wall below it too: a cube never hangs in the air waiting.
  const cells = [from, next, add(from, above), add(next, above), add(next, step.dir)]
  for (let y = from[1] - 1; y >= 0; y--) cells.push([next[0], y, next[2]])
  cells.push(add(add(next, below), step.dir))
  return cells
}

// The rows of the keyboard, without the function row and one modifier, so that 64 keys fit.
const rows = ROWS.slice(1).map((row) => row.filter((code) => code !== 'ContextMenu'))
const ROW_START = [-5, -5, -5, -5, -3]
const codeAt = new Map(rows.flatMap((row, z) => row.map((code, i) => [name([ROW_START[z] + i, 0, z]), code] as const)))

const makeCubes = () => {
  const cubes: Cube[] = []
  const at = new Map<string, Cube>()
  for (let y = 0; y < CELLS; y++) {
    for (let z = 0; z < CELLS; z++) {
      for (let x = 0; x < CELLS; x++) {
        const home: Cell = [x, y, z]
        const out = (v: number) => (v === 0 ? -1 : v === CELLS - 1 ? 1 : 0)
        const skin: Cell = [out(x), y === CELLS - 1 ? 1 : 0, out(z)]
        const rail: Cell = skin[1] ? [0, 1, 0] : skin[0] ? [skin[0], 0, 0] : [0, 0, skin[2]]
        const cube = { home, end: home, route: [], moves: [], skin, rail, surface: skin.some(Boolean), tint: TINT.blue, code: '', wake: 0, settled: 0 }
        cubes.push(cube)
        at.set(name(home), cube)
      }
    }
  }

  // The route of one cube: along its layer, off the edge, down the wall, then across the floor.
  const walk = (cube: Cube, side: 1 | -1, slot: Cell, closes: boolean) => {
    const dir: Cell = [side, 0, 0]
    const wall = side > 0 ? CELLS : -1
    let cell = cube.home
    const roll = (d: Cell, closing = false) => {
      cell = add(cell, d)
      cube.route.push({ to: cell, kind: 'roll', dir: d, closing })
    }
    while (cell[0] + side !== wall) roll(dir)
    cell = [wall, cell[1] - 1, cell[2]]
    cube.route.push({ to: cell, kind: 'tip', dir })
    if (cell[1] > 0) {
      cell = [wall, 0, cell[2]]
      cube.route.push({ to: cell, kind: 'drop', dir })
    }
    while (cell[2] < slot[2]) roll([0, 0, 1])
    const inward = slot[0] > cell[0] ? 1 : -1
    while (cell[0] !== slot[0]) roll([inward, 0, 0])
    if (closes) roll([-side, 0, 0], true)
    cube.end = closes ? cell : slot
  }

  // Wing rows park one cell too far out. A tipping cube sweeps the cell beyond its landing,
  // so the wall column stays clear until the last landing, then the ranks close.
  const FRONT = 4
  const wing = (z: number, side: 1 | -1) => {
    const last = side > 0 ? (z < 2 ? 8 : 7) : -5
    const near = side > 0 ? 4 : -1
    const slots: [number, boolean][] = []
    for (let x = last; x !== near; x -= side) slots.push([x + side, true])
    slots.push([near, false])
    return slots
  }
  const frontEast = [[1, 3], [2, 2], [3, 1], [6, 3], [5, 2], [4, 0]] // slot in the front row, for the cube of this lane
  const frontWest = [[0, 3], [-3, 2], [-2, 1], [-1, 0]]

  for (let z = 0; z < CELLS; z++) {
    for (const side of [1, -1] as const) {
      const columns = side > 0 ? [3, 2] : [0, 1]
      const queue = [3, 2, 1].flatMap((y) => columns.map((x) => at.get(name([x, y, z]))!))
      const front = (side > 0 ? frontEast : frontWest).filter(([, lane]) => lane === z).map(([x]) => x)
      front.forEach((x, i) => walk(queue[i], side, [x, 0, FRONT], false))
      wing(z, side).forEach(([x, closes], i) => walk(queue[i + front.length], side, [x, 0, z], closes))
    }
  }

  cubes.forEach((cube) => {
    const [x, , z] = cube.end
    const shown = (x - 1.5) * P
    cube.tint = Math.abs(shown * 0.55 - (z - 2) * P) < P * 1.05 ? TINT.cream : TINT.blue
    cube.code = codeAt.get(name(cube.end)) ?? ''
  })
  return cubes
}

// Books the grid. A move starts only if every cell it touches is free for its whole length,
// so two cubes can never share a cell, whatever the order on screen looks like.
const plan = (cubes: Cube[]) => {
  const scout = cubes.find((cube) => name(cube.home) === name([3, 3, 3]))!
  const taken = new Map<string, number>()
  cubes.forEach((cube) => taken.set(name(cube.home), Infinity))
  const state = cubes.map((cube) => ({ cube, step: 0, cell: cube.home, busy: 0, quat: new THREE.Quaternion() }))
  // Top layer first, then outwards in: the box comes down in the order you would dismantle it.
  const order = [...state].sort((a, b) => b.cube.home[1] - a.cube.home[1] || b.cube.home[2] - a.cube.home[2])
  const hasTipped = (s: (typeof state)[number]) => s.cube.route.slice(0, s.step).some((step) => step.kind === 'tip')
  const free = (cell: Cell, tick: number, own: Cell) => name(cell) === name(own) || (taken.get(name(cell)) ?? -1) <= tick

  let tick = 0
  for (; tick < 400 && state.some((s) => s.step < s.cube.route.length); tick++) {
    const walking = state.some((s) => {
      const step = s.cube.route[s.step]
      return step && !step.closing
    })
    for (const s of order) {
      const step = s.cube.route[s.step]
      if (!step || s.busy > tick) continue
      if (step.closing && walking) continue
      if (s.cube !== scout && tick < SCOUT_TICKS) continue
      const layer = s.cube.home[1]
      if (s.step === 0 && state.some((o) => o.cube.home[1] > layer && o.cube.route.length && !hasTipped(o))) continue

      const span = step.kind === 'tip' ? 2 : 1
      const falls = s.cube.route[s.step + 1]?.kind === 'drop'
      const cells = footprint(s.cell, step)
      if (step.kind !== 'drop' && !cells.every((cell) => free(cell, tick, s.cell))) continue

      cells.forEach((cell) => taken.set(name(cell), tick + span + (falls ? 1 : 0)))
      taken.set(name(step.to), Infinity)

      const from = world(s.cell)
      const to = world(step.to)
      const axis = new THREE.Vector3(step.dir[0], 0, step.dir[2]).cross(UP).negate()
      const pivot = world(s.cell).add(new THREE.Vector3(step.dir[0], -1, step.dir[2]).multiplyScalar(P / 2))
      const angle = step.kind === 'drop' ? 0 : step.kind === 'tip' ? Math.PI : Math.PI / 2
      const before = s.quat.clone()
      s.quat = new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(s.quat)
      s.cube.moves.push({ start: tick, span, from, to, pivot, axis, angle, before, after: s.quat.clone() })
      s.cell = step.to
      s.step++
      s.busy = tick + span
    }
  }
  if (state.some((s) => s.step < s.cube.route.length)) throw new Error('Walkers: the plan deadlocked')
  return tick
}

const cubes = makeCubes()
const TOTAL = plan(cubes)
const count = cubes.length

// A cube wakes when a neighbour leaves and exposes it. It settles when it reaches its key.
const homes = new Map(cubes.map((cube) => [name(cube.home), cube]))
const firstMove = (cube: Cube) => cube.moves[0]?.start ?? TOTAL
cubes.forEach((cube) => {
  const near = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].map((d) => homes.get(name(add(cube.home, d as Cell))))
  cube.wake = Math.min(firstMove(cube), ...near.map((n) => (n ? firstMove(n) : TOTAL)))
  const last = cube.moves[cube.moves.length - 1]
  cube.settled = last ? last.start + last.span : TOTAL
})
const scoutIndex = cubes.findIndex((cube) => name(cube.home) === name([3, 3, 3]))

const heavy = (t: number) => t * t * (1.6 - 0.6 * t) // leans over slowly, lands with speed

const spin = new THREE.Quaternion()
const swing = new THREE.Vector3()

// A pure function of the clock, which is what lets the scroll run the whole film backwards.
const place = (cube: Cube, tick: number, position: THREE.Vector3, quat: THREE.Quaternion) => {
  const { moves } = cube
  let i = moves.length - 1
  while (i >= 0 && moves[i].start > tick) i--
  if (i < 0) {
    world(cube.home, position)
    quat.identity()
    return
  }
  const move = moves[i]
  const t = (tick - move.start) / move.span
  if (t >= 1) {
    position.copy(move.to)
    quat.copy(move.after)
  } else if (move.angle) {
    const angle = heavy(t) * move.angle
    position.copy(swing.copy(move.from).sub(move.pivot).applyAxisAngle(move.axis, angle)).add(move.pivot)
    quat.copy(spin.setFromAxisAngle(move.axis, angle)).multiply(move.before)
  } else {
    position.lerpVectors(move.from, move.to, t * t)
    quat.copy(move.after)
  }
}

// Development check of the promise above: samples every pair of cubes along the whole film.
if (import.meta.env.DEV) {
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const qa = new THREE.Quaternion()
  const qb = new THREE.Quaternion()
  const local = new THREE.Vector3()
  const half = SIZE / 2
  const samples: THREE.Vector3[] = []
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
    if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) === 2) samples.push(new THREE.Vector3(x, y, z).multiplyScalar(half / 2))
  }
  let hits = 0
  for (let tick = 0; tick <= TOTAL; tick += 1 / 12) {
    for (let i = 0; i < count; i++) {
      place(cubes[i], tick, a, qa)
      for (let j = i + 1; j < count; j++) {
        place(cubes[j], tick, b, qb)
        if (a.distanceTo(b) > SIZE * 1.74) continue
        qb.invert()
        for (const sample of samples) {
          local.copy(sample).applyQuaternion(qa).add(a).sub(b).applyQuaternion(qb)
          if (Math.max(Math.abs(local.x), Math.abs(local.y), Math.abs(local.z)) < half * 0.999) {
            hits++
            break
          }
        }
      }
    }
  }
  if (hits) console.error(`Walkers: ${hits} cube overlaps in the plan`)
}

// Maps the scroll onto the planner's clock. The scout's walk takes as long as the whole crowd's.
const clockAt = (progress: number) =>
  progress < SCOUT_END
    ? lerp(-ROCK_TICKS, SCOUT_TICKS, clamp((progress - WAKE) / (SCOUT_END - WAKE)))
    : lerp(SCOUT_TICKS, TOTAL, clamp((progress - SCOUT_END) / (BOARD_AT - SCOUT_END)))

// The hidden faces are chrome. Works on the cube's own normal, so a roll turns them to the light.
const makeMaterial = () => {
  const material = createLiquidMaterial()
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('attribute float aHide;', 'attribute float aHide;\n  attribute vec4 aSkin;')
      .replace(
        'vSurface = aSurface;',
        `vSurface = aSurface;
        vec3 bare = normal * aSkin.xyz;
        vSurface.x = mix(aSurface.x, aSkin.w, smoothstep(0.35, 0.7, max(bare.x, max(bare.y, bare.z))));`,
      )
      .replace(
        'vEdge = 1.0 - abs(normal.y);',
        'vEdge = clamp((1.0 - max(abs(normal.x), max(abs(normal.y), abs(normal.z)))) * 3.4, 0.0, 1.0);',
      )
    // Chrome floods a cube at full strength, it never passes through a grey half-tone.
    shader.fragmentShader = shader.fragmentShader.replace('smoothstep(0.3, 0.75, amount)', 'smoothstep(0.01, 0.12, amount)')
  }
  return material
}

const makeFloor = () => {
  const positions: number[] = []
  for (let x = -7; x <= 10; x++) for (let z = -1; z <= 6; z++) positions.push((x - 2) * P, -CUBE_SIZE / 2, (z - 2) * P)
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
}

const turn = new THREE.Quaternion()
const position = new THREE.Vector3()
const point = new THREE.Vector3()
const target = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const color = new THREE.Color()
const quat = new THREE.Quaternion()

export function Scene() {
  const { geometry, offset, surface, hide, skin, quats } = useMemo(() => {
    const geometry = new RoundedBoxGeometry(1, 1, 1, 3, 0.2)
    const attribute = (name: string, itemSize: number) => {
      const buffer = new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize)
      buffer.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute(name, buffer)
      return buffer
    }
    const offset = attribute('aOffset', 3)
    const surface = attribute('aSurface', 3)
    const hide = attribute('aHide', 1)
    const skin = attribute('aSkin', 4)
    const quats = attribute('aQuat', 4)
    const sizes = attribute('aSize', 3)
    cubes.forEach((cube, i) => {
      sizes.setXYZ(i, SIZE, SIZE, SIZE)
      skin.setXYZ(i, cube.skin[0], cube.skin[1], cube.skin[2])
    })
    return { geometry, offset, surface, hide, skin, quats }
  }, [])
  const material = useMemo(makeMaterial, [])
  const floor = useMemo(makeFloor, [])
  const floorDots = useRef<THREE.PointsMaterial>(null)
  const floorGroup = useRef<THREE.Group>(null)
  const frame = useRef<THREE.Group>(null)
  const gl = useThree((state) => state.gl)

  const yaw = useRef(0.68)
  const drift = useRef(0)
  const lift = useRef(new Float32Array(count)) // hover spring of each cube
  const liftVelocity = useRef(new Float32Array(count))

  useEffect(() => {
    const canvas = gl.domElement
    let dragging = false
    let lastX = 0
    const move = (event: PointerEvent) => {
      hero.pointerX = (event.clientX / window.innerWidth) * 2 - 1
      hero.pointerY = 1 - (event.clientY / window.innerHeight) * 2
      hero.pointerActive = true
      if (dragging) {
        drift.current = (event.clientX - lastX) * DRAG_SPEED
        yaw.current += drift.current
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
      floor.dispose()
    }
  }, [gl, geometry, material, floor])

  useFrame(({ camera, clock, size }, delta) => {
    const dt = Math.min(delta, 1 / 30)
    const time = hero.still ? 3 : clock.elapsedTime
    const { progress, intro } = hero
    const aspect = size.width / size.height
    const scrolling = smooth(0, 0.004, progress)
    const peek = hero.peek * (1 - scrolling) // the box only breathes before the scroll begins
    const tick = clockAt(progress)

    // The box stops dead on the first scroll. The camera only squares up with the grid at the end.
    if (!hero.still && progress < 0.004) yaw.current += dt * 0.14
    yaw.current += drift.current * dt * 30
    drift.current *= Math.pow(0.03, dt)
    const REST = -0.62
    const quarter = Math.PI / 2
    if (progress < 0.004) yaw.current = REST + THREE.MathUtils.euclideanModulo(yaw.current - REST + quarter / 2, quarter) - quarter / 2
    const angle = lerp(lerp(yaw.current, REST, smooth(0, WAKE, progress)), 0, smooth(0.2, SETTLE_END, progress))
    turn.setFromAxisAngle(UP, angle)

    // Once every cube is parked the slab clicks into rows, then a pulse runs through the keys.
    const click = smooth(BOARD_AT, CLICK_END, progress)
    const boardZ = 0.5 * P // the keyboard sits half a cell in front of the box
    const pulse = (r: number) => {
      const t = progress - CLICK_END - r * 0.0035
      return t <= 0 || hero.still ? 0 : 0.5 * Math.exp(-t * 26) * Math.abs(Math.sin(t * 90))
    }

    // Camera: starts close and low on the box, ends high above a small board.
    const fitStart = Math.max(14, 5.4 / (0.74 * FOV_SCALE * Math.min(aspect, 1)))
    const boardWidth = 15 * P * (1 + SPREAD) + 2
    const fitEnd = Math.max(boardWidth / ((aspect < 0.85 ? 0.92 : 0.44) * FOV_SCALE * aspect), 34)
    const travel = smooth(SCOUT_END * (aspect < 0.85 ? 0.2 : 0.45), aspect < 0.85 ? BOARD_AT * 0.55 : SETTLE_END, progress)
    const distance = Math.exp(lerp(Math.log(fitStart), Math.log(fitEnd), travel))
    const look = lerp(0.52, 1.12, smooth(0.08, SETTLE_END, progress))
    target.set(0, 0, boardZ).multiplyScalar(travel).applyQuaternion(turn)
    target.y = lerp(0, -CUBE_SIZE / 2, travel)
    // The scout's landing is the only thing heavy enough to reach the camera.
    const landed = tick - SCOUT_LANDS
    if (landed > 0 && !hero.still) target.y += 0.07 * Math.exp(-landed * 5) * Math.sin(landed * 22)
    camera.position.set(
      target.x + (hero.pointerX * travel * distance) / 60,
      target.y + Math.sin(look) * distance,
      target.z + Math.cos(look) * distance,
    )
    camera.lookAt(target)
    camera.near = 1
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    leakAt.set(Math.sin(time * 0.31), Math.sin(time * 0.23 + 1) * 0.8, Math.cos(time * 0.27)).normalize()

    const offsets = offset.array as Float32Array
    const surfaces = surface.array as Float32Array
    const hides = hide.array as Float32Array
    const skins = skin.array as Float32Array

    let left = Infinity
    let right = -Infinity
    let back = Infinity
    let front = -Infinity

    cubes.forEach((cube, i) => {
      place(cube, tick, position, quat)

      // The scout leans out over the edge twice before it commits.
      if (i === scoutIndex && tick < 0 && !hero.still) {
        const move = cube.moves[0]
        const lean = Math.sin(((tick + ROCK_TICKS) / ROCK_TICKS) * Math.PI * 2)
        const a = lean * lean * (tick > -ROCK_TICKS / 2 ? 0.34 : 0.17)
        position.copy(swing.copy(move.from).sub(move.pivot).applyAxisAngle(move.axis, a)).add(move.pivot)
        quat.copy(spin.setFromAxisAngle(move.axis, a))
      }

      // Hover and keys are rails: a cube only ever moves straight along one axis.
      const open = progress < 0.02
      const done = progress > CLICK_END
      const pressed = done && hero.pressed.has(cube.code)
      let goal = pressed ? -0.26 : 0
      if (hero.pointerActive && !goal && (open ? cube.surface : done)) {
        point.copy(position).multiplyScalar(open ? 1.12 : 1).applyQuaternion(turn).project(camera)
        const near = Math.hypot((point.x - hero.pointerX) * aspect, point.y - hero.pointerY)
        const facing = !open || point.set(cube.rail[0], cube.rail[1], cube.rail[2]).applyQuaternion(turn).dot(camera.position) > 0
        if (facing) goal = smooth(HOVER_RADIUS * (open ? 2.4 : 1), HOVER_RADIUS * 0.3, near) * (open ? 0.42 : 0.5)
      }
      const velocity = liftVelocity.current
      velocity[i] += ((goal - lift.current[i]) * 190 - velocity[i] * 15) * dt
      lift.current[i] += velocity[i] * dt
      const h = lift.current[i]

      if (click > 0) {
        const row = cube.end[2]
        position.x += position.x * SPREAD * click + STAGGER[row] * P * click
        position.z += (position.z - boardZ) * SPREAD * click
      }

      left = Math.min(left, position.x)
      right = Math.max(right, position.x)
      back = Math.min(back, position.z)
      front = Math.max(front, position.z)

      if (open || progress < 0.03) {
        const rise = cube.surface ? (1 - smooth(0, 1, intro * 1.7 - i * 0.008)) * 6 : 0
        const out = rise + h * (1 - smooth(0.02, 0.03, progress))
        position.multiplyScalar(1 + peek * 0.09)
        position.x += cube.rail[0] * out
        position.y += cube.rail[1] * out
        position.z += cube.rail[2] * out
      }

      if (done) position.y += h + pulse(Math.hypot(position.x, position.z - boardZ) / P)

      position.applyQuaternion(turn)
      quat.premultiply(turn)

      const settled = smooth(cube.settled + 0.6, cube.settled + 3.2, tick)
      const finish = smooth(BOARD_AT, CLICK_END + 0.02, progress)
      const flood = cube.moves.length ? settled : finish
      point.set(position.x, position.y, position.z).normalize()
      const leak = smooth(0.62, 0.8, point.dot(leakAt) + peek * 0.3) * 0.9 * (1 - scrolling)
      const inner = Math.max(smooth(cube.wake, cube.wake + 2, tick), peek * 0.75)

      offsets[i * 3] = position.x
      offsets[i * 3 + 1] = position.y
      offsets[i * 3 + 2] = position.z
      quats.setXYZW(i, quat.x, quat.y, quat.z, quat.w)
      surfaces[i * 3] = Math.max(inner, flood)
      surfaces[i * 3 + 1] = lerp(TINT.blue, cube.tint, Math.max(smooth(cube.wake, cube.wake + 2, tick), flood))
      surfaces[i * 3 + 2] = clamp(h * 2) * (pressed ? 0 : 1) + (pressed ? 1 : 0)
      skins[i * 4 + 3] = Math.max(leak, flood)
      hides[i] = 1 - smooth(0, 0.5, intro)
    })

    offset.needsUpdate = true
    surface.needsUpdate = true
    hide.needsUpdate = true
    skin.needsUpdate = true
    quats.needsUpdate = true

    // The crowd pushes the frame open from the inside, so a cube never crosses a line.
    if (frame.current) {
      const box = CUBE_SIZE * 1.16
      const margin = (box - (CELLS - 1) * P) / 2
      const height = lerp(box, 1.5, smooth(TOTAL - 8, TOTAL, tick))
      frame.current.position.set((left + right) / 2, -CUBE_SIZE / 2 - 0.24 + height / 2, (back + front) / 2).applyQuaternion(turn)
      frame.current.quaternion.copy(turn)
      frame.current.scale.set((right - left + margin * 2) / box, height / box, (front - back + margin * 2) / box)
    }
    if (floorDots.current && floorGroup.current) {
      floorDots.current.opacity = smooth(0, 0.12, progress) * (1 - 0.8 * click) * 0.9
      floorDots.current.size = 2.4 * gl.getPixelRatio()
      floorGroup.current.quaternion.copy(turn)
    }

    material.uniforms.uTime.value = time
    material.uniforms.uTheme.value = hero.theme
    material.uniforms.uScale.value = 0.42
    material.uniforms.uBg.value.copy(color.lerpColors(DARK, CREAM, hero.theme))
  })

  return (
    <>
      <instancedMesh args={[geometry, material, count]} frustumCulled={false} />
      <group ref={floorGroup}>
        <points geometry={floor} frustumCulled={false}>
          <pointsMaterial ref={floorDots} color="#1C70EC" size={2} sizeAttenuation={false} transparent opacity={0} depthWrite={false} />
        </points>
      </group>
      <group ref={frame} />
      <Outline follow={frame} morph={false} />
    </>
  )
}
