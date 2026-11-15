import React, { useEffect, useRef } from 'react'
import { useJson, HOME, fitSet, color, css, ease, lineStrength } from './shared.js'

// The 2D world map, the light option for lower-end devices: one canvas, Equal Earth projection (the
// whole world without the polar blow-up; Finland stays recognisable). Coastlines, borders and lakes
// (Natural Earth 1:10m, web/public/world.json: detailed in Northern Europe, simplified elsewhere) are
// built once as Path2D and cached on an offscreen layer per view, so a hover redraws only dots and lines.
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2
export function project(lon, lat) {
  const l = lon * Math.PI / 180, t = Math.asin(M * Math.sin(lat * Math.PI / 180))
  const t2 = t * t, t6 = t2 * t2 * t2
  return [(2 * Math.sqrt(3) * l * Math.cos(t)) / (3 * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1)),
          -t * (A4 * t6 * t2 + A3 * t6 + A2 * t2 + A1)]
}
const FINLAND = [[20.0, 59.6], [31.6, 70.2]]
const WORLD = [[-180, -58], [180, 84]]
const CITIES = [['Helsinki', 24.94, 60.17], ['Turku', 22.27, 60.45], ['Tampere', 23.76, 61.5], ['Oulu', 25.47, 65.01],
  ['Rovaniemi', 25.73, 66.5], ['Vaasa', 21.62, 63.1], ['Joensuu', 29.76, 62.6], ['Viipuri', 28.73, 60.71],
  ['Stockholm', 18.07, 59.33], ['Tallinn', 24.75, 59.44], ['Pietari', 30.31, 59.94], ['Oslo', 10.75, 59.91],
  ['Riga', 24.11, 56.95], ['Kööpenhamina', 12.57, 55.68], ['Moskova', 37.62, 55.75], ['Petroskoi', 34.35, 61.79],
  ['Berliini', 13.4, 52.52], ['Lontoo', -0.13, 51.51], ['Pariisi', 2.35, 48.86], ['Rooma', 12.5, 41.9]]

const box = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}
const lonlatBox = ([[lo0, la0], [lo1, la1]]) => box([project(lo0, la0), project(lo1, la1), project(lo0, la1), project(lo1, la0)])

function fit([x0, y0, x1, y1], [w, h], pad = 60) {
  const sx = Math.max(x1 - x0, 0.02), sy = Math.max(y1 - y0, 0.02)
  const s = Math.min((w - 2 * pad) / sx, (h - 2 * pad) / sy)
  return { s, tx: w / 2 - ((x0 + x1) / 2) * s, ty: h / 2 - ((y0 + y1) / 2) * s }
}

export default function Map2D({ dots, pin, hoverId, neigh, semantic, onHover, onPick }) {
  const wrap = useRef(null), canvas = useRef(null)
  const geo = useJson('world.json')
  const st = useRef({ view: null, target: null, base: null, baseKey: '', dots: [], dirty: true, size: [0, 0], dpr: 1 })
  const s = st.current
  s.pin = pin; s.hoverId = hoverId; s.lines = neigh; s.semantic = semantic; s.geo = geo
  s.dirty = true

  useEffect(() => { window.__map = st.current }, [])     // the Playwright demo script reads dot positions

  // fit to the filter's dots (always with Finland in view) when they change
  useEffect(() => {
    s.dots = dots
    for (const d of dots) { [d.wx, d.wy] = project(d.lon, d.lat) }
    if (!s.size[0]) return
    const use = fitSet(dots)
    const pts = use.map((d) => [d.wx, d.wy])
    const fin = lonlatBox(FINLAND)
    const b = box(pts.concat([[fin[0], fin[1]], [fin[2], fin[3]]]))
    s.target = fit(b, s.size)
    const widest = fit(lonlatBox(WORLD), s.size, 10)
    if (s.target.s < widest.s) s.target = widest
    if (!s.view) s.view = { ...s.target }
    s.anim = { from: { ...s.view }, t0: performance.now() }
    s.dirty = true
  }, [dots])

  useEffect(() => {
    const c = canvas.current
    const resize = () => {
      if (!wrap.current) return
      const r = wrap.current.getBoundingClientRect()
      s.dpr = Math.min(2, window.devicePixelRatio || 1)
      s.size = [r.width, r.height]
      c.width = Math.round(r.width * s.dpr); c.height = Math.round(r.height * s.dpr)
      c.style.width = `${r.width}px`; c.style.height = `${r.height}px`
      if (!s.view) { s.view = fit(lonlatBox(FINLAND), s.size); s.target = { ...s.view } }
      s.baseKey = ''; s.dirty = true
    }
    const ro = new ResizeObserver(resize)
    ro.observe(wrap.current)
    resize()
    let raf
    const frame = (now) => {
      raf = requestAnimationFrame(frame)
      const busy = step(s, now)
      if (s.dirty || busy) { const t = performance.now(); draw(s, c); s.frameMs = performance.now() - t; s.dirty = false }
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  // input: hover / click pick the nearest dot; drag pans, the wheel zooms around the cursor
  useEffect(() => {
    const c = canvas.current
    const at = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
    const pick = (x, y) => {
      let best = null, bd = 14 * 14
      for (const d of s.dots) {
        const dx = d.sx - x, dy = d.sy - y, dd = dx * dx + dy * dy
        if (dd < bd) { bd = dd; best = d }
      }
      return best
    }
    const move = (e) => {
      const [x, y] = at(e)
      if (s.drag) {
        s.view.tx += x - s.drag[0]; s.view.ty += y - s.drag[1]
        s.drag = [x, y, s.drag[2] || Math.abs(x - s.drag[0]) + Math.abs(y - s.drag[1]) > 3]
        s.anim = null; s.baseKey = ''; s.dirty = true
        return
      }
      const d = pick(x, y)
      c.style.cursor = d ? 'pointer' : 'grab'
      onHover(d, x, y)
    }
    const down = (e) => { s.drag = [...at(e), false]; c.style.cursor = 'grabbing' }
    const up = (e) => {
      if (!s.drag) return                          // the press did not start on the map (e.g. the card)
      const moved = s.drag[2]
      s.drag = null; c.style.cursor = 'grab'
      if (!moved) { const [x, y] = at(e); onPick(pick(x, y)) }
    }
    const leave = () => { s.drag = null; onHover(null) }
    const wheel = (e) => {
      e.preventDefault()
      const [x, y] = at(e)
      const v = s.view
      const minS = fit(lonlatBox(WORLD), s.size, 10).s
      const ns = Math.max(minS, Math.min(60000, v.s * Math.exp(-e.deltaY * 0.0015)))
      v.tx = x - (x - v.tx) * (ns / v.s); v.ty = y - (y - v.ty) * (ns / v.s); v.s = ns
      s.anim = null; s.baseKey = ''; s.dirty = true
    }
    c.addEventListener('mousemove', move); c.addEventListener('mousedown', down)
    window.addEventListener('mouseup', up); c.addEventListener('mouseleave', leave)
    c.addEventListener('wheel', wheel, { passive: false })
    return () => {
      c.removeEventListener('mousemove', move); c.removeEventListener('mousedown', down)
      window.removeEventListener('mouseup', up); c.removeEventListener('mouseleave', leave)
      c.removeEventListener('wheel', wheel)
    }
  }, [onHover, onPick])

  return (
    <div className="mapcanvas" ref={wrap}>
      <canvas ref={canvas} />
      {!geo && <div className="maploading">Loading the map…</div>}
    </div>
  )
}

export const frameMs2D = () => window.__map?.frameMs

function step(s, now) {
  let busy = false
  if (s.anim && s.target) {
    const u = Math.min(1, (now - s.anim.t0) / 600), e = ease(u)
    const a = s.anim.from, b = s.target
    const ls = Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * e
    s.view = { s: Math.exp(ls), tx: a.tx + (b.tx - a.tx) * e, ty: a.ty + (b.ty - a.ty) * e }
    s.baseKey = ''
    if (u >= 1) s.anim = null
    busy = true
  }
  for (const id of [s.hoverId, s.pin?.id]) {
    const l = id && s.lines?.[id]
    if (l?.t0 && now - l.t0 < 450) busy = true
  }
  return busy
}

function buildPaths(geo) {
  const ring = (path, pts) => {
    pts.forEach(([lo, la], i) => { const [x, y] = project(lo, la); i ? path.lineTo(x, y) : path.moveTo(x, y) })
    path.closePath()
  }
  const land = new Path2D(), fin = new Path2D(), lakes = new Path2D()
  for (const c of geo.land) for (const p of c.polys) { ring(land, p); if (c.iso === 'FI') ring(fin, p) }
  for (const p of geo.lakes) ring(lakes, p)
  const [gx0, gy0] = project(-180, 0), [gx1] = project(180, 0)
  const graticule = new Path2D()               // the world's outline (Equal Earth's rounded edge)
  for (let la = -90; la <= 90; la += 2) { const [x, y] = project(-180, la); la === -90 ? graticule.moveTo(x, y) : graticule.lineTo(x, y) }
  for (let la = 90; la >= -90; la -= 2) { const [x, y] = project(180, la); graticule.lineTo(x, y) }
  graticule.closePath()
  return { land, fin, lakes, graticule, cities: CITIES.map(([n, lo, la]) => [n, ...project(lo, la)]), gx0, gy0, gx1 }
}

function drawBase(s) {
  const [w, h] = s.size, dpr = s.dpr, v = s.view
  const key = `${w}x${h}@${dpr}:${v.s.toFixed(3)},${v.tx.toFixed(1)},${v.ty.toFixed(1)}`
  if (s.baseKey === key && s.base) return s.base
  s.paths ||= buildPaths(s.geo)
  const b = s.base || document.createElement('canvas')
  b.width = Math.round(w * dpr); b.height = Math.round(h * dpr)
  const g = b.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.fillStyle = css('--map-space'); g.fillRect(0, 0, w, h)
  g.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty)
  const px = 1 / v.s
  g.fillStyle = css('--map-sea'); g.fill(s.paths.graticule)
  g.fillStyle = css('--map-land'); g.fill(s.paths.land, 'evenodd')
  g.fillStyle = css('--map-finland'); g.fill(s.paths.fin, 'evenodd')
  g.fillStyle = css('--map-sea'); g.fill(s.paths.lakes)
  g.lineJoin = 'round'
  g.strokeStyle = css('--map-border'); g.lineWidth = 0.8 * px; g.stroke(s.paths.land)
  g.strokeStyle = css('--map-finland-border'); g.lineWidth = 1.3 * px; g.stroke(s.paths.fin)
  if (v.s > 900) {                                  // city names once you are close enough to read them
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.font = '500 11px Inter, system-ui, sans-serif'
    g.fillStyle = css('--map-label')
    for (const [n, x, y] of s.paths.cities) {
      const sx = x * v.s + v.tx, sy = y * v.s + v.ty
      if (sx < -50 || sy < -20 || sx > w + 50 || sy > h + 20) continue
      g.beginPath(); g.arc(sx, sy, 1.6, 0, 7); g.fill()
      g.fillText(n, sx + 4, sy - 3)
    }
  }
  s.base = b; s.baseKey = key
  return b
}

function draw(s, c) {
  if (!s.geo || !s.view) return
  const ctx = c.getContext('2d')
  const v = s.view
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(drawBase(s), 0, 0)
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0)
  const zoom = Math.log2(v.s / 400)
  const r0 = Math.max(2, Math.min(6, 2.6 + 0.75 * (zoom - 2)))
  // stacked dots: a sunflower, spaced like on the ground (STACK_KM) but never closer than 1.5 px
  const step = Math.max(1.5, 0.00055 * v.s)
  for (const d of s.dots) {
    const a = d.k * 2.39996, rr = d.k ? step * Math.sqrt(d.k) : 0
    d.sx = d.wx * v.s + v.tx + rr * Math.cos(a); d.sy = d.wy * v.s + v.ty + rr * Math.sin(a)
    d.rad = s.semantic && d.sim != null ? 2.5 + 9 * d.sim : r0
  }
  const byId = new Map(s.dots.map((d) => [d.id, d]))
  const hover = s.hoverId && byId.get(s.hoverId)
  const active = [s.pin && byId.get(s.pin.id), hover].filter(Boolean)
  const focus = new Set()
  for (const src of active) {
    const l = s.lines?.[src.id]
    if (!l?.data) continue
    const p = Math.min(1, (performance.now() - l.t0) / 450)
    for (const [i, n] of l.data.entries()) {
      const d = byId.get(n.wikidata_id)
      let tx, ty
      if (d) { tx = d.sx; ty = d.sy; focus.add(d.id) } else { const [wx, wy] = project(n.lon, n.lat); tx = wx * v.s + v.tx; ty = wy * v.s + v.ty }
      const t = lineStrength(n.similarity)
      const pe = ease(Math.max(0, Math.min(1, p * 1.4 - i * 0.04)))
      curve(ctx, src.sx, src.sy, tx, ty, pe, 0.9 + 4.2 * t, `rgba(47, 93, 138, ${0.28 + 0.55 * t})`)
      if (!d && pe > 0.95) { ctx.strokeStyle = 'rgba(47,93,138,.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(tx, ty, 3.5, 0, 7); ctx.stroke() }
    }
  }
  const dim = active.length > 0
  for (const d of s.dots) {
    const on = focus.has(d.id) || active.includes(d)
    ctx.beginPath(); ctx.arc(d.sx, d.sy, d.rad, 0, 7)
    ctx.fillStyle = color(d.r.score, dim && !on ? 0.35 : 0.92); ctx.fill()
    ctx.lineWidth = 0.8; ctx.strokeStyle = dim && !on ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.9)'; ctx.stroke()
  }
  for (const src of active) {
    ctx.beginPath(); ctx.arc(src.sx, src.sy, src.rad + 4, 0, 7)
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(29,27,24,.85)'; ctx.stroke()
  }
  const pinDot = s.pin && byId.get(s.pin.id)
  const labelled = pinDot && s.lines?.[pinDot.id]?.data ? s.lines[pinDot.id].data.slice(0, 6) : []
  ctx.font = '500 11px Inter, system-ui, sans-serif'
  for (const n of labelled) {
    const d = byId.get(n.wikidata_id)
    if (d) halo(ctx, n.titles.fi, d.sx + d.rad + 4, d.sy + 4)
  }
  if (pinDot) { ctx.font = '600 13px Inter, system-ui, sans-serif'; halo(ctx, pinDot.r.titles.fi, pinDot.sx + pinDot.rad + 7, pinDot.sy - 7) }
}

function halo(ctx, text, x, y) {
  ctx.lineWidth = 3.5; ctx.strokeStyle = css('--map-halo'); ctx.lineJoin = 'round'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = css('--map-text'); ctx.fillText(text, x, y)
}

// A gently bent line from (x0,y0) towards (x1,y1), drawn up to fraction p (the draw-in animation).
function curve(ctx, x0, y0, x1, y1, p, width, stroke) {
  if (p <= 0) return
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0
  const cx = mx - dy * 0.18, cy = my + dx * 0.18
  ctx.beginPath(); ctx.moveTo(x0, y0)
  const n = 28
  for (let i = 1; i <= Math.ceil(n * p); i++) {
    const t = Math.min(p, i / n), u = 1 - t
    ctx.lineTo(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1)
  }
  ctx.lineCap = 'round'; ctx.lineWidth = width; ctx.strokeStyle = stroke; ctx.stroke()
}

export { HOME }
