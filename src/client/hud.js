// hud.js — the bar, the panel, the interior and the listening trial
import { esc, short, openPage } from './util.js'

// ------------------------------------------------------------------ HUD, panel, interior
export function wireHud (root, world, sound, speakers, map, div, walk, flight = null) {
  const hud = root.querySelector('.hear-hud')
  const panel = root.querySelector('.hear-panel')
  const solo = hud.querySelector('[data-act="solo"]')
  const groups = new Map()
  for (const s of speakers) { const k = s.district || s.site; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s) }
  for (const [k, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const og = document.createElement('optgroup'); og.label = `${k} (${list.length})`
    for (const s of list.sort((a, b) => a.title.localeCompare(b.title))) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.title; og.appendChild(o) }
    solo.appendChild(og)
  }
  const bMute = hud.querySelector('[data-act="mute"]'), bPause = hud.querySelector('[data-act="pause"]')
  bMute.addEventListener('click', () => { const on = !bMute.classList.contains('on'); bMute.classList.toggle('on', on); sound.mute(on) })
  bPause.addEventListener('click', () => { const on = !bPause.classList.contains('on'); bPause.classList.toggle('on', on); sound.pause(on) })
  hud.querySelectorAll('input[data-bus]').forEach(r => r.addEventListener('input', () => sound.bus(r.dataset.bus, r.value / 100)))
  hud.querySelector('[data-act="above"]').addEventListener('click', () => { walk.stop(); world.above(); sound.focus(null); panel.hidden = true })
  // Walk: the walker carries you round the street; Next skips to the next house; a walking key or Above ends it
  const bWalk = hud.querySelector('[data-act="walk"]')
  bWalk.addEventListener('click', () => { if (walk.state.on) walk.stop(); else walk.start() })
  hud.querySelector('[data-act="next"]').addEventListener('click', () => walk.next())
  walk.onLeg = () => { bWalk.classList.add('on'); bWalk.textContent = 'Stop walking' }
  walk.onArrive = s => showPanel(s)
  walk.onStop = () => { bWalk.classList.remove('on'); bWalk.textContent = 'Walk' }
  // Close: back to the beginning state — outside, silent, the gate up; the voices and the place are kept for the next Enter
  const reset = () => {
    walk.stop(); flight?.stop(); root._hearTrial?.abort?.()
    root.querySelector('.hear-inside')?.remove(); sound.leave()
    panel.hidden = true; clearInterval(cueTimer)
    if (sound.enabled) sound.silence()
    world.ctl.keys.clear(); world.above()
    hud.hidden = true; root.querySelector('.hear-trial').hidden = true
    const st = root.querySelector('.hear-status'); if (st) st.textContent = root._hearBaseStatus || ''
    root.querySelector('.hear-gate').hidden = false
    bMute.classList.remove('on'); bPause.classList.remove('on'); sound.mute(false); sound.pause(false)
  }
  hud.querySelector('[data-act="close"]').addEventListener('click', reset)
  solo.addEventListener('change', () => { if (solo.value) goTo(solo.value) })
  // the mix selector: native, polyphonic, a solo per language the city can speak, and pairs of the two most spoken
  const mixSel = hud.querySelector('[data-act="mix"]')
  const langs = [...sound.languages().entries()].filter(([l]) => l !== 'en').sort((a, b) => b[1] - a[1])
  const NAMES = { es: 'Spanish', ar: 'Arabic', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', ja: 'Japanese', zh: 'Chinese' }
  const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; mixSel.appendChild(o) }
  opt('polyphonic', 'Mix: polyphonic, every language')
  for (const [l, n] of langs) opt(`solo ${l}`, `Mix: ${NAMES[l] || l} only (${n})`)
  for (let i = 0; i < langs.length; i++) for (let j = i + 1; j < Math.min(langs.length, 3); j++) opt(`pair ${langs[i][0]} ${langs[j][0]}`, `Mix: ${NAMES[langs[i][0]] || langs[i][0]} with ${NAMES[langs[j][0]] || langs[j][0]}`)
  const mixValue = () => { const m = sound.mix; return m.mode === 'native' ? 'native' : m.mode === 'polyphonic' ? 'polyphonic' : `${m.mode} ${m.languages.join(' ')}` }
  if (![...mixSel.options].some(o => o.value === mixValue())) opt(mixValue(), `Mix: ${mixValue()}`)
  mixSel.value = mixValue()
  mixSel.addEventListener('change', () => { const [mode, ...ls] = mixSel.value.split(' '); sound.setMix(mode, ls); flight?.stop() })
  // Fly: the journey's language zones, if the item gave one
  const bFly = hud.querySelector('[data-act="fly"]')
  if (flight) {
    bFly.hidden = false
    bFly.addEventListener('click', () => { if (flight.state.on) flight.stop(); else { walk.stop(); flight.start() } })
    flight.onZone = (z, i) => { bFly.classList.add('on'); bFly.textContent = `Zone ${i + 1}: ${z.mix}${z.languages?.length ? ' ' + z.languages.join(' ') : ''}`; mixSel.value = mixValue(); panel.hidden = true }
    flight.onArrive = s => showPanel(s)
    flight.onStop = () => { bFly.classList.remove('on'); bFly.textContent = 'Fly'; if (quiz.on) finishQuiz() }
    // the multilingual listening trial: Fly with questions — after each zone, which languages did you hear, and did it feel like one place
    const bQuiz = document.createElement('button'); bQuiz.dataset.act = 'flytrial'; bQuiz.title = 'Fly the journey and answer two questions after each zone'; bQuiz.textContent = 'Fly + questions'
    bFly.after(bQuiz)
    const tbox = root.querySelector('.hear-trial')
    const NAMES2 = { es: 'Spanish', ar: 'Arabic', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', en: 'English' }
    const quiz = { on: false, answers: [], listener: '' }
    const askZone = (z, i, rec) => new Promise(resolve => {
      const langs = [...new Set([...sound.languages().keys()])].sort()
      const picked = new Set()
      tbox.hidden = false
      tbox.innerHTML = `<h4>Zone ${i + 1} of ${flight.zones.length}: ${esc(z.name)}</h4><div class="hear-q">Which languages did you hear? (tap all that apply)</div><div class="hear-opts">${langs.map(l => `<button data-l="${esc(l)}">${esc(NAMES2[l] || l)}</button>`).join('')}</div><div class="hear-q" style="margin-top:8px">Did that zone feel like one place, a quarter of the city?</div><div class="hear-opts"><button data-p="yes">Yes, one place</button><button data-p="mixed">Mixed</button><button data-p="no">No, scattered</button></div>`
      tbox.querySelectorAll('button[data-l]').forEach(b => b.addEventListener('click', () => { const l = b.dataset.l; if (picked.has(l)) { picked.delete(l); b.classList.remove('on') } else { picked.add(l); b.classList.add('on') } }))
      tbox.querySelectorAll('button[data-p]').forEach(b => b.addEventListener('click', () => {
        const truth = Object.keys(rec?.heard || {}).sort()
        quiz.answers.push({ zone: i + 1, name: z.name, mix: z.mix, languages_set: z.languages, heard_by_machine: truth, named: [...picked].sort(), correct: [...picked].sort().join(',') === truth.join(','), place: b.dataset.p })
        tbox.hidden = true; resolve()
      }))
    })
    const finishQuiz = () => {
      quiz.on = false; flight.onZoneEnd = null
      const result = { listener: quiz.listener || 'listener', kind: 'multilingual flight trial', started: quiz.started, finished: new Date().toISOString(), policy_id: sound.policy.policy_id || 'default', journey: flight.zones.length, zones: quiz.answers,
        summary: { zones_named_correctly: quiz.answers.filter(a => a.correct).length + ' of ' + quiz.answers.length, pure_zones_read_as_place: quiz.answers.filter(a => a.mix === 'solo' && a.place === 'yes').length + ' of ' + quiz.answers.filter(a => a.mix === 'solo').length } }
      try { const all = JSON.parse(localStorage.getItem('hear-flight-trials') || '[]'); all.push(result); localStorage.setItem('hear-flight-trials', JSON.stringify(all.slice(-20))) } catch {}
      tbox.hidden = false
      tbox.innerHTML = `<h4>Your flight</h4><div class="hear-q">Zones named correctly: ${result.summary.zones_named_correctly}. Pure zones that felt like one place: ${result.summary.pure_zones_read_as_place}.<br>Copy the record onto the Multilingual Listening Trial page.</div><pre>${esc(JSON.stringify(result))}</pre><div class="hear-opts"><button data-act="copy" class="primary">Copy JSON</button><button data-act="close">Close</button></div>`
      tbox.querySelector('[data-act="copy"]').addEventListener('click', () => navigator.clipboard?.writeText(JSON.stringify(result)))
      tbox.querySelector('[data-act="close"]').addEventListener('click', () => { tbox.hidden = true })
      root._hearFlightTrial = result
    }
    bQuiz.addEventListener('click', () => {
      if (!sound.enabled) { tbox.hidden = false; tbox.innerHTML = '<h4>Fly + questions</h4><div class="hear-q">Enter the soundscape first: the questions are about what you hear.</div><div class="hear-opts"><button data-act="close">OK</button></div>'; tbox.querySelector('[data-act="close"]').addEventListener('click', () => { tbox.hidden = true }); return }
      if (flight.state.on) { flight.stop(); return }
      quiz.on = true; quiz.answers = []; quiz.started = new Date().toISOString(); flight.onZoneEnd = askZone
      walk.stop(); flight.start()
    })
  }

  const manifests = new Map()
  const manifestOf = async s => {
    if (!manifests.has(s.id)) manifests.set(s.id, fetch(s.manifest, { mode: 'cors' }).then(r => r.json()).catch(() => null))
    return manifests.get(s.id)
  }

  const goTo = id => {
    const s = speakers.find(x => x.id === id)
    walk.stop(); world.threshold(id)
    if (sound.enabled) sound.listen(id); else sound.focus(id)   // from the top: the transcript starts at its first cue
    if (s) showPanel(s)
  }
  world.onPick = n => {
    const s = speakers.find(x => x.id === n.id)
    if (s) goTo(s.id)
    else { openPage(div, n.title, n.site) }
  }

  let panelId = null, cueTimer = 0
  const showPanel = async s => {
    panelId = s.id
    panel.hidden = false
    const nat = s.native && sound.spokenOf?.(s.id) !== 'en'
    panel.innerHTML = `<button class="hear-panel-close" data-act="dismiss" title="Close the transcript">✕</button><div class="hear-role">${s.role === 'human_reading' ? 'human reading' : 'synthetic voice'} · ${esc(nat ? s.native_voice : s.voice || '')}${nat ? ` · in ${esc(s.language)}` : ''}</div><h4>${esc(s.title)}</h4><div style="color:#94a3b1;font-size:12px">${esc(s.heading || '')} · fragment ${esc(s.fragment_id || '')}${s.district ? ` · district ${esc(s.district)}` : ''}</div><div class="hear-cues"></div><div class="hear-prov">loading provenance…</div><div class="hear-actions"><button data-act="inside" class="primary">Go inside</button><button data-act="open">Open source page</button></div>`
    panel.querySelector('[data-act="open"]').addEventListener('click', () => openPage(div, s.title, s.id.split('/')[0]))
    panel.querySelector('[data-act="dismiss"]').addEventListener('click', () => { panel.hidden = true })
    panel.querySelector('[data-act="inside"]').addEventListener('click', () => enterInterior(s))
    const cues = sound.enabled ? await sound.cues(s.id) : []
    const box = panel.querySelector('.hear-cues')
    box.innerHTML = cues.map((c, i) => `<p data-i="${i}">${esc(c.text)}</p>`).join('') || '<p>Enter the soundscape to follow the transcript.</p>'
    const m = await manifestOf(s); const a = m?.assets?.[0]
    panel.querySelector('.hear-prov').innerHTML = a ? provHtml(m, a) : 'No manifest.'
    clearInterval(cueTimer)
    cueTimer = setInterval(() => {
      if (!root.isConnected) { clearInterval(cueTimer); return }
      if (panel.hidden || panelId !== s.id) return
      const t = sound.currentTime(s.id)
      let current = null
      box.querySelectorAll('p[data-i]').forEach((p, i) => { const on = !!(cues[i] && t >= cues[i].start && t < cues[i].end); p.classList.toggle('now', on); if (on) current = p })
      if (current && current !== panel._cueEl) {   // keep the current cue in view by scrolling the panel only, never the page
        panel._cueEl = current
        const top = current.offsetTop - panel.scrollTop, bottom = top + current.offsetHeight
        if (top < 0 || bottom > panel.clientHeight) panel.scrollTo({ top: current.offsetTop - panel.clientHeight / 2, behavior: 'smooth' })
      }
    }, 250)
  }

  const enterInterior = async s => {
    sound.enter(s.id); world.ctl.mode = 'inside'
    const inside = document.createElement('div'); inside.className = 'hear-inside'
    inside.innerHTML = `<button class="hear-close">Step outside</button><div class="hear-page"><h2>${esc(s.title)}</h2><p style="color:#94a3b1">loading the page…</p></div>`
    root.appendChild(inside)
    inside.querySelector('.hear-close').addEventListener('click', () => { inside.remove(); sound.leave(); world.ctl.mode = 'threshold' })
    const site = s.id.split('/')[0]
    const [page, m] = await Promise.all([fetch(`https://${site}/${s.slug}.json`, { mode: 'cors' }).then(r => r.json()).catch(() => null), manifestOf(s)])
    const a = m?.assets?.[0]
    const body = inside.querySelector('.hear-page')
    const paras = (page?.story || []).filter(it => it.type === 'markdown' && !/^#/.test(it.text || '')).slice(0, 14)
    const frag = paras.find(it => (it.text || '').includes(s.fragment_id))
    body.innerHTML = `<h2>${esc(s.title)}</h2>
      <p style="color:#94a3b1">${esc(s.heading || '')} · ${s.role === 'human_reading' ? 'a human reading' : 'a synthetic voice'} (${esc(s.voice || '')}) · this house on <a href="https://${esc(site)}/view/${esc(s.slug)}" target="_blank" style="color:#e0a44f">${site}</a></p>
      <audio controls crossorigin="anonymous" src="${esc(s.audio)}"></audio>
      ${frag ? `<blockquote>${esc(frag.text.replace(/`[^`]*`\s*[—-]\s*[^\n]*\n\n>?\s*/, '').replace(/^>\s*/gm, ''))}</blockquote>` : ''}
      ${paras.slice(0, 4).map(it => `<p>${esc((it.text || '').replace(/\[\[([^\]]+)\]\]/g, '$1')).slice(0, 700)}</p>`).join('')}
      <div class="hear-prov">${a ? provHtml(m, a) : ''}</div>
      <div class="hear-actions"><button data-act="open" class="primary">Open the page in the wiki</button></div>`
    body.querySelector('[data-act="open"]').addEventListener('click', () => openPage(div, s.title, site))
  }

  sound.onTick = (list, lod, liveNodes) => {
    const st = root.querySelector('.hear-status')
    if (!st) return
    const talking = list.filter(x => x.intelligible).map(x => `${short(x.title)}${x.language && x.language !== 'en' ? ` (${x.language})` : ''}`)
    const m = sound.mix; const mixText = `mix ${m.mode}${m.languages.length ? ' ' + m.languages.join(' ') : ''} · `
    const f = flight?.state; const flying = f?.on ? `flying · zone ${f.zone + 1} ${short(f.zoneName || '')} · ${Math.round(f.remaining)} s · ` : ''

    const w = walk.state
    const going = w.on ? (w.phase === 'leg' ? `walking to ${short(w.target.title)} · ${Math.round(w.remaining)} m · ` : `at ${short(w.target.title)}, listening · `) : ''
    st.textContent = `${flying}${going}${mixText}${lod} scale · ${list.length} of ${speakers.length} voices sounding, ${liveNodes} audio nodes alive · intelligible: ${talking.join(', ') || 'none'}`
  }
  root._hearTrial = wireTrial(root, world, sound, speakers)
}

// ------------------------------------------------------------------ the listening trial
// The One Audible Street questions as four short tasks: isolate a named house
// (time), attribute a clear voice among the crowd (accuracy), a fatigue
// self-report, and whether the sound revealed structure the map hid.  A machine
// listener (auto) walks straight to targets and answers by the policy: the
// geometric floor a human time is read against, never a substitute for one.
function wireTrial (root, world, sound, speakers) {
  const hud = root.querySelector('.hear-hud'), box = root.querySelector('.hear-trial')
  const btn = hud.querySelector('[data-act="trial"]')
  let lastTick = []
  const prevTick = sound.onTick
  sound.onTick = (list, lod, live) => { lastTick = list; prevTick?.(list, lod, live) }
  const distTo = id => { const [x, z] = world.nodePos.get(id); return Math.hypot(x - world.ctl.pos.x, z - world.ctl.pos.z) }
  const nearSquare = () => speakers.filter(s => { const [x, z] = world.nodePos.get(s.id); return Math.hypot(x - world.sqPos[0], z - world.sqPos[1]) < 30 && s.role !== 'human_reading' })
  const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const ask = (title, q, opts, extra = '') => new Promise(resolve => {
    box.hidden = false
    box.innerHTML = `<h4>${esc(title)}<span class="hear-timer"></span></h4><div class="hear-q">${q}</div>${extra}<div class="hear-opts">${opts.map((o, i) => `<button data-i="${i}" class="${o.primary ? 'primary' : ''}">${esc(o.label)}</button>`).join('')}</div>`
    asking = resolve
    box.querySelectorAll('button[data-i]').forEach(b => b.addEventListener('click', () => { root.focus({ preventScroll: true }); asking = null; resolve(opts[+b.dataset.i].value) }))
  })
  const timer = (t0) => { const el = box.querySelector('.hear-timer'); if (el) el.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s` }
  let steering = null, hooked = false, sawFrame = false, pump = 0, aborted = false, asking = null
  const hook = () => {   // the sound engine installs its own frame hook when the gate opens; wrap it at run time, once
    if (!hooked) {
      hooked = true
      const prevFrame = world.onFrame
      world.onFrame = dt => { sawFrame = true; prevFrame?.(dt); if (steering) steering(dt) }
    }
    // a hidden tab gets no animation frames; the machine listener clocks the world itself then
    clearInterval(pump)
    pump = setInterval(() => { if (!sawFrame) { world.ctl.pos.y = Math.max(1.5, world.ctl.pos.y); world.applyCam?.(); world.onFrame?.(0.1) } sawFrame = false }, 100)
  }

  async function isolate (target, auto) {
    world.above(); sound.focus(null)
    const t0 = performance.now(); let gaveUp = false
    box.hidden = false
    box.innerHTML = `<h4>Find a house<span class="hear-timer"></span></h4><div class="hear-q">Walk to the door of <b>${esc(target.title)}</b>. Listen for it; the map does not point.</div><div class="hear-opts"><button data-act="giveup">Give up</button></div>`
    box.querySelector('[data-act="giveup"]').addEventListener('click', () => { gaveUp = true })
    root.focus({ preventScroll: true })
    if (auto) {
      const [tx, tz] = world.nodePos.get(target.id)
      steering = dt => {
        const p = world.ctl.pos; const dx = tx - p.x, dz = tz - p.z; const d = Math.hypot(dx, dz) || 1
        const step = Math.min(d - 3.8, 6 * dt); if (step > 0) { p.x += dx / d * step; p.z += dz / d * step }
        p.y = Math.max(1.7, p.y - 8 * dt); world.lookAtPoint(tx, 1.4, tz)
      }
    }
    while (!gaveUp && !aborted && distTo(target.id) > 4.5) { timer(t0); await wait(100); if (performance.now() - t0 > (auto ? 30000 : 120000)) gaveUp = true }
    steering = null
    return { target: target.slug, title: target.title, seconds: +((performance.now() - t0) / 1000).toFixed(1), gaveUp }
  }
  async function attribute (target, auto) {
    const [tx, tz] = world.nodePos.get(target.id)
    world.ctl.pos.set(world.sqPos[0], 1.7, world.sqPos[1]); world.ctl.mode = 'street'; world.lookAtPoint(tx, 1.4, tz)
    sound.focus(target.id)
    const others = shuffle(speakers.filter(s => s.id !== target.id && s.role !== 'human_reading').sort((a, b) => distTo(a.id) - distTo(b.id)).slice(0, 6)).slice(0, 3)
    const opts = shuffle([target, ...others]).map(s => ({ label: s.title, value: s.slug }))
    const t0 = performance.now()
    let chosen
    if (auto) { await wait(4000); const clear = lastTick.find(x => x.intelligible); chosen = speakers.find(s => s.id === clear?.id)?.slug || null }
    else chosen = await ask('Who is speaking?', 'One voice is clear among the crowd. Which house is it?', opts)
    sound.focus(null)
    return { target: target.slug, title: target.title, chosen, correct: chosen === target.slug, seconds: +((performance.now() - t0) / 1000).toFixed(1), options: opts.map(o => o.value) }
  }
  async function run ({ auto = false, listener = '' } = {}) {
    if (!sound.enabled) { await ask('Listening trial', 'Enter the soundscape first: the trial needs the voices.', [{ label: 'OK', value: 1, primary: true }]); box.hidden = true; return null }
    hook(); aborted = false
    const pool = shuffle(nearSquare())
    if (pool.length < 6) { await ask('Listening trial', 'Not enough speaking houses near the square for a trial.', [{ label: 'OK', value: 1 }]); box.hidden = true; return null }
    const result = { listener: listener || (auto ? 'machine baseline' : 'listener'), auto, started: new Date().toISOString(), policy_id: sound.policy.policy_id || 'default', voices: speakers.length, isolate: [], attribute: [], fatigue: null, structure: null }
    if (!auto) await ask('Listening trial', 'Four short tasks, about five minutes: find three named houses by ear, name three clear voices, then two questions. Headphones help.', [{ label: 'Begin', value: 1, primary: true }])
    for (const t of pool.slice(0, 3)) { if (aborted) return null; result.isolate.push(await isolate(t, auto)) }
    for (const t of pool.slice(3, 6)) { if (aborted) return null; result.attribute.push(await attribute(t, auto)) }
    if (aborted) return null
    world.above()
    if (!auto) {
      result.fatigue = await ask('How tired are your ears?', 'After those six tasks, from 1 (fresh) to 5 (I need silence).', [1, 2, 3, 4, 5].map(n => ({ label: String(n), value: n })))
      const yes = await ask('Did the sound show you anything the map hid?', 'A neighbourhood, a kinship between houses, a house that did not belong where it stood.', [{ label: 'Yes', value: true, primary: true }, { label: 'No', value: false }], '<textarea placeholder="What did you hear? (optional)"></textarea>')
      result.structure = { yes, note: box.querySelector('textarea')?.value || '' }
    }
    clearInterval(pump)
    result.finished = new Date().toISOString()
    result.summary = { isolate_median_s: median(result.isolate.map(r => r.seconds)), gave_up: result.isolate.filter(r => r.gaveUp).length, attribution_correct: result.attribute.filter(r => r.correct).length + ' of ' + result.attribute.length }
    try { const all = JSON.parse(localStorage.getItem('hear-trials') || '[]'); all.push(result); localStorage.setItem('hear-trials', JSON.stringify(all.slice(-20))) } catch {}
    trial.last = result
    box.hidden = false
    box.innerHTML = `<h4>Your results</h4><div class="hear-q">Find: median ${result.summary.isolate_median_s} s, gave up ${result.summary.gave_up}. Attribution: ${result.summary.attribution_correct}. Fatigue: ${result.fatigue ?? '—'}. Structure revealed: ${result.structure ? (result.structure.yes ? 'yes' : 'no') : '—'}.<br>Copy the record below onto the Listening Trial page, or send it to David.</div><pre>${esc(JSON.stringify(result))}</pre><div class="hear-opts"><button data-act="copy" class="primary">Copy JSON</button><button data-act="close">Close</button></div>`
    box.querySelector('[data-act="copy"]').addEventListener('click', () => navigator.clipboard?.writeText(JSON.stringify(result)))
    box.querySelector('[data-act="close"]').addEventListener('click', () => { box.hidden = true })
    return result
  }
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
  const abort = () => { aborted = true; steering = null; clearInterval(pump); box.hidden = true; const r = asking; asking = null; r?.(null) }
  const trial = { run, abort, last: null }
  btn.addEventListener('click', () => run({ auto: false }))
  return trial
}

export const provHtml = (m, a) => {
  const p = a.provenance || {}, r = a.rights || {}, st = a.source_text || {}
  return `<b>${esc(a.role)}</b> · ${esc(p.kind)}${p.model ? ` · ${esc(p.model)} voice ${esc(p.voice_id)}` : ''}${p.reader ? ` · read by ${esc(p.reader)}` : ''}<br>
source ${esc(st.fragment_id || '')} · page ${esc((m.semantic_target?.source_revision || '').slice(7, 19))}… · text ${esc((st.input_revision || '').slice(7, 19))}…<br>
${esc(a.loudness?.integrated_lufs)} LUFS · ${esc(a.duration_seconds)} s · ${esc(r.source_licence)}<br>
<i>${esc(r.attribution)}</i>`
}

