import { useState } from 'react'
import gsap from 'gsap'
import { hero } from './hero'

const BACKGROUND = { dark: '#08090C', light: '#FFFCF0' }

export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BACKGROUND[next])
    gsap.to(hero, { theme: next === 'light' ? 1 : 0, duration: hero.still ? 0 : 0.6, ease: 'power2.inOut' })
  }

  const isLight = theme === 'light'

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <circle cx="9" cy="9" r="7.25" stroke="currentColor" strokeWidth="1.5" />
        <path d={isLight ? 'M9 1.75a7.25 7.25 0 0 0 0 14.5Z' : 'M9 1.75a7.25 7.25 0 0 1 0 14.5Z'} fill="currentColor" />
      </svg>
    </button>
  )
}
