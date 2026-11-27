# 共享图鉴核心与其他 Bot

 **AstrBot** 实现；若指其他框架，需要对应框架的适配器。

## 支持范围

`core/service.mjs` 提供人格、E.G.O、敌人、饰品的离线搜索、ID 详情、罪人列表、敌人类型、显式分页、状态速查和数据统计。详情带技能、被动文本。DSH 和 AstrBot 返回文本/结构化数据，不依赖 Yunzai 全局 `plugin`、`logger`、Puppeteer 或网络。

Yunzai 的图片卡片、群聊隐式序号会话、画廊、抽卡模拟、配队和管理员在线更新仍由 Yunzai 层负责；此版本的其他平台适配器**没有这些功能**。分页采用显式 `page` 或 `第N页`，不会跨群串会话。安装包携带当前本地数据快照，重新构建安装包才能更新数据。

## Node API / JSON CLI

需要 Node.js 20+。无 npm 依赖。

```js
import { LimbusService, formatResult } from './core/service.mjs'
const service = new LimbusService()
service.query({kind: 'personality', query: '李箱', page: 2, pageSize: 8})
formatResult(service.command('人格 10101'))
```

CLI 从 stdin 读取一个 JSON，stdout 仅输出一个 JSON，`ok:false` 时退出码为 1。

```sh
echo '{"command":"人格 李箱 第2页"}' | node core/cli.mjs
```

## DSH：MCP 本地服务器

可直接使用仓库内 `adapters/dsh/server.mjs`，或解压构建的 `limbus-mcp.zip`。在 DSH 设置的 MCP 页面添加 **stdio** 服务器，命令填 Node 可执行文件，参数填该文件的绝对路径。Windows 必须用实际的 `node.exe`，不要用 `.cmd` npm shim。进程由 DSH 管理，无需另开终端运行。

Cordis 配置见 `adapters/dsh/config.example.yaml`。配置路径是解压后的服务器路径，不能指向 ZIP 内部。工具为 `limbus_query` 和 `limbus_stats`。服务器实现 MCP 2025-11-25 及兼容的早期握手协议；现代 `server/discover` 探测返回 Method not found，DSH 官方客户端会回退握手。它不宣称实现 2026-07-28 无会话协议。

## AstrBot：完整 ZIP 插件

```sh
node adapters/build-packages.mjs /absolute/path/to/new-output-dir
```

输出 `astrbot_plugin_limbus.zip` 和 `limbus-mcp.zip`，包含共用 core、必要 lib、JSON 数据与许可证，不包含 Git、缓存、上游克隆或私有配置。构建拒绝覆盖同名文件。

在 AstrBot 插件页选择“从文件安装”，上传 `astrbot_plugin_limbus.zip`；也可解压到 `AstrBot/data/plugins/astrbot_plugin_limbus/`，确保该目录直接包含 `main.py` 和 `metadata.yaml`。不要把 Yunzai 仓库根目录当成 AstrBot 安装包。AstrBot 与 Node 必须处于同一运行环境，Docker 部署需要容器内部有 Node 20+。

命令：`/limbus 帮助`、`/limbus 人格 李箱`、`/limbus 人格 李箱 第2页`、`/limbus 人格 10101`、`/limbus ego 狐雨`、`/limbus 图鉴状态`。使用 AstrBot 设置的实际唤醒前缀替换 `/`。

Python 层通过 `asyncio.create_subprocess_exec` 启动本地 Node（不经过 shell），最多两个并发查询、排队最多 3 秒、查询 15 秒超时，取消或卸载时回收子进程。使用平台通用纯文本回复，不需要聊天模型/API key。

## 验证与边界

运行 `npm test`。适配测试覆盖本地查询、详情、分页、错误输入、CLI 启动、MCP 握手与工具调用及打包完整性。Python 端可用 `python -m py_compile adapters/astrbot/main.py` 检查语法。

这些测试不等于真实 AstrBot/DSH 安装验收；实际加载、命令唤醒和平台消息长度限制需要在对应版本宿主里确认。没有自动安装/修改用户现有 DSH、AstrBot 或 MCP 配置。

## 官方接入依据

- [DSH MCP 客户端配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)
- [MCP 2025-11-25 生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP 工具接口](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [AstrBot 最小插件](https://docs.astrbot.app/en/dev/star/guides/simple.html)
- [AstrBot 安装完整插件包](https://docs.astrbot.app/use/plugin.html)
- [AstrBot 命令解析源码](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/star/filter/command.py)
