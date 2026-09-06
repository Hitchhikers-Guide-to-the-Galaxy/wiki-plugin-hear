// voice-chain-air.js — an example voice chain for wiki-plugin-hear's MODULE line.
//
// The plugin calls createVoiceChain(ctx, voice, policy) once per voice when its
// audio graph is built, connects the voice's signal (already panned by the
// listener and murmured by the intelligibility low-pass) to `input`, and takes
// `output` to the bus.  Every ~150 ms it calls update() with the listener's
// distance in metres, whether the listener faces the house, whether the voice is
// intelligible, the acoustic scale, and the policy score.  Return dispose() to
// release anything you made.  Nothing here touches the plugin's own gain, pan
// or level budget: those stay the policy's.
//
// This example does three things a flat field lacks: air absorption (the far
// voice loses its top), a room that grows with distance (a short feedback delay
// at low level), and a little body when a voice is close (a low shelf).  It is
// a starting point, not a mix.

export function createVoiceChain (ctx, voice, policy) {
  const input = ctx.createGain()
  const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = 16000; air.Q.value = 0.5
  const body = ctx.createBiquadFilter(); body.type = 'lowshelf'; body.frequency.value = 220; body.gain.value = 0
  const dry = ctx.createGain(); dry.gain.value = 1
  const send = ctx.createGain(); send.gain.value = 0
  const delay = ctx.createDelay(1.0); delay.delayTime.value = 0.09 + (hash(voice.slug) % 40) / 1000   // 90–130 ms, per house
  const fb = ctx.createGain(); fb.gain.value = 0.35
  const damp = ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2500
  const output = ctx.createGain()
  input.connect(air); air.connect(body); body.connect(dry); dry.connect(output)
  body.connect(send); send.connect(delay); delay.connect(damp); damp.connect(fb); fb.connect(delay); damp.connect(output)
  const ramp = (p, v, s = 0.2) => { const t = ctx.currentTime; p.cancelScheduledValues(t); p.setTargetAtTime(v, t, s) }
  return {
    input, output,
    update ({ distance, intelligible, facing, lod }) {
      const d = Math.min(45, Math.max(0, distance))
      ramp(air.frequency, 16000 * Math.pow(0.5, d / 9) + 400)          // −6 dB an octave down every 9 m
      ramp(body.gain, d < 6 ? (6 - d) * 0.8 : 0)                       // warmth inside 6 m
      ramp(send.gain, intelligible ? 0.05 : Math.min(0.35, d / 60))    // the far crowd sits in a room
      ramp(fb.gain, lod === 'region' ? 0.5 : 0.35)
      ramp(dry.gain, 1 - Math.min(0.25, d / 120))
    },
    dispose () { for (const n of [input, air, body, dry, send, delay, fb, damp, output]) { try { n.disconnect() } catch {} } }
  }
}

function hash (s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h }
