import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { CUBE_SIZE, ROWS, TINT, tiles } from '../layout'
import { createLiquidMaterial } from '../scene/liquidMaterial'
import { Outline } from '../scene/Outline'

// The black box was one key of the keyboard all along. It falls down an empty shaft and stops
// dead on an unseen floor. Only then does the shock raise the other keys around it, and the
// camera lets go.

const PITCH = CUBE_SIZE * 1.12
const HERO_CODE = 'KeyG'
const DRAG_SPEED = 0.006
const HOVER_RADIUS = 0.07

const DROP_HEIGHT = 44
const HOIST = 0.6 // the box lifts a little before it lets go
const FLOOR = -1.75 // invisible, but it hides the keys below it and takes the outline's lower corners
const BURIED = -3.7 // a key waiting under the floor, top included
const KEY_RADIUS = 0.2

const FALL_START = 0.07
const SWAP = 0.2 // the tiles are sealed by here, so the solid key takes over unseen
const IMPACT = 0.36
const WAVE = 0.41 // a held beat: the box sits alone on the floor
const WAVE_SPEED = 0.011 // scroll per key of distance
const RISE = 0.09
const PULL_START = 0.43
const PULL_END = 0.74

const FOV_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(14))
const DARK = new THREE.Color('#08090C')
const CREAM = new THREE.Color('#FFFCF0')
const BLUE = new THREE.Color('#1C70EC')

const keys = ROWS.flatMap((row, rowIndex) =>
  row.map((code, column) => {
    const x = (column - (row.length - 1) / 2) * PITCH
    const z = (rowIndex - (ROWS.length - 1) / 2) * PITCH
    return { code, x, z, tint: Math.abs(x * 0.55 - z) < PITCH * 0.85 ? TINT.cream : TINT.blue }
  }),
)
const heroIndex = keys.findIndex((key) => key.code === HERO_CODE)
const heroKey = keys[heroIndex]
const reach = keys.map((key) => Math.hypot(key.x - heroKey.x, key.z - heroKey.z) / PITCH)
const BOARD_WIDTH = 15 * PITCH

const heroQuat = new THREE.Quaternion()
const tileQuat = new THREE.Quaternion()
const point = new THREE.Vector3()
const target = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
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

// The liquid material tints tile seams. uSeam fades that out, so a sealed box is plain black.
const createKeyMaterial = () => {
  const material = createLiquidMaterial()
  material.uniforms.uSeam = { value: 0 }
  material.fragmentShader = material.fragmentShader
    .replace('uniform float uTime;', 'uniform float uTime;\n  uniform float uSeam;')
    .replace('* 0.16; // each tile', '* 0.16 * uSeam; // each tile')
  return material
}

const shaftVertex = /* glsl */ `
  attribute float aTail;
  uniform float uStretch;
  uniform float uFocus;
  varying float vFade;
  void main() {
    vec3 p = position;
    p.y += aTail * uStretch; // dust smears with speed
    vFade = 1.0 - smoothstep(7.0, 24.0, abs(p.y - uFocus));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

const shaftFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    gl_FragColor = vec4(uColor, vFade * uOpacity);
    #include <colorspace_fragment>
  }
`

// What the fall is measured against: square frames it passes through, dust, and marks on the floor.
const buildShaft = () => {
  const positions: number[] = []
  const tails: number[] = []
  const segment = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, tail = 0) => {
    positions.push(ax, ay, az, bx, by, bz)
    tails.push(0, tail)
  }
  const half = 4.8
  for (let y = 5; y < DROP_HEIGHT + 12; y += 6) {
    const [x0, x1, z0, z1] = [heroKey.x - half, heroKey.x + half, heroKey.z - half, heroKey.z + half]
    segment(x0, y, z0, x1, y, z0)
    segment(x1, y, z0, x1, y, z1)
    segment(x1, y, z1, x0, y, z1)
    segment(x0, y, z1, x0, y, z0)
  }
  for (let i = 0; i < 120; i++) {
    const angle = i * 2.4
    const radius = 3.6 + ((i * 0.618) % 1) * 9
    const x = heroKey.x + Math.cos(angle) * radius
    const z = heroKey.z + Math.sin(angle) * radius
    const y = 2 + (i * 7.3) % (DROP_HEIGHT + 10)
    segment(x, y, z, x, y, z, 1)
  }
  keys.forEach(({ x, z }) => {
    const y = FLOOR + 0.02
    segment(x - 0.35, y, z, x + 0.35, y, z)
    segment(x, y, z - 0.35, x, y, z + 0.35)
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aTail', new THREE.Float32BufferAttribute(tails, 1))
  const material = new THREE.ShaderMaterial({
    vertexShader: shaftVertex,
    fragmentShader: shaftFragment,
    transparent: true,
    depthWrite: false,
    uniforms: { uStretch: { value: 0 }, uFocus: { value: 0 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color() } },
  })
  return { geometry, material }
}

const RING: [number, number, number][] = Array.from({ length: 97 }, (_, i) => {
  const angle = (i / 96) * Math.PI * 2
  return [Math.cos(angle), 0, Math.sin(angle)]
})

export function Scene() {
  const shell = useMemo(() => {
    const instances = buildInstances(3, tiles.length)
    tiles.forEach((tile, t) => instances.quat.setXYZW(t, tile.quaternion.x, tile.quaternion.y, tile.quaternion.z, tile.quaternion.w))
    return instances
  }, [])
  const solid = useMemo(() => {
    const instances = buildInstances(5, keys.length)
    keys.forEach((_, k) => {
      instances.size.setXYZ(k, CUBE_SIZE, CUBE_SIZE, CUBE_SIZE)
      instances.quat.setXYZW(k, 0, 0, 0, 1)
    })
    return instances
  }, [])
  const shellMaterial = useMemo(createKeyMaterial, [])
  const solidMaterial = useMemo(createKeyMaterial, [])
  const shaft = useMemo(buildShaft, [])
  const shellMesh = useRef<THREE.InstancedMesh>(null)
  const frame = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Group>(null)
  const ringLine = useRef<React.ComponentRef<typeof Line>>(null)
  const gl = useThree((state) => state.gl)

  const yaw = useRef(0.68)
  const spin = useRef(0)
  // Spring state: one per key, plus one per tile of the box for the opening hover.
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
      shell.geometry.dispose()
      solid.geometry.dispose()
      shellMaterial.dispose()
      solidMaterial.dispose()
      shaft.geometry.dispose()
      shaft.material.dispose()
    }
  }, [gl, shell, solid, shellMaterial, solidMaterial, shaft])

  useFrame(({ camera, clock, size }, delta) => {
    const dt = Math.min(delta, 1 / 30)
    const time = hero.still ? 3 : clock.elapsedTime
    const { progress, intro } = hero
    const aspect = size.width / size.height
    const scrolling = smooth(0, 0.015, progress)
    const peek = hero.peek * (1 - scrolling) // the box only breathes before the scroll begins

    // The box turns freely until the scroll, then squares up with its slot on the way down.
    if (!hero.still && progress < 0.005) yaw.current += dt * 0.14
    yaw.current += spin.current * dt * 30
    spin.current *= Math.pow(0.03, dt)
    if (progress < 0.005) yaw.current = Math.atan2(Math.sin(yaw.current), Math.cos(yaw.current))
    const square = Math.round(yaw.current / (Math.PI / 2)) * (Math.PI / 2)
    const angle = lerp(yaw.current, square, smooth(0, SWAP, progress))
    heroQuat.setFromAxisAngle(UP, angle)

    // Lifts, lets go, accelerates under gravity, and stops dead.
    const fall = clamp((progress - FALL_START) / (IMPACT - FALL_START))
    const top = DROP_HEIGHT + HOIST
    const heroY = progress < FALL_START ? DROP_HEIGHT + HOIST * smooth(0, FALL_START, progress) : top * (1 - fall * fall)
    const stopped = Math.max(0, (progress - IMPACT) / 0.06)

    // The tile gaps close and the corners sharpen before the swap, then the solid key rounds them off.
    const sealed = smooth(0.02, FALL_START + 0.07, progress)
    shellMaterial.uniforms.uRadius.value = lerp(0.055, 0, sealed)
    shellMaterial.uniforms.uSeam.value = 1 - sealed
    solidMaterial.uniforms.uRadius.value = KEY_RADIUS * smooth(SWAP, IMPACT, progress)

    // Camera: close on the box, drops with it, then lets go and reveals a small board.
    const fitStart = Math.max(14, 5.4 / (0.74 * FOV_SCALE * Math.min(aspect, 1)))
    const fitLand = fitStart * 1.4
    const fitEnd = Math.max(BOARD_WIDTH / ((aspect < 0.85 ? 0.88 : 0.47) * FOV_SCALE * aspect), 44)
    const travel = smooth(PULL_START, PULL_END, progress)
    const distance = Math.exp(lerp(Math.log(lerp(fitStart, fitLand, smooth(0.02, IMPACT, progress))), Math.log(fitEnd), travel))
    const look = lerp(lerp(0.52, 0.66, smooth(FALL_START, IMPACT, progress)), 1.12, travel)
    const orbit = 0.5 * smooth(FALL_START, IMPACT, progress) * (1 - travel)

    // The camera falls behind as the box gains speed, and is still catching up when it stops.
    const trail = fitStart * 0.2 * fall * fall * fall
    const catchUp = stopped > 0 ? Math.exp(-stopped * 5) * Math.cos(stopped * 7) : 1
    const follow = hero.still ? 0 : trail * catchUp
    const shake = hero.still || stopped === 0 ? 0 : Math.exp(-stopped * 6) * Math.sin(stopped * 34) * fitStart * 0.012
    target.set(lerp(heroKey.x, 0, travel), lerp(heroY + follow, 0, travel), lerp(heroKey.z, 0, travel))
    camera.position.set(
      target.x + Math.sin(orbit) * Math.cos(look) * distance + (hero.pointerX * travel * distance) / 60 + shake,
      target.y + Math.sin(look) * distance,
      target.z + Math.cos(orbit) * Math.cos(look) * distance,
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

    // The tiled shell: the box as it opens the page.
    const tiled = progress < SWAP
    if (shellMesh.current) shellMesh.current.visible = tiled
    if (tiled) {
      const gap = lerp(0, 0.03, sealed)
      tiles.forEach((tile, t) => {
        const lift = (1 - smooth(0, 1, intro * 1.7 - t * 0.007)) * 7
        const near = progress < 0.02 && hero.pointerActive
        point.copy(tile.position).applyQuaternion(heroQuat)
        const facing = point.dot(camera.position) > 0
        const hoverGoal = near && facing ? smooth(0.22, 0.07, project(heroKey.x + point.x, heroY + point.y, heroKey.z + point.z)) : 0
        spring(tileHover.current, tileVelocity.current, t, hoverGoal)
        const h = tileHover.current[t]
        const out = lift + peek * (0.4 + 0.2 * Math.sin(t * 2.4)) + h * 0.5

        point.copy(tile.position).addScaledVector(tile.normal, out).applyQuaternion(heroQuat)
        shell.offset.setXYZ(t, heroKey.x + point.x, heroY + point.y, heroKey.z + point.z)
        tileQuat.copy(heroQuat).multiply(tile.quaternion)
        shell.quat.setXYZW(t, tileQuat.x, tileQuat.y, tileQuat.z, tileQuat.w)
        const liquid = smooth(0.55, 0.98, point.copy(tile.position).normalize().applyQuaternion(heroQuat).dot(leakAt) + peek * 0.3) * 0.9 * (1 - scrolling)
        shell.surface.setXYZ(t, liquid, heroKey.tint, h)
        shell.size.setXYZ(t, tile.size.x + gap, tile.size.y, tile.size.z + gap)
        shell.hide.setX(t, 1 - smooth(0, 0.5, intro))
      })
      shell.offset.needsUpdate = true
      shell.quat.needsUpdate = true
      shell.surface.needsUpdate = true
      shell.size.needsUpdate = true
      shell.hide.needsUpdate = true
    }

    // The solid keys: 79 under the floor, and the hero once it has sealed.
    let landedY = heroY
    const outlineGround = hero.theme > 0.5 ? TINT.cream : TINT.blue // the keys around the outline always contrast with it
    keys.forEach((key, k) => {
      const r = reach[k]
      const isHero = k === heroIndex
      const rising = clamp((progress - WAVE - r * WAVE_SPEED) / RISE)
      const slam = 1 + 2.2 * Math.pow(rising - 1, 3) + 1.2 * Math.pow(rising - 1, 2) // overshoots, on its own rail
      const ignited = isHero ? 0 : smooth(0, 0.06, progress - WAVE - 0.05 - r * WAVE_SPEED)
      const swell = smooth(0.8, 1, Math.sin(key.x * 0.18 + key.z * 0.1 - time * 1.2)) * smooth(PULL_END - 0.1, PULL_END + 0.1, progress) * 0.5

      let goal = hero.pressed.has(key.code) ? -0.8 : 0
      if (!isHero && hero.pointerActive && ignited > 0.9 && !goal) {
        goal = smooth(HOVER_RADIUS, HOVER_RADIUS * 0.3, project(key.x, 1.5, key.z)) * 1.6
      }
      spring(keyHover.current, keyVelocity.current, k, goal)

      const y = (isHero ? heroY : lerp(BURIED, 0, slam)) + swell + keyHover.current[k]
      if (isHero) {
        landedY = y
        solid.quat.setXYZW(k, heroQuat.x, heroQuat.y, heroQuat.z, heroQuat.w)
      }
      solid.offset.setXYZ(k, key.x, y, key.z)
      solid.surface.setXYZ(
        k,
        Math.max(ignited, clamp(keyHover.current[k])),
        r < 1.6 ? outlineGround : key.tint,
        clamp(keyHover.current[k]),
      )
      solid.hide.setX(k, (isHero ? !tiled : rising > 0) ? 0 : 1)
    })
    solid.offset.needsUpdate = true
    solid.surface.needsUpdate = true
    solid.hide.needsUpdate = true
    solid.quat.needsUpdate = true

    if (frame.current) {
      frame.current.position.set(heroKey.x, landedY, heroKey.z)
      frame.current.quaternion.copy(heroQuat)
      frame.current.scale.setScalar(lerp(1, 0.965, smooth(FALL_START, IMPACT, progress))) // sits in the middle of the gap
    }

    // The shaft and the floor marks, only there while they measure the fall.
    const lines = shaft.material.uniforms
    const shaftInk = color.lerpColors(CREAM, BLUE, hero.theme)
    lines.uColor.value.copy(shaftInk)
    lines.uFocus.value = target.y
    lines.uOpacity.value = smooth(0.02, FALL_START + 0.04, progress) * (1 - smooth(WAVE + 0.02, WAVE + 0.1, progress)) * lerp(0.24, 0.34, hero.theme)
    lines.uStretch.value = hero.still ? 0.2 : 0.2 + fall * (1 - clamp(stopped)) * 9

    // The shock runs out across the floor, and the keys come up as it passes.
    const front = (progress - WAVE) / WAVE_SPEED
    if (ring.current && ringLine.current) {
      ring.current.visible = front > 0 && front < 12
      ring.current.scale.setScalar(Math.max(front, 0.01) * PITCH + 1.5)
      ringLine.current.material.color.copy(shaftInk)
      ringLine.current.material.opacity = 0.7 * (1 - smooth(1, 11, front))
    }

    const bg = color.lerpColors(DARK, CREAM, hero.theme)
    for (const material of [shellMaterial, solidMaterial]) {
      material.uniforms.uTime.value = time
      material.uniforms.uTheme.value = hero.theme
      material.uniforms.uScale.value = 0.2 // wide enough to flow across several keys
      material.uniforms.uBg.value.copy(bg)
    }
  })

  return (
    <>
      {/* Writes depth only: the page shows through, and buried keys stay hidden. */}
      <mesh rotation-x={-Math.PI / 2} position-y={FLOOR} renderOrder={-1}>
        <planeGeometry args={[4000, 4000]} />
        <meshBasicMaterial colorWrite={false} />
      </mesh>
      <instancedMesh ref={shellMesh} args={[shell.geometry, shellMaterial, tiles.length]} frustumCulled={false} />
      <instancedMesh args={[solid.geometry, solidMaterial, keys.length]} frustumCulled={false} />
      <lineSegments args={[shaft.geometry, shaft.material]} frustumCulled={false} />
      <group ref={ring} position={[heroKey.x, FLOOR + 0.03, heroKey.z]}>
        <Line ref={ringLine} points={RING} lineWidth={1.2} transparent depthWrite={false} />
      </group>
      <group ref={frame} />
      <Outline follow={frame} morph={false} />
    </>
  )
}
