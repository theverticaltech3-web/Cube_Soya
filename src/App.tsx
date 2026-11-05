import { type ComponentType, Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { hero } from './hero'
import { ThemeToggle } from './ThemeToggle'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// Each concept lives at ?c=<number> in its own file, so one that breaks cannot take down the rest.
// Track is the scroll length in screen heights.
const CONCEPTS: [number, string, number][] = [
  [1, 'BoxKey', 280],
  [2, 'Shadow', 280],
  [3, 'Pinscreen', 280],
  [7, 'InsideTheBox', 280],
  [9, 'Casting', 280],
  [10, 'Meteor', 420],
]
const files = import.meta.glob<{ Scene: ComponentType }>('./concepts/*.tsx')
const available = CONCEPTS.filter(([, name]) => files[`./concepts/${name}.tsx`])
const requested = Number(new URLSearchParams(window.location.search).get('c') ?? 10)
const [active, activeName, trackHeight] = available.find(([id]) => id === requested) ?? available[0]
const Scene = lazy(() => files[`./concepts/${activeName}.tsx`]().then(({ Scene }) => ({ default: Scene })))

export function App() {
  const track = useRef<HTMLElement>(null)
  const cue = useRef<HTMLDivElement>(null)
  const [maxDpr, setMaxDpr] = useState(1.75)

  useGSAP(() => {
    hero.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    gsap.to(hero, {
      progress: 1,
      ease: 'none',
      scrollTrigger: { trigger: track.current, start: 'top top', end: 'bottom bottom', scrub: hero.still ? true : 1.4 },
    })

    // The cue leaves as soon as it has done its job.
    gsap.fromTo(
      cue.current,
      { opacity: 1 },
      {
        opacity: 0,
        ease: 'none',
        immediateRender: false,
        scrollTrigger: { trigger: track.current, start: 'top top', end: '+=200', scrub: hero.still ? true : 1.4 },
      },
    )

    if (hero.still) {
      hero.intro = 1
      gsap.set(cue.current, { opacity: 1 })
      return
    }

    gsap
      .timeline()
      .to(hero, { intro: 1, duration: 2.2, ease: 'power3.out' })
      .to(cue.current, { opacity: 1, duration: 0.8 }, activeName === 'Meteor' ? 6 : 1.4) // the Meteor's stars arrive first

    // Every few seconds the box opens a little, then closes: it can be pulled apart.
    gsap
      .timeline({ repeat: -1, repeatDelay: 3.6, delay: 2.4 })
      .to(hero, { peek: 1, duration: 0.7, ease: 'power2.out' })
      .to(hero, { peek: 0, duration: 1.1, ease: 'elastic.out(1, 0.5)' })
  })

  // Smooth scrolling, driven by GSAP's clock so the scrub stays in step with it.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const lenis = new Lenis({ lerp: 0.05, wheelMultiplier: 0.8, syncTouch: true, syncTouchLerp: 0.06 })
    const tick = (time: number) => lenis.raf(time * 1000)
    lenis.on('scroll', ScrollTrigger.update)
    gsap.ticker.add(tick)
    gsap.ticker.lagSmoothing(0)
    return () => {
      gsap.ticker.remove(tick)
      lenis.destroy()
    }
  }, [])

  useEffect(() => {
    const down = (event: KeyboardEvent) => hero.pressed.add(event.code)
    const up = (event: KeyboardEvent) => hero.pressed.delete(event.code)
    const clear = () => hero.pressed.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])

  return (
    <main ref={track} className="track" style={{ height: `${trackHeight}svh` }}>
      <div className={activeName === 'Meteor' ? 'stage plain' : 'stage'} role="img" aria-label="A black cube that breaks apart and rebuilds itself into a keyboard as you scroll">
        <Canvas dpr={[1, maxDpr]} camera={{ fov: 28, position: [0, 0, 13] }} gl={{ alpha: true, antialias: true }}>
          {/* A device that can't hold the frame rate drops resolution instead of lagging. */}
          <PerformanceMonitor onDecline={() => setMaxDpr(1)} />
          <Suspense fallback={null}>
            <Scene />
          </Suspense>
        </Canvas>
      </div>
      <ThemeToggle />
      <nav className="concepts" aria-label="Concepts">
        {available.map(([id]) => (
          <a key={id} href={`?c=${id}`} aria-current={id === active ? 'page' : undefined}>
            {id}
          </a>
        ))}
      </nav>
      <div ref={cue} className="scroll-cue" aria-hidden="true">
        <span className="scroll-mouse" />
        <span className="scroll-arrows" />
      </div>
    </main>
  )
}
