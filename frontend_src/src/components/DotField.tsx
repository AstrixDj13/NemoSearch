import { useEffect, useRef } from 'react'

export default function DotField({ running = false }: { running?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const runningRef = useRef(running)

  useEffect(() => {
    runningRef.current = running
  }, [running])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0
    let height = 0
    let frame = 0
    let lastFrame = 0
    let animationFrame = 0
    const pointer = { x: -1000, y: -1000, active: false }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw(0)
    }

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height)
      const spacing = width < 640 ? 26 : 30
      const drift = reducedMotion ? 0 : time * 0.00022

      for (let x = spacing / 2; x < width; x += spacing) {
        for (let y = spacing / 2; y < height; y += spacing) {
          const wave = Math.sin(x * 0.018 + y * 0.013 + drift * 8)
          const distance = Math.hypot(x - pointer.x, y - pointer.y)
          const influence = pointer.active ? Math.max(0, 1 - distance / 180) : 0
          const researchPulse = runningRef.current
            ? Math.max(0, Math.sin(distance * 0.025 - time * 0.003)) * Math.max(0, 1 - distance / 360)
            : 0
          const radius = 0.8 + influence * 1.25 + researchPulse * 0.35
          const alpha = 0.13 + (wave + 1) * 0.018 + influence * 0.27 + researchPulse * 0.06
          const offsetY = reducedMotion ? 0 : wave * 0.65

          context.beginPath()
          context.fillStyle = `rgba(17, 18, 20, ${Math.min(alpha, 0.52)})`
          context.arc(x, y + offsetY, radius, 0, Math.PI * 2)
          context.fill()
        }
      }
    }

    const animate = (time: number) => {
      if (time - lastFrame > 42) {
        draw(time)
        lastFrame = time
        frame += 1
      }
      animationFrame = window.requestAnimationFrame(animate)
    }

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.active = true
    }
    const onPointerLeave = () => {
      pointer.active = false
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onPointerLeave)
    if (!reducedMotion) animationFrame = window.requestAnimationFrame(animate)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointerMove)
      document.documentElement.removeEventListener('pointerleave', onPointerLeave)
      void frame
    }
  }, [])

  return <canvas ref={canvasRef} className="dot-field" aria-hidden="true" />
}
