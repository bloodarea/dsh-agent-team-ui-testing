"""Common protocol mechanics for the MoGe/SHARP workers (no model imports)."""
import argparse
import contextlib
import hashlib
import json
import os
import sys
import time
import traceback
from pathlib import Path


class WorkerFailure(Exception):
    def __init__(self, prefix, message):
        self.prefix = prefix
        super().__init__(message)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def peak_ram():
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [(name, ctypes.c_size_t) for name in ["PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage"]]
        value = Counters()
        value.cb = ctypes.sizeof(value)
        kernel = ctypes.windll.kernel32
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        get_memory = ctypes.windll.psapi.GetProcessMemoryInfo
        get_memory.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        get_memory.restype = wintypes.BOOL
        if get_memory(kernel.GetCurrentProcess(), ctypes.byref(value), value.cb):
            return int(value.PeakWorkingSetSize)
        return None
    import resource
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024))


def artifact(workdir, relative, kind, media_type, width=None, height=None, channels=None, unit=None):
    path = workdir / relative
    return {"kind": kind, "path": relative, "mediaType": media_type, "sha256": digest(path), "bytes": path.stat().st_size, "width": width, "height": height, "channels": channels, "unit": unit}


def main(provider_id, capabilities, infer):
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    # Capture all library diagnostics so failure prefixes are always stderr's first line.
    started = time.perf_counter()
    diagnostics = None
    try:
        if output.exists():
            output.unlink()
        req = json.loads(Path(args.request).read_text(encoding="utf-8"))
        if req["providerId"] != provider_id or req["capabilityId"] not in capabilities:
            raise ValueError("unsupported provider/capability")
        workdir = Path(req["workDir"])
        if not workdir.is_absolute() or not workdir.is_dir():
            raise ValueError("workDir must be an existing absolute directory")
        if output.parent.resolve() != workdir.resolve():
            raise ValueError("result must be inside workDir")
        diagnostics = open(workdir / "diagnostics.log", "w+", encoding="utf-8")
        with contextlib.redirect_stdout(diagnostics), contextlib.redirect_stderr(diagnostics):
            inputs = req["inputs"]
            if len(inputs) != 1:
                raise ValueError("exactly one image required")
            source = Path(inputs[0]["path"])
            if not source.is_absolute():
                raise ValueError("absolute input required")
            if digest(source) != inputs[0]["sha256"]:
                raise WorkerFailure("ASSET_DIGEST_MISMATCH", "input digest differs")
            weights = Path(req["weightsPath"])
            if not weights.is_file():
                raise WorkerFailure("WEIGHTS_MISSING", str(weights))
            # Bind model provenance to actual file bytes, not a caller assertion.
            if req.get("weightsSha256") and digest(weights) != req["weightsSha256"]:
                raise WorkerFailure("ASSET_DIGEST_MISMATCH", "weights digest differs")
            try:
                import torch
                import numpy as np
                from PIL import Image
            except ImportError as exc:
                raise WorkerFailure("DEPENDENCY_MISSING", str(exc)) from exc
            device = req.get("config", {}).get("device", "cuda")
            if device not in ("cpu", "cuda") or (device == "cuda" and not torch.cuda.is_available()):
                raise WorkerFailure("DEVICE_UNAVAILABLE", device)
            if device == "cuda":
                torch.cuda.reset_peak_memory_stats()
            # Image decode happens only after the digest has been verified.
            with Image.open(source) as image:
                if image.width * image.height > 16777216:
                    raise ValueError("input exceeds 16 megapixels")
                image.verify()
            result = infer(req, workdir, source, torch, np, Image, started)
            if device == "cuda":
                torch.cuda.synchronize()
            result["resources"].update(wallMs=round((time.perf_counter() - started) * 1000, 3), peakRamBytes=peak_ram(), peakVramBytes=int(torch.cuda.max_memory_allocated()) if device == "cuda" else None)
            cap = req.get("budget", {}).get("maxVramBytes")
            if cap is not None and result["resources"]["peakVramBytes"] is not None and result["resources"]["peakVramBytes"] > cap:
                raise WorkerFailure("DEVICE_UNAVAILABLE", "VRAM budget exceeded")
            total = sum(item["bytes"] for item in result["artifacts"])
            limit = req.get("budget", {}).get("maxOutputBytes")
            if limit is not None and total > limit:
                raise WorkerFailure("OUTPUT_LIMIT", f"{total} > {limit}")
            if (time.perf_counter() - started) * 1000 > req.get("budget", {}).get("timeoutMs", float("inf")):
                raise WorkerFailure("DEVICE_UNAVAILABLE", "soft wall budget exceeded")
            result.update(ok=True, providerId=provider_id, capabilityId=req["capabilityId"])
            output.write_text(json.dumps(result, allow_nan=False, indent=2), encoding="utf-8")
        diagnostics.close()
        diagnostics = None
        if device == "cuda":
            torch.cuda.empty_cache()
        print(json.dumps({"ok": True, "providerId": provider_id, "artifactCount": len(result["artifacts"]), "wallMs": result["resources"]["wallMs"]}))
    except Exception as exc:
        if output.exists():
            output.unlink()
        prefix = exc.prefix if isinstance(exc, WorkerFailure) else "DEPENDENCY_MISSING" if isinstance(exc, ImportError) else "DEVICE_UNAVAILABLE" if "out of memory" in str(exc).lower() else "MODEL_LOAD_FAILED"
        print(f"{prefix}: {exc}", file=sys.stderr)
        if diagnostics:
            diagnostics.flush()
            diagnostics.seek(0)
            # Keep diagnostics bounded even on verbose model failures.
            text = diagnostics.read()
            print(text[-32768:], file=sys.stderr)
            diagnostics.close()
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
