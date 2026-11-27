import db from './db.mjs'
import { normalPortraitUrl, artLocal } from './cards.mjs'
import { SINNER_NAMES } from './constants.mjs'

/**
 * 画廊（立绘墙）生成器。
 * 本地无 resources/art 缓存时全部走在线热链（artUrl），模板 onerror 隐藏加载失败的图并显示文字占位。
 * 中文统一使用 \u 转义，避免编辑器/传输链路的编码污染。
 */

const RANK_NAME = { 1: '\u4e00\u706f', 2: '\u4e8c\u706f', 3: '\u4e09\u706f' }
export const GALLERY_PAGE_SIZE = 12

/** 仅为当前页解析图片路径，避免一个请求加载整个人格图册。 */
export function buildGalleryPage(ids, page = 0, kind = '全部人格立绘') {
  db.load()
  const totalPages = Math.max(1, Math.ceil(ids.length / GALLERY_PAGE_SIZE))
  const current = Math.min(totalPages - 1, Math.max(0, Math.floor(Number(page) || 0)))
  const groups = []
  for (const id of ids.slice(current * GALLERY_PAGE_SIZE, (current + 1) * GALLERY_PAGE_SIZE)) {
    const p = db.getPersonality(id)
    if (!p) continue
    let group = groups.find(g => g.charId === p.charId)
    if (!group) {
      group = { charId: p.charId, charName: SINNER_NAMES[p.charId] || p.charName, items: [] }
      groups.push(group)
    }
    group.items.push(item(p))
  }
  return { kind: `${kind} · 第 ${current + 1}/${totalPages} 页`, groups, total: ids.length, page: current, totalPages }
}

function item (p) {
  const local = artLocal(p.id, 'normal')
  const src = local ? { local: true, path: local } : { local: false, url: normalPortraitUrl(p.id) }
  return {
    id: p.id,
    name: p.name || '\u4eba\u683c' + p.id,
    rank: p.rank ?? 1,
    rankName: RANK_NAME[p.rank] || '\u4e00\u706f',
    rankColor: { 1: '#a9a9a9', 2: '#dc143c', 3: '#ffd700' }[p.rank] || '#a9a9a9',
    season: p.season ?? 0,
    seasonLabel: (p.season ?? 0) >= 1000 ? '\u74e6\u591c' : '\u5b63\u8282' + (p.season ?? 0),
    src,
    local
  }
}

/** 全部人格 → 画廊（按罪人分组） */
export function buildGalleryAll (page = 0) {
  db.load()
  return buildGalleryPage(db.personalities.map(p => p.id).sort((a, b) => a - b), page)
}

/** 某罪人 → 画廊 */
export function buildGallerySinner (cid, page = 0) {
  db.load()
  const list = db.personalitiesOfSinner(cid)
  return buildGalleryPage(list.map(p => p.id), page, `${SINNER_NAMES[cid] || cid}的人格立绘`)
}

/** 随机一个人格立绘卡 */
export function buildGalleryRandom () {
  db.load()
  const list = db.personalities
  if (!list.length) return null
  const p = list[Math.floor(Math.random() * list.length)]
  return { kind: '\u968f\u673a\u4eba\u683c', groups: [{ charId: p.charId, charName: p.charName, items: [item(p)] }], total: 1 }
}
