import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { CUBE_SIZE, KEY_CUBE, ROWS, TINT, tiles } from '../layout'
import { createLiquidMaterial } from '../scene/liquidMaterial'
import { Outline } from '../scene/Outline'

// A small black box with a very long room inside it. One face turns to the camera and its rows
// draw back into the walls, and through the opening the room is there, in true perspective,
// with the keyboard hanging at the far end. The camera glides in at an even pace and stops.
//
// The room is real geometry in the same world as the box, seen by the same camera, so the parallax
// is simply correct. Only the depth buffer keeps it inside the opening, which needs no stencil
// (the Canvas has none) and no second pass, and the opening's edge keeps its antialiasing:
//   1. fill depth with "near" everywhere, 2. punch the opening back to "far",
//   3. draw the room and keys, which can now only land in the hole,
//   4. reset depth to "far", 5. write the opening's true depth, 6. draw the box as normal.
// Once the opening covers the whole screen the masks switch off and nothing on screen changes.

const BOX = CUBE_SIZE / 2
const WALL = 0.2 // tile thickness: what is left around the opening
const OPENING = BOX - WALL
const SINK = 0.24 // the rows drop off the face before they slide, so they clear the walls
const THRESHOLD = 1 // the plane of the opening, set back in the box so the rim has real depth
const CLEARANCE = 0.02 // the rows stop just inside the side walls
const ROW_TIME = 0.12

const ROOM = 12 // half width: the box's own four tiles a side, at eight times the size
const ROOM_TILE = ROOM / 2
const ROOM_FRONT = 3
const ROOM_BACK = -240
const BOARD_Z = -40
const BOARD_TILT = 0.62
const REST_DISTANCE = 20

const SQUARE_END = 0.14
const LEVEL_END = 0.4
const DOORS_START = 0.09
const ROOM_SPEED = 0.42 // the walls at the edge of the frame, against the rim on the way in
const JOURNEY_END = 0.97
const RAMP_IN = 0.05
const RAMP_OUT = 0.14
const MAX_RATE = 0.3 // scroll per second: a hard flick still plays out calmly

const DRAG_SPEED = 0.006
const HOVER_RADIUS = 0.04
const FOV_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(14))
const DARK = new THREE.Color('#08090C')
const CREAM = new THREE.Color('#FFFCF0')
const UP = new THREE.Vector3(0, 1, 0)
const SIDEWAYS = new THREE.Vector3(1, 0, 0)

// The layout has no underside, but a level camera looks at the rim of one.
const shellTiles = [
  ...tiles,
  ...tiles
    .filter((tile) => tile.normal.y > 0.5)
    .map((tile) => ({
      ...tile,
      normal: new THREE.Vector3(0, -1, 0),
      position: tile.position.clone().setY(-tile.position.y),
      quaternion: new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(0, -1, 0)),
    })),
]

const keys = ROWS.flatMap((row, rowIndex) =>
  row.map((code, column) => {
    const x = (column - (row.length - 1) / 2) * 0.5
    const y = ((ROWS.length - 1) / 2 - rowIndex) * 0.5
    return { code, x, y, tint: Math.abs(x * 0.55 + y) < 0.42 ? TINT.cream : TINT.blue }
  }),
)
const BOARD_SPAN = 15 * 0.5

const angleQuat = new THREE.Quaternion()
const squareQuat = new THREE.Quaternion()
const settleQuat = new THREE.Quaternion()
const tileQuat = new THREE.Quaternion()
const point = new THREE.Vector3()
const place = new THREE.Vector3()
const axis = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const look = new THREE.Vector3()
const color = new THREE.Color()

const buildInstances = (segments: number, count: number) => {
  const geometry = new RoundedBoxGeometry(1, 1, 1, segments, 0.2)
  const attribute = (name: string, itemSize: number) => {
    const buffer = new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize)
    buffer.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute(name, buffer)
    return buffer
  }
  return {
    geometry,
    offset: attribute('aOffset', 3),
    surface: attribute('aSurface', 3),
    hide: attribute('aHide', 1),
    size: attribute('aSize', 3),
    quat: attribute('aQuat', 4),
  }
}

// The shared shader with its tile seams on a dial: the box closes up to plain black, and keys have none.
const createKeyMaterial = (seam: number) => {
  const material = createLiquidMaterial()
  material.uniforms.uSeam = { value: seam }
  material.uniforms.uShine = { value: 1 }
  material.fragmentShader = material.fragmentShader
    .replace('uniform float uTime;', 'uniform float uTime;\n  uniform float uSeam;\n  uniform float uShine;')
    .replace('* 0.16; // each tile', '* 0.16 * uSeam; // each tile')
    .replace('gloss += fresnel * mix(uBlue * 0.34', 'gloss += fresnel * mix(uBlue * mix(0.05, 0.34, uSeam)') // the rim stays black
    .replace('uCream * highlight * (0.35', 'uCream * highlight * uShine * (0.35')
  return material
}

// Writes depth only. Depth clip -1 is nearest, 1 is farthest.
const screenVertex = /* glsl */ `
  uniform float uDepth;
  void main() {
    gl_Position = vec4(position.xy, uDepth, 1.0);
  }
`
const punchVertex = /* glsl */ `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w; // the outline of the opening, at the far plane
  }
`
const blankFragment = /* glsl */ `
  void main() {
    gl_FragColor = vec4(0.0);
  }
`
const createMask = (vertexShader: string, depth: number) =>
  new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: blankFragment,
    uniforms: { uDepth: { value: depth } },
    colorWrite: false,
    depthFunc: THREE.AlwaysDepth,
    side: THREE.DoubleSide,
  })

// Keys: a narrower sweep of the chrome, so faces hold their colour and only the edges catch the light.
const createSolidMaterial = () => {
  const material = createKeyMaterial(0)
  material.fragmentShader = material.fragmentShader.replace('reflected.y * 0.5 + 0.4 + field * 0.85', 'reflected.y * 0.5 + 0.05 + field * 0.25')
  return material
}

const roomVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vFace;
  void main() {
    vFace = -normal;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const roomFragment = /* glsl */ `
  uniform float uTheme;
  uniform float uTile;
  uniform float uRoom;
  uniform float uLight;
  uniform vec3 uBg;
  uniform vec3 uBlue;
  uniform vec3 uCream;
  varying vec3 vWorld;
  varying vec3 vFace;

  void main() {
    vec3 face = normalize(vFace);
    vec3 view = normalize(cameraPosition - vWorld);
    vec2 cell = vec2(abs(face.x) > 0.5 ? vWorld.y : vWorld.x, vWorld.z) / uTile;

    // The same seam as the box, the same share of a tile, thinning out with distance.
    vec2 width = fwidth(cell);
    vec2 edge = abs(fract(cell) - 0.5);
    vec2 line = smoothstep(0.5 - 0.016 - width, 0.5 - 0.016 + width, edge);
    float seam = max(line.x * (1.0 - smoothstep(0.06, 0.22, width.x)), line.y * (1.0 - smoothstep(0.02, 0.09, width.y)));
    seam *= step(abs(face.z), 0.5) * smoothstep(uLight, uLight + 130.0, vWorld.z); // the far end is only light

    // One quiet light at the far end. The room is black where you stand and lifts as it recedes.
    float glow = exp(-pow((vWorld.z - uLight) / 150.0, 2.0));
    float facing = abs(face.z) > 0.5 ? uRoom / length(cameraPosition - vWorld) : abs(dot(face, view)); // the end wall carries on from the side walls
    float graze = pow(1.0 - facing, 3.0);
    float lit = glow * mix(0.3, 1.0, graze);

    vec3 night = uBg + mix(uBlue, uCream, 0.12) * lit * 0.085 + uBlue * seam * glow * 0.03;

    // Light mode: the same room in paper, shaded by nothing but its own depth.
    vec3 paper = uCream * (1.0 - (1.0 - glow) * 0.18 * (0.4 + graze * 0.6));
    paper = mix(paper, uBlue, seam * 0.05);

    gl_FragColor = vec4(mix(night, paper, uTheme), 1.0);
    #include <colorspace_fragment>
  }
`

// The camera moves so that the picture changes at one speed, instead of the distance changing at
// one speed. pace(z) is how much world travel moves the picture by one screen height at z. On the
// way in that is the rim of the box, whose speed on screen climbs with the square of its nearness.
// Past the rim only the far walls are left, and they barely move, so the camera can open up.
const buildJourney = (start: number, rest: number, aspect: number) => {
  const widest = Math.max(aspect, 1)
  const halfScreen = FOV_SCALE * 0.5
  const rimGone = BOX - THRESHOLD + OPENING / (halfScreen * widest)
  const roomPace = (ROOM_SPEED * ROOM) / (halfScreen * widest * Math.min(aspect, 1) ** 1.5)
  const pace = (z: number) => {
    const distance = Math.max(z - BOX, rimGone)
    const rim = ((distance * distance * halfScreen) / OPENING) * lerp(0.2, 1, smooth(start * 0.62, start * 0.4, z))
    return lerp(rim, roomPace, smooth(BOX + rimGone / Math.sqrt(Math.min(aspect, 1)), BOX - 1, z))
  }
  const steps = 2000
  const total = new Float32Array(steps + 1)
  for (let i = 0; i < steps; i++) {
    const z = lerp(start, rest, (i + 0.5) / steps)
    total[i + 1] = total[i] + (start - rest) / steps / pace(z)
  }
  const table = new Float32Array(401)
  let at = 0
  table.forEach((_, i) => {
    const wanted = (i / 400) * total[steps]
    while (at < steps - 1 && total[at + 1] < wanted) at++
    const between = (wanted - total[at]) / (total[at + 1] - total[at])
    table[i] = lerp(start, rest, (at + between) / steps)
  })
  return { key: aspect, table }
}

// Constant speed with a short ease on and a longer one off, so nothing is compressed anywhere.
const glide = (t: number, on = RAMP_IN, off = RAMP_OUT) => {
  const speed = 1 / (1 - on / 2 - off / 2)
  if (t < on) return (speed * t * t) / (2 * on)
  if (t > 1 - off) return 1 - (speed * (1 - t) * (1 - t)) / (2 * off)
  return speed * (t - on / 2)
}

const sample = (table: Float32Array, t: number) => {
  const at = clamp(t) * (table.length - 1)
  const low = Math.floor(at)
  return lerp(table[low], table[Math.min(low + 1, table.length - 1)], at - low)
}

export function Scene() {
  const shell = useMemo(() => {
    const instances = buildInstances(3, shellTiles.length)
    shellTiles.forEach((tile, t) => instances.size.setXYZ(t, tile.size.x, tile.size.y, tile.size.z))
    return instances
  }, [])
  const solid = useMemo(() => {
    const instances = buildInstances(4, keys.length)
    keys.forEach((_, k) => {
      instances.size.setXYZ(k, KEY_CUBE, KEY_CUBE, KEY_CUBE)
      instances.quat.setXYZW(k, 0, 0, 0, 1)
    })
    return instances
  }, [])
  const shellMaterial = useMemo(() => createKeyMaterial(1), [])
  const solidMaterial = useMemo(createSolidMaterial, [])
  const roomMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: roomVertex,
        fragmentShader: roomFragment,
        side: THREE.BackSide,
        uniforms: {
          uTheme: { value: 0 },
          uTile: { value: ROOM_TILE },
          uRoom: { value: ROOM },
          uLight: { value: ROOM_BACK },
          uBg: { value: new THREE.Color() },
          uBlue: { value: new THREE.Color('#1C70EC') },
          uCream: { value: new THREE.Color('#FFFCF0') },
        },
      }),
    [],
  )
  const masks = useMemo(
    () => ({ near: createMask(screenVertex, -1), punch: createMask(punchVertex, 1), far: createMask(screenVertex, 1) }),
    [],
  )
  const doorway = useMemo(() => new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }), [])

  const shellMesh = useRef<THREE.InstancedMesh>(null)
  const room = useRef<THREE.Mesh>(null)
  const board = useRef<THREE.Group>(null)
  const mask = useRef<THREE.Group>(null)
  const frame = useRef<THREE.Group>(null)
  const outline = useRef<THREE.Group>(null)
  const gl = useThree((state) => state.gl)

  const shown = useRef(0)
  const journey = useRef({ key: 0, table: new Float32Array(2) })
  const yaw = useRef(0.68)
  const spin = useRef(0)
  const square = useRef(0)
  const lean = useRef({ x: 0, y: 0 })
  const keyHover = useRef(new Float32Array(keys.length))
  const keyVelocity = useRef(new Float32Array(keys.length))
  const tileHover = useRef(new Float32Array(shellTiles.length))
  const tileVelocity = useRef(new Float32Array(shellTiles.length))

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
      shell.geometry.dispose()
      solid.geometry.dispose()
      shellMaterial.dispose()
      solidMaterial.dispose()
      roomMaterial.dispose()
      doorway.dispose()
      for (const material of Object.values(masks)) material.dispose()
    }
  }, [gl, shell, solid, shellMaterial, solidMaterial, roomMaterial, doorway, masks])

  useFrame(({ camera, clock, size }, delta) => {
    const dt = Math.min(delta, 1 / 30)
    const time = hero.still ? 3 : clock.elapsedTime
    const { intro } = hero
    const aspect = size.width / size.height
    const lens = camera as THREE.PerspectiveCamera

    // A governor on top of the scrub: the film never plays faster than MAX_RATE, however hard the flick.
    if (hero.still) shown.current = hero.progress
    else {
      const wheel = Math.min(delta, 0.1)
      const step = (hero.progress - shown.current) * (1 - Math.exp(-wheel * 7))
      shown.current += clamp(step, -MAX_RATE * wheel, MAX_RATE * wheel)
    }
    const progress = shown.current
    const scrolling = smooth(0, 0.015, progress)
    const peek = hero.peek * (1 - scrolling) // the box only breathes before the scroll begins

    // The box turns freely until the scroll, then slows and brings the nearest face round.
    if (!hero.still && progress < 0.005) yaw.current += dt * 0.14
    yaw.current += spin.current * dt * 30
    spin.current *= Math.pow(0.03, dt)
    if (progress < 0.005) {
      yaw.current = Math.atan2(Math.sin(yaw.current), Math.cos(yaw.current))
      square.current = Math.round(yaw.current / (Math.PI / 2)) * (Math.PI / 2)
    }
    const angle = lerp(yaw.current, square.current, smooth(0.005, SQUARE_END, progress))
    angleQuat.setFromAxisAngle(UP, angle)
    squareQuat.setFromAxisAngle(UP, square.current)
    settleQuat.setFromAxisAngle(UP, angle - square.current)

    // The camera, at one on-screen speed from the first scroll to the end.
    const start = Math.max(14, 5.4 / (0.74 * FOV_SCALE * Math.min(aspect, 1)))
    const rest = BOARD_Z + REST_DISTANCE
    if (journey.current.key !== aspect) journey.current = buildJourney(start, rest, aspect)
    const along = sample(journey.current.table, glide(clamp(progress / JOURNEY_END)))
    const pitch = 0.52 * (1 - glide(clamp(progress / LEVEL_END), 0.3, 0.3))

    // The pointer leans the camera around the opening, which is what proves the room is real.
    const reach = 1 - Math.pow(0.02, dt)
    const leaning = hero.pointerActive && !hero.still
    lean.current.x = lerp(lean.current.x, leaning ? hero.pointerX : 0, reach)
    lean.current.y = lerp(lean.current.y, leaning ? hero.pointerY : 0, reach)
    const swing = Math.min(Math.abs(along - BOX) * 0.05, 1) * smooth(0.02, 0.08, progress)
    const inRoom = smooth(BOX + 1, BOX - 6, along)
    camera.position.set(
      lean.current.x * swing,
      Math.sin(pitch) * along + lean.current.y * swing,
      Math.cos(pitch) * along,
    )
    look.set(0, 0, inRoom * BOARD_Z)
    camera.lookAt(look)

    const camZ = camera.position.z
    lens.near = 0.1
    lens.far = 600
    lens.updateProjectionMatrix()
    camera.updateMatrixWorld()

    // Inside once the rim has left the frame on every side, so the switch cannot be seen.
    const spanY = (camZ - THRESHOLD) * FOV_SCALE * 0.5
    const spanX = spanY * aspect
    const inside = spanX + Math.abs(camera.position.x) < OPENING * 0.94 && spanY + Math.abs(camera.position.y) < OPENING * 0.94
    const opening = progress > DOORS_START
    if (mask.current) mask.current.visible = opening && !inside
    if (room.current) room.current.visible = opening || inside
    if (board.current) board.current.visible = opening || inside
    if (shellMesh.current) shellMesh.current.visible = !inside
    if (outline.current) outline.current.visible = !inside

    const pointerTo = (x: number, y: number, z: number) => {
      point.set(x, y, z).project(camera)
      return Math.hypot((point.x - hero.pointerX) * aspect, point.y - hero.pointerY)
    }
    const spring = (value: Float32Array, velocity: Float32Array, i: number, goal: number) => {
      velocity[i] += ((goal - value[i]) * 190 - velocity[i] * 15) * dt
      value[i] += velocity[i] * dt
    }

    if (!inside) {
      leakAt.set(Math.sin(time * 0.31), Math.sin(time * 0.23 + 1) * 0.8, Math.cos(time * 0.27)).normalize()
      shellTiles.forEach((tile, t) => {
        const lift = (1 - smooth(0, 1, intro * 1.7 - t * 0.007)) * 7
        const near = progress < 0.02 && hero.pointerActive
        point.copy(tile.position).applyQuaternion(angleQuat)
        const hoverGoal = near && point.dot(camera.position) > 0 ? smooth(0.22, 0.07, pointerTo(point.x, point.y, point.z)) : 0
        spring(tileHover.current, tileVelocity.current, t, hoverGoal)
        const h = tileHover.current[t]
        const out = lift + peek * (0.4 + 0.2 * Math.sin(t * 2.4)) + h * 0.5

        // Worked out in the squared-up box, so whichever face comes round is the door.
        place.copy(tile.position).addScaledVector(tile.normal, out).applyQuaternion(squareQuat)
        let hidden = 1 - smooth(0, 0.5, intro)
        let width = tile.size.x
        let deep = tile.size.z
        if (place.z > BOX - WALL && Math.abs(place.x) < BOX && Math.abs(place.y) < BOX && out < 0.01) {
          // Middle rows first, so the opening grows from a slot to a square, like an iris.
          const row = place.y > 0 ? (place.y < 0.75 ? 0 : 2) : place.y > -0.75 ? 1 : 3
          const move = clamp((progress - DOORS_START - row * 0.032) / ROW_TIME)
          const slide = smooth(0.14, 1, move) * (OPENING + CLEARANCE)
          place.z -= smooth(0, 0.2, move) * SINK

          // Each half row runs into the side wall, and is cut off by it, like a pocket door.
          const side = Math.sign(place.x)
          axis.copy(SIDEWAYS).applyQuaternion(tile.quaternion).applyQuaternion(squareQuat)
          const alongX = Math.abs(axis.x) > 0.5
          const half = (alongX ? tile.size.x : tile.size.z) / 2
          const inner = Math.abs(place.x) - half + slide
          const outer = Math.min(Math.abs(place.x) + half + slide, OPENING + CLEARANCE)
          const span = outer - inner
          if (span < 0.01) hidden = 1
          place.x = side * (inner + outer) / 2
          if (alongX) width = Math.max(span, 0.01)
          else deep = Math.max(span, 0.01)
        }
        place.applyQuaternion(settleQuat)
        shell.offset.setXYZ(t, place.x, place.y, place.z)
        tileQuat.copy(angleQuat).multiply(tile.quaternion)
        shell.quat.setXYZW(t, tileQuat.x, tileQuat.y, tileQuat.z, tileQuat.w)
        shell.size.setXYZ(t, width, tile.size.y, deep)
        const liquid = smooth(0.55, 0.98, point.copy(tile.position).normalize().applyQuaternion(angleQuat).dot(leakAt) + peek * 0.3) * 0.9 * (1 - scrolling)
        shell.surface.setXYZ(t, liquid, TINT.blue, h)
        shell.hide.setX(t, hidden)
      })
      shell.offset.needsUpdate = true
      shell.quat.needsUpdate = true
      shell.size.needsUpdate = true
      shell.surface.needsUpdate = true
      shell.hide.needsUpdate = true
    }
    if (frame.current) frame.current.quaternion.copy(angleQuat)

    // The keys hang still at the far end, the same size on every screen.
    const fit = (REST_DISTANCE * (aspect < 0.85 ? 0.82 : 0.46) * FOV_SCALE * aspect) / BOARD_SPAN
    if (board.current) {
      board.current.scale.setScalar(fit)
      board.current.updateMatrixWorld()
      const settled = progress > 0.9
      keys.forEach((key, k) => {
        const pressed = hero.pressed.has(key.code)
        point.set(key.x, key.y, 0).applyMatrix4(board.current!.matrixWorld)
        const near = settled && hero.pointerActive ? smooth(HOVER_RADIUS, HOVER_RADIUS * 0.4, pointerTo(point.x, point.y, point.z)) : 0
        spring(keyHover.current, keyVelocity.current, k, pressed ? -0.2 : near * 0.24)
        const bounce = keyHover.current[k]
        const heat = Math.max(clamp(Math.abs(bounce) * 4.5), pressed ? 1 : 0)
        solid.offset.setXYZ(k, key.x, key.y, bounce)
        solid.surface.setXYZ(k, 1, key.tint === TINT.blue ? lerp(TINT.blue, TINT.cream, heat) : lerp(TINT.cream, TINT.blue, heat), 0)
      })
      solid.offset.needsUpdate = true
      solid.surface.needsUpdate = true
    }

    const bg = color.lerpColors(DARK, CREAM, hero.theme)
    for (const material of [shellMaterial, solidMaterial]) {
      material.uniforms.uTime.value = time
      material.uniforms.uTheme.value = hero.theme
      material.uniforms.uScale.value = 0.2
      material.uniforms.uBg.value.copy(bg)
    }
    shellMaterial.uniforms.uSeam.value = 1 - smooth(0.02, DOORS_START, progress)
    shellMaterial.uniforms.uShine.value = 1 - smooth(DOORS_START, LEVEL_END, progress)
    solidMaterial.uniforms.uRadius.value = KEY_CUBE * 0.2
    roomMaterial.uniforms.uTheme.value = hero.theme
    roomMaterial.uniforms.uBg.value.copy(bg)
  })

  return (
    <>
      <group ref={mask}>
        <mesh material={masks.near} renderOrder={-9} frustumCulled={false}>
          <planeGeometry args={[2, 2]} />
        </mesh>
        <mesh material={masks.punch} position-z={THRESHOLD} renderOrder={-8} frustumCulled={false}>
          <planeGeometry args={[(OPENING + 0.01) * 2, (OPENING + 0.01) * 2]} />
        </mesh>
        <mesh material={masks.far} renderOrder={-3} frustumCulled={false}>
          <planeGeometry args={[2, 2]} />
        </mesh>
        <mesh material={doorway} position-z={THRESHOLD} renderOrder={-2} frustumCulled={false}>
          <planeGeometry args={[(OPENING + 0.01) * 2, (OPENING + 0.01) * 2]} />
        </mesh>
      </group>
      <mesh ref={room} material={roomMaterial} position-z={(ROOM_FRONT + ROOM_BACK) / 2} renderOrder={-7} frustumCulled={false}>
        <boxGeometry args={[ROOM * 2, ROOM * 2, ROOM_FRONT - ROOM_BACK]} />
      </mesh>
      <group ref={board} position-z={BOARD_Z} rotation-x={-BOARD_TILT}>
        <instancedMesh args={[solid.geometry, solidMaterial, keys.length]} frustumCulled={false} renderOrder={-6} />
      </group>
      <instancedMesh ref={shellMesh} args={[shell.geometry, shellMaterial, shellTiles.length]} frustumCulled={false} />
      <group ref={frame} />
      <group ref={outline}>
        <Outline follow={frame} morph={false} />
      </group>
    </>
  )
}
