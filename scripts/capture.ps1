param(
  [string]$Out = 'quizwin.png',
  [string]$Title = 'Quiz Instructor',
  [int]$ClickX = -1,
  [int]$ClickY = -1
)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
$src = @'
using System;using System.Runtime.InteropServices;
public class Inp {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n,INPUT[] i,uint size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint f);
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;}
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
if (-not $proc) { throw "window '$Title' not found" }
$h = $proc.MainWindowHandle
[void][Inp]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 200
$r = New-Object Inp+RECT
[void][Inp]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T

# A minimised window (rect -32000) silently swallows clicks. SW_RESTORE is the
# only call that reliably un-minimises it; SW_SHOW does not.
$TOPMOST = [IntPtr](-1); $NOTOPMOST = [IntPtr](-2)
$SWP_NOSIZE = 0x1; $SWP_NOACTIVATE = 0x10; $SWP_SHOWWINDOW = 0x40
$w = 1100; $ht = 760
[void][Inp]::ShowWindow($h, 9)   # SW_RESTORE
Start-Sleep -Milliseconds 500
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -lt 400 -or $r.L -lt -1000) { $w = 1100; $ht = 760 }
# Pin it to a known spot so window-relative click coordinates are predictable.
[void][Inp]::SetWindowPos($h, $TOPMOST, 100, 60, $w, $ht, $SWP_SHOWWINDOW)
Start-Sleep -Milliseconds 300
$fg = [Inp]::GetForegroundWindow()
$fgThread = [Inp]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
$me = [Inp]::GetCurrentThreadId()
[void][Inp]::AttachThreadInput($me, $fgThread, $true)
[void][Inp]::BringWindowToTop($h)
[void][Inp]::SetForegroundWindow($h)
[void][Inp]::AttachThreadInput($me, $fgThread, $false)
Start-Sleep -Milliseconds 400
[void][Inp]::SetWindowPos($h, $NOTOPMOST, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE))
# Re-read the rect: it is only valid after the window is actually restored.
$r = New-Object Inp+RECT
[void][Inp]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
Write-Output "foreground=$([Inp]::GetForegroundWindow()) (target $h) rect=$($r.L),$($r.T) ${w}x${ht}"

# Click mode: -ClickX/-ClickY are window-relative coordinates of the target.
if ($ClickX -ge 0 -and $ClickY -ge 0) {
  $x = $r.L + $ClickX; $y = $r.T + $ClickY
  [void][Inp]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 300
  foreach ($flag in 0x0002, 0x0004) {   # left down, left up
    $i = New-Object 'Inp+INPUT'
    $i.type = 0                            # INPUT_MOUSE
    $i.u.mi.dwFlags = $flag
    [void][Inp]::SendInput(1, [Inp+INPUT[]]@($i), [Runtime.InteropServices.Marshal]::SizeOf([type]'Inp+INPUT'))
  }
  Start-Sleep -Milliseconds 300
  Write-Output "clicked at $x,$y (window origin $($r.L),$($r.T))"
}

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][Inp]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
$g.Dispose()
$bmp.Save((Join-Path (Get-Location) $Out))
$bmp.Dispose()
Write-Output "saved $Out ($w x $ht) from pid $($proc.Id)"