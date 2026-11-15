import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { useSql } from './SqlDrawer.jsx'
import Map2D from './map/Map2D.jsx'
import { usePlaces, useDots, useNeighbours, webglOk, color } from './map/shared.js'

// The map view: every article in the current filter as a dot at its place, coloured by score (how much it
// needs an editor); with a semantic search, dot size = similarity to the query. Hover or click a dot:
// lines to its 10 most similar articles (VEC_DISTANCE on the article vectors), thicker = more similar.
// Click the name in the card to open the article page.
//   3D globe (default; globe.gl, loaded only when used) | 2D world map (canvas; the light option for
//   lower-end devices). The choice is remembered in this browser.
const Map3D = lazy(() => import('./map/Map3D.jsx'))
const KEY = 'contested.mapMode'
function initialMode() {
  try { const m = localStorage.getItem(KEY); if (m === '2d' || m === '3d') return m } catch { /* private mode */ }
  return webglOk() ? '3d' : '2d'
}

export default function MapView({ res, filter, onOpen }) {
  const [mode, setModeRaw] = useState(initialMode)
  const setMode = (m) => { setModeRaw(m); try { localStorage.setItem(KEY, m) } catch { /* ignore */ } }
  const places = usePlaces()
  const semantic = !!(filter.q && filter.mode === 'meaning')
  const { dots, unplaced } = useDots(res, places, semantic)
  const [hover, setHover] = useState(null)   // {dot, x, y}
  const [pin, setPin] = useState(null)       // dot
  const neigh = useNeighbours([hover?.dot?.id, pin?.id].filter(Boolean))
  const [frame, setFrame] = useState(null)

  useEffect(() => { setHover(null); setPin((p) => (p && dots.some((d) => d.id === p.id) ? p : null)) }, [dots])
  useEffect(() => {
    if (mode !== '2d') { setFrame(null); return }
    const id = setInterval(() => { const f = window.__map?.frameMs; if (f != null) setFrame(f) }, 1000)
    return () => clearInterval(id)
  }, [mode])

  const onHover = useCallback((d, x, y) => setHover((h) => (d ? (h?.dot === d && Math.abs(h.x - x) < 2 && Math.abs(h.y - y) < 2 ? h : { dot: d, x, y }) : null)), [])
  const onPick = useCallback((d) => setPin(d || null), [])

  const shownSim = neigh[pin?.id] || neigh[hover?.dot?.id]
  useSql([
    ...(res ? res.sql.map((s) => ({ ...s, ms: res.ms })) : []),
    ...(shownSim?.sql ? shownSim.sql.map((s) => ({ ...s, ms: shownSim.ms })) : []),
    ...(places ? places.sql.map((s) => ({ ...s, ms: places.ms })) : []),
  ], [res, places, shownSim])

  const view = { dots, pin, hoverId: hover?.dot?.id, neigh, semantic, onHover, onPick }
  const cardSim = pin && neigh[pin.id]
  return (
    <div className="mapview">
      <div className="mapwrap">
        {mode === '3d'
          ? <Suspense fallback={<div className="maploading">Loading the globe…</div>}><Map3D {...view} onFail={() => setMode('2d')} /></Suspense>
          : <Map2D {...view} />}

        <div className="mapmode seg" role="group" aria-label="Map type">
          <button className={mode === '3d' ? 'on' : ''} onClick={() => setMode('3d')} title="3D globe (needs a graphics card)">3D globe</button>
          <button className={mode === '2d' ? 'on' : ''} onClick={() => setMode('2d')} title="2D world map: lighter, for lower-end devices">2D map</button>
        </div>

        {hover && hover.dot !== pin && (
          <div className="maptip" style={{ left: Math.min(hover.x + 14, window.innerWidth - 290), top: hover.y + 14 }}>
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
            {dots.length.toLocaleString()} articles on the map{unplaced ? ` · ${unplaced} without a place` : ''}
            {frame != null && ` · frame ${frame.toFixed(1)} ms`}
          </div>
          <div className="small muted">{mode === '3d' ? 'drag to turn · scroll to zoom' : 'drag to pan · scroll to zoom'}</div>
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
