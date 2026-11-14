import React, { useEffect, useMemo, useRef, useState } from 'react'
import Globe from 'react-globe.gl'
import { api, fmtDate } from '../api.js'

// The globe: every placed article as a glowing column; height and colour = how contested its
// history is (sentences removed and put back + whole-article reverts). Heat mode aggregates
// nearby articles into hexagons. Click → the article's page (time slider, contested map, …).
const RAMP = ['#ffe9a8', '#ffc861', '#ff9a3d', '#ff6a2b', '#e8361f', '#b5121b']

function useSize(ref) {
  const [size, setSize] = useState({ width: 800, height: 560 })
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return size
}

export default function GlobeView({ onOpen }) {
  const [points, setPoints] = useState(null)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('heat')
  const [sel, setSel] = useState(null)
  const [nearby, setNearby] = useState([])
  const globeRef = useRef()
  const boxRef = useRef()
  const { width, height } = useSize(boxRef)

  useEffect(() => { api.map().then(setPoints).catch((e) => setError(e.message)) }, [])

  // Colour by rank (percentile), so a few extreme articles don't wash out everything else.
  const { rank, max } = useMemo(() => {
    const sorted = [...(points || [])].sort((a, b) => a.contested - b.contested)
    const rank = new Map(sorted.map((p, i) => [p.page_id, sorted.length > 1 ? i / (sorted.length - 1) : 1]))
    return { rank, max: Math.max(1, ...sorted.map((p) => p.contested)) }
  }, [points])
  const color = (q) => RAMP[Math.min(RAMP.length - 1, Math.floor(q * RAMP.length))]
  // Log scale: one extreme article (Talvisota) would otherwise make every other hexagon pale.
  const heat = (w) => Math.min(1, Math.log1p(w) / Math.log1p(max))
  const top = useMemo(() => [...(points || [])].sort((a, b) => b.contested - a.contested).slice(0, 12), [points])

  useEffect(() => {
    if (!globeRef.current) return
    globeRef.current.pointOfView({ lat: 62.8, lng: 26, altitude: 0.7 }, 1500)
    const c = globeRef.current.controls()
    c.autoRotate = false
  }, [points])

  const select = (p) => {
    setSel(p)
    globeRef.current?.pointOfView({ lat: p.lat, lng: p.lon, altitude: 0.45 }, 1000)
    api.mapNear(p.lat, p.lon).then((n) => setNearby(n.filter((x) => x.page_id !== p.page_id))).catch(() => setNearby([]))
  }
  const byId = useMemo(() => new Map((points || []).map((p) => [p.page_id, p])), [points])

  const label = (p) => `<div class="glabel"><b>${p.title}</b><br/>${p.revisions.toLocaleString()} revisions ·
    ${p.returns} returns · ${p.reverts} reverts</div>`

  return (
    <div className="grid2 globegrid">
      <div className="panel globebox" ref={boxRef}>
        {error && <p className="err">{error}</p>}
        {!points && !error && <p className="muted" style={{ padding: 16 }}>Loading the map…</p>}
        {points && (
          <Globe
            ref={globeRef}
            width={width}
            height={height}
            globeImageUrl={`${import.meta.env.BASE_URL}earth-night.jpg`}
            bumpImageUrl={`${import.meta.env.BASE_URL}earth-topology.png`}
            backgroundImageUrl={`${import.meta.env.BASE_URL}night-sky.png`}
            atmosphereColor="#7fb2ff"
            atmosphereAltitude={0.18}
            // points mode: one column per article
            pointsData={mode === 'points' ? points : []}
            pointLat="lat"
            pointLng="lon"
            pointAltitude={(p) => 0.003 + 0.05 * heat(p.contested)}
            pointRadius={(p) => (sel?.page_id === p.page_id ? 0.32 : 0.18)}
            pointColor={(p) => (sel?.page_id === p.page_id ? '#7fd6ff' : color(rank.get(p.page_id)))}
            pointLabel={label}
            onPointClick={select}
            pointsMerge={false}
            // heat mode: hexagons summing contestedness of the articles inside
            hexBinPointsData={mode === 'heat' ? points : []}
            hexBinPointLat="lat"
            hexBinPointLng="lon"
            hexBinPointWeight={(p) => 1 + p.contested}
            hexBinResolution={4}
            hexMargin={0.15}
            hexAltitude={(d) => 0.002 + 0.05 * heat(d.sumWeight)}
            hexTopColor={(d) => color(heat(d.sumWeight))}
            hexSideColor={(d) => color(heat(d.sumWeight)) + 'cc'}
            hexLabel={(d) => `<div class="glabel"><b>${d.points.length} article${d.points.length > 1 ? 's' : ''}</b><br/>${
              [...d.points].sort((a, b) => b.contested - a.contested).slice(0, 5).map((p) => p.title).join('<br/>')}</div>`}
            onHexClick={(d) => select([...d.points].sort((a, b) => b.contested - a.contested)[0])}
            hexTransitionDuration={600}
          />
        )}
        <div className="globetools">
          <div className="bucket">
            {['heat', 'points'].map((m) => (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)} title={m === 'heat' ? 'Hexagons adding up all articles in an area' : 'One column per article'}>{m}</button>
            ))}
          </div>
          <div className="legend ramp">
            <span>calm</span>{RAMP.map((c) => <i key={c} style={{ background: c }} />)}<span>contested</span>
          </div>
        </div>
      </div>

      <div className="panel">
        {!sel && (
          <>
            <h3>Most contested places</h3>
            <p className="muted small" style={{ marginTop: -4 }}>
              {points ? `${points.length.toLocaleString()} articles on the map` : ''} · contested = sentences removed and put back + whole-article reverts.
              Click a name (or a hexagon on the globe) to see the place.
            </p>
            <ol className="chain">
              {top.map((p) => (
                <li key={p.page_id} style={{ cursor: 'pointer' }} onClick={() => select(p)}>
                  {p.title}
                  <span className="when">{p.revisions.toLocaleString()} revisions · {p.returns} returns · {p.reverts} reverts</span>
                </li>
              ))}
            </ol>
          </>
        )}
        {sel && (
          <>
            <button className="btn ghost back" onClick={() => { setSel(null); setNearby([]) }}
                    title="Back to the list of the most contested places">← All places</button>
            <h3>{sel.source?.startsWith('place:') ? `Event at ${sel.source.slice(6)}` : 'Place'}</h3>
            <div className="placetitle">{sel.title}</div>
            <div className="kpis">
              <div title="How many times the article has been saved on Wikipedia"><b>{sel.revisions.toLocaleString()}</b><span>revisions</span></div>
              <div title="Times a sentence was deleted and later put back word for word: the edit-war signal"><b>{sel.returns}</b><span>sentence returns</span></div>
              <div title="Times the whole article was restored to an earlier version"><b>{sel.reverts}</b><span>reverts</span></div>
              <div title="Sentences in today’s version"><b>{sel.n_sentences}</b><span>sentences now</span></div>
            </div>
            <p className="muted small">Edited {fmtDate(sel.first_rev)} → {fmtDate(sel.last_rev)}</p>
            <div className="actionlist">
              <button className="btn primary block" onClick={() => onOpen(sel, 'time')}>
                Read the article through time →
                <small>Today’s text with a time slider: see it as it was on any date</small>
              </button>
              <button className="btn block" onClick={() => onOpen(sel, 'contested')}>
                Contested map
                <small>Every sentence coloured by how often it was rewritten</small>
              </button>
              <button className="btn block" onClick={() => onOpen(sel, 'wars')}>
                Edit wars
                <small>Sentences deleted and restored, with who did it</small>
              </button>
              <a className="btn block" href={`https://fi.wikipedia.org/?curid=${sel.page_id}`} target="_blank" rel="noreferrer">
                Open on Wikipedia ↗
                <small>The live article on fi.wikipedia.org (new tab)</small>
              </a>
            </div>
            {nearby.length > 0 && (
              <>
                <h3 style={{ marginTop: 18 }}>Nearby <span className="muted small" style={{ textTransform: 'none', letterSpacing: 0 }}>· click to jump there</span></h3>
                <ul className="nearby">
                  {nearby.map((n) => (
                    <li key={n.page_id} onClick={() => byId.get(n.page_id) && select(byId.get(n.page_id))}>
                      {n.title} <span className="muted small">{n.km} km</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
