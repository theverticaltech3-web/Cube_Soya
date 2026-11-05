// Shared animation state. GSAP and the pointer write to it, the render loop reads it.
export const hero = {
  progress: 0, // scroll, 0 = cube, 1 = keyboard
  intro: 0, // load animation
  peek: 0, // idle hint that the cube opens
  theme: 0, // 0 = dark, 1 = light
  lock: 0, // 1 = the cubes line up from the one correct angle
  fit: 1, // final scale of the board
  portrait: false,
  pointerX: 0, // normalized device coordinates
  pointerY: 0,
  pointerActive: false,
  still: false, // prefers-reduced-motion
  pressed: new Set<string>(), // keys held on the real keyboard
}

export const clamp = (x: number, min = 0, max = 1) => Math.min(max, Math.max(min, x))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
