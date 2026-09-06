// world.js — the place: geometry from map.json, camera and controls
import { nodesById, short } from './util.js'

// ------------------------------------------------------------------ world
export function buildWorld (three, root, map, speakers, squareId) {
  const stage = root.querySelector('.hear-stage')
  const renderer = new three.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
  renderer.shadowMap.enabled = false
  stage.appendChild(renderer.domElement)
  const scene = new three.Scene()
  scene.background = new three.Color(0xd9e4ec)
  scene.fog = new three.Fog(0xd9e4ec, 60, 260)
  const camera = new three.PerspectiveCamera(58, 1, 0.1, 600)

  // map units -> metres, set by the street itself: the mean distance from the
  // square to its houses becomes 12 m, so the street is walkable and audible
  // (the manifests' max_distance is 45 m).  y flips: SVG down, world -z north.
  const [vx, vy, vw, vh] = map.viewBox
  const sqNode = map.nodes.find(n => n.id === squareId)
  const houseNodes = (map.street?.houses || []).map(id => map.nodes.find(n => n.id === id)).filter(Boolean)
  const meanDist = sqNode && houseNodes.length
    ? houseNodes.reduce((t, n) => t + Math.hypot(n.x - sqNode.x, n.y - sqNode.y), 0) / houseNodes.length : 0
  const S = meanDist > 0 ? 12 / meanDist : 240 / vw
  const toWorld = (x, y) => [(x - vx - vw / 2) * S, -((y - vy - vh / 2) * S)]
  const nodePos = new Map(map.nodes.map(n => [n.id, toWorld(n.x, n.y)]))
  const heightOf = n => Math.max(1.2, Math.min(9, Math.log((n.story_length || 1) + 1) * 0.55 - 2))
  const speakerIds = new Set(speakers.map(s => s.id))

  scene.add(new three.HemisphereLight(0xffffff, 0x8899aa, 1.05))
  const sun = new three.DirectionalLight(0xfff2dc, 1.2); sun.position.set(60, 120, 40); scene.add(sun)
  const ground = new three.Mesh(new three.PlaneGeometry(2000, 2000), new three.MeshLambertMaterial({ color: 0xc9d8e3 }))
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; scene.add(ground)

  // regions: extruded polygons
  const regionColour = new Map()
  for (const r of map.regions) {
    const col = new three.Color(r.colour || '#8fa8bf')
    regionColour.set(r.id, col)
    const mat = new three.MeshLambertMaterial({ color: col.clone().lerp(new three.Color(0xffffff), 0.35) })
    for (const poly of r.polygons || []) {
      if (poly.length < 3) continue
      const shape = new three.Shape(poly.map(([x, y]) => { const [wx, wz] = toWorld(x, y); return new three.Vector2(wx, -wz) }))
      const geo = new three.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false })
      const mesh = new three.Mesh(geo, mat)
      mesh.rotation.x = -Math.PI / 2   // shape (x, y) -> world (x, -z), extruded up
      mesh.position.y = 0
      scene.add(mesh)
    }
  }

  // houses: one instanced mesh, speakers taller and outlined
  const box = new three.BoxGeometry(1, 1, 1)
  box.translate(0, 0.5, 0)
  const houses = new three.InstancedMesh(box, new three.MeshLambertMaterial({ color: 0xffffff }), map.nodes.length)
  const dummy = new three.Object3D()
  const index = []
  map.nodes.forEach((n, i) => {
    const [x, z] = nodePos.get(n.id)
    const h = heightOf(n)
    const w = speakerIds.has(n.id) ? 2.2 : 1.3
    dummy.position.set(x, 0.5, z); dummy.scale.set(w, h, w); dummy.updateMatrix()
    houses.setMatrixAt(i, dummy.matrix)
    const c = (regionColour.get(n.region) || new three.Color(0x8fa8bf)).clone().lerp(new three.Color(0x222222), 0.25)
    if (speakerIds.has(n.id)) c.set(0xb0432e)
    if (n.id === squareId) c.set(0xe0a44f)
    houses.setColorAt(i, c)
    index.push(n)
  })
  houses.instanceMatrix.needsUpdate = true
  if (houses.instanceColor) houses.instanceColor.needsUpdate = true
  scene.add(houses)

  // the square: a plaza disc
  const sq = map.nodes.find(n => n.id === squareId)
  const sqPos = sq ? nodePos.get(sq.id) : [0, 0]
  const plaza = new three.Mesh(new three.CylinderGeometry(4.5, 4.5, 0.7, 40), new three.MeshLambertMaterial({ color: 0xe8c78a }))
  plaza.position.set(sqPos[0], 0.5, sqPos[1]); scene.add(plaza)

  // roads: drawn edges thin, street roads thick and red
  const thin = [], thick = []
  for (const [a, b, , drawn, road] of map.edges) {
    const A = nodePos.get(map.nodes[a].id), B = nodePos.get(map.nodes[b].id)
    if (!A || !B) continue
    const seg = [A[0], 0.62, A[1], B[0], 0.62, B[1]]
    if (road) thick.push(...seg); else if (drawn) thin.push(...seg)
  }
  const mkLines = (arr, colour, opacity) => {
    const g = new three.BufferGeometry(); g.setAttribute('position', new three.Float32BufferAttribute(arr, 3))
    return new three.LineSegments(g, new three.LineBasicMaterial({ color: colour, transparent: true, opacity }))
  }
  if (thin.length) scene.add(mkLines(thin, 0x42586a, 0.25))
  if (thick.length) scene.add(mkLines(thick, 0xb0432e, 0.9))

  // labels for the speakers and the square (canvas sprites)
  const label = (text, x, y, z, big) => {
    const c = document.createElement('canvas'); const ctx = c.getContext('2d')
    ctx.font = `${big ? 44 : 34}px Helvetica, Arial`; const w = Math.ceil(ctx.measureText(text).width) + 24
    c.width = w; c.height = big ? 64 : 52
    ctx.font = `${big ? 44 : 34}px Helvetica, Arial`; ctx.fillStyle = 'rgba(244,248,251,.85)'; ctx.fillRect(0, 0, w, c.height)
    ctx.fillStyle = big ? '#7a2a1a' : '#2a3a48'; ctx.textBaseline = 'middle'; ctx.fillText(text, 12, c.height / 2)
    const tex = new three.CanvasTexture(c); tex.colorSpace = three.SRGBColorSpace
    const sp = new three.Sprite(new three.SpriteMaterial({ map: tex, depthTest: false }))
    sp.scale.set(w / 26, c.height / 26, 1); sp.position.set(x, y, z); scene.add(sp); return sp
  }
  for (const s of speakers) { const [x, z] = nodePos.get(s.id); const n = nodesById(map, s.id); label(short(s.title), x, heightOf(n) + 1.6, z, false) }
  if (sq) label(sq.title, sqPos[0], 3.2, sqPos[1], true)

  // camera + controls: yaw/pitch, WASD, above/threshold presets
  const ctl = { yaw: 0, pitch: -0.55, pos: new three.Vector3(sqPos[0], 14, sqPos[1] + 22), keys: new Set(), drag: null, mode: 'outside' }
  const applyCam = () => {
    camera.position.copy(ctl.pos)
    const dir = new three.Vector3(Math.sin(ctl.yaw) * Math.cos(ctl.pitch), Math.sin(ctl.pitch), -Math.cos(ctl.yaw) * Math.cos(ctl.pitch))
    camera.lookAt(camera.position.clone().add(dir))
  }
  const lookAtPoint = (x, y, z) => {
    const dx = x - ctl.pos.x, dy = y - ctl.pos.y, dz = z - ctl.pos.z
    ctl.yaw = Math.atan2(dx, -dz); ctl.pitch = Math.atan2(dy, Math.hypot(dx, dz))
  }
  const above = () => { ctl.pos.set(sqPos[0], 11, sqPos[1] + 16); lookAtPoint(sqPos[0], 0, sqPos[1]); ctl.mode = 'outside' }
  const threshold = id => {
    const [x, z] = nodePos.get(id); const n = nodesById(map, id)
    const dx = x - sqPos[0], dz = z - sqPos[1]; const d = Math.hypot(dx, dz) || 1
    ctl.pos.set(x - dx / d * 4.5, 1.7, z - dz / d * 4.5); lookAtPoint(x, heightOf(n) * 0.5, z); ctl.mode = 'threshold'
  }
  above()

  const el = renderer.domElement
  el.tabIndex = 0
  el.style.outline = 'none'
  el.style.touchAction = 'none'
  const onDown = e => { ctl.drag = { x: e.clientX, y: e.clientY, moved: false }; el.focus(); el.setPointerCapture?.(e.pointerId) }
  const onMove = e => {
    if (!ctl.drag) return
    const dx = e.clientX - ctl.drag.x, dy = e.clientY - ctl.drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) ctl.drag.moved = true
    ctl.yaw += dx * 0.005; ctl.pitch = Math.max(-1.4, Math.min(1.2, ctl.pitch - dy * 0.005))
    ctl.drag.x = e.clientX; ctl.drag.y = e.clientY
  }
  const ray = new three.Raycaster(); const ndc = new three.Vector2()
  const onUp = e => {
    const moved = ctl.drag?.moved; ctl.drag = null
    if (moved) return
    const r = el.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    const hit = ray.intersectObject(houses, false)[0]
    if (hit && hit.instanceId != null) world.onPick?.(index[hit.instanceId])
  }
  const onKey = (e, down) => {
    const k = e.key.toLowerCase()
    if ('wasdqe'.includes(k) || k.startsWith('arrow')) { if (down) ctl.keys.add(k); else ctl.keys.delete(k); e.preventDefault() }
  }
  el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp)
  // keys work whenever the pointer is over the place or something inside it has focus —
  // a listener who has just clicked a trial button must still be able to walk
  let hovering = false
  root.tabIndex = -1; root.style.outline = 'none'
  root.addEventListener('pointerenter', () => { hovering = true }); root.addEventListener('pointerleave', () => { hovering = false })
  const wants = e => root.isConnected && (hovering || root.contains(document.activeElement)) && !e.target.matches?.('input,textarea,select')
  const onWinKey = (e, down) => { if (!wants(e)) return; if (down && e.key.toLowerCase() === 'f' && !e.repeat) { toggleFull(); e.preventDefault(); return } onKey(e, down) }
  const onKD = e => onWinKey(e, true), onKU = e => onWinKey(e, false), onBlur = () => ctl.keys.clear()
  window.addEventListener('keydown', onKD); window.addEventListener('keyup', onKU); window.addEventListener('blur', onBlur)
  const toggleFull = () => { if (document.fullscreenElement === root) document.exitFullscreen?.(); else root.requestFullscreen?.().catch(() => {}) }
  root.querySelector('[data-act="full"]')?.addEventListener('click', toggleFull)
  root.querySelectorAll('.hear-pad button[data-key]').forEach(b => {
    const k = b.dataset.key
    const press = e => { e.preventDefault(); ctl.keys.add(k); b.classList.add('on'); b.setPointerCapture?.(e.pointerId) }
    const release = () => { ctl.keys.delete(k); b.classList.remove('on') }
    b.addEventListener('pointerdown', press); b.addEventListener('pointerup', release); b.addEventListener('pointercancel', release); b.addEventListener('lostpointercapture', release)
  })
  root.addEventListener('click', e => { if (e.target.closest('button,select,input,textarea')) return; root.focus({ preventScroll: true }) })

  const resize = () => {
    const r = stage.getBoundingClientRect()
    renderer.setSize(r.width, r.height, false)
    camera.aspect = r.width / r.height; camera.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(resize); ro.observe(stage); resize()

  let last = performance.now(); let raf = 0; let disposed = false
  const forward = new three.Vector3(), right = new three.Vector3()
  const world = {
    three, scene, camera, renderer, nodePos, heightOf, index, speakers, squareId, sqPos, ctl,
    above, threshold, lookAtPoint, applyCam, onPick: null, onFrame: null,
    dispose () {
      if (disposed) return
      disposed = true; cancelAnimationFrame(raf); ro.disconnect()
      window.removeEventListener('keydown', onKD); window.removeEventListener('keyup', onKU); window.removeEventListener('blur', onBlur)
      renderer.dispose(); el.remove()
    }
  }
  const tick = now => {
    if (disposed) return
    if (!root.isConnected) { root._hear?.dispose?.(); return }   // the wiki re-renders items without calling dispose
    raf = requestAnimationFrame(tick)
    const dt = Math.min(0.05, (now - last) / 1000); last = now
    const speed = (ctl.mode === 'outside' ? 14 : 5) * dt
    forward.set(Math.sin(ctl.yaw), 0, -Math.cos(ctl.yaw)); right.set(Math.cos(ctl.yaw), 0, Math.sin(ctl.yaw))
    const k = ctl.keys
    if (k.has('w') || k.has('arrowup')) ctl.pos.addScaledVector(forward, speed)
    if (k.has('s') || k.has('arrowdown')) ctl.pos.addScaledVector(forward, -speed)
    if (k.has('a') || k.has('arrowleft')) ctl.pos.addScaledVector(right, -speed)
    if (k.has('d') || k.has('arrowright')) ctl.pos.addScaledVector(right, speed)
    if (k.has('q')) ctl.pos.y += speed; if (k.has('e')) ctl.pos.y -= speed
    ctl.pos.y = Math.max(1.5, Math.min(120, ctl.pos.y))
    ctl.mode = ctl.pos.y > 6 ? 'outside' : (ctl.mode === 'inside' ? 'inside' : 'threshold')
    applyCam()
    world.onFrame?.(dt)
    renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(tick)
  return world
}

