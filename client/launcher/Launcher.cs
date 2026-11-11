// 客户端 exe：只负责用内置 Python 运行 client\launch.py，逻辑都在 Python 里。
// 由 build.py 调用系统自带的 csc.exe 编译，一般不需要修改。
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class Launcher
{
    [STAThread]
    static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string pythonw = Path.Combine(root, @"runtime\python\pythonw.exe");
        string script = Path.Combine(root, @"client\launch.py");
        if (!File.Exists(pythonw) || !File.Exists(script))
        {
            MessageBox.Show("程序文件不完整，请重新解压或重新打包。\n缺少：" + (File.Exists(pythonw) ? script : pythonw),
                "AI 小说生成器", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        var info = new ProcessStartInfo(pythonw, "\"" + script + "\"");
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        Process.Start(info);
    }
}
