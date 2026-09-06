import { esc, nodesById, openPage } from './util.js'
import { buildWorld } from './world.js'
import { makeSound } from './sound.js'
import { wireHud } from './hud.js'
import { makeWalk } from './walk.js'
import { makeJourney } from './journey.js'

// wiki-plugin-hear — walk a page-level GMap as a street and hear its pages speak.
//
// Item text is a small DSL (UPPERCASE command, then data):
//   MAP    https://…/map.json                 the page-level GMap (World Format)
//   MEDIA  https://…/street-media.json        which houses speak, and where their clips are
//   POLICY https://…/soundscape-policy.json   the mixing rules: budget, deadband, crossfade
//   STREET clause.legalcommons.org/right-to-amparo   the square (defaults to map.street.square)
//   HEIGHT 520                                 pixels
//   MODULE https://…/voice-chain.js           an ES module exporting createVoiceChain(ctx, voice, policy): per-voice DSP between the murmur filter and the bus
//   MIX    solo es | pair es pt | polyphonic | native   which languages sound (Multilingual Mixes; overrides the policy)
//   JOURNEY https://…/journey.json           a cue sheet of language zones: the Fly button carries you through them
//
// Geometry is built from map.json in code: regions extruded, houses as instanced
// boxes sized by story length, the square a plaza, roads from the edges.  No
// Blender and no glTF in the loop.  Sound is Web Audio through three.js: a
// listener on the camera, positional emitters only for the active budget, the
// policy deciding who is intelligible, a deadband and an equal-power crossfade
// so voices do not flicker, a consent gate before anything sounds.

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js'
let stylesInjected = false

// ------------------------------------------------------------------ DSL
export const parseText = text => {
  const spec = { map: '', media: '', policy: '', street: '', module: '', journey: '', mix: null, height: 520, caption: [] }
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^([A-Z]+):?\s+(.*)$/)
    if (!m) { spec.caption.push(line); continue }
    const [, cmd, val] = m
    if (cmd === 'MAP') spec.map = val
    else if (cmd === 'MEDIA') spec.media = val
    else if (cmd === 'POLICY') spec.policy = val
    else if (cmd === 'STREET') spec.street = val
    else if (cmd === 'MODULE') spec.module = val
    else if (cmd === 'JOURNEY') spec.journey = val
    else if (cmd === 'MIX') { const [mode, ...langs] = val.split(/\s+/); spec.mix = { mode: mode.toLowerCase(), languages: langs.map(l => l.toLowerCase()) } }
    else if (cmd === 'HEIGHT') spec.height = Math.max(240, parseInt(val, 10) || 520)
    else spec.caption.push(line)
  }
  return spec
}

const DEFAULT_POLICY = {
  max_active_emitters: 8, max_intelligible_speech: 2, focus_duck_db: -14, crossfade_ms: 900,
  hysteresis: { deadband: 0.08, min_dwell_ms: 900 },
  selection_weights: { proximity: 0.4, explicit_focus: 0.25, journey_relevance: 0.15, view_direction: 0.1, semantic_relevance: 0.1 },
  buses: ['human_speech', 'synthetic_speech', 'ambience', 'ui'],
  mix: 'native', languages: [], per_language_intelligible: 1
}



// ------------------------------------------------------------------ styles
const ensureStyle = () => {
  if (stylesInjected) return
  stylesInjected = true
  const css = `
.hear-shell{position:relative;background:#0d1219;color:#e8eef4;border-radius:8px;overflow:hidden;font:13px/1.4 -apple-system,Helvetica,Arial,sans-serif}
.hear-stage{position:absolute;inset:0}
.hear-stage canvas{display:block;width:100%;height:100%}
.hear-gate[hidden],.hear-hud[hidden]{display:none}
.hear-gate{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(9,13,20,.86);z-index:5;text-align:center;padding:24px}
.hear-gate h3{margin:0;font-size:18px;font-weight:600}
.hear-gate p{margin:0;max-width:420px;color:#b8c4cf}
.hear-gate button{font-size:15px;padding:10px 18px;border-radius:6px;border:0;background:#e0a44f;color:#1a1208;cursor:pointer}
.hear-gate .hear-quiet{background:transparent;color:#b8c4cf;border:1px solid #3a4652;font-size:13px}
.hear-hud{position:absolute;left:8px;top:8px;right:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;z-index:3;pointer-events:none}
.hear-hud>*{pointer-events:auto}
.hear-hud button,.hear-hud select{font-size:12px;padding:4px 8px;border-radius:5px;border:1px solid #3a4652;background:rgba(20,27,36,.9);color:#e8eef4;cursor:pointer}
.hear-hud button.on{background:#e0a44f;color:#1a1208;border-color:#e0a44f}
.hear-hud label{font-size:11px;color:#b8c4cf;display:flex;align-items:center;gap:4px;background:rgba(20,27,36,.9);padding:3px 6px;border-radius:5px}
.hear-hud input[type=range]{width:64px}
.hear-hud .hear-pad{display:inline-flex;gap:2px;margin-left:auto}
.hear-hud button.hear-close{font-weight:600;padding:4px 9px}
.hear-panel .hear-panel-close{float:right;font-size:12px;line-height:1;padding:2px 6px;border-radius:4px;border:1px solid #3a4652;background:#1a2330;color:#e8eef4;cursor:pointer;margin:-2px -4px 0 6px}
.hear-hud .hear-pad button{padding:4px 7px;user-select:none;-webkit-user-select:none;touch-action:none}
.hear-hud .hear-pad button.on{background:#e0a44f;color:#1a1208}
.hear-shell:fullscreen{width:100vw;height:100vh!important;border-radius:0}
.hear-shell:fullscreen .hear-panel{width:min(34%,420px);max-height:70%}
.hear-shell:fullscreen .hear-trial{left:20%;right:20%}
.hear-status{position:absolute;left:8px;bottom:8px;z-index:3;font-size:11px;color:#b8c4cf;background:rgba(20,27,36,.85);padding:4px 8px;border-radius:5px;max-width:70%}
.hear-panel{position:absolute;right:8px;bottom:8px;width:min(46%,320px);max-height:62%;overflow:auto;z-index:4;background:rgba(14,20,28,.94);border:1px solid #2c3743;border-radius:7px;padding:10px 12px}
.hear-panel h4{margin:0 0 4px;font-size:14px}
.hear-panel .hear-role{font-size:11px;color:#e0a44f;letter-spacing:.04em;text-transform:uppercase}
.hear-panel .hear-cues p{margin:3px 0;color:#94a3b1}
.hear-panel .hear-cues p.now{color:#fff}
.hear-panel .hear-prov{font-size:11px;color:#b8c4cf;border-top:1px solid #2c3743;margin-top:8px;padding-top:6px}
.hear-panel .hear-prov b{color:#e8eef4}
.hear-panel .hear-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.hear-panel .hear-actions button{font-size:12px;padding:4px 8px;border-radius:5px;border:1px solid #3a4652;background:#1a2330;color:#e8eef4;cursor:pointer}
.hear-panel .hear-actions button.primary{background:#e0a44f;color:#1a1208;border-color:#e0a44f}
.hear-inside{position:absolute;inset:0;z-index:6;background:rgba(10,14,20,.97);overflow:auto;padding:16px 18px}
.hear-inside .hear-close{position:sticky;top:0;float:right;font-size:12px;padding:4px 8px;border-radius:5px;border:1px solid #3a4652;background:#1a2330;color:#e8eef4;cursor:pointer}
.hear-inside .hear-page{max-width:560px;color:#d5dde5}
.hear-inside .hear-page h2{margin:0 0 8px;font-size:20px}
.hear-inside .hear-page p{margin:0 0 8px}
.hear-inside .hear-page blockquote{border-left:3px solid #e0a44f;margin:8px 0;padding:2px 10px;color:#f0f4f8}
.hear-inside audio{width:100%;margin:8px 0}
.hear-list{padding:10px 12px}
.hear-list li{margin:4px 0}
.hear-list a{color:#e0a44f}
.hear-hint{position:absolute;left:50%;top:44px;transform:translateX(-50%);z-index:3;font-size:11px;color:#b8c4cf;background:rgba(20,27,36,.8);padding:3px 8px;border-radius:5px;pointer-events:none}
.hear-caption{font-style:italic;color:#666;margin:6px 0 0}
.hear-trial{position:absolute;left:8px;right:8px;top:44px;z-index:7;background:rgba(14,20,28,.96);border:1px solid #e0a44f;border-radius:7px;padding:10px 12px;max-height:70%;overflow:auto}
.hear-trial h4{margin:0 0 6px;font-size:14px;color:#e0a44f}
.hear-trial .hear-q{font-size:15px;margin:4px 0 8px}
.hear-trial .hear-opts{display:flex;flex-wrap:wrap;gap:6px}
.hear-trial button{font-size:12px;padding:5px 9px;border-radius:5px;border:1px solid #3a4652;background:#1a2330;color:#e8eef4;cursor:pointer}
.hear-trial button.primary{background:#e0a44f;color:#1a1208;border-color:#e0a44f}
.hear-trial textarea{width:100%;min-height:48px;background:#0d1219;color:#e8eef4;border:1px solid #3a4652;border-radius:5px;margin:6px 0}
.hear-trial pre{font-size:10px;white-space:pre-wrap;color:#b8c4cf;max-height:180px;overflow:auto;background:#0d1219;padding:6px;border-radius:5px}
.hear-trial .hear-timer{float:right;color:#94a3b1;font-size:12px}
`
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}

// ------------------------------------------------------------------ shell
const shellHtml = spec => `
<div class="hear-shell" style="height:${spec.height}px">
  <div class="hear-stage"></div>
  <div class="hear-hud" hidden>
    <button data-act="mute" title="Mute everything">Mute</button>
    <button data-act="pause" title="Pause the voices, keep the place">Pause voices</button>
    <label>human <input type="range" data-bus="human_speech" min="0" max="100" value="100"></label>
    <label>synthetic <input type="range" data-bus="synthetic_speech" min="0" max="100" value="100"></label>
    <select data-act="solo"><option value="">Solo a house…</option></select>
    <select data-act="mix" title="The mix: which languages sound"><option value="native">Mix: native</option></select>
    <button data-act="fly" hidden title="Fly the language zones of the journey">Fly</button>
    <button data-act="above" title="Back above the street">Above</button>
    <button data-act="walk" title="Be carried round the street: each house speaks its clause from the top when you arrive">Walk</button>
    <button data-act="next" title="On to the next house">Next</button>
    <button data-act="trial" title="The One Audible Street questions: four short tasks, results you can copy">Listening trial</button>
    <button data-act="full" title="Full screen (F); Esc leaves">Full screen</button>
    <span class="hear-pad" title="Walk: hold a key, or W A S D on the keyboard"><button data-key="a">◀</button><button data-key="w">▲</button><button data-key="s">▼</button><button data-key="d">▶</button><button data-key="q">↑</button><button data-key="e">↓</button></span>
    <button data-act="close" class="hear-close" title="Close: back to the beginning, silent, the gate up">✕ Close</button>
  </div>
  <div class="hear-trial" hidden></div>
  <div class="hear-hint" hidden>drag to look · W A S D to walk · Q E up down · click a house · Walk to be carried</div>
  <div class="hear-status" hidden></div>
  <div class="hear-panel" hidden></div>
  <div class="hear-gate">
    <h3>Hear Crowds</h3>
    <p>A street of pages that speak. Nothing sounds until you enter; the voices are readings of constitutional text, most of them synthetic and labelled so.</p>
    <button data-act="enter">Enter the soundscape</button>
    <button data-act="quiet" class="hear-quiet">Walk it silently</button>
  </div>
</div>`

const captionHtml = spec => spec.caption.length ? `<p class="hear-caption">${esc(spec.caption.join(' '))}</p>` : ''

export const emit = (div, item) => {
  ensureStyle()
  const spec = parseText(item.text)
  div.html(shellHtml(spec) + captionHtml(spec))
}

export const bind = (div, item) => {
  const spec = parseText(item.text)
  const root = div.find('.hear-shell')[0]
  div.on('dblclick', e => {
    if (e.target.closest('button,input,select,canvas,audio,a,.hear-panel,.hear-inside')) return
    if (window.wiki?.textEditor) window.wiki.textEditor(div, item)
  })
  if (root) start(root, spec, div).catch(err => {
    setStatus(root, `Could not start: ${err.message}`)
    const gate = root.querySelector('.hear-gate')
    if (gate) gate.innerHTML = `<h3>Hear Crowds</h3><p>The place could not load: ${esc(err.message)}. Check the MAP line.</p>`
  })
}

export const dispose = (div) => {
  const root = div.find('.hear-shell')[0]
  if (root && root._hear) root._hear.dispose()
}

const setStatus = (root, text) => {
  const el = root.querySelector('.hear-status')
  if (!el) return
  el.hidden = false
  el.textContent = text
}

// ------------------------------------------------------------------ data
const fetchJson = async url => {
  const r = await fetch(url, { mode: 'cors' })
  if (!r.ok) throw new Error(`${r.status} for ${url}`)
  return r.json()
}

const webglAvailable = () => {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch { return false }
}

// ------------------------------------------------------------------ start
async function start (root, spec, div) {
  if (!spec.map) { setStatus(root, 'Give a MAP line: the URL of a map.json.'); return }
  setStatus(root, 'Loading the map…')
  const [map, media, policyRaw, journey] = await Promise.all([
    fetchJson(spec.map),
    spec.media ? fetchJson(spec.media).catch(() => null) : null,
    spec.policy ? fetchJson(spec.policy).catch(() => null) : null,
    spec.journey ? fetchJson(spec.journey).catch(() => null) : null
  ])
  const policy = Object.assign({}, DEFAULT_POLICY, policyRaw || {})
  policy.hysteresis = Object.assign({}, DEFAULT_POLICY.hysteresis, policy.hysteresis || {})
  policy.selection_weights = Object.assign({}, DEFAULT_POLICY.selection_weights, policy.selection_weights || {})
  if (policy.hysteresis.min_dwell_ms < policy.crossfade_ms) policy.hysteresis.min_dwell_ms = policy.crossfade_ms
  if (spec.mix) { policy.mix = spec.mix.mode; policy.languages = spec.mix.languages }   // the item's MIX line beats the policy file

  const squareId = spec.street || map.street?.square || ''
  const nodesById = new Map(map.nodes.map(n => [n.id, n]))
  // the media index names houses by slug (and site, from the manifest URL); resolve each to a map node
  const speakers = []
  for (const h of [...(media?.houses || []), ...(media?.extras || [])]) {
    const site = h.id?.split('/')[0] || (h.manifest || '').replace(/^https?:\/\//, '').split('/')[0]
    const id = h.id || `${site}/${h.slug}`
    const n = nodesById.get(id) || map.nodes.find(x => x.slug === h.slug)
    if (n) speakers.push({ ...h, id: n.id, site: n.site, degree: n.degree || 0, district: n.district || null })
  }

  if (!webglAvailable()) { renderList(root, map, speakers, squareId, div); return }
  let three
  try { three = await import(THREE_URL) } catch (e) { setStatus(root, `Three.js did not load (${e.message}); showing the list.`); renderList(root, map, speakers, squareId, div); return }

  let chainFactory = null
  if (spec.module) {
    try { chainFactory = (await import(spec.module)).createVoiceChain || null } catch (e) { setStatus(root, `Voice module did not load (${e.message}); voices use the plain chain.`) }
  }
  const world = buildWorld(three, root, map, speakers, squareId)
  const sound = makeSound(three, world, speakers, policy, root, chainFactory)
  const walk = makeWalk(world, sound, speakers, map)
  const flight = journey ? makeJourney(world, sound, speakers, map, journey) : null
  wireHud(root, world, sound, speakers, map, div, walk, flight)
  const natives = speakers.filter(s => s.native).length
  root._hearBaseStatus = `${map.nodes.length} pages · ${map.regions.length} regions · ${speakers.length} voices, ${natives} in their own language · policy ${policyRaw?.policy_id || 'default'} · mix ${policy.mix}${policy.languages?.length ? ' ' + policy.languages.join(' ') : ''}`
  setStatus(root, root._hearBaseStatus)

  root.querySelector('[data-act="enter"]').addEventListener('click', async () => {
    await sound.enable()   // after a Close this only lifts the hold
    closeGate(root)
  })
  root.querySelector('[data-act="quiet"]').addEventListener('click', () => { if (sound.enabled) sound.silence(); closeGate(root) })
  root._hear = { world, sound, walk, flight, speakers, policy, dispose: () => { flight?.dispose(); walk.dispose(); world.dispose(); sound.dispose() } }
}

const closeGate = root => {
  root.querySelector('.hear-gate').hidden = true
  root.querySelector('.hear-hud').hidden = false
  root.querySelector('.hear-hint').hidden = false
  setTimeout(() => { const h = root.querySelector('.hear-hint'); if (h) h.hidden = true }, 6000)
}

// ------------------------------------------------------------------ list fallback
function renderList (root, map, speakers, squareId, div) {
  const sq = map.nodes.find(n => n.id === squareId)
  const houses = speakers.map(s => `<li><a href="#" data-page="${esc(s.title)}" data-site="${esc(s.id.split('/')[0])}">${esc(s.title)}</a> — ${esc(s.heading || '')} (${esc(s.voice || '')})<br><audio controls preload="none" src="${esc(s.audio)}"></audio></li>`).join('')
  root.innerHTML = `<div class="hear-list"><p>No WebGL here, so the street is a list. The square is <b>${esc(sq?.title || squareId)}</b>; its houses speak below.</p><ul>${houses}</ul></div>`
  root.querySelectorAll('a[data-page]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); openPage(div, a.dataset.page, a.dataset.site) }))
}

if (typeof window !== 'undefined') {
  window.plugins = window.plugins || {}
  window.plugins.hear = { emit, bind, dispose }
}
