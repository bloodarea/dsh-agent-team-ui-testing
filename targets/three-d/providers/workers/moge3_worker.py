"""MoGe-3 local worker; base geometry only when refineSteps=0."""
import time
from moge3_protocol import WorkerFailure, artifact, main

CAPABILITIES = ["vision.depth.relative", "vision.surface.normal", "vision.camera.intrinsics", "vision.pointcloud"]


def infer(req, workdir, source, torch, np, Image, started):
    config = req.get("config", {})
    if config.get("refineSteps", 0) != 0:
        raise WorkerFailure("DEPENDENCY_MISSING", "MoGe refiner requires compatible flex_gemm/triton; only refineSteps=0 is supported")
    from moge.model.v3 import MoGeModel
    checkpoint = torch.load(req["weightsPath"], map_location="cpu", weights_only=True)
    model_config = dict(checkpoint["model_config"])
    model_config.pop("refiner", None)
    model = MoGeModel(**model_config)
    missing, unexpected = model.load_state_dict(checkpoint["model"], strict=False)
    if missing or any(not name.startswith("refiner.") for name in unexpected):
        raise WorkerFailure("MODEL_LOAD_FAILED", f"unexpected state keys: missing={missing}, unexpected={unexpected[:5]}")
    device = config.get("device", "cuda")
    model.to(device).eval()
    image = np.array(Image.open(source).convert("RGB"))
    target = int(config.get("targetResolution", 518))
    if target < 64 or target > 1536:
        raise ValueError("targetResolution must be 64..1536")
    h, w = image.shape[:2]
    if max(h, w) > target:
        image = np.array(Image.fromarray(image).resize((max(1, round(w * target / max(h, w))), max(1, round(h * target / max(h, w))))))
    h, w = image.shape[:2]
    tensor = torch.tensor(image / 255.0, dtype=torch.float32, device=device).permute(2, 0, 1)
    cold_ms = (time.perf_counter() - started) * 1000
    t0 = time.perf_counter()
    with torch.no_grad():
        outputs = model.infer(tensor, resolution_level=int(config.get("resolutionLevel", 2)), refine_steps=0)
    if device == "cuda":
        torch.cuda.synchronize()
    inference_ms = (time.perf_counter() - t0) * 1000
    depth = outputs["depth"].float().cpu().numpy()
    normal = outputs["normal"].float().cpu().numpy()
    points = outputs["points"].float().cpu().numpy()
    mask = outputs["mask"].cpu().numpy().astype(bool)
    intrinsics = outputs["intrinsics"].float().cpu().numpy()
    valid = mask & np.isfinite(depth) & np.isfinite(points).all(axis=-1) & np.isfinite(normal).all(axis=-1)
    if not valid.any():
        raise ValueError("model returned no valid geometry")
    # Absolute scale has no calibration evidence; normalize depth and points together.
    scale = float(np.median(depth[valid]))
    depth = np.where(valid, depth / scale, 0).astype(np.float32)
    points = np.where(valid[..., None], points / scale, 0).astype(np.float32)
    normal = np.where(valid[..., None], normal, 0).astype(np.float32)
    directory = workdir / "artifacts"
    directory.mkdir(exist_ok=True)
    products = []
    for name, array, kind, channels in [("depth", depth, "relativeDepthRaster", 1), ("normal", normal, "normalRaster", 3), ("mask", valid, "maskRaster", 1)]:
        np.save(directory / (name + ".npy"), array)
        products.append(artifact(workdir, "artifacts/" + name + ".npy", kind, "application/x-npy", w, h, channels))
    np.save(directory / "points.npy", points[valid])
    products.append(artifact(workdir, "artifacts/points.npy", "pointCloud", "application/x-npy", channels=3))
    import json
    (directory / "camera.json").write_text(json.dumps({"intrinsics": intrinsics.tolist(), "normalization": "image-width-height", "width": w, "height": h, "coordinateFrame": "camera-opencv-x-right-y-down-z-forward", "extrinsics": None}), encoding="utf-8")
    products.append(artifact(workdir, "artifacts/camera.json", "cameraModel", "application/json"))
    return {"artifacts": products, "metrics": {"inferenceMs": round(inference_ms, 3), "validPixelRatio": float(valid.mean()), "pointCount": int(valid.sum()), "fovDeg": float(2 * np.degrees(np.arctan(0.5 / intrinsics[0, 0])))}, "resources": {"coldStartMs": round(cold_ms, 3)}, "limitations": ["refiner-disabled-flex_gemm-triton-incompatible", "relative-depth-only", "metric-scale-unresolved", "quality-benchmark-not-run"], "modelVersion": "moge-3-vitl@sha256-9b41b7b9f65a"}


if __name__ == "__main__":
    main("vision.moge3", CAPABILITIES, infer)
