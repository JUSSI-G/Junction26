import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { useSql } from './SqlDrawer.jsx'

// Worklist: articles ranked by how much their fi / sv / en versions disagree (GET /api/worklist,
// docs/contracts.md c). Click a column to sort, click a row to open the comparison view.
const COLS = [
  { key: 'score', label: 'Score', title: 'Overall: how much this article needs an editor (0–1, higher = more)', scale: 'unit' },
  { key: 'fi_sv', label: 'fi ↔ sv', title: 'Whole-article cosine distance between the Finnish and Swedish versions', scale: 'max', digits: 3 },
  { key: 'fi_en', label: 'fi ↔ en', title: 'Whole-article cosine distance between the Finnish and English versions', scale: 'max', digits: 3 },
  { key: 'missing_sv', label: 'Missing sv', title: 'Finnish sentences with no matching sentence in Swedish', scale: 'max' },
  { key: 'missing_en', label: 'Missing en', title: 'Finnish sentences with no matching sentence in English', scale: 'max' },
  { key: 'contradictions', label: 'Possible contradictions', title: 'Matched sentence pairs that Gemma 27B judged to disagree on a fact (check the sources)', scale: 'max', tone: 'bad' },
  { key: 'framing', label: 'Framing', title: 'Matched sentence pairs that Gemma 27B judged to tell the same fact with a different slant', scale: 'max' },
  { key: 'edit_war_score', label: 'Edit war', title: 'Edit-war activity in the Finnish history: reverts and sentences that came back (0–1)', scale: 'unit', tone: 'war' },
]

export default function Worklist({ onOpen }) {
  const [res, setRes] = useState(null)
  const [error, setError] = useState(null)
  const [sort, setSort] = useState({ key: 'score', dir: -1 })

  useEffect(() => { api.worklist(50).then(setRes).catch((e) => setError(e.message)) }, [])

  const max = useMemo(() => {
    const m = {}
    for (const c of COLS) m[c.key] = Math.max(0, ...(res?.data || []).map((r) => r[c.key] ?? 0))
    return m
  }, [res])

  const rows = useMemo(() => {
    const list = [...(res?.data || [])]
    const val = (r) => (sort.key === 'title' ? r.titles?.fi || '' : r[sort.key])
    list.sort((a, b) => {
      const x = val(a), y = val(b)
      if (x == null && y == null) return 0
      if (x == null) return 1 // not computed yet: always last
      if (y == null) return -1
      return (typeof x === 'string' ? x.localeCompare(y, 'fi') : x - y) * sort.dir
    })
    return list
  }, [res, sort])
  useSql(res ? [{ label: 'Worklist', sql: res.sql, ms: res.ms }] : [], [res])

  if (!res) return <div className="panel muted">{error ? `API error: ${error}` : 'Loading…'}</div>

  const head = (key, label, title) => (
    <th key={key} title={title} className={sort.key === key ? 'sorted' : ''}
        onClick={() => setSort({ key, dir: sort.key === key ? -sort.dir : key === 'title' ? 1 : -1 })}>
      {label}<span className="arrow">{sort.key === key ? (sort.dir < 0 ? '▼' : '▲') : ''}</span>
    </th>
  )

  return (
    <div className="panel worklist">
      <div className="legend" style={{ marginBottom: 10 }}>
        <span>{rows.length} articles about Finland that exist in Finnish, Swedish and English · click a column to sort · click a row to compare the three versions</span>
      </div>
      <table className="wl">
        <thead>
          <tr>
            <th className="rank">#</th>
            {head('title', 'Article', 'Finnish title (Swedish / English titles below)')}
            {COLS.map((c) => head(c.key, c.label, c.title))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.wikidata_id} onClick={() => onOpen(r)} title={`Compare the fi / sv / en versions of “${r.titles.fi}”`}>
              <td className="rank">{i + 1}</td>
              <td className="art">
                <b>{r.titles.fi}</b>
                <small>{r.titles.sv !== r.titles.fi ? `sv ${r.titles.sv} · ` : ''}{r.titles.en !== r.titles.fi ? `en ${r.titles.en} · ` : ''}{r.wikidata_id}</small>
              </td>
              {COLS.map((c) => <td key={c.key}><Bar v={r[c.key]} max={c.scale === 'unit' ? 1 : max[c.key]} digits={c.digits} tone={c.tone} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small" style={{ marginTop: 10 }}>— = that stage has not run yet for this article.</p>
    </div>
  )
}

function Bar({ v, max, digits, tone }) {
  if (v == null) return <span className="muted">—</span>
  const pct = max > 0 ? Math.min(100, (v / max) * 100) : 0
  const text = digits ? v.toFixed(digits) : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
  return (
    <span className={`bar ${tone || ''}`}>
      <span className="track"><span className="fill" style={{ width: `${pct}%` }} /></span>
      <span className="num">{text}</span>
    </span>
  )
}
