import { rulePrefix } from '../utils/common.js'
import db from '../lib/db.mjs'
import { checkDataAge } from '../lib/version_check.mjs'
import { PLUGIN_ROOT } from '../lib/constants.mjs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
const execAsync = promisify(exec)

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

/** 可选通用 git 代理（config/system/update.json 的 httpProxy，如 http://127.0.0.1:26561）。
 *  拉取上游时带上，让国内服务器也能拉 git.neonteam.dev / github.com 的上游数据。
 *  返回 git 的 -c 参数数组（未配置则空数组）。 */
function gitProxyArgs () {
  const cfg = loadUpdateConfig()
  const proxy = (cfg.httpProxy || '').trim()
  if (!proxy) return []
  return [
    '-c', 'http.proxy=' + proxy,
    '-c', 'http.sslBackend=openssl',
    '-c', 'http.sslVerify=false',
    '-c', 'http.lowSpeedLimit=1000',
    '-c', 'http.lowSpeedTime=600'
  ]
}

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

  async update(e) {
    if (this._running) {
      await this.reply('更新任务进行中，请稍候')
      return true
    }
    this._running = true
    const onlyData = this.e.msg.includes('数据')
    try {
      // ============ 阶段1：插件自更新（git pull，仅更新本插件目录，失败不覆盖）============
      if (!onlyData) {
        await this.reply('①/② 正在拉取插件最新代码…')
        let updated = false
        // 安全护栏：确认 PLUGIN_ROOT 确实是插件自身目录（含 apps/ 与 package.json），
        // 避免 PLUGIN_ROOT 解析偏差时对 Yunzai 插件根等父目录误执行 git/覆盖。
        const isPluginRoot = fs.existsSync(path.join(PLUGIN_ROOT, 'apps')) && fs.existsSync(path.join(PLUGIN_ROOT, 'package.json'))
        if (!isPluginRoot) {
          await this.reply(`⚠ 插件目录校验失败（PLUGIN_ROOT=${PLUGIN_ROOT}），已中止插件自更新，仅执行数据更新。`)
        } else if (this._isGitRepo()) {
          const isForce = this.e.msg.includes('强制')
          const oldCommit = await this._execGit('rev-parse --short HEAD')
          let cmd = isForce
            ? 'git -C "' + PLUGIN_ROOT + '" fetch --all && git -C "' + PLUGIN_ROOT + '" reset --hard @{upstream}'
            : 'git -C "' + PLUGIN_ROOT + '" pull --no-rebase'
          let ret = await execAsync(cmd, { timeout: 180000, windowsHide: true }).catch(err => ({ stdout: '', stderr: err.message }))
          // 直连失败则走 ghMirror 代理重试
          if (/Failed to connect|unable to access|Timed out|Could not|fatal/i.test(ret.stdout || '') + String(ret.stderr || '')) {
            const mir = ghMirrorOf(REPO_URL)
            await this.reply('直连 GitHub 失败，改用代理镜像重试…')
            ret = await execAsync(`git -C "${PLUGIN_ROOT}" pull --no-rebase "${mir}" HEAD`, { timeout: 180000, windowsHide: true })
              .catch(err => ({ stdout: '', stderr: err.message }))
          }
          const stdout = (ret.stdout || '') + (ret.stderr || '')
          if (/Already up.to date|已经是最新/i.test(stdout)) {
            await this.reply('插件代码已是最新')
            updated = true
          } else if (/fatal|error|Could not|Failed to connect/i.test(stdout)) {
            // 安全：git 更新失败不做全量覆盖（避免误覆盖插件或 Yunzai 目录），只提示用户
            await this.reply(`插件 git 更新失败:\n${stdout.trim().slice(0, 300)}\n可执行「#limbus强制更新」或改用 Yunzai 的「更新插件」功能。`)
          } else {
            await this.reply(`代码已更新（${isForce ? '强制' : '常规'}）\n${stdout.trim().split('\n').slice(-6).join('\n').slice(0, 400)}`)
            const log = await this._gitLog(oldCommit)
            if (log) await this.reply(log.slice(0, 600))
            updated = true
          }
        } else {
          // 第三方面板安装（无 .git）：不自更新，提示走 Yunzai 更新机制
          updated = false
          await this.reply('插件目录不是 git 仓库，无法自更新。\n请改用 Yunzai 的「更新插件」功能，或重新安装插件。')
        }
        if (!updated) {
          // 插件代码未更新（网络/git/非仓库），提示用户，不影响下方数据更新
          await this.reply('插件代码自更新未完成（网络或 git 问题），可改用 Yunzai 的「更新插件」功能。\n不影响下方数据更新。')
        }
      } else {
        await this.reply('①/② 跳过插件自更新（仅更新数据）')
      }

      // ============ 阶段2：拉上游数据 ============
      const upstreamDir = path.join(PLUGIN_ROOT, 'data', 'upstream')
      fs.mkdirSync(upstreamDir, { recursive: true })
      await this.reply('②/② 正在拉取上游数据源（1-3 分钟）…')
      const gargs = gitProxyArgs() // 可选代理 -c 参数（未配置 httpProxy 为空数组）
      const gpre = gargs.length ? gargs.join(' ') + ' ' : ''
      for (const u of getUpstreams()) {
        const dest = path.join(upstreamDir, u.name)
        try {
          if (fs.existsSync(path.join(dest, '.git'))) {
            await execAsync(`git ${gpre}pull --ff-only`, { cwd: dest, timeout: 180000, windowsHide: true })
          } else {
            fs.rmSync(dest, { recursive: true, force: true })
            await execAsync(`git ${gpre}clone --depth 1 ${u.url} "${dest}"`, { timeout: 600000, windowsHide: true })
          }
        } catch (e) {
          // 单个源失败不中断整个更新（如国内服务器连不上 GitHub）
          logger.error(`[limbus-plugin] 拉取源失败 ${u.name}: ${e.message}`)
          await this.reply(`⚠ 拉取源 ${u.name} 失败（${e.message.slice(0, 40)}），已跳过。\n若该源已有本地缓存会继续用旧数据。`)
        }
      }

      // ============ 阶段3：重建数据 ============
      const { buildAll } = await import('../scripts/build_data.mjs')
      const result = await buildAll(upstreamDir, path.join(PLUGIN_ROOT, 'resources', 'data'))
      db.ready = false
      db.load()

      // ============ 阶段4：拉取立绘（本地缓存，缺失才热链） ============
      let artLine = ''
      if (!onlyData) {
        try {
          await this.reply('正在拉取人格+E.G.O 立绘（首次约几分钟，之后增量）…')
          const { build: buildArt } = await import('../scripts/fetch_art.mjs')
          const art = await buildArt()
          artLine = `\n立绘: 需下载 ${art.need} / 已下载 ${art.downloaded} / 已有 ${art.existed} / 失败 ${art.failed}` +
            (art.failed > 0 ? '\n立绘失败较多：多为服务器无法访问图床 huijistatic.com，可配代理；缺失立绘会自动回退在线热链（不影响文字查询）' : '')
        } catch (e) {
          logger.error(`[limbus-plugin] 立绘拉取失败: ${e.message}`)
          artLine = '\n立绘: 拉取失败（不影响文字查询）'
        }
      }

      await this.reply(
        `边狱图鉴更新完成 ✓\n人格: ${result.personalities}\nE.G.O: ${result.egos}\n敌人: ${result.enemies}\n饰品: ${result.egogifts}` +
        artLine +
        (result.diag && result.diag.length ? `\n\n⚠ 数据完整性提示：\n${result.diag.map(d => '· ' + d).join('\n')}` : '')
      )
    } catch (err) {
      logger.error(`[limbus-plugin] 更新失败: ${err.stack || err.message}`)
      await this.reply(`更新失败: ${err.message}\n常见原因: 服务器无法访问 git.neonteam.dev / github.com（国内服务器建议配置代理）`)
    } finally {
      this._running = false
    }
    return true
  }

  _execGit (args) {
    return execAsync(`git -C "${PLUGIN_ROOT}" ${args}`, { timeout: 60000, windowsHide: true })
      .then(r => (r.stdout || '').trim()).catch(() => '')
  }

  _gitLog (oldCommit) {
    return this._execGit('log -15 --oneline --pretty=format:"%h|[%cd] %s" --date=format:"%m-%d %H:%M"')
      .then(out => {
        if (!out) return ''
        const lines = out.split('\n')
        const logs = []
        for (const l of lines) {
          const h = (l.split('|')[0] || '').trim()
          if (h && oldCommit && h === oldCommit) break
          if (/Merge branch/.test(l)) continue
          logs.push(l)
        }
        return logs.length ? `最近更新:\n${logs.join('\n')}` : ''
      }).catch(() => '')
  }
}