// journey.js — the guided flight: a cue sheet of language zones (JOURNEY line)
//
// journey.json (radio-voice/hear/journey.py) is a list of zones, each with a
// mix (solo, pair, polyphonic, native), an allow-list of languages, a place in
// map coordinates, a height and a duration.  The flight carries the listener
// from zone to zone, setting the mix as it crosses into each, and on a zone
// with `descend` it drops to that house's threshold and listens to it from the
// top.  The rule the sheet obeys is the one on the Multilingual Mixes page: a
// zone begins pure and ends pure.  Any walking key stops the flight.  A hidden
// tab gets no animation frames, so the flight clocks itself like the walker.
const EASE = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2

export function makeJourney (world, sound, speakers, map, journey) {
  const { ctl } = world
  const [vx, vy, vw, vh] = map.viewBox
  // the world's own scale: recover it from a node we know the position of
  const probe = map.nodes[0]; const [px, pz] = world.nodePos.get(probe.id)
  const S = probe.x - vx - vw / 2 !== 0 ? px / (probe.x - vx - vw / 2) : 1
  const toWorld = (x, y) => [(x - vx - vw / 2) * S, -((y - vy - vh / 2) * S)]
  const state = { on: false, zone: -1, zoneName: '', remaining: 0, mix: null }
  const flight = { state, onZone: null, onZoneEnd: null, onStop: null, zones: journey?.zones || [], log: [] }
  let sawFrame = false, pump = 0, hooked = false, leg = null, sampler = 0
  // the zone log: what was intelligible, in which language, while the listener was in each zone — the machine's answer
  // to the trial's first question, and the record a human listener copies with theirs
  const sample = () => {
    if (!state.on || state.zone < 0 || !sound.enabled) return
    const z = flight.log[state.zone]; if (!z) return
    const tick = sound.lastTick || []
    for (const x of tick) { if (x.intelligible) { z.heard[x.language || 'en'] = (z.heard[x.language || 'en'] || 0) + 1; z.houses.add(x.title) } }
  }

  const hook = () => {
    if (!hooked) { hooked = true; const prev = world.onFrame; world.onFrame = dt => { sawFrame = true; prev?.(dt); step(dt) } }
    clearInterval(pump)
    pump = setInterval(() => { if (!state.on || !world.renderer.domElement.isConnected) { clearInterval(pump); return } if (!sawFrame) { step(0.1); world.applyCam?.() } sawFrame = false }, 100)
  }
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a))
  const step = dt => {
    if (!state.on || !leg || sound.paused) return
    if (ctl.keys.size) { stop(); return }
    leg.t = Math.min(1, leg.t + dt / leg.seconds)
    const k = EASE(leg.t)
    ctl.pos.x = leg.from[0] + (leg.to[0] - leg.from[0]) * k
    ctl.pos.z = leg.from[2] + (leg.to[2] - leg.from[2]) * k
    ctl.pos.y = leg.from[1] + (leg.to[1] - leg.from[1]) * k
    state.remaining = leg.seconds * (1 - leg.t)
    // look along the way, tilted down to the roofs; on a descent, at the door
    const dx = leg.to[0] - ctl.pos.x, dz = leg.to[2] - ctl.pos.z
    const wantYaw = Math.hypot(dx, dz) > 0.5 ? Math.atan2(dx, -dz) : ctl.yaw
    const wantPitch = leg.descend ? Math.atan2(1.4 - ctl.pos.y, Math.hypot(dx, dz) + 1) : -0.55
    ctl.yaw += wrap(wantYaw - ctl.yaw) * Math.min(1, 2.5 * dt)
    ctl.pitch += (wantPitch - ctl.pitch) * Math.min(1, 2 * dt)
    ctl.mode = ctl.pos.y > 6 ? 'outside' : 'threshold'
    if (leg.t >= 1) arrive()
  }
  const arrive = () => {
    const z = flight.zones[state.zone]
    leg = null
    if (z.descend) {
      const s = speakers.find(x => x.slug === z.descend)
      if (s) { world.threshold(s.id); if (sound.enabled) sound.listen(s.id).then(() => { if (state.on) stop() }); flight.onArrive?.(s) } else stop()
      return
    }
    // hold in the zone for its remaining seconds; then, if the HUD asks questions, wait for the answers before moving on
    setTimeout(async () => {
      if (!state.on) return
      const rec = flight.log[state.zone]; if (rec) rec.houses = [...rec.houses]
      if (flight.onZoneEnd) { try { await flight.onZoneEnd(z, state.zone, rec) } catch {} }
      if (!state.on) return
      if (state.zone < flight.zones.length - 1) next(); else stop()
    }, Math.max(1000, z.seconds * 400))
  }
  const next = () => {
    state.zone += 1
    const z = flight.zones[state.zone]
    if (!z) { stop(); return }
    state.zoneName = z.name; state.mix = { mode: z.mix, languages: z.languages || [] }
    sound.setMix?.(z.mix, z.languages || [])
    flight.log[state.zone] = { zone: state.zone + 1, name: z.name, mix: z.mix, languages: z.languages || [], seconds: z.seconds, heard: {}, houses: new Set(), started: new Date().toISOString() }
    const [wx, wz] = z.descend && speakers.find(x => x.slug === z.descend)
      ? (() => { const s = speakers.find(x => x.slug === z.descend); const [hx, hz] = world.nodePos.get(s.id); return [hx, hz] })()
      : toWorld(z.at[0], z.at[1])
    const to = z.descend ? (() => { const s = speakers.find(x => x.slug === z.descend); const [hx, hz] = world.nodePos.get(s.id); const dx = hx - ctl.pos.x, dz = hz - ctl.pos.z; const d = Math.hypot(dx, dz) || 1; return [hx - dx / d * 4.5, 1.7, hz - dz / d * 4.5] })() : [wx, z.height ?? 20, wz]
    leg = { from: [ctl.pos.x, ctl.pos.y, ctl.pos.z], to, seconds: Math.max(4, (z.seconds || 20) * 0.6), t: 0, descend: !!z.descend }
    state.remaining = leg.seconds
    flight.onZone?.(z, state.zone)
  }
  const start = () => {
    if (state.on || !flight.zones.length) return
    state.on = true; state.zone = -1; flight.log = []; hook(); next()
    clearInterval(sampler); sampler = setInterval(sample, 500)
  }
  const stop = () => {
    if (!state.on) return
    state.on = false; leg = null; state.remaining = 0; clearInterval(pump); clearInterval(sampler)
    for (const r of flight.log) if (r && r.houses instanceof Set) r.houses = [...r.houses]
    flight.onStop?.()
  }
  Object.assign(flight, { start, stop, next, dispose () { stop() } })
  return flight
}
