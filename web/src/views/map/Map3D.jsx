import React, { useEffect, useRef, useState } from 'react'
import Globe from 'globe.gl'
import { useJson, HOME, fitSet, color, css, lineStrength, STACK_KM } from './shared.js'

// The 3D globe (the default; the 2D map is the light option). globe.gl / three.js, styled like the
// original globe (web/globe): the dark earth texture with relief, a dark sky, the blue atmosphere; country
// outlines from web/public/world3d.json on top, Finland highlighted; one point per article
// (stacked articles spread on the ground, STACK_KM apart); hover or click → arcs to the 10 most similar
// articles, thicker and more opaque = more similar, with a slow flowing dash.
export default function Map3D({ dots, pin, hoverId, neigh, semantic, onHover, onPick, onFail }) {
  const el = useRef(null)        // the wrapper (React's)
  const mount = useRef(null)     // the globe's own element: React renders nothing inside it
  const g = useRef(null)
  const geo = useJson('world3d.json')
  const mouse = useRef([0, 0])
  const props = useRef({})
  props.current = { onHover, onPick }
  const [alt, setAlt] = useState(1.4)       // camera altitude, rounded: dot size and stacking follow it

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
      .pointLat('jlat').pointLng('jlon')
      .pointAltitude((d) => (d.__on ? 0.011 : 0.0068))
      .pointResolution(10)
      .pointsMerge(false)
      .pointsTransitionDuration(0)
      .onPointHover((d) => props.current.onHover(d || null, ...mouse.current))
      .onPointClick((d) => props.current.onPick(d))
      .onGlobeClick(() => props.current.onPick(null))
      .arcStartLat((a) => a.from.jlat).arcStartLng((a) => a.from.jlon)
      .arcEndLat((a) => a.lat).arcEndLng((a) => a.lon)
      .arcAltitudeAutoScale(0.45)
      .arcStroke((a) => 0.12 + 0.55 * a.t)
      .arcColor((a) => [`rgba(255,196,92,${0.35 + 0.45 * a.t})`, `rgba(255,224,150,${0.6 + 0.4 * a.t})`])
      .arcDashLength(0.5).arcDashGap(0.12).arcDashAnimateTime(2600)
      .arcsTransitionDuration(0)
      .htmlLat('lat').htmlLng('lng').htmlAltitude(0.015)
      .htmlTransitionDuration(0)
      .htmlElement((d) => {
        const e = document.createElement('div')
        e.className = `globelabel${d.main ? ' main' : ''}`
        e.textContent = d.text
        return e
      })
      .pointOfView({ ...HOME, altitude: 1.4 }, 0)
    const ctl = globe.controls()
    ctl.autoRotate = false; ctl.enableDamping = true; ctl.dampingFactor = 0.12
    ctl.minDistance = 101 + 8; ctl.maxDistance = 900
    // after a zoom, resize the dots and re-spread stacked ones (only when the altitude changed enough)
    ctl.addEventListener('end', () => {
      const a = globe.pointOfView().altitude
      setAlt((cur) => (Math.abs(Math.log(a / cur)) > 0.15 ? a : cur))
    })
    const ro = new ResizeObserver(() => {
      const r = el.current?.getBoundingClientRect()
      if (r) globe.width(r.width).height(r.height)
    })
    ro.observe(el.current)
    window.__globe = globe                          // the Playwright demo script: screen positions of dots
    return () => { ro.disconnect(); globe._destructor?.(); g.current = null; if (window.__globe === globe) window.__globe = null }
  }, [])

  useEffect(() => {
    if (!geo || !g.current) return
    g.current.polygonsData(geo.land.map((c) => ({
      type: 'Feature', properties: { iso: c.iso, name: c.name },
      geometry: { type: 'MultiPolygon', coordinates: c.polys.map((r) => [r]) },
    })))
  }, [geo])

  // A dot's size on the globe is a distance on the ground, so it follows the camera: smaller when you zoom
  // in. Articles at one place (Helsinki has 400) are spread in a sunflower at least 1.7 dot-radii apart,
  // so a crowded city is a dense cluster from afar and separates as you zoom in.
  const radius = Math.max(0.008, Math.min(0.15, 0.06 * alt))           // degrees
  useEffect(() => {
    const biggest = semantic ? radius * 3.7 : radius                      // a semantic search enlarges the best matches
    // without a search, cap the spacing: from afar Helsinki's 400 stay a compact cluster, not a disc
    const step = Math.max(STACK_KM, Math.min(semantic ? 1e9 : 8, 1.8 * biggest * 111))   // km
    for (const d of dots) {
      const a = d.k * 2.39996, rkm = d.k ? step * Math.sqrt(d.k) : 0
      d.jlat = d.lat + (rkm * Math.cos(a)) / 111
      d.jlon = d.lon + (rkm * Math.sin(a)) / (111 * Math.max(0.2, Math.cos(d.lat * Math.PI / 180)))
    }
    const globe = g.current
    if (!globe) return
    globe
      .pointColor((d) => color(d.r.score, d.__dim ? 0.3 : 0.95))
      .pointRadius((d) => (semantic && d.sim != null ? radius * (0.7 + 3 * d.sim) : radius))
      .pointsData([...dots])
  }, [dots, semantic, radius])

  // a camera flight to fit the filter's dots (Finland always in view); the camera sits a little south of
  // them, so Finland is high on the globe and the arcs show their curve
  useEffect(() => {
    const globe = g.current
    if (!globe) return
    const use = fitSet(dots)
    const lats = use.map((d) => d.lat).concat([60, 70]), lons = use.map((d) => d.lon).concat([20, 31])
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2, lng = (Math.min(...lons) + Math.max(...lons)) / 2
    const span = Math.max(Math.max(...lats) - Math.min(...lats), (Math.max(...lons) - Math.min(...lons)) * Math.cos(lat * Math.PI / 180))
    const altitude = Math.max(0.6, Math.min(2.6, span / 20))
    globe.pointOfView({ lat: lat - 6 - span * 0.15, lng, altitude }, 900)
    const t = setTimeout(() => setAlt(altitude), 950)
    return () => clearTimeout(t)
  }, [dots])

  // arcs + labels for the pinned / hovered dot; dim the rest
  useEffect(() => {
    const globe = g.current
    if (!globe) return
    const byId = new Map(dots.map((d) => [d.id, d]))
    const srcs = [pin && byId.get(pin.id), hoverId && byId.get(hoverId)].filter(Boolean)
    const arcs = [], labels = [], on = new Set(srcs.map((d) => d.id))
    for (const src of srcs) {
      for (const n of neigh[src.id]?.data || []) {
        const d = byId.get(n.wikidata_id)
        if (d) on.add(d.id)
        arcs.push({ from: src, lat: d ? d.jlat : n.lat, lon: d ? d.jlon : n.lon, t: lineStrength(n.similarity) })
      }
    }
    const pinDot = pin && byId.get(pin.id)
    if (pinDot) {
      labels.push({ lat: pinDot.jlat, lng: pinDot.jlon, text: pinDot.r.titles.fi, main: true })
      for (const n of (neigh[pinDot.id]?.data || []).slice(0, 6)) {
        const d = byId.get(n.wikidata_id)
        labels.push({ lat: d ? d.jlat : n.lat, lng: d ? d.jlon : n.lon, text: n.titles.fi })
      }
    }
    for (const d of dots) { d.__on = on.has(d.id); d.__dim = srcs.length > 0 && !d.__on }
    globe.arcsData(arcs).htmlElementsData(labels)
    // new accessor functions = globe.gl re-evaluates every point (dimming, lifted focus dots)
    globe.pointColor((d) => color(d.r.score, d.__dim ? 0.3 : 0.95))
    globe.pointAltitude((d) => (d.__on ? 0.011 : 0.0068))
  }, [pin, hoverId, neigh, dots, radius])

  return (
    <div className="mapcanvas globe3d" ref={el}
         onMouseMove={(e) => { const r = el.current.getBoundingClientRect(); mouse.current = [e.clientX - r.left, e.clientY - r.top] }}>
      <div ref={mount} className="globemount" />
      {!geo && <div className="maploading">Loading the globe…</div>}
    </div>
  )
}
