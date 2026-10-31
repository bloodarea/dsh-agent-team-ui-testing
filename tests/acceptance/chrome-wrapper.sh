#!/usr/bin/env bash
# Local acceptance wrapper around the real Chromium binary.
#
# Why this exists: DSH runs delegated-agent shell commands inside a file sandbox. Inside that
# sandbox Chrome cannot create its setuid sandbox namespaces nor write /dev/shm, so a plain
# `chrome --headless=new` invocation dies during zygote startup ("Zygote process exited
# prematurely"). Outside the sandbox (normal DSH host process) the plugin's default flags work.
#
# This wrapper launches the *same* real binary with three test-only compatibility flags and
# passes every plugin-supplied argument through unchanged:
#   --no-sandbox            : setuid sandbox is unavailable inside the file sandbox
#   --disable-dev-shm-usage : /dev/shm is not writable inside the file sandbox
#   --disable-crash-reporter: crashpad cannot write ~/.config/google-chrome inside the sandbox
#
# It is NOT used by default: tests/acceptance/run.mjs first tries the plugin's real default
# (/opt/google/chrome/chrome), and only falls back to this wrapper when that launch fails, so
# the fallback is recorded in run-report.json as an environment fact.
set -euo pipefail

REAL_CHROME="${CHROME_REAL_BIN:-/opt/google/chrome/chrome}"

if [ ! -x "$REAL_CHROME" ]; then
  echo "chrome-wrapper: $REAL_CHROME is not executable" >&2
  exit 127
fi

exec "$REAL_CHROME" --no-sandbox --disable-dev-shm-usage --disable-crash-reporter "$@"
