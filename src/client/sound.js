// sound.js — the voices: Web Audio through three.js under the soundscape policy
import { nodesById, parseVtt } from './util.js'

// ------------------------------------------------------------------ sound
export function makeSound (three, world, speakers, policy, root, chainFactory = null) {
  const { camera, nodePos, heightOf } = world
  let listener = null, ctx = null, enabled = false, muted = false, paused = false, timer = 0
  const buses = {}
  const emitters = new Map()   // id -> emitter
  let focusId = null, insideId = null
  let held = false                       // Close: everything quiet, the context kept for the next Enter
  let listenId = null, listenResolve = null   // the house being listened to from the top, and the promise that settles when its clause ends
  const W = policy.selection_weights
  const fadeMs = policy.crossfade_ms
  const dwellMs = policy.hysteresis.min_dwell_ms
  const deadband = policy.hysteresis.deadband
  const dbToGain = db => Math.pow(10, db / 20)

  const busOf = s => s.role === 'human_reading' ? 'human_speech' : 'synthetic_speech'
  // ---- Multilingual Mixes (policy 0.2.0): which languages sound, and which of a house's two readings plays
  const base = l => String(l || 'en').toLowerCase().split('-')[0]
  const mix = { mode: policy.mix || 'native', languages: (policy.languages || []).map(base) }
  const perLang = policy.per_language_intelligible ?? 1
  const hasNative = s => !!(s.native && (s.native_opus || s.native_audio))
  const langOf = s => hasNative(s) ? base(s.language) : 'en'             // what the house can speak besides English
  const spokenOf = e => e.track === 'nat' ? langOf(e.s) : 'en'            // what it is speaking now
  let onlyId = null   // "one voice": a zone that lets a single house sound and nothing else
  const allowed = e => (!onlyId || e.s.id === onlyId) && (!mix.languages.length || mix.languages.includes(langOf(e.s)) || (mix.mode === 'native' && mix.languages.includes('en')))
  const shared = () => mix.mode === 'pair' || mix.mode === 'polyphonic'   // modes that owe every allowed language a voice
  // the track a house should be on: solo, pair and polyphonic always take the original; native takes the
  // English at city and street scale and crosses to the original at the threshold of the house you chose
  const wantTrack = e => !hasNative(e.s) ? 'en' : mix.mode !== 'native' ? 'nat'
    : ((lod === 'threshold' || lod === 'interior') && (focusId === e.s.id || listenId === e.s.id || insideId === e.s.id) ? 'nat' : 'en')
  const MAX_NODES = 14   // audio graphs alive at once: the budget plus a few cooling down
  const build = (e, track) => {   // the audio graph for one house, made only when it is needed
    if (e.pa) return
    const s = e.s
    e.track = track || wantTrack(e)
    const el = document.createElement('audio')
    el.crossOrigin = 'anonymous'; el.preload = 'none'; el.loop = true
    const canOpus = el.canPlayType('audio/ogg; codecs=opus')
    const src = e.track === 'nat' ? { opus: s.native_opus, audio: s.native_audio } : { opus: s.opus, audio: s.audio }
    el.src = canOpus && src.opus ? src.opus : src.audio
    const pa = new three.PositionalAudio(listener)
    pa.setMediaElementSource(el)
    pa.setRefDistance(4); pa.setMaxDistance(45); pa.setRolloffFactor(1.2); pa.setDistanceModel('inverse')
    pa.setDirectionalCone(180, 270, 0.2)
    const gain = ctx.createGain(); gain.gain.value = 0
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lod === 'region' ? 400 : 700   // a new voice murmurs until promoted
    // panner -> gain (crossfade, duck) -> low-pass (murmur) -> [voice chain, if a MODULE gave one] -> bus
    pa.gain.disconnect(); pa.gain.connect(gain); gain.connect(lp)
    let chain = null
    if (chainFactory) {
      try {
        chain = chainFactory(ctx, { id: s.id, slug: s.slug, title: s.title, role: s.role, district: s.district, voice: e.track === 'nat' ? s.native_voice : s.voice, language: spokenOf(e), x: e.x, y: e.y, z: e.z }, policy) || null
      } catch (err) { console.warn('hear: voice chain failed for', s.slug, err); chain = null }
    }
    if (chain?.input && chain?.output) { lp.connect(chain.input); chain.output.connect(buses[busOf(s)]) } else { chain = null; lp.connect(buses[busOf(s)]) }
    pa.position.set(e.x, e.y, e.z)
    const d = new three.Vector3(e.x - world.sqPos[0], 0, e.z - world.sqPos[1]).normalize()
    pa.lookAt(new three.Vector3(e.x - d.x, e.y, e.z - d.z))
    world.scene.add(pa)
    Object.assign(e, { el, pa, gain, lp, chain })
  }
  const teardown = e => {
    if (!e.pa) return
    e.el.pause(); e.el.src = ''; world.scene.remove(e.pa)
    try { e.pa.disconnect() } catch {}
    try { e.chain?.dispose?.() } catch {}
    Object.assign(e, { el: null, pa: null, gain: null, lp: null, chain: null, started: false, cues: null, track: null })
  }
  // the crossfade between a house's two readings: the old graph fades out and is torn down, the new one
  // starts from the top and fades in — the original speaks at the threshold, from its first word
  const retrack = (e, want, now) => {
    if (!e.pa || e.track === want) return
    const old = { el: e.el, pa: e.pa, gain: e.gain, lp: e.lp, chain: e.chain }
    ramp(old.gain.gain, 0, fadeMs)
    setTimeout(() => { try { old.el.pause(); old.el.src = ''; world.scene.remove(old.pa); old.pa.disconnect(); old.chain?.dispose?.() } catch {} }, fadeMs + 80)
    Object.assign(e, { el: null, pa: null, gain: null, lp: null, chain: null, cues: null, started: false })
    build(e, want)
    e.started = true; e.since = now
    try { e.el.currentTime = 0 } catch {}
    e.el.play().catch(() => {})
    ramp(e.gain.gain, e.target || 1, fadeMs)
    if (e.intelligible) { e.intelligible = false; setIntelligible(e, true) }
  }
  const live = () => [...emitters.values()].filter(e => e.pa).length

  const enable = async () => {
    if (enabled) { held = false; return }
    listener = new three.AudioListener()
    camera.add(listener)
    ctx = listener.context
    if (ctx.state === 'suspended') await ctx.resume()
    for (const b of ['human_speech', 'synthetic_speech', 'ambience', 'ui']) {
      const g = ctx.createGain(); g.connect(listener.getInput()); buses[b] = g
    }
    for (const s of speakers) {
      const [x, z] = nodePos.get(s.id); const n = nodesById({ nodes: world.index }, s.id)
      emitters.set(s.id, { s, x, z, y: Math.min(2.2, heightOf(n) * 0.5), el: null, pa: null, gain: null, lp: null,
                           active: false, intelligible: false, since: 0, score: 0, cues: null, started: false, target: 0, idleSince: 0 })
    }
    enabled = true
    timer = setInterval(() => frame(0.15), 150)   // independent of the render loop
  }

  const distance = e => { const c = world.ctl.pos; return Math.hypot(e.x - c.x, e.z - c.z, (e.y - c.y) * 0.5) }
  const proximity = e => Math.max(0, 1 - distance(e) / 45)
  const facing = e => {
    const to = new three.Vector3(e.x - camera.position.x, 0, e.z - camera.position.z).normalize()
    const f = new three.Vector3(); camera.getWorldDirection(f); f.y = 0; f.normalize()
    return Math.max(0, to.dot(f))
  }
  const maxDegree = Math.max(1, ...speakers.map(s => s.degree || 0))
  let lod = 'street'
  const score = e => W.proximity * proximity(e) + W.explicit_focus * (focusId === e.s.id ? 1 : 0) + W.view_direction * facing(e)
    + W.journey_relevance * 0                                                    // journey relevance is Phase 6
    + W.semantic_relevance * (lod === 'city' || lod === 'region' ? (e.s.degree || 0) / maxDegree : 0)   // beacons above the city

  const ramp = (param, to, ms) => {
    // Equal power is a law for two signals crossing; a single level moving
    // between two non-zero values must ramp linearly or it bulges above unity.
    const t0 = ctx.currentTime; const from = param.value
    if (Math.abs(to - from) < 0.02) return
    param.cancelScheduledValues(t0)
    param.setValueAtTime(from, t0)
    if (from < 0.01 || to < 0.01) {
      const n = 24; const curve = new Float32Array(n)
      for (let i = 0; i < n; i++) { const p = i / (n - 1); curve[i] = from * Math.cos(p * Math.PI / 2) + to * Math.sin(p * Math.PI / 2) }
      try { param.setValueCurveAtTime(curve, t0, Math.max(0.01, ms / 1000)); return } catch {}
    }
    param.linearRampToValueAtTime(to, t0 + Math.max(0.01, ms / 1000))
  }
  const activate = (e, now) => {
    build(e)
    e.active = true; e.since = now
    if (!e.started) { try { e.el.currentTime = Math.random() * 10 } catch {} e.started = true }
    e.el.play().catch(() => {})
    e.target = 1
    ramp(e.gain.gain, 1, fadeMs)
  }
  const deactivate = (e, now) => {
    e.active = false; e.intelligible = false; e.since = now; e.target = 0
    ramp(e.gain.gain, 0, fadeMs); e.idleSince = now
    setTimeout(() => { if (!e.active && e.el) e.el.pause() }, fadeMs + 50)
  }
  const setIntelligible = (e, on) => {
    if (e.intelligible === on || !e.lp) return
    e.intelligible = on
    ramp(e.lp.frequency, on ? 20000 : (lod === 'region' ? 400 : 700), fadeMs)
  }
  // acoustic level of detail, by where the listener is: what the policy's table says sounds at each scale
  const lodOf = () => {
    if (insideId) return 'interior'
    if (world.ctl.mode === 'threshold') return 'threshold'
    const h = world.ctl.pos.y          // the control position, not the camera: a hidden tab never renders
    return h > 40 ? 'region' : h > 14 ? 'city' : 'street'
  }
  const LOD = Object.fromEntries((policy.acoustic_lod || []).map(l => [l.scale, l]))
  const budgetFor = l => LOD[l]?.max_active ?? ({ region: 4, city: 6, street: policy.max_active_emitters, threshold: policy.max_active_emitters, interior: 1 })[l]
  const intelligibleFor = l => LOD[l]?.max_intelligible ?? ({ region: 0, city: 2, street: policy.max_intelligible_speech, threshold: 1, interior: 1 })[l]

  const frame = () => {
    if (!enabled) return
    if (!root.isConnected) { root._hear?.dispose?.(); return }
    const now = performance.now()
    if (paused || muted || held) return
    lod = lodOf()
    const all = [...emitters.values()]
    for (const e of all) e.score = score(e)
    for (const e of all) if (e.chain?.update && e.pa) { try { e.chain.update({ distance: distance(e), facing: facing(e), intelligible: e.intelligible, active: e.active, lod, score: e.score, focused: focusId === e.s.id }) } catch {} }
    for (const e of all) if (!e.active && e.pa && now - e.idleSince > 20000 && now - (e.primed || 0) > 20000 && e.s.id !== listenId && live() > MAX_NODES) teardown(e)
    // the mix: a language not on the allow-list is muted, not ducked — its houses leave the budget and never enter it
    for (const e of all) if (e.active && !allowed(e) && e.s.id !== listenId) deactivate(e, now)
    // the track each house should be on now (native mode crosses to the original at the threshold)
    for (const e of all) if (e.active && e.pa) { const w = wantTrack(e); if (w !== e.track) retrack(e, w, now) }
    // the listened house keeps playing whatever paused its element (a background tab, a stray pause): the clause is the walker's clock
    if (listenId) { const e = emitters.get(listenId); if (e?.el && e.active && e.el.paused && !e.el.ended && e.el.readyState >= 2) e.el.play().catch(() => {}) }
    if (insideId) {
      for (const e of all) {
        const on = e.s.id === insideId
        if (on && !e.active) activate(e, now)
        if (!on && e.active) deactivate(e, now)
        setIntelligible(e, on)
      }
      return
    }
    // budget with hysteresis: a challenger must beat the weakest active by the deadband,
    // and the weakest must have dwelt at least min_dwell_ms
    const active = all.filter(e => e.active).sort((a, b) => a.score - b.score)
    const idle = all.filter(e => !e.active && allowed(e) && e.score > 0.02).sort((a, b) => b.score - a.score)
    const budget = budgetFor(lod)
    while (active.length > budget) { const e = active.shift(); deactivate(e, now) }
    while (active.length < budget && idle.length) { const e = idle.shift(); activate(e, now); active.push(e) }
    // a pair or a polyphony owes each allowed language a house: the nearest of that language is chosen on its own,
    // even when every nearer house speaks another tongue (0.8.2; before this a pair over Iberia was all Spanish)
    const perLangActive = new Map(); for (const e of active) { const l = spokenOf(e); perLangActive.set(l, (perLangActive.get(l) || 0) + 1) }
    if (shared()) {
      const owed = mix.mode === 'pair' ? mix.languages : [...new Set(idle.map(spokenOf))]
      for (const l of owed) {
        if (perLangActive.get(l)) continue
        const ci = idle.findIndex(e => spokenOf(e) === l); if (ci < 0) continue
        if (active.length >= budget) {
          const v = active.find(e => (perLangActive.get(spokenOf(e)) || 0) > 1); if (!v) continue
          deactivate(v, now); active.splice(active.indexOf(v), 1); perLangActive.set(spokenOf(v), perLangActive.get(spokenOf(v)) - 1)
        }
        const c = idle.splice(ci, 1)[0]; activate(c, now); active.push(c); active.sort((a, b) => a.score - b.score); perLangActive.set(l, 1)
      }
    }
    const sole = e => shared() && (perLangActive.get(spokenOf(e)) || 0) <= 1
    for (const c of idle) {
      const weakest = active.find(e => !sole(e))
      if (!weakest) break
      if (c.score > weakest.score + deadband && now - weakest.since >= dwellMs) {
        deactivate(weakest, now); activate(c, now); active.splice(active.indexOf(weakest), 1); active.push(c); active.sort((a, b) => a.score - b.score)
        perLangActive.set(spokenOf(weakest), perLangActive.get(spokenOf(weakest)) - 1); perLangActive.set(spokenOf(c), (perLangActive.get(spokenOf(c)) || 0) + 1)
      } else break
    }
    for (const e of active) if (e.score < 0.01 && now - e.since >= dwellMs) deactivate(e, now)
    const byScore = all.filter(e => e.active).sort((a, b) => b.score - a.score)
    const limit = intelligibleFor(lod)
    if (shared()) {   // one intelligible strand per language, so a pair is two tongues and the crowd is a set of them, not a wall
      const perLanguage = new Map(); let n = 0
      for (const e of byScore) { const l = spokenOf(e); const c = perLanguage.get(l) || 0; const on = n < limit && c < perLang; if (on) { n++; perLanguage.set(l, c + 1) } setIntelligible(e, on) }
    } else byScore.forEach((e, i) => setIntelligible(e, i < limit))
    // ducking: when a house is focused, the rest drop by focus_duck_db
    for (const e of byScore) {
      const duck = focusId && focusId !== e.s.id ? dbToGain(policy.focus_duck_db) : 1
      if (e.active && e.target !== duck) { e.target = duck; ramp(e.gain.gain, duck, fadeMs) }
    }
    sound.lastTick = byScore.map(e => ({ id: e.s.id, title: e.s.title, score: e.score, intelligible: e.intelligible, language: spokenOf(e) }))
    sound.onTick?.(sound.lastTick, lod, live())
  }

  const wait = ms => new Promise(r => setTimeout(r, ms))
  // settle the current listen: the element loops again and, if the clause ended while the house is still active, plays on as the crowd does
  const endListen = ended => {
    if (!listenId) return
    const e = emitters.get(listenId); listenId = null
    if (e?.el) {
      e.el.loop = true
      if (e._onEnded) { e.el.removeEventListener('ended', e._onEnded); e._onEnded = null }
      if (ended && e.active && !paused) e.el.play().catch(() => {})
    }
    const r = listenResolve; listenResolve = null; r?.(ended)
  }
  // seek to the top: before metadata the browser honours it as the start position; after, wait for the seek (or a beat)
  const seekStart = el => new Promise(resolve => {
    let done = false; const fin = () => { if (!done) { done = true; el.removeEventListener('seeked', fin); resolve() } }
    if (el.readyState >= 1) { el.addEventListener('seeked', fin); try { el.currentTime = 0 } catch {}; setTimeout(fin, 300) } else {
      el.addEventListener('loadedmetadata', () => { try { el.currentTime = 0 } catch {}; fin() }, { once: true })
      el.preload = 'auto'; el.load()
      setTimeout(fin, 2500)
    }
  })
  // prime a house you are walking towards: build its graph and fetch the clip, so arrival does not wait on the network
  const prime = id => { const e = emitters.get(id); if (!e || !enabled) return; build(e); e.primed = performance.now(); if (e.el.readyState < 1) { e.el.preload = 'auto'; e.el.load() } }
  // the timing rule: a house starts its clause from the top the moment it is listened to — dip, seek, open, fade —
  // and does not loop while listened to, so the end of the clause is an event the walker can wait for
  const listen = async id => {
    const e = emitters.get(id)
    if (!e || !enabled) return false
    endListen(false)
    held = false
    const now = performance.now()
    listenId = id; focusId = id
    if (e.pa && hasNative(e.s) && mix.mode === 'native' && e.track !== 'nat') teardown(e)   // a chosen house speaks its original from the top
    build(e, hasNative(e.s) ? 'nat' : 'en')
    e.active = true; e.started = true; e.since = now; e.target = 1; e.el.loop = false   // active before the dip, so frame() neither activates it at a random offset nor ducks it
    ramp(e.gain.gain, 0, 120)
    await wait(130)
    if (listenId !== id) return false
    await seekStart(e.el)
    if (listenId !== id) return false
    e.el.play().catch(() => {})
    ramp(e.gain.gain, muted ? 0 : 1, fadeMs); setIntelligible(e, true)
    return new Promise(resolve => {
      listenResolve = resolve
      e._onEnded = () => { if (listenId === id) endListen(true) }
      e.el.addEventListener('ended', e._onEnded)
    })
  }
  // Close: every voice fades out and the frame loop holds; the graphs and the context stay for the next Enter
  const silence = () => {
    endListen(false); focusId = null; insideId = null
    const now = performance.now()
    for (const e of emitters.values()) if (e.active) deactivate(e, now)
    held = true
  }

  const sound = {
    enable, emitters, buses, policy, listen, silence, prime,
    resume () { held = false },
    get held () { return held },
    get paused () { return paused },
    get listening () { return listenId },
    get enabled () { return enabled },
    onTick: null,
    focus (id) { if (id !== listenId) endListen(false); focusId = id },
    enter (id) { endListen(false); insideId = id; focusId = id },
    leave () { insideId = null },
    mute (on) { muted = on; for (const b of Object.values(buses)) ramp(b.gain, on ? 0 : 1, 200) },
    pause (on) { paused = on; for (const e of emitters.values()) { if (!e.el) continue; if (on) e.el.pause(); else if (e.active) e.el.play().catch(() => {}) } },
    bus (name, v) { if (buses[name]) buses[name].gain.value = v },
    currentTime (id) { return emitters.get(id)?.el?.currentTime ?? 0 },
    get lod () { return lod },
    get mix () { return { ...mix } },
    languages () { const c = new Map(); for (const s of speakers) { const l = langOf(s); c.set(l, (c.get(l) || 0) + 1) } return c },
    // change the mix live: unlisted houses fall silent, houses on the wrong track cross to the right one
    setMix (mode, languages = []) {
      mix.mode = ['native', 'solo', 'pair', 'polyphonic'].includes(mode) ? mode : 'native'; mix.languages = languages.map(base)
      if (!enabled) return
      const now = performance.now()
      for (const e of emitters.values()) { if (e.active && !allowed(e)) deactivate(e, now); else if (e.pa) { const w = wantTrack(e); if (w !== e.track) { if (e.active) retrack(e, w, now); else teardown(e) } } }
    },
    spokenOf (id) { const e = emitters.get(id); return e ? spokenOf(e) : 'en' },
    // one voice: only this house may sound (null lifts it); the flight uses it for a zone that is a single door
    only (id = null) {
      onlyId = id || null
      if (!enabled) return
      const now = performance.now()
      for (const e of emitters.values()) if (e.active && !allowed(e) && e.s.id !== listenId) deactivate(e, now)
    },
    get onlyId () { return onlyId },
    get chainFactory () { return chainFactory },
    setChain (fn) { chainFactory = typeof fn === 'function' ? fn : null; for (const e of emitters.values()) teardown(e) },   // live swap from the console: graphs rebuild on next activation
    get liveNodes () { return live() },
    async cues (id) {
      const e = emitters.get(id); if (!e) return []
      if (!e.cues) {
        const vtt = e.track === 'nat' && e.s.native_vtt ? e.s.native_vtt : (e.s.audio || '').replace(/\.(m4a|opus)$/, '.vtt')
        e.cues = await fetch(vtt, { mode: 'cors' }).then(r => r.text()).then(parseVtt).catch(() => [])
      }
      return e.cues
    },
    dispose () { if (!enabled) return; enabled = false; clearInterval(timer); for (const e of emitters.values()) teardown(e); ctx?.close?.() }
  }
  return sound
}

