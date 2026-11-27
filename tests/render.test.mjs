import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRenderQueue } from '../lib/render_queue.mjs'
test('render queue limits pending work and recovers after failure', async () => {
  const queue = createRenderQueue({maxPending:1})
  let release
  const first = queue(() => new Promise(resolve => { release=resolve }))
  const second = queue(() => { throw new Error('renderer failed') })
  await assert.rejects(queue(() => 3), /RENDER_QUEUE_FULL/)
  release(1)
  assert.equal(await first,1)
  await assert.rejects(second,/renderer failed/)
  assert.equal(await queue(() => 4),4)
})
