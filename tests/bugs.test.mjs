import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

globalThis.logger = { info() {}, error() {}, warn() {}, debug() {} }
globalThis.plugin = class {
  constructor(options) { Object.assign(this, options) }
  async reply(message) { return this.e.reply(message) }
}
const { default: db } = await import('../lib/db.mjs')
const { LimbusQuery } = await import('../apps/personality.js')
const { LimbusQuery2 } = await import('../apps/query.js')
const { LimbusTool } = await import('../apps/tool.js')
const { selectionKey, rememberSelect, peekSelect, clearSelect } = await import('../lib/selection.mjs')
const { buildGalleryAll, buildGallerySinner } = await import('../lib/gallery.mjs')
const { buildGiftList } = await import('../lib/cards.mjs')
const { default: runtimeRender } = await import('../utils/runtimeRender.js')
const { PLUGIN_ROOT } = await import('../lib/constants.mjs')
assert.equal(db.load(), true)

let user = 100
function harness(Class, msg, overrides = {}) {
  const instance = new Class()
  const messages = [], renders = []
  instance.e = {
    msg, user_id: ++user, self_id: 1, group_id: 10,
    reply: async message => { messages.push(message); return true },
    runtime: { render: async (...args) => { renders.push(args); return true } },
    ...overrides
  }
  return { instance, messages, renders }
}

test('personality ID remains intact and returns the exact detail card', async () => {
  const h = harness(LimbusQuery, '#人格 10201')
  await h.instance.queryPersonality()
  assert.equal(h.renders.length, 1)
  assert.equal(h.renders[0][2].card.id, 10201)
})

test('personality sinner filters handle rarity, season and adjacent command syntax', async () => {
  for (const [msg, expected] of [['#人格 良秀 3灯', { rank: 3 }], ['#巴士人格 良秀 3', { season: 3 }]]) {
    const h = harness(LimbusQuery, msg)
    await h.instance.queryPersonality()
    const payload = h.renders[0][2]
    assert.equal(payload.charId, 4)
    assert.ok(payload.items.length > 0)
    assert.ok(payload.items.every(p => Object.entries(expected).every(([k, v]) => p[k] === v)))
  }
  const h = harness(LimbusQuery, '#人格良秀')
  assert.equal(new RegExp(h.instance.rule.find(r => r.fnc === 'queryPersonality').reg).test(h.instance.e.msg), true)
})

test('EGO parser includes two-character HE and keeps case-insensitive prefixes', async () => {
  const h = harness(LimbusQuery2, '#limbusEGO 良秀 HE')
  await h.instance.queryEgo()
  const payload = h.renders[0][2]
  assert.equal(payload.charId, 4)
  assert.ok(payload.items.length > 0)
  assert.ok(payload.items.every(p => p.grade === 'HE'))
})

test('random exploration returns an event and its choices, not the directory', async () => {
  const h = harness(LimbusTool, '#事件 随机')
  await h.instance.exploreEvent()
  assert.match(h.messages[0], /选项：/)
  assert.doesNotMatch(h.messages[0], /【镜牢探索事件】/)
})

test('all twelve initial EGOs are excluded, while non-initial ZAYIN remain', () => {
  const h = harness(LimbusTool, '')
  for (let cid = 1; cid <= 12; cid++) assert.equal(h.instance._isInitialEgo(20001 + cid * 100), true)
  assert.equal(h.instance._isInitialEgo(21202), false)
  const pools = h.instance._gachaPools()
  assert.ok(pools.ZAYIN.length > 0)
  assert.ok(pools.ZAYIN.every(g => !h.instance._isInitialEgo(g.id)))
  assert.equal(h.instance._gachaPools(), pools)
})

test('shared selection retains text labels and isolates bot, group and private chats', () => {
  const e = { self_id: 1, group_id: 1, user_id: 1 }
  const key = selectionKey(e)
  rememberSelect(key, { ids: [1], textNames: { 1: '标签' } })
  assert.equal(peekSelect(key).textNames[1], '标签')
  for (const other of [{ ...e, self_id: 2 }, { ...e, group_id: 2 }, { self_id: 1, user_id: 1 }, { ...e, user_id: 2 }]) {
    assert.notEqual(selectionKey(other), key)
    assert.equal(peekSelect(selectionKey(other)), null)
  }
  clearSelect(key)
})

test('catalogue pagination stays textual across apps, then selects the page-local entry', async () => {
  const h = harness(LimbusTool, '#图鉴 3灯')
  await h.instance.catalogBrowse()
  const key = selectionKey(h.instance.e)
  const ids = peekSelect(key).ids
  assert.ok(ids.length > 8)
  const q = harness(LimbusQuery2, '下一页', { ...h.instance.e, msg: '下一页' })
  await q.instance.turnPage()
  assert.equal(peekSelect(key).page, 1)
  assert.equal(q.renders.length, 0)
  assert.match(h.messages.at(-1), /第 2\//)
  q.instance.e.msg = '1'
  await q.instance.selectNumber()
  assert.equal(h.renders.at(-1)[2].card.id, ids[8])
})

test('gallery renders at most twelve images and next page has distinct entries', async () => {
  for (const payload of [buildGalleryAll(), buildGallerySinner(4)]) {
    const count = payload.groups.reduce((sum, g) => sum + g.items.length, 0)
    assert.ok(count <= 12)
  }
  const h = harness(LimbusTool, '#画廊')
  await h.instance.gallery()
  const first = h.renders[0][2].groups.flatMap(g => g.items.map(p => p.id))
  const q = new LimbusQuery2()
  q.e = { ...h.instance.e, msg: '下一页' }
  await q.turnPage()
  const second = h.renders.at(-1)[2].groups.flatMap(g => g.items.map(p => p.id))
  assert.equal(first.length, 12)
  assert.ok(second.length <= 12 && second.length > 0)
  assert.ok(second.every(id => !first.includes(id)))
  q.e.msg = '1'
  assert.equal(await q.selectNumber(), false)
  const personality = new LimbusQuery()
  personality.e = q.e
  assert.equal(await personality.selectNumber(), false)
  assert.equal(peekSelect(selectionKey(q.e)).page, 1)
})

test('gift overview avoids expanding artwork and level filter matches requested rarity', () => {
  const overview = buildGiftList()
  assert.equal(overview.total, db.egogifts.length)
  assert.ok(overview.groups.every(g => g.items.every(p => !('artSrc' in p))))
  const level = buildGiftList(2)
  assert.equal(level.total, db.egogifts.filter(p => (p.rarity ?? 0) === 1).length)
  assert.ok(level.groups[0].items.every(p => p.levelName === '级别2'))
})

test('render wrapper preserves framework arguments, actual plugin directory and template data', async () => {
  let captured
  const e = { reply: async () => true, runtime: { render: async (name, template, data, options) => {
    captured = { name, template, data, options }
    const prepared = options.beforeRender({ data: { ...data, pluResPath: '/plugin-assets/' } })
    assert.equal(prepared.card.name, '李箱')
    assert.equal(prepared._res_path, '/plugin-assets/')
    assert.equal(prepared.defaultLayout, path.join(PLUGIN_ROOT, 'resources/common/layout/default.html'))
    assert.match(prepared.sys.scale, /1\.4/)
    return 'image-sent'
  } } }
  assert.equal(await runtimeRender(e, 'personality/personality', { card: { name: '李箱' } }, { scale: 1.4 }), 'image-sent')
  assert.equal(captured.name, path.basename(PLUGIN_ROOT))
  assert.equal(captured.template, 'personality/personality')
  assert.equal(captured.options.scale, 1.4)
})

test('render failure is reported and later requests still succeed', async () => {
  const replies = []
  const e = { reply: async value => replies.push(value), runtime: { render: async () => { throw new Error('browser closed') } } }
  await runtimeRender(e, 'gallery/gallery', {})
  assert.match(replies[0], /图片生成失败/)
  e.runtime.render = async () => 'recovered'
  assert.equal(await runtimeRender(e, 'gallery/gallery', {}), 'recovered')
})

test('gacha pool cache refreshes when database reload replaces records', () => {
  const h = harness(LimbusTool, '')
  const old = db.egos
  const before = h.instance._gachaPools()
  try {
    db.egos = old.concat({ id: 20199, name: '测试EGO', grade: 'ZAYIN' })
    const after = h.instance._gachaPools()
    assert.notEqual(after, before)
    assert.equal(after.ZAYIN.at(-1).id, 20199)
  } finally { db.egos = old }
})
