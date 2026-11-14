import Globe from 'globe.gl';
import { HISTORICAL } from './historical.js';

// ------------------------------------------------------------------ state
const YEARS = Array.from({ length: 23 }, (_, i) => 2004 + i);
const STORY_PAGE = 1150;
const STORY = [
  { year: 2005, text: 'A young article grows fast. Editors link the first towns and battlefields of the 1918 civil war.' },
  { year: 2010, text: 'Six years in, the article links 65 places. The war now reaches Brest-Litovsk, Berlin and St Petersburg.' },
  { year: 2014, text: 'One edit on 11 Feb 2014 moves the story from towns to prison camps: Tampere and Suomenlinna out, five camps in.' },
  { year: 2018, text: 'The centenary. The article links 107 places, and small battles have articles of their own.' },
  { year: 2026, text: 'Today: 112 places, and the story is still being rewritten.' },
];
const params = new URLSearchParams(location.search);
const state = {
  year: +params.get('year') || 2004,
  metric: params.get('metric') || 'knowledge',
  playing: false,
  story: null,          // index into STORY, or null
  sqlTab: 'heat',
  panelSql: null,
  showAll: params.get('all') === '1',   // also draw unchanged links and arcs with an inferred origin
};
const METRIC = {
  knowledge: { hint: 'Links pointing to each place on 1 January, plus the size of the articles about it.',
               size: 'more written about it', unit: 'links + KB written' },
  activity: { hint: 'Edits saved that year to the articles about, or linking, each place.',
              size: 'more edits that year', unit: 'edits' },
  controversy: { hint: 'Edits that were undone (reverted) that year in those articles.',
                 size: 'more edits undone that year', unit: 'reverts' },
  rewritten: { hint: 'Links to each place that articles added or removed that year.',
               size: 'more links added or removed', unit: 'link changes' },
  language: { hint: 'How much the Swedish and English Wikipedia articles differ from the Finnish one (today\'s text).',
              size: 'more different', unit: '' },
};
// ---- language differences (the editor tool): article -> Stockholm (sv) / London (en)
const LANG_END = {
  sv: { lat: 59.3293, lon: 18.0686, title: 'sv', name: 'Swedish Wikipedia' },
  en: { lat: 51.5072, lon: -0.1276, title: 'en', name: 'English Wikipedia' },
};
const DIFF_RAMP = [[61, 220, 132], [255, 200, 60], [255, 90, 95]];   // same -> different
const diffT = (d) => Math.max(0, Math.min(1, (d - 0.15) / (0.40 - 0.15)));  // tooltips: cosine distance p10..p97
// Lines and dots: percentile within the language, so green = more alike than most, red = among the most different.
// Lines: only the most different 15 % per language are drawn clearly; the rest stay a faint haze.
const LINE_TOP = 0.15;
const topShare = (t) => Math.max(0, (t - (1 - LINE_TOP)) / LINE_TOP) ** 1.5;
function pctRank(values) { const s = [...values].sort((a, b) => a - b); return (v) => (s.length > 1 ? s.findIndex((x) => x >= v) / (s.length - 1) : 0); }
const compareUrl = (q) => `/contested/#compare/${q}`;
let langLines = null;   // /api/lang-lines response (cached)
const isLang = () => state.metric === 'language';
// Finnish title, with the English Wikidata label when it says something different.
const en = (d) => (d.en_label && d.en_label.toLowerCase() !== d.title.toLowerCase() ? d.en_label : '');
const both = (d) => `${esc(d.title)}${en(d) ? ` <span class="en">${esc(en(d))}</span>` : ''}`;
const cache = { heat: {}, arcs: {} };   // heat[metric][year], arcs[pageKey][year]
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');

// ------------------------------------------------------------------ data
async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
function heatKey() { return state.metric; }
function arcKey() { return state.story !== null ? `p${STORY_PAGE}` : state.showAll ? 'all' : 'changes'; }
async function getHeat(metric, year) {
  const m = (cache.heat[metric] ||= {});
  return (m[year] ||= api(`/api/heat?year=${year}&metric=${metric}&limit=1300`));
}
async function getArcs(key, year) {
  const m = (cache.arcs[key] ||= {});
  // changes: the 150 strongest added + 150 removed arcs. all: 90 per group, unchanged and inferred too.
  const q = key === 'changes' ? '&limit=220' : key === 'all' ? '&all=1&limit=90' : `&page=${key.slice(1)}`;
  return (m[year] ||= api(`/api/arcs?year=${year}${q}`));
}

// Preload every year for the current metric and arc set, a few requests at a time.
let preloadRun = 0;
async function preload() {
  const run = ++preloadRun;
  if (isLang()) { $('preload-bar').style.opacity = 0; return; }
  const metric = heatKey(), key = arcKey();
  const jobs = [];
  for (const y of YEARS) { jobs.push(() => getHeat(metric, y)); jobs.push(() => getArcs(key, y)); }
  let done = 0;
  const bar = $('preload-bar');
  bar.style.opacity = 0.7;
  const worker = async () => {
    while (jobs.length && run === preloadRun) {
      await jobs.shift()().catch(() => {});
      done++;
      if (run === preloadRun) bar.style.width = `${(100 * done) / (YEARS.length * 2)}%`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (run !== preloadRun) return;
  bar.style.opacity = 0;
  await computeMax(metric);
  render();
}

// Scale: sqrt of value / the metric's maximum over all loaded years, so years are comparable.
const maxima = {};   // metric -> {point, country}
async function computeMax(metric) {
  const mx = { point: 1, country: 1 };
  for (const p of Object.values(cache.heat[metric] || {})) {
    const res = await p.catch(() => null);
    if (!res) continue;
    for (const row of polygonTotals(res.data).values()) mx.country = Math.max(mx.country, row.value);
    for (const d of res.data) if (!polygonQid(d)) mx.point = Math.max(mx.point, d.value);
  }
  maxima[metric] = mx;
}

// ------------------------------------------------------------------ countries
let countryFeatures = [];
const featureByQid = new Map();
function polygonQid(d) {
  if (!d.is_country) return null;
  const q = HISTORICAL[d.title] || d.qid;
  return featureByQid.has(q) ? q : null;
}
function polygonTotals(rows) {
  const totals = new Map();   // qid -> {value, places: [...]}
  for (const d of rows) {
    const q = polygonQid(d);
    if (!q) continue;
    const t = totals.get(q) || { value: 0, places: [] };
    t.value = Math.max(t.value, d.value);   // max, not sum: the same articles link several eras
    t.places.push(d);
    totals.set(q, t);
  }
  return totals;
}

// ------------------------------------------------------------------ colour
const lerp = (a, b, t) => a + (b - a) * t;
function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  return stops[i].map((c, k) => Math.round(lerp(c, stops[i + 1][k], f)));
}
const POINT_RAMP = [[107, 63, 16], [255, 176, 32], [255, 241, 194]];
const COUNTRY_RAMP = [[26, 44, 74], [38, 84, 140], [70, 140, 214]];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const ARC = { added: [61, 220, 132], removed: [255, 90, 95], same: [143, 155, 179] };

// ------------------------------------------------------------------ globe
let zoom = 1;   // marks are sized in degrees; shrink them when the camera is close
const globe = new Globe($('globe'), { animateIn: false })
  .backgroundColor('#05070d')
  .globeImageUrl('/earth-dark.jpg')
  .bumpImageUrl('/earth-topology.png')
  .atmosphereColor('#4b83c4')
  .atmosphereAltitude(0.16)
  // countries
  .polygonAltitude(0.005)
  .polygonSideColor(() => 'rgba(0,0,0,0)')
  .polygonStrokeColor(() => 'rgba(120,140,180,0.28)')
  .polygonsTransitionDuration(0)
  .polygonLabel((f) => f.__tip || '')
  .onPolygonClick((f) => f.__top && openPlace(f.__top.title, f.__places))
  // places
  .pointLat('lat').pointLng('lon')
  .pointsMerge(false)
  .pointsTransitionDuration(0)
  .pointAltitude((d) => (d.lang ? 0.012 : 0.007 + 0.012 * d.t))
  .pointRadius((d) => zoom * (d.lang ? (d.inferred ? 0.06 : 0.12) + 0.18 * d.t : 0.06 + 0.42 * d.t))
  .pointColor((d) => (d.lang ? rgba(ramp(DIFF_RAMP, d.t), 0.95) : rgba(ramp(POINT_RAMP, 0.15 + 0.85 * d.t), 0.7 + 0.28 * d.t)))
  .pointLabel((d) => (d.lang ? langTip(d.topic) : `<div class="tip"><b>${both(d)}</b><br><span class="k">${esc(d.kind || d.category)}</span><br><b>${fmt(d.value)}</b> ${METRIC[state.metric].unit} in ${state.year}<br><span class="k">click for its articles</span></div>`))
  .onPointClick((d) => (d.lang ? (location.href = compareUrl(d.wikidata_id)) : openPlace(d.title)))
  // place names: DOM labels (crisp, full Finnish alphabet), decluttered in render()
  .htmlLat('lat').htmlLng('lon').htmlAltitude(0.02)
  .htmlTransitionDuration(0)
  .htmlElement((d) => {
    const el = document.createElement('div');
    el.className = `place-label${d.changed ? ` ${d.changed}` : ''}${d.langEnd ? ' lang-end' : ''}`;
    if (d.langEnd) { el.innerHTML = `<b>${d.title}</b> ${esc(d.name)}`; return el; }
    if (d.lang) { el.innerHTML = esc(d.title); el.onclick = () => (location.href = compareUrl(d.wikidata_id)); return el; }
    el.innerHTML = labelText(d).length > d.title.length ? both(d) : esc(d.title);
    el.onclick = () => openPlace(d.title);
    return el;
  })
  // selected place
  .ringLat('lat').ringLng('lon').ringColor(() => (t) => `rgba(255,176,32,${1 - t})`)
  .ringMaxRadius(1.6).ringPropagationSpeed(1.2).ringRepeatPeriod(900)
  // arcs
  .arcStartLat((d) => d.from.lat).arcStartLng((d) => d.from.lon)
  .arcEndLat((d) => d.to.lat).arcEndLng((d) => d.to.lon)
  .arcColor((d) => {
    if (d.lang) { const c = ramp(DIFF_RAMP, d.t), a = 0.025 + 0.9 * topShare(d.t); return [rgba(c, a * 0.5), rgba(c, a)]; }
    const a = d.status === 'same' ? (d.origin_inferred ? 0.06 : 0.14) : (d.origin_inferred ? 0.3 : 0.95);
    return [rgba(ARC[d.status], a * 0.55), rgba(ARC[d.status], a)];
  })
  .arcStroke((d) => zoom * (d.lang ? 0.02 + 0.16 * topShare(d.t) : d.status === 'same' ? 0.04 : (d.origin_inferred ? 0.09 : 0.14) + 0.04 * Math.min(3, d.weight)))
  .arcAltitudeAutoScale(0.16)
  .arcDashLength((d) => (d.lang || d.status === 'same' ? 1 : d.status === 'added' ? 0.55 : 0.25))
  .arcDashGap((d) => (d.lang || d.status === 'same' ? 0 : d.status === 'added' ? 0.25 : 0.2))
  .arcDashAnimateTime((d) => (d.lang || d.status === 'same' ? 0 : d.status === 'added' ? 2200 : 3600))
  .arcsTransitionDuration(0)
  .arcLabel((d) => {
    if (d.lang) return langTip(d.topic, d.lang);
    const n = d.weight;
    const word = { added: `+ link${n > 1 ? 's' : ''} added`, removed: `− link${n > 1 ? 's' : ''} removed`, same: 'unchanged' }[d.status];
    const arts = d.articles.slice(0, 5).map((a) => esc(a.title)).join('<br>');
    const more = n > 5 ? `<br><span class="k">+ ${fmt(n - Math.min(5, d.articles.length))} more</span>` : '';
    return `<div class="tip"><span class="s-${d.status}">${word}</span> in ${state.year}<br>
      <b>${esc(d.from.title)} → ${esc(d.to.title)}</b>${d.origin_inferred ? '<br><span class="k">start of the arc is a guess: the place this article links most</span>' : ''}
      <br><span class="k">${n > 1 ? `${fmt(n)} articles` : 'article'} about ${esc(d.from.title)}:</span><br>${arts}${more}</div>`;
  })
  .onArcClick((d) => (d.lang ? (location.href = compareUrl(d.topic.wikidata_id)) : openArticle(d.articles[0].page_id)));

const HOME = { lat: 61.2, lng: 23.5, altitude: 0.62 };
const EUROPE = { lat: 57.5, lng: 13, altitude: 1.05 };   // Finland, Stockholm and London in one view
globe.pointOfView(HOME, 0);
globe.controls().autoRotate = false;
window.addEventListener('resize', () => globe.width(innerWidth).height(innerHeight));

// ------------------------------------------------------------------ render
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const { year, metric } = state;
  $('year').value = year;
  $('year-big').textContent = year;
  document.querySelectorAll('#ticks span').forEach((s) => s.classList.toggle('on', +s.dataset.y === year));
  document.querySelectorAll('#metrics button').forEach((b) => b.classList.toggle('on', b.dataset.metric === metric));
  $('legend-metric').textContent = METRIC[metric].size;
  $('metric-hint').textContent = METRIC[metric].hint;
  document.body.classList.toggle('lang-mode', isLang());
  if (isLang()) { await renderLanguage(seq); return; }
  renderCaption();

  const [heat, arcs] = await Promise.all([getHeat(metric, year), getArcs(arcKey(), year)]);
  if (seq !== renderSeq) return;
  const mx = maxima[metric] || { point: Math.max(1, ...heat.data.filter((d) => !polygonQid(d)).map((d) => d.value)),
                                 country: Math.max(1, ...[...polygonTotals(heat.data).values()].map((t) => t.value)) };

  // countries
  const totals = polygonTotals(heat.data);
  for (const f of countryFeatures) {
    const t = totals.get(f.properties.qid);
    f.__t = t ? 0.12 + 0.88 * Math.sqrt(t.value / mx.country) : null;
    f.__places = t ? t.places.sort((a, b) => b.value - a.value) : null;
    f.__top = t ? f.__places[0] : null;
    f.__tip = t
      ? `<div class="tip"><b>${esc(f.properties.name)}</b><br><b>${fmt(t.value)}</b> ${METRIC[metric].unit} in ${year}<br><span class="k">${t.places.slice(0, 5).map((p) => `${esc(p.title)} ${fmt(p.value)}`).join('<br>')}</span></div>`
      : '';
  }
  globe.polygonCapColor((f) => (f.__t === null ? 'rgba(20,27,42,0.72)' : rgba(ramp(COUNTRY_RAMP, f.__t), 0.62 + 0.2 * f.__t)));
  globe.polygonsData(countryFeatures);

  // places (top 1500 keeps the scene light at full scale)
  const points = heat.data.filter((d) => !polygonQid(d)).sort((a, b) => b.value - a.value).slice(0, 700)
    .map((d) => ({ ...d, t: Math.sqrt(d.value / mx.point) }));
  globe.pointsData(points);
  let labels = points;

  // arcs
  let shown = arcs.data;
  if (arcKey() === 'changes') {
    // Draw green and red in the year's real proportion (the API sends the strongest of each).
    const c = captions?.data.find((r) => r.year === year);
    const total = 220, share = c && c.added + c.removed ? c.removed / (c.added + c.removed) : 0.5;
    const nRemoved = Math.max(8, Math.round(total * share));
    const added = arcs.data.filter((a) => a.status === 'added'), removed = arcs.data.filter((a) => a.status === 'removed');
    shown = [...added.slice(0, total - nRemoved), ...removed.slice(0, nRemoved)];
  }
  globe.arcsData(shown);
  const n = { added: 0, removed: 0, same: 0 };
  for (const a of arcs.data) n[a.status]++;
  if (state.story !== null) {
    // In story mode, name the places the article's links changed to this year.
    const changed = arcs.data.filter((a) => a.status !== 'same')
      .sort((a, b) => (a.status === 'removed' ? 0 : 1) - (b.status === 'removed' ? 0 : 1))
      .map((a) => ({ ...a.to, value: a.status === 'added' ? 2 : 1, changed: a.status }));
    labels = changed;
    $('story-counts').innerHTML = `In ${year} this one article <span class="s-added">added ${n.added}</span> place links, <span class="s-removed">removed ${n.removed}</span> and kept ${n.same}.`;
  }

  labelPool = labels;
  placeLabels();

  lastSql.heat = heat; lastSql.arcs = arcs; lastSql.caption = captions;
  renderSql();
}

// ------------------------------------------------------------------ language differences
function langTip(t, only = null) {
  const line = (l) => {
    const d = t[`fi_${l}`], miss = t[`missing_${l}`];
    return `<span class="lang-tag" style="background:${rgba(ramp(DIFF_RAMP, diffT(d)), 0.9)}">${l}</span> `
      + `distance <b>${d.toFixed(3)}</b>${miss != null ? ` · ${fmt(miss)} Finnish sentences missing` : ''}`;
  };
  return `<div class="tip"><b>${esc(t.titles.fi)}</b>${t.titles.en !== t.titles.fi ? ` <span class="en">${esc(t.titles.en)}</span>` : ''}<br>
    ${(only ? [only] : ['sv', 'en']).map(line).join('<br>')}<br>${t.place ? `<span class="k">placed at ${esc(t.place)}, the place its article links most</span><br>` : ''}<span class="k">click to compare fi / sv / en</span></div>`;
}

async function renderLanguage(seq) {
  langLines ||= await api('/api/lang-lines');
  if (seq !== renderSeq) return;
  for (const f of countryFeatures) { f.__t = null; f.__tip = ''; f.__top = null; }
  globe.polygonCapColor(() => 'rgba(20,27,42,0.72)');
  globe.polygonsData(countryFeatures);
  const topics = langLines.data;
  const rank = { sv: pctRank(topics.map((t) => t.fi_sv)), en: pctRank(topics.map((t) => t.fi_en)) };
  const dots = topics.map((t) => ({ lang: true, topic: t, wikidata_id: t.wikidata_id, title: t.titles.fi,
    inferred: t.located_by === 'inferred',
    lat: t.lat, lon: t.lon, value: (rank.sv(t.fi_sv) + rank.en(t.fi_en)) / 2,
    t: (rank.sv(t.fi_sv) + rank.en(t.fi_en)) / 2 }));
  globe.pointsData(dots);
  // Most different on top: draw the calm lines first.
  const lines = topics.flatMap((t) => ['sv', 'en'].map((l) => ({ lang: l, topic: t, t: rank[l](t[`fi_${l}`]),
    from: { lat: t.lat, lon: t.lon }, to: LANG_END[l] }))).sort((a, b) => a.t - b.t);
  globe.arcsData(lines);
  $('lang-count').textContent = fmt(topics.length);
  // Labels: the two languages, then the most different articles.
  labelPool = [{ ...LANG_END.sv, langEnd: true }, { ...LANG_END.en, langEnd: true },
    ...[...dots].sort((a, b) => b.value - a.value)];
  placeLabels();
  lastSql.heat = { sql: langLines.sql, ms: langLines.ms, built_from: '-- article_divergence: python -m db.build_divergence (VEC_DISTANCE_COSINE between the bge-m3 article vectors)' };
  lastSql.arcs = lastSql.heat;
  renderSql();
}

// The sentence for the year: totals, and the single edit that changed the most place links.
let captions = null;                       // /api/captions response
const tidy = (c) => String(c || '').replace(/\/\*\s*(.*?)\s*\*\//g, '$1: ').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/:\s*$/, '').trim();
function renderCaption() {
  const c = captions?.data.find((r) => r.year === state.year);
  $('caption').hidden = state.story !== null || !c;
  if (!c) return;
  $('caption-totals').innerHTML = `<b>${state.year}</b> · articles <span class="s-added">added ${fmt(c.added)}</span> links to places and <span class="s-removed">removed ${fmt(c.removed)}</span>`;
  const big = $('caption-biggest');
  big.hidden = !c.page_id;
  if (c.page_id) {
    const parts = [c.n_added ? `${fmt(c.n_added)} added` : '', c.n_removed ? `${fmt(c.n_removed)} removed` : ''].filter(Boolean).join(', ');
    const summary = tidy(c.comment);
    big.innerHTML = `Biggest single edit: <a href="#" id="caption-open">${esc(c.title)}</a>, ${parts}`
      + (summary ? ` <span class="k">— editor's note: “${esc(summary.length > 90 ? `${summary.slice(0, 88)}…` : summary)}”</span>` : '');
    $('caption-open').onclick = (e) => { e.preventDefault(); openArticle(c.page_id); };
  }
  // Room for Gemma's one-sentence explanation (change_reason table, stage 7); hidden until it exists.
  const why = $('caption-reason');
  why.hidden = !c.reason;
  if (c.reason) why.innerHTML = `<span class="gemma">explained by Gemma</span> ${esc(c.reason)}`;
}

// On the globe the English name is added only when the pair stays short.
const labelText = (d) => (en(d) && d.title.length + en(d).length <= 24 ? `${d.title} ${en(d)}` : d.title);

// Place names: strongest first, skipping any that would sit on top of one already shown.
let labelPool = [];
function placeLabels() {
  const alt = globe.pointOfView().altitude;
  const story = state.story !== null;
  const minDeg = Math.max(0.3, (story ? 1.3 : 2.4) * alt), max = story ? 22 : 16, shown = [];
  const sel = panelView?.type === 'place' ? labelPool.find((d) => d.title === panelView.title) : null;
  for (const d of sel ? [sel, ...labelPool] : labelPool) {
    if (d === sel && shown.length) continue;
    if (d.langEnd) { shown.push(d); continue; }
    if (shown.length >= max) break;
    const cos = Math.cos((d.lat * Math.PI) / 180);
    // wider labels need more room sideways (about 9 characters fit in minDeg)
    const wide = (o) => minDeg * Math.max(1, (labelText(o).length + labelText(d).length) / 18);
    if (shown.some((o) => Math.abs(o.lat - d.lat) < minDeg * 0.45 && Math.abs(o.lon - d.lon) * cos < wide(o))) continue;
    shown.push(d);
  }
  globe.htmlElementsData(shown);
}
function rescale() {
  const z = Math.max(0.3, Math.min(1.6, globe.pointOfView().altitude / 0.62));
  if (Math.abs(z - zoom) / zoom < 0.12) return;
  zoom = z;
  globe.pointRadius(globe.pointRadius()).arcStroke(globe.arcStroke());   // re-evaluate the accessors
}
globe.controls().addEventListener('end', () => { rescale(); placeLabels(); });

// ------------------------------------------------------------------ SQL drawer
const lastSql = { heat: null, arcs: null, caption: null };
function highlight(sql) {
  return esc(sql)
    .replace(/(--[^\n]*)/g, '<span class="c">$1</span>')
    .replace(/(FOR SYSTEM_TIME (?:AS OF|ALL|FROM|BETWEEN))/g, '<mark>$1</mark>');
}
function renderSql() {
  let text = '', ms = '';
  if (state.sqlTab === 'heat' && lastSql.heat) {
    ms = lastSql.heat.ms;
    text = `-- What the globe reads (${ms} ms)\n${lastSql.heat.sql}\n\n-- How heat_year was built for ${state.year}: system-versioned queries\n${lastSql.heat.built_from}`;
  } else if (state.sqlTab === 'arcs' && lastSql.arcs) {
    ms = lastSql.arcs.ms;
    text = `-- Arcs for ${state.year} (${ms} ms)\n${lastSql.arcs.sql}`
      + (lastSql.arcs.built_from ? `\n\n-- How arc_year was built for ${state.year}: system-versioned queries\n${lastSql.arcs.built_from}` : '');
  } else if (state.sqlTab === 'caption' && lastSql.caption) {
    ms = lastSql.caption.ms;
    text = `-- The sentence above the globe (${ms} ms)\n${lastSql.caption.sql}\n\n${lastSql.caption.built_from}`;
  } else if (state.sqlTab === 'panel') {
    ms = state.panelSql?.ms ?? '';
    text = state.panelSql ? `-- Side panel (${ms} ms)\n${state.panelSql.sql}` : '-- Click a place or an article to see its query.';
  }
  $('sql-text').innerHTML = highlight(text);
  $('sql-ms').textContent = ms !== '' ? `${ms} ms` : '';
  document.querySelectorAll('#sql-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.sqlTab));
}
$('sql-toggle').onclick = () => $('sql-drawer').classList.toggle('closed');
document.querySelectorAll('#sql-tabs button').forEach((b) => (b.onclick = () => { state.sqlTab = b.dataset.tab; renderSql(); }));

// ------------------------------------------------------------------ side panel
const panelDate = () => (state.year >= 2026 ? '' : `${state.year}-12-31`);
const dateLabel = () => (state.year >= 2026 ? 'today' : `31 Dec ${state.year}`);
let panelView = null;   // {type:'place', title, siblings} | {type:'article', page_id, from}
function showPanel(html) { $('panel-body').innerHTML = html; $('panel').hidden = false; $('panel').scrollTop = 0; document.body.classList.add('panel-open'); }
function closePanel() { $('panel').hidden = true; panelView = null; document.body.classList.remove('panel-open'); globe.ringsData([]); }
$('panel-close').onclick = closePanel;

async function openPlace(title, siblings = null, fly = true) {
  panelView = { type: 'place', title, siblings };
  const d = panelDate();
  let res;
  try { res = await api(`/api/place/${encodeURIComponent(title)}${d ? `?date=${d}` : ''}`); }
  catch { showPanel(`<h2>${esc(title)}</h2><p class="empty">No data for this place.</p>`); return; }
  if (panelView?.title !== title) return;
  const p = res.place;
  globe.ringsData(p.is_country ? [] : [p]);
  if (fly) globe.pointOfView({ lat: p.lat, lng: p.lon, altitude: p.is_country ? 0.9 : 0.3 }, 1200);
  setTimeout(() => { rescale(); placeLabels(); }, 1300);
  const located = res.data.filter((r) => r.relation === 'located here');
  const linking = res.data.filter((r) => r.relation === 'links here');
  const item = (r) => `<li data-page="${r.page_id}"><span class="t">${esc(r.title)}</span><span class="m">${
    r.mentions ? `${r.mentions}× · ` : ''}${fmt(Math.round(r.len / 1000))} KB</span></li>`;
  const sib = (siblings || []).filter((s) => s.title !== title);
  showPanel(`
    <h2>${esc(p.title)}</h2>
    <p class="sub">${en(p) ? `${esc(en(p))} · ` : ''}${esc(p.kind || p.category)} · as of ${dateLabel()}</p>
    ${sib.length ? `<div class="chips">${sib.slice(0, 8).map((s) => `<button class="chip" data-place="${esc(s.title)}">${esc(s.title)}</button>`).join('')}</div>` : ''}
    ${located.length ? `<h3>Articles located here</h3><ul class="article-list">${located.map(item).join('')}</ul>` : ''}
    <h3>${fmt(res.linking_total)} article${res.linking_total === 1 ? '' : 's'} link here${res.linking_total > linking.length ? ` · the ${linking.length} that mention it most` : ''}</h3>
    ${linking.length ? `<ul class="article-list">${linking.map(item).join('')}</ul>` : `<p class="empty">No article linked this place on ${dateLabel()}.</p>`}
  `);
  document.querySelectorAll('#panel [data-page]').forEach((li) => (li.onclick = () => openArticle(+li.dataset.page, panelView)));
  document.querySelectorAll('#panel [data-place]').forEach((b) => (b.onclick = () => openPlace(b.dataset.place, siblings, false)));
  state.panelSql = res; state.sqlTab = 'panel'; renderSql();
}

async function openArticle(page_id, from = null) {
  panelView = { type: 'article', page_id, from };
  if (!from) globe.ringsData([]);
  const d = panelDate();
  let a;
  try { a = await api(`/api/article/${page_id}${d ? `?date=${d}` : ''}`); }
  catch { showPanel(`<p class="empty">This article did not exist yet on ${dateLabel()}.</p>`); return; }
  if (panelView?.page_id !== page_id) return;
  const out = [];
  let inList = false;
  for (const b of a.blocks) {
    if (b.kind === 'li') { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${esc(b.text)}</li>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(b.kind === 'h' ? `<h4>${esc(b.text)}</h4>` : `<p>${esc(b.text)}</p>`);
  }
  if (inList) out.push('</ul>');
  showPanel(`
    ${from ? `<button class="btn small back">← ${esc(from.title)}</button>` : ''}
    <h2>${esc(a.title)}</h2>
    <p class="sub">As it stood on ${dateLabel()} · saved ${esc(a.saved.slice(0, 16))} UTC by ${esc(a.user || 'unknown')}</p>
    <div class="stats">
      <div class="stat"><b>${fmt(a.edits_to_date)}</b><span>edits so far</span></div>
      <div class="stat"><b>${fmt(a.reverts_to_date)}</b><span>reverts so far</span></div>
      <div class="stat"><b>${fmt(Math.round(a.len / 1000))} KB</b><span>length</span></div>
    </div>
    <p class="sub"><a href="${esc(a.oldid_url)}" target="_blank" rel="noopener">Open this version on Wikipedia (oldid ${a.rev_id}) ↗</a></p>
    <h3>Text on that day</h3>
    <div class="article-text">${out.join('')}</div>
  `);
  const back = document.querySelector('#panel .back');
  if (back) back.onclick = () => openPlace(from.title, from.siblings, false);
  state.panelSql = a; state.sqlTab = 'panel'; renderSql();
}

function refreshPanel() {
  if (!panelView) return;
  if (panelView.type === 'place') openPlace(panelView.title, panelView.siblings, false);
  else openArticle(panelView.page_id, panelView.from);
}

// ------------------------------------------------------------------ controls
let timer = null;
function setYear(y, { keepPanel = true } = {}) {
  state.year = Math.max(2004, Math.min(2026, y));
  render();
  if (keepPanel && !state.playing) refreshPanel();
}
function play(on) {
  state.playing = on;
  $('play').textContent = on ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
  clearInterval(timer);
  if (!on) { refreshPanel(); return; }
  if (state.story !== null) { timer = setInterval(() => storyStep((state.story + 1) % STORY.length), 6000); return; }
  if (state.year >= 2026) setYear(2004);
  timer = setInterval(() => {
    if (state.year >= 2026) { play(false); return; }
    setYear(state.year + 1);
  }, 1500);
}
$('play').onclick = () => play(!state.playing);
$('year').oninput = (e) => { if (state.story !== null) exitStory(false); setYear(+e.target.value); };
$('ticks').innerHTML = YEARS.map((y) => `<span data-y="${y}">${y % 2 === 0 ? `’${String(y).slice(2)}` : ''}</span>`).join('');
document.querySelectorAll('#metrics button').forEach((b) => (b.onclick = () => {
  const wasLang = isLang();
  state.metric = b.dataset.metric;
  if (isLang() && !wasLang) { closePanel(); globe.pointOfView(EUROPE, 1200); setTimeout(() => { rescale(); placeLabels(); }, 1300); }
  if (!isLang() && wasLang) { globe.pointOfView(HOME, 1200); setTimeout(() => { rescale(); placeLabels(); }, 1300); }
  render();
  preload();
}));

$('show-all').checked = state.showAll;
$('show-all').onchange = (e) => { state.showAll = e.target.checked; render(); preload(); };

// ------------------------------------------------------------------ landing
function closeLanding() { $('landing').hidden = true; }
$('landing-story').onclick = () => { closeLanding(); startStory(true); };
$('landing-explore').onclick = () => { closeLanding(); setYear(2004); play(true); };

// ------------------------------------------------------------------ story
function storyStep(i) {
  state.story = i;
  const s = STORY[i];
  $('story-text').textContent = s.text;
  $('story-dots').innerHTML = STORY.map((x, k) => `<button data-i="${k}" class="${k === i ? 'on' : ''}">${x.year === 2026 ? 'now' : x.year}</button>`).join('');
  document.querySelectorAll('#story-dots button').forEach((b) => (b.onclick = () => { play(false); storyStep(+b.dataset.i); }));
  state.year = s.year;
  render();
  openArticle(STORY_PAGE);
}
function startStory(autoplay = true, step = 0) {
  play(false);
  state.story = step;
  $('story-card').hidden = false;
  $('story-btn').hidden = true;
  document.body.classList.add('story');
  globe.pointOfView({ lat: 60.5, lng: 22, altitude: 0.78 }, 1400);
  setTimeout(() => { rescale(); placeLabels(); }, 1500);
  storyStep(step);
  preload();
  if (autoplay) play(true);
}
function exitStory(rerender = true) {
  play(false);
  state.story = null;
  $('story-card').hidden = true;
  $('story-btn').hidden = false;
  document.body.classList.remove('story');
  closePanel();
  if (rerender) { render(); preload(); }
}
$('story-btn').onclick = () => startStory(true);
$('story-exit').onclick = () => { exitStory(); globe.pointOfView(HOME, 1200); };

// ------------------------------------------------------------------ start
(async function init() {
  const geo = await fetch('/countries.geojson').then((r) => r.json());
  countryFeatures = geo.features.filter((f) => f.properties.iso !== 'AQ');
  for (const f of countryFeatures) featureByQid.set(f.properties.qid, f);
  captions = await api('/api/captions').catch(() => null);
  if (params.get('sql')) { $('sql-drawer').classList.remove('closed'); if (params.get('sql') !== '1') state.sqlTab = params.get('sql'); }
  // The landing overlay greets a first visit; deep links (?year=, ?story=, ?place=) skip it.
  $('landing').hidden = ['year', 'story', 'place'].some((k) => params.has(k));
  if (params.get('story')) {
    const step = Math.max(0, STORY.findIndex((s) => s.year === state.year));
    startStory(params.get('autoplay') === '1', step);
  } else {
    if (isLang() && params.get('view') !== 'home') { globe.pointOfView(EUROPE, 0); rescale(); }
    await render();
    preload();
    if (params.get('place')) openPlace(params.get('place'));
  }
  window.__app = { state, globe, render, setYear, startStory, openPlace, openArticle, ready: () => renderSeq > 0 };
})();
