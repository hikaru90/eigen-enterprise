<script lang="ts">
  import { onMount } from 'svelte'
  import {
    WATER_FLOW_FRAGMENT_SHADER,
    WATER_FLOW_VERTEX_SHADER,
    resolveWaterFlowColors,
    type WaterFlowColors,
  } from './water-flow-shader'

  type Props = {
    class?: string
    /** Dark end of the grayscale flow (hex only, monochrome enforced). */
    from?: string
    /** Light end of the grayscale flow (hex only, monochrome enforced). */
    to?: string
    /** Flow speed multiplier (0 = frozen). */
    speed?: number
    /** Pattern zoom; higher = tighter ripples. */
    scale?: number
    /** Internal render scale vs CSS pixels (dpr-capped); the soft fluid hides sub-pixel upscaling. */
    quality?: number
    /**
     * Fixed internal canvas resolution in "pixels". Bypasses DPR/quality/
     * pixel-budget entirely. When `cells` is not given, the mask grid matches
     * this one-to-one (with crisp pixelated upscaling).
     */
    resolution?: { width: number; height: number }
    /**
     * Pill-grid mask (cols × rows), decoupled from `resolution`: a higher
     * canvas resolution renders smooth gradients INSIDE each pill (no
     * per-cell value stepping = no jitter), while the mask stays chunky.
     */
    cells?: { x: number; y: number }
  }

  let {
    class: className = '',
    from = '#060606',
    to = '#b9b9b9',
    speed = 0.35,
    scale = 1.6,
    quality = 0.75,
    resolution = undefined,
    cells = undefined,
  }: Props = $props()

  // Grid resolution: explicit cells, else the canvas resolution one-to-one —
  // normalized to {x, y} so the template has a single shape to read.
  const cellGrid = $derived.by(() => {
    const grid = cells ?? resolution
    if (!grid) return undefined
    return 'x' in grid ? { x: grid.x, y: grid.y } : { x: grid.width, y: grid.height }
  })

  let canvas = $state<HTMLCanvasElement | undefined>(undefined)
  let staticFallback = $state(false)

  // Decorative brand asset: every failure mode (no WebGL, invalid/non-monochrome
  // tint) degrades to the visible static tint with a loud log — it never crashes
  // the host page, and never degrades silently.
  let cachedTintKey = ''
  let cachedTints: WaterFlowColors | null = null

  function tints(): WaterFlowColors | null {
    const key = `${from}|${to}`
    if (key === cachedTintKey) return cachedTints
    try {
      cachedTints = resolveWaterFlowColors(from, to)
      cachedTintKey = key
    } catch (err) {
      staticFallback = true
      console.error('[brand] water-flow:', err instanceof Error ? err.message : err)
      return (cachedTints = null)
    }
    return cachedTints
  }

  function validResolution(): { width: number; height: number } | null {
    if (!resolution) return { width: 0, height: 0 }
    const { width, height } = resolution
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      staticFallback = true
      console.error(
        `[brand] water-flow: resolution must be positive integers, got ${width}x${height} — rendering static tint fallback`,
      )
      return null
    }
    return { width, height }
  }

  function validCells(): { x: number; y: number } | null {
    if (!cells) return { x: 0, y: 0 }
    const { x, y } = cells
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1) {
      staticFallback = true
      console.error(
        `[brand] water-flow: cells must be positive integers, got ${x}x${y} — rendering static tint fallback`,
      )
      return null
    }
    return { x, y }
  }

  onMount(() => {
    const el = canvas
    if (!el) return

    const gl = el.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    })
    if (!gl) {
      staticFallback = true
      console.error('[brand] water-flow: WebGL unavailable — rendering static tint fallback')
      return
    }
    const fixed = validResolution()
    if (!fixed) return
    const grid = validCells()
    if (!grid) return
    const fixedWidth = fixed.width
    const fixedHeight = fixed.height
    if (!tints()) return

    function compile(type: number, source: string): WebGLShader {
      const shader = gl!.createShader(type)
      if (!shader) throw new Error('[brand] water-flow: shader allocation failed')
      gl!.shaderSource(shader, source)
      gl!.compileShader(shader)
      if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
        const log = gl!.getShaderInfoLog(shader)
        gl!.deleteShader(shader)
        throw new Error(`[brand] water-flow: shader compile failed: ${log ?? 'no log'}`)
      }
      return shader
    }

    const program = gl.createProgram()
    if (!program) throw new Error('[brand] water-flow: program allocation failed')
    const vertexShader = compile(gl.VERTEX_SHADER, WATER_FLOW_VERTEX_SHADER)
    const fragmentShader = compile(gl.FRAGMENT_SHADER, WATER_FLOW_FRAGMENT_SHADER)
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      throw new Error(`[brand] water-flow: program link failed: ${log ?? 'no log'}`)
    }
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const positionLocation = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)

    const uResolution = gl.getUniformLocation(program, 'u_resolution')
    const uTime = gl.getUniformLocation(program, 'u_time')
    const uFrom = gl.getUniformLocation(program, 'u_from')
    const uTo = gl.getUniformLocation(program, 'u_to')
    const uScale = gl.getUniformLocation(program, 'u_scale')

    // Hard pixel budget keeps the fragment cost flat on 4K/retina; the soft
    // grayscale flow hides the extra upscale.
    const MAX_PIXELS = 1_500_000

    function resize() {
      const rect = el!.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      if (fixedWidth > 0) {
        if (el!.width !== fixedWidth || el!.height !== fixedHeight) {
          el!.width = fixedWidth
          el!.height = fixedHeight
          gl!.viewport(0, 0, fixedWidth, fixedHeight)
        }
        return
      }
      const q = Math.min(1, Math.max(0.25, quality))
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      let width = Math.max(1, Math.round(rect.width * dpr * q))
      let height = Math.max(1, Math.round(rect.height * dpr * q))
      const pixels = width * height
      if (pixels > MAX_PIXELS) {
        const k = Math.sqrt(MAX_PIXELS / pixels)
        width = Math.max(1, Math.round(width * k))
        height = Math.max(1, Math.round(height * k))
      }
      if (el!.width !== width || el!.height !== height) {
        el!.width = width
        el!.height = height
        gl!.viewport(0, 0, width, height)
      }
    }

    let time = 0
    let last: number | null = null

    function draw(c: WaterFlowColors) {
      gl!.uniform2f(uResolution, el!.width, el!.height)
      gl!.uniform1f(uTime, time)
      gl!.uniform3f(uFrom, c.from[0], c.from[1], c.from[2])
      gl!.uniform3f(uTo, c.to[0], c.to[1], c.to[2])
      gl!.uniform1f(uScale, Math.max(0.1, scale))
      gl!.drawArrays(gl!.TRIANGLES, 0, 3)
    }

    let running = false
    let offscreen = false
    let raf = 0

    function frame(now: number) {
      raf = 0
      const c = tints()
      if (!c) {
        running = false
        return
      }
      // Clamp dt so background-tab resume does not jump the flow.
      const dt = last === null ? 0 : Math.min((now - last) / 1000, 0.064)
      last = now
      time += dt * Math.max(0, speed)
      draw(c)
      if (running) raf = requestAnimationFrame(frame)
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

    function syncLoop() {
      const shouldRun = !reducedMotion.matches && !offscreen
      if (shouldRun && !running) {
        running = true
        last = null
        raf = requestAnimationFrame(frame)
      } else if (!shouldRun && running) {
        running = false
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        const c = tints()
        if (c) draw(c)
      }
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(el)
    resize()

    const intersectionObserver = new IntersectionObserver((entries) => {
      offscreen = !(entries[0]?.isIntersecting ?? true)
      syncLoop()
    })
    intersectionObserver.observe(el)

    const onReducedMotionChange = () => syncLoop()
    reducedMotion.addEventListener('change', onReducedMotionChange)

    syncLoop()

    return () => {
      running = false
      if (raf) cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      reducedMotion.removeEventListener('change', onReducedMotionChange)
      gl.deleteProgram(program)
      gl.deleteBuffer(buffer)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  })
</script>

<canvas
  bind:this={canvas}
  class="water-flow {className}"
  class:pixelated={resolution !== undefined && cells === undefined}
  class:cells={cellGrid !== undefined}
  class:static-fallback={staticFallback}
  style="--water-from: {from}; --water-to: {to}; --cells-x: {cellGrid?.x ?? 1}; --cells-y: {cellGrid?.y ?? 1}"
  data-water-flow={staticFallback ? 'static' : 'webgl'}
  aria-hidden="true"
></canvas>

<style>
  .water-flow {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
  }

  .water-flow.pixelated {
    image-rendering: pixelated;
  }

  /* Rounded-pill grid: an SVG mask of a single rounded rect, tiled at
     --cells-x / --cells-y cells across the canvas. Gaps show the host surface
     through. Decoupled from canvas resolution so pills can show smooth
     internal gradients. */
  .water-flow.cells {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'%3E%3Crect x='7' y='4' width='86' height='92' rx='12' ry='5'/%3E%3C/svg%3E");
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'%3E%3Crect x='7' y='4' width='86' height='92' rx='12' ry='5'/%3E%3C/svg%3E");
    -webkit-mask-size: calc(100% / var(--cells-x)) calc(100% / var(--cells-y));
    mask-size: calc(100% / var(--cells-x)) calc(100% / var(--cells-y));
    -webkit-mask-repeat: repeat;
    mask-repeat: repeat;
  }

  .water-flow.static-fallback {
    background: linear-gradient(135deg, var(--water-from), var(--water-to));
  }
</style>
