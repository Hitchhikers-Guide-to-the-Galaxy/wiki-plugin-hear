// walk.js — the walker: carries the listener from house to house around the street
//
// Crude on purpose.  Every leg goes from where you stand to the rim of the
// square and from there to the target's threshold, because the street's roads
// all radiate from the square: a straight line by way of the square follows the
// red roads.  Houses are visited in a circuit by angle around the square,
// starting from the one nearest you.  Arrival is a place — the same threshold
// point Solo teleports to — and on arrival the house starts its clause from the
// top (sound.listen); the walker leaves a beat after the clause ends.  Any
// walking key hands control back to the listener.  A hidden tab gets no
// animation frames, so the walker clocks itself, as the Listening Trial does.
const SPEED = 3.2        // m/s, a brisk walk
const EYE = 1.7
const RIM = 5.5          // the plaza disc is 4.5 m; walk round it, not through the fountain
const ARRIVE = 0.25      // m: close enough to the waypoint
const BEAT_MS = 1200     // after the clause ends, before leaving
const SILENT_DWELL_MS = 6000   // when there are no voices, how long to stand at a door

export function makeWalk (world, sound, speakers, map) {
  const { ctl, nodePos, sqPos } = world
  const streetIds = new Set(map.street?.houses || [])
  let houses = speakers.filter(s => streetIds.has(s.id))
  if (houses.length < 2) houses = speakers.filter(s => dist(nodePos.get(s.id), sqPos) < 30)   // no street in the map: the houses round the square
  const angle = s => { const [x, z] = nodePos.get(s.id); return Math.atan2(z - sqPos[1], x - sqPos[0]) }
  const circuit = houses.slice().sort((a, b) => angle(a) - angle(b))
  const towards = id => { const [x, z] = nodePos.get(id); const dx = x - sqPos[0], dz = z - sqPos[1]; const d = Math.hypot(dx, dz) || 1; return [x, z, dx / d, dz / d, d] }
  const thresholdOf = id => { const [x, z, ux, uz] = towards(id); return [x - ux * 4.5, z - uz * 4.5] }
  const rimOf = id => { const [, , ux, uz] = towards(id); return [sqPos[0] + ux * RIM, sqPos[1] + uz * RIM] }

  const state = { on: false, phase: 'idle', target: null, i: -1, path: [], remaining: 0 }
  const walk = { state, circuit, onLeg: null, onArrive: null, onStop: null }
  let sawFrame = false, pump = 0, hooked = false, beat = 0

  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a))
  const step = dt => {
    if (!state.on || state.phase !== 'leg' || sound.paused) return
    if (ctl.keys.size) { stop(); return }   // the listener took over
    const [tx, tz] = state.path[0]
    const dx = tx - ctl.pos.x, dz = tz - ctl.pos.z; const d = Math.hypot(dx, dz)
    state.remaining = d + (state.path.length > 1 ? dist(state.path[0], state.path[1]) : 0)
    const move = Math.min(d, SPEED * dt)
    if (d > 1e-6) { ctl.pos.x += dx / d * move; ctl.pos.z += dz / d * move }
    ctl.pos.y += (EYE - ctl.pos.y) * Math.min(1, 3 * dt)
    // look where you are going; on the last metres of the final leg, look at the door
    let wantYaw = Math.atan2(dx, -dz), wantPitch = -0.05
    if (state.path.length === 1 && d < 5) {
      const [hx, hz] = nodePos.get(state.target.id)
      const ex = hx - ctl.pos.x, ez = hz - ctl.pos.z
      wantYaw = Math.atan2(ex, -ez); wantPitch = Math.atan2(1.4 - ctl.pos.y, Math.hypot(ex, ez))
    }
    ctl.yaw += wrap(wantYaw - ctl.yaw) * Math.min(1, 4 * dt)
    ctl.pitch += (wantPitch - ctl.pitch) * Math.min(1, 3 * dt)
    if (d <= ARRIVE) { state.path.shift(); if (!state.path.length) arrive() }
  }

  const arrive = () => {
    const s = state.target
    const [hx, hz] = nodePos.get(s.id)
    world.lookAtPoint(hx, world.heightOf(nodeOf(s.id)) * 0.5, hz)
    ctl.mode = 'threshold'
    state.phase = 'listening'; state.remaining = 0
    walk.onArrive?.(s)
    const settled = sound.enabled ? sound.listen(s.id) : wait(SILENT_DWELL_MS).then(() => true)
    settled.then(ended => {
      if (!state.on || state.target !== s || state.phase !== 'listening') return
      if (ended === false) return   // interrupted: someone else took the voice
      clearTimeout(beat)
      beat = setTimeout(() => { if (state.on && state.target === s && state.phase === 'listening') next() }, BEAT_MS)
    })
  }
  const nodeOf = id => world.index.find(n => n.id === id)
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
  const wait = ms => new Promise(r => setTimeout(r, ms))

  const hook = () => {
    if (!hooked) {
      hooked = true
      const prev = world.onFrame
      world.onFrame = dt => { sawFrame = true; prev?.(dt); step(dt) }
    }
    clearInterval(pump)
    pump = setInterval(() => {
      if (!state.on || !world.renderer.domElement.isConnected) { clearInterval(pump); return }
      if (!sawFrame) { step(0.1); world.applyCam?.() }
      sawFrame = false
    }, 100)
  }

  const next = () => {
    if (!circuit.length) return
    if (!state.on) { state.on = true; hook() }
    clearTimeout(beat)
    state.i = (state.i + 1) % circuit.length
    state.target = circuit[state.i]
    const here = [ctl.pos.x, ctl.pos.z]
    const th = thresholdOf(state.target.id)
    // by way of the square unless you are already on it or the door is nearer than the rim
    state.path = dist(here, sqPos) <= RIM + 0.5 || dist(here, th) < dist(here, rimOf(state.target.id)) ? [th] : [rimOf(state.target.id), th]
    state.phase = 'leg'; state.remaining = state.path.reduce((t, p, i) => t + dist(i ? state.path[i - 1] : here, p), 0)
    ctl.mode = 'threshold'
    sound.prime?.(state.target.id)
    walk.onLeg?.(state.target, state.remaining)
  }
  const start = () => {
    if (state.on || !circuit.length) return
    // begin with the house nearest to where you stand
    const here = [ctl.pos.x, ctl.pos.z]
    let best = 0, bd = Infinity
    circuit.forEach((s, i) => { const d = dist(here, thresholdOf(s.id)); if (d < bd) { bd = d; best = i } })
    state.i = (best - 1 + circuit.length) % circuit.length
    state.on = true; hook(); next()
  }
  const stop = () => {
    if (!state.on) return
    state.on = false; state.phase = 'idle'; state.target = null; state.path = []; state.remaining = 0
    clearTimeout(beat); clearInterval(pump)
    walk.onStop?.()
  }
  Object.assign(walk, { start, stop, next, thresholdOf, dispose () { stop() } })
  return walk
}
