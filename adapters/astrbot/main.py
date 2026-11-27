"""AstrBot text adapter for the shared offline Limbus Node core.

Install the built ZIP, not this source subdirectory: the build bundles core/data.
Node.js >=20 must be available on PATH inside the AstrBot runtime/container.
"""

import asyncio
import json
from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star


class LimbusPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self._slots = asyncio.Semaphore(2)
        self._children = set()
        self._stopping = False
        self._root = Path(__file__).resolve().parent

    @filter.command("limbus")
    async def limbus(self, event: AstrMessageEvent):
        """本地图鉴：/limbus 人格 李箱、/limbus ego 狐雨、/limbus 图鉴状态。"""
        if self._stopping:
            return
        # Read the entire command tail; AstrBot's ordinary str argument consumes
        # only one token, which would truncate multiword names and pagination.
        query = event.get_message_str().split("limbus", 1)[-1].strip() or "帮助"
        if len(query) > 512:
            yield event.plain_result("查询过长，请限制在 512 字以内")
            return
        acquired = False
        child = None
        try:
            await asyncio.wait_for(self._slots.acquire(), timeout=3)
            acquired = True
            if self._stopping:
                return
            child = await asyncio.create_subprocess_exec(
                "node", str(self._root / "core" / "cli.mjs"),
                cwd=str(self._root), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                limit=1024 * 1024,
            )
            self._children.add(child)
            stdout, _ = await asyncio.wait_for(
                child.communicate(json.dumps({"command": query}, ensure_ascii=False).encode("utf-8")),
                timeout=15,
            )
            payload = json.loads(stdout)
            message = payload.get("text") if payload.get("ok") else payload.get("error")
            yield event.plain_result(str(message or "图鉴返回了空结果")[:16000])
        except FileNotFoundError:
            yield event.plain_result("未找到 Node.js，请在 AstrBot 运行环境安装 Node.js 20 或更新版本")
        except asyncio.TimeoutError:
            yield event.plain_result("图鉴繁忙或查询超时，请稍后重试")
        except (OSError, ValueError) as exc:
            logger.error(f"Limbus 查询失败: {exc}")
            yield event.plain_result("图鉴加载失败，请检查完整安装包和日志")
        finally:
            if child is not None:
                if child.returncode is None:
                    try:
                        child.kill()
                    except ProcessLookupError:
                        pass
                    await child.wait()
                self._children.discard(child)
            if acquired:
                self._slots.release()

    async def terminate(self):
        self._stopping = True
        for child in tuple(self._children):
            if child.returncode is None:
                try:
                    child.kill()
                except ProcessLookupError:
                    pass
                await child.wait()
        self._children.clear()
