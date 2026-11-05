import * as THREE from 'three'

export const CUBE_SIZE = 3
const CUBE_GRID = 4
const TILE_THICKNESS = 0.2
const TILE_GAP = 0.024
const KEY_PITCH = 0.5
export const KEY_CUBE = 0.43
const DEPTH_RANGE = 4.4 // how far apart the cubes hang front to back

export const TINT = { blue: 1, cream: 2 } as const

// Every key is the same cube, so the board only suggests a keyboard.
export const ROWS = [
  'Escape F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 PrintScreen Delete',
  'Backquote Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal Backspace',
  'Tab KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight Backslash',
  'CapsLock KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote Enter',
  'ShiftLeft KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash ShiftRight ArrowUp',
  'ControlLeft Fn MetaLeft AltLeft Space AltRight ContextMenu ControlRight ArrowLeft ArrowDown ArrowRight',
].map((row) => row.split(' '))

export const BOARD_WIDTH = 15 * KEY_PITCH
export const BOARD_HEIGHT = ROWS.length * KEY_PITCH
export const BOARD_DEPTH = DEPTH_RANGE * 2

// Fixed seed, so the scatter looks the same on every visit.
let seed = 7
const random = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}

const keys = ROWS.flatMap((row, rowIndex) =>
  row.map((code, column) => {
    const x = (column - (row.length - 1) / 2) * KEY_PITCH
    const y = ((ROWS.length - 1) / 2 - rowIndex) * KEY_PITCH
    // A single diagonal stroke of cream across the blue, like a brush mark.
    const tint = Math.abs(x * 0.55 + y) < 0.42 ? TINT.cream : TINT.blue
    return { code, end: new THREE.Vector3(x, y, (random() * 2 - 1) * DEPTH_RANGE), tint }
  }),
)

const UP = new THREE.Vector3(0, 1, 0)

// The faces interlock at the edges instead of meeting in the same space: the top keeps its full
// span, the front and back stop under it, and the sides fit between them.
const FULL: [number, number] = [-CUBE_SIZE / 2, CUBE_SIZE / 2]
const UNDER = CUBE_SIZE / 2 - TILE_THICKNESS - TILE_GAP / 2
const BELOW_TOP: [number, number] = [-CUBE_SIZE / 2, UNDER]
const BETWEEN: [number, number] = [-UNDER, UNDER]

export const tiles = [
  { normal: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1), spanU: FULL, spanV: FULL },
  { normal: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 1, 0), v: new THREE.Vector3(0, 0, 1), spanU: BELOW_TOP, spanV: BETWEEN },
  { normal: new THREE.Vector3(-1, 0, 0), u: new THREE.Vector3(0, 1, 0), v: new THREE.Vector3(0, 0, 1), spanU: BELOW_TOP, spanV: BETWEEN },
  { normal: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0), spanU: FULL, spanV: BELOW_TOP },
  { normal: new THREE.Vector3(0, 0, -1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0), spanU: FULL, spanV: BELOW_TOP },
].flatMap(({ normal, u, v, spanU, spanV }) => {
  const pitchU = (spanU[1] - spanU[0]) / CUBE_GRID
  const pitchV = (spanV[1] - spanV[0]) / CUBE_GRID
  const cells = []
  for (let a = 0; a < CUBE_GRID; a++) {
    for (let b = 0; b < CUBE_GRID; b++) {
      cells.push({
        normal,
        position: normal
          .clone()
          .multiplyScalar(CUBE_SIZE / 2 - TILE_THICKNESS / 2)
          .addScaledVector(u, spanU[0] + (a + 0.5) * pitchU)
          .addScaledVector(v, spanV[0] + (b + 0.5) * pitchV),
        quaternion: new THREE.Quaternion().setFromUnitVectors(UP, normal),
        size: new THREE.Vector3(pitchU - TILE_GAP, TILE_THICKNESS, pitchV - TILE_GAP),
      })
    }
  }
  return cells
})

const shuffled = keys.map((key) => ({ key, order: random() })).sort((a, b) => a.order - b.order)

export type Piece = {
  code: string
  normal: THREE.Vector3
  direction: THREE.Vector3
  start: THREE.Vector3
  mid: THREE.Vector3
  end: THREE.Vector3
  startSize: THREE.Vector3
  startQuat: THREE.Quaternion
  spinAxis: THREE.Vector3
  tint: number
  delay: number
  phase: number
}

const randomVector = () => new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5)

export const pieces: Piece[] = tiles.map((tile, i) => {
  const { key } = shuffled[i]
  // The tiles peel off from the top, then ride a helix around the empty box.
  const angle = (i / tiles.length) * Math.PI * 6
  return {
    code: key.code,
    normal: tile.normal,
    direction: tile.position.clone().normalize(),
    start: tile.position,
    mid: new THREE.Vector3(Math.cos(angle) * 4.6, (i / tiles.length - 0.5) * 6, Math.sin(angle) * 4.6).add(randomVector()),
    end: key.end,
    startSize: tile.size,
    startQuat: tile.quaternion,
    spinAxis: randomVector().normalize(),
    tint: key.tint,
    delay: (0.5 - tile.position.y / CUBE_SIZE) * 0.75 + random() * 0.25,
    phase: random() * Math.PI * 2,
  }
})
