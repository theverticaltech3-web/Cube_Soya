import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { CUBE_SIZE, ROWS, TINT } from '../layout'
import { createLiquidMaterial } from '../scene/liquidMaterial'
import { Outline } from '../scene/Outline'

// The box is a true 4x4x4 and the scroll cracks it like a safe. Quarter turns click home one at a
// time, then every layer turns at once, and each layer rides out on rails and drops into a keyboard.
//
// Why nothing can touch:
// - A cube is narrower than its cell, and a slice only ever sweeps its own slab.
// - Turns on different axes never overlap in time. Only the last turn runs together, on one axis.
// - Each layer stays at its own height while it unpacks. Its rows slide along x, keeping their order,
//   then its columns slide along z, keeping theirs. All layers then fall on parallel vertical rails
//   into 64 different slots, and finally whole rows shift along x in their own lanes.

const GRID = 4
const COUNT = GRID ** 3
const CELL = CUBE_SIZE / GRID
const TILE_WIDTH = CELL - 0.024
const TILE_THICKNESS = 0.2
const CORE = CELL - 0.05
const PITCH = CELL * 1.12
const FLOOR = -1.5 * CELL
const DRAG_SPEED = 0.006
const HOVER_RADIUS = 0.2

// Scroll timing. Everything is a pure function of progress, so scrolling back rewinds it exactly.
const OPEN = 0.022
const TURN = 0.05
const CLICK = 0.6 // the slice hits home this far through its turn
const MOVES = [
  { axis: 1, slab: 3, dir: -1, at: 0.024 },
  { axis: 0, slab: 0, dir: 1, at: 0.08 },
  { axis: 2, slab: 1, dir: -1, at: 0.136 },
  { axis: 0, slab: 2, dir: -1, at: 0.192 },
  // The one surprise: all four layers go at once, each the opposite way to the next.
  { axis: 1, slab: 0, dir: 1, at: 0.252 },
  { axis: 1, slab: 1, dir: -1, at: 0.26 },
  { axis: 1, slab: 2, dir: 1, at: 0.268 },
  { axis: 1, slab: 3, dir: -1, at: 0.276 },
]
const SQUARE_START = 0.25
const SQUARE_END = 0.325
const FALL_START = 0.33
const LAYER_DELAY = 0.016
const LANE_DELAY = 0.005
const SLIDE_X = 0.044
const SLIDE_Z = 0.034
const DROP_START = 0.478
const DROP = 0.024
const DROP_DELAY = 0.008
const SHIFT_START = 0.522
const SHIFT = 0.016
const SETTLE_END = 0.56

const FOV_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(14))
const DARK = new THREE.Color('#08090C')
const CREAM = new THREE.Color('#FFFCF0')
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
const UP = AXES[1]
const coord = (i: number) => (i - (GRID - 1) / 2) * CELL

// Wind up against the turn, fall into it, hit home, ring out. Always lands on exactly 1.
const heavy = (u: number) => {
  if (u <= 0) return 0
  if (u >= 1) return 1
  if (hero.still) return smooth(0, 1, u)
  if (u < 0.2) return -0.035 * Math.sin((Math.PI * u) / 0.2)
  if (u < CLICK) return ((u - 0.2) / (CLICK - 0.2)) ** 3
  const v = (u - CLICK) / (1 - CLICK)
  return 1 + 0.03 * Math.exp(-4 * v) * Math.sin(v * Math.PI * 3) * (1 - v)
}

// Rails: slow start, full speed, a stop with a small rebound.
const rail = (u: number) => {
  if (u <= 0) return 0
  if (u >= 1) return 1
  if (u < 0.8) return smooth(0, 1, u / 0.8)
  return 1 + 0.012 * Math.sin(((u - 0.8) / 0.2) * Math.PI)
}

const home = [...Array(COUNT).keys()].map((i) => {
  const ix = i % GRID
  const iy = Math.floor(i / GRID) % GRID
  const iz = Math.floor(i / GRID ** 2)
  return { ix, iy, iz, position: new THREE.Vector3(coord(ix), coord(iy), coord(iz)) }
})

const FACE_RANK = [1, 3, 2] // x, y, z

// Each cube is a core plus one black tile on every face that belongs to the skin of the box.
const parts = home.flatMap(({ position }, cube) => {
  const skin = [{ cube, core: true, local: new THREE.Vector3(), quaternion: new THREE.Quaternion(), size: new THREE.Vector3().setScalar(CORE) }]
  AXES.forEach((axis, a) => {
    const side = Math.sign(position.getComponent(a))
    if (Math.abs(position.getComponent(a)) < coord(GRID - 1) - 0.01) return
    const normal = axis.clone().multiplyScalar(side)
    const local = normal.clone().multiplyScalar(CELL / 2 - TILE_THICKNESS / 2)
    const span = [TILE_WIDTH, TILE_WIDTH, TILE_WIDTH]
    // Tiles meeting on a box edge interlock: y sits over z, and z over x.
    AXES.forEach((_, b) => {
      if (b === a || FACE_RANK[b] <= FACE_RANK[a]) return
      if (Math.abs(position.getComponent(b)) < coord(GRID - 1) - 0.01) return
      span[b] -= TILE_THICKNESS + 0.012
      local.setComponent(b, (-Math.sign(position.getComponent(b)) * (TILE_THICKNESS + 0.012)) / 2)
    })
    skin.push({
      cube,
      core: false,
      local,
      quaternion: new THREE.Quaternion().setFromUnitVectors(UP, normal),
      size: new THREE.Vector3(a === 0 ? span[1] : span[0], TILE_THICKNESS, a === 2 ? span[1] : span[2]),
    })
  })
  return skin
})
const count = parts.length

// Bake where every cube is after each move. poses[n] is the state after n moves.
const snap = (value: number) => Math.round(value / (CELL / 2)) * (CELL / 2)
const poses = [{ p: home.map(({ position }) => position.clone()), q: home.map(() => new THREE.Quaternion()) }]
const members = MOVES.map(({ axis, slab, dir }) => {
  const last = poses[poses.length - 1]
  const quarter = new THREE.Quaternion().setFromAxisAngle(AXES[axis], (dir * Math.PI) / 2)
  const inside = last.p.map((p) => Math.abs(p.getComponent(axis) - coord(slab)) < 0.01)
  poses.push({
    p: last.p.map((p, c) => {
      if (!inside[c]) return p
      const next = p.clone().applyQuaternion(quarter)
      return next.set(snap(next.x), snap(next.y), snap(next.z))
    }),
    q: last.q.map((q, c) => (inside[c] ? q.clone().premultiply(quarter).normalize() : q)),
  })
  return inside
})
const solved = poses[poses.length - 1]

// 64 keys, so the board is exactly the box: the number row down, without the function keys.
const boardRows = ROWS.slice(1).map((row) => row.filter((code) => code !== 'ContextMenu'))
const slots = boardRows.flatMap((row, rowIndex) =>
  row.map((code, index) => ({
    code,
    row: rowIndex,
    column: index + (14 - row.length) / 2 - (row.length === 13 ? 0.5 : 0),
    shift: row.length === 13 ? PITCH / 2 : 0, // the stagger, added last by sliding the whole row
  })),
)
const BOARD_WIDTH = 14 * PITCH
const BOARD_DEPTH = boardRows.length * PITCH

// Reading order, four keys to each row of cubes, top layer first. Same column, later row: the
// order along z can never swap, which is what keeps the rails clear.
const place = new Array<(typeof slots)[number] & { x: number; z: number; order: number; lane: number; tint: number }>(COUNT)
for (let order = 0; order < GRID; order++) {
  for (let lane = 0; lane < GRID; lane++) {
    const row = solved.p
      .map((p, cube) => ({ p, cube }))
      .filter(({ p }) => Math.abs(p.y - coord(GRID - 1 - order)) < 0.01 && Math.abs(p.z - coord(lane)) < 0.01)
      .sort((a, b) => a.p.x - b.p.x)
    const keys = slots.splice(0, GRID).sort((a, b) => a.column - b.column)
    row.forEach(({ cube }, i) => {
      const key = keys[i]
      const x = (key.column - 6.5) * PITCH
      const z = (key.row - (boardRows.length - 1) / 2) * PITCH
      const tint = Math.abs((x + key.shift) * 0.55 - z) < PITCH * 0.85 ? TINT.cream : TINT.blue
      place[cube] = { ...key, x, z, order, lane, tint }
    })
  }
}
const firstMove = home.map((_, c) => members.findIndex((inside) => inside[c]))
const clickAt = (m: number) => MOVES[m].at + TURN * CLICK
const dropAt = (order: number) => DROP_START + (GRID - 1 - order) * DROP_DELAY
// Every hit that should reach the camera.
const IMPACTS = [...MOVES.map((_, m) => clickAt(m)), ...[0, 1, 2].map((order) => dropAt(order) + DROP), SHIFT_START + SHIFT]

// Rigid pose of a cube at this point of the scroll, in the box's own frame.
const turning = new THREE.Quaternion()
function pieceAt(c: number, progress: number, position: THREE.Vector3, rotation: THREE.Quaternion) {
  let done = 0
  while (done < MOVES.length && progress >= MOVES[done].at + TURN) done++
  const pose = poses[done]
  position.copy(pose.p[c])
  rotation.copy(pose.q[c])

  for (let m = done; m < MOVES.length; m++) {
    const u = (progress - MOVES[m].at) / TURN
    if (u <= 0) break
    const { axis, slab, dir } = MOVES[m]
    if (Math.abs(position.getComponent(axis) - coord(slab)) > 0.01) continue
    turning.setFromAxisAngle(AXES[axis], (heavy(u) * dir * Math.PI) / 2)
    position.applyQuaternion(turning)
    rotation.premultiply(turning)
    break
  }

  if (progress > FALL_START) {
    const { order, lane, x, z, shift } = place[c]
    const start = FALL_START + order * LAYER_DELAY
    const alongX = rail((progress - start - lane * LANE_DELAY) / SLIDE_X)
    const alongZ = rail((progress - start - GRID * LANE_DELAY - SLIDE_X) / SLIDE_Z)
    const fall = clamp((progress - dropAt(order)) / DROP)
    const after = progress - dropAt(order) - DROP
    position.x = lerp(position.x, x, alongX) + shift * rail((progress - SHIFT_START) / SHIFT)
    position.z = lerp(position.z, z, alongZ)
    position.y = lerp(position.y, FLOOR, fall * fall)
    if (after > 0 && order < GRID - 1) position.y += 0.1 * Math.exp(-after * 130) * Math.abs(Math.sin(after * 190)) // lands, and hops
  }
}

const position = new THREE.Vector3()
const rotation = new THREE.Quaternion()
const partQuat = new THREE.Quaternion()
const bodyQuat = new THREE.Quaternion()
const recoilQuat = new THREE.Quaternion()
const point = new THREE.Vector3()
const facing = new THREE.Vector3()
const push = new THREE.Vector3()
const target = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const color = new THREE.Color()

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
    parts.forEach(({ size }, i) => sizes.setXYZ(i, size.x, size.y, size.z))
    offset.setUsage(THREE.DynamicDrawUsage)
    surface.setUsage(THREE.DynamicDrawUsage)
    hide.setUsage(THREE.DynamicDrawUsage)
    quats.setUsage(THREE.DynamicDrawUsage)
    return { geometry, offset, surface, hide, quats }
  }, [])
  const material = useMemo(createLiquidMaterial, [])
  const body = useRef<THREE.Group>(null)
  const frame = useRef<THREE.Group>(null)
  const gl = useThree((state) => state.gl)

  const yaw = useRef(0.68)
  const spin = useRef(0)
  const bounce = useRef(new Float32Array(COUNT))
  const velocity = useRef(new Float32Array(COUNT))

  useEffect(() => {
    const canvas = gl.domElement
    let dragging = false
    let lastX = 0
    const move = (event: PointerEvent) => {
      hero.pointerX = (event.clientX / window.innerWidth) * 2 - 1
      hero.pointerY = 1 - (event.clientY / window.innerHeight) * 2
      hero.pointerActive = true
      if (dragging && hero.progress < 0.005) {
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
    }
  }, [gl, geometry, material])

  useFrame(({ camera, clock, size }, delta) => {
    const dt = Math.min(delta, 1 / 30)
    const time = hero.still ? 3 : clock.elapsedTime
    const { progress, intro } = hero
    const aspect = size.width / size.height
    const scrolling = smooth(0, 0.012, progress)
    const peek = progress > 0.001 ? 0 : hero.peek // stops the instant the scroll starts

    if (progress < 0.005) {
      if (!hero.still) yaw.current += dt * 0.14
      yaw.current += spin.current * dt * 30
    }
    spin.current *= Math.pow(0.03, dt)

    // The closed box looks the same every quarter turn, so the idle spin can wrap. That means the
    // one move plan always starts from the same corner, and the board always lands facing the camera.
    const quarter = Math.PI / 2
    const wrapped = Math.floor(yaw.current / quarter) * quarter
    const angle = lerp(lerp(yaw.current - wrapped, Math.PI / 4, smooth(0, 0.02, progress)), 0, smooth(SQUARE_START, SQUARE_END, progress))
    bodyQuat.setFromAxisAngle(UP, angle)

    // A turning slice shoves the rest of the box the other way, and the click stops it dead.
    if (!hero.still) {
      for (let m = 0; m < MOVES.length - 4; m++) {
        const u = (progress - MOVES[m].at) / (TURN * CLICK)
        if (u > 0 && u < 1) bodyQuat.multiply(recoilQuat.setFromAxisAngle(AXES[MOVES[m].axis], -MOVES[m].dir * 0.075 * Math.sin(Math.PI * u) * u))
      }
    }
    if (body.current) body.current.quaternion.copy(bodyQuat)

    // Every click is a notch closer, like leaning in to the dial. Then the pull back.
    let notches = 0
    MOVES.forEach((_, m) => (notches += smooth(clickAt(m), clickAt(m) + 0.01, progress)))
    let knock = 0
    if (!hero.still) {
      for (const at of IMPACTS) {
        const t = progress - at
        if (t > 0 && t < 0.05) knock += Math.exp(-t * 120) * Math.sin(t * 420)
      }
    }

    const fitStart = Math.max(14, 5.4 / (0.74 * FOV_SCALE * Math.min(aspect, 1)))
    const fitEnd = Math.max((BOARD_WIDTH + 1) / ((aspect < 0.85 ? 0.76 : 0.46) * FOV_SCALE * aspect), 26)
    const travel = smooth(FALL_START - 0.05, aspect < 0.85 ? FALL_START + 0.035 : FALL_START + 0.09, progress) // the rails must stay on a phone screen
    const distance = Math.exp(lerp(Math.log(fitStart * Math.pow(0.965, notches)), Math.log(fitEnd), travel))
    const look = lerp(0.52, 1.14, smooth(SQUARE_START, SETTLE_END, progress))
    target.set(0, FLOOR * travel, 0)
    camera.position.set(
      target.x + (hero.pointerX * travel * distance) / 60,
      target.y + Math.sin(look) * distance + knock * 0.09,
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
    const rotations = quats.array as Float32Array
    const open = smooth(OPEN, OPEN + 0.02, progress)
    const boxLive = progress < 0.008
    const boardLive = progress > SETTLE_END - 0.02
    if (boxLive) facing.copy(camera.position).applyQuaternion(recoilQuat.copy(bodyQuat).invert())

    let index = 0
    for (let c = 0; c < COUNT; c++) {
      const key = place[c]
      pieceAt(c, progress, position, rotation)
      position.multiplyScalar(1 + peek * 0.13)

      // The box assembles layer by layer on the same rail it leaves by.
      const arrive = smooth(0, 1, intro * 1.7 - home[c].iy * 0.12)
      position.y += (1 - arrive) * (home[c].iy + 1) * 1.6

      // Hover and keys: the cube moves straight out of the box, or up and down in the board.
      let goal = 0
      push.set(0, 0, 0)
      if (boxLive || boardLive) {
        let aim = hero.pressed.has(key.code) ? 1 : 0
        if (hero.pointerActive && !aim) {
          point.copy(position).applyQuaternion(bodyQuat).project(camera)
          const away = Math.hypot((point.x - hero.pointerX) * aspect, point.y - hero.pointerY)
          aim = smooth(HOVER_RADIUS, HOVER_RADIUS * 0.3, away)
        }
        if (boxLive) {
          let best = 0.05
          AXES.forEach((axis, a) => {
            const v = position.getComponent(a)
            const side = facing.getComponent(a) * Math.sign(v)
            if (Math.abs(v) > coord(GRID - 1) - 0.01 && side > best) {
              best = side
              push.copy(axis).multiplyScalar(Math.sign(v))
            }
          })
          if (best === 0.05) aim = 0
        } else {
          push.set(0, hero.pressed.has(key.code) ? -0.55 : 1, 0)
        }
        goal = aim
      }
      velocity.current[c] += ((goal - bounce.current[c]) * 190 - velocity.current[c] * 15) * dt
      bounce.current[c] += velocity.current[c] * dt
      const hop = bounce.current[c]
      if (boxLive) position.addScaledVector(push, hop * 0.3 * (1 - smooth(0, 0.008, progress)))
      else if (boardLive) position.y += hop * push.y * 0.42

      // After the fall the board breathes on its vertical rails.
      if (progress > SHIFT_START) position.y += smooth(0.8, 1, Math.sin((key.x + key.shift) * 0.42 + key.z * 0.24 - time * 1.2)) * smooth(SHIFT_START, SETTLE_END + 0.1, progress) * 0.16

      // Light: a turned cube stays lit, and takes its color with it round the next turns.
      const first = firstMove[c]
      const lit = first < 0 ? 0 : smooth(clickAt(first) - 0.004, clickAt(first) + 0.01, progress)
      let flash = 0
      let flashTint = 0
      for (let m = 0; m < MOVES.length; m++) {
        if (!members[m][c]) continue
        const t = progress - clickAt(m)
        const f = t < -0.012 ? 0 : t < 0 ? 1 + t / 0.012 : Math.exp(-t * 48)
        if (f > flash) {
          flash = f
          flashTint = m % 2 ? TINT.cream : TINT.blue
        }
      }
      if (hero.still) flash *= 0.5
      const baseTint = lit > 0 ? (key.tint === TINT.cream ? lerp(TINT.cream, 1.68, hero.theme) : key.tint) : TINT.blue // cream keys must not vanish on cream
      const tint = lerp(baseTint, flashTint || baseTint, clamp(flash * 1.4))
      const pop = Math.max(flash, clamp(Math.abs(hop)))
      const hidden = 1 - smooth(0, 0.5, intro)

      for (; index < count && parts[index].cube === c; index++) {
        const part = parts[index]
        point.copy(part.local).applyQuaternion(rotation).add(position)
        offsets[index * 3] = point.x
        offsets[index * 3 + 1] = point.y
        offsets[index * 3 + 2] = point.z
        partQuat.copy(rotation).multiply(part.quaternion)
        rotations[index * 4] = partQuat.x
        rotations[index * 4 + 1] = partQuat.y
        rotations[index * 4 + 2] = partQuat.z
        rotations[index * 4 + 3] = partQuat.w

        let liquid = lit
        if (part.core) liquid = Math.max(lit, open, peek * 0.85)
        else if (scrolling < 1) {
          const leak = smooth(0.55, 0.98, point.applyQuaternion(bodyQuat).normalize().dot(leakAt) + peek * 0.3)
          liquid = Math.max(liquid, leak * 0.9 * (1 - scrolling))
        }
        surfaces[index * 3] = liquid
        surfaces[index * 3 + 1] = tint
        surfaces[index * 3 + 2] = pop
        hides[index] = hidden
      }
    }

    offset.needsUpdate = true
    surface.needsUpdate = true
    hide.needsUpdate = true
    quats.needsUpdate = true

    if (frame.current) {
      // Same frame as the box, then it opens out flat around the rails.
      frame.current.quaternion.setFromAxisAngle(UP, angle + wrapped)
      const wide = smooth(FALL_START - 0.04, FALL_START + 0.045, progress)
      const flat = smooth(DROP_START, SHIFT_START, progress)
      const box = CUBE_SIZE * 1.16
      const across = lerp(1, (BOARD_WIDTH + 1.4) / box, wide)
      const deep = lerp(1, (BOARD_DEPTH + 1.4) / box, wide)
      const sideways = Math.round(wrapped / quarter) % 2 !== 0 // the frame keeps its own quarter turns
      frame.current.scale.set(sideways ? deep : across, lerp(1, 1.5 / box, flat), sideways ? across : deep)
      frame.current.position.set(0, FLOOR * flat, 0)
    }

    material.uniforms.uTime.value = time
    material.uniforms.uTheme.value = hero.theme
    material.uniforms.uScale.value = 0.42
    material.uniforms.uSweep.value = lerp(-4, 4, smooth(DROP_START, SETTLE_END + 0.08, progress))
    material.uniforms.uBg.value.copy(color.lerpColors(DARK, CREAM, hero.theme))
  })

  return (
    <>
      <group ref={body}>
        <instancedMesh args={[geometry, material, count]} frustumCulled={false} />
      </group>
      <group ref={frame} />
      <Outline follow={frame} morph={false} />
    </>
  )
}
