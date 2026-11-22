/**
 * Windows: drop a headed native window out of the taskbar and Alt-Tab without unmapping it.
 *
 * A window parked at `-10000,-10000` is still an ordinary visible top-level window, so the shell
 * keeps a taskbar button and an Alt-Tab entry for it. Marking it `WS_EX_TOOLWINDOW` and clearing
 * `WS_EX_APPWINDOW`, then toggling HIDE + SHOWNOACTIVATE so the shell re-evaluates, removes both
 * while the window stays mapped.
 *
 * Staying mapped is the whole point: `SW_HIDE` alone makes the window not-visible, and Blender
 * stops delivering `POST_PIXEL` draw callbacks for a window it considers hidden, which is exactly
 * the frame the viewport needs. Restyling keeps drawing working (verified against Blender 5.3).
 *
 * There is no CLI for window styles, so this is a bounded best-effort PowerShell call. Every
 * failure is non-fatal and only means the window keeps its taskbar button.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Runs once per spawned process; a restyle that finds no window just reports zero hits. */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshBlenderWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
'@
$target = [uint32]__PID__
$script:hits = 0
$cb = [DshBlenderWin+EnumProc]{
  param($hWnd, $lParam)
  [uint32]$owner = 0
  [void][DshBlenderWin]::GetWindowThreadProcessId($hWnd, [ref]$owner)
  if ($owner -eq $target -and [DshBlenderWin]::IsWindowVisible($hWnd) -and [DshBlenderWin]::GetWindow($hWnd, 4) -eq [IntPtr]::Zero) {
    $ex = [int64][DshBlenderWin]::GetWindowLongPtr($hWnd, -20)
    # WS_EX_TOOLWINDOW on, WS_EX_APPWINDOW off.
    $new = ($ex -bor 0x80) -band (-bnot 0x40000)
    [void][DshBlenderWin]::SetWindowLongPtr($hWnd, -20, [IntPtr]$new)
    # SW_HIDE then SW_SHOWNOACTIVATE: the shell re-reads the style for taskbar membership.
    [void][DshBlenderWin]::ShowWindow($hWnd, 0)
    [void][DshBlenderWin]::ShowWindow($hWnd, 4)
    $script:hits++
  }
  return $true
}
[void][DshBlenderWin]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:hits -gt 0) { 'HIDDEN:' + $script:hits } else { 'NONE' }
`;

/**
 * @param {number|undefined} pid the Blender process whose top-level windows to restyle
 * @returns {boolean} true when at least one window was restyled
 */
export function hideBlenderWindowWin32(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = SCRIPT.replace('__PID__', String(pid));
  try {
    const output = execFileSync(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return /^HIDDEN:\d+$/m.test(String(output));
  } catch {
    return false;
  }
}

/**
 * Best-effort retry: the window does not exist the instant the process is spawned, and creating
 * it happens on Blender's own thread, so the first few attempts may legitimately find nothing.
 *
 * @param {number|undefined} pid
 * @param {{attempts?:number, delayMs?:number}} [options]
 * @returns {Promise<boolean>} whether any attempt restyled a window
 */
export async function hideBlenderWindowWhenReadyWin32(pid, { attempts = 12, delayMs = 250 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  for (let index = 0; index < attempts; index += 1) {
    if (hideBlenderWindowWin32(pid)) return true;
    await new Promise((resolve) => { setTimeout(resolve, delayMs); });
  }
  return false;
}
