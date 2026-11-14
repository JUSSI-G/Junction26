// API client. Contract: plan §6.2 (served under /api). With VITE_USE_MOCKS=1 (npm run dev:mock)
// every call is answered from web/mocks/*.json, generated from the real API by
// `python -m api.dump_mocks`, so the frontend can be built without a backend.

const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === '1'
// The editor views (worklist, compare) have their own switch, because their API (docs/contracts.md c)
// does not exist yet: mocks by default. Set VITE_EDITOR_MOCKS=0 (e.g. in web/.env.local) to use the API.
const EDITOR_MOCKS = USE_MOCKS || (import.meta.env.VITE_EDITOR_MOCKS ?? '1') !== '0'
const mockFiles = import.meta.glob('../mocks/*.json')

async function mock(name) {
  const key = `../mocks/${name}.json`
  if (!mockFiles[key]) throw new Error(`no mock ${name}.json`)
  return (await mockFiles[key]()).default
}

async function get(path, params = {}, mockName, useMock = USE_MOCKS) {
  if (useMock) return mock(mockName)
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  const res = await fetch(`/api${path}${qs.toString() ? '?' + qs : ''}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  articles: (q = '') => get('/articles', { q }, 'articles'),
  asOf: (id, date) => get(`/articles/${id}/as-of`, { date }, 'as_of'),
  diff: (id, from, to) => get(`/articles/${id}/diff`, { from, to }, 'diff'),
  contested: (id) => get(`/articles/${id}/contested`, {}, 'contested'),
  editWars: (id, limit = 30) => get(`/articles/${id}/edit-wars`, { limit }, 'edit_wars'),
  drift: (id, bucket = 'year') => get(`/articles/${id}/drift`, { bucket }, `drift_${bucket}`),
  termDrift: (id, terms, bucket = 'year') =>
    get(`/articles/${id}/term-drift`, { terms: terms?.join(','), bucket }, `term_drift_${bucket}`),
  revisions: (id) => get(`/articles/${id}/revisions`, {}, 'revisions'),
  sentenceHistory: (id, hash) => get(`/articles/${id}/sentences/${hash}/history`, {}, 'sentence_history'),
  revision: (revId) => get(`/revisions/${revId}`, {}, 'revision'),
  stats: () => get('/stats', {}, 'stats'),
  about: (id, date, from, to) => get(`/articles/${id}/about`, { date, from, to }, 'about'),
  aboutAll: (date, from, to) => get('/about', { date, from, to }, 'about_all'),
  map: () => get('/map', {}, 'map'),
  mapNear: (lat, lon, deg = 1) => get('/map/near', { lat, lon, deg }, 'map_near'),
  // Editor tool, docs/contracts.md (c). The mock compare.json holds one topic (Niinistö, Q29207).
  worklist: (limit = 50) => get('/worklist', { limit }, 'worklist', EDITOR_MOCKS),
  compare: (wikidataId) => get(`/compare/${encodeURIComponent(wikidataId)}`, {}, 'compare', EDITOR_MOCKS),
  // The demo app (api/explore.py): worklist with semantic / title search and topic chips, the map.
  topics: ({ q = '', mode = 'meaning', chip = '' } = {}) => get('/topics', { q, mode: q ? mode : null, chip }),
  chips: () => get('/chips'),
  similar: (wikidataId, k = 10) => get(`/similar/${encodeURIComponent(wikidataId)}`, { k }),
  topicPlaces: () => get('/topic-places'),
  queryText: (name) => get(`/queries/${name}`),
}

export const isMock = USE_MOCKS
export const isEditorMock = EDITOR_MOCKS

export const fmtDate = (iso) => (iso ? iso.slice(0, 10) : 'now')
export const wikiRev = (revId) => `https://fi.wikipedia.org/?oldid=${revId}`
