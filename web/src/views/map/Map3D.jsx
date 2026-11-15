import React, { useEffect, useRef, useState } from 'react'
import Globe from 'globe.gl'
import { CircleGeometry, RingGeometry, Group, Mesh, MeshBasicMaterial, Color } from 'three'
import { useJson, HOME, fitSet, color, sizeOf } from './shared.js'

// The 3D globe (the default; the 2D map is the light option). globe.gl / three.js, styled like the
// original globe (web/globe): the dark earth texture with relief, a dark sky, the blue atmosphere; country
// outlines from web/public/world3d.json on top, Finland highlighted. The marks look like the 2D map's:
// flat discs lying on the surface with a white outline, one per article or per blob (the views share the
// clustering, so they never overlap), and the same lines: solid, low, thicker = more similar, drawn in once.
const LINE = '150, 195, 255'           // the 2D map's line colour, lightened for the dark globe
const UNITS_PER_DEG = (Math.PI / 180) * 100      // globe.gl's globe has radius 100
const DISC = new CircleGeometry(1, 40)
const RIM = new RingGeometry(1, 1.14, 40)

function rgba(str) {                     // 'rgba(r,g,b,a)' -> [Color, a]
  const [r, g, b, a] = str.match(/[\d.]+/g).map(Number)
  return [new Color(`rgb(${r},${g},${b})`), a]          // a CSS string = sRGB, as on the 2D map
}

export default function Map3D({ marks, fitKey, fitMarks, lines, focus, selKey, hoverKey, labels, semantic, onHover, onPick, onScale, onFail }) {
  const el = useRef(null)        // the wrapper (React's)
  const mount = useRef(null)     // the globe's own element: React renders nothing inside it
  const g = useRef(null)
  const geo = useJson('world3d.json')
  const mouse = useRef([0, 0])
  const props = useRef({})
  props.current = { onHover, onPick }
  const [alt, setAlt] = useState(1.4)       // camera altitude, rounded: the mark size follows it

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
      // marks: flat discs facing out from the surface
      .objectLat('lat').objectLng('lon')
      .objectFacesSurface(true)
      .objectThreeObject((m) => {
        const grp = new Group()
        grp.add(new Mesh(DISC, new MeshBasicMaterial({ transparent: true, depthWrite: false })))
        grp.add(new Mesh(RIM, new MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false })))
        m.__obj = grp
        paint(m)
        return grp
      })
      .onObjectHover((m) => props.current.onHover(m || null, ...mouse.current))
      .onObjectClick((m) => props.current.onPick(m))
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
    ctl.addEventListener('end', () => {            // after a zoom: resize the marks, re-cluster
      const a = globe.pointOfView().altitude
      setAlt((cur) => (Math.abs(Math.log(a / cur)) > 0.12 ? a : cur))
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

  // one article's radius on the ground follows the camera (smaller when you zoom in); tell the view, it
  // re-clusters so marks never overlap
  // ~3-4 px on screen at any altitude, like the 2D map's dots
  const radius = Math.max(0.012, Math.min(0.6, 0.2 * alt))               // degrees
  useEffect(() => { onScale?.(radius * 111.2) }, [radius])

  // the look of each disc: size, colour, dimmed or not; set on the existing three.js objects (cheap)
  const look = useRef({})
  function paint(m) {
    const o = m.__obj
    if (!o) return
    const { radius: r, semantic: sem, focus: f, lifted } = look.current
    const s = r * sizeOf(m, sem) * UNITS_PER_DEG
    o.scale.set(s, s, s)
    const on = !(f?.size) || f.has(m.key)
    const [c, a] = rgba(color(m.score, on ? 0.92 : 0.3))
    o.children[0].material.color = c
    o.children[0].material.opacity = a
    o.children[1].material.opacity = on ? 0.95 : 0.3
    o.position.setLength(100 * (1 + (lifted?.has(m.key) ? 0.009 : m.n > 1 ? 0.0058 : 0.0064)))
  }
  useEffect(() => {
    look.current = { radius, semantic, focus, lifted: new Set([selKey, hoverKey]) }
    const globe = g.current
    if (!globe) return
    if (globe.objectsData() !== marks) globe.objectsData(marks)       // new marks: objects are rebuilt
    for (const m of marks) paint(m)
    const raf = requestAnimationFrame(() => { for (const m of marks) paint(m) })   // after globe.gl placed new ones
    return () => cancelAnimationFrame(raf)
  }, [marks, semantic, radius, focus, selKey, hoverKey])

  // a camera flight to fit the filter (Finland always in view); the camera sits a little south, so
  // Finland is high on the globe and the lines show their curve. Only when the filter changes.
  useEffect(() => {
    const globe = g.current
    if (!globe) return
    const use = fitSet(fitMarks || marks)          // the places, not the zoom-dependent clusters
    const lats = use.map((m) => m.lat).concat([60, 70]), lons = use.map((m) => m.lon).concat([20, 31])
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2, lng = (Math.min(...lons) + Math.max(...lons)) / 2
    const span = Math.max(Math.max(...lats) - Math.min(...lats), (Math.max(...lons) - Math.min(...lons)) * Math.cos(lat * Math.PI / 180))
    const altitude = Math.max(0.6, Math.min(2.6, span / 20))
    globe.pointOfView({ lat: lat - 6 - span * 0.15, lng, altitude }, 900)
    const t = setTimeout(() => setAlt(altitude), 950)
    return () => clearTimeout(t)
  }, [fitKey])

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
