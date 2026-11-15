import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api.js'

// What the 3D globe and the 2D map share: the data (places, coastlines), the dots of the current
// filter, the "most similar" neighbours of the hovered / pinned dot, and the colours.
export const MAX_LINES = 10
export const HOME = { lat: 64.5, lng: 25.5 }                  // Finland's middle
export const CORE = [[4, 53.5], [42, 71.5]]                   // the Nordic-Baltic core a view fits to
export const inCore = (lon, lat) => lon >= CORE[0][0] && lon <= CORE[1][0] && lat >= CORE[0][1] && lat <= CORE[1][1]
export const STACK_KM = 3.5                                   // spacing of articles stacked at one place

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
// 0..1 strength of a "most similar" line
export const lineStrength = (sim) => Math.max(0, Math.min(1, (sim - 0.6) / 0.3))

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

// One dot per topic in the filter that has a place. Topics at the same place (Helsinki has 400) get a
// stack index k and a sunflower offset of STACK_KM·√k (lat / lon for the globe; the 2D map spreads them
// in screen space, at least as far apart as on the ground).
export function useDots(res, places, semantic) {
  return useMemo(() => {
    if (!res || !places) return { dots: [], unplaced: 0 }
    const sims = res.data.map((r) => r.similarity).filter((v) => v != null)
    const smin = Math.min(...sims), smax = Math.max(...sims)
    const list = []
    const stack = new Map()
    let unplaced = 0
    for (const r of res.data) {
      const p = places.data[r.wikidata_id]
      if (!p) { unplaced++; continue }
      const [lat, lon] = p
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`
      const k = stack.get(key) || 0
      stack.set(key, k + 1)
      const a = k * 2.39996, rkm = k ? STACK_KM * Math.sqrt(k) : 0
      const jlat = lat + (rkm * Math.cos(a)) / 111
      const jlon = lon + (rkm * Math.sin(a)) / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)))
      const sim = r.similarity != null && smax > smin ? (r.similarity - smin) / (smax - smin) : null
      list.push({ r, id: r.wikidata_id, lat, lon, jlat, jlon, k, sim, place: p[3], located: p[2], core: inCore(lon, lat) })
    }
    // the most urgent (or the closest match) drawn last = on top
    list.sort((a, b) => (semantic ? (a.sim ?? 0) - (b.sim ?? 0) : (a.r.score ?? 0) - (b.r.score ?? 0)))
    return { dots: list, unplaced }
  }, [res, places, semantic])
}

// The dots a view should fit to: the Nordic-Baltic ones when most dots are there.
export function fitSet(dots) {
  const core = dots.filter((d) => d.core)
  return core.length >= Math.max(5, dots.length * 0.6) ? core : dots
}

const simCache = new Map()
// /api/similar for the hovered and pinned dots: {id: answer + t0 (when it arrived, for the draw-in)}
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

export function webglOk() {
  try {
    const c = document.createElement('canvas')
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')))
  } catch { return false }
}
