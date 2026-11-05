import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { hero, lerp, smooth } from '../hero'

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// The stepped, pixel-edged disc of grid cells from the reference video.
const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uRadius;
  uniform float uOpacity;
  varying vec2 vUv;

  const float CELLS = 64.0;

  void main() {
    vec2 grid = vUv * CELLS;
    vec2 cell = (floor(grid) + 0.5) / CELLS - 0.5;
    vec2 edge = abs(fract(grid - 0.5) - 0.5) / fwidth(grid);
    float line = 1.0 - min(min(edge.x, edge.y), 1.0);

    float inside = step(length(cell * vec2(1.0, 1.5)), uRadius);
    float fade = 0.45 + 0.55 * smoothstep(uRadius, uRadius * 0.45, length(cell));
    gl_FragColor = vec4(uColor, line * inside * fade * uOpacity);
    #include <colorspace_fragment>
  }
`

export function GridHalo() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uColor: { value: new THREE.Color('#1C70EC') },
          uRadius: { value: 0.28 },
          uOpacity: { value: 0 },
        },
      }),
    [],
  )

  useFrame(({ viewport }) => {
    const wide = Math.min(viewport.aspect / 1.2, 1)
    material.uniforms.uRadius.value = lerp(0.24, 0.36, smooth(0.3, 0.95, hero.progress)) * wide
    material.uniforms.uOpacity.value = smooth(0.2, 1, hero.intro) * lerp(0.2, 0.16, hero.theme)
  })

  return (
    <mesh position={[0, 0, -4]} material={material}>
      <planeGeometry args={[18, 18]} />
    </mesh>
  )
}
