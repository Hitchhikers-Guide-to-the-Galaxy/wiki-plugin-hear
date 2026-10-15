// flight.js — the authored flight (FLIGHT line): circle the city, dive to one house, glide to a
// house that speaks another language, climb, and circle again
//
// A journey (JOURNEY) sets the mix and lets the street's competition choose the voices.  A flight
// owns the camera AND the mix while it runs.  The camera rides one smooth curve per stage —
// centripetal Catmull-Rom through a handful of control points, its speed matched where one stage
// hands over to the next, the gaze damped towards a moving look point — and the sound is authored
// through sound.direct(): which houses sound, how loud, which one is clear.  Nothing enters or leaves
// the mix on a schedule of its own.  A house starts its clause from the top a few seconds before the
// camera arrives, so you land inside its first sentence, and the flight leaves a beat after the
// clause ends.  Any walking key or a drag hands control back.  A hidden tab gets no animation
// frames, so the flight clocks itself, as the walker does.
//
// flight.json:
//   { "flight_id": "…", "name": "…", "loop": true, "centre": "city" | "street",
//     "orbit": { "radius": 60, "height": 44, "direction": 1, "seconds_per_turn": 50 },
//     "bed_voices": 6,
//     "stages": [ { "kind": "orbit", "degrees": 300, "caption": "…" },
//                 { "kind": "dive",   "house": "slug", "speak_before_arrival": 3 },
//                 { "kind": "listen", "house": "slug", "beat": 1.5 },
//                 { "kind": "glide",  "house": "slug", "speak_before_arrival": 2.5, "height": 5.5 },
//                 { "kind": "listen", "house": "slug" },
//                 { "kind": "climb" } ] }
// Radius and height default to the city's own span; stages default to the longest native reading on
// the street and the nearest house that speaks another language.
const smooth = t => t * t * (3 - 2 * t)
const clamp01 = x => Math.max(0, Math.min(1, x))
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const inOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
const outQuad = t => 1 - (1 - t) * (1 - t)     // leaves at speed, arrives at rest
const inQuad = t => t * t                      // leaves at rest, arrives at speed
const linear = t => t
const rampIn = a => t => t < a ? (t * t / (2 * a)) / (1 - a / 2) : (t - a / 2) / (1 - a / 2)   // up to speed over the first a, then steady
const LANG = { en: 'English', es: 'Spanish', ar: 'Arabic', pt: 'Portuguese', 'pt-BR': 'Brazilian Portuguese', 'pt-PT': 'European Portuguese', fr: 'French', de: 'German', 'de-CH': 'Swiss German', it: 'Italian', ja: 'Japanese', zh: 'Chinese', rm: 'Romansh' }
export const languageName = l => LANG[l] || LANG[String(l || '').split('-')[0]] || l || 'English'
const base = l => String(l || 'en').toLowerCase().split('-')[0]
const EYE = 2.0
const STANDOFF = 3.2   // close enough that a house a metre wide fills the middle of the frame
const wait = ms => new Promise(r => setTimeout(r, ms))

export function makeFlight (world, sound, speakers, map, sheet = {}) {
  const { three, ctl, nodePos } = world
  const V = (x = 0, y = 0, z = 0) => new three.Vector3(x, y, z)
  const nodeOf = id => world.index.find(n => n.id === id)
  const house = key => speakers.find(s => s.slug === key || s.id === key)
  const posOf = s => { const [x, z] = nodePos.get(s.id); return V(x, 0, z) }
  const flat = v => V(v.x, 0, v.z)
  const hasNative = s => !!(s?.native && (s.native_opus || s.native_audio))
  const speaks = s => hasNative(s) ? s.language : 'en'

  // the city: its centre and span, from every page on the map
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const [x, z] of nodePos.values()) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z) }
  const span = Math.max(x1 - x0, z1 - z0)
  const centre = sheet.centre === 'street' ? V(world.sqPos[0], 0, world.sqPos[1]) : V((x0 + x1) / 2, 0, (z0 + z1) / 2)
  const orbit = Object.assign({ radius: span * 1.0, height: span * 0.62, direction: 1, seconds_per_turn: 50 }, sheet.orbit || {})   // far enough out that the whole city stays in frame
  const dir = orbit.direction < 0 ? -1 : 1
  const omega = 2 * Math.PI / orbit.seconds_per_turn
  const orbitSpeed = omega * orbit.radius
  const onCircle = th => V(centre.x + orbit.radius * Math.cos(th), orbit.height, centre.z + orbit.radius * Math.sin(th))
  const tangent = th => V(-Math.sin(th), 0, Math.cos(th)).multiplyScalar(dir)
  const angleOf = v => Math.atan2(v.z - centre.z, v.x - centre.x)
  const TAU = 2 * Math.PI
  const mod = (a, m) => ((a % m) + m) % m

  // the stages: the sheet's, or a sensible flight made from the street
  const defaultStages = () => {
    const street = new Set(map.street?.houses || [])
    const natives = speakers.filter(hasNative)
    const a = natives.filter(s => street.has(s.id)).sort((x, y) => (y.native_seconds || 0) - (x.native_seconds || 0))[0] || natives[0] || speakers[0]
    if (!a) return []
    const b = natives.filter(s => s.id !== a.id && base(s.language) !== base(a.language)).sort((x, y) => posOf(x).distanceTo(posOf(a)) - posOf(y).distanceTo(posOf(a)))[0] ||
      speakers.filter(s => s.id !== a.id).sort((x, y) => posOf(x).distanceTo(posOf(a)) - posOf(y).distanceTo(posOf(a)))[0]
    const st = [{ kind: 'orbit', degrees: 300 }, { kind: 'dive', house: a.slug }, { kind: 'listen', house: a.slug }]
    if (b) st.push({ kind: 'glide', house: b.slug }, { kind: 'listen', house: b.slug })
    st.push({ kind: 'climb' })
    return st
  }
  const stages = (sheet.stages?.length ? sheet.stages : defaultStages()).filter(st => !st.house || house(st.house))
  const leads = new Set(stages.map(st => st.house && house(st.house)?.id).filter(Boolean))

  // the bed heard from above: one voice per sector of the city, its best-linked house, its own language first
  const bed = (() => {
    const k = sheet.bed_voices ?? 6; const picks = []
    for (let i = 0; i < k; i++) {
      const lo = -Math.PI + i * TAU / k, hi = lo + TAU / k
      const inSector = speakers.filter(s => !leads.has(s.id) && s.role !== 'human_reading').filter(s => { const a = angleOf(posOf(s)); return a >= lo && a < hi })
      inSector.sort((a, b) => (hasNative(b) ? 1 : 0) - (hasNative(a) ? 1 : 0) || (b.degree || 0) - (a.degree || 0))
      if (inSector[0]) picks.push(inSector[0])
    }
    return picks
  })()
  const neighbours = (s, k = 2) => speakers.filter(x => x.id !== s.id && !leads.has(x.id))
    .map(x => [x, posOf(x).distanceTo(posOf(s))]).sort((a, b) => a[1] - b[1]).slice(0, k).map(a => a[0])

  // the door.  The city is dense (houses a metre or two apart), so the point STANDOFF short of a house on the line you
  // came in on is often inside a neighbour: measured on the first test, the camera landed facing a red wall.  Search
  // round the house for the clear place to stand nearest that line, with a clear sight of the house's face; failing
  // that, stand further back; failing that, higher, above the neighbouring roofs.
  const boxes = world.index.map(n => { const p = nodePos.get(n.id); return p && { id: n.id, x: p[0], z: p[1], r: world.widthOf(n) / 2, h: world.heightOf(n) } }).filter(Boolean)
  const blocked = (x, y, z, pad, skip) => boxes.some(b => b.id !== skip && b.h > y - pad && Math.abs(b.x - x) < b.r + pad && Math.abs(b.z - z) < b.r + pad)
  const roofAt = (x, z, pad) => boxes.reduce((m, b) => Math.abs(b.x - x) < b.r + pad && Math.abs(b.z - z) < b.r + pad ? Math.max(m, b.h) : m, 0)
  const sightClear = (from, to, skip) => {
    for (let i = 1; i < 14; i++) { const t = i / 14; if (blocked(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t, 0.12, skip)) return false }
    return true
  }
  const door = (s, from) => {
    const H = posOf(s); const h = world.heightOf(nodeOf(s.id))
    const look = V(H.x, Math.min(2.2, h * 0.5), H.z)
    const u0 = flat(H.clone().sub(from)); if (u0.lengthSq() < 1e-6) u0.set(0, 0, -1); u0.normalize()
    const a0 = Math.atan2(u0.z, u0.x)
    let best = null
    for (const eye of [EYE, 3.2, 4.8]) {
      for (const dist of [STANDOFF, 4.2, 5.5]) {
        for (let k = 0; k < 24; k++) {
          const da = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI / 12   // 0, +15°, -15°, +30° … round the house
          const u = V(Math.cos(a0 + da), 0, Math.sin(a0 + da))
          const at = H.clone().addScaledVector(u, -dist).setY(eye)
          if (blocked(at.x, at.y, at.z, 0.3, s.id) || !sightClear(at, look, s.id)) continue
          const cost = Math.abs(da) * 4 + (dist - STANDOFF) * 0.6
          if (!best || cost < best.cost) best = { cost, u, at }
        }
      }
      if (best) break
    }
    if (!best) best = { u: u0, at: H.clone().addScaledVector(u0, -STANDOFF).setY(Math.max(EYE, roofAt(H.x, H.z, STANDOFF) + 1.5)) }
    return { s, H, u: best.u, at: best.at, look }
  }
  const overRoofs = (p, pad = 1.2, lift = 0.9) => { p.y = Math.max(p.y, roofAt(p.x, p.z, pad) + lift); return p }

  const state = { on: false, stage: -1, kind: '', house: null, remaining: 0, lap: 0 }
  const flight = { state, stages, bed, centre, orbit, name: sheet.name || 'The flight', id: sheet.flight_id || '', loop: sheet.loop !== false, onStage: null, onCaption: null, onStop: null }

  // ---- the mix, authored: the bed fades with altitude, the neighbours of the house you are near
  // murmur softly at street level, and the house speaking its clause is the one clear voice
  const mix = { bed: true, near: [], speaking: null }
  const director = () => {
    const h = ctl.pos.y
    const out = new Map()
    const put = (s, gain, clear) => { const cur = out.get(s.id); if (!cur || cur.gain < gain) out.set(s.id, { id: s.id, gain, clear, track: hasNative(s) ? 'nat' : 'en' }) }
    // one handover, not two fades: as the bed of the city fades with altitude, the neighbours of the house you are
    // coming down to rise, so the level holds all the way down (the first test measured a ten-second hole at -45 dB)
    const above = smooth(clamp01((h - 3) / 18))
    const bedGain = mix.bed ? 0.42 * above : 0
    for (const s of bed) put(s, bedGain, false)
    const nearGain = (mix.speaking ? 0.07 : 0.3) * (1 - above) + (mix.bed ? 0 : 0.05)
    for (const s of mix.near) put(s, nearGain, false)
    if (mix.speaking) put(mix.speaking, 1, true)
    return [...out.values()]
  }

  // ---- camera legs
  let leg = null, hold = null
  const lookPt = V()
  const curveLeg = (points, law, secondsOf) => {
    const curve = new three.CatmullRomCurve3(points, false, 'centripetal')
    const length = curve.getLength()
    return { pos: u => curve.getPointAt(clamp01(u)), law, seconds: secondsOf(length), length, elapsed: 0 }
  }
  let theta = 0, prevKind = ''

  // subtitles: the current cue of the house that is speaking
  let cueTimer = 0
  const caption = (title, detail = '', line = '', rtl = false) => flight.onCaption?.({ title, detail, line, rtl })
  const speakerDetail = s => {
    const voice = hasNative(s) ? s.native_voice : s.voice
    return [languageName(speaks(s)), `${s.role === 'human_reading' ? 'a human reading' : 'a synthetic voice'}${voice ? ' (' + voice + ')' : ''}`, hasNative(s) ? '' : s.heading].filter(Boolean).join(' · ')
  }
  // a clause is often one long cue: cut it into subtitle-sized pieces, timed by their share of the characters
  const chunk = cues => {
    const out = []
    for (const c of cues) {
      const text = (c.text || '').trim()
      if (text.length <= 110) { out.push(c); continue }
      const parts = []; let cur = ''
      for (const w of text.split(/\s+/)) {
        if (cur && (cur + ' ' + w).length > 90) { parts.push(cur); cur = w } else cur = cur ? cur + ' ' + w : w
        if (/[.;:,،؛]$/.test(w) && cur.length > 55) { parts.push(cur); cur = '' }
      }
      if (cur) parts.push(cur)
      const total = parts.reduce((t, p) => t + p.length, 0) || 1; let t = c.start
      for (const p of parts) { const d = (c.end - c.start) * p.length / total; out.push({ start: t, end: t + d, text: p }); t += d }
    }
    return out
  }
  const follow = async s => {
    clearInterval(cueTimer)
    const cues = chunk(sound.enabled ? await sound.cues(s.id) : [])
    const rtl = base(speaks(s)) === 'ar'
    let last = null
    cueTimer = setInterval(() => {
      if (!state.on || mix.speaking !== s) { clearInterval(cueTimer); return }
      const t = sound.currentTime(s.id)
      const c = cues.find((c, i) => t >= c.start && t < (i === cues.length - 1 ? c.end + 0.6 : c.end))
      const text = c ? c.text : ''
      if (text !== last) { last = text; caption(s.title, speakerDetail(s), text, rtl) }
    }, 150)
  }

  let clause = null          // the promise of the clause being spoken: settles when it ends
  const speak = s => {
    mix.speaking = s
    mix.near = neighbours(s, 2)
    caption(s.title, speakerDetail(s), '', base(speaks(s)) === 'ar')
    const seconds = (hasNative(s) ? s.native_seconds : s.seconds) || 20
    const guard = wait((seconds * 1.6 + 6) * 1000).then(() => 'timeout')   // a stalled clip never strands the flight
    clause = sound.enabled ? Promise.race([sound.listen(s.id), guard]) : wait(seconds * 1000)
    follow(s)
    return clause
  }
  const upcoming = from => { for (let i = from + 1; i < stages.length; i++) if (stages[i].house) return house(stages[i].house); return null }

  // ---- the stages
  let lastDoor = null
  const run = {
    join () {   // from wherever you are onto the circle, at rest
      const th = angleOf(ctl.pos.lengthSq() ? ctl.pos : V(1, 0, 0))
      const P0 = ctl.pos.clone(), P2 = onCircle(th)
      const P1 = P0.clone().lerp(P2, 0.5); P1.y = Math.max(P0.y, P2.y) * 0.9
      leg = curveLeg([P0, P1, P2], inOut, L => clamp(L / 7, 4, 10))
      leg.look = u => centre
      leg.onDone = () => { theta = th; prevKind = 'join'; next(true) }
      caption(flight.name, 'rising to circle the city')
    },
    orbit (st, i) {
      mix.bed = true; mix.speaking = null; mix.near = []
      const th0 = theta
      let sweep = (st.degrees ?? 300) * Math.PI / 180
      const target = upcoming(i)
      if (target) {   // at least the sheet's degrees, ending where the dive runs naturally inward to the house
        const want = angleOf(posOf(target)) - dir * 1.1
        sweep += mod(dir * (want - (th0 + dir * sweep)), TAU)
      }
      const seconds = sweep / omega
      const law = prevKind === 'climb' ? linear : rampIn(Math.min(0.3, 5 / seconds))
      leg = { pos: u => { theta = th0 + dir * sweep * u; return onCircle(theta) }, law, seconds, elapsed: 0, look: () => centre }
      leg.onDone = () => { theta = th0 + dir * sweep; next() }
      caption(st.caption || map.name || flight.name, st.detail || `${map.nodes.length} pages · ${speakers.length} that can speak`)
    },
    dive (st) {
      const s = house(st.house)
      mix.bed = true; mix.near = neighbours(s, 3); mix.speaking = null; world.highlight?.([s.id])
      const P0 = ctl.pos.clone()
      const P1 = P0.clone().addScaledVector(tangent(theta), orbitSpeed * 2.5); P1.y = Math.max(8, P0.y - 5)
      const d = door(s, P1)
      const back = Math.min(18, 0.45 * flat(P1.clone().sub(d.H)).length())
      const P2 = overRoofs(d.H.clone().addScaledVector(d.u, -(d.at.distanceTo(flat(d.H).setY(d.at.y)) + back)).setY(Math.max(9, back * 0.7)))
      const P3 = overRoofs(d.H.clone().addScaledVector(d.u, -(d.at.distanceTo(flat(d.H).setY(d.at.y)) + 4)).setY(Math.max(3, d.at.y + 1)))
      leg = curveLeg([P0, P1, P2, P3, d.at], outQuad, L => clamp(2 * L / orbitSpeed, 12, 24))
      leg.look = u => centre.clone().lerp(d.look, smooth(clamp01((u - 0.12) / 0.66)))
      leg.speakAt = leg.seconds - (st.speak_before_arrival ?? 6)
      leg.onSpeak = () => speak(s)
      leg.onDone = () => { lastDoor = d; next() }
      sound.prime?.(s.id)
      caption(`Down to ${s.title}`, languageName(speaks(s)))
    },
    listen (st) {
      const s = house(st.house)
      const d = lastDoor?.s === s ? lastDoor : door(s, ctl.pos)
      if (lastDoor?.s !== s) { ctl.pos.copy(d.at); lastDoor = d }
      const p = mix.speaking === s && clause ? clause : speak(s)
      // hold at the door, leaning in a little over the clause
      const from = ctl.pos.clone(), seconds = (hasNative(s) ? s.native_seconds : s.seconds) || 20
      const lean = blocked(from.x + d.u.x * 0.6, from.y, from.z + d.u.z * 0.6, 0.25, s.id) ? 0 : 0.6
      hold = { look: d.look, elapsed: 0, seconds, pos: u => from.clone().addScaledVector(d.u, lean * smooth(u)) }
      const me = state.stage
      p.then(async () => {
        if (!state.on || state.stage !== me) return
        mix.speaking = null
        await wait((st.beat ?? 1.5) * 1000)
        if (!state.on || state.stage !== me) return
        hold = null; next()
      })
    },
    glide (st) {
      const s = house(st.house)
      const A = lastDoor || door(s, ctl.pos)
      mix.bed = false; mix.near = [...new Set([...neighbours(A.s, 2), ...neighbours(s, 2)])]; world.highlight?.([s.id])
      const P0 = ctl.pos.clone()
      const d = door(s, P0)
      const P1 = overRoofs(P0.clone().addScaledVector(A.u, -2.5).setY(P0.y + 1.2))
      // the hop between the two doors clears every roof on the straight line between them
      let ridge = 0
      for (let i = 1; i < 12; i++) { const q = P1.clone().lerp(d.at, i / 12); ridge = Math.max(ridge, roofAt(q.x, q.z, 1.0)) }
      const mid = P1.clone().lerp(d.at, 0.5).setY(Math.max(st.height ?? 5.5, ridge + 1.5))
      const P3 = overRoofs(d.at.clone().addScaledVector(d.u, -3).setY(d.at.y + 1))
      leg = curveLeg([P0, P1, mid, P3, d.at], inOut, L => clamp(L / 1.5, 6, 14))
      leg.look = u => A.look.clone().lerp(d.look, smooth(clamp01((u - 0.1) / 0.7)))
      leg.speakAt = leg.seconds - (st.speak_before_arrival ?? 4)
      leg.onSpeak = () => speak(s)
      leg.onDone = () => { lastDoor = d; next() }
      sound.prime?.(s.id)
      caption(`Across to ${s.title}`, `from ${languageName(speaks(A.s))} to ${languageName(speaks(s))}`)
    },
    climb () {
      const B = lastDoor
      mix.bed = true; mix.speaking = null; world.highlight?.([])
      const P0 = ctl.pos.clone()
      const away = flat(P0.clone().sub(centre))
      if (away.lengthSq() < 1) away.copy(B ? B.u : V(1, 0, 0)).negate()
      away.normalize()
      const thEnd = Math.atan2(away.z, away.x) + dir * 0.5
      const Pend = onCircle(thEnd)
      const P1 = overRoofs(P0.clone().addScaledVector(B ? B.u : away, -4).setY(5))
      const P2 = P1.clone().lerp(Pend, 0.45).setY(orbit.height * 0.5)
      const P3 = Pend.clone().addScaledVector(tangent(thEnd), -orbitSpeed * 2.5); P3.y = orbit.height - 3
      leg = curveLeg([P0, P1, P2, P3, Pend], inQuad, L => clamp(2 * L / orbitSpeed, 12, 24))
      const look0 = B ? B.look : centre
      leg.look = u => look0.clone().lerp(centre, smooth(clamp01((u - 0.08) / 0.6)))
      leg.onDone = () => { theta = thEnd; next() }
      caption('Up and round again', flight.loop ? 'the flight circles the city once more' : '')
    }
  }

  const next = (fromJoin = false) => {
    if (!state.on) return
    if (!fromJoin) prevKind = state.kind
    state.stage += 1
    if (state.stage >= stages.length) {
      if (!flight.loop) { stop(); return }
      state.stage = 0; state.lap += 1
    }
    const st = stages[state.stage]
    state.kind = st.kind; state.house = st.house ? house(st.house) : null
    leg = null
    const fn = run[st.kind]
    if (!fn) { next(); return }
    fn(st, state.stage)
    flight.onStage?.(st, state.stage)
  }

  // ---- the clock
  let sawFrame = false, pump = 0, hooked = false, startedAt = 0
  const step = dt => {
    if (!state.on || sound.paused) return
    if (ctl.keys.size || (ctl.userAt || 0) > startedAt) { stop(); return }   // a key, a drag or a wheel takes the controls back
    const k = 1 - Math.exp(-dt * 3)
    if (leg) {
      leg.elapsed = Math.min(leg.seconds, leg.elapsed + dt)
      const t = leg.elapsed / leg.seconds
      const u = leg.law(t)
      ctl.pos.copy(leg.pos(u))
      lookPt.lerp(leg.look(u), k)
      state.remaining = leg.seconds - leg.elapsed
      if (leg.speakAt != null && !leg.spoke && leg.elapsed >= leg.speakAt) { leg.spoke = true; leg.onSpeak?.() }
      if (t >= 1) { const done = leg.onDone; leg = null; done?.() }
    } else if (hold) {
      hold.elapsed = Math.min(hold.seconds, hold.elapsed + dt)
      ctl.pos.copy(hold.pos(hold.elapsed / hold.seconds))
      lookPt.lerp(hold.look, k)
      state.remaining = 0
    }
    world.lookAtPoint(lookPt.x, lookPt.y, lookPt.z)
    ctl.mode = ctl.pos.y > 6 ? 'outside' : 'threshold'
    sound.spread?.(ctl.pos.y)
  }
  const hook = () => {
    if (!hooked) { hooked = true; const prev = world.onFrame; world.onFrame = dt => { sawFrame = true; prev?.(dt); step(dt) } }
    clearInterval(pump)
    pump = setInterval(() => {
      if (!state.on || !world.renderer.domElement.isConnected) { clearInterval(pump); return }
      if (!sawFrame) { step(0.1); world.applyCam?.() }
      sawFrame = false
    }, 100)
  }

  const start = () => {
    if (state.on || !stages.length) return
    state.on = true; state.stage = -1; state.lap = 0; prevKind = ''; lastDoor = null; hold = null; clause = null; startedAt = performance.now()
    mix.bed = true; mix.near = []; mix.speaking = null
    // the gaze starts where the camera already looks, so nothing snaps
    const f = V(); world.camera.getWorldDirection(f); lookPt.copy(ctl.pos).addScaledVector(f, 20)
    if (sound.enabled) { sound.focus(null); sound.direct?.(director) }
    hook()
    const th = angleOf(ctl.pos)
    if (ctl.pos.distanceTo(onCircle(th)) > 4) { state.stage = -1; state.kind = 'join'; run.join() } else { theta = th; next() }
  }
  const stop = () => {
    if (!state.on) return
    state.on = false; leg = null; hold = null; state.remaining = 0; clause = null
    clearInterval(pump); clearInterval(cueTimer)
    mix.speaking = null; world.highlight?.([])
    if (sound.enabled) { sound.direct?.(null); sound.focus(null) }
    sound.spread?.(null)
    flight.onStop?.()
  }
  Object.assign(flight, { start, stop, dispose () { stop() } })
  return flight
}
