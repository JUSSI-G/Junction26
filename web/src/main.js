import Globe from 'globe.gl';
import { HISTORICAL } from './historical.js';

// ------------------------------------------------------------------ state
const YEARS = Array.from({ length: 23 }, (_, i) => 2004 + i);
const STORY_PAGE = 1150;
const STORY = [
  { year: 2005, text: 'A young article grows fast. Editors link the first towns and battlefields of the 1918 civil war.' },
  { year: 2010, text: 'Six years in, the article links 64 places. The war now reaches Brest-Litovsk, Berlin and St Petersburg.' },
  { year: 2014, text: 'One edit on 11 Feb 2014 moves the story from towns to prison camps: Tampere and Suomenlinna out, five camps in.' },
  { year: 2018, text: 'The centenary. A hundred places are linked, and small battles have articles of their own.' },
  { year: 2026, text: 'Today: 104 places, and the story is still being rewritten.' },
];
const params = new URLSearchParams(location.search);
const state = {
  year: +params.get('year') || 2004,
  metric: params.get('metric') || 'knowledge',
  playing: false,
  story: null,          // index into STORY, or null
  sqlTab: 'heat',
  panelSql: null,
};
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
function arcKey() { return state.story !== null ? `p${STORY_PAGE}` : 'all'; }
async function getHeat(metric, year) {
  const m = (cache.heat[metric] ||= {});
  return (m[year] ||= api(`/api/heat?year=${year}&metric=${metric}`));
}
async function getArcs(key, year) {
  const m = (cache.arcs[key] ||= {});
  const page = key === 'all' ? '' : `&page=${key.slice(1)}`;
  return (m[year] ||= api(`/api/arcs?year=${year}&limit=${key === 'all' ? 500 : 2000}${page}`));
}

// Preload every year for the current metric and arc set, a few requests at a time.
let preloadRun = 0;
async function preload() {
  const run = ++preloadRun;
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
  .pointAltitude((d) => 0.007 + 0.012 * d.t)
  .pointRadius((d) => 0.1 + 0.4 * d.t)
  .pointColor((d) => rgba(ramp(POINT_RAMP, 0.15 + 0.85 * d.t), 0.7 + 0.28 * d.t))
  .pointLabel((d) => `<div class="tip"><b>${esc(d.title)}</b><br><span class="k">${esc(d.kind || d.category)}</span><br>${esc(state.metric)}: <b>${fmt(d.value)}</b></div>`)
  .onPointClick((d) => openPlace(d.title))
  // place names: DOM labels (crisp, full Finnish alphabet), decluttered in render()
  .htmlLat('lat').htmlLng('lon').htmlAltitude(0.02)
  .htmlTransitionDuration(0)
  .htmlElement((d) => {
    const el = document.createElement('div');
    el.className = `place-label${d.changed ? ` ${d.changed}` : ''}`;
    el.textContent = d.title;
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
    const a = d.status === 'same' ? (d.origin_inferred ? 0.06 : 0.14) : (d.origin_inferred ? 0.3 : 0.95);
    return [rgba(ARC[d.status], a * 0.55), rgba(ARC[d.status], a)];
  })
  .arcStroke((d) => (d.status === 'same' ? 0.04 : (d.origin_inferred ? 0.09 : 0.14) + 0.04 * Math.min(3, d.weight)))
  .arcAltitudeAutoScale(0.24)
  .arcDashLength((d) => (d.status === 'same' ? 1 : d.status === 'added' ? 0.55 : 0.25))
  .arcDashGap((d) => (d.status === 'same' ? 0 : d.status === 'added' ? 0.25 : 0.2))
  .arcDashAnimateTime((d) => (d.status === 'same' ? 0 : d.status === 'added' ? 2200 : 3600))
  .arcsTransitionDuration(0)
  .arcLabel((d) => {
    const word = { added: '+ link added', removed: '− link removed', same: 'unchanged link' }[d.status];
    const arts = d.articles.slice(0, 6).map((a) => esc(a.title)).join('<br>');
    const more = d.articles.length > 6 ? `<br><span class="k">+ ${d.articles.length - 6} more</span>` : '';
    return `<div class="tip"><span class="s-${d.status}">${word}</span> in ${state.year}<br>
      <b>${esc(d.from.title)} → ${esc(d.to.title)}</b>${d.origin_inferred ? '<br><span class="k">origin inferred</span>' : ''}
      <br><span class="k">article${d.articles.length > 1 ? 's' : ''}:</span><br>${arts}${more}</div>`;
  })
  .onArcClick((d) => openArticle(d.articles[0].page_id));

const HOME = { lat: 59, lng: 24, altitude: 0.95 };
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
  $('legend-metric').textContent = metric[0].toUpperCase() + metric.slice(1);

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
      ? `<div class="tip"><b>${esc(f.properties.name)}</b><br>${esc(metric)}: <b>${fmt(t.value)}</b><br><span class="k">${t.places.slice(0, 5).map((p) => `${esc(p.title)} ${fmt(p.value)}`).join('<br>')}</span></div>`
      : '';
  }
  globe.polygonCapColor((f) => (f.__t === null ? 'rgba(20,27,42,0.72)' : rgba(ramp(COUNTRY_RAMP, f.__t), 0.62 + 0.2 * f.__t)));
  globe.polygonsData(countryFeatures);

  // places (top 1500 keeps the scene light at full scale)
  const points = heat.data.filter((d) => !polygonQid(d)).slice(0, 1500)
    .map((d) => ({ ...d, t: Math.sqrt(d.value / mx.point) }));
  globe.pointsData(points);
  let labels = points;

  // arcs
  globe.arcsData(arcs.data);
  const n = { added: 0, removed: 0, same: 0 };
  for (const a of arcs.data) n[a.status]++;
  for (const k of Object.keys(n)) $(`n-${k}`).textContent = fmt(n[k]);
  if (state.story !== null) {
    // In story mode, name the places the article's links changed to this year.
    const changed = arcs.data.filter((a) => a.status !== 'same')
      .sort((a, b) => (a.status === 'removed' ? 0 : 1) - (b.status === 'removed' ? 0 : 1))
      .map((a) => ({ ...a.to, value: a.status === 'added' ? 2 : 1, changed: a.status }));
    labels = changed;
    $('story-counts').textContent = `${year}: ${n.added} place links added, ${n.removed} removed, ${n.same} unchanged`;
  }

  labelPool = labels;
  placeLabels();

  lastSql.heat = heat; lastSql.arcs = arcs;
  renderSql();
}

// Place names: strongest first, skipping any that would sit on top of one already shown.
let labelPool = [];
function placeLabels() {
  const alt = globe.pointOfView().altitude;
  const story = state.story !== null;
  const minDeg = Math.max(0.3, (story ? 1.3 : 2.4) * alt), max = story ? 22 : 16, shown = [];
  const sel = panelView?.type === 'place' ? labelPool.find((d) => d.title === panelView.title) : null;
  for (const d of sel ? [sel, ...labelPool] : labelPool) {
    if (d === sel && shown.length) continue;
    if (shown.length >= max) break;
    const cos = Math.cos((d.lat * Math.PI) / 180);
    if (shown.some((o) => Math.abs(o.lat - d.lat) < minDeg * 0.45 && Math.abs(o.lon - d.lon) * cos < minDeg)) continue;
    shown.push(d);
  }
  globe.htmlElementsData(shown);
}
globe.controls().addEventListener('end', placeLabels);

// ------------------------------------------------------------------ SQL drawer
const lastSql = { heat: null, arcs: null };
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
    text = `-- Arcs for ${state.year} (${ms} ms)\n${lastSql.arcs.sql}`;
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
  if (fly) globe.pointOfView({ lat: p.lat, lng: p.lon, altitude: p.is_country ? 0.9 : 0.42 }, 1200);
  setTimeout(placeLabels, 1300);
  const located = res.data.filter((r) => r.relation === 'located here');
  const linking = res.data.filter((r) => r.relation === 'links here');
  const item = (r) => `<li data-page="${r.page_id}"><span class="t">${esc(r.title)}</span><span class="m">${
    r.mentions ? `${r.mentions}× · ` : ''}${fmt(Math.round(r.len / 1000))} KB</span></li>`;
  const sib = (siblings || []).filter((s) => s.title !== title);
  showPanel(`
    <h2>${esc(p.title)}</h2>
    <p class="sub">${esc(p.kind || p.category)} · as of ${dateLabel()}</p>
    ${sib.length ? `<div class="chips">${sib.slice(0, 8).map((s) => `<button class="chip" data-place="${esc(s.title)}">${esc(s.title)}</button>`).join('')}</div>` : ''}
    ${located.length ? `<h3>Articles located here</h3><ul class="article-list">${located.map(item).join('')}</ul>` : ''}
    <h3>${linking.length} article${linking.length === 1 ? '' : 's'} linking here</h3>
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
  state.metric = b.dataset.metric;
  render();
  preload();
}));

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
  globe.pointOfView({ lat: 60.5, lng: 22, altitude: 0.78 }, 1400);
  storyStep(step);
  preload();
  if (autoplay) play(true);
}
function exitStory(rerender = true) {
  play(false);
  state.story = null;
  $('story-card').hidden = true;
  $('story-btn').hidden = false;
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
  if (params.get('sql')) $('sql-drawer').classList.remove('closed');
  if (params.get('story')) {
    const step = Math.max(0, STORY.findIndex((s) => s.year === state.year));
    startStory(params.get('autoplay') === '1', step);
  } else {
    await render();
    preload();
    if (params.get('place')) openPlace(params.get('place'));
  }
  window.__app = { state, globe, render, setYear, startStory, openPlace, openArticle, ready: () => renderSeq > 0 };
})();
