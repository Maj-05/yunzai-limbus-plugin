import { LimbusService, formatResult } from '../../core/service.mjs'

export const toolDefinitions = [
  { name: 'limbus_query', description: 'Read local Limbus identities, E.G.O, enemies and gifts. Empty query lists records; page starts at 1; exact numeric ID gives full detail.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['personality', 'ego', 'enemy', 'gift'] },
      query: { type: 'string', maxLength: 200 }, page: { type: 'integer', minimum: 1, maximum: 10000 }, pageSize: { type: 'integer', minimum: 1, maximum: 20 }
    } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'limbus_stats', description: 'Show counts and provenance of the bundled offline data.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
]

/** Deliberately supports MCP handshake revisions through 2025-11-25. Modern probes
 * receive Method not found, allowing current DSH's official SDK legacy fallback. */
export function createSession(service = new LimbusService()) {
  let initialized = false
  let ready = false
  return request => {
    const hasId = request && Object.hasOwn(request, 'id')
    const error = (code, message) => ({ jsonrpc: '2.0', id: hasId ? request.id : null, error: { code, message } })
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (hasId && !['number', 'string'].includes(typeof request.id))) return error(-32600, 'Invalid Request')
    if (request.method === 'notifications/initialized') { if (initialized) ready = true; return null }
    if (!hasId) return null
    const result = value => ({ jsonrpc: '2.0', id: request.id, result: value })
    if (request.method === 'ping') return result({})
    if (request.method === 'server/discover') return error(-32601, 'This server supports MCP 2025-11-25 initialize handshake')
    if (request.method === 'initialize') {
      if (!request.params || typeof request.params.protocolVersion !== 'string') return error(-32602, 'protocolVersion is required')
      initialized = true
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
      return result({ protocolVersion: supported.includes(request.params.protocolVersion) ? request.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'limbus-offline', version: '2.0.0' } })
    }
    if (!ready) return error(-32000, 'Initialize the connection first')
    if (request.method === 'tools/list') return result({ tools: toolDefinitions })
    if (request.method !== 'tools/call') return error(-32601, 'Method not found')
    const params = request.params
    if (!params || !toolDefinitions.some(t => t.name === params.name)) return error(-32602, 'Unknown tool')
    try {
      const args = params.arguments ?? {}
      if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('arguments must be an object')
      const keys = params.name === 'limbus_query' ? ['kind', 'query', 'page', 'pageSize'] : []
      if (Object.keys(args).some(k => !keys.includes(k))) throw new Error('Unknown argument')
      const value = params.name === 'limbus_stats' ? { type: 'stats', stats: service.stats() } : service.query(args)
      return result({ content: [{ type: 'text', text: formatResult(value) }], structuredContent: value })
    } catch (e) {
      return result({ content: [{ type: 'text', text: e.message }], isError: true })
    }
  }
}

// stdio messages are newline-delimited JSON; only protocol responses go to stdout.
const dispatch = createSession()
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n')
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let response
    if (Buffer.byteLength(line) > 65536) { process.exitCode = 1; process.stdin.destroy(); return }
    try { response = dispatch(JSON.parse(line)) }
    catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } }
    if (response) process.stdout.write(JSON.stringify(response) + '\n')
  }
  if (Buffer.byteLength(buffer) > 65536) { process.exitCode = 1; process.stdin.destroy() }
})
