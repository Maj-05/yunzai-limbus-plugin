import { rulePrefix } from '../utils/common.js'
import db from '../lib/db.mjs'
import { checkDataAge } from '../lib/version_check.mjs'
import { PLUGIN_ROOT } from '../lib/constants.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
const execAsync = promisify(execFile)

/**
 * 数据更新 + 插件自更新
 *  #limbus更新        → 插件自更新（git pull 仅更新本插件目录，安全；失败只提示不覆盖）+ 重建图鉴数据
 *  #limbus更新数据    → 仅重建图鉴数据（需要 data/upstream 已存在）
 *  #图鉴状态          → 数据统计
 */
const REPO_URL = 'https://github.com/Maj-05/yunzai-limbus-plugin.git'
// 上游数据源（可在 config/system/update.json 覆盖 url / 设置 ghMirror 走 GitHub 代理）
const DEFAULT_UPSTREAMS = [
  { name: 'LimbusStaticData', url: 'https://git.neonteam.dev/yuvlian/LimbusStaticData.git', gh: false },
  { name: 'LocalizeLimbusCompany', url: 'https://github.com/LocalizeLimbusCompany/LocalizeLimbusCompany.git', gh: true }
]

function loadUpdateConfig () {
  try {
    const p = path.join(PLUGIN_ROOT, 'config', 'system', 'update.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) { logger.error('[limbus-plugin] 读取 update.json 失败: ' + e.message) }
  return {}
}

function ghMirrorOf (url) {
  const cfg = loadUpdateConfig()
  const mirror = (cfg.ghMirror || '').replace(/\/$/, '') + '/'
  return (mirror && mirror !== '/') ? mirror + url : url
}

function getUpstreams () {
  const cfg = loadUpdateConfig()
  const mirror = (cfg.ghMirror || '').replace(/\/$/, '') + '/'
  return DEFAULT_UPSTREAMS.map(u => {
    let url = u.url
    if (u.gh && mirror && mirror !== '/') url = mirror + url
    // 允许在配置里单独覆盖某个源
    const over = (cfg.upstreams || {})[u.name]
    if (over) url = over
    return { name: u.name, url }
  })
}

export function gitProxyArgs (cfg = loadUpdateConfig()) {
  const args = ['-c', 'http.sslVerify=true', '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60']
  const proxy = (cfg.httpProxy || '').trim()
  if (proxy) {
    const parsed = new URL(proxy)
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) throw new Error('不支持的代理协议')
    args.push('-c', 'http.proxy=' + proxy)
  }
  return args
}

export function validateGitUrl (value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Git 源必须使用无凭据的 HTTPS URL')
  return url.href
}

let updating = false

export class LimbusUpdate extends plugin {
  constructor() {
    super({
      name: '[limbus-plugin]更新',
      dsc: '插件自更新与数据重建',
      event: 'message',
      priority: 500,
      rule: [
        { reg: `^${rulePrefix}limbus(?:强制)?更新(数据)?$`, fnc: 'update', permission: 'master' },
        { reg: `^${rulePrefix}limbus强制更新$`, fnc: 'update', permission: 'master' },
        { reg: `^${rulePrefix}limbus版本$`, fnc: 'version' },
        { reg: `^${rulePrefix}limbus更新记录$`, fnc: 'changelog' },
        { reg: `^${rulePrefix}图鉴状态$`, fnc: 'status' }
      ]
    })
    this._running = false
  }

  async status() {
    if (!db.load()) {
      await this.reply('图鉴数据未就绪')
      return true
    }
    const s = db.stats()
    const age = checkDataAge()
    const body = [
      `【边狱图鉴数据】`,
      `人格: ${s.personalities}`,
      `E.G.O: ${s.egos}`,
      `敌人: ${s.enemies}`,
      `饰品: ${s.egogifts}`
    ]
    if (s.builtAt) body.push(`构建时间: ${s.builtAt}`)
    if (age.sourceVersion) {
      body.push(`数据版本: ${age.sourceVersion}（${age.label}）`)
      if (age.stale) body.push(`⚠ 数据已 ${age.days} 天未更新，可能缺新人格/技能，建议管理员执行 #limbus更新 重建数据。`)
    }
    await this.reply(body.join('\n'))
    return true
  }

  async version() {
    const info = this._gitInfo()
    await this.reply(`limbus-plugin 当前版本: ${info}`)
    return true
  }

  /** #limbus更新记录：读取 CHANGELOG.md 返回更新日志 */
  async changelog() {
    try {
      const p = path.join(PLUGIN_ROOT, 'CHANGELOG.md')
      if (!fs.existsSync(p)) {
        await this.reply('暂无更新记录（CHANGELOG.md 缺失）')
        return true
      }
      const text = fs.readFileSync(p, 'utf8')
      await this.reply(`【limbus-plugin 更新记录】\n${text.trim()}`)
    } catch (e) {
      logger.error(`[limbus-plugin] 读取 CHANGELOG 失败: ${e.message}`)
      await this.reply('读取更新记录失败')
    }
    return true
  }

  _gitInfo() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
      return 'v' + (pkg.version || '?')
    } catch {
      return 'v?'
    }
  }

  /** 插件目录是否是 git 仓库 */
  _isGitRepo() {
    return fs.existsSync(path.join(PLUGIN_ROOT, '.git'))
  }

  async update() {
    if (!this.e?.isMaster) return false
    if (updating) { await this.reply('更新任务进行中，请稍候'); return true }
    updating = true
    const cfg = loadUpdateConfig()
    const onlyData = this.e.msg.includes('数据')
    const online = cfg.allowNetworkUpdates === true
    try {
      if (online && !onlyData && this._isGitRepo()) {
        await this.reply('正在更新插件代码…')
        const git = args => this._execGit(args, PLUGIN_ROOT, cfg)
        try {
          if (this.e.msg.includes('强制')) {
            await git(['fetch', '--all'])
            await git(['reset', '--hard', '@{upstream}'])
          } else await git(['pull', '--ff-only'])
        } catch (error) {
          const mirror = ghMirrorOf(REPO_URL)
          if (mirror === REPO_URL || !/unable to access|failed to connect|timed? out|could not resolve/i.test(String(error.stderr || error.message))) throw error
          await git(['pull', '--ff-only', validateGitUrl(mirror), 'HEAD'])
        }
      }
      const upstreamDir = path.join(PLUGIN_ROOT, 'data', 'upstream')
      if (online) {
        fs.mkdirSync(upstreamDir, { recursive: true })
        for (const upstream of getUpstreams()) {
          const dest = path.join(upstreamDir, upstream.name)
          const url = validateGitUrl(upstream.url)
          if (fs.existsSync(path.join(dest, '.git'))) await this._execGit(['pull', '--ff-only'], dest, cfg)
          else if (!fs.existsSync(dest)) await this._execGit(['clone', '--depth', '1', '--', url, dest], upstreamDir, cfg)
          else throw new Error('本地上游目录存在但不是 Git 仓库，已保留文件：' + upstream.name)
        }
      }
      const args = [path.join(PLUGIN_ROOT, 'scripts', 'build_data.mjs'), upstreamDir, path.join(PLUGIN_ROOT, 'resources', 'data')]
      const env = { ...process.env }
      if (!env.LIMBUS_REF_DIR && cfg.localRefDir) env.LIMBUS_REF_DIR = cfg.localRefDir
      const built = await execAsync(process.execPath, args, { env, cwd: PLUGIN_ROOT, timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true })
      const result = JSON.parse(built.stdout.trim())
      db.ready = false
      if (!db.load()) throw new Error('更新后的数据无法载入')
      let artLine = ''
      if (online && !onlyData && cfg.downloadArt === true) {
        await execAsync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'fetch_art.mjs'), '--allow-network'], { cwd: PLUGIN_ROOT, timeout: 600000, maxBuffer: 1024 * 1024, windowsHide: true })
        artLine = '\n立绘缓存更新完成'
      }
      await this.reply(`图鉴本地数据更新完成\n人格: ${result.personalities} · E.G.O: ${result.egos} · 敌人: ${result.enemies} · 饰品: ${result.egogifts}` + artLine + (!online ? '\n离线模式：未访问网络。' : ''))
    } catch (error) {
      globalThis.logger?.error('[limbus-plugin] 更新失败: ' + error.message)
      await this.reply('更新失败，已停止：' + error.message)
    } finally { updating = false }
    return true
  }

  _execGit(args, cwd = PLUGIN_ROOT, cfg = loadUpdateConfig()) {
    return execAsync('git', [...gitProxyArgs(cfg), ...args], { cwd, timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true })
      .then(result => result.stdout.trim())
  }
}
