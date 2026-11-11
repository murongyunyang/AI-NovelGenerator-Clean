"""客户端入口。exe 启动器和 dev.bat 都执行这个文件。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from novel_client.startup_trace import trace  # noqa: E402

trace.mark("python_entry")
with trace.span("client_imports"):
    from novel_client.app import main  # noqa: E402

if __name__ == "__main__":
    main()
