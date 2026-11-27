import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Small, dependency-free ZIP writer for curated distribution files only. */
function zip(entries) {
  const local = [], central = []
  let offset = 0
  for (const [filename, content] of entries) {
    const name = Buffer.from(filename.replaceAll('\\', '/'))
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const compressed = deflateRawSync(data)
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8)
    header.writeUInt16LE(33, 12) // 1980-01-01, reproducible DOS date
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, compressed)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14)
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20)
    entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += header.length + name.length + compressed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

export function buildPackages(destination) {
  fs.mkdirSync(destination, { recursive: true })
  const common = ['core/service.mjs', 'core/cli.mjs', 'lib/db.mjs', 'lib/constants.mjs', 'LICENSE']
  for (const name of fs.readdirSync(path.join(root, 'resources/data')).sort()) {
    if (name.endsWith('.json')) common.push(`resources/data/${name}`)
  }
  const entries = common.map(name => [name, fs.readFileSync(path.join(root, name))])
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  // The archive needs ESM mode but no Yunzai/npm dependencies.
  entries.push(['package.json', JSON.stringify({ name: 'limbus-offline', version: pkg.version, type: 'module', private: true, engines: { node: '>=20' } }, null, 2)])
  const astr = [...entries, ...['main.py', 'metadata.yaml'].map(name => [name, fs.readFileSync(path.join(root, 'adapters/astrbot', name))])]
  const mcp = [...entries, ...['server.mjs', 'config.example.yaml'].map(name => [`adapters/dsh/${name}`, fs.readFileSync(path.join(root, 'adapters/dsh', name))])]
  const files = [path.join(destination, 'astrbot_plugin_limbus.zip'), path.join(destination, 'limbus-mcp.zip')]
  // Exclusive writes prevent silently replacing a distribution already reviewed.
  fs.writeFileSync(files[0], zip(astr), { flag: 'wx' })
  fs.writeFileSync(files[1], zip(mcp), { flag: 'wx' })
  return files
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = path.resolve(process.argv[2] || path.join(root, 'dist', `adapters-${Date.now()}`))
  for (const file of buildPackages(destination)) console.log(file)
}
