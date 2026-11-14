import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { useSql } from './SqlDrawer.jsx'

// The map: every article in the current filter as a dot at its place, coloured by score (how much it
// needs an editor); with a semantic search, dot size = similarity to the query. Hover or click a dot:
// lines to its 10 most similar articles (VEC_DISTANCE on the article vectors), thicker = more similar.
// Click the name in the card to open the article page.
//
// 2D canvas, Lambert azimuthal equal-area centred on Finland. The coastline, borders and lakes
// (Natural Earth 1:10m, web/public/nordic.json) are built once as Path2D and cached on an offscreen
// layer per view, so hovering only redraws dots and lines.
const LON0 = 25 * Math.PI / 180, LAT0 = 62 * Math.PI / 180
const SIN0 = Math.sin(LAT0), COS0 = Math.cos(LAT0)
function project(lon, lat) {
  const l = lon * Math.PI / 180 - LON0, p = lat * Math.PI / 180
  const k = Math.sqrt(2 / (1 + SIN0 * Math.sin(p) + COS0 * Math.cos(p) * Math.cos(l)))
  return [k * Math.cos(p) * Math.sin(l), -k * (COS0 * Math.sin(p) - SIN0 * Math.cos(p) * Math.cos(l))]
}
const HOME = [[20.0, 59.6], [31.6, 70.2]]                     // Finland
const MAX_LINES = 10
const CORE = [[4, 53.5], [42, 71.5]]                          // the Nordic-Baltic core the view fits to
const inCore = (lon, lat) => lon >= CORE[0][0] && lon <= CORE[1][0] && lat >= CORE[0][1] && lat <= CORE[1][1]
const LIMIT = [[-8, 47], [56, 74]]                            // never zoom out beyond this (the data ends further out)
const CITIES = [['Helsinki', 24.94, 60.17], ['Turku', 22.27, 60.45], ['Tampere', 23.76, 61.5], ['Oulu', 25.47, 65.01],
  ['Rovaniemi', 25.73, 66.5], ['Vaasa', 21.62, 63.1], ['Joensuu', 29.76, 62.6], ['Viipuri', 28.73, 60.71],
  ['Stockholm', 18.07, 59.33], ['Tallinn', 24.75, 59.44], ['Pietari', 30.31, 59.94], ['Oslo', 10.75, 59.91],
  ['Riga', 24.11, 56.95], ['Kööpenhamina', 12.57, 55.68], ['Moskova', 37.62, 55.75], ['Petroskoi', 34.35, 61.79]]

let geoCache = null, placesCache = null
const simCache = new Map()

const RAMP = [[0, [66, 146, 132]], [0.5, [226, 178, 74]], [0.8, [214, 108, 62]], [1, [178, 40, 48]]]
function color(t, a = 1) {
  t = Math.max(0, Math.min(1, t ?? 0))
  let i = 0
  while (i < RAMP.length - 2 && t > RAMP[i + 1][0]) i++
  const [t0, c0] = RAMP[i], [t1, c1] = RAMP[i + 1]
  const u = (t - t0) / (t1 - t0)
  return `rgba(${c0.map((c, j) => Math.round(c + (c1[j] - c) * u)).join(',')},${a})`
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const ease = (x) => 1 - Math.pow(1 - x, 3)

export default function MapView({ res, filter, onOpen }) {
  const wrap = useRef(null), canvas = useRef(null)
  const st = useRef({ view: null, target: null, base: null, baseKey: '', dots: [], hover: null, pin: null,
                      lines: {}, dirty: true, drag: null, size: [0, 0], dpr: 1, paths: null })
  const [geo, setGeo] = useState(geoCache)
  const [places, setPlaces] = useState(placesCache)
  const [hover, setHover] = useState(null)   // {dot, x, y}
  const [pin, setPin] = useState(null)       // dot
  const [neigh, setNeigh] = useState({})     // wikidata_id -> /api/similar answer
  const [perf, setPerf] = useState(null)
  const semantic = !!(filter.q && filter.mode === 'meaning')

  useEffect(() => {
    if (!geoCache) fetch(`${import.meta.env.BASE_URL}nordic.json`).then((r) => r.json()).then((g) => { geoCache = g; setGeo(g) })
    if (!placesCache) api.topicPlaces().then((p) => { placesCache = p; setPlaces(p) })
  }, [])

  // Dots for the topics in the filter that have a place inside the map's box.
  const { dots, outside } = useMemo(() => {
    if (!res || !places || !geo) return { dots: [], outside: 0 }
    const [x0, y0, x1, y1] = geo.box
    const sims = res.data.map((r) => r.similarity).filter((v) => v != null)
    const smin = Math.min(...sims), smax = Math.max(...sims)
    const list = []
    let out = 0
    const stack = new Map()
    for (const r of res.data) {
      const p = places.data[r.wikidata_id]
      if (!p) continue
      const [lat, lon] = p
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) { out++; continue }
      const [wx, wy] = project(lon, lat)
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`
      const k = stack.get(key) || 0
      stack.set(key, k + 1)
      const sim = r.similarity != null && smax > smin ? (r.similarity - smin) / (smax - smin) : null
      list.push({ r, id: r.wikidata_id, wx, wy, k, sim, place: p[3], located: p[2], core: inCore(lon, lat) })
    }
    // the most urgent on top
    list.sort((a, b) => (semantic ? (a.sim ?? 0) - (b.sim ?? 0) : (a.r.score ?? 0) - (b.r.score ?? 0)))
    return { dots: list, outside: out }
  }, [res, places, geo, semantic])

  // Fit the view to the dots (or Finland) whenever the filter changes.
  useEffect(() => {
    const s = st.current
    s.dots = dots
    if (!s.size[0]) return
    // fit to the Nordic-Baltic dots when there are enough of them; a few far-away ones stay off screen
    const core = dots.filter((d) => d.core)
    const use = core.length >= Math.max(5, dots.length * 0.6) ? core : dots
    const pts = use.length ? use.map((d) => [d.wx, d.wy]) : HOME.map(([lo, la]) => project(lo, la))
    const home = HOME.map(([lo, la]) => project(lo, la))
    // never zoom further out than Finland + neighbours, nor in more than a region
    // always keep Finland in view; the dots may widen it
    const xs = pts.map((p) => p[0]).concat(home.map((p) => p[0]))
    const ys = pts.map((p) => p[1]).concat(home.map((p) => p[1]))
    s.target = fit(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), s.size)
    const lim = LIMIT.map(([lo, la]) => project(lo, la))
    const widest = fit(lim[0][0], lim[1][1], lim[1][0], lim[0][1], s.size)
    if (s.target.s < widest.s) s.target = widest
    if (!s.view) s.view = { ...s.target }
    s.anim = { from: { ...s.view }, t0: performance.now() }
    s.hover = null; s.dirty = true
    setHover(null)
  }, [dots])

  useEffect(() => { window.__map = st.current }, [])     // for the Playwright demo script: dot positions
  useEffect(() => { st.current.pin = pin; st.current.dirty = true }, [pin])
  useEffect(() => { st.current.lines = neigh; st.current.dirty = true }, [neigh])

  // Neighbours of the hovered / pinned dot (cached; at most two sets on screen = 20 lines).
  const want = [hover?.dot?.id, pin?.id].filter(Boolean)
  useEffect(() => {
    for (const id of want) {
      if (simCache.has(id)) { if (!neigh[id]) setNeigh((n) => ({ ...n, [id]: { ...simCache.get(id), t0: performance.now() } })); continue }
      simCache.set(id, null)
      const t0 = performance.now()
      api.similar(id, MAX_LINES).then((r) => {
        r.wall_ms = Math.round(performance.now() - t0)
        simCache.set(id, r)
        setNeigh((n) => ({ ...n, [id]: { ...r, t0: performance.now() } }))
      }).catch(() => simCache.delete(id))
    }
  }, [want.join('|')])

  const shownSim = neigh[pin?.id] || neigh[hover?.dot?.id]
  useSql([
    ...(res ? res.sql.map((s) => ({ ...s, ms: res.ms })) : []),
    ...(shownSim ? shownSim.sql.map((s) => ({ ...s, ms: shownSim.ms })) : []),
    ...(places ? places.sql.map((s) => ({ ...s, ms: places.ms })) : []),
  ], [res, places, shownSim])

  // ---- canvas: size, input, render loop
  useEffect(() => {
    const s = st.current, c = canvas.current
    const resize = () => {
      if (!wrap.current) return
      const r = wrap.current.getBoundingClientRect()
      s.dpr = Math.min(2, window.devicePixelRatio || 1)
      s.size = [r.width, r.height]
      c.width = Math.round(r.width * s.dpr); c.height = Math.round(r.height * s.dpr)
      c.style.width = `${r.width}px`; c.style.height = `${r.height}px`
      if (!s.view && s.dots) {
        const pts = HOME.map(([lo, la]) => project(lo, la))
        s.view = fit(pts[0][0], pts[1][1], pts[1][0], pts[0][1], s.size)
        s.target = { ...s.view }
      }
      s.baseKey = ''; s.dirty = true
    }
    const ro = new ResizeObserver(resize)
    ro.observe(wrap.current)
    resize()
    let raf
    const frame = (now) => {
      raf = requestAnimationFrame(frame)
      const animating = step(s, now)
      if (s.dirty || animating) { const t = performance.now(); draw(s, c, geo, semantic); s.frameMs = performance.now() - t; s.dirty = false }
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [geo, semantic])

  useEffect(() => {
    const s = st.current, c = canvas.current
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
      if (d !== s.hover) { s.hover = d; s.dirty = true; c.style.cursor = d ? 'pointer' : 'grab' }
      setHover(d ? { dot: d, x, y } : null)
    }
    const down = (e) => { s.drag = [...at(e), false]; c.style.cursor = 'grabbing' }
    const up = (e) => {
      if (!s.drag) return                          // the press did not start on the map (e.g. the card)
      const moved = s.drag?.[2]
      s.drag = null; c.style.cursor = s.hover ? 'pointer' : 'grab'
      if (!moved) { const [x, y] = at(e); const d = pick(x, y); setPin(d || null) }
    }
    const leave = () => { s.drag = null; if (s.hover) { s.hover = null; s.dirty = true } setHover(null) }
    const wheel = (e) => {
      e.preventDefault()
      const [x, y] = at(e)
      const f = Math.exp(-e.deltaY * 0.0015)
      const v = s.view
      const lim = LIMIT.map(([lo, la]) => project(lo, la))
      const minS = fit(lim[0][0], lim[1][1], lim[1][0], lim[0][1], s.size).s
      const ns = Math.max(minS, Math.min(40000, v.s * f))
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
  }, [])

  useEffect(() => {
    const id = setInterval(() => { const f = st.current.frameMs; if (f != null) setPerf(f) }, 1000)
    return () => clearInterval(id)
  }, [])

  const card = pin || hover?.dot
  const cardSim = card && neigh[card.id]
  return (
    <div className="mapview">
      <div className="mapwrap" ref={wrap}>
        <canvas ref={canvas} />
        {!geo && <div className="maploading">Loading the map…</div>}
        {hover && hover.dot !== pin && (
          <div className="maptip" style={{ left: Math.min(hover.x + 14, (st.current.size[0] || 800) - 270), top: hover.y + 14 }}>
            <b>{hover.dot.r.titles.fi}</b>
            <span className="muted">{hover.dot.r.titles.en}</span>
            <Stats r={hover.dot.r} />
            <small className="muted">{hover.dot.located === 'inferred' ? `placed at ${hover.dot.place} (the place it links most)` : hover.dot.place} · click to pin</small>
          </div>
        )}
        {pin && (
          <aside className="mapcard">
            <button className="x" onClick={() => setPin(null)} title="Unpin">✕</button>
            <a className="title" href={`#/article/${pin.id}/languages`} onClick={(e) => { e.preventDefault(); onOpen(pin.id) }}
               title="Open the article page">{pin.r.titles.fi} →</a>
            <span className="muted">{pin.r.titles.en}</span>
            <Stats r={pin.r} />
            <h4>Most similar articles</h4>
            {!cardSim?.data && <p className="muted small">Asking MariaDB…</p>}
            {cardSim?.data && (
              <ol className="simlist">
                {cardSim.data.map((n) => (
                  <li key={n.wikidata_id}>
                    <a href={`#/article/${n.wikidata_id}/languages`} onClick={(e) => { e.preventDefault(); onOpen(n.wikidata_id) }}>{n.titles.fi}</a>
                    <span className="simbar"><span style={{ width: `${Math.max(4, (n.similarity - 0.5) / 0.4 * 100)}%` }} /></span>
                    <small>{n.similarity.toFixed(2)}</small>
                  </li>
                ))}
              </ol>
            )}
            {cardSim?.data && <small className="muted">VEC_DISTANCE on the article vectors · {cardSim.ms} ms in MariaDB</small>}
          </aside>
        )}
        <div className="maplegend">
          <div className="ramp"><span>needs an editor less</span><i /><span>more</span></div>
          {semantic && <div className="small">dot size = how close to “{filter.q}”</div>}
          <div className="small muted">
            {dots.length.toLocaleString()} articles on the map{outside ? ` · ${outside} elsewhere in the world` : ''}
            {perf != null && ` · frame ${perf.toFixed(1)} ms`}
          </div>
        </div>
      </div>
    </div>
  )
}

function Stats({ r }) {
  return (
    <span className="mapstats">
      <span title="Score: how much the article needs an editor"><i style={{ background: color(r.score) }} />score {r.score?.toFixed(2)}</span>
      <span title="Whole-article distance to the Finnish version">sv {r.fi_sv?.toFixed(2)} · en {r.fi_en?.toFixed(2)}</span>
      {r.contradictions != null && <span>{r.contradictions} possible contradiction{r.contradictions === 1 ? '' : 's'}{r.contradictions_agreed ? ` (${r.contradictions_agreed} agreed)` : ''}</span>}
      {r.similarity != null && <span>match {r.similarity.toFixed(2)}</span>}
    </span>
  )
}

function fit(x0, y0, x1, y1, [w, h]) {
  const pad = 60
  const minSpan = 0.02                                     // never closer than a small region
  const sx = Math.max(x1 - x0, minSpan), sy = Math.max(y1 - y0, minSpan)
  const s = Math.min((w - 2 * pad) / sx, (h - 2 * pad) / sy)
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  return { s, tx: w / 2 - cx * s, ty: h / 2 - cy * s }
}

function step(s, now) {
  let busy = false
  if (s.anim && s.target) {
    const u = Math.min(1, (now - s.anim.t0) / 550), e = ease(u)
    const a = s.anim.from, b = s.target
    // zoom in log space so the motion feels even
    const ls = Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * e
    s.view = { s: Math.exp(ls), tx: a.tx + (b.tx - a.tx) * e, ty: a.ty + (b.ty - a.ty) * e }
    s.baseKey = ''
    if (u >= 1) s.anim = null
    busy = true
  }
  for (const id of [s.hover?.id, s.pin?.id]) {
    const l = id && s.lines[id]
    if (l && now - l.t0 < 450) busy = true
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
  return { land, fin, lakes, cities: CITIES.map(([n, lo, la]) => [n, ...project(lo, la)]) }
}

function drawBase(s, geo) {
  const [w, h] = s.size, dpr = s.dpr, v = s.view
  const key = `${w}x${h}@${dpr}:${v.s.toFixed(3)},${v.tx.toFixed(1)},${v.ty.toFixed(1)}`
  if (s.baseKey === key && s.base) return s.base
  s.paths ||= buildPaths(geo)
  const b = s.base || document.createElement('canvas')
  b.width = Math.round(w * dpr); b.height = Math.round(h * dpr)
  const g = b.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.fillStyle = css('--map-sea'); g.fillRect(0, 0, w, h)
  g.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty)
  const px = 1 / v.s
  g.fillStyle = css('--map-land'); g.fill(s.paths.land, 'evenodd')
  g.fillStyle = css('--map-finland'); g.fill(s.paths.fin, 'evenodd')
  g.fillStyle = css('--map-sea'); g.fill(s.paths.lakes)
  g.lineJoin = 'round'
  g.strokeStyle = css('--map-border'); g.lineWidth = 0.8 * px; g.stroke(s.paths.land)
  g.strokeStyle = css('--map-finland-border'); g.lineWidth = 1.3 * px; g.stroke(s.paths.fin)
  // city names for orientation
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.font = '500 11px Inter, system-ui, sans-serif'
  g.fillStyle = css('--map-label')
  for (const [n, x, y] of s.paths.cities) {
    const sx = x * v.s + v.tx, sy = y * v.s + v.ty
    if (sx < -50 || sy < -20 || sx > w + 50 || sy > h + 20) continue
    g.beginPath(); g.arc(sx, sy, 1.6, 0, 7); g.fill()
    g.fillText(n, sx + 4, sy - 3)
  }
  s.base = b; s.baseKey = key
  return b
}

function draw(s, c, geo, semantic) {
  if (!geo || !s.view) return
  const ctx = c.getContext('2d')
  const [w, h] = s.size, dpr = s.dpr, v = s.view
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(drawBase(s, geo), 0, 0)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const zoom = Math.log2(v.s / 400)
  const r0 = Math.max(2.2, Math.min(6, 2.6 + 0.75 * (zoom - 2)))
  // positions (stacked dots fan out in a small sunflower, in screen pixels)
  for (const d of s.dots) {
    // Articles at the same place (Helsinki has 400) spread in a sunflower whose spacing is a distance on
    // the map (~3.5 km), so a crowded city is a dense cluster from afar and opens up as you zoom in.
    const step = Math.max(1.5, 0.00055 * v.s)
    const a = d.k * 2.39996, rr = d.k ? step * Math.sqrt(d.k) : 0
    d.sx = d.wx * v.s + v.tx + rr * Math.cos(a); d.sy = d.wy * v.s + v.ty + rr * Math.sin(a)
    d.rad = semantic && d.sim != null ? 2.5 + 9 * d.sim : r0
  }
  const byId = new Map(s.dots.map((d) => [d.id, d]))
  const active = [s.pin, s.hover].filter(Boolean)
  const focus = new Set()
  // lines to the most similar articles
  for (const src of active) {
    const l = s.lines[src.id]
    if (!l?.data) continue
    const p = Math.min(1, (performance.now() - l.t0) / 450)
    for (const [i, n] of l.data.entries()) {
      const d = byId.get(n.wikidata_id)
      let tx, ty
      if (d) { tx = d.sx; ty = d.sy; focus.add(d.id) } else { const [wx, wy] = project(n.lon, n.lat); tx = wx * v.s + v.tx; ty = wy * v.s + v.ty }
      const t = Math.max(0, Math.min(1, (n.similarity - 0.6) / 0.3))
      const pe = ease(Math.max(0, Math.min(1, p * 1.4 - i * 0.04)))
      curve(ctx, src.sx, src.sy, tx, ty, pe, 0.9 + 4.2 * t, `rgba(47, 93, 138, ${0.28 + 0.55 * t})`)
      if (!d && pe > 0.95) { ctx.strokeStyle = 'rgba(47,93,138,.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(tx, ty, 3.5, 0, 7); ctx.stroke() }
    }
  }
  // dots
  const dim = active.length > 0
  for (const d of s.dots) {
    const on = focus.has(d.id) || active.includes(d)
    ctx.beginPath(); ctx.arc(d.sx, d.sy, d.rad, 0, 7)
    ctx.fillStyle = color(d.r.score, dim && !on ? 0.35 : 0.92); ctx.fill()
    ctx.lineWidth = 0.8; ctx.strokeStyle = dim && !on ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.9)'; ctx.stroke()
  }
  // focus rings and labels
  ctx.font = '600 12px Inter, system-ui, sans-serif'
  for (const src of active) {
    ctx.beginPath(); ctx.arc(src.sx, src.sy, src.rad + 4, 0, 7)
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(29,27,24,.85)'; ctx.stroke()
  }
  const labelled = s.pin && s.lines[s.pin.id]?.data ? s.lines[s.pin.id].data.slice(0, 6) : []
  ctx.font = '500 11px Inter, system-ui, sans-serif'
  for (const n of labelled) {
    const d = byId.get(n.wikidata_id)
    if (!d) continue
    halo(ctx, n.titles.fi, d.sx + d.rad + 4, d.sy + 4)
  }
  if (s.pin) { ctx.font = '600 13px Inter, system-ui, sans-serif'; halo(ctx, s.pin.r.titles.fi, s.pin.sx + s.pin.rad + 7, s.pin.sy - 7) }
}

function halo(ctx, text, x, y) {
  ctx.lineWidth = 3.5; ctx.strokeStyle = css('--map-halo'); ctx.lineJoin = 'round'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = css('--map-text'); ctx.fillText(text, x, y)
}

// A gently bent line from (x0,y0) towards (x1,y1), drawn up to fraction p (for the draw-in animation).
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
