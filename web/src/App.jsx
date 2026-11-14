import React, { useEffect, useState } from 'react'
import { api, isMock, isEditorMock } from './api.js'
import TimeSlider from './views/TimeSlider.jsx'
import ContestedMap from './views/ContestedMap.jsx'
import EditWars from './views/EditWars.jsx'
import NarrativeDrift from './views/NarrativeDrift.jsx'
import Stats from './views/Stats.jsx'
import GlobeView from './views/GlobeView.jsx'
import Worklist from './views/Worklist.jsx'
import Compare from './views/Compare.jsx'

const VIEWS = [
  { id: 'worklist', label: 'Worklist', who: 'editors',
    help: 'Articles whose Finnish, Swedish and English versions differ most: missing content, contradictions, edit wars. Click a column to sort, click an article to compare the three versions sentence by sentence.' },
  { id: 'globe', label: 'Globe', who: 'explore',
    help: 'Every article with a place on the map. Taller, redder hexagons = articles whose text was fought over more. Drag to rotate, scroll to zoom, hover for names, click to see the place.' },
  { id: 'time', label: 'Time slider', who: 'readers',
    help: 'Read the article as it was on any date. Drag the slider (or click the bar chart) to travel in time; tick “Compare with” to see what was added (green) and removed (red) between two dates.' },
  { id: 'contested', label: 'Contested map', who: 'editors',
    help: 'Today’s text, each sentence coloured by how often it was rewritten or removed and put back. Click a sentence to see every earlier wording of it, who wrote it and when.' },
  { id: 'wars', label: 'Edit wars', who: 'editors',
    help: 'Sentences that were deleted and later restored, most-fought first. Click one to see each round: who added it, who removed it and why. “view” opens that moment in the time slider.' },
  { id: 'drift', label: 'Narrative drift', who: 'both',
    help: 'How the story changed: which words the article uses for the event and how neutral it reads, year by year. Click any point on a chart to open that period in the time slider.' },
]
const COMPARE_HELP = 'Finnish, Swedish and English side by side, sentence by sentence. Colour = how the sv / en sentence relates to the Finnish one; hover for Gemma\'s reason. Click a row to see what to fix, then open that language\'s Wikipedia editor: you make the edit.'
const EDITOR_VIEWS = ['worklist', 'compare']

// Editor views are addressable: #worklist, #compare/Q29207 (shareable links, screenshots).
function readHash() {
  const [v, id] = window.location.hash.replace(/^#/, '').split('/')
  if (v === 'compare' && id) return { view: 'compare', topic: decodeURIComponent(id) }
  if (v === 'worklist') return { view: 'worklist', topic: null }
  return null
}

const HERO_TITLE = 'Suomen sisällissota'

export default function App() {
  const [articles, setArticles] = useState([])
  const [article, setArticle] = useState(null)
  const [view, setViewRaw] = useState(() => readHash()?.view || 'globe')
  const [topic, setTopic] = useState(() => readHash()?.topic || null) // wikidata_id in the compare view
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  // Shared "moment" so views can hand over to each other (hero moment: drift spike -> time slider).
  const [focus, setFocus] = useState(null) // {from, to}
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    api.articles(q).then((list) => {
      setArticles(list)
      setArticle((cur) => cur || list.find((a) => a.title === HERO_TITLE) || list[0] || null)
    }).catch((e) => setError(e.message))
  }, [q])

  const setView = (v, t = null) => {
    setViewRaw(v); setTopic(t)
    const h = v === 'compare' ? `#compare/${encodeURIComponent(t)}` : v === 'worklist' ? '#worklist' : ''
    if (window.location.hash !== h) history.replaceState(null, '', h || window.location.pathname)
  }
  useEffect(() => {
    const onHash = () => { const h = readHash(); if (h) { setViewRaw(h.view); setTopic(h.topic) } }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  // From the comparison view to Kristian's views of the Finnish article.
  const openHistory = async (t) => {
    const title = t.titles.fi
    const found = articles.find((a) => a.title === title) || (await api.articles(title).catch(() => [])).find((a) => a.title === title)
    if (found) openArticle(found, 'wars')
    else setNotice(`“${title}”: no Finnish history found. Is the API running (make api)?`)
  }

  const jumpTo = (range) => { setFocus(range); setView('time') }
  // Open an article (from the globe or the search) in a history view. From the globe tab,
  // picking an article means "show it to me", so we go to the time slider.
  const openArticle = (a, v) => {
    setArticle(a); setFocus(null); setOpen(false); setQ('')
    setView(v || (view === 'globe' ? 'time' : view))
    window.scrollTo(0, 0)
  }
  // Enter in the search box: exact title match first, else the most-edited match.
  const onSearchKey = (e) => {
    if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur() }
    if (e.key !== 'Enter' || !articles.length) return
    const exact = articles.find((a) => a.title.toLowerCase() === q.trim().toLowerCase())
    openArticle(exact || articles[0])
    e.currentTarget.blur()
  }
  const current = view === 'compare' ? { label: 'Compare', help: COMPARE_HELP } : VIEWS.find((v) => v.id === view)
  const editor = EDITOR_VIEWS.includes(view)

  return (
    <div className="app">
      <header className="top">
        <h1>Contested History</h1>
        <span className="tag">which sentences of Finnish history Wikipedia keeps rewriting</span>
        {(isMock || (editor && isEditorMock)) && <span className="mockbadge">mock data</span>}
      </header>

      {!editor && <div className="picker">
        <input placeholder="Search articles… (e.g. sisällissota) — Enter opens" value={q}
               title="Type part of a title. Enter opens the best match; or click a result."
               onChange={(e) => { setQ(e.target.value); setOpen(true) }} onKeyDown={onSearchKey}
               onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
        {article && (
          <>
            <span className="current">{article.title}</span>
            <span className="meta">{article.revisions.toLocaleString()} revisions · {article.first_rev?.slice(0, 4)}–{article.last_rev?.slice(0, 4)}</span>
          </>
        )}
        {open && articles.length > 0 && (
          <div className="dropdown">
            {articles.map((a) => (
              <button key={a.page_id} onMouseDown={() => openArticle(a)} title={`Open “${a.title}”`}>
                <span>{a.title}</span><small>{a.revisions.toLocaleString()} revs</small>
              </button>
            ))}
          </div>
        )}
      </div>}

      <nav className="tabs">
        {VIEWS.map((v) => (
          <button key={v.id} className={view === v.id || (v.id === 'worklist' && view === 'compare') ? 'on' : ''} onClick={() => setView(v.id)} title={v.help}>
            {v.label}<span className="who">{v.who}</span>
          </button>
        ))}
      </nav>
      {current && (
        <p className="viewhelp">
          <b>{current.label}:</b> {current.help}
          {view !== 'globe' && !editor && article && <> Showing <i>{article.title}</i> — search above to switch article.</>}
        </p>
      )}

      {notice && editor && <p className="err">{notice}</p>}
      {error && !editor && <p className="err">API error: {error}. Is the API running (make api)? Or try npm run dev:mock.</p>}
      {view === 'globe' && <GlobeView onOpen={openArticle} />}
      {view === 'worklist' && <Worklist onOpen={(r) => { setView('compare', r.wikidata_id); window.scrollTo(0, 0) }} />}
      {view === 'compare' && topic && <Compare wikidataId={topic} onBack={() => setView('worklist')} onHistory={openHistory} />}
      {article && view === 'time' && <TimeSlider key={article.page_id} article={article} focus={focus} />}
      {article && view === 'contested' && <ContestedMap key={article.page_id} article={article} />}
      {article && view === 'wars' && <EditWars key={article.page_id} article={article} onJump={jumpTo} />}
      {article && view === 'drift' && <NarrativeDrift key={article.page_id} article={article} onJump={jumpTo} />}

      <Stats />
    </div>
  )
}
