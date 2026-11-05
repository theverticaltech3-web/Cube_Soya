import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { CUBE_SIZE, ROWS, TINT, tiles } from '../layout'
import { createLiquidMaterial } from '../scene/liquidMaterial'
import { Outline } from '../scene/Outline'

// The box never changes. Its reflection is a separate block of 64 cubes under the floor,
// and it stops agreeing with the box. 4 x 4 x 4 cubes are exactly the 64 keys of a compact board.
//
// Collision-free by construction, in three strictly ordered phases on axis rails:
// 1. Z: every column along z spreads into 5 planes, keeping its order. Columns share no lane.
// 2. X: inside a plane, each layer slides as one train at one speed, so its gaps only grow.
// 3. Y: every cube now has its own column in the plane, and drops straight down it.

const GRID = 4
const PITCH = CUBE_SIZE / GRID
const CUBE = PITCH - 0.024 // same size and gap as the tiles of the box
const KEY_PITCH = 0.86
const CENTER = 1.78 // the frame of the box just clears the floor
const BOARD_SHIFT = 0.85 // the board drifts toward the viewer, out from under the box
const PLATE = CENTER + 1.5 * PITCH // the deepest layer of the block: the keys land level with it
const OFFSET = (n: number, size: number) => n - (size - 1) / 2

const DRAG_SPEED = 0.006
const SCROLL_TURN = Math.PI * 1.5
const FOV_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(14))
const DARK = new THREE.Color('#08090C')
const CREAM = new THREE.Color('#FFFCF0')

// Timeline, in scroll progress.
const FREEZE_END = 0.05 // the reflection stops following
const Z_START = 0.1
const Z_TIME = 0.08
const X_START = 0.235
const X_TIME = 0.075
const Y_TIME = 0.05
const LOCK_START = 0.7
const LOCK_END = 0.85 // the box stops dead, and the board feels it

const fine = (t: number) => {
  const x = clamp(t)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

// How many of the 16 z columns leave a gap in each plane, giving rows of 14, 14, 13, 13, 10.
const SKIPS = [4, 4, 4, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 0, 0]
const LANE_ORDER = [0, 2, 3, 1] // shallow layers travel furthest, out to both sides
const ROW_SHIFT = [-0.25, 0.25, 0, 0.3, 0]
const LAST_ROW_SLOTS = [0, 1, 2, 3, 8, 9, 10, 11, 12, 13] // the gap is the space bar
const rows = ROWS.slice(1).map((row) => row.filter((code) => code !== 'ContextMenu'))

type Voxel = {
  position: THREE.Vector3
  direction: THREE.Vector3 // from the center of the block
  lane: number
  column: number
  plane: number
  code: string
  x: number
  z: number
  tint: number
  zStart: number
  xStart: number
  yStart: number
  land: number
  reach: number
}

const voxels: Voxel[] = []
for (let i = 0; i < GRID; i++) {
  for (let j = 0; j < GRID; j++) {
    const column = i + j * GRID
    const skip = SKIPS[(column * 7) % 16]
    for (let k = 0; k < GRID; k++) {
      const position = new THREE.Vector3(OFFSET(i, GRID) * PITCH, CENTER + OFFSET(j, GRID) * PITCH, OFFSET(k, GRID) * PITCH)
      voxels.push({
        position,
        direction: position.clone().setY(position.y - CENTER),
        lane: j,
        column,
        plane: k < skip ? k : k + 1,
        code: '',
        x: 0,
        z: 0,
        tint: TINT.blue,
        zStart: Z_START + (((column * 5) % 16) / 16) * 0.05,
        xStart: 0,
        yStart: 0,
        land: 0,
        reach: 0,
      })
    }
  }
}

rows.forEach((row, r) => {
  const inPlane = voxels
    .filter((voxel) => voxel.plane === r)
    .sort((a, b) => LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane) || a.position.x - b.position.x)
  inPlane.forEach((voxel, n) => {
    const slot = r === 4 ? LAST_ROW_SLOTS[n] : n
    const width = r === 4 ? 14 : row.length
    voxel.code = row[n]
    voxel.x = (OFFSET(slot, width) + ROW_SHIFT[r]) * KEY_PITCH
    const rowZ = OFFSET(r, rows.length) * KEY_PITCH
    voxel.z = rowZ + BOARD_SHIFT
    voxel.tint = Math.abs(voxel.x * 0.5 - rowZ) < 1.1 ? TINT.cream : TINT.blue
    voxel.xStart = X_START + r * 0.012 + LANE_ORDER.indexOf(voxel.lane) * 0.008
    voxel.yStart = X_START + X_TIME + r * 0.012 + 0.03 + Math.abs(voxel.x) * 0.002
    voxel.land = voxel.yStart + Y_TIME
    voxel.reach = Math.hypot(voxel.x, rowZ)
  })
})

const count = voxels.length
const LANDED = Math.max(...voxels.map((voxel) => voxel.land))
const BOARD_WIDTH = 15 * KEY_PITCH

// Which cube sits behind each tile, so the opening hover shows up in the reflection too.
const tileVoxel = tiles.map(({ position }) => {
  const away = voxels.map(({ direction }) => direction.clone().sub(position).length())
  return away.indexOf(Math.min(...away))
})

// The same material, drawn truly mirrored: everything is shaded as if above the floor, with the
// camera mirrored too, then flipped below the floor at the very end. So the two match to the pixel.
const createMirrorMaterial = () => {
  const material = createLiquidMaterial()
  material.side = THREE.BackSide // the flip reverses the winding
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('gl_Position = projectionMatrix * viewMatrix * world;', 'gl_Position = projectionMatrix * viewMatrix * vec4(world.x, -world.y, world.z, 1.0);')
      // A cube has no thin side like a tile does, so its seams glow from the rounded rims.
      .replace('vEdge = 1.0 - abs(normal.y);', 'vEdge = 1.0 - smoothstep(0.72, 0.995, max(abs(normal.x), max(abs(normal.y), abs(normal.z))));')
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 view = normalize(cameraPosition - vWorld);',
      'vec3 view = normalize(cameraPosition * vec3(1.0, -1.0, 1.0) - vWorld);',
    )
  }
  return material
}

const floorVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

// Dark glass: the reflection shows close to the object, the floor dissolves into the background.
const floorFragment = /* glsl */ `
  uniform vec3 uBg;
  uniform vec3 uBlue;
  uniform float uTheme;
  uniform float uGlass;
  varying vec3 vWorld;
  void main() {
    float r = length(vWorld.xz);
    float alpha = mix(uGlass, 1.0, smoothstep(9.0, 40.0, r));
    float pool = exp(-r * r * 0.012);
    vec3 color = uBg + uBlue * pool * mix(0.018, 0.0, uTheme);
    float contact = exp(-r * r * 0.22) * uTheme * 0.1; // a soft shadow under the box on the light floor
    gl_FragColor = vec4(color * (1.0 - contact), alpha);
    #include <colorspace_fragment>
  }
`

const point = new THREE.Vector3()
const target = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const realQuat = new THREE.Quaternion()
const mirrorQuat = new THREE.Quaternion()
const tileQuat = new THREE.Quaternion()
const UP = new THREE.Vector3(0, 1, 0)
const color = new THREE.Color()

const instanced = (cubes: number) => {
  const geometry = new RoundedBoxGeometry(1, 1, 1, 3, 0.2)
  const attribute = (name: string, itemSize: number) => {
    const buffer = new THREE.InstancedBufferAttribute(new Float32Array(cubes * itemSize), itemSize)
    geometry.setAttribute(name, buffer)
    return buffer
  }
  return {
    geometry,
    sizes: attribute('aSize', 3),
    offset: attribute('aOffset', 3).setUsage(THREE.DynamicDrawUsage),
    surface: attribute('aSurface', 3).setUsage(THREE.DynamicDrawUsage),
    hide: attribute('aHide', 1).setUsage(THREE.DynamicDrawUsage),
    quats: attribute('aQuat', 4).setUsage(THREE.DynamicDrawUsage),
  }
}

export function Scene() {
  const box = useMemo(() => {
    const parts = instanced(tiles.length)
    tiles.forEach((tile, t) => parts.sizes.setXYZ(t, tile.size.x, tile.size.y, tile.size.z))
    return parts
  }, [])
  const mirror = useMemo(() => {
    const parts = instanced(count)
    for (let v = 0; v < count; v++) parts.sizes.setXYZ(v, CUBE, CUBE, CUBE)
    return parts
  }, [])
  const material = useMemo(createLiquidMaterial, [])
  const mirrorMaterial = useMemo(createMirrorMaterial, [])
  const floorMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: floorVertex,
        fragmentShader: floorFragment,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uBg: { value: new THREE.Color('#08090C') },
          uBlue: { value: new THREE.Color('#1C70EC') },
          uTheme: { value: 0 },
          uGlass: { value: 0.4 },
        },
      }),
    [],
  )
  const realFrame = useRef<THREE.Group>(null)
  const mirrorFrame = useRef<THREE.Group>(null)
  const flipped = useRef<THREE.Group>(null)
  const gl = useThree((state) => state.gl)

  const yaw = useRef(0.68)
  const spin = useRef(0)
  const snap = useRef(0) // the quarter turn the reflection settles on, picked when the scroll starts
  const tileHover = useRef(new Float32Array(tiles.length))
  const tileVelocity = useRef(new Float32Array(tiles.length))
  const keyHover = useRef(new Float32Array(count))
  const keyVelocity = useRef(new Float32Array(count))
  const nudge = useRef(new Float32Array(count * 4)) // the box's hover, passed on to its reflection

  useEffect(() => {
    // Lines are single sided, and the flip turns them away from the camera.
    flipped.current?.traverse((part) => {
      if (part instanceof THREE.Mesh) part.material.side = THREE.DoubleSide
    })
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
      box.geometry.dispose()
      mirror.geometry.dispose()
      material.dispose()
      mirrorMaterial.dispose()
      floorMaterial.dispose()
    }
  }, [gl, box, mirror, material, mirrorMaterial, floorMaterial])

  useFrame(({ camera, clock, size }, delta) => {
    const dt = Math.min(delta, 1 / 30)
    const time = hero.still ? 3 : clock.elapsedTime
    const { progress, intro } = hero
    const aspect = size.width / size.height
    const scrolling = smooth(0, 0.015, progress)
    const peek = hero.peek * (1 - scrolling)

    // The box keeps turning, unaware, until the very end.
    if (!hero.still) yaw.current += dt * 0.14 * (1 - smooth(0.55, LOCK_START, progress))
    yaw.current += spin.current * dt * 30
    spin.current *= Math.pow(0.03, dt)
    if (progress < 0.005) {
      yaw.current = Math.atan2(Math.sin(yaw.current), Math.cos(yaw.current))
      snap.current = Math.round(yaw.current / (Math.PI / 2)) * (Math.PI / 2)
    }
    const square = Math.round(yaw.current / (Math.PI / 2)) * (Math.PI / 2)
    const realAngle = lerp(yaw.current, square, smooth(LOCK_START, LOCK_END, progress)) + fine(progress / LOCK_END) * SCROLL_TURN
    realQuat.setFromAxisAngle(UP, realAngle)

    // A cube looks the same every quarter turn, so the block matches by turning less than 45 degrees.
    const frozen = smooth(0.004, FREEZE_END, progress)
    mirrorQuat.setFromAxisAngle(UP, (yaw.current - snap.current) * (1 - frozen))

    // Camera: frames the box and its reflection, then rises and pulls back.
    const fitStart = Math.max(8.4 / (0.72 * FOV_SCALE), 4.8 / (0.72 * FOV_SCALE * aspect))
    const fitEnd = Math.max(BOARD_WIDTH / ((aspect < 0.85 ? 0.86 : 0.4) * FOV_SCALE * aspect), 9.5 / (0.8 * FOV_SCALE))
    const travel = smooth(0.04, 0.62, progress)
    // The frame opens faster than the camera travels, so a narrow screen makes room for it first.
    const open = fine((progress - Z_START) / 0.2)
    const room = (open * (BOARD_WIDTH + 0.9)) / (0.8 * FOV_SCALE * aspect)
    const distance = Math.max(Math.exp(lerp(Math.log(fitStart), Math.log(fitEnd), travel)), room)
    const look = lerp(0.46, 0.66, smooth(0.08, 0.6, progress))
    target.set(0, lerp(0.15, -0.7, travel), 0)
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

    const project = (x: number, y: number, z: number) => {
      point.set(x, y, z).project(camera)
      return Math.hypot((point.x - hero.pointerX) * aspect, point.y - hero.pointerY)
    }
    const spring = (value: Float32Array, velocity: Float32Array, i: number, goal: number) => {
      velocity[i] += ((goal - value[i]) * 190 - velocity[i] * 15) * dt
      value[i] += velocity[i] * dt
    }

    // The box itself: the same tiles and the same life as the opening of BoxKey.
    const offsets = box.offset.array as Float32Array
    const surfaces = box.surface.array as Float32Array
    const hides = box.hide.array as Float32Array
    const quats = box.quats.array as Float32Array
    const nudges = nudge.current
    nudges.fill(0)
    const appear = 1 - smooth(0, 0.5, intro)

    tiles.forEach((tile, t) => {
      const lift = (1 - smooth(0, 1, intro * 1.7 - t * 0.007)) * 7
      point.copy(tile.position).applyQuaternion(realQuat)
      const facing = point.dot(camera.position) > 0
      const near = progress < 0.2 && hero.pointerActive && facing
      spring(tileHover.current, tileVelocity.current, t, near ? smooth(0.22, 0.07, project(point.x, CENTER + point.y, point.z)) : 0)
      const h = tileHover.current[t]
      const out = lift + peek * (0.4 + 0.2 * Math.sin(t * 2.4)) + h * 0.5

      point.copy(tile.position).addScaledVector(tile.normal, out).applyQuaternion(realQuat)
      offsets[t * 3] = point.x
      offsets[t * 3 + 1] = CENTER + point.y
      offsets[t * 3 + 2] = point.z
      tileQuat.copy(realQuat).multiply(tile.quaternion)
      quats[t * 4] = tileQuat.x
      quats[t * 4 + 1] = tileQuat.y
      quats[t * 4 + 2] = tileQuat.z
      quats[t * 4 + 3] = tileQuat.w
      point.copy(tile.position).normalize().applyQuaternion(realQuat)
      surfaces[t * 3] = smooth(0.55, 0.98, point.dot(leakAt) + peek * 0.3) * 0.9
      surfaces[t * 3 + 1] = TINT.blue
      surfaces[t * 3 + 2] = h
      hides[t] = appear

      const v = tileVoxel[t] * 4
      nudges[v] += tile.normal.x * out
      nudges[v + 1] += tile.normal.y * out
      nudges[v + 2] += tile.normal.z * out
      nudges[v + 3] = Math.max(nudges[v + 3], h)
    })

    // The reflection: rigid cubes on rails.
    const mirrorOffsets = mirror.offset.array as Float32Array
    const mirrorSurfaces = mirror.surface.array as Float32Array
    const mirrorHides = mirror.hide.array as Float32Array
    const mirrorQuats = mirror.quats.array as Float32Array
    const follow = 1 - smooth(0.02, 0.1, progress) // the wandering leak dies in the reflection first
    const impactAt = (reach: number) => {
      const t = progress - LOCK_END - reach * 0.004
      return t <= 0 ? 0 : 0.42 * Math.exp(-t * 26) * Math.sin(t * 70)
    }

    voxels.forEach((voxel, v) => {
      const { position } = voxel
      const eZ = fine((progress - voxel.zStart) / Z_TIME)
      const eX = fine((progress - voxel.xStart) / X_TIME)
      const eY = fine((progress - voxel.yStart) / Y_TIME)
      const landed = progress - voxel.land

      let goal = hero.pressed.has(voxel.code) ? 0.4 : 0
      if (!goal && hero.pointerActive && progress > LANDED) goal = -smooth(0.075, 0.02, project(voxel.x, -PLATE, voxel.z)) * 0.7
      spring(keyHover.current, keyVelocity.current, v, progress > LANDED - 0.02 ? goal : 0)
      const hover = keyHover.current[v]
      const glow = clamp(Math.abs(hover) * 2.2)

      // A soft stop: the weight of the cube settling as it lands.
      const bounce = landed > 0 ? 0.16 * Math.exp(-landed * 70) * Math.sin(landed * 150) : 0

      point.set(
        lerp(position.x, voxel.x, eX) + nudges[v * 4],
        lerp(position.y, PLATE, eY) + nudges[v * 4 + 1] + bounce + hover + impactAt(voxel.reach),
        lerp(position.z, voxel.z, eZ) + nudges[v * 4 + 2],
      )
      // Before it moves, the block turns as one rigid body with the box.
      point.setY(point.y - CENTER).applyQuaternion(mirrorQuat).setY(point.y + CENTER)
      mirrorOffsets[v * 3] = point.x
      mirrorOffsets[v * 3 + 1] = point.y
      mirrorOffsets[v * 3 + 2] = point.z
      mirrorQuats[v * 4] = mirrorQuat.x
      mirrorQuats[v * 4 + 1] = mirrorQuat.y
      mirrorQuats[v * 4 + 2] = mirrorQuat.z
      mirrorQuats[v * 4 + 3] = mirrorQuat.w

      point.copy(voxel.direction).normalize().applyQuaternion(mirrorQuat)
      const leak = smooth(0.55, 0.98, point.dot(leakAt) + peek * 0.3) * 0.9 * follow
      const ignite = smooth(0, 0.05, landed - voxel.reach * 0.004)
      mirrorSurfaces[v * 3] = Math.max(leak, ignite, glow)
      mirrorSurfaces[v * 3 + 1] = lerp(voxel.tint, TINT.blue, hero.theme) // cream keys would vanish on the cream floor
      mirrorSurfaces[v * 3 + 2] = Math.max(nudges[v * 4 + 3], glow)
      mirrorHides[v] = appear
    })

    box.offset.needsUpdate = true
    box.surface.needsUpdate = true
    box.hide.needsUpdate = true
    box.quats.needsUpdate = true
    mirror.offset.needsUpdate = true
    mirror.surface.needsUpdate = true
    mirror.hide.needsUpdate = true
    mirror.quats.needsUpdate = true

    if (realFrame.current) {
      realFrame.current.position.set(0, CENTER, 0)
      realFrame.current.quaternion.copy(realQuat)
    }
    if (mirrorFrame.current) {
      // The reflected frame stops following too, and opens up around the board.
      const landing = fine((progress - X_START - X_TIME) / 0.09)
      mirrorFrame.current.position.set(0, lerp(CENTER, PLATE, landing), lerp(0, BOARD_SHIFT, open))
      mirrorFrame.current.quaternion.copy(mirrorQuat)
      mirrorFrame.current.scale.set(lerp(1, (BOARD_WIDTH + 0.9) / (CUBE_SIZE * 1.16), open), lerp(1, 0.5, landing), lerp(1, 1.6, open))
    }

    const bg = color.lerpColors(DARK, CREAM, hero.theme)
    for (const shared of [material, mirrorMaterial]) {
      shared.uniforms.uTime.value = time
      shared.uniforms.uTheme.value = hero.theme
      shared.uniforms.uScale.value = 0.42
      shared.uniforms.uBg.value.copy(bg)
    }
    // One band of light crosses the board when it is finished.
    mirrorMaterial.uniforms.uSweep.value = lerp(-5, 5, smooth(LANDED, LANDED + 0.14, progress))
    floorMaterial.uniforms.uBg.value.copy(bg)
    floorMaterial.uniforms.uTheme.value = hero.theme
    // The glass clears as the lie takes shape: the reflection ends up more solid than the box.
    floorMaterial.uniforms.uGlass.value = lerp(lerp(0.34, 0.46, hero.theme), 0.05, smooth(0.1, 0.42, progress))
  })

  return (
    <>
      <instancedMesh args={[box.geometry, material, tiles.length]} frustumCulled={false} />
      <instancedMesh args={[mirror.geometry, mirrorMaterial, count]} frustumCulled={false} />
      <mesh material={floorMaterial} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <planeGeometry args={[400, 400]} />
      </mesh>
      <group ref={realFrame} />
      <Outline follow={realFrame} morph={false} />
      <group ref={flipped} scale={[1, -1, 1]}>
        <group ref={mirrorFrame} />
        <Outline follow={mirrorFrame} morph={false} />
      </group>
    </>
  )
}
