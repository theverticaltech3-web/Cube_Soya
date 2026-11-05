import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { hero, smooth } from '../hero'
import { BOARD_HEIGHT, BOARD_WIDTH, CUBE_SIZE } from '../layout'

const CORNERS: [number, number, number][] = [
  [-0.5, -0.5, -0.5],
  [0.5, -0.5, -0.5],
  [0.5, -0.5, 0.5],
  [-0.5, -0.5, 0.5],
  [-0.5, 0.5, -0.5],
  [0.5, 0.5, -0.5],
  [0.5, 0.5, 0.5],
  [-0.5, 0.5, 0.5],
]
const EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]

const CUBE_BOX = new THREE.Vector3().setScalar(CUBE_SIZE * 1.16)
// Shallow enough that both ends of the frame stay on screen around the board.
const BOARD_BOX = new THREE.Vector3(BOARD_WIDTH + 1.7, BOARD_HEIGHT + 1.7, 2.6)
const BOARD_BOX_TALL = new THREE.Vector3(BOARD_HEIGHT + 1.7, BOARD_WIDTH + 1.7, 2.6)

const cream = new THREE.Color('#FFFCF0')
const blue = new THREE.Color('#1C70EC')

const dotVertex = /* glsl */ `
  uniform float uSize;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize;
  }
`

const dotFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float alpha = 1.0 - smoothstep(0.42, 0.5, d);
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(uColor, alpha * uOpacity);
    #include <colorspace_fragment>
  }
`

// A thin frame with a dot on all 8 corners, floating clear of the object inside it.
export function Outline({ follow, morph = true }: { follow: React.RefObject<THREE.Group | null>; morph?: boolean }) {
  const group = useRef<THREE.Group>(null)
  const box = useRef<THREE.Group>(null)
  const line = useRef<React.ComponentRef<typeof Line>>(null)

  const points = useMemo(() => EDGES.map((corner) => CORNERS[corner]), [])
  const dots = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(CORNERS.flat(), 3))
    const material = new THREE.ShaderMaterial({
      vertexShader: dotVertex,
      fragmentShader: dotFragment,
      transparent: true,
      uniforms: { uSize: { value: 9 }, uColor: { value: blue.clone() }, uOpacity: { value: 1 } },
    })
    return { geometry, material }
  }, [])

  useFrame(({ gl }, delta) => {
    if (!group.current || !box.current || !line.current || !follow.current) return

    // The frame trails the object slightly, so it feels like a separate thing around it.
    const lag = 1 - Math.pow(0.0006, Math.min(delta, 1 / 30))
    group.current.quaternion.slerp(follow.current.quaternion, lag)
    group.current.scale.copy(follow.current.scale)
    group.current.position.copy(follow.current.position)

    const flatten = morph ? smooth(0.4, 0.95, hero.progress) : 0
    const appear = smooth(0.35, 1, hero.intro)
    box.current.scale.lerpVectors(CUBE_BOX, hero.portrait ? BOARD_BOX_TALL : BOARD_BOX, flatten).multiplyScalar(0.9 + appear * 0.1)

    const material = line.current.material
    material.color.lerpColors(cream, blue, hero.theme)
    material.opacity = appear * 0.82

    dots.material.uniforms.uColor.value.copy(blue)
    dots.material.uniforms.uOpacity.value = appear
    dots.material.uniforms.uSize.value = 9 * gl.getPixelRatio()
  })

  return (
    <group ref={group}>
      <group ref={box}>
        <Line ref={line} points={points} segments lineWidth={1.1} transparent />
        <points geometry={dots.geometry} material={dots.material} frustumCulled={false} />
      </group>
    </group>
  )
}
