# Black Box Hero

A full-screen hero with no text. A black box comes apart on scroll into a cloud of cubes, and from one exact angle the cloud snaps into a keyboard. Move the cursor and the illusion breaks, then settles back when the cursor rests.

Built with React, TypeScript, React Three Fiber and GSAP.

## Run it

```
npm install
npm run dev
```

## How it works

- **Scroll:** a GSAP ScrollTrigger scrubs `hero.progress` from 0 (cube) to 1 (keyboard). The canvas stays fixed over a tall scroll track.
- **Pieces:** 80 tiles drawn as a single instanced mesh. Each one becomes a cube in flight and lands at its own depth, scaled so that all 80 line up from the head-on camera angle (true anamorphosis). The liquid is mapped to the screen at that angle, so it reads as one painting across the cubes.
- **Material:** a custom shader for the black gloss of the closed box and the liquid chrome of the cubes, which are `#1C70EC` or `#FFFCF0`.
- **Interaction:** tiles react to the cursor, keys press down with the real keyboard, and dragging spins the cube.
- **Scroll hint:** the box opens slightly every few seconds, and a dot runs down a line at the bottom of the screen.

## Where to change things

| What | File |
| --- | --- |
| Board layout, depth range, cube grid, tile sizes | `src/layout.ts` |
| Texture and colors | `src/scene/liquidMaterial.ts` |
| Scroll choreography | `src/scene/Pieces.tsx` |
| Camera angles, sizing, drag | `src/scene/Stage.tsx` |
| Outline and corner dots | `src/scene/Outline.tsx` |
| Load and idle animation | `src/App.tsx` |
