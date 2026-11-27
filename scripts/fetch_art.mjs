import { artLocal, normalPortraitUrl } from '../lib/cards.mjs'
/**
 * 下载人格立绘到 resources/art/（本地缓存）。
 * 数据源：灰机wiki图床（文件名 = {人格id}_normal.png / {id}_gacksung.png）。
 * 规则：MediaWiki uploads/{md5[0]}/{md5[0..2]}/{fn}
 * 输出：resources/art/{id}_{kind}.png（原图缓存），并生成 art_index.json
 *
 * 说明：纯 Node 无 canvas 依赖，无法重编码成 JPEG，这里直接缓存原图 PNG，
 * 由 puppeteer 渲染时加载本地文件（避免每次在线热链原图 1~3MB 的延迟）。
 * 由 apps/update.js 的「拉取立绘」步骤调用。服务器需能访问 huijistatic.com。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..')
const DATA = path.join(PLUGIN_ROOT, 'resources', 'data', 'personalities.json')
const EGO_DATA = path.join(PLUGIN_ROOT, 'resources', 'data', 'egos.json')
const OUT_DIR = path.join(PLUGIN_ROOT, 'resources', 'art')
const INDEX = path.join(OUT_DIR, 'art_index.json')

const HOST = 'huiji-public.huijistatic.com'
const BASE = '/limbuscompany/uploads'

function md5Path (fn) {
  const h = crypto.createHash('md5').update(fn, 'utf8').digest('hex')
  return `${h[0]}/${h.slice(0, 2)}/${fn}`
}

/** 读取可配置的立绘图床前缀(config/system/update.json 的 artMirror)，默认灰机wiki图床 */
function getArtBase () {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'config', 'system', 'update.json'), 'utf8'))
    if (cfg.artMirror) return cfg.artMirror.replace(/\/$/, '')
  } catch {}
  return 'https://' + HOST
}

export async function download (url, { timeout = 20000, maxBytes = 12 * 1024 * 1024, request = https.get } = {}) {
  const origin = new URL(url)
  if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('图床必须使用无凭据的 HTTPS URL')
  const deadline = Date.now() + timeout
  async function get (target, redirects = 0) {
    if (redirects > 3) throw new Error('重定向次数过多')
    const next = new URL(target)
    if (next.origin !== origin.origin) throw new Error('不允许跨域图床重定向')
    return new Promise((resolve, reject) => {
      let req, res, settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) { req?.destroy(); res?.destroy(); reject(error) } else resolve(value)
      }
      const timer = setTimeout(() => finish(new Error('下载超时')), Math.max(1, deadline - Date.now()))
      try {
        req = request(next, { headers: { 'User-Agent': 'limbus-plugin' } }, response => {
          res = response
          res.on('error', error => finish(error))
          res.on('aborted', () => finish(new Error('下载中断')))
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            const location = res.headers.location
            res.resume()
            if (!location) return finish(new Error('缺少重定向地址'))
            let redirect
            try { redirect = new URL(location, next).href } catch (error) { return finish(error) }
            get(redirect, redirects + 1).then(value => finish(null, value), error => finish(error))
            return
          }
          if (res.statusCode !== 200) return finish(new Error('HTTP ' + res.statusCode))
          if (Number(res.headers['content-length']) > maxBytes) return finish(new Error('立绘超过大小限制'))
          let size = 0
          const chunks = []
          res.on('data', chunk => {
            size += chunk.length
            if (size > maxBytes) return finish(new Error('立绘超过大小限制'))
            chunks.push(chunk)
          })
          res.on('end', () => finish(null, Buffer.concat(chunks)))
        })
        req.on('error', error => finish(error))
      } catch (error) { finish(error) }
    })
  }
  return get(origin.href)
}

export async function build ({ allowNetwork = false } = {}) {
  if (!allowNetwork) return { downloaded: 0, existed: 0, failed: 0, need: 0, skipped: true }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const index = {}
  let downloaded = 0
  let failed = 0
  let existed = 0
  const t0 = Date.now()

  // 人格 + EGO 立绘本地缓存（人格 normal/gacksung，EGO awaken_profile）。
  // 饰品立绘灰机wiki无 {id}_normal.png 文件（全404），故不下载，饰品卡用文字/图标兜底。
  const sources = [
    { file: DATA, kinds: ['normal', 'gacksung'], total: 0 },
    { file: EGO_DATA, kinds: ['awaken_profile'], total: 0 }
  ]

  // 收集全部待下载任务（已存在本地的跳过，记入 existed）
  const tasks = []
  let grandTotal = 0
  for (const src of sources) {
    if (!fs.existsSync(src.file)) continue
    const list = JSON.parse(fs.readFileSync(src.file, 'utf8'))
    src.total = list.length * src.kinds.length
    grandTotal += src.total
    for (const p of list) {
      const id = p.id
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('立绘 ID 无效')
      for (const kind of src.kinds) {
        const local = artLocal(id, kind)
        if (local) {
          index[`${id}_${kind}`] = local
          existed++
          continue
        }
        const png = `${id}_${kind}.png`
        const url = src.file === DATA && kind === 'normal' ? normalPortraitUrl(id) : `${getArtBase()}${BASE}/${md5Path(png)}`
        const fn = path.basename(new URL(url).pathname)
        tasks.push({ id, kind, src, fn, url, target: path.join(OUT_DIR, fn) })
      }
    }
  }
  const need = tasks.length

  // 小并发池下载（默认 6 并发），显著缩短首次几百张的下载时长
  const CONCURRENCY = 6
  let cursor = 0
  let reported = 0
  const worker = async () => {
    while (cursor < tasks.length) {
      const t = tasks[cursor++]
      try {
        const buf = await download(t.url)
        const valid = t.fn.endsWith('.webp')
          ? buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
          : buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        if (!valid || buf.length <= 5000) throw new Error('无效的立绘图片')
        const temporary = t.target + '.tmp'
        try { fs.writeFileSync(temporary, buf); fs.renameSync(temporary, t.target) } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
        index[`${t.id}_${t.kind}`] = t.fn
        downloaded++
      } catch (e) {
        failed++
        if (t.src.file === EGO_DATA) console.log(`[art] EGO ${t.id} ${t.kind} 缺失: ${e.message}`)
        else if (t.kind === 'normal') console.log(`[art] ${t.id} normal 缺失: ${e.message}`)
      }
      reported++
      if (grandTotal > 40 && reported % 25 === 0) console.log(`[art] 进度 ${reported}/${grandTotal}`)
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, need)) }, () => worker())
  await Promise.all(workers)

  fs.writeFileSync(INDEX, JSON.stringify(index))
  console.log(`[art] 完成: 需下载 ${need}, 已下载 ${downloaded}, 已有 ${existed}, 失败 ${failed}, 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return { downloaded, existed, failed, need }
}

if (process.argv[1] && process.argv[1].endsWith('fetch_art.mjs')) {
  build({ allowNetwork: process.argv.includes('--allow-network') }).catch(e => { console.error('[art] 失败:', e.message); process.exit(1) })
}

export { md5Path }