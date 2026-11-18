/**
 * The branded graphic as a PNG at the post's real pixel size (e.g. 1080 ×
 * 1350): drawn on a canvas from the rendered preview itself — every part's
 * box, colour and type come from the live layout (the active style's tokens
 * resolved by the browser), scaled up. No second layout to drift from the
 * preview. Text is re-flowed into each part's box at the same type size.
 */

const TEXT_PARTS = new Set(['name', 'headline', 'body', 'cta'])

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line)
        line = word
      } else line = next
    }
    lines.push(line)
  }
  return lines
}

function drawText(ctx: CanvasRenderingContext2D, el: HTMLElement, x: number, y: number, width: number): void {
  const cs = getComputedStyle(el)
  const size = parseFloat(cs.fontSize)
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  ctx.fillStyle = cs.color
  ctx.textBaseline = 'middle'
  if ('letterSpacing' in ctx && cs.letterSpacing !== 'normal') (ctx as { letterSpacing: string }).letterSpacing = cs.letterSpacing
  const lineHeight = cs.lineHeight === 'normal' ? size * 1.2 : parseFloat(cs.lineHeight)
  const padL = parseFloat(cs.paddingLeft)
  const padT = parseFloat(cs.paddingTop)
  const inner = width - padL - parseFloat(cs.paddingRight)
  const raw = el.textContent ?? ''
  const text = cs.textTransform === 'uppercase' ? raw.toUpperCase() : raw
  wrap(ctx, text, inner + 0.5).forEach((line, i) => ctx.fillText(line, x + padL, y + padT + lineHeight * (i + 0.5)))
  if ('letterSpacing' in ctx) (ctx as { letterSpacing: string }).letterSpacing = '0px'
}

export async function renderGraphicPng(root: HTMLElement, size: { width: number; height: number }): Promise<Blob> {
  const article = root.querySelector('article')
  if (!article) throw new Error('The graphic is not on the page.')
  await document.fonts?.ready
  const box = article.getBoundingClientRect()
  if (box.width === 0) throw new Error('The graphic has no size yet.')
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot draw the graphic.')
  const s = size.width / box.width
  ctx.setTransform(s, 0, 0, s, 0, 0)
  ctx.fillStyle = getComputedStyle(article).backgroundColor
  ctx.fillRect(0, 0, box.width, box.height)

  for (const el of article.querySelectorAll<HTMLElement>('[data-part]')) {
    const part = el.dataset.part ?? ''
    const r = el.getBoundingClientRect()
    const x = r.left - box.left
    const y = r.top - box.top
    const cs = getComputedStyle(el)
    const bg = cs.backgroundColor
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      ctx.fillStyle = bg
      ctx.beginPath()
      ctx.roundRect(x, y, r.width, r.height, Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.height / 2, r.width / 2))
      ctx.fill()
    }
    if (TEXT_PARTS.has(part)) drawText(ctx, el, x, y, r.width)
  }

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The graphic could not be turned into a PNG.'))), 'image/png'),
  )
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A file name from the post title (letters, digits and dashes). */
export function fileStem(title: string): string {
  const stem = title
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return stem || 'social-post'
}
