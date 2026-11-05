import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { CUBE_SIZE, ROWS, TINT, tiles } from '../layout'
import { createLiquidMaterial } from '../scene/liquidMaterial'
import { Outline } from '../scene/Outline'

// The black box was a folded sheet, lined with liquid. It cracks along its edges, swings open
// on rigid hinges into a cross, then the flat tiles run on rails into a keyboard.
//
// Why nothing collides:
// Hinges: every face first slides clear along its own normal by CLEARANCE, and that slide decays
// with the cosine of the swing, so a thick face never cuts into the one it is hinged to. Walls keep
// to their own side of the box, so neighbouring walls never meet.
// Rails: tiles first move along x only, each staying in its row and keeping its order, then along
// z only, each staying in its column and keeping its order. The two stages never overlap in time.

const PITCH = CUBE_SIZE / 4
const SHELL = CUBE_SIZE / 2
const CLEARANCE = 0.21 // tile thickness plus a hair
const FLOOR = -1.4 // height of the unfolded sheet
const NET_Z = -1.5 // middle of the cross
const GRID = 16 // tiles per keyboard row
const KEY_GAP = 0.1
const ROW_GAP = 0.12
const DRAG_SPEED = 0.006
const HOVER_RADIUS = 0.05

// The film, in scroll progress.
const SQUARE_END = 0.05
const CRACK = [0.025, 0.06]
const LID_TEASE = [0.06, 0.075]
const LID = [0.085, 0.14]
const RIGHT = [0.125, 0.19]
const LEFT = [0.135, 0.2]
const FRONT = [0.17, 0.235]
const BACK = [0.205, 0.305]
const SLAM = lerp(BACK[0], BACK[1], 0.62)
const RAIL_ROWS = 0.31
const RAIL_COLUMNS = 0.39
const SEAT = [0.49, 0.54]
const SETTLE_END = 0.8

const FOV_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(14))
const DARK = new THREE.Color('#08090C')
const CREAM = new THREE.Color('#FFFCF0')
const UP = new THREE.Vector3(0, 1, 0)
const DOWN = new THREE.Vector3(0, -1, 0)

const shell = [
  ...tiles,
  ...tiles.slice(0, 16).map((tile) => ({
    ...tile,
    normal: DOWN,
    position: tile.position.clone().setY(-tile.position.y),
    quaternion: new THREE.Quaternion().setFromUnitVectors(UP, DOWN),
  })),
]
const count = shell.length
const FACE = { lid: 0, right: 1, left: 2, front: 3, back: 4, floor: 5 }

type Pose = { quaternion: THREE.Quaternion; position: THREE.Vector3 }
const pose = (): Pose => ({ quaternion: new THREE.Quaternion(), position: new THREE.Vector3() })

// A wall's normal, its hinge along the floor, and the axis that lays it outwards.
const walls = [FACE.right, FACE.left, FACE.front, FACE.back].map((face) => {
  const normal = shell[face * 16].normal
  return {
    face,
    normal,
    hinge: normal.clone().multiplyScalar(SHELL).addScaledVector(UP, -SHELL),
    axis: UP.clone().cross(normal).normalize(),
  }
})
const backWall = walls[3]
const lidHinge = backWall.normal.clone().multiplyScalar(SHELL).addScaledVector(UP, SHELL)

// Rotates about the hinge, with the clearance slide that disappears as the swing completes.
const swing = (out: Pose, hinge: THREE.Vector3, axis: THREE.Vector3, angle: number, slide: THREE.Vector3, amount: number) => {
  out.quaternion.setFromAxisAngle(axis, angle)
  out.position.copy(hinge).applyQuaternion(out.quaternion).negate().add(hinge)
  out.position.addScaledVector(slide, amount * Math.max(0, Math.cos(angle)))
}

const poseFaces = (poses: Pose[], crack: number, opened: (face: number) => number) => {
  for (const wall of walls) {
    swing(poses[wall.face], wall.hinge, wall.axis, opened(wall.face) * Math.PI * 0.5, wall.normal, CLEARANCE * crack)
  }
  // The lid is carried by the back wall, so the two fall as one tall panel.
  const lid = poses[FACE.lid]
  const back = poses[FACE.back]
  swing(lid, lidHinge, backWall.axis, opened(FACE.lid) * Math.PI * 0.5, UP, CLEARANCE * crack)
  lid.position.applyQuaternion(back.quaternion).add(back.position)
  lid.quaternion.premultiply(back.quaternion)
}

// Where each tile lands once the cross lies flat, as a cell of the sheet.
const flatPoses = shell.slice(0, 6).map(pose)
poseFaces(flatPoses, 0, () => 1)
const sheet = shell.map((tile, i) => {
  const face = Math.floor(i / 16)
  const at = tile.position.clone().applyQuaternion(flatPoses[face].quaternion).add(flatPoses[face].position)
  return { i, face, x: at.x, z: at.z, column: Math.round(at.x / PITCH + 5.5), row: Math.round(at.z / PITCH + 9.5) }
})

// Each sheet row takes the least used keyboard columns, in order, so a row never reorders itself.
// The widest rows go first, then the spine from its far ends inwards, which splits it down the middle.
const used = new Array<number>(GRID).fill(0)
const rowsOfSheet = Array.from({ length: 16 }, (_, row) => sheet.filter((cell) => cell.row === row).sort((a, b) => a.column - b.column))
const railTarget = new Array<number>(count).fill(0)
;[...rowsOfSheet]
  .sort((a, b) => b.length - a.length || Math.abs(b[0].row - 7.5) - Math.abs(a[0].row - 7.5))
  .forEach((cells) => {
    const columns = Array.from({ length: GRID }, (_, column) => column)
      .sort((a, b) => used[a] - used[b] || Math.abs(a - 7.5) - Math.abs(b - 7.5))
      .slice(0, cells.length)
      .sort((a, b) => a - b)
    cells.forEach((cell, n) => {
      railTarget[cell.i] = columns[n]
      used[columns[n]]++
    })
  })

// Keys wider than one tile, so every row fills all 16 columns.
const WIDE: Record<string, number> = {
  Escape: 2,
  Backspace: 3,
  Tab: 2,
  Backslash: 2,
  CapsLock: 2,
  Enter: 3,
  ShiftLeft: 3,
  ShiftRight: 2,
  Space: 6,
}
const BOARD_WIDTH = GRID * PITCH + KEY_GAP * 15
const BOARD_DEPTH = ROWS.length * (PITCH + ROW_GAP)

const seats = ROWS.flatMap((row, rowIndex) => {
  const gap = (BOARD_WIDTH - GRID * PITCH) / (row.length - 1)
  let column = 0
  return row.flatMap((code, k) => {
    const span = WIDE[code] ?? 1
    const start = column
    column += span
    return Array.from({ length: span }, (_, n) => ({
      code,
      column: start + n,
      rowIndex,
      x: (start + n - (GRID - 1) / 2) * PITCH + (k - (row.length - 1) / 2) * gap,
    }))
  })
})
const codes = [...new Set(seats.map((seat) => seat.code))]
const keyCentre = codes.map((code) => {
  const own = seats.filter((seat) => seat.code === code)
  return { x: own.reduce((sum, seat) => sum + seat.x, 0) / own.length, rowIndex: own[0].rowIndex }
})

// Tiles keep their order inside a column, so the second rail stage cannot cross either.
const slots = sheet.map((cell) => {
  const column = railTarget[cell.i]
  const above = sheet.filter((other) => railTarget[other.i] === column && other.row < cell.row).length
  const seat = seats.find((other) => other.column === column && other.rowIndex === above)!
  const key = codes.indexOf(seat.code)
  const centre = keyCentre[key]
  const seatZ = NET_Z + (above - (ROWS.length - 1) / 2) * (PITCH + ROW_GAP)
  return {
    ...cell,
    key,
    railX: (column - (GRID - 1) / 2) * PITCH,
    railZ: NET_Z + (above - (ROWS.length - 1) / 2) * PITCH,
    seatX: seat.x,
    seatZ,
    columnIndex: column,
    tint: Math.abs(centre.x * 0.55 - (above - 2.5) * (PITCH + ROW_GAP)) < 0.78 ? TINT.cream : TINT.blue,
  }
})

// Accelerates like a falling panel, lands, and rebounds once on its hinge.
const fall = (span: number[], progress: number, rebound = 0.09) => {
  const x = clamp((progress - span[0]) / (span[1] - span[0]))
  if (x < 0.62) return (x / 0.62) ** 2
  const u = (x - 0.62) / 0.38
  return 1 - rebound * 4 * u * (1 - u)
}

const heroQuat = new THREE.Quaternion()
const tileQuat = new THREE.Quaternion()
const point = new THREE.Vector3()
const target = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const color = new THREE.Color()

// The shared material, with one addition: the inner side of each tile has its own liquid amount.
const createLinedMaterial = () => {
  const material = createLiquidMaterial()
  material.vertexShader = material.vertexShader
    .replace('varying float vHide;', 'varying float vHide;\nattribute float aLining;\nvarying float vLining;')
    .replace('vHide = aHide;', 'vHide = aHide;\nvLining = aLining * (1.0 - smoothstep(-0.8, -0.4, normal.y));')
  material.fragmentShader = material.fragmentShader
    .replace('varying float vHide;', 'varying float vHide;\nvarying float vLining;')
    .replace('float amount = vSurface.x;', 'float amount = max(vSurface.x, vLining);')
  return material
}

export function Scene() {
  const { geometry, offset, surface, hide, lining } = useMemo(() => {
    const geometry = new RoundedBoxGeometry(1, 1, 1, 3, 0.2)
    const attribute = (name: string, itemSize: number) => {
      const buffer = new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize)
      geometry.setAttribute(name, buffer)
      return buffer
    }
    const offset = attribute('aOffset', 3)
    const surface = attribute('aSurface', 3)
    const hide = attribute('aHide', 1)
    const lining = attribute('aLining', 1)
    const sizes = attribute('aSize', 3)
    const quats = attribute('aQuat', 4)
    for (let i = 0; i < count; i++) {
      const tile = shell[i]
      sizes.setXYZ(i, tile.size.x, tile.size.y, tile.size.z)
      quats.setXYZW(i, tile.quaternion.x, tile.quaternion.y, tile.quaternion.z, tile.quaternion.w)
    }
    offset.setUsage(THREE.DynamicDrawUsage)
    surface.setUsage(THREE.DynamicDrawUsage)
    hide.setUsage(THREE.DynamicDrawUsage)
    lining.setUsage(THREE.DynamicDrawUsage)
    quats.setUsage(THREE.DynamicDrawUsage)
    return { geometry, offset, surface, hide, lining }
  }, [])
  const material = useMemo(createLinedMaterial, [])
  const frame = useRef<THREE.Group>(null)
  const gl = useThree((state) => state.gl)
  const poses = useMemo(() => shell.slice(0, 6).map(pose), [])

  const yaw = useRef(0.68)
  const spin = useRef(0)
  // Spring state: one per key, plus one per tile of the box for the opening hover.
  const keyHover = useRef(new Float32Array(codes.length))
  const keyVelocity = useRef(new Float32Array(codes.length))
  const keyLit = useRef(new Float32Array(codes.length))
  const tileHover = useRef(new Float32Array(count))
  const tileVelocity = useRef(new Float32Array(count))

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
    const peek = hero.peek * (1 - scrolling) // the box only breathes before the scroll begins

    // The box turns freely until the scroll, then squares up. It looks the same every quarter turn,
    // so the tiles only take the remainder and the same face always ends up as the lid.
    if (progress < 0.005) {
      if (!hero.still) yaw.current += dt * 0.14
      yaw.current += spin.current * dt * 30
    }
    spin.current *= Math.pow(0.03, dt)
    const turns = Math.round(yaw.current / (Math.PI / 2))
    const square = 1 - smooth(0, SQUARE_END, progress)
    heroQuat.setFromAxisAngle(UP, (yaw.current - turns * (Math.PI / 2)) * square)

    const crack = smooth(CRACK[0], CRACK[1], progress)
    const lidOpen = smooth(LID_TEASE[0], LID_TEASE[1], progress) * 0.07 + fall(LID, progress, 0.05) * 0.93
    poseFaces(poses, crack, (face) => {
      if (face === FACE.lid) return lidOpen
      if (face === FACE.right) return fall(RIGHT, progress)
      if (face === FACE.left) return fall(LEFT, progress)
      if (face === FACE.front) return fall(FRONT, progress)
      return fall(BACK, progress, 0.05)
    })

    // Everything lands at once: the tall panel hits and the whole sheet takes the blow.
    const sinceSlam = progress - SLAM
    const thud = sinceSlam > 0 ? -0.26 * Math.exp(-sinceSlam * 75) * Math.sin(sinceSlam * 240) : 0

    // Camera: starts close and low on the box, climbs to read the cross, ends far above a small board.
    const fitStart = Math.max(14, 5.4 / (0.74 * FOV_SCALE * Math.min(aspect, 1)))
    const fitNet = Math.max(13.2 / (0.82 * FOV_SCALE), 10 / (0.88 * FOV_SCALE * aspect))
    const fitEnd = Math.max(BOARD_WIDTH / ((aspect < 0.85 ? 0.7 : 0.38) * FOV_SCALE * aspect), fitNet * 1.15)
    const pull = smooth(0.03, 0.25, progress)
    const leave = smooth(RAIL_ROWS, SETTLE_END, progress)
    const distance = Math.exp(lerp(lerp(Math.log(fitStart), Math.log(fitNet), pull), Math.log(fitEnd), leave))
    const look = lerp(lerp(0.52, 0.86, smooth(0.04, 0.12, progress)), 1.2, smooth(0.16, 0.3, progress)) - leave * 0.08
    const travel = smooth(0.12, 0.3, progress)
    const shake = hero.still ? 0 : thud * 0.7
    target.set(0, FLOOR * travel, NET_Z * travel)
    camera.position.set(
      target.x + (hero.pointerX * leave * distance) / 60,
      target.y + Math.sin(look) * distance + shake,
      target.z + Math.cos(look) * distance,
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

    // Keys only exist once the sheet is flat. A pressed key dips on its own rail and lights up.
    const seated = smooth(SEAT[0], SEAT[1], progress)
    for (let k = 0; k < codes.length; k++) {
      const pressed = progress > BACK[1] && hero.pressed.has(codes[k])
      let goal = pressed ? -0.2 : 0
      if (!pressed && seated > 0.9 && hero.pointerActive) {
        const z = NET_Z + (keyCentre[k].rowIndex - (ROWS.length - 1) / 2) * (PITCH + ROW_GAP)
        goal = smooth(HOVER_RADIUS, HOVER_RADIUS * 0.3, project(keyCentre[k].x, FLOOR, z)) * 0.32
      }
      spring(keyHover.current, keyVelocity.current, k, goal)
      keyLit.current[k] = lerp(keyLit.current[k], pressed ? 1 : clamp(keyHover.current[k] * 3.2), 1 - Math.pow(0.0005, dt))
    }

    const offsets = offset.array as Float32Array
    const surfaces = surface.array as Float32Array
    const hides = hide.array as Float32Array
    const linings = lining.array as Float32Array
    const quats = geometry.getAttribute('aQuat') as THREE.InstancedBufferAttribute
    const lit = smooth(CRACK[0], LID[0], progress)
    const near = progress < 0.02 && hero.pointerActive

    for (let i = 0; i < count; i++) {
      const tile = shell[i]
      const slot = slots[i]
      const facePose = poses[slot.face]

      const lift = (1 - smooth(0, 1, intro * 1.7 - i * 0.0058)) * 7
      let hoverGoal = 0
      if (near) {
        point.copy(tile.position).applyQuaternion(heroQuat)
        const facing = point.dot(camera.position) > 0
        hoverGoal = facing ? smooth(0.22, 0.07, project(point.x, point.y, point.z)) : 0
      }
      spring(tileHover.current, tileVelocity.current, i, hoverGoal)
      const h = tileHover.current[i]
      const out = lift + peek * (0.4 + 0.2 * Math.sin(i * 2.4)) + h * 0.5

      point.copy(tile.position).addScaledVector(tile.normal, out)
      point.applyQuaternion(facePose.quaternion).add(facePose.position).applyQuaternion(heroQuat)

      // Rails: rows slide first, spine outwards. Then columns close, centre first. Then the keys seat.
      const row = Math.abs(slot.row - 7.5) / 7.5
      const rowRun = smooth(RAIL_ROWS + (1 - row) * 0.025, RAIL_ROWS + (1 - row) * 0.025 + 0.055, progress)
      const column = Math.abs(slot.columnIndex - 7.5) / 7.5
      const columnRun = smooth(RAIL_COLUMNS + column * 0.03, RAIL_COLUMNS + column * 0.03 + 0.07, progress)
      const x = point.x + (slot.railX - slot.x) * rowRun + (slot.seatX - slot.railX) * seated
      const z = point.z + (slot.railZ - slot.z) * columnRun + (slot.seatZ - slot.railZ) * seated
      const y = point.y + thud * (1 - seated) + keyHover.current[slot.key]

      tileQuat.copy(heroQuat).multiply(facePose.quaternion).multiply(tile.quaternion)
      quats.setXYZW(i, tileQuat.x, tileQuat.y, tileQuat.z, tileQuat.w)

      point.copy(tile.position).normalize().applyQuaternion(heroQuat)
      const leak = smooth(0.55, 0.98, point.dot(leakAt) + peek * 0.3) * 0.9 * (1 - scrolling)

      offsets[i * 3] = x
      offsets[i * 3 + 1] = y
      offsets[i * 3 + 2] = z
      surfaces[i * 3] = leak
      surfaces[i * 3 + 1] = lerp(TINT.blue, slot.tint, columnRun)
      surfaces[i * 3 + 2] = Math.max(h, keyLit.current[slot.key])
      hides[i] = 1 - smooth(0, 0.5, intro)
      linings[i] = lit
    }

    offset.needsUpdate = true
    surface.needsUpdate = true
    hide.needsUpdate = true
    lining.needsUpdate = true
    quats.needsUpdate = true

    // The frame stays a ghost of the box until the slam, then closes around the sheet like a jig.
    if (frame.current) {
      const flat = smooth(SLAM, SLAM + 0.05, progress)
      const close = smooth(RAIL_ROWS, SEAT[1], progress)
      const width = lerp(lerp(CUBE_SIZE * 1.16, 9.8, flat), BOARD_WIDTH + 0.8, close)
      const depth = lerp(lerp(CUBE_SIZE * 1.16, 12.8, flat), BOARD_DEPTH + 0.8, close)
      const height = lerp(CUBE_SIZE * 1.16, 0.7, flat)
      const across = turns % 2 === 0
      frame.current.position.set(0, lerp(0, FLOOR, flat) + thud, lerp(0, NET_Z, flat))
      frame.current.quaternion.setFromAxisAngle(UP, turns * (Math.PI / 2) + (yaw.current - turns * (Math.PI / 2)) * square)
      frame.current.scale.set(across ? width : depth, height, across ? depth : width).divideScalar(CUBE_SIZE * 1.16)
    }

    material.uniforms.uTime.value = time
    material.uniforms.uTheme.value = hero.theme
    material.uniforms.uScale.value = lerp(0.42, 0.72, lit) // tighter bands, so the flat sheet stays liquid
    material.uniforms.uSweep.value = lerp(-4, 4, clamp((progress - SEAT[0]) / 0.14))
    material.uniforms.uBg.value.copy(color.lerpColors(DARK, CREAM, hero.theme))
  })

  return (
    <>
      <instancedMesh args={[geometry, material, count]} frustumCulled={false} />
      <group ref={frame} />
      <Outline follow={frame} morph={false} />
    </>
  )
}
