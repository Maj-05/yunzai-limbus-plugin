import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { buildAll, publishSnapshot, skillDescription, mergeLocalTexts } from '../scripts/build_data.mjs'
import { download, build as buildArt } from '../scripts/fetch_art.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limbus-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function data() {
  return { personalities: [{ id: 1 }], egos: [{ id: 2 }], enemies: [{ id: 3 }], egogifts: [{ id: 4 }], skills: { 1: { name: '技能', desc: '旧描述' } }, passives: { 1: { name: '被动' } }, meta: { sourceVersion: 'old-release' } }
}
test('invalid replacement keeps every old snapshot byte unchanged', t => {
  const out = path.join(fixture(t), 'data')
  publishSnapshot(out, data())
  const before = fs.readFileSync(path.join(out, 'personalities.json'), 'utf8')
  assert.throws(() => publishSnapshot(out, { ...data(), enemies: [] }), /为空/)
  assert.equal(fs.readFileSync(path.join(out, 'personalities.json'), 'utf8'), before)
})
test('offline rebuild keeps bundled data and source date, supplements coin descriptions', async t => {
  const root = fixture(t), out = path.join(root, 'data'), ref = path.join(root, 'ref')
  publishSnapshot(out, data())
  fs.mkdirSync(path.join(ref, 'CN'), { recursive: true })
  fs.writeFileSync(path.join(ref, 'CN', 'Skills.json'), '\uFEFF' + JSON.stringify({ dataList: [{ id: 1, levelList: [{ level: 1, name: '技能' }, { level: 4, name: '技能', coinlist: [{ coindescs: [{ desc: '命中附加沉沦' }] }] }] }] }))
  const result = await buildAll(path.join(root, 'missing'), out, { localRefDir: ref })
  assert.equal(result.local, true)
  assert.match(JSON.parse(fs.readFileSync(path.join(out, 'skills.json')))[1].desc, /沉沦/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'meta.json'))).sourceVersion, 'old-release')
})
test('malformed local text aborts before publishing', async t => {
  const root = fixture(t), out = path.join(root, 'data'), ref = path.join(root, 'ref')
  publishSnapshot(out, data()); fs.mkdirSync(path.join(ref, 'CN'), { recursive: true })
  fs.writeFileSync(path.join(ref, 'CN', 'Skills.json'), '{bad')
  const before = fs.readFileSync(path.join(out, 'skills.json'), 'utf8')
  await assert.rejects(buildAll(path.join(root, 'missing'), out, { localRefDir: ref }), /无法解析/)
  assert.equal(fs.readFileSync(path.join(out, 'skills.json'), 'utf8'), before)
})
test('offline refresh excludes category keys but preserves all real gifts and custom data', async t => {
  const root = fixture(t), out = path.join(root, 'data'), payload = data()
  payload.egogifts = Array.from({ length: 20 }, (_, id) => ({ id, name: '饰品' + id, custom: true }))
  publishSnapshot(out, payload)
  fs.writeFileSync(path.join(out, 'egogifts.json'), JSON.stringify([...payload.egogifts, { id: 'Combustion', name: '烧伤' }]))
  fs.writeFileSync(path.join(out, 'custom.json'), '{"preserve":true}')
  const result = await buildAll(path.join(root, 'missing'), out, { localRefDir: path.join(root, 'missing-ref') })
  assert.equal(result.egogifts, 20)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'egogifts.json'))), payload.egogifts)
  assert.equal(fs.readFileSync(path.join(out, 'custom.json'), 'utf8'), '{"preserve":true}')
})
test('local empty descriptions preserve old descriptions and extra fields', t => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, 'CN'))
  fs.writeFileSync(path.join(root, 'CN', 'Skills.json'), JSON.stringify({ dataList: [{ id: 1, levelList: [{ level: 1, name: '新名', desc: '' }] }] }))
  const payload = data(); payload.skills[1].custom = 123
  mergeLocalTexts(payload, root)
  assert.equal(payload.skills[1].desc, '旧描述')
  assert.equal(payload.skills[1].custom, 123)
  assert.equal(payload.skills[1].name, '新名')
})
test('skill text falls back to old description if local record has none', () => {
  assert.deepEqual(skillDescription({ name: 'Guard', desc: 'block' }), { name: 'Guard', desc: 'block' })
})
function fakeRequest(handler) {
  return (url, options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {}
    queueMicrotask(() => handler(url, callback))
    return req
  }
}
function response(statusCode, headers = {}) {
  const res = new EventEmitter(); Object.assign(res, { statusCode, headers, resume() {}, destroy() {} }); return res
}
test('downloader rejects protocol and cross-origin redirect', async () => {
  await assert.rejects(download('http://example.org/x'), /HTTPS/)
  const request = fakeRequest((url, callback) => callback(response(302, { location: 'https://other.example/x' })))
  await assert.rejects(download('https://example.org/x', { request }), /跨域/)
})
test('downloader enforces limit on streamed responses without content-length', async () => {
  const request = fakeRequest((url, callback) => { const res = response(200); callback(res); res.emit('data', Buffer.alloc(20)); res.emit('end') })
  await assert.rejects(download('https://example.org/x', { request, maxBytes: 10 }), /大小限制/)
})
test('redirected download has an overall deadline', async () => {
  const request = fakeRequest((url, callback) => callback(url.pathname === '/x' ? response(302, { location: '/hang' }) : response(200)))
  await assert.rejects(download('https://example.org/x', { request, timeout: 20 }), /超时/)
})
test('art builder is offline unless explicitly enabled', async () => {
  assert.equal((await buildArt()).skipped, true)
})
test('git arguments retain TLS and never interpret proxy shell punctuation', async () => {
  globalThis.plugin ||= class {}
  const { gitProxyArgs, validateGitUrl, LimbusUpdate } = await import('../apps/update.js')
  const args = gitProxyArgs({ httpProxy: 'http://localhost:1234/?x=1&y=2' })
  assert.ok(args.includes('http.sslVerify=true'))
  assert.ok(args.includes('http.proxy=http://localhost:1234/?x=1&y=2'))
  assert.throws(() => validateGitUrl('file:///tmp/repo'), /HTTPS/)
  assert.equal(await LimbusUpdate.prototype.update.call({ e: { isMaster: false } }), false)
})
