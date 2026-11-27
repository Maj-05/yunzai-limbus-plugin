import { DB } from '../lib/db.mjs'
import { translateStatus } from '../lib/constants.mjs'

const KINDS = {
  personality: ['personalities', 'searchPersonality', 'getPersonality'],
  ego: ['egos', 'searchEgo', 'getEgo'],
  enemy: ['enemies', 'searchEnemy', 'getEnemy'],
  gift: ['egogifts', 'searchGift', 'getGift']
}
const ALIASES = { 人格: 'personality', 身份: 'personality', ego: 'ego', 'e.g.o': 'ego', 敌人: 'enemy', 饰品: 'gift' }
const HELP = '边狱图鉴：人格 <名称/ID>、ego <名称/ID>、敌人 <名称/类型>、饰品 <名称/ID>、状态 <名称>、图鉴状态。列表可加“第2页”，如：人格 李箱 第2页。精确ID返回详情。'

function integer(value, fallback, min, max) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`参数必须是 ${min}–${max} 的整数`)
  return value
}
function text(value, max = 200) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`查询必须是长度不超过 ${max} 的文本`)
  return value.trim()
}

/** Host-independent, read-only API. No global plugin, logger, browser or network required. */
export class LimbusService {
  constructor(database = new DB({ logger: null })) { this.db = database }
  ready() { if (!this.db.load()) throw new Error('图鉴数据加载失败，请检查本地数据文件') }
  stats() { this.ready(); return this.db.stats() }
  query({ kind = 'personality', query = '', page = 1, pageSize = 8 } = {}) {
    if (!Object.hasOwn(KINDS, kind)) throw new Error('未知图鉴类型')
    const q = text(query)
    page = integer(page, 1, 1, 10000)
    pageSize = integer(pageSize, 8, 1, 20)
    this.ready()
    const [collection, search, get] = KINDS[kind]
    let records
    const sinner = ['personality', 'ego'].includes(kind) && this.db.resolveSinner(q)
    const enemyType = kind === 'enemy' && this.db.enemyTypeKeyword(q)
    if (!q) records = this.db[collection]
    else if (sinner) records = kind === 'personality' ? this.db.personalitiesOfSinner(sinner) : this.db.egosOfSinner(sinner)
    else if (enemyType) records = this.db.enemiesOfType(enemyType.type).map(id => this.db[get](id))
    else records = this.db[search](q, this.db[collection].length).map(id => this.db[get](id)).filter(Boolean)
    const exact = /^\d+$/.test(q) ? records.find(r => String(r.id) === q) : (!sinner && records.find(r => r.name?.replace(/\s/g, '') === q.replace(/\s/g, '')))
    if (exact || records.length === 1) return { type: 'detail', kind, record: this.detail(kind, (exact || records[0]).id) }
    const total = records.length
    const pages = Math.max(1, Math.ceil(total / pageSize))
    page = Math.min(page, pages)
    return { type: 'list', kind, query: q, total, page, pages, pageSize,
      items: records.slice((page - 1) * pageSize, page * pageSize).map(({ id, name, charName, rank, grade, type }) => ({ id, name, charName, rank, grade, type })) }
  }
  detail(kind, id) {
    this.ready()
    const config = KINDS[kind]
    if (!config) throw new Error('未知图鉴类型')
    const record = this.db[config[2]](id)
    if (!record) throw new Error('没有找到该 ID')
    // Clone so callers cannot mutate the shared database through API results.
    const out = structuredClone(record)
    out.skills = (record.skills || []).map(s => ({ ...s, text: this.db.skillText(s.skillId) }))
    out.passives = (record.passives || []).map(p => ({ ...p, text: this.db.passiveText(p.id) }))
    if (record.defense) out.defense = { ...record.defense, text: this.db.skillText(record.defense.skillId) }
    if (record.awakenSkillId) out.awaken = this.db.skillText(record.awakenSkillId)
    if (record.corrodeSkillId) out.corrode = this.db.skillText(record.corrodeSkillId)
    return structuredClone(out)
  }
  command(input) {
    let value = text(input, 512).replace(/^[#/]/, '').replace(/^(?:limbus|边狱|巴士)\s*/i, '').trim()
    if (!value || /^(帮助|help)$/i.test(value)) return { type: 'text', text: HELP }
    if (/^(?:图鉴状态|状态统计)$/i.test(value)) return { type: 'stats', stats: this.stats() }
    const match = value.match(/^(人格|身份|ego|e\.g\.o|敌人|饰品|状态)\s*(.*)$/i)
    if (!match) return { type: 'text', text: `未识别指令。${HELP}` }
    let query = match[2].trim()
    if (match[1] === '状态') {
      // This optional manual dataset uses the same safe injected reader as the database.
      const statuses = this.db.reader('statuses') || []
      const item = statuses.find(s => s.name === query || s.key === query)
      return { type: 'text', text: item ? `【${item.name}】\n${item.desc || ''}` : '未找到状态，请输入完整状态名，如：状态 烧伤' }
    }
    const pm = query.match(/\s+第(\d+)页$/)
    const page = pm ? Number(pm[1]) : 1
    if (pm) query = query.slice(0, pm.index).trim()
    return this.query({ kind: ALIASES[match[1].toLowerCase()], query, page })
  }
}

export function formatResult(result) {
  if (result.type === 'text') return result.text
  if (result.type === 'stats') return '【图鉴统计】\n' + Object.entries(result.stats).map(([k, v]) => `${k}: ${v ?? '未知'}`).join('\n')
  if (result.type === 'list') return result.total ? `【${result.kind}】共 ${result.total} 条 · 第 ${result.page}/${result.pages} 页\n` + result.items.map((r, i) => `${i + 1}. ${r.name}（ID ${r.id}）`).join('\n') + '\n输入类型 + ID 查看详情；查询后加“第N页”翻页。' : '没有找到相关条目。'
  const r = result.record
  const lines = [`【${r.name}】 ID ${r.id}`, [r.charName, r.rank ? `${r.rank}灯` : '', r.grade].filter(Boolean).join(' · '), r.desc || '']
  for (const s of r.skills || []) lines.push(`技能：${s.text?.name || s.skillId}`, s.text?.desc || '', `基础 ${s.base ?? '?'} / 硬币 ${s.coin ?? '?'} / 硬币威力 ${s.coinPower ?? '?'}`)
  for (const s of [r.defense?.text, r.awaken, r.corrode].filter(Boolean)) lines.push(s.name, s.desc)
  for (const p of r.passives || []) lines.push(`被动：${p.text?.name || p.id}`, p.text?.desc || '')
  return translateStatus(lines.filter(Boolean).join('\n')).slice(0, 16000)
}
