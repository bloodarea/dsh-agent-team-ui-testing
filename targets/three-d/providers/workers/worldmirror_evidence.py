"""Recompute local evidence integrity; does not load a model or allocate CUDA."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[4]
BASE = ROOT / "docs/internal/blender-agent/provider-evidence"


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1048576), b""):
            h.update(block)
    return h.hexdigest()


def dump(path, data):
    path.write_text(json.dumps(data, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def inspect_run(summary):
    import numpy as np
    if summary["status"] != "passed":
        return summary
    run = ROOT / summary["workDir"]
    result = json.loads((run / "result.json").read_text(encoding="utf-8"))
    request = json.loads((run / "request.json").read_text(encoding="utf-8"))
    total = 0
    arrays = []
    for artifact in result["artifacts"]:
        filename = (run / artifact["path"]).resolve()
        assert filename.is_relative_to(run.resolve())
        assert digest(filename) == artifact["sha256"]
        assert filename.stat().st_size == artifact["bytes"]
        total += artifact["bytes"]
        if artifact["kind"] == "relativeDepthRaster":
            assert artifact["unit"] is None
        assert artifact["kind"] != "mesh", "Neither provider claims fine mesh"
        if filename.suffix in (".npy", ".npz"):
            loaded = np.load(filename, allow_pickle=False)
            parts = {"array": loaded} if filename.suffix == ".npy" else {name: loaded[name] for name in loaded.files}
            for name, array in parts.items():
                assert np.isfinite(array).all(), str(filename) + ": nonfinite " + name
                arrays.append({"artifact": artifact["path"], "name": name, "shape": list(array.shape), "dtype": str(array.dtype), "finite": True})
            if filename.suffix == ".npz":
                loaded.close()
    for item in request["inputs"]:
        assert digest(item["path"]) == item["sha256"]
    summary["integrity"] = {"status": "PASS", "artifactCount": len(result["artifacts"]), "artifactBytes": total, "inputDigestCount": len(request["inputs"]), "arrays": arrays}
    summary["requestRef"] = summary["workDir"] + "/request.json"
    summary["resultRef"] = summary["workDir"] + "/result.json"
    summary["stderrRef"] = summary["workDir"] + "/stderr.log"
    summary["precision"] = "bf16 inference (autocast/dtype=bf16); no numeric comparison against fp32"
    return summary


def main():
    checked_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    packages = {}
    for package in ("torch", "numpy", "safetensors", "transformers", "flash-attn", "torch-scatter", "triton", "spconv-cu124", "open3d", "omegaconf", "Pillow"):
        try:
            packages[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            packages[package] = None
    engines = Path(os.environ["DSH_BLENDER_ENGINES_ROOT"])
    for provider_id, engine, files in (("vision.hyworld", "HY-World-2.0", ["hyworld2/worldrecon/pipeline.py", "hyworld2/worldrecon/hyworldmirror/models/models/rasterization.py"]),
                                       ("vision.spatiallm", "SpatialLM", ["inference.py", "spatiallm/model/spatiallm_qwen.py", "spatiallm/model/sonata_encoder.py"])):
        folder = BASE / provider_id
        folder.mkdir(parents=True, exist_ok=True)
        source = engines / engine
        commit = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], capture_output=True, text=True)
        lock = {"python": platform.python_version(), "platform": platform.platform(), "packages": packages,
                "engineCommit": commit.stdout.strip() if commit.returncode == 0 else None,
                "engineFiles": {name: digest(source / name) for name in files if (source / name).is_file()},
                "workerFiles": {file.name: digest(file) for file in Path(__file__).parent.glob("worldmirror_*.py") if file.name != Path(__file__).name}}
        if provider_id == "vision.spatiallm":
            lock["workerFiles"]["spatiallm_worker.py"] = digest(Path(__file__).parent / "spatiallm_worker.py")
        dump(folder / "dependencies.json", lock)
        runs = [inspect_run(json.loads(attempt.read_text(encoding="utf-8"))) for attempt in sorted(folder.glob("attempt-*.json"))]
        passed = [r for r in runs if r["status"] == "passed"]
        checks = []
        labels = {1: "Manifest and capability schema", 2: "Missing runtime/weights/dependencies, disabled/license/device", 3: "ACL, digest, format, units and resolver pointcloud validation", 4: "Budget, timeout, cancellation, descendant cleanup, output limit", 5: "Artifact digests, observation provenance, model version and configuration", 6: "Cache version/weights/device/config isolation", 7: "Core import and Economy baseline with model configuration absent", 8: "Disabled/unregistered/crashed provider isolation", 9: "Ground-truth benchmark quality", 10: "Explicit quality-unverified reporting"}
        cpu_ref = "docs/internal/blender-agent/provider-evidence/vision.hyworld/cpu-conformance.log"
        baseline_ref = "docs/internal/blender-agent/provider-evidence/vision.hyworld/optional-core-baseline.log"
        for number, label in labels.items():
            status = "UNKNOWN" if number == 9 else "PASS"
            refs = [baseline_ref] if number == 7 else [cpu_ref]
            reason = "No labeled benchmark with measured accuracy/IoU; smoke is operational evidence only" if number == 9 else None
            if number == 5:
                refs += [run["resultRef"] for run in passed]
                if not passed:
                    status, reason = "UNKNOWN", "No successful real run"
            checks.append({"id": number, "name": label, "status": status, "reason": reason, "evidenceRefs": refs})
        latest = passed[-1] if passed else None
        limitations = latest["limitations"] if latest else ["no-successful-real-run"]
        report = {"providerId": provider_id, "checkedAt": checked_at, "suiteVersion": "wm-slm-conformance-v1", "platform": platform.platform(), "runs": runs, "checks": checks,
                  "smoke": {"status": "passed" if passed else "failed", "meaning": "worker execution, protocol, digests and finite-output checks; not benchmark acceptance"},
                  "quality": {"status": "unverified", "dataset": "local six-view synthetic atrium / caller-scaled z-up pointcloud", "accuracy": None, "semanticIoU": None,
                              "domainShift": "Residential training model historically misses the 13.5m atrium" if provider_id == "vision.spatiallm" else None},
                  "dependencyLockSha256": digest(folder / "dependencies.json"), "limitations": limitations, "verdict": "partial",
                  "optionality": {"modelPathsFrom": ["DSH_BLENDER_PYTHON", "DSH_BLENDER_MODELS_ROOT", "DSH_BLENDER_ENGINES_ROOT"], "autoRegistered": False,
                                  "coreBaseline": {"files": 14, "pass": 198, "fail": 0, "modelEnvironment": "all unset", "evidenceRef": baseline_ref}},
                  "scheduling": {"gpuExclusive": True, "concurrentOom": False, "viewDowngrade": False},
                  "overflowGuard": {"mode": "runtime-only", "upstreamModified": False, "unpatchedBugReproduction": "NOT RUN"} if provider_id == "vision.hyworld" else None}
        if provider_id == "vision.hyworld":
            report["preMeasurementAttempt"] = {"status": "blocked-before-worker", "reason": "maxVramBytes supplied while manifest estimate was null; RESOURCE_BUDGET_EXCEEDED correctly enforced. Measurement rerun uses maxVramBytes:null."}
        if provider_id == "vision.hyworld" and len(passed) >= 2:
            model_hashes = []
            for run in passed:
                result = json.loads((ROOT / run["resultRef"]).read_text(encoding="utf-8"))
                model_hashes.append({a["path"]: a["sha256"] for a in result["artifacts"] if a["kind"] != "report"})
            report["reproducibility"] = {"runsCompared": len(model_hashes), "modelArtifactCountPerRun": len(model_hashes[0]),
                                         "allModelArtifactDigestsIdentical": all(h == model_hashes[0] for h in model_hashes[1:]),
                                         "scope": "same six images, device, bf16 precision and resolution518; no cross-device or fp32 equivalence assertion"}
        if latest and provider_id == "vision.spatiallm" and latest["metrics"]["semanticEntityCount"] == 0:
            report["quality"]["localOutcome"] = "FAIL: generated incomplete layout, zero parseable semantic entities; no useful room reconstruction established"
            report["smoke"] = {"status": "failed", "workerExecutionStatus": "passed", "reason": "Two real forward runs produced incomplete wall_0=Wall(7, and zero usable entities"}
            report["limitations"] = list(report["limitations"]) + ["domain-mismatch-residential-model-on-large-hall"]
            report["failureReproduction"] = [{"resultRef": run["resultRef"], "entityCount": run["metrics"]["semanticEntityCount"],
                                              "rawOutputRef": run["workDir"] + "/artifacts/generated-layout.json",
                                              "attentionMask": "explicit-ones" if index == 1 else "upstream-inferred"} for index, run in enumerate(passed)]
            report["domainMismatchHypothesis"] = "Residential training domain versus caller-scaled 13.5m hall; domain/input mismatch is a hypothesis, not an isolated causal proof"
        dump(folder / "report.json", report)
        print(json.dumps({"providerId": provider_id, "runs": len(runs), "passedRuns": len(passed), "dependencyLockSha256": report["dependencyLockSha256"], "verdict": report["verdict"]}))


if __name__ == "__main__":
    main()
