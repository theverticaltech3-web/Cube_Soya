import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { clamp, hero, lerp, smooth } from '../hero'
import { BOARD_HEIGHT, BOARD_WIDTH } from '../layout'
import { Outline } from './Outline'
import { GridHalo } from './GridHalo'
import { Pieces } from './Pieces'

const START_PITCH = 0.52
const START_YAW = 0.68
const SWEEP_PITCH = 0.95 // how far the orbit rises on the way round
const END_YAW = -Math.PI * 2 // one full turn, arriving dead on
const OBJECT_CUBE = 5.3 // on-screen footprint of the cube, in world units
const DRAG_SPEED = 0.006
const SHAKE_SPEED = 0.0022
const SHAKE_LIMIT = 0.42

const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))

export function Stage() {
  const group = useRef<THREE.Group>(null)
  const yaw = useRef(0)
  const yawVelocity = useRef(0)
  const tilt = useRef({ x: 0, y: 0 })
  const shake = useRef({ x: 0, y: 0 })
  const gl = useThree((state) => state.gl)

  useEffect(() => {
    const canvas = gl.domElement
    let dragging = false
    let lastX = 0
    let moveX = 0
    let moveY = 0

    const move = (event: PointerEvent) => {
      // Moving the cursor knocks the locked board off its one correct angle.
      shake.current.y = clamp(shake.current.y + (event.clientX - moveX) * SHAKE_SPEED, -SHAKE_LIMIT, SHAKE_LIMIT)
      shake.current.x = clamp(shake.current.x + (event.clientY - moveY) * SHAKE_SPEED, -SHAKE_LIMIT, SHAKE_LIMIT)
      moveX = event.clientX
      moveY = event.clientY
      hero.pointerX = (event.clientX / window.innerWidth) * 2 - 1
      hero.pointerY = 1 - (event.clientY / window.innerHeight) * 2
      hero.pointerActive = true
      if (dragging) {
        yawVelocity.current = (event.clientX - lastX) * DRAG_SPEED
        yaw.current += yawVelocity.current
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
    const leave = () => {
      hero.pointerActive = false
    }

    canvas.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    document.documentElement.addEventListener('pointerleave', leave)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.documentElement.removeEventListener('pointerleave', leave)
    }
  }, [gl])

  useFrame(({ viewport }, delta) => {
    if (!group.current) return
    const dt = Math.min(delta, 1 / 30)
    const { progress } = hero
    const morph = smooth(0.08, 0.86, progress)
    hero.lock = smooth(0.7, 0.86, progress)

    // Spin on its own while idle, keep the momentum from a drag, and let go once scrolling starts.
    if (!hero.still && progress < 0.005) yaw.current += dt * 0.14
    yaw.current += yawVelocity.current * dt * 30
    yawVelocity.current *= Math.pow(0.03, dt)
    if (progress < 0.005) yaw.current = wrapAngle(yaw.current)

    tilt.current.x = lerp(tilt.current.x, hero.pointerActive ? hero.pointerY * -0.07 : 0, 1 - Math.pow(0.02, dt))
    tilt.current.y = lerp(tilt.current.y, hero.pointerActive ? hero.pointerX * 0.1 : 0, 1 - Math.pow(0.02, dt))

    // Once the cursor rests, the board settles back into line.
    const settle = Math.pow(0.1, dt)
    shake.current.x *= settle
    shake.current.y *= settle
    const tiltX = lerp(tilt.current.x, shake.current.x, hero.lock)
    const tiltY = lerp(tilt.current.y, shake.current.y, hero.lock)

    // Tall screens turn the board to run along the height, where there is room for it.
    hero.portrait = viewport.aspect < 0.85
    const cubeScale = Math.min((viewport.width * 0.8) / OBJECT_CUBE, (viewport.height * 0.74) / OBJECT_CUBE)
    hero.fit = hero.portrait
      ? Math.min((viewport.height * 0.66) / BOARD_WIDTH, (viewport.width * 0.74) / BOARD_HEIGHT)
      : Math.min((viewport.width * 0.74) / BOARD_WIDTH, (viewport.height * 0.6) / BOARD_HEIGHT)

    group.current.rotation.set(
      lerp(START_PITCH, 0, morph) + Math.sin(Math.PI * morph) * SWEEP_PITCH * (1 - morph) + tiltX,
      lerp(START_YAW + yaw.current, END_YAW, morph) + tiltY,
      0,
    )
    group.current.scale.setScalar(lerp(cubeScale, hero.fit, morph))
  })

  return (
    <>
      <GridHalo />
      <group ref={group}>
        <Pieces />
      </group>
      <Outline follow={group} />
    </>
  )
}
