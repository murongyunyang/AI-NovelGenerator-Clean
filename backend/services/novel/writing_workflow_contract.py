"""跨请求共享的流程标识；不依赖执行器，避免服务之间循环导入。"""
from typing import Literal

WorkflowId = Literal["auto", "claude", "codex", "planner", "reflexion"]
