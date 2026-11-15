import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api.js'

// What the 3D globe and the 2D map share: the data (places, coastlines), the marks of the current filter,
// the "most similar" neighbours of the selected / hovered article, and the colours.
export const MAX_LINES = 10
export const HOME = { lat: 64.5, lng: 25.5 }                  // Finland's middle
export const CORE = [[4, 53.5], [42, 71.5]]                   // the Nordic-Baltic core a view fits to
export const inCore = (lon, lat) => lon >= CORE[0][0] && lon <= CORE[1][0] && lat >= CORE[0][1] && lat <= CORE[1][1]

const RAMP = [[0, [66, 146, 132]], [0.5, [226, 178, 74]], [0.8, [214, 108, 62]], [1, [178, 40, 48]]]
export function color(t, a = 1) {
  t = Math.max(0, Math.min(1, t ?? 0))
  let i = 0
  while (i < RAMP.length - 2 && t > RAMP[i + 1][0]) i++
  const [t0, c0] = RAMP[i], [t1, c1] = RAMP[i + 1]
  const u = (t - t0) / (t1 - t0)
  return `rgba(${c0.map((c, j) => Math.round(c + (c1[j] - c) * u)).join(',')},${a})`
}
export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
export const ease = (x) => 1 - Math.pow(1 - x, 3)
// 0..1 strength of a "most similar" line: thickness and opacity, the same rule on both maps
export const lineStrength = (sim) => Math.max(0, Math.min(1, (sim - 0.6) / 0.3))
// a blob's size relative to a single article: grows with the log of the count (Helsinki, 400 → ×6.4)
export const blobScale = (n) => 1 + 0.9 * Math.log(n)

const cache = {}
export function useJson(name) {           // web/public/<name>, fetched once per page load
  const [v, setV] = useState(cache[name] || null)
  useEffect(() => {
    if (cache[name]) return
    fetch(`${import.meta.env.BASE_URL}${name}`).then((r) => r.json()).then((g) => { cache[name] = g; setV(g) })
  }, [name])
  return v
}
let placesCache = null
export function usePlaces() {
  const [p, setP] = useState(placesCache)
  useEffect(() => { if (!placesCache) api.topicPlaces().then((r) => { placesCache = r; setP(r) }) }, [])
  return p
}

// One mark per place: a single article, or a blob of all the articles at that place (Helsinki has 400).
// A blob is coloured by its most urgent article, sized by its count; clicking it lists the articles.
//   mark = {key, lat, lon, items: [article…] (most urgent / closest first), score, sim, n, place, located}
//   article = {r (the /api/topics row), id, sim (0..1 within this search)}
export function useMarks(res, places, semantic) {
  return useMemo(() => {
    if (!res || !places) return { marks: [], markOf: new Map(), unplaced: 0 }
    const sims = res.data.map((r) => r.similarity).filter((v) => v != null)
    const smin = Math.min(...sims), smax = Math.max(...sims)
    const groups = new Map()
    let unplaced = 0
    for (const r of res.data) {
      const p = places.data[r.wikidata_id]
      if (!p) { unplaced++; continue }
      const [lat, lon, located, place] = p
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`
      let m = groups.get(key)
      if (!m) { m = { key, lat, lon, items: [], place, located, core: inCore(lon, lat) }; groups.set(key, m) }
      if (m.located !== located) m.located = 'mixed'
      const sim = r.similarity != null && smax > smin ? (r.similarity - smin) / (smax - smin) : null
      m.items.push({ r, id: r.wikidata_id, sim })
    }
    const marks = [...groups.values()]
    const markOf = new Map()
    for (const m of marks) {
      m.items.sort((a, b) => (semantic ? (b.sim ?? 0) - (a.sim ?? 0) : (b.r.score ?? 0) - (a.r.score ?? 0)))
      m.n = m.items.length
      m.score = Math.max(...m.items.map((a) => a.r.score ?? 0))
      m.sim = semantic ? Math.max(...m.items.map((a) => a.sim ?? 0)) : null
      for (const a of m.items) markOf.set(a.id, m)
    }
    // small on top of big, urgent on top of calm
    marks.sort((a, b) => b.n - a.n || (semantic ? (a.sim ?? 0) - (b.sim ?? 0) : a.score - b.score))
    return { marks, markOf, unplaced }
  }, [res, places, semantic])
}

// The marks a view should fit to: the Nordic-Baltic ones when most are there.
export function fitSet(marks) {
  const core = marks.filter((m) => m.core)
  return core.length >= Math.max(5, marks.length * 0.6) ? core : marks
}

const simCache = new Map()
// /api/similar for the selected and hovered articles: {id: answer + t0 (when it arrived, for the draw-in)}
export function useNeighbours(ids) {
  const [neigh, setNeigh] = useState({})
  useEffect(() => {
    for (const id of ids) {
      if (simCache.has(id)) {           // null = still on its way; its .then() fills it in
        const hit = simCache.get(id)
        if (hit && !neigh[id]) setNeigh((n) => ({ ...n, [id]: { ...hit, t0: performance.now() } }))
        continue
      }
      simCache.set(id, null)
      api.similar(id, MAX_LINES).then((r) => {
        simCache.set(id, r)
        setNeigh((n) => ({ ...n, [id]: { ...r, t0: performance.now() } }))
      }).catch(() => simCache.delete(id))
    }
  }, [ids.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  return neigh
}

// The lines to draw: for each source article (selected, hovered), one per neighbour, from the source's
// mark to the neighbour's mark (or to its bare place when it is not in the current filter).
export function linesFor(sources, neigh, markOf) {
  const out = []
  for (const id of sources) {
    const from = markOf.get(id)
    const l = neigh[id]
    if (!from || !l?.data) continue
    l.data.forEach((n, i) => {
      const to = markOf.get(n.wikidata_id)
      if (to === from) return                      // a neighbour in the same blob: no line to itself
      out.push({ src: id, from, to: to || null, lat: to ? to.lat : n.lat, lon: to ? to.lon : n.lon,
                 t: lineStrength(n.similarity), i, t0: l.t0, title: n.titles.fi })
    })
  }
  return out
}

export function webglOk() {
  try {
    const c = document.createElement('canvas')
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')))
  } catch { return false }
}
