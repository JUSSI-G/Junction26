import React, { useEffect, useRef, useState } from 'react'
import Globe from 'globe.gl'
import { useJson, HOME, fitSet, color } from './shared.js'

// The 3D globe (the default; the 2D map is the light option). globe.gl / three.js, styled like the
// original globe (web/globe): the dark earth texture with relief, a dark sky, the blue atmosphere; country
// outlines from web/public/world3d.json on top, Finland highlighted. The same marks as the 2D map (one
// article, or a blob of all the articles at one place) and the same lines: solid, low over the surface,
// thicker and brighter = more similar, drawn in once.
const LINE = '150, 195, 255'           // the 2D map's line colour, lightened for the dark globe

export default function Map3D({ marks, lines, focus, selKey, hoverKey, labels, semantic, onHover, onPick, onFail }) {
  const el = useRef(null)        // the wrapper (React's)
  const mount = useRef(null)     // the globe's own element: React renders nothing inside it
  const g = useRef(null)
  const geo = useJson('world3d.json')
  const mouse = useRef([0, 0])
  const props = useRef({})
  props.current = { onHover, onPick }
  const [alt, setAlt] = useState(1.4)       // camera altitude, rounded: the mark size follows it

  // create the globe once
  useEffect(() => {
    let globe
    try {
      globe = new Globe(mount.current, { animateIn: false, rendererConfig: { antialias: true, alpha: true } })
    } catch (e) { onFail?.(e); return }
    g.current = globe
    globe.renderer().setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1))
    globe
      .backgroundColor('#05070d')
      .globeImageUrl(import.meta.env.BASE_URL + 'earth-dark.jpg')
      .bumpImageUrl(import.meta.env.BASE_URL + 'earth-topology.png')
      .atmosphereColor('#4b83c4').atmosphereAltitude(0.16)
      .polygonAltitude(0.005).polygonCapCurvatureResolution(3)
      .polygonSideColor(() => 'rgba(0,0,0,0)')
      .polygonStrokeColor((f) => (f.properties.iso === 'FI' ? 'rgba(190,210,245,0.85)' : 'rgba(120,140,180,0.3)'))
      .polygonCapColor((f) => (f.properties.iso === 'FI' ? 'rgba(70,98,150,0.42)' : 'rgba(20,27,42,0.55)'))
      .polygonsTransitionDuration(0)
      .pointLat('lat').pointLng('lon')
      .pointResolution(16)
      .pointsMerge(false)
      .pointsTransitionDuration(0)
      .onPointHover((m) => props.current.onHover(m || null, ...mouse.current))
      .onPointClick((m) => props.current.onPick(m))
      .onGlobeClick(() => props.current.onPick(null))
      .arcStartLat((a) => a.from.lat).arcStartLng((a) => a.from.lon)
      .arcEndLat((a) => a.lat).arcEndLng((a) => a.lon)
      .arcAltitudeAutoScale(0.18)
      .arcStroke((a) => 0.12 + 0.5 * a.t)
      .arcColor((a) => `rgba(${LINE}, ${0.4 + 0.5 * a.t})`)
      .arcsTransitionDuration(0)
      .htmlLat('lat').htmlLng('lng').htmlAltitude(0.012)
      .htmlTransitionDuration(0)
      .htmlElement((d) => {
        const e = document.createElement('div')
        e.className = d.count ? 'globecount' : `globelabel${d.main ? ' main' : ''}`
        e.textContent = d.text
        return e
      })
      .pointOfView({ ...HOME, altitude: 1.4 }, 0)
    const ctl = globe.controls()
    ctl.autoRotate = false; ctl.enableDamping = true; ctl.dampingFactor = 0.12
    ctl.minDistance = 101 + 8; ctl.maxDistance = 900
    ctl.addEventListener('end', () => {            // after a zoom, resize the marks
      const a = globe.pointOfView().altitude
      setAlt((cur) => (Math.abs(Math.log(a / cur)) > 0.15 ? a : cur))
    })
    const ro = new ResizeObserver(() => {
      const r = el.current?.getBoundingClientRect()
      if (r) globe.width(r.width).height(r.height)
    })
    ro.observe(el.current)
    window.__globe = globe                          // the Playwright demo script: screen positions of marks
    return () => { ro.disconnect(); globe._destructor?.(); g.current = null; if (window.__globe === globe) window.__globe = null }
  }, [])

  useEffect(() => {
    if (!geo || !g.current) return
    g.current.polygonsData(geo.land.map((c) => ({
      type: 'Feature', properties: { iso: c.iso, name: c.name },
      geometry: { type: 'MultiPolygon', coordinates: c.polys.map((r) => [r]) },
    })))
  }, [geo])

  // marks: a size on the ground, so it follows the camera (smaller when you zoom in); a blob grows with
  // its count; dim everything but the selection and its neighbours
  const radius = Math.max(0.01, Math.min(0.16, 0.065 * alt))           // degrees, one article
  useEffect(() => {
    const globe = g.current
    if (!globe) return
    const dim = (focus?.size || 0) > 0
    const lifted = new Set([selKey, hoverKey])
    globe
      .pointRadius((m) => {
        const one = semantic && m.sim != null ? radius * (0.7 + 3 * m.sim) : radius
        return m.n > 1 ? Math.max(one, radius * (1 + 1.4 * Math.log(m.n))) : one       // bigger than 2D: seen from afar
      })
      .pointColor((m) => color(m.score, !dim || focus.has(m.key) ? (m.n > 1 ? 0.85 : 0.95) : 0.28))
      .pointAltitude((m) => (lifted.has(m.key) ? 0.011 : m.n > 1 ? 0.0062 : 0.0068))
      .pointsData(marks)
  }, [marks, semantic, radius, focus, selKey, hoverKey])

  // a camera flight to fit the filter (Finland always in view); the camera sits a little south, so
  // Finland is high on the globe and the lines show their curve
  useEffect(() => {
    const globe = g.current
    if (!globe) return
    const use = fitSet(marks)
    const lats = use.map((m) => m.lat).concat([60, 70]), lons = use.map((m) => m.lon).concat([20, 31])
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2, lng = (Math.min(...lons) + Math.max(...lons)) / 2
    const span = Math.max(Math.max(...lats) - Math.min(...lats), (Math.max(...lons) - Math.min(...lons)) * Math.cos(lat * Math.PI / 180))
    const altitude = Math.max(0.6, Math.min(2.6, span / 20))
    globe.pointOfView({ lat: lat - 6 - span * 0.15, lng, altitude }, 900)
    const t = setTimeout(() => setAlt(altitude), 950)
    return () => clearTimeout(t)
  }, [marks])

  // lines: drawn in once (a dash that grows from the source), then solid
  useEffect(() => {
    const globe = g.current
    if (!globe) return
    const fresh = (a) => performance.now() - a.t0 < 600
    const apply = () => globe
      .arcDashLength(1)
      .arcDashGap((a) => (fresh(a) ? 1 : 0))
      .arcDashInitialGap((a) => (fresh(a) ? 1 : 0))
      .arcDashAnimateTime((a) => (fresh(a) ? 650 : 0))
      .arcsData(lines)
    apply()
    const t = setTimeout(apply, 700)
    return () => clearTimeout(t)
  }, [lines])

  // labels: blob counts (20+ articles) + the selected article's and its neighbours' names
  useEffect(() => {
    const globe = g.current
    if (!globe) return
    const counts = marks.filter((m) => m.n >= 20).map((m) => ({ lat: m.lat, lng: m.lon, text: String(m.n), count: true }))
    const names = (labels || []).map((l) => ({ lat: l.mark ? l.mark.lat : l.lat, lng: l.mark ? l.mark.lon : l.lon, text: l.text, main: l.main }))
    globe.htmlElementsData([...counts, ...names])
  }, [marks, labels])

  return (
    <div className="mapcanvas globe3d" ref={el}
         onMouseMove={(e) => { const r = el.current.getBoundingClientRect(); mouse.current = [e.clientX - r.left, e.clientY - r.top] }}>
      <div ref={mount} className="globemount" />
      {!geo && <div className="maploading">Loading the globe…</div>}
    </div>
  )
}
