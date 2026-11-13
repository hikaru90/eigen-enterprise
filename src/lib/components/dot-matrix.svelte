<script lang="ts" module>
  /** 5×7 digits, one string per row ('1' = lit), as on the website's display tile. */
  const GLYPHS: Record<string, readonly string[]> = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  }
  const ROWS = 7

  /** The lit dots of `text` laid out left to right, one blank column between glyphs. */
  export function litDots(text: string): { cols: number; on: Record<string, true> } {
    const on: Record<string, true> = {}
    let x = 0
    for (const ch of text) {
      const glyph = GLYPHS[ch]
      if (!glyph) throw new Error(`dot-matrix: no glyph for "${ch}"`)
      glyph.forEach((row, y) => {
        for (let c = 0; c < row.length; c++) if (row[c] === '1') on[`${x + c},${y}`] = true
      })
      x += 6
    }
    return { cols: Math.max(0, x - 1), on }
  }
</script>

<script lang="ts">
  /**
   * The website's dot-matrix display: a field of faint dots with the value
   * lit (white, or the coral accent when it needs attention). Decorative —
   * the caller states the value in text too.
   */
  let {
    text,
    lit: litColour = '#ffffff',
    cols = 23,
    rows = 11,
  }: { text: string; lit?: string; cols?: number; rows?: number } = $props()

  const lit = $derived(litDots(text))
  const width = $derived(Math.max(cols, lit.cols + 2))
  const offsetX = $derived(Math.floor((width - lit.cols) / 2))
  const offsetY = $derived(Math.floor((rows - ROWS) / 2))
  const dots = $derived(
    Array.from({ length: width * rows }, (_, i) => {
      const x = i % width
      const y = Math.floor(i / width)
      return { x, y, on: lit.on[`${x - offsetX},${y - offsetY}`] === true }
    }),
  )
</script>

<svg
  class="block h-full w-full"
  viewBox="0 0 {width} {rows}"
  preserveAspectRatio="xMidYMid meet"
  aria-hidden="true"
  data-testid="dot-matrix"
>
  {#each dots as d (`${d.x},${d.y}`)}
    <circle cx={d.x + 0.5} cy={d.y + 0.5} r="0.36" fill={d.on ? litColour : 'rgb(255 255 255 / 0.075)'} />
  {/each}
</svg>
