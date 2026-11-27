/** Bound expensive screenshot work across all commands. */
export function createRenderQueue({ concurrency = 1, maxPending = 8 } = {}) {
  let active = 0
  const waiting = []
  function drain() {
    while (active < concurrency && waiting.length) {
      const { task, resolve, reject } = waiting.shift()
      active++
      Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; drain() })
    }
  }
  return task => new Promise((resolve, reject) => {
    if (active >= concurrency && waiting.length >= maxPending) return reject(new Error('RENDER_QUEUE_FULL'))
    waiting.push({ task, resolve, reject })
    drain()
  })
}
