import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('real stdio server negotiates legacy MCP, exposes tools and rejects invalid calls', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../adapters/dsh/server.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let errors = ''
  const requests = [
    { id: 0, method: 'server/discover' },
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'limbus_query', arguments: { kind: 'personality', query: '10101' } } },
    { id: 4, method: 'tools/call', params: { name: 'limbus_stats', arguments: {} } },
    { id: 5, method: 'tools/call', params: { name: 'limbus_query', arguments: { page: 0 } } },
    { id: 6, method: 'tools/call', params: { name: 'unregistered', arguments: {} } },
    { id: 7, method: 'ping' }
  ]
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  const timer = setTimeout(() => child.kill(), 10000)
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  child.stdin.end(requests.map(x => JSON.stringify({ jsonrpc: '2.0', ...x })).join('\n') + '\n')
  try {
    assert.equal(await done, 0, errors)
    const messages = output.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(messages.length, 8)
    const byId = new Map(messages.map(m => [m.id, m]))
    assert.equal(byId.get(0).error.code, -32601)
    assert.equal(byId.get(1).result.protocolVersion, '2025-11-25')
    assert.equal(byId.get(2).result.tools.length, 2)
    assert.equal(byId.get(3).result.structuredContent.record.id, 10101)
    assert.ok(byId.get(4).result.structuredContent.stats.personalities > 0)
    assert.equal(byId.get(5).result.isError, true)
    assert.equal(byId.get(6).error.code, -32602)
    assert.deepEqual(byId.get(7).result, {})
  } finally { clearTimeout(timer); child.kill() }
})
