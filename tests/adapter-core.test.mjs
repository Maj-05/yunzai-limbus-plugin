import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LimbusService, formatResult } from '../core/service.mjs'
import { DB } from '../lib/db.mjs'
import { readData } from '../lib/constants.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const service = new LimbusService()

test('standalone DB loads with no Yunzai globals and enriches ID details', () => {
  assert.equal(globalThis.plugin, undefined)
  assert.ok(service.stats().personalities > 0)
  const result = service.query({ query: '10101' })
  assert.equal(result.type, 'detail')
  assert.equal(result.record.id, 10101)
  assert.ok(result.record.skills[0].text.name)
  result.record.name = 'mutated'
  assert.notEqual(service.detail('personality', 10101).name, 'mutated')
})

test('sinner list pagination is bounded and nonoverlapping', () => {
  const first = service.query({ query: '李箱', pageSize: 3 })
  const next = service.query({ query: '李箱', page: 2, pageSize: 3 })
  assert.equal(first.type, 'list')
  assert.equal(next.page, 2)
  assert.equal(first.items.length, 3)
  assert.ok(next.items.every(x => !first.items.some(y => x.id === y.id)))
  assert.equal(service.query({ query: '李箱', page: 9999, pageSize: 3 }).page, first.pages)
})

test('unknown commands and adversarial API arguments have explicit outcomes', () => {
  assert.match(formatResult(service.command('???')), /未识别指令/)
  assert.match(formatResult(service.query({ query: '不存在的条目XYZ000' })), /没有找到/)
  assert.throws(() => service.query({ kind: '__proto__' }), /未知图鉴/)
  assert.throws(() => service.query({ page: 0 }), /整数/)
  assert.throws(() => service.query({ pageSize: 21 }), /整数/)
  assert.throws(() => service.command('x'.repeat(513)), /长度/)
  assert.throws(() => service.query({ query: {} }), /文本/)
})

test('Chinese commands retain multiword queries and explicit page', () => {
  const result = service.command('/limbus 人格 李箱 第2页')
  assert.equal(result.type, 'list')
  assert.equal(result.page, 2)
  assert.match(formatResult(service.command('人格 10101')), /技能：/)
  assert.equal(service.command('图鉴状态').type, 'stats')
  assert.equal(service.command('敌人 异常体').type, 'list')
})

test('CLI starts in an unrelated cwd and prints only a JSON response', () => {
  const run = spawnSync(process.execPath, [path.join(root, 'core/cli.mjs')], { cwd: path.dirname(root), input: JSON.stringify({ command: '人格 10101' }), encoding: 'utf8', timeout: 10000 })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(JSON.parse(run.stdout).result.record.id, 10101)
  const invalid = spawnSync(process.execPath, [path.join(root, 'core/cli.mjs')], { input: '{broken', encoding: 'utf8', timeout: 10000 })
  assert.equal(invalid.status, 1)
  assert.equal(JSON.parse(invalid.stdout).ok, false)
})

test('DB rejects malformed reloads without replacing the last usable arrays', () => {
  let broken = false
  const db = new DB({ logger: null, reader: name => broken && name === 'egos' ? null : readData(name) })
  assert.equal(db.load(), true)
  const before = db.personalities
  broken = true
  db.ready = false
  assert.equal(db.load(), false)
  assert.equal(db.personalities, before)
})
