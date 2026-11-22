import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blenderDesktopLaunch } from '../../targets/three-d/hidden-window.js';

const launcher = await readFile(new URL('../../targets/three-d/launch-win32.ps1', import.meta.url), 'utf8');

// A desktop assigned at process creation covers startup and subsequent windows, even if Blender
// activates or repositions them. Keep the guard against reintroducing desktop switching or parking.
test('Blender starts on its private desktop and stays in the launch job', () => {
  assert.match(launcher, /startup\.Desktop = "DshBlender-" \+ Guid\.NewGuid\(\)/u);
  assert.match(launcher, /CreateDesktop\(startup\.Desktop,/u);
  assert.match(launcher, /CreateProcess\(executable,[\s\S]*?ref startup, out blender\)/u);
  assert.ok(launcher.indexOf('BindLauncherLifetime();') < launcher.indexOf('Check(CreateProcess(executable,'));
  assert.match(launcher, /AssignProcessToJobObject\(job, GetCurrentProcess\(\)\)/u);
  assert.match(launcher, /limits\.Basic\.Flags = JobObjectLimitKillOnJobClose/u);
  assert.match(launcher, /WaitForMultipleObjects\(2, new\[\] \{ blender\.Process, host \}/u);
  assert.doesNotMatch(launcher, /\b(?:SwitchDesktop|ShowWindow|SetForegroundWindow)\(/u);
});

test('launcher preserves Blender paths and arguments using Windows quoting', () => {
  const executable = 'C:\\Program Files\\Blender\\blender.exe';
  const launch = blenderDesktopLaunch(executable, ['--python', 'C:\\My Scripts\\视口.py', '', 'a"b', 'C:\\tmp\\'], { KEEP: 'value' });
  assert.ok(launch.args.at(-1).endsWith('launch-win32.ps1'));
  assert.equal(launch.env.KEEP, 'value');
  assert.equal(launch.env.DSH_BLENDER_LAUNCH_EXECUTABLE, executable);
  assert.equal(launch.env.DSH_BLENDER_LAUNCH_COMMAND,
    '"C:\\Program Files\\Blender\\blender.exe" "--python" "C:\\My Scripts\\视口.py" "" "a\\"b" "C:\\tmp\\\\"');
  assert.equal(launch.env.DSH_BLENDER_LAUNCH_HOST_PID, String(process.pid));
});
