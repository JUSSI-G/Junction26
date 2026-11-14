import React, { useState } from 'react'

// The SQL drawer: the MariaDB query behind the current view, straight from the API response's `sql`.
// Same convention as the globe's drawer (web/globe/): a small "SQL" button, click to open.
export default function SqlDrawer({ queries }) {
  const list = (queries || []).filter((q) => q && q.sql)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState(0)
  if (!list.length) return null
  const cur = list[Math.min(tab, list.length - 1)]

  return (
    <section className={`sqldrawer${open ? ' open' : ''}`}>
      {open && (
        <div className="sqlcontent">
          {list.length > 1 && (
            <div className="sqltabs">
              {list.map((q, i) => (
                <button key={q.label} className={i === tab ? 'on' : ''} onClick={() => setTab(i)}>{q.label}</button>
              ))}
            </div>
          )}
          <pre>{highlight(cur.sql)}</pre>
        </div>
      )}
      <button className="btn sm sqltoggle" onClick={() => setOpen(!open)} title="The MariaDB query behind this view">
        {open ? '✕ SQL' : 'SQL'}
      </button>
    </section>
  )
}

const KW = /\b(SELECT|FROM|WHERE|JOIN|LEFT JOIN|ON|AND|OR|AS|ORDER BY|GROUP BY|LIMIT|USING|DESC|ASC|FOR SYSTEM_TIME|AS OF|VEC_DISTANCE_COSINE|VEC_DISTANCE)\b/g

function highlight(sql) {
  return sql.split('\n').map((line, i) => {
    if (line.trim().startsWith('--')) return <span key={i} className="c">{line}{'\n'}</span>
    const parts = []
    let last = 0
    for (const m of line.matchAll(KW)) {
      parts.push(line.slice(last, m.index))
      parts.push(<b key={m.index}>{m[0]}</b>)
      last = m.index + m[0].length
    }
    parts.push(line.slice(last))
    return <span key={i}>{parts}{'\n'}</span>
  })
}
