import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// Footer: dataset size and measured query times (GET /stats) — the "scalability" proof on screen.
export default function Stats() {
  const [s, setS] = useState(null)
  useEffect(() => { api.stats().then(setS).catch(() => {}) }, [])
  if (!s) return null
  const n = (x) => x?.toLocaleString()
  return (
    <footer className="stats">
      <span>dataset <b>{s.dataset}</b></span>
      <span><b>{n(s.articles)}</b> articles</span>
      <span><b>{n(s.revisions)}</b> revisions</span>
      <span><b>{n(s.sentence_rows)}</b> sentence lives (system-versioned rows)</span>
      <span><b>{n(s.scored_sentences)}</b> sentences scored{s.scored_by && Object.keys(s.scored_by).length ? ` (${Object.keys(s.scored_by).join(', ')})` : ''}</span>
      {Object.entries(s.query_ms).map(([k, v]) => <span key={k}>{k} p95 <b>{v.p95} ms</b></span>)}
      <span>MariaDB · FOR SYSTEM_TIME</span>
    </footer>
  )
}
