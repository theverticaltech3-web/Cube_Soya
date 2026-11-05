// Bakes the impact and the landing with Rapier, verifies them, and writes src/concepts/meteor.data.ts.
// Run: node --experimental-strip-types scripts/bakeMeteor.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import RAPIER from '@dimforge/rapier3d-compat'
import * as data from '../src/concepts/meteor.data.ts'

const { SIZE, PITCH, COUNT, COLUMNS, ROWS, METEOR, METEOR_SLOT, SIM_YAW, SIM_FPS, FLOOR, RIM_HEIGHT, RIM_WIDTH, RIM_DEPTH, RIM_LAND, TRAY_X, TRAY_Z } = data
const { STRIKE_DIR, STRIKE_SPEED, STRIKE_START, IMPACT_POINT, cells, slotAt, introPose, meteorPoint, smooth, INTRO_TIME } = data

const DATA_FILE = new URL('../src/concepts/meteor.data.ts', import.meta.url)
const HZ = 480
const STEP = 1 / HZ
const SAMPLE_EVERY = HZ / SIM_FPS
const DURATION = 3.6
const BLEND = 0.22 // seconds of final clean up
const GRAVITY = 14
const COLLIDER_SKIN = 0.006 // colliders are slightly larger than the drawn cubes
const level = (slot) => (Math.round((slot[0] - slotAt(0, 0)[0]) / PITCH) + 2 * Math.round((slot[2] - slotAt(0, 0)[2]) / PITCH)) % 3
const STEER_FROM = 0.16
const RANGE = 18

await RAPIER.init()

let seed = 23
const random = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}

const yaw = { x: 0, y: Math.sin(SIM_YAW / 2), z: 0, w: Math.cos(SIM_YAW / 2) }
const rotateYaw = ([x, y, z]) => [x * Math.cos(SIM_YAW) + z * Math.sin(SIM_YAW), y, -x * Math.sin(SIM_YAW) + z * Math.cos(SIM_YAW)]
const starts = cells.map(rotateYaw)

const blast = cells.map((_, i) => {
  const [x, y, z] = starts[i]
  const dx = x - IMPACT_POINT[0]
  const dy = y - IMPACT_POINT[1]
  const dz = z - IMPACT_POINT[2]
  const d = Math.hypot(dx, dy, dz)
  const power = 3.2 + 7 / (0.8 + d * 0.55)
  return {
    v: [(dx / d) * power * 1.05 - 1.4 + (random() - 0.5) * 2, 4.6 + random() * 4.2 + Math.max(0, dy / d) * power * 0.25, (dz / d) * power * 0.4 + (random() - 0.5) * 1.6],
    at: [(random() - 0.5) * 0.5, (random() - 0.5) * 0.5, (random() - 0.5) * 0.5],
  }
})

const q = {
  mul: (a, b) => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }),
  conj: (a) => ({ x: -a.x, y: -a.y, z: -a.z, w: a.w }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w,
}

// The 24 rotations of a cube: identical cubes may land on any of them.
const symmetries = (() => {
  const r = Math.SQRT1_2
  const quarter = [
    { x: 0, y: 0, z: 0, w: 1 },
    { x: r, y: 0, z: 0, w: r },
    { x: 1, y: 0, z: 0, w: 0 },
    { x: -r, y: 0, z: 0, w: r },
    { x: 0, y: r, z: 0, w: r },
    { x: 0, y: -r, z: 0, w: r },
  ]
  const spin = [
    { x: 0, y: 0, z: 0, w: 1 },
    { x: 0, y: 0, z: r, w: r },
    { x: 0, y: 0, z: 1, w: 0 },
    { x: 0, y: 0, z: -r, w: r },
  ]
  return quarter.flatMap((a) => spin.map((b) => q.mul(a, b)))
})()

const nearestSymmetry = (rotation) => {
  let best = symmetries[0]
  let score = -1
  for (const s of symmetries) {
    const value = Math.abs(q.dot(s, rotation))
    if (value > score) {
      score = value
      best = s
    }
  }
  return best
}

// Runs the world. With no slots it stops early and reports where each cube would land.
function simulate(slots, predictOnly = false) {
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 })
  world.timestep = STEP
  world.integrationParameters.numSolverIterations = 8
  world.integrationParameters.normalizedPredictionDistance = 0.12
  world.integrationParameters.contact_natural_frequency = 160

  const half = SIZE / 2 + COLLIDER_SKIN
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(TRAY_X, FLOOR - 1, TRAY_Z))
  world.createCollider(RAPIER.ColliderDesc.cuboid(40, 1, 40).setRestitution(0.22).setFriction(0.5).setContactSkin(0.02), floor)

  const bodies = []
  for (let i = 0; i < COUNT; i++) {
    const isMeteor = i === METEOR
    const [x, y, z] = isMeteor ? STRIKE_START : starts[i]
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation(yaw).setCcdEnabled(true).setCanSleep(false)
    if (isMeteor) desc.setLinvel(STRIKE_DIR[0] * STRIKE_SPEED, STRIKE_DIR[1] * STRIKE_SPEED, STRIKE_DIR[2] * STRIKE_SPEED)
    const body = world.createRigidBody(desc)
    world.createCollider(RAPIER.ColliderDesc.cuboid(half, half, half).setDensity(1).setRestitution(0.18).setFriction(0.25), body)
    bodies.push(body)
  }

  const samples = []
  const rimStart = Math.round(RIM_LAND * HZ)
  const steps = Math.round((predictOnly ? STEER_FROM : DURATION) * HZ)

  for (let step = 0; step <= steps; step++) {
    const t = step * STEP

    if (step === 0) {
      bodies.forEach((body, i) => {
        const m = body.mass()
        if (i === METEOR) {
          body.setGravityScale(0.2, true) // it hangs longest, then drops at full weight into the last open slot
          body.setLinvel({ x: -1.2, y: 5.8, z: 0.4 }, true)
          body.setAngvel({ x: 7, y: 5, z: -9 }, true)
          return
        }
        const { v, at } = blast[i]
        const p = body.translation()
        body.applyImpulseAtPoint({ x: v[0] * m, y: v[1] * m, z: v[2] * m }, { x: p.x + at[0], y: p.y + at[1], z: p.z + at[2] }, true)
      })
    }

    if (step === rimStart) {
      const low = Math.min(...bodies.map((body) => body.translation().y))
      if (low < FLOOR + RIM_HEIGHT + 0.5) console.log('warning: a cube is already at rim height when the rim lands', low.toFixed(2))
      const rim = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(TRAY_X, FLOOR + RIM_HEIGHT / 2, TRAY_Z))
      const wall = (hx, hz, x, z) =>
        world.createCollider(RAPIER.ColliderDesc.cuboid(hx, RIM_HEIGHT / 2, hz).setTranslation(x, 0, z).setRestitution(0.1).setFriction(0.1).setContactSkin(0.02), rim)
      wall(0.1, RIM_DEPTH / 2 + 0.2, RIM_WIDTH / 2 + 0.1, 0)
      wall(0.1, RIM_DEPTH / 2 + 0.2, -RIM_WIDTH / 2 - 0.1, 0)
      wall(RIM_WIDTH / 2 + 0.2, 0.1, 0, RIM_DEPTH / 2 + 0.1)
      wall(RIM_WIDTH / 2 + 0.2, 0.1, 0, -RIM_DEPTH / 2 - 0.1)
    }

    if (slots && t > STEER_FROM) {
      const ramp = smooth(STEER_FROM, STEER_FROM + 0.5, t)
      if (bodies[METEOR].linvel().y < 0) bodies[METEOR].setGravityScale(1, true)
      bodies.forEach((body, i) => {
        const p = body.translation()
        const v = body.linvel()
        const w = body.angvel()
        const r = body.rotation()
        const m = body.mass()
        const slot = slots[i]

        const hold = FLOOR + 1.7 + level(slot) * 0.95 // neighbours wait at different heights, so they cannot wedge
        const above = p.y - hold - 1.4
        const eta = above > 0 ? (v.y + Math.sqrt(v.y * v.y + 2 * GRAVITY * above)) / GRAVITY : 0
        const gain = (above > 0 ? 12 : 40) * ramp
        const ax = gain * ((slot[0] - p.x) / (eta + 0.14) - v.x)
        const az = gain * ((slot[2] - p.z) / (eta + 0.14) - v.z)
        const off = Math.hypot(slot[0] - p.x, slot[2] - p.z)

        const goal = nearestSymmetry(r)
        let error = q.mul(goal, q.conj(r))
        if (error.w < 0) error = { x: -error.x, y: -error.y, z: -error.z, w: -error.w }
        const angle = 2 * Math.acos(Math.min(1, error.w))
        const scale = angle < 1e-5 ? 2 : angle / Math.sin(angle / 2)
        const wGain = (above > 0 ? 12 : 50) * ramp
        const wx = wGain * ((error.x * scale) / (eta + 0.12) - w.x)
        const wy = wGain * ((error.y * scale) / (eta + 0.12) - w.y)
        const wz = wGain * ((error.z * scale) / (eta + 0.12) - w.z)
        const inertia = (m * SIZE * SIZE) / 6

        // Not over the slot yet: hold above the neighbours instead of jamming between them.
        const askew = Math.max(off / 0.04, angle / 0.09) - 1
        const ay = p.y < hold && askew > 0 ? Math.min(1, askew) * (GRAVITY + 60 * (hold - p.y) - 16 * v.y) : 0
        body.applyImpulse({ x: m * ax * STEP, y: m * ay * STEP, z: m * az * STEP }, true)
        body.applyTorqueImpulse({ x: inertia * wx * STEP, y: inertia * wy * STEP, z: inertia * wz * STEP }, true)
      })
    }

    if (step % SAMPLE_EVERY === 0) {
      const frame = []
      for (const body of bodies) {
        const p = body.translation()
        const r = body.rotation()
        frame.push([p.x, p.y, p.z, r.x, r.y, r.z, r.w])
      }
      samples.push(frame)
    }
    world.step()
  }

  const velocities = bodies.map((body) => {
    const v = body.linvel()
    return [v.x, v.y, v.z]
  })
  const finals = bodies.map((body) => {
    const p = body.translation()
    const r = body.rotation()
    return { p: [p.x, p.y, p.z], r: { x: r.x, y: r.y, z: r.z, w: r.w } }
  })
  world.free()
  return { samples, velocities, finals }
}

// Min-cost assignment of cubes to slots, O(n^3).
function hungarian(cost) {
  const n = cost.length
  const u = new Float64Array(n + 1)
  const v = new Float64Array(n + 1)
  const match = new Int32Array(n + 1)
  const way = new Int32Array(n + 1)
  for (let i = 1; i <= n; i++) {
    match[0] = i
    let j0 = 0
    const minv = new Float64Array(n + 1).fill(Infinity)
    const used = new Uint8Array(n + 1)
    do {
      used[j0] = 1
      const i0 = match[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (current < minv[j]) {
          minv[j] = current
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[match[j]] += delta
          v[j] -= delta
        } else minv[j] -= delta
      }
      j0 = j1
    } while (match[j0] !== 0)
    do {
      const j1 = way[j0]
      match[j0] = match[j1]
      j0 = j1
    } while (j0)
  }
  const result = new Int32Array(n)
  for (let j = 1; j <= n; j++) result[match[j] - 1] = j - 1
  return result
}

const free = []
for (let row = 0; row < ROWS; row++) {
  for (let column = 0; column < COLUMNS; column++) {
    if (column !== METEOR_SLOT.column || row !== METEOR_SLOT.row) free.push(slotAt(column, row))
  }
}

const predict = simulate(null, true)
const landing = predict.finals.slice(0, METEOR).map(({ p }, i) => {
  const v = predict.velocities[i]
  const flight = (v[1] + Math.sqrt(v[1] * v[1] + 2 * GRAVITY * Math.max(0, p[1] - FLOOR))) / GRAVITY
  return [p[0] + v[0] * flight, p[2] + v[2] * flight]
})
const cost = landing.map(([x, z]) => free.map((slot) => (slot[0] - x) ** 2 + (slot[2] - z) ** 2))
const assignment = hungarian(cost)
const slots = [...assignment].map((j) => free[j])
slots.push(slotAt(METEOR_SLOT.column, METEOR_SLOT.row))

const { samples, finals, velocities } = simulate(slots)

let worstError = 0
let worstAngle = 0
let worstSpeed = 0
finals.forEach(({ p, r }, i) => {
  worstError = Math.max(worstError, Math.hypot(p[0] - slots[i][0], p[1] - slots[i][1], p[2] - slots[i][2]))
  worstAngle = Math.max(worstAngle, 2 * Math.acos(Math.min(1, Math.abs(q.dot(r, nearestSymmetry(r))))))
  worstSpeed = Math.max(worstSpeed, Math.hypot(...velocities[i]))
})
console.log(`unblended end: max slot error ${worstError.toFixed(4)}, angle ${worstAngle.toFixed(4)}, speed ${worstSpeed.toFixed(4)}`)

// Tiny clean up over the last frames.
const blendFrames = Math.round(BLEND * SIM_FPS)
const last = samples.length - 1
samples.forEach((frame, f) => {
  if (f <= last - blendFrames) return
  const k = smooth(last - blendFrames, last, f)
  frame.forEach((pose, i) => {
    const goal = nearestSymmetry(finals[i].r)
    const sign = q.dot(goal, { x: pose[3], y: pose[4], z: pose[5], w: pose[6] }) < 0 ? -1 : 1
    for (let c = 0; c < 3; c++) pose[c] += (slots[i][c] - pose[c]) * k
    pose[3] += (goal.x * sign - pose[3]) * k
    pose[4] += (goal.y * sign - pose[4]) * k
    pose[5] += (goal.z * sign - pose[5]) * k
    pose[6] += (goal.w * sign - pose[6]) * k
    const length = Math.hypot(pose[3], pose[4], pose[5], pose[6])
    for (let c = 3; c < 7; c++) pose[c] /= length
  })
})

// Quantise, then verify the decoded data rather than the sim.
const frames = samples.length
const positions = new Int16Array(frames * COUNT * 3)
const rotations = new Int16Array(frames * COUNT * 4)
samples.forEach((frame, f) => {
  frame.forEach((pose, i) => {
    const at = (f * COUNT + i) * 3
    const rt = (f * COUNT + i) * 4
    for (let c = 0; c < 3; c++) positions[at + c] = Math.round((pose[c] / RANGE) * 32767)
    let w = pose[6]
    let flip = 1
    if (f > 0) {
      const prev = (f - 1) * COUNT + i
      const dot = rotations[prev * 4] * pose[3] + rotations[prev * 4 + 1] * pose[4] + rotations[prev * 4 + 2] * pose[5] + rotations[prev * 4 + 3] * w
      if (dot < 0) flip = -1
    }
    for (let c = 0; c < 4; c++) rotations[rt + c] = Math.round(pose[3 + c] * flip * 32767)
  })
})

const poseAt = (time, i, out) => {
  const frame = Math.min(frames - 1.001, time * SIM_FPS)
  const a = Math.floor(frame)
  const k = frame - a
  const ia = (a * COUNT + i) * 3
  const ib = ((a + 1) * COUNT + i) * 3
  for (let c = 0; c < 3; c++) out.p[c] = ((positions[ia + c] + (positions[ib + c] - positions[ia + c]) * k) * RANGE) / 32767
  const ra = (a * COUNT + i) * 4
  const rb = ((a + 1) * COUNT + i) * 4
  let length = 0
  for (let c = 0; c < 4; c++) {
    const value = rotations[ra + c] + (rotations[rb + c] - rotations[ra + c]) * k
    out.q[c] = value
    length += value * value
  }
  length = Math.sqrt(length)
  for (let c = 0; c < 4; c++) out.q[c] /= length
}

const axes = (r, out) => {
  const [x, y, z, w] = r
  out[0] = 1 - 2 * (y * y + z * z)
  out[1] = 2 * (x * y + w * z)
  out[2] = 2 * (x * z - w * y)
  out[3] = 2 * (x * y - w * z)
  out[4] = 1 - 2 * (x * x + z * z)
  out[5] = 2 * (y * z + w * x)
  out[6] = 2 * (x * z + w * y)
  out[7] = 2 * (y * z - w * x)
  out[8] = 1 - 2 * (x * x + y * y)
}

// Separating axis test. Positive means disjoint, and is a lower bound on the true gap.
function gap(pa, a, ha, pb, b, hb) {
  const d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]
  let best = -Infinity
  const test = (x, y, z) => {
    const length = Math.hypot(x, y, z)
    if (length < 1e-6) return
    x /= length
    y /= length
    z /= length
    let ra = 0
    let rb = 0
    for (let k = 0; k < 3; k++) {
      ra += Math.abs(a[k * 3] * x + a[k * 3 + 1] * y + a[k * 3 + 2] * z) * ha[k]
      rb += Math.abs(b[k * 3] * x + b[k * 3 + 1] * y + b[k * 3 + 2] * z) * hb[k]
    }
    best = Math.max(best, Math.abs(d[0] * x + d[1] * y + d[2] * z) - ra - rb)
  }
  for (let k = 0; k < 3; k++) {
    test(a[k * 3], a[k * 3 + 1], a[k * 3 + 2])
    test(b[k * 3], b[k * 3 + 1], b[k * 3 + 2])
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const ax = a[i * 3]
      const ay = a[i * 3 + 1]
      const az = a[i * 3 + 2]
      const bx = b[j * 3]
      const by = b[j * 3 + 1]
      const bz = b[j * 3 + 2]
      test(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
    }
  }
  return best
}

const half = SIZE / 2
const halves = [half, half, half]
const reach = half * Math.sqrt(3) * 2 + 0.3

// Pairwise check of the decoded playback, at four times the sample rate.
let minimum = Infinity
let minimumAt = 0
let minimumPair = ''
let wallMinimum = Infinity
let floorMinimum = Infinity
const poses = Array.from({ length: COUNT }, () => ({ p: [0, 0, 0], q: [0, 0, 0, 1], a: new Float64Array(9) }))
const identity = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
const SUB = 4
const totalChecks = (frames - 1) * SUB
const walls = [
  { p: [TRAY_X + RIM_WIDTH / 2 + 0.1, FLOOR + RIM_HEIGHT / 2, TRAY_Z], h: [0.1, RIM_HEIGHT / 2, RIM_DEPTH / 2 + 0.2] },
  { p: [TRAY_X - RIM_WIDTH / 2 - 0.1, FLOOR + RIM_HEIGHT / 2, TRAY_Z], h: [0.1, RIM_HEIGHT / 2, RIM_DEPTH / 2 + 0.2] },
  { p: [TRAY_X, FLOOR + RIM_HEIGHT / 2, TRAY_Z + RIM_DEPTH / 2 + 0.1], h: [RIM_WIDTH / 2 + 0.2, RIM_HEIGHT / 2, 0.1] },
  { p: [TRAY_X, FLOOR + RIM_HEIGHT / 2, TRAY_Z - RIM_DEPTH / 2 - 0.1], h: [RIM_WIDTH / 2 + 0.2, RIM_HEIGHT / 2, 0.1] },
]
for (let check = 0; check <= totalChecks; check++) {
  const time = check / (SIM_FPS * SUB)
  poses.forEach((pose, i) => {
    poseAt(time, i, pose)
    axes(pose.q, pose.a)
  })
  for (let i = 0; i < COUNT; i++) {
    const a = poses[i]
    let bottom = Infinity
    for (let k = 0; k < 8; k++) {
      const sx = k & 1 ? 1 : -1
      const sy = k & 2 ? 1 : -1
      const sz = k & 4 ? 1 : -1
      bottom = Math.min(bottom, a.p[1] + (a.a[1] * sx + a.a[4] * sy + a.a[7] * sz) * half)
    }
    floorMinimum = Math.min(floorMinimum, bottom - FLOOR)
    if (time >= RIM_LAND) {
      for (const wall of walls) wallMinimum = Math.min(wallMinimum, gap(a.p, a.a, halves, wall.p, identity, wall.h))
    }
    for (let j = i + 1; j < COUNT; j++) {
      const b = poses[j]
      if (Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) > reach) continue
      const value = gap(a.p, a.a, halves, b.p, b.a, halves)
      if (value < minimum) {
        minimum = value
        minimumAt = time
        minimumPair = `${i}/${j}`
      }
    }
  }
}
console.log(`sim playback min separation ${minimum.toFixed(4)} at t=${minimumAt.toFixed(3)} pair ${minimumPair}, walls ${wallMinimum.toFixed(4)}, floor ${floorMinimum.toFixed(4)}`)

// Intro: same test on the analytic flight, in the box frame, at 120Hz.
let introMinimum = Infinity
let introAt = 0
const flight = Array.from({ length: 64 }, () => ({ x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, scale: 0, heat: 0, sky: 0, a: new Float64Array(9), p: [0, 0, 0] }))
for (const aspect of [16 / 9, 390 / 844]) {
  const skies = flight.map((_, i) => data.skyStar(i, aspect, [0, 0, 0]))
  for (let time = 0; time <= INTRO_TIME + 0.01; time += 1 / 120) {
    flight.forEach((pose, i) => {
      introPose(i, time, pose)
      pose.p = [0, 1, 2].map((c) => [pose.x, pose.y, pose.z][c] * (1 - pose.sky) + skies[i][c] * pose.sky)
      axes([pose.qx, pose.qy, pose.qz, pose.qw], pose.a)
    })
    for (let i = 0; i < 64; i++) {
      const a = flight[i]
      if (a.scale <= 0) continue
      for (let j = i + 1; j < 64; j++) {
        const b = flight[j]
        if (b.scale <= 0) continue
        if (Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) > ((a.scale + b.scale) / 2) * Math.sqrt(3) + 0.05) continue
        const value = gap(a.p, a.a, [a.scale / 2, a.scale / 2, a.scale / 2], b.p, b.a, [b.scale / 2, b.scale / 2, b.scale / 2])
        if (value < introMinimum) {
          introMinimum = value
          introAt = time
        }
      }
    }
  }
}
console.log(`intro min separation ${introMinimum.toFixed(4)} at t=${introAt.toFixed(3)}`)

// Idle frame: every edge, at its widest wobble, against the box with the peek open and rotation lag added.
{
  const reachOut = (1.5 * data.CELL + half) * 1.05
  const offsets = new Float32Array(24)
  const signs = [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]
  const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]
  let clearance = Infinity
  for (let time = 0; time < 240; time += 1 / 15) {
    const breath = data.frameBreath(time, offsets)
    const corners = signs.map(([sx, sy, sz], i) => {
      const x = (sx * data.OUTLINE_SIZE) / 2 * breath + offsets[i * 3]
      const y = (sy * data.OUTLINE_SIZE) / 2 * breath + offsets[i * 3 + 1]
      const z = (sz * data.OUTLINE_SIZE) / 2 * breath + offsets[i * 3 + 2]
      return [x, y, z]
    })
    for (let e = 0; e < edges.length; e += 2) {
      const a = corners[edges[e]]
      const b = corners[edges[e + 1]]
      for (let k = 0; k <= 24; k++) {
        const t = k / 24
        const dx = Math.max(Math.abs(a[0] + (b[0] - a[0]) * t) - reachOut, 0)
        const dy = Math.max(Math.abs(a[1] + (b[1] - a[1]) * t) - reachOut, 0)
        const dz = Math.max(Math.abs(a[2] + (b[2] - a[2]) * t) - reachOut, 0)
        clearance = Math.min(clearance, Math.hypot(dx, dy, dz))
      }
    }
  }
  console.log(`idle frame clearance to box ${clearance.toFixed(4)}`)
}

// Strike: the end of the meteor's approach against the finished box.
let strikeMinimum = Infinity
const yawAxes = new Float64Array(9)
axes([yaw.x, yaw.y, yaw.z, yaw.w], yawAxes)
const point = [0, 0, 0]
for (const aspect of [16 / 9, 390 / 844]) {
  const start = data.loneStar(aspect, [0, 0, 0])
  for (let u = 0.7; u < 1.0005; u += 0.0005) {
    meteorPoint(Math.min(u, 1), start, point)
    for (const cell of starts) strikeMinimum = Math.min(strikeMinimum, Math.hypot(point[0] - cell[0], point[1] - cell[1], point[2] - cell[2]) > 2.5 ? Infinity : gap(point, yawAxes, halves, cell, yawAxes, halves))
  }
}
console.log(`strike approach min separation ${strikeMinimum.toFixed(4)}`)

// Landing times, so the scene knows when the last thud happens.
const landed = new Float32Array(COUNT)
for (let i = 0; i < COUNT; i++) {
  for (let f = 0; f < frames; f++) {
    if (positions[(f * COUNT + i) * 3 + 1] * (RANGE / 32767) < FLOOR + SIZE / 2 + 0.25) {
      landed[i] = f / SIM_FPS
      break
    }
  }
}
const order = [...landed].sort((a, b) => a - b)
console.log(`first landing ${order[0].toFixed(2)}, median ${order[32].toFixed(2)}, last non meteor ${Math.max(...landed.slice(0, METEOR)).toFixed(2)}, meteor ${landed[METEOR].toFixed(2)}`)
const apex = Math.max(...samples.flatMap((frame) => frame.slice(0, METEOR).map((pose) => pose[1])))
console.log(`meteor apex ${Math.max(...samples.map((frame) => frame[METEOR][1])).toFixed(2)}`)
const spreadX = Math.max(...samples.flatMap((frame) => frame.map((pose) => Math.abs(pose[0]))))
const spreadZ = Math.max(...samples.flatMap((frame) => frame.map((pose) => Math.abs(pose[2]))))
console.log(`extent: apex ${apex.toFixed(2)}, |x| ${spreadX.toFixed(2)}, |z| ${spreadZ.toFixed(2)}`)

const encode = (array) => Buffer.from(array.buffer).toString('base64')
const bake = { frames, positions: encode(positions), rotations: encode(rotations), range: RANGE, landed: [...landed].map((v) => +v.toFixed(3)) }
const line = `export const BAKE = ${JSON.stringify(bake)}`
const source = readFileSync(DATA_FILE, 'utf8').replace(/^export const BAKE = .*$/m, line)
writeFileSync(DATA_FILE, source)
console.log(`wrote ${frames} frames, ${(line.length / 1024).toFixed(0)} KB`)
