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

  // footprints from the city's own grain (0.9.0).  GMap packs pages about a metre apart (median nearest neighbour 0.94 m
  // at street scale on the legalcommons map), so fixed 2.2 m and 1.3 m boxes overlapped into one plateau that hid every
  // street.  Each house now takes a share of the distance to its nearest neighbour, never more than the old sizes, so a
  // sparse map looks as it did and a dense one shows its lanes.
  const nearest = new Map()
  {
    const pts = map.nodes.map(n => [n.id, ...nodePos.get(n.id)])
    for (const [id, x, z] of pts) { let d = Infinity; for (const [id2, x2, z2] of pts) if (id2 !== id) { const e = (x - x2) ** 2 + (z - z2) ** 2; if (e < d) d = e } nearest.set(id, Math.sqrt(d)) }
  }
  const widthOf = n => { const sp = speakerIds.has(n.id); return Math.max(0.35, Math.min(sp ? 2.2 : 1.3, (nearest.get(n.id) ?? 9) * (sp ? 0.75 : 0.62))) }

  // houses: one instanced mesh, speakers taller and outlined
  const box = new three.BoxGeometry(1, 1, 1)
  box.translate(0, 0.5, 0)
  const houses = new three.InstancedMesh(box, new three.MeshLambertMaterial({ color: 0xffffff }), map.nodes.length)
  const dummy = new three.Object3D()
  const index = []
  map.nodes.forEach((n, i) => {
    const [x, z] = nodePos.get(n.id)
    const h = heightOf(n)
    const w = widthOf(n)
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
  // the house you are going to, or hearing, is lit gold: a red speaking house in a red region otherwise disappears
  // into the ground from its own door (seen on the first flight test at Paraguay)
  const baseColour = new Map()
  let litHouses = []
  const gold = new three.Color(0xffd27a)
  const highlight = ids => {
    for (const i of litHouses) houses.setColorAt(i, baseColour.get(i))
    litHouses = []
    const c = new three.Color()
    for (const id of ids || []) {
      const i = index.findIndex(n => n.id === id); if (i < 0) continue
      if (!baseColour.has(i)) { houses.getColorAt(i, c); baseColour.set(i, c.clone()) }
      houses.setColorAt(i, gold); litHouses.push(i)
    }
    if (houses.instanceColor) houses.instanceColor.needsUpdate = true
  }

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

  // names (0.9.0): no carpet of labels over the city.  A small sprite per house, made on first need, a constant size
  // on screen, hidden behind buildings, faded with distance.  By default only the square and the houses speaking
  // clearly now carry a name, so the city's own shape shows; "all" names the speaking houses near you; "off" nothing.
  const smooth01 = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }
  const sprites = new Map()
  const makeLabel = (text, big) => {
    const c = document.createElement('canvas'); const g = c.getContext('2d')
    const px = big ? 40 : 32
    g.font = `600 ${px}px Helvetica, Arial`; const w = Math.ceil(g.measureText(text).width) + 28
    c.width = w; c.height = Math.round(px * 1.6)
    g.font = `600 ${px}px Helvetica, Arial`; g.fillStyle = 'rgba(13,18,25,.74)'
    const r = c.height / 2
    g.beginPath(); g.moveTo(r, 0); g.lineTo(w - r, 0); g.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2); g.lineTo(r, c.height); g.arc(r, r, r, Math.PI / 2, Math.PI * 1.5); g.fill()
    g.fillStyle = big ? '#f3c77a' : '#f4f8fb'; g.textBaseline = 'middle'; g.fillText(text, 14, c.height / 2 + 1)
    const tex = new three.CanvasTexture(c); tex.colorSpace = three.SRGBColorSpace
    const sp = new three.Sprite(new three.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true, opacity: 0, sizeAttenuation: false }))
    const hgt = big ? 0.042 : 0.034   // a share of the view's height, whatever the distance
    sp.scale.set(hgt * w / c.height, hgt, 1); sp.center.set(0.5, 0); sp.renderOrder = 2; sp.visible = false
    scene.add(sp); return sp
  }
  const labelOf = id => {
    if (sprites.has(id)) return sprites.get(id)
    const n = nodesById(map, id); const p = nodePos.get(id)
    if (!n || !p) return null
    const sp = makeLabel(id === squareId ? n.title : short(n.title), id === squareId)
    sp.position.set(p[0], (id === squareId ? 1.2 : heightOf(n)) + 0.6, p[1])
    sprites.set(id, sp); return sp
  }
  const labels = {
    mode: 'speaking', lit: new Set(), onChange: null,
    setMode (m) { labels.mode = ['off', 'speaking', 'all'].includes(m) ? m : 'speaking'; labels.onChange?.(labels.mode) },
    cycle () { labels.setMode({ off: 'speaking', speaking: 'all', all: 'off' }[labels.mode]) },
    setLit (ids) { labels.lit = new Set(ids || []) }
  }
  const updateLabels = dt => {
    const show = new Set()
    if (labels.mode !== 'off') {
      if (squareId) show.add(squareId)
      for (const id of labels.lit) show.add(id)
      if (labels.mode === 'all') for (const s of speakers) { const p = nodePos.get(s.id); if (p && Math.hypot(p[0] - camera.position.x, p[1] - camera.position.z) < 30) show.add(s.id) }
    }
    for (const id of show) labelOf(id)
    const k = Math.min(1, dt * 5)
    const far = labels.mode === 'all' ? 30 : 90
    for (const [id, sp] of sprites) {
      const d = sp.position.distanceTo(camera.position)
      const want = show.has(id) ? 1 - smooth01((d - far * 0.65) / (far * 0.35)) : 0
      sp.material.opacity += (want - sp.material.opacity) * k
      sp.visible = sp.material.opacity > 0.02
    }
  }

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
  const onDown = e => { ctl.drag = { x: e.clientX, y: e.clientY, moved: false }; el.focus({ preventScroll: true }); el.setPointerCapture?.(e.pointerId) }
  const onMove = e => {
    if (!ctl.drag) return
    const dx = e.clientX - ctl.drag.x, dy = e.clientY - ctl.drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) { ctl.drag.moved = true; ctl.userAt = performance.now() }
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
  // a trackpad or wheel moves you over the ground (a pinch moves you up and down) and never scrolls the page, or swipes
  // the browser back, underneath the place
  const onWheel = e => {
    e.preventDefault()
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    const dx = e.deltaX * unit, dy = e.deltaY * unit
    const rate = Math.max(0.02, ctl.pos.y * 0.004)
    if (e.ctrlKey) ctl.pos.y = Math.max(1.5, Math.min(120, ctl.pos.y + dy * rate * 2))
    else {
      ctl.pos.x += (Math.cos(ctl.yaw) * dx - Math.sin(ctl.yaw) * dy) * rate
      ctl.pos.z += (Math.sin(ctl.yaw) * dx + Math.cos(ctl.yaw) * dy) * rate
    }
    ctl.userAt = performance.now()
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  // keys work whenever the pointer is over the place or something inside it has focus —
  // a listener who has just clicked a trial button must still be able to walk
  let hovering = false
  root.tabIndex = -1; root.style.outline = 'none'
  root.addEventListener('pointerenter', () => { hovering = true }); root.addEventListener('pointerleave', () => { hovering = false })
  const wants = e => root.isConnected && (inTheatre() || hovering || root.contains(document.activeElement)) && !e.target.matches?.('input,textarea,select')
  const onWinKey = (e, down) => {
    if (!wants(e)) return
    const k = e.key.toLowerCase()
    if (down && !e.repeat && k === 'f') { if (inTheatre()) { if (fsEl()) exitFs(); else requestFs() } else full(); e.preventDefault(); return }
    if (down && !e.repeat && k === 'l') { labels.cycle(); e.preventDefault(); return }
    if (down && k === 'escape' && inTheatre() && !fsEl()) { leaveTheatre(); e.preventDefault(); return }
    onKey(e, down)
  }
  const onKD = e => onWinKey(e, true), onKU = e => onWinKey(e, false), onBlur = () => ctl.keys.clear()
  window.addEventListener('keydown', onKD); window.addEventListener('keyup', onKU); window.addEventListener('blur', onBlur)

  // the stage that holds (0.9.0).  Full screen first lifts the place out of the wiki's lineup into a window-sized layer
  // on the body, so nothing the wiki does to its item (a re-render, the editor, a page opened beside it, the lineup
  // scrolling) can detach it; then it asks the browser for full screen on top.  Leaving the browser's full screen (Esc,
  // F, a gesture, the system) keeps the theatre: the place still fills the window.  Esc again, the button or Close put
  // the place back where it was on the page.
  let home = null
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null
  const requestFs = () => { try { const p = (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root); p?.catch?.(() => {}) } catch {} }
  const exitFs = () => { try { const p = (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); p?.catch?.(() => {}) } catch {} }
  const inTheatre = () => root.classList.contains('hear-theatre')
  const enterTheatre = () => {
    if (inTheatre()) return
    home = document.createElement('div'); home.className = 'hear-home'; home.style.height = root.style.height || '520px'
    home.textContent = 'The place is open full screen. Esc, or the button, brings it back here.'
    root.before(home)
    document.body.appendChild(root)
    root.classList.add('hear-theatre'); document.documentElement.classList.add('hear-theatre-on')
    root.focus({ preventScroll: true })
    world.onTheatre?.(true, !!fsEl())
  }
  const leaveTheatre = () => {
    if (!inTheatre()) return
    if (fsEl() === root) exitFs()
    root.classList.remove('hear-theatre'); document.documentElement.classList.remove('hear-theatre-on')
    const back = home; home = null
    if (back?.isConnected) back.replaceWith(root)
    else { back?.remove(); root._hear?.dispose?.(); root.remove(); return }   // the wiki re-rendered the item meanwhile: its new copy stands in
    world.onTheatre?.(false, false)
  }
  const full = () => { enterTheatre(); requestFs() }
  const onFsChange = () => world.onTheatre?.(inTheatre(), fsEl() === root)
  document.addEventListener('fullscreenchange', onFsChange); document.addEventListener('webkitfullscreenchange', onFsChange)
  root.querySelector('[data-act="full"]')?.addEventListener('click', () => { if (inTheatre()) leaveTheatre(); else full() })
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
    above, threshold, lookAtPoint, applyCam, onPick: null, onFrame: null, onTheatre: null, labels,
    widthOf,   // a house's footprint, as built above
    highlight,
    theatre: { enter: enterTheatre, leave: leaveTheatre, full, get on () { return inTheatre() }, get fullscreen () { return fsEl() === root } },
    dispose () {
      if (disposed) return
      disposed = true; cancelAnimationFrame(raf); ro.disconnect()
      window.removeEventListener('keydown', onKD); window.removeEventListener('keyup', onKU); window.removeEventListener('blur', onBlur)
      document.removeEventListener('fullscreenchange', onFsChange); document.removeEventListener('webkitfullscreenchange', onFsChange)
      el.removeEventListener('wheel', onWheel)
      if (inTheatre()) { if (fsEl() === root) exitFs(); root.classList.remove('hear-theatre'); document.documentElement.classList.remove('hear-theatre-on'); home?.remove() }
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
    updateLabels(dt)
    renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(tick)
  return world
}

