import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(new URL('./launch-win32.ps1', import.meta.url));

/** Quote one argument for the Windows C runtime parser used by Blender. */
function quoteArgument(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';
}

export function blenderDesktopLaunch(executable, args, env) {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return {
    executable: powershell,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER],
    env: {
      ...env,
      DSH_BLENDER_LAUNCH_EXECUTABLE: executable,
      DSH_BLENDER_LAUNCH_COMMAND: [executable, ...args].map(quoteArgument).join(' '),
      DSH_BLENDER_LAUNCH_HOST_PID: String(process.pid),
    },
  };
}
