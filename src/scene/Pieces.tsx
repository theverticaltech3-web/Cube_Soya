import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, hero, lerp, smooth } from '../hero'
import { KEY_CUBE, pieces } from '../layout'
import { createLiquidMaterial } from './liquidMaterial'

const CUBE_MOMENT = new THREE.Vector3().setScalar(0.66)
const HOVER_RADIUS = 0.22

const WORD = ['KeyB', 'KeyL', 'KeyA', 'KeyC', 'KeyK', '', 'KeyB', 'KeyO', 'KeyX', '', '', '']

const position = new THREE.Vector3()
const end = new THREE.Vector3()
const leakAt = new THREE.Vector3()
const size = new THREE.Vector3()
const axis = new THREE.Vector3()
const projected = new THREE.Vector3()
const toCamera = new THREE.Vector3()
const quat = new THREE.Quaternion()
const spin = new THREE.Quaternion()
const groupQuat = new THREE.Quaternion()
const flat = new THREE.Quaternion()

export function Pieces() {
  const { geometry, offset, sizes, quats, surface } = useMemo(() => {
    const geometry = new RoundedBoxGeometry(1, 1, 1, 3, 0.2)
    const attribute = (name: string, itemSize: number) => {
      const buffer = new THREE.InstancedBufferAttribute(new Float32Array(pieces.length * itemSize), itemSize)
      buffer.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute(name, buffer)
      return buffer
    }
    return {
      geometry,
      offset: attribute('aOffset', 3),
      sizes: attribute('aSize', 3),
      quats: attribute('aQuat', 4),
      surface: attribute('aSurface', 3),
    }
  }, [])
  const material = useMemo(createLiquidMaterial, [])
  const mesh = useRef<THREE.InstancedMesh>(null)

  // Spring state for the jelly response to the cursor.
  const hover = useRef(new Float32Array(pieces.length))
  const velocity = useRef(new Float32Array(pieces.length))

  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  useFrame(({ camera, clock, viewport }, delta) => {
    const group = mesh.current?.parent
    if (!group) return

    const dt = Math.min(delta, 1 / 30)
    const time = hero.still ? 3 : clock.elapsedTime
    const { progress, intro, peek, lock, fit } = hero
    const distance = camera.position.z
    const typed = lock > 0.99 && !hero.still ? WORD[Math.floor(time * 3.4) % WORD.length] : ''

    // A patch of liquid wanders over the closed box, like a leak from inside it.
    leakAt.set(Math.sin(time * 0.31), Math.sin(time * 0.23 + 1) * 0.8, Math.cos(time * 0.27)).normalize()

    group.getWorldQuaternion(groupQuat)
    toCamera.copy(camera.position).normalize()

    pieces.forEach((piece, i) => {
      const { start, mid, delay } = piece
      const travel = smooth(0, 1, clamp((progress - 0.02 - delay * 0.26) / 0.42))
      const arrive = 1 - Math.pow(1 - travel, 3)
      const e = travel

      // Each cube shrinks with its distance from the camera, so all of them line up from one angle.
      const perspective = (distance - piece.end.z * fit) / distance
      const across = piece.end.x * perspective
      const along = piece.end.y * perspective
      end.set(hero.portrait ? -along : across, hero.portrait ? across : along, piece.end.z)

      // Curved flight from the cube, out through the scatter, down onto the keyboard.
      const a = (1 - e) * (1 - e)
      const b = 2 * (1 - e) * e
      const c = e * e
      position.set(0, 0, 0).addScaledVector(start, a).addScaledVector(mid, b).addScaledVector(end, c)

      const appear = smooth(0, 1, intro * 1.7 - delay * 0.7)
      const lift = (1 - appear) * 2.4 + (1 - e) * (peek * (0.26 + 0.12 * Math.sin(piece.phase)) + Math.sin(time * 0.9 + piece.phase) * 0.012)
      position.addScaledVector(piece.normal, lift)

      // Flat tile, then a true cube mid-flight, then the shape of its key.
      const toCube = smooth(0.12, 0.46, e)
      const toKey = smooth(0.58, 1, e)
      size.lerpVectors(piece.startSize, CUBE_MOMENT, toCube)
      size.lerp(axis.setScalar(KEY_CUBE * perspective), toKey)
      size.multiplyScalar(Math.max(appear, 0.0001))

      quat.slerpQuaternions(piece.startQuat, flat, arrive)
      spin.setFromAxisAngle(piece.spinAxis, Math.sin(Math.PI * e) * 2.4 + (1 - appear) * 1.4)
      quat.premultiply(spin)

      // Cursor proximity on screen, measured from each piece's projected position.
      axis.set(0, 1, 0).applyQuaternion(quat)
      let target = 0
      if (hero.pressed.has(piece.code) || piece.code === typed) {
        target = 1
      } else if (hero.pointerActive) {
        const faces = e > 0.08 || axis.clone().applyQuaternion(groupQuat).dot(toCamera) > 0.1
        if (faces) {
          projected.copy(position).applyMatrix4(group.matrixWorld).project(camera)
          const dx = (projected.x - hero.pointerX) * viewport.aspect
          const dy = projected.y - hero.pointerY
          target = smooth(HOVER_RADIUS, HOVER_RADIUS * 0.3, Math.hypot(dx, dy))
        }
      }

      // A slow swell keeps the locked board alive.
      target = Math.max(target, lock * smooth(0.8, 1, Math.sin(piece.end.x * 1.3 - piece.end.y - time * 1.5)) * 0.3)

      const v = velocity.current
      const h = hover.current
      v[i] += ((target - h[i]) * 190 - v[i] * 15) * dt
      h[i] += v[i] * dt

      // Pops out of the cube, and towards the viewer once the board has locked.
      position.addScaledVector(axis, h[i] * 0.2 * (1 - lock))
      position.z += (h[i] * 0.55 * lock) / fit
      const squash = 1 + clamp(h[i], -0.5, 1.5) * 0.07
      size.x *= squash
      size.z *= squash
      size.y *= squash

      // Each cube takes on its color as it leaves the box.
      const leak = piece.direction.dot(leakAt)
      const amount = Math.max(smooth(0.1, 0.55, e), smooth(0.55, 0.98, leak + peek * 0.3) * 0.9)

      offset.setXYZ(i, position.x, position.y, position.z)
      sizes.setXYZ(i, size.x, size.y, size.z)
      quats.setXYZW(i, quat.x, quat.y, quat.z, quat.w)
      surface.setXYZ(i, amount, piece.tint, h[i])
    })

    offset.needsUpdate = true
    sizes.needsUpdate = true
    quats.needsUpdate = true
    surface.needsUpdate = true

    material.uniforms.uTime.value = time
    material.uniforms.uTheme.value = hero.theme
    material.uniforms.uSweep.value = hero.still ? -9 : lerp(-9, ((time * 0.55) % 5.5) * 2 - 5.5, lock)
    material.uniforms.uAlign.value = lock
  })

  return <instancedMesh ref={mesh} args={[geometry, material, pieces.length]} frustumCulled={false} />
}
