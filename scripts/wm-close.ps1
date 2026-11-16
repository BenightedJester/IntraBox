# 向 Electron 主窗口发送 WM_CLOSE，模拟用户点击标题栏 X。
# 用 EnumWindows 而非 MainWindowHandle：窗口隐藏到托盘后后者取不到句柄。
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Win32 {
  public delegate bool EnumDelegate(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumDelegate enumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  public static List<IntPtr> WindowsOf(int pid) {
    var list = new List<IntPtr>();
    EnumWindows((hWnd, lParam) => {
      int wpid; GetWindowThreadProcessId(hWnd, out wpid);
      if (wpid == pid) {
        var sb = new System.Text.StringBuilder(256);
        GetClassName(hWnd, sb, 256);
        // Chromium 主窗口类名；隐藏到托盘后窗口无标题，不能按标题过滤
        if (sb.ToString() == "Chrome_WidgetWin_1") list.Add(hWnd);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$procs = Get-Process electron -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output 'NO_PROCESS'; exit 1 }
$handles = @()
foreach ($p in $procs) { $handles += [Win32]::WindowsOf($p.Id) }
if ($handles.Count -eq 0) { Write-Output 'NO_WINDOW'; exit 1 }
foreach ($h in $handles) {
  [Win32]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
}
Write-Output "WM_CLOSE sent ($($handles.Count) window)"