import { LimbusService, formatResult } from './service.mjs'

// One JSON request on stdin, one JSON response on stdout. No shell interpretation.
let input = ''
try {
  for await (const chunk of process.stdin) {
    input += chunk
    if (Buffer.byteLength(input) > 8192) throw new Error('请求过大')
  }
  const request = JSON.parse(input)
  const service = new LimbusService()
  const result = request.command !== undefined ? service.command(request.command) : service.query(request)
  process.stdout.write(JSON.stringify({ ok: true, result, text: formatResult(result) }) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n')
  process.exitCode = 1
}
