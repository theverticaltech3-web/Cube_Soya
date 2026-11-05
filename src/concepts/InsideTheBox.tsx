import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { CUBE_SIZE, ROWS, TINT, tiles } from '../layout'
import { createLiquidMaterial } from '../scene/liquidMaterial'
import { Outline } from '../scene/Outline'

// The box is bigger on the inside. Its lid parts along the centre seam, and through the gap sits a
// shaft forty times wider than the box, built from the same tiles, with the keyboard far below.
// The shaft is a stack of square rings twisted into a vortex. Each ring only ever turns about the
// vertical axis inside its own horizontal slab, so rings cannot touch. They lock square as you fall.

const SCALE = 40 // the room is the box at this scale
const TILE = (CUBE_SIZE / 4) * SCALE
const TILE_GAP = 0.024 * SCALE
const TILE_DEPTH = 0.3 * SCALE
const ROOM_WIDTH = TILE * 4
const RINGS = 18

const LID_LIFT = 0.21 // clears the rim of the side walls before the doors slide
const GAP = 0.92 // half width of the seam once parted, the camera passes down its centre
const PORTAL_Y = CUBE_SIZE / 2 + 0.01
const PORTAL_DEPTH = CUBE_SIZE / 2 - 0.2 // stops at the inner face of the front and back walls
const FLOOR_Y = PORTAL_Y - RINGS * TILE - TILE_GAP

const KEY_SIZE = 3.4
const KEY_PITCH = 4
const KEY_FLOAT = 0.8 // room to press a key down without touching the floor
const KEY_Y = FLOOR_Y + KEY_SIZE / 2 + KEY_FLOAT

const SQUARE_END = 0.1
const LIFT_START = 0.085
const SLIDE_START = 0.115
const SLIDE_END = 0.2
const DIVE_START = 0.225
const LAND = 0.54
const LOCK_START = 0.32
const LOCK_END = 0.54
const LOCK_LENGTH = 0.035

const FOV = 28
const END_FOV = 58
const DRAG_SPEED = 0.006
const HOVER_RADIUS = 0.05
const FOV_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2))
const DARK = new THREE.Color('#08090C')
const CREAM = new THREE.Color('#FFFCF0')

const UP = new THREE.Vector3(0, 1, 0)

const keys = ROWS.flatMap((row, rowIndex) =>
  row.map((code, column) => {
    const x = (column - (row.length - 1) / 2) * KEY_PITCH
    const z = (rowIndex - (ROWS.length - 1) / 2) * KEY_PITCH
    return { code, x, z, tint: Math.abs(x * 0.55 - z) < KEY_PITCH * 0.85 ? TINT.cream : TINT.blue, reach: Math.hypot(x, z) / KEY_PITCH }
  }),
)

// One ring of the shaft: four cells per side. Walls on x stop short of the z walls, so corners never overlap.
const ringTiles = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)].flatMap((normal) => {
  const side = new THREE.Vector3(normal.z, 0, normal.x)
  return [-1.5, -0.5, 0.5, 1.5].map((cell) => ({
    normal,
    position: normal.clone().multiplyScalar(ROOM_WIDTH / 2 + TILE_DEPTH / 2).addScaledVector(side, cell * TILE),
    quaternion: new THREE.Quaternion().setFromUnitVectors(UP, normal.clone().negate()),
    cell,
  }))
})
const roomCount = RINGS * ringTiles.length + 16

const ringQuat = new THREE.Quaternion()
const tileQuat = new THREE.Quaternion()
const boxQuat = new THREE.Quaternion()
const euler = new THREE.Euler(0, 0, 0, 'YXZ')
const point = new THREE.Vector3()
const back = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const color = new THREE.Color()

// The shared shader plus an analytic portal: a fragment is only drawn if the ray to it crosses the seam.
const createRoomMaterial = (radius: number, scale: number, fog: number) => {
  const material = createLiquidMaterial()
  Object.assign(material.uniforms, { uPortal: { value: new THREE.Vector3(0, 0, 0) }, uCamY: { value: 99 }, uFog: { value: fog }, uPaper: { value: fog > 0 ? 1 : 0 }, uPearl: { value: fog > 0 ? 0 : 0.5 } })
  material.uniforms.uRadius.value = radius
  material.uniforms.uScale.value = scale
  material.uniforms.uSweep.value = 1e4
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        /* glsl */ `
        uniform vec3 uPortal; // x half width, y plane height, z half depth
        uniform float uFog;
        uniform float uPaper;
        uniform float uPearl;
        void main() {
          if (cameraPosition.y > uPortal.y) {
            float t = (uPortal.y - cameraPosition.y) / (vWorld.y - cameraPosition.y);
            vec3 hit = cameraPosition + (vWorld - cameraPosition) * t;
            if (abs(hit.x) > uPortal.x || abs(hit.z) > uPortal.z) discard;
          }`,
      )
      .replace(
        'gl_FragColor = vec4(mix(color, uBg, vHide), 1.0);',
        /* glsl */ `
        color *= mix(1.0, 0.36, smoothstep(0.5, 0.9, geometric.y)); // the floor stays near black
        float haze = (1.0 - exp(-length(vWorld - cameraPosition) * uFog)) * (1.0 - uTheme);
        // Black outside, paper inside: in light mode the shut tiles of the room turn cream with blue edges.
        vec3 paper = mix(uBg, uBlue, smoothstep(0.5, 1.0, vEdge) * 0.8 + fresnel * 0.1);
        color = mix(color, mix(paper, color, mask), uTheme * uPaper);
        color = mix(color, uCream, pearl * uPearl); // cream keys stay cream at this tiny size
        gl_FragColor = vec4(mix(color, uBg, max(vHide, haze * 0.92)), 1.0);`,
      )
  }
  material.customProgramCacheKey = () => 'inside-the-box-room'
  return material
}

const createInstances = (geometry: THREE.BufferGeometry, count: number) => {
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
    sizes: attribute('aSize', 3),
    quats: attribute('aQuat', 4),
  }
}

// Heavy mechanical settle: runs past square by a hair and comes back, a tumbler dropping into place.
const clunk = (t: number) => {
  const u = t - 1
  return 1 + 2.2 * u * u * u + 1.2 * u * u
}

export function Scene() {
  const box = useMemo(() => {
    const parts = createInstances(new RoundedBoxGeometry(1, 1, 1, 3, 0.2), tiles.length)
    tiles.forEach((tile, i) => {
      parts.sizes.setXYZ(i, tile.size.x, tile.size.y, tile.size.z)
      parts.quats.setXYZW(i, tile.quaternion.x, tile.quaternion.y, tile.quaternion.z, tile.quaternion.w)
    })
    return parts
  }, [])
  const room = useMemo(() => {
    const parts = createInstances(new RoundedBoxGeometry(1, 1, 1, 3, 0.2), roomCount)
    for (let i = 0; i < roomCount; i++) parts.sizes.setXYZ(i, TILE - TILE_GAP, TILE_DEPTH, TILE - TILE_GAP)
    // The floor never moves, so it is written once.
    for (let i = 0; i < 16; i++) {
      const at = roomCount - 16 + i
      parts.offset.setXYZ(at, ((i % 4) - 1.5) * TILE, FLOOR_Y - TILE_DEPTH / 2, (Math.floor(i / 4) - 1.5) * TILE)
      parts.quats.setXYZW(at, 0, 0, 0, 1)
      parts.surface.setXYZ(at, 0, TINT.blue, 0)
    }
    return parts
  }, [])
  const board = useMemo(() => {
    const parts = createInstances(new RoundedBoxGeometry(1, 1, 1, 3, 0.2), keys.length)
    for (let i = 0; i < keys.length; i++) {
      parts.sizes.setXYZ(i, KEY_SIZE, KEY_SIZE, KEY_SIZE)
      parts.quats.setXYZW(i, 0, 0, 0, 1)
    }
    return parts
  }, [])

  const boxMaterial = useMemo(createLiquidMaterial, [])
  const roomMaterial = useMemo(() => createRoomMaterial(0.055 * SCALE, 0.42 / SCALE, 0.0026), [])
  const boardMaterial = useMemo(() => createRoomMaterial(0.32, 0.1, 0), [])
  const portalMaterial = useMemo(() => new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }), [])

  const frame = useRef<THREE.Group>(null)
  const outline = useRef<THREE.Group>(null)
  const boxMesh = useRef<THREE.InstancedMesh>(null)
  const portal = useRef<THREE.Mesh>(null)
  const roomMesh = useRef<THREE.InstancedMesh>(null)
  const boardMesh = useRef<THREE.InstancedMesh>(null)
  const gl = useThree((state) => state.gl)

  const yaw = useRef(0.68)
  const spin = useRef(0)
  const keyHover = useRef(new Float32Array(keys.length))
  const keyVelocity = useRef(new Float32Array(keys.length))
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
      if (dragging && hero.progress < 0.01) {
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
      for (const parts of [box, room, board]) parts.geometry.dispose()
      for (const material of [boxMaterial, roomMaterial, boardMaterial, portalMaterial]) material.dispose()
    }
  }, [gl, box, room, board, boxMaterial, roomMaterial, boardMaterial, portalMaterial])

  useFrame(({ camera, clock, size }, delta) => {
    const dt = Math.min(delta, 1 / 30)
    const time = hero.still ? 3 : clock.elapsedTime
    const { progress, intro } = hero
    const aspect = size.width / size.height
    const tall = aspect < 0.85
    const lens = camera as THREE.PerspectiveCamera
    const scrolling = smooth(0, 0.015, progress)
    const peek = hero.peek * (1 - scrolling) // the box only breathes before the scroll begins

    // Free turn until the scroll, then the seam squares up with the camera.
    if (!hero.still && progress < 0.005) yaw.current += dt * 0.14
    yaw.current += spin.current * dt * 30
    spin.current *= Math.pow(0.03, dt)
    if (progress < 0.005) yaw.current = Math.atan2(Math.sin(yaw.current), Math.cos(yaw.current))
    const square = Math.round(yaw.current / Math.PI) * Math.PI
    const angle = lerp(yaw.current, square, smooth(0.005, SQUARE_END, progress))
    boxQuat.setFromAxisAngle(UP, angle)

    // Door travel: lift off the rim, then slide apart over the walls.
    const lift = smooth(LIFT_START, SLIDE_START, progress) * LID_LIFT
    const slideT = clamp((progress - SLIDE_START) / (SLIDE_END - SLIDE_START))
    const slide = (1 - Math.pow(1 - slideT, 3)) * GAP

    // Camera: over the top, hold on the reveal, then fall. Gravity first, heavy braking at the end.
    const landed = smooth(LAND, 0.86, progress)
    const fitStart = Math.max(14, 5.4 / (0.74 * FOV_SCALE * Math.min(aspect, 1)))
    const endScale = 2 * Math.tan(THREE.MathUtils.degToRad(END_FOV / 2))
    const endHeight = ROOM_WIDTH / ((tall ? 0.86 : 0.6) * endScale * Math.min(aspect, 1)) // the floor sits square in the frame
    // The tilt comes off during the hold, and the far keyboard slides into line with the seam.
    const reveal = smooth(0.012, SQUARE_END, progress) * (1 - smooth(SLIDE_END - 0.05, SLIDE_END + 0.015, progress))
    const over = lerp(0.52, Math.PI / 2, smooth(0.01, 0.1, progress))
    const pitch = over - reveal * 0.2 - smooth(LAND - 0.1, LAND, progress) * (1 - landed) * 0.3

    const fallT = clamp((progress - DIVE_START) / (LAND - DIVE_START))
    const eased = fallT * fallT * fallT * (fallT * (6 * fallT - 15) + 10) // smootherstep starts and ends flat
    const fall = lerp(eased, Math.pow(eased, 1.6), 1 - fallT)
    const outside = Math.sin(pitch) * lerp(fitStart, fitStart * 0.72, smooth(SLIDE_END - 0.04, DIVE_START, progress))
    const y = lerp(outside, KEY_Y + endHeight * lerp(0.62, 1, landed), fall) // a low stop, then the crane up shows the whole room

    const rush = smooth(0.255, 0.31, progress) * (1 - smooth(0.42, LAND, progress))
    lens.fov = lerp(lerp(FOV, END_FOV, smooth(0.42, LAND, progress)), 84, rush)

    const roll = smooth(DIVE_START + 0.03, LAND + 0.02, progress) * (tall ? Math.PI * 1.5 : Math.PI * 2)
    euler.set(-pitch, roll, 0)
    camera.quaternion.setFromEuler(euler)
    back.set(0, 0, 1).applyQuaternion(camera.quaternion)
    const anchor = progress < DIVE_START + 0.05 ? 0 : KEY_Y
    const sway = (1 - smooth(DIVE_START, DIVE_START + 0.03, progress)) * smooth(SQUARE_END, SLIDE_END, progress) * 1.6
    camera.position.set(
      (back.x / back.y) * (y - anchor) + hero.pointerX * (sway + landed * 8),
      y,
      (back.z / back.y) * (y - anchor) - hero.pointerY * sway,
    )

    const inside = y < PORTAL_Y
    lens.near = inside ? 0.5 : clamp((y - PORTAL_Y) * 0.2, 0.05, 1)
    lens.far = 1600
    lens.updateProjectionMatrix()
    camera.updateMatrixWorld()

    const project = (x: number, yy: number, z: number) => {
      point.set(x, yy, z).project(camera)
      return Math.hypot((point.x - hero.pointerX) * aspect, point.y - hero.pointerY)
    }
    const spring = (value: Float32Array, velocity: Float32Array, i: number, goal: number) => {
      velocity[i] += ((goal - value[i]) * 190 - velocity[i] * 15) * dt
      value[i] += velocity[i] * dt
    }

    // The box.
    const showRoom = lift > 0
    if (boxMesh.current) boxMesh.current.visible = !inside
    if (roomMesh.current) roomMesh.current.visible = showRoom
    if (boardMesh.current) boardMesh.current.visible = showRoom
    if (outline.current) outline.current.visible = !inside
    if (portal.current) {
      portal.current.visible = showRoom && !inside
      portal.current.position.set(0, PORTAL_Y, 0)
      portal.current.scale.set(Math.max(slide, 0.001) * 2, PORTAL_DEPTH * 2, 1)
    }

    if (!inside) {
      leakAt.set(Math.sin(time * 0.31), Math.sin(time * 0.23 + 1) * 0.8, Math.cos(time * 0.27)).normalize()
      const offsets = box.offset.array as Float32Array
      const surfaces = box.surface.array as Float32Array
      const hides = box.hide.array as Float32Array
      tiles.forEach((tile, t) => {
        const entry = (1 - smooth(0, 1, intro * 1.7 - t * 0.007)) * 7
        point.copy(tile.position).applyQuaternion(boxQuat)
        const near = progress < 0.03 && hero.pointerActive && point.dot(camera.position) > 0
        spring(tileHover.current, tileVelocity.current, t, near ? smooth(0.22, 0.07, project(point.x, point.y, point.z)) : 0)
        const h = tileHover.current[t]
        const out = entry + peek * (0.4 + 0.2 * Math.sin(t * 2.4)) + h * 0.5

        point.copy(tile.position).addScaledVector(tile.normal, out)
        const isLid = tile.normal.y > 0.5
        if (isLid) {
          point.y += lift
          point.x += Math.sign(point.x) * slide
        }
        point.applyQuaternion(boxQuat)
        offsets[t * 3] = point.x
        offsets[t * 3 + 1] = point.y
        offsets[t * 3 + 2] = point.z
        tileQuat.copy(boxQuat).multiply(tile.quaternion)
        box.quats.setXYZW(t, tileQuat.x, tileQuat.y, tileQuat.z, tileQuat.w)
        point.copy(tile.position).normalize().applyQuaternion(boxQuat)
        surfaces[t * 3] = smooth(0.55, 0.98, point.dot(leakAt) + peek * 0.3) * 0.9 * (1 - smooth(0, 0.03, progress))
        surfaces[t * 3 + 1] = TINT.blue
        surfaces[t * 3 + 2] = h
        hides[t] = 1 - smooth(0, 0.5, intro)
      })
      box.offset.needsUpdate = true
      box.surface.needsUpdate = true
      box.hide.needsUpdate = true
      box.quats.needsUpdate = true
    }

    if (frame.current) frame.current.quaternion.copy(boxQuat)

    // The room. Before the fall the rings hang twisted, and they lock square one after another.
    if (showRoom) {
      const offsets = room.offset.array as Float32Array
      const surfaces = room.surface.array as Float32Array
      const turning = hero.still ? 0 : time * 0.05
      const wave = (progress - LOCK_END) / 0.2 // chrome climbs the walls after the last ring locks
      for (let ring = 0; ring < RINGS; ring++) {
        const depth = ring / (RINGS - 1)
        const start = lerp(LOCK_START, LOCK_END - LOCK_LENGTH, depth)
        const locked = clunk(clamp((progress - start) / LOCK_LENGTH))
        const twist = ((ring + 1) * 0.26 + turning + progress * 5) * (1 - locked)
        ringQuat.setFromAxisAngle(UP, twist)
        const ringY = PORTAL_Y - (ring + 0.5) * TILE
        const climb = Math.exp(-Math.pow((1 - depth - wave) * 5, 2))
        ringTiles.forEach((tile, t) => {
          const i = ring * ringTiles.length + t
          point.copy(tile.position).applyQuaternion(ringQuat)
          offsets[i * 3] = point.x
          offsets[i * 3 + 1] = ringY
          offsets[i * 3 + 2] = point.z
          tileQuat.copy(ringQuat).multiply(tile.quaternion)
          room.quats.setXYZW(i, tileQuat.x, tileQuat.y, tileQuat.z, tileQuat.w)
          const band = Math.sin(t * 1.05 + ring * 0.62 + progress * 16 + time * 0.12)
          surfaces[i * 3] = Math.max(smooth(0.74, 1, band) * lerp(0.92, 0.5, landed), climb)
          surfaces[i * 3 + 1] = t % 7 === 0 && band > 0.74 ? TINT.cream : TINT.blue
        })
      }
      room.offset.needsUpdate = true
      room.surface.needsUpdate = true
      room.quats.needsUpdate = true

      // Keys only move on vertical rails. The last ring's impact jumps outwards through the board.
      const offsetsB = board.offset.array as Float32Array
      const surfacesB = board.surface.array as Float32Array
      keys.forEach((key, k) => {
        const swell = smooth(0.8, 1, Math.sin(key.x * 0.1 + key.z * 0.08 - time * 1.2)) * landed * 0.5
        let goal = hero.pressed.has(key.code) ? -KEY_FLOAT * 0.75 : 0
        if (hero.pointerActive && progress > LAND && !goal) goal = smooth(HOVER_RADIUS, HOVER_RADIUS * 0.3, project(key.x, KEY_Y, key.z)) * 2
        spring(keyHover.current, keyVelocity.current, k, goal)
        const t = progress - LOCK_END - key.reach * 0.004
        const jump = t > 0 ? 3 * Math.exp(-t * 34) * Math.abs(Math.sin(t * 90)) : 0
        offsetsB[k * 3] = key.x
        offsetsB[k * 3 + 1] = KEY_Y + Math.max(keyHover.current[k] + swell + jump, -KEY_FLOAT * 0.8)
        offsetsB[k * 3 + 2] = key.z
        surfacesB[k * 3] = 1
        surfacesB[k * 3 + 1] = key.tint
        surfacesB[k * 3 + 2] = Math.max(clamp(keyHover.current[k]), hero.pressed.has(key.code) ? 1 : 0)
      })
      board.offset.needsUpdate = true
      board.surface.needsUpdate = true
    }

    const background = color.lerpColors(DARK, CREAM, hero.theme)
    for (const material of [boxMaterial, roomMaterial, boardMaterial]) {
      material.uniforms.uTime.value = time
      material.uniforms.uTheme.value = hero.theme
      material.uniforms.uBg.value.copy(background)
    }
    boxMaterial.uniforms.uScale.value = 0.42
    for (const material of [roomMaterial, boardMaterial]) {
      material.uniforms.uPortal.value.set(slide, PORTAL_Y, PORTAL_DEPTH)
    }
  })

  return (
    <>
      {/* Order matters: the room paints through the seam, then the seam writes depth, so nothing of the box or frame shows inside it. */}
      <instancedMesh ref={roomMesh} args={[room.geometry, roomMaterial, roomCount]} frustumCulled={false} renderOrder={-3} />
      <instancedMesh ref={boardMesh} args={[board.geometry, boardMaterial, keys.length]} frustumCulled={false} renderOrder={-3} />
      <mesh ref={portal} rotation={[-Math.PI / 2, 0, 0]} material={portalMaterial} renderOrder={-2}>
        <planeGeometry />
      </mesh>
      <instancedMesh ref={boxMesh} args={[box.geometry, boxMaterial, tiles.length]} frustumCulled={false} renderOrder={-1} />
      <group ref={frame} />
      <group ref={outline}>
        <Outline follow={frame} morph={false} />
      </group>
    </>
  )
}
