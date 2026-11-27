import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildPackages } from '../adapters/build-packages.mjs'

test('ZIP bundles contain runnable core and AstrBot event bridge handles a real Node query', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limbus-adapter-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const [astr, mcp] = buildPackages(dir)
  assert.ok(fs.statSync(astr).size > 100000)
  assert.ok(fs.statSync(mcp).size > 100000)
  assert.throws(() => buildPackages(dir), /EEXIST/)
  const python = process.platform === 'win32' ? 'py' : 'python3'
  const prefix = process.platform === 'win32' ? ['-3'] : []
  const probe = spawnSync(python, [...prefix, '--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) { t.diagnostic('Python absent: ZIP/event bridge Python integration not run'); return }
  const code = `
import ast, asyncio, importlib.util, pathlib, sys, types, zipfile
archive, dest = sys.argv[1:3]
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    names = z.namelist()
    assert all(x in names for x in ['main.py', 'metadata.yaml', 'core/cli.mjs', 'lib/db.mjs', 'resources/data/skills.json'])
    assert not any('.git/' in n or 'config/' in n or 'upstream/' in n for n in names)
    ast.parse(z.read('main.py'))
    z.extractall(dest)
for name in ['astrbot', 'astrbot.api', 'astrbot.api.event', 'astrbot.api.star']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['astrbot.api'].logger = types.SimpleNamespace(error=lambda msg: None)
sys.modules['astrbot.api.event'].filter = types.SimpleNamespace(command=lambda name: lambda fn: fn)
sys.modules['astrbot.api.event'].AstrMessageEvent = object
class Star:
    def __init__(self, context): pass
sys.modules['astrbot.api.star'].Star = Star
sys.modules['astrbot.api.star'].Context = object
spec = importlib.util.spec_from_file_location('limbus_test', str(pathlib.Path(dest) / 'main.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
class Event:
    def __init__(self, message): self.message = message
    def get_message_str(self): return self.message
    def plain_result(self, text): return text
async def run():
    plugin = mod.LimbusPlugin(None)
    for query, expected in [('/limbus 人格 10101', 'ID 10101'), ('/limbus 人格 李箱 第2页', '第 2/'), ('/limbus ???', '未识别指令')]:
        replies = [text async for text in plugin.limbus(Event(query))]
        assert expected in replies[0], replies
    await plugin.terminate()
    assert not plugin._children
asyncio.run(run())
`
  const run = spawnSync(python, [...prefix, '-B', '-c', code, astr, path.join(dir, 'unpacked')], { encoding: 'utf8', timeout: 30000 })
  assert.equal(run.status, 0, run.stderr || run.stdout)
})
