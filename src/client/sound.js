// sound.js — the voices: Web Audio through three.js under the soundscape policy
import { nodesById, parseVtt } from './util.js'

// ------------------------------------------------------------------ sound
export function makeSound (three, world, speakers, policy, root) {
  const { camera, nodePos, heightOf } = world
  let listener = null, ctx = null, enabled = false, muted = false, paused = false, timer = 0
  const buses = {}
  const emitters = new Map()   // id -> emitter
  let focusId = null, insideId = null
  const W = policy.selection_weights
  const fadeMs = policy.crossfade_ms
  const dwellMs = policy.hysteresis.min_dwell_ms
  const deadband = policy.hysteresis.deadband
  const dbToGain = db => Math.pow(10, db / 20)

  const busOf = s => s.role === 'human_reading' ? 'human_speech' : 'synthetic_speech'
  const MAX_NODES = 14   // audio graphs alive at once: the budget plus a few cooling down
  const build = e => {   // the audio graph for one house, made only when it is needed
    if (e.pa) return
    const s = e.s
    const el = document.createElement('audio')
    el.crossOrigin = 'anonymous'; el.preload = 'none'; el.loop = true
    const canOpus = el.canPlayType('audio/ogg; codecs=opus')
    el.src = canOpus && s.opus ? s.opus : s.audio
    const pa = new three.PositionalAudio(listener)
    pa.setMediaElementSource(el)
    pa.setRefDistance(4); pa.setMaxDistance(45); pa.setRolloffFactor(1.2); pa.setDistanceModel('inverse')
    pa.setDirectionalCone(180, 270, 0.2)
    const gain = ctx.createGain(); gain.gain.value = 0
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lod === 'region' ? 400 : 700   // a new voice murmurs until promoted
    pa.gain.disconnect(); pa.gain.connect(gain); gain.connect(lp); lp.connect(buses[busOf(s)])
    pa.position.set(e.x, e.y, e.z)
    const d = new three.Vector3(e.x - world.sqPos[0], 0, e.z - world.sqPos[1]).normalize()
    pa.lookAt(new three.Vector3(e.x - d.x, e.y, e.z - d.z))
    world.scene.add(pa)
    Object.assign(e, { el, pa, gain, lp })
  }
  const teardown = e => {
    if (!e.pa) return
    e.el.pause(); e.el.src = ''; world.scene.remove(e.pa)
    try { e.pa.disconnect() } catch {}
    Object.assign(e, { el: null, pa: null, gain: null, lp: null, started: false })
  }
  const live = () => [...emitters.values()].filter(e => e.pa).length

  const enable = async () => {
    if (enabled) return
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

  const proximity = e => {
    const c = world.ctl.pos
    const d = Math.hypot(e.x - c.x, e.z - c.z, (e.y - c.y) * 0.5)
    return Math.max(0, 1 - d / 45)
  }
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
    if (paused || muted) return
    lod = lodOf()
    const all = [...emitters.values()]
    for (const e of all) e.score = score(e)
    for (const e of all) if (!e.active && e.pa && now - e.idleSince > 20000 && live() > MAX_NODES) teardown(e)
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
    const idle = all.filter(e => !e.active && e.score > 0.02).sort((a, b) => b.score - a.score)
    const budget = budgetFor(lod)
    while (active.length > budget) { const e = active.shift(); deactivate(e, now) }
    while (active.length < budget && idle.length) { const e = idle.shift(); activate(e, now); active.push(e) }
    for (const c of idle) {
      const weakest = active[0]
      if (!weakest) break
      if (c.score > weakest.score + deadband && now - weakest.since >= dwellMs) {
        deactivate(weakest, now); activate(c, now); active.shift(); active.push(c); active.sort((a, b) => a.score - b.score)
      } else break
    }
    for (const e of active) if (e.score < 0.01 && now - e.since >= dwellMs) deactivate(e, now)
    const byScore = all.filter(e => e.active).sort((a, b) => b.score - a.score)
    const limit = intelligibleFor(lod)
    byScore.forEach((e, i) => setIntelligible(e, i < limit))
    // ducking: when a house is focused, the rest drop by focus_duck_db
    for (const e of byScore) {
      const duck = focusId && focusId !== e.s.id ? dbToGain(policy.focus_duck_db) : 1
      if (e.active && e.target !== duck) { e.target = duck; ramp(e.gain.gain, duck, fadeMs) }
    }
    sound.onTick?.(byScore.map(e => ({ id: e.s.id, title: e.s.title, score: e.score, intelligible: e.intelligible })), lod, live())
  }

  const sound = {
    enable, emitters, buses, policy,
    get enabled () { return enabled },
    onTick: null,
    focus (id) { focusId = id },
    enter (id) { insideId = id; focusId = id },
    leave () { insideId = null },
    mute (on) { muted = on; for (const b of Object.values(buses)) ramp(b.gain, on ? 0 : 1, 200) },
    pause (on) { paused = on; for (const e of emitters.values()) { if (!e.el) continue; if (on) e.el.pause(); else if (e.active) e.el.play().catch(() => {}) } },
    bus (name, v) { if (buses[name]) buses[name].gain.value = v },
    currentTime (id) { return emitters.get(id)?.el?.currentTime ?? 0 },
    get lod () { return lod },
    get liveNodes () { return live() },
    async cues (id) {
      const e = emitters.get(id); if (!e) return []
      if (!e.cues) {
        const vtt = (e.s.audio || '').replace(/\.(m4a|opus)$/, '.vtt')
        e.cues = await fetch(vtt, { mode: 'cors' }).then(r => r.text()).then(parseVtt).catch(() => [])
      }
      return e.cues
    },
    dispose () { if (!enabled) return; enabled = false; clearInterval(timer); for (const e of emitters.values()) teardown(e); ctx?.close?.() }
  }
  return sound
}

