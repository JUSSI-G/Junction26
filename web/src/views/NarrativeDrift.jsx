import React, { useEffect, useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { api } from '../api.js'

// V4 — how the story changed: which name the article uses for the event, and how neutral it reads,
// at the end of every period. Click a period → V1 with that period's changes highlighted.
const DEFAULT_TERMS = ['vapaussota', 'sisällissota', 'kansalaissota', 'punakapina', 'luokkasota', 'veljessota']
const COLORS = ['#c0392b', '#2f5d8a', '#2e8b57', '#d4881e', '#8e44ad', '#5d6d7e', '#16a085', '#b03a6f']

export default function NarrativeDrift({ article, onJump }) {
  const [bucket, setBucket] = useState('year')
  const [termsText, setTermsText] = useState(DEFAULT_TERMS.join(', '))
  const [terms, setTerms] = useState(DEFAULT_TERMS)
  const [termRows, setTermRows] = useState(null)
  const [drift, setDrift] = useState(null)
  const [error, setError] = useState(null)
  const [models, setModels] = useState(null)

  useEffect(() => {
    api.stats().then((s) => setModels(Object.keys(s.scored_by || {}).join(', ') || null)).catch(() => {})
  }, [])

  useEffect(() => {
    api.termDrift(article.page_id, terms, bucket).then(setTermRows).catch((e) => setError(e.message))
    api.drift(article.page_id, bucket).then(setDrift).catch((e) => setError(e.message))
  }, [article.page_id, bucket, terms.join(',')])

  const termData = useMemo(() => (termRows || []).map((r) => ({ period: r.period, period_end: r.period_end, ...r.terms })), [termRows])

  // Per period: weighted average neutrality, loaded+partisan count, sentences per event name.
  const { tone, names } = useMemo(() => {
    const by = new Map()
    const names = new Set()
    for (const r of drift || []) {
      const p = by.get(r.period) || { period: r.period, period_end: r.period_end, n: 0, neu: 0, biased: 0 }
      p.n += r.n; p.neu += (r.avg_neutrality ?? 0) * r.n; p.biased += r.loaded + r.partisan
      if (r.event_name) { p[r.event_name] = r.n; names.add(r.event_name) }
      by.set(r.period, p)
    }
    const tone = [...by.values()].map((p) => ({ ...p, neutrality: p.n ? +(p.neu / p.n).toFixed(3) : null }))
    return { tone, names: [...names] }
  }, [drift])

  const click = (state) => {
    const p = state?.activePayload?.[0]?.payload
    if (!p) return
    const idx = termData.findIndex((r) => r.period === p.period)
    const prev = idx > 0 ? termData[idx - 1].period_end : null
    onJump({ from: prev, to: p.period_end })
  }

  return (
    <div className="charts">
      <div className="panel">
        <div className="legend" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Which name does the article use? <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· sentences mentioning each term</span></h3>
          <div className="bucket">
            {['month', 'quarter', 'year'].map((b) => (
              <button key={b} className={bucket === b ? 'on' : ''} onClick={() => setBucket(b)}>{b}</button>
            ))}
          </div>
        </div>
        <div className="terms">
          <input value={termsText} onChange={(e) => setTermsText(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && setTerms(termsText.split(',').map((t) => t.trim()).filter(Boolean))} />
          <span className="muted small">comma-separated, Enter to apply · click the chart to open that period in the time slider</span>
        </div>
        {error && <p className="err">{error}</p>}
        <div className="chartbox">
          <ResponsiveContainer>
            <LineChart data={termData} onClick={click} margin={{ left: -10, right: 10 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 11, fill: 'var(--muted)' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
              <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {terms.map((t, i) => (
                <Line key={t} type="monotone" dataKey={t} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <h3>Tone over time <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· every sentence scored for neutrality{models ? ` (${models})` : ''}</span></h3>
        {drift && drift.length === 0 && <p className="muted small">No scores yet for this article — run <code>make score</code>.</p>}
        <div className="chartbox" style={{ height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={tone} onClick={click} margin={{ left: -10, right: 10 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 11, fill: 'var(--muted)' }} />
              <YAxis yAxisId="l" domain={[0.5, 1]} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
              <YAxis yAxisId="r" orientation="right" allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
              <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="l" type="monotone" dataKey="neutrality" name="avg neutrality" stroke="var(--accent)" strokeWidth={2} dot={false} />
              <Line yAxisId="r" type="monotone" dataKey="biased" name="loaded/partisan sentences" stroke="#c0392b" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <h3>Names used for the event <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· sentences per name{models ? `, as classified by ${models}` : ''}</span></h3>
        <div className="chartbox" style={{ height: 240 }}>
          <ResponsiveContainer>
            <BarChart data={tone} onClick={click} margin={{ left: -10, right: 10 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 11, fill: 'var(--muted)' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
              <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {names.map((n, i) => <Bar key={n} dataKey={n} stackId="a" fill={COLORS[i % COLORS.length]} />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}
