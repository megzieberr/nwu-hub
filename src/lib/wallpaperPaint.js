// The other half of the wallpaper: it carries out the draw instructions from lib/wallpaper.js on
// a canvas and saves the PNG. Deliberately dumb. If the wrong thing is on the picture, the fault is
// in wallpaper.js (which has checks), not here.

import { buildWallpaper, wallpaperSize } from './wallpaper.js'

// The hub's two fonts, each with a fallback that is already on every laptop.
const FAMILY = {
  body: "'Rajdhani', system-ui, sans-serif",
  display: "'Orbitron', sans-serif",
}
// Every weight the picture uses. Loaded BEFORE anything is measured.
const FACES = ["600 16px 'Rajdhani'", "700 16px 'Rajdhani'", "700 16px 'Orbitron'", "900 16px 'Orbitron'"]

const fontString = (f) => `${f.weight || 400} ${f.size}px ${FAMILY[f.family] || FAMILY.body}`

function setFont(ctx, f) {
  ctx.font = fontString(f)
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${f.spacing || 0}px`
}

// The measuring function lib/wallpaper.js lays the text out with: the same canvas, the same font
// strings as the drawing below, so what is measured is what is drawn.
export function measureWith(ctx) {
  return (text, font) => {
    setFont(ctx, font)
    return ctx.measureText(String(text)).width
  }
}

// Offline with nothing cached, the fonts never arrive. Three seconds, then carry on in the
// fallback font: a plainer picture, still a whole one.
async function loadFonts() {
  if (typeof document === 'undefined' || !document.fonts) return
  const wait = new Promise((resolve) => setTimeout(resolve, 3000))
  try {
    await Promise.race([Promise.all(FACES.map((f) => document.fonts.load(f))), wait])
  } catch { /* the fallback font takes over */ }
}

// A line or an edge one pixel wide is only sharp when it runs down the MIDDLE of a pixel.
const crisp = (v, width) => (Math.round(width) % 2 ? Math.floor(v) + 0.5 : Math.round(v))

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r || 0, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

export function paint(layout, canvas) {
  const { page, ops } = layout
  canvas.width = page.w
  canvas.height = page.h
  const ctx = canvas.getContext('2d')
  ctx.textBaseline = 'alphabetic'

  for (const o of ops) {
    ctx.save()
    switch (o.op) {
      case 'rect': {
        const lw = o.stroke ? (o.strokeWidth || 1) : 0
        const x = lw ? crisp(o.x, lw) : Math.round(o.x)
        const y = lw ? crisp(o.y, lw) : Math.round(o.y)
        roundRect(ctx, x, y, Math.round(o.w), Math.round(o.h), o.radius)
        if (o.fill) {
          ctx.fillStyle = o.fill
          ctx.fill()
        }
        if (o.stroke) {
          ctx.strokeStyle = o.stroke
          ctx.lineWidth = lw
          ctx.setLineDash(o.dash || [])
          ctx.stroke()
        }
        break
      }

      // A soft glow: an oval that fades from its colour to nothing (the page's radial-gradient).
      case 'radial': {
        ctx.translate(o.cx, o.cy)
        ctx.scale(o.rx, o.ry)
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
        g.addColorStop(0, o.color)
        g.addColorStop(o.fade, o.colorEnd)
        ctx.fillStyle = g
        ctx.fillRect(-o.cx / o.rx, -o.cy / o.ry, page.w / o.rx, page.h / o.ry)
        break
      }

      case 'line': {
        const lw = o.width || 1
        const flat = o.y1 === o.y2
        ctx.beginPath()
        ctx.moveTo(flat ? o.x1 : crisp(o.x1, lw), flat ? crisp(o.y1, lw) : o.y1)
        ctx.lineTo(flat ? o.x2 : crisp(o.x2, lw), flat ? crisp(o.y2, lw) : o.y2)
        ctx.strokeStyle = o.color
        ctx.lineWidth = lw
        ctx.setLineDash(o.dash || [])
        ctx.stroke()
        break
      }

      case 'text': {
        setFont(ctx, o.font)
        ctx.fillStyle = o.color
        ctx.globalAlpha = o.alpha ?? 1
        ctx.textAlign = o.align || 'left'
        if (o.glow) {
          ctx.shadowColor = o.glow.color
          ctx.shadowBlur = o.glow.blur
        }
        let x = o.x
        let y = o.y
        if (o.rotate) {
          ctx.translate(x, y)
          ctx.rotate((o.rotate * Math.PI) / 180)
          x = 0
          y = 0
        }
        ctx.fillText(o.text, x, y)
        // A ticked-off block wears a line through its words, as it does on the Week tab.
        if (o.strike) {
          const w = ctx.measureText(o.text).width
          const x0 = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x
          const sy = crisp(y - o.font.size * 0.28, 1)
          ctx.beginPath()
          ctx.moveTo(x0, sy)
          ctx.lineTo(x0 + w, sy)
          ctx.strokeStyle = o.color
          ctx.lineWidth = Math.max(1, Math.round(o.font.size / 14))
          ctx.stroke()
        }
        break
      }

      default:
        // An unknown instruction is a programming error; skipping it quietly would hide a whole
        // missing piece of the picture.
        console.warn('wallpaper paint: unknown op', o.op)
    }
    ctx.restore()
  }
  return canvas
}

// Her week as a finished picture on `canvas`, at the real size of the screen it is made on
// (or at `size`, when the caller names one).
export async function renderWallpaper(model, canvas = document.createElement('canvas'), size = null) {
  await loadFonts()
  const real = size || wallpaperSize({
    width: window.screen.width, height: window.screen.height, dpr: window.devicePixelRatio,
    outerWidth: window.outerWidth, innerWidth: window.innerWidth,
  })
  const measure = measureWith(document.createElement('canvas').getContext('2d'))
  return paint(buildWallpaper({ size: real, model, measure }), canvas)
}

function toBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the picture came out empty'))), 'image/png')
  })
}

// A blob: link, like WhenWorks' wallpaper, not a data: link: her download manager (IDM) takes over
// Chrome downloads and cannot fetch a data: address.
export async function saveCanvas(canvas, filename) {
  const url = URL.createObjectURL(await toBlob(canvas))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked a moment later: revoking at once can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
