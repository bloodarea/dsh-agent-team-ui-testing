"""Shared CLI envelope for the optional WorldMirror and SpatialLM workers (v1).
No model imports occur until request validation completes.
"""
import argparse
import contextlib
import ctypes
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import traceback


class WorkerFailure(Exception):
    def __init__(self, prefix, reason):
        super().__init__(reason)
        self.prefix = prefix


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def fail(prefix, reason):
    raise WorkerFailure(prefix, reason)


def peak_ram():
    if os.name == "nt":
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [(n, ctypes.c_size_t) for n in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        get_handle = ctypes.windll.kernel32.GetCurrentProcess
        get_handle.restype = wintypes.HANDLE
        query = ctypes.windll.psapi.GetProcessMemoryInfo
        query.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
        query.restype = wintypes.BOOL
        if query(get_handle(), ctypes.byref(counters), counters.cb):
            return counters.PeakWorkingSetSize
        return None
    import resource
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)


class Job:
    def __init__(self, request, provider_id, capabilities):
        self.started = time.perf_counter()
        self.request = request
        if request.get("providerId") != provider_id or request.get("capabilityId") not in capabilities:
            fail("MODEL_LOAD_FAILED", "provider-or-capability-mismatch")
        self.root = Path(request["workDir"])
        if not self.root.is_absolute() or not self.root.is_dir():
            fail("MODEL_LOAD_FAILED", "workDir-must-be-existing-absolute-directory")
        self.root = self.root.resolve()
        # All imports/caches/temp files owned by the child remain in this job.
        for name in ("TMP", "TEMP", "TMPDIR", "TORCHINDUCTOR_CACHE_DIR", "TRITON_CACHE_DIR", "TORCH_EXTENSIONS_DIR", "MPLCONFIGDIR"):
            folder = self.root / ("cache-" + name.lower())
            folder.mkdir(exist_ok=True)
            os.environ[name] = str(folder)
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
        sys.dont_write_bytecode = True
        self.config = request.get("config", {})
        self.budget = request.get("budget", {})
        self.inputs = request.get("inputs", [])
        if not self.inputs:
            fail("ASSET_DIGEST_MISMATCH", "inputs-required")
        for item in self.inputs:
            path = Path(item["path"])
            if not path.is_absolute() or not path.is_file():
                fail("ASSET_DIGEST_MISMATCH", "input-path-not-absolute-file")
            if digest(path) != item.get("sha256"):
                fail("ASSET_DIGEST_MISMATCH", "input-digest-mismatch")
        self.weights = Path(request.get("weightsPath", ""))
        if not self.weights.exists():
            fail("WEIGHTS_MISSING", str(self.weights))
        expected_weights = request.get("weightsSha256")
        weights_file = self.weights / "model.safetensors" if self.weights.is_dir() else self.weights
        if expected_weights and (not weights_file.is_file() or digest(weights_file) != expected_weights):
            fail("ASSET_DIGEST_MISMATCH", "weights-digest-mismatch")
        self.artifacts = []
        self.cold_ms = None

    def check(self):
        timeout = self.budget.get("timeoutMs")
        if timeout is not None and (time.perf_counter() - self.started) * 1000 > timeout:
            fail("DEVICE_UNAVAILABLE", "soft-time-budget-exceeded")

    def artifact(self, path, kind, media_type, **metadata):
        path = Path(path).resolve()
        if not path.is_relative_to(self.root) or path.is_symlink():
            fail("OUTPUT_LIMIT", "artifact-outside-workDir")
        self.artifacts.append(dict(kind=kind, path=path.relative_to(self.root).as_posix(), mediaType=media_type, sha256=digest(path), bytes=path.stat().st_size, **metadata))
        maximum = self.budget.get("maxOutputBytes")
        if maximum is not None and sum(a["bytes"] for a in self.artifacts) > maximum:
            fail("OUTPUT_LIMIT", "max-output-bytes-exceeded")
        self.check()

    def json(self, name, value, kind="report", **metadata):
        path = self.root / "artifacts" / name
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(value, allow_nan=False, indent=2), encoding="utf-8")
        self.artifact(path, kind, "application/json", **metadata)

    def torch(self):
        import torch
        device = self.config.get("device", "cuda")
        if device != "cuda" or not torch.cuda.is_available():
            fail("DEVICE_UNAVAILABLE", "cuda-required-or-unavailable")
        torch.cuda.reset_peak_memory_stats()
        return torch

    def finish(self, provider_id, version, metrics, limitations):
        import torch
        peak_vram = torch.cuda.max_memory_allocated() if torch.cuda.is_available() else None
        if self.budget.get("maxVramBytes") is not None and peak_vram is not None and peak_vram > self.budget["maxVramBytes"]:
            fail("DEVICE_UNAVAILABLE", "vram-budget-exceeded")
        return dict(ok=True, providerId=provider_id, capabilityId=self.request["capabilityId"], artifacts=self.artifacts, metrics=metrics,
                    resources=dict(wallMs=round((time.perf_counter() - self.started) * 1000), peakRamBytes=peak_ram(), peakVramBytes=peak_vram, coldStartMs=self.cold_ms),
                    limitations=limitations, modelVersion=version)


def main(provider_id, capabilities, run):
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    diagnostics = []
    # Buffer diagnostics so the failure prefix is the first stderr line, even
    # when an upstream library prints progress before failing.
    import io
    capture = io.StringIO()
    try:
        if output.exists():
            fail("MODEL_LOAD_FAILED", "refusing-existing-result-file")
        request = json.loads(Path(args.request).read_text(encoding="utf-8-sig"))
        job = Job(request, provider_id, capabilities)
        if output.parent.resolve() != job.root:
            fail("MODEL_LOAD_FAILED", "result-must-be-in-workDir")
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
            result = run(job)
        job.check()
        output.write_text(json.dumps(result, allow_nan=False, indent=2), encoding="utf-8")
        sys.stderr.write(capture.getvalue())
        print(json.dumps({"ok": True, "providerId": provider_id, "artifacts": len(result["artifacts"]), "wallMs": result["resources"]["wallMs"]}))
        return 0
    except Exception as error:
        if isinstance(error, WorkerFailure):
            prefix = error.prefix
        elif isinstance(error, (ImportError, ModuleNotFoundError)):
            prefix = "DEPENDENCY_MISSING"
        elif "out of memory" in str(error).lower():
            prefix = "DEVICE_UNAVAILABLE"
        else:
            prefix = "MODEL_LOAD_FAILED"
        sys.stderr.write(prefix + ": " + str(error) + "\n")
        sys.stderr.write(capture.getvalue())
        traceback.print_exc(file=sys.stderr)
        return 1
