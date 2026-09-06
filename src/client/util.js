// util.js — small shared helpers for wiki-plugin-hear
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
export const nodesById = (map, id) => map.nodes.find(n => n.id === id)
export const short = t => t.length > 30 ? t.slice(0, 28) + '…' : t
export const asSlug = title => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
export const openPage = (div, title, site) => {
  if (window.wiki?.doInternalLink) window.wiki.doInternalLink(title, div.parents('.page'), site)
  else window.open(`https://${site}/view/${asSlug(title)}`, '_blank')
}
export const parseVtt = text => {
  const cues = []
  const t = s => { const [h, m, sec] = s.split(':'); return (+h) * 3600 + (+m) * 60 + parseFloat(sec) }
  for (const block of text.split(/\n\n+/)) {
    const lines = block.trim().split('\n')
    const i = lines.findIndex(l => l.includes('-->'))
    if (i < 0) continue
    const [a, b] = lines[i].split('-->').map(s => s.trim())
    cues.push({ start: t(a), end: t(b), text: lines.slice(i + 1).join(' ') })
  }
  return cues
}
