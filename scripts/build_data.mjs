/**
 * 构建脚本：合并 LimbusStaticData（数值）+ LocalizeLimbusCompany（中文文本）
 * → resources/data/{personalities,egos,enemies,egogifts,skills,passives,meta}.json
 *
 * 由 apps/update.js 调用：buildAll(upstreamDir, outDir)
 * 也可独立运行：node scripts/build_data.mjs [upstreamDir]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..')

const SINNER_NAMES = {
  1: '李箱', 2: '浮士德', 3: '堂吉诃德', 4: '良秀',
  5: '默尔索', 6: '鸿璐', 7: '希斯克利夫', 8: '以实玛利',
  9: '罗佳', 10: '辛克莱', 11: '奥提斯', 12: '格里高尔'
}

const ATK = { SLASH: 'SLASH', PENETRATE: 'PENETRATE', HIT: 'HIT' }
const DEF_TYPES = { EVADE: 'EVADE', GUARD: 'GUARD', COUNTER: 'COUNTER' }

function readJson(p) {
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (error) {
    throw new Error(`无法解析本地数据 ${path.basename(p)}: ${error.message}`)
  }
}

function list(json) {
  if (!json) return []
  return json.list || json.dataList || []
}

/** 安全读目录：目录不存在或读取失败返回 []，避免单个上游子目录缺失让整个构建崩溃 */
function listDir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 在 SD/static-data 下按目录名特征自动发现数据目录（不依赖固定名字，上游改名也能扫到）。
 * 返回匹配到的全部子目录绝对路径（排除文件、排除 .git 等）。pattern 为目录名正则。
 */
function findDirs(base, pattern) {
  const out = []
  for (const name of listDir(base)) {
    if (pattern.test(name)) {
      const p = path.join(base, name)
      try { if (fs.statSync(p).isDirectory()) out.push(p) } catch {}
    }
  }
  return out
}

/**
 * 敌人类型推导。上游数值源（abnormality-unit）无独立 type 字段时，
 * 用中文文本表 Enemies.json 的 desc 与 id 结构分类：
 *   - desc 含「本体」→ 异常体本体（abno）
 *   - desc 含「部位」→ 异常体部位（part）
 *   - desc 含「头目」→ 人类·头目（human_boss）
 *   - desc 含「单位」→ 人类·单位（human）
 *   - desc 为空时按 id 兜底：6 位及以上=部位；5 位且以 9 开头=人类单位；否则=异常体本体
 */
function enemyType(t, id) {
  const d = (t.desc || '').trim()
  if (d.includes('本体')) return 'abno'
  if (d.includes('部位')) return 'part'
  if (d.includes('头目')) return 'human_boss'
  if (d.includes('单位')) return 'human'
  const s = String(id)
  if (s.length >= 6) return 'part'
  if (s.length >= 5 && s[0] === '9') return 'human'
  return 'abno'
}

/** 文本表 → Map<id, item>（skills/passives 的 dataList 是数组带 id） */
function textMap(json) {
  const m = {}
  for (const it of list(json)) m[it.id] = it
  return m
}

export function resolveRefDir (configured) {
  return path.resolve(process.env.LIMBUS_REF_DIR || configured || path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'limbus-ref'))
}

export function skillDescription (record) {
  const levels = [...(record.levelList || [])].sort((a, b) => (b.level || 0) - (a.level || 0))
  const text = levels[0] || record
  return { name: text.name || '', desc: [text.desc || '', ...(text.coinlist || []).flatMap(c => (c.coindescs || []).map(d => d.desc || ''))].filter(Boolean).join('\n') }
}

export function publishSnapshot (outDir, payload) {
  const parent = path.dirname(path.resolve(outDir))
  fs.mkdirSync(parent, { recursive: true })
  for (const name of ['personalities', 'egos', 'enemies', 'egogifts']) {
    const rows = payload[name]
    if (!Array.isArray(rows) || !rows.length) throw new Error(`${name} 为空，保留旧数据`)
    if (new Set(rows.map(r => r.id)).size !== rows.length || rows.some(r => !Number.isSafeInteger(r.id) || r.id < 0)) throw new Error(`${name} ID 无效或重复`)
    const old = readJson(path.join(outDir, name + '.json'))
    if (old?.length && rows.length < old.length * .9) throw new Error(`${name} 记录数量异常减少，保留旧数据`)
  }
  if (!Object.keys(payload.skills || {}).length || !Object.keys(payload.passives || {}).length) throw new Error('技能或被动文本为空，保留旧数据')
  const stage = fs.mkdtempSync(path.join(parent, '.limbus-stage-'))
  const backup = stage + '-previous'
  let moved = false
  try {
    if (fs.existsSync(outDir)) fs.cpSync(outDir, stage, { recursive: true })
    for (const [name, value] of Object.entries(payload)) fs.writeFileSync(path.join(stage, name + '.json'), JSON.stringify(value))
    if (fs.existsSync(outDir)) { fs.renameSync(outDir, backup); moved = true }
    try { fs.renameSync(stage, outDir) } catch (error) { if (moved) fs.renameSync(backup, outDir); throw error }
    if (moved) fs.rmSync(backup, { recursive: true, force: true })
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }) }
}

export function mergeLocalTexts (payload, refDir) {
  const cn = path.join(refDir, 'CN')
  for (const file of listDir(cn).filter(f => /^Skills.*\.json$/i.test(f)).sort()) {
    for (const record of list(readJson(path.join(cn, file)))) {
      const incoming = skillDescription(record)
      const old = payload.skills[record.id] || {}
      payload.skills[record.id] = { ...old, name: incoming.name || old.name || '', desc: incoming.desc || old.desc || '' }
    }
  }
  for (const record of list(readJson(path.join(cn, 'Passives.json')))) {
    const old = payload.passives[record.id] || {}
    payload.passives[record.id] = { ...old, name: record.name || old.name || '', desc: record.desc || old.desc || '' }
  }
}

export async function buildAll (upstreamDir, outDir, options = {}) {
  const SD = path.join(upstreamDir, 'LimbusStaticData', 'StaticData', 'static-data')
  const CN = path.join(upstreamDir, 'LocalizeLimbusCompany', 'LLC_zh-CN')
  const refDir = resolveRefDir(options.localRefDir)

  if (!fs.existsSync(SD) || !fs.existsSync(CN)) {
    const payload = Object.fromEntries(['personalities', 'egos', 'enemies', 'egogifts', 'skills', 'passives', 'meta'].map(name => [name, readJson(path.join(outDir, name + '.json'))]))
    if (!payload.skills || !payload.passives) throw new Error('缺少本地数据快照；请先配置本地上游数据')
    // EGOgift category tables contain status keys rather than actual gift IDs.
    if (Array.isArray(payload.egogifts)) payload.egogifts = payload.egogifts.filter(row => Number.isSafeInteger(row.id) && row.id >= 0)
    mergeLocalTexts(payload, refDir)
    // Keep the original source date: a local rebuild is not a fresh upstream release.
    payload.meta = { ...payload.meta, rebuiltAt: new Date().toISOString() }
    publishSnapshot(outDir, payload)
    return { ...Object.fromEntries(['personalities', 'egos', 'enemies', 'egogifts'].map(n => [n, payload[n].length])), diag: ['使用本地快照；未联网更新'], local: true }
  }

  // ===== 文本表 =====
  const tPers = list(readJson(path.join(CN, 'Personalities.json')))
  const tEgos = list(readJson(path.join(CN, 'Egos.json')))
  const tSkills = textMap(readJson(path.join(CN, 'Skills.json')))
  const tPassives = textMap(readJson(path.join(CN, 'Passives.json')))
  const tEnemies = list(readJson(path.join(CN, 'Enemies.json')))

  const persName = new Map(tPers.map(p => [p.id, p]))
  const egoName = new Map(tEgos.map(e => [e.id, e]))
  const enemyName = new Map()
  for (const e of tEnemies) enemyName.set(e.id, e)

  // ===== 人格（12 个罪人，per-sinner json）=====
  const personalities = []
  for (let cid = 1; cid <= 12; cid++) {
    const num = String(cid).padStart(2, '0')
    const stat = list(readJson(path.join(SD, 'personality', `personality-${num}.json`)))
    const passiveFile = list(readJson(path.join(SD, 'personality-passive', `personality-passive-${num}.json`)))
    // { personalityID → { battle: [passiveId...], supporter: [passiveId...] } }
    const passiveByPers = new Map()
    for (const pv of passiveFile) {
      passiveByPers.set(pv.personalityID, {
        battle: (pv.battlePassiveList || []).flatMap(l => l.passiveIDList || []),
        supporter: (pv.supporterPassiveList || []).flatMap(l => l.passiveIDList || [])
      })
    }

    for (const s of stat) {
      const cn = persName.get(s.id) || {}
      const cname = cn.name || SINNER_NAMES[s.characterId] || `罪人${s.characterId}`
      // 完整名 = 罪人名 + 空格 + 完整标题（如「希斯克利夫 R公司第四集团军兔子队」）；LCB罪人保持罪人名
      const titleRaw = (cn.title || '').replace(/\//g, '').replace(/\s+/g, '')
      const isLCB = titleRaw === 'LCB罪人' || !titleRaw
      const name = isLCB ? cname : cname + ' ' + titleRaw
      const skills = []
      for (const attr of s.attributeList || []) {
        // skillId → skill tier 从 personality-skill-XX 找 skillTier
        skills.push({
          skillId: attr.skillId,
          slot: attr.number,           // 3/2/1 = 1/2/3 技能位
          tier: null,
          sin: null,
          atkType: null,
          base: null,
          coin: null,
          coinPower: null
        })
      }
      // 守备
      let defense = null
      const defId = (s.defenseSkillIDList || [])[0]
      if (defId) defense = { skillId: defId, type: null, sin: null }
      // 被动：battlePassive（战斗中）+ supporterPassive（支援/主线加成）
      const pvOfPers = passiveByPers.get(s.id) || { battle: [], supporter: [] }
      // 被动去重：上游 battle/supporter 列表可能重复（同一 id 多次），只保留一次
      const passives = []
      const pvSeen = new Set()
      const addPv = (pid, on) => {
        if (pid == null) return
        const k = `${pid}|${on}`
        if (pvSeen.has(k)) return
        pvSeen.add(k)
        passives.push({ id: pid, on, res: 0 })
      }
      for (const pid of pvOfPers.battle) addPv(pid, true)
      for (const pid of pvOfPers.supporter) addPv(pid, false)
      personalities.push({
        id: s.id,
        name,
        title: isLCB ? '' : titleRaw,
        charId: s.characterId,
        charName: SINNER_NAMES[s.characterId] || `罪人${s.characterId}`,
        rank: s.rank ?? 1,
        season: s.season ?? 0,
        hp: s.hp ? { base: s.hp.defaultStat, inc: s.hp.incrementByLevel } : null,
        def: s.defCorrection ?? null,
        speedMin: s.minSpeedList || null,
        speedMax: s.maxSpeedList || null,
        resist: (s.resistInfo?.atkResistList || []).map(r => ({ type: r.type, value: r.value })),
        skills,
        defense,
        passives
      })
    }
  }

  // ===== 技能数值（12+ 罪人 per-sinner json，合并）=====
  const skillStat = {}
  for (let cid = 1; cid <= 12; cid++) {
    const num = String(cid).padStart(2, '0')
    const arr = list(readJson(path.join(SD, 'skill', `personality-skill-${num}.json`)))
    for (const sk of arr) {
      skillStat[sk.id] = sk
    }
  }
  // EGO 技能数值（skill 目录缺失或无数值文件时跳过，不让构建崩溃）
  const egoSkillFiles = listDir(path.join(SD, 'skill')).filter(f => f.startsWith('ego-skill'))
  for (const f of egoSkillFiles) {
    for (const sk of list(readJson(path.join(SD, 'skill', f)))) skillStat[sk.id] = sk
  }

  // 回填 skill tier / sin / atkType / 币数
  for (const p of personalities) {
    for (const sk of p.skills) {
      const stat = skillStat[sk.skillId]
      if (!stat) continue
      sk.tier = stat.skillTier ?? 1
      const lv1 = (stat.skillData || [])[0] || {}
      sk.sin = lv1.attributeType || null
      sk.atkType = lv1.atkType || null
      const coins = lv1.coinList || []
      sk.coin = coins.length
      sk.coinPower = coins[0]?.scale ?? null
      sk.base = lv1.defaultValue ?? null
    }
    if (p.defense) {
      const stat = skillStat[p.defense.skillId]
      if (stat) {
        const lv1 = (stat.skillData || [])[0] || {}
        p.defense.type = lv1.defType || lv1.atkType || null
        p.defense.sin = lv1.attributeType || 'NEUTRAL'
      }
    }
  }

  // ===== EGO（per-character json 合并）=====
  const egos = []
  for (let cid = 1; cid <= 12; cid++) {
    const arr = list(readJson(path.join(SD, 'ego', `ego-${cid}.json`)))
    for (const g of arr) {
      const name = egoName.get(g.id)?.name || `E.G.O ${g.id}`
      egos.push({
        id: g.id,
        name,
        charId: g.characterId,
        charName: SINNER_NAMES[g.characterId] || `罪人${g.characterId}`,
        grade: g.egoType || null,
        gradeName: g.egoType || null,
        season: g.season ?? 0,
        resist: (g.attributeResistList || []).map(r => ({ sin: r.type, value: r.value })),
        cost: (g.requirementList || []).map(r => ({ sin: r.attributeType, num: r.num })),
        awakenSkillId: g.awakeningSkillId || null,
        corrodeSkillId: g.corrosionSkillId || null
      })
    }
  }

  // ===== 敌人 =====
  // 中文文本表（Enemies.json）为主索引；数值表（abnormality-unit）缺失时也能正常构建（抗性/技能留空）。
  const enemies = []
  for (const [id, t] of enemyName) {
    enemies.push({
      id,
      name: t.name || `敌人${id}`,
      desc: t.desc || '',
      type: enemyType(t, id),   // 本体/部位/人类头目/人类单位（无上游 type 字段时由 desc/id 推导）
      skills: [],
      resist: []
    })
  }
  // 数值表（abnormality-unit 等目录）合并抗性/技能；目录缺失则跳过，不让构建崩溃。
  // 自动发现敌人数值目录（abnormality-unit / enemy / abno / monster 等，上游改名也能扫到），
  // 并合并目录下全部 *.json（含 mirror/refraction/walpu/wp 等赛季变体），避免敌人抗性/技能全空。
  const abnById = new Map()
  const abnDirs = findDirs(SD, /abnormal|enemy|abno|monster/i)
  for (const dir of abnDirs) {
    for (const f of listDir(dir).filter(x => x.endsWith('.json'))) {
      for (const a of list(readJson(path.join(dir, f)))) {
        if (a.id != null) abnById.set(a.id, a)
      }
    }
  }
  for (const e of enemies) {
    const st = abnById.get(e.id)
    if (!st) continue
    e.resist = (st.resistInfo?.atkResistList || []).map(r => ({ type: r.type, value: r.value }))
    // 技能：上游 unit/part/enemy 均用 attributeList[{skillId,number}]（旧 skillList 字段已移除）
    e.skills = (st.attributeList || []).slice(0, 8).map(a => ({ skillId: a.skillId, sin: null }))
    // 异常体本体（unit）无 resistInfo，抗性在其部位（abnormalityPart）上，取首个部位的抗性兜底
    if (!e.resist.length && st.abnormalityPartList?.length) {
      const part = abnById.get(st.abnormalityPartList[0])
      if (part?.resistInfo?.atkResistList?.length) {
        e.resist = part.resistInfo.atkResistList.map(r => ({ type: r.type, value: r.value }))
      }
    }
  }

  // ===== 饰品（镜牢 EGO gift）=====
  // 以 CN 文本表为全量主源：自动枚举全部 EGOgift*.json 文本表
  // （含 MirrorDungeon 主表 + _2/6/7、EventTheme/StoryTheme 主题、walpu 瓦夜、活动等，上游拆分/新增都能扫到），
  // SD 仅补稀有度。
  const egogifts = []
  const giftFiles = listDir(CN).filter(f => /^EGOgift/i.test(f) && f.endsWith('.json'))
  const giftMap = new Map()
  // 倒序合并：数值主表 _7/_2 等赛季后缀表优先覆盖（同 id 升级变体靠后）
  for (const f of giftFiles.sort()) {
    for (const g of list(readJson(path.join(CN, f)))) {
      if (Number.isSafeInteger(g.id) && g.id >= 0) giftMap.set(g.id, g)
    }
  }
  // 饰品稀有度：自动发现饰品数据目录（ego-gift-mirrordungeon / ego-gift 等，上游改名也能扫到），
  // 合并目录下全部 *.json（含 2/3/4/5/6/7/extreme 等赛季饰品），避免饰品级别全为 1。
  // 上游用 tag 字段标稀有度（TIER_1..TIER_5, TIER_EX），非旧 rarity 数值。
  const giftRarity = new Map()
  const giftDirs = findDirs(SD, /gift/i)
  for (const dir of giftDirs) {
    for (const f of listDir(dir).filter(x => /^ego-gift-.+\.json$/.test(x))) {
      for (const g of list(readJson(path.join(dir, f)))) {
        if (g.id == null) continue
        // 旧格式 rarity 数字优先；新格式从 tag 提取 TIER_*
        const r = (g.rarity != null) ? g.rarity : 0
        let tier = -1
        if (g.rarity == null && Array.isArray(g.tag)) {
          for (const t of g.tag) {
            if (t === 'TIER_EX') { tier = 5; break }
            const m = /^TIER_(\d)$/.exec(t || '')
            if (m) { tier = Number(m[1]) - 1; break }
          }
        }
        if (tier >= 0) giftRarity.set(g.id, tier)
        else if (g.rarity != null) giftRarity.set(g.id, r)
      }
    }
  }
  for (const [gid, t] of giftMap) {
    egogifts.push({
      id: gid,
      name: t?.name || `饰品${gid}`,
      desc: t?.desc || '',
      rarity: giftRarity.get(gid) ?? t?.rarity ?? 0,
      effects: t?.desc ? [{ text: t.desc }] : []
    })
  }

  // ===== 技能/被动文本 =====
  // 合并全部技能文本表：自动枚举 LLC_zh-CN 下所有 Skills*.json
  // （通用 + EGO + 敌人 + 异常体 + 各罪人人格技能 + 人格专属EGO技能，命名随上游演变也能被扫到）
  const skillFiles = listDir(CN)
    .filter(f => /^Skills/i.test(f) && f.endsWith('.json'))
    .sort()
  const skills = {}
  for (const f of skillFiles) {
    const json = readJson(path.join(CN, f))
    if (!json) continue
    for (const t of list(json)) {
      const lv1 = [...(t.levelList || [])].sort((a, b) => (b.level || 0) - (a.level || 0))[0] || {}
      const name = lv1.name || ''
      let desc = lv1.desc || ''
      // Limbus 技能文本 = 主 desc + 硬币 coinlist[].coindescs[].desc
      for (const c of lv1.coinlist || []) {
        for (const cd of c.coindescs || []) {
          if (cd.desc) desc += (desc ? '\n' : '') + cd.desc
        }
      }
      if (!name && !desc) continue
      const prev = skills[t.id]
      if (!prev) {
        skills[t.id] = { name, desc }
      } else {
        // 后者补缺：通用表常只有名没有描述，用详细表补全
        if (!prev.name && name) prev.name = name
        if (!prev.desc && desc) prev.desc = desc
      }
    }
  }
  const passives = {}
  for (const [id, t] of Object.entries(tPassives)) {
    passives[id] = { name: t.name || '', desc: t.desc || '' }
  }

  // ===== 输出 =====
  // 合并补充人格（数据源未收录的赛季8高级定制等，由 supplement.json 维护）
  const supplementPath = path.join(outDir, 'supplement.json')
  const supplement = readJson(supplementPath)
  if (supplement && supplement.length) {
    const have = new Set(personalities.map(x => x.id))
    for (const p of supplement) {
      if (!have.has(p.id)) personalities.push(p)
    }
    personalities.sort((a, b) => a.id - b.id)
  }
  const payload = { personalities, egos, enemies, egogifts, skills, passives, meta: { builtAt: new Date().toISOString(), sourceVersion: 'local-upstream' } }
  mergeLocalTexts(payload, refDir)
  publishSnapshot(outDir, payload)

  // ===== 数据完整性诊断（便于一眼看出哪些上游数据缺失）=====
  const diag = []
  if (!enemies.length) diag.push('敌人为空（缺 LocalizeLimbusCompany/Enemies.json）')
  const enemiesNoResist = enemies.filter(e => !(e.resist || []).length).length
  if (enemiesNoResist === enemies.length) diag.push('敌人抗性全空（缺 LimbusStaticData/abnormality-unit 数值源）')
  // 无技能统计：部位（part）是异常体的可破坏身体部件，本来就不带独立技能，不计入缺失；
  // 只统计本体/人类类无技能，那才代表上游数值确实缺。
  const enemiesNoSkill = enemies.filter(e => e.type !== 'part' && !(e.skills || []).length).length
  const noSkillNonPart = enemies.filter(e => e.type !== 'part')
  if (enemiesNoSkill > 0) diag.push(`${enemiesNoSkill}/${noSkillNonPart.length} 本体/人类敌人无技能数据（缺 abnormality-unit 数值源）`)
  const giftRarityZero = egogifts.filter(g => (g.rarity ?? 0) === 0).length
  if (giftRarityZero === egogifts.length && egogifts.length) diag.push('饰品级别全为1（缺 LimbusStaticData/ego-gift-mirrordungeon 稀有度数据）')
  if (!Object.keys(skills).length) diag.push('技能文本为空（缺 LocalizeLimbusCompany/Skills*.json）')

  return {
    personalities: personalities.length,
    egos: egos.length,
    enemies: enemies.length,
    egogifts: egogifts.length,
    diag
  }
}

// 直接运行
if (process.argv[1] && process.argv[1].endsWith('build_data.mjs')) {
  const upstream = process.argv[2] || path.join(PLUGIN_ROOT, 'data', 'upstream')
  buildAll(upstream, process.argv[3] || path.join(PLUGIN_ROOT, 'resources', 'data'))
    .then(r => {
      console.log(JSON.stringify(r))
    })
    .catch(e => {
      console.error('build failed:', e.message)
      process.exit(1)
    })
}
