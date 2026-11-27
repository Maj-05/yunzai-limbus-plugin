import path from 'path'
import { Version } from '../components/index.js'
import { PLUGIN_ROOT } from '../lib/constants.mjs'

import { createRenderQueue } from '../lib/render_queue.mjs'
const enqueue = createRenderQueue()
const PLUGIN_Name = path.basename(PLUGIN_ROOT)

/**
 * 渲染并回复图片（依赖 Yunzai 内置 puppeteer：e.runtime.render）
 */
export default async function runtimeRender (e, tplPath, renderData = {}, cfg = {}) {
  if (!e.runtime || !e.runtime.render) {
    globalThis.logger?.error('[limbus-plugin] 未找到 e.runtime.render，请升级至 TRSS/Miao-Yunzai 最新版')
    return e.reply('渲染失败：Bot 框架版本过低，请联系管理员升级')
  }
  const scale = (cfg.scale || 1) * 1
  const pct = `style='transform:scale(${scale})'`
  // 用插件真实根目录解析 layout，避免插件目录名与 PLUGIN_Name 不一致时找不到模板
  const layoutPath = path.join(PLUGIN_ROOT, 'resources', 'common', 'layout')

  try { return await enqueue(() => e.runtime.render(PLUGIN_Name, tplPath, renderData, {
    ...cfg,
    beforeRender ({ data }) {
      return {
        ...data,
        _res_path: data.pluResPath || data._res_path,
        _layout_path: layoutPath + path.sep,
        defaultLayout: path.join(layoutPath, 'default.html'),
        sys: {
          scale: pct,
          copyright: `Created By ${Version.name} & limbus-plugin v${Version.version}`
        },
        quality: 85
      }
    }
  })) } catch (error) {
    globalThis.logger?.error('[limbus-plugin] render: ' + error.message)
    return e.reply(error.message === 'RENDER_QUEUE_FULL' ? '图鉴图片正在排队，请稍后重试。' : '图片生成失败，请稍后重试或使用文字查询。')
  }
}
