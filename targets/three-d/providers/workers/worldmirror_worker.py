"""Optional HY-WorldMirror 2.0 multiview worker; worker protocol v1."""
import os
from pathlib import Path
import sys
import time
from worldmirror_protocol import main, fail

PROVIDER_ID = "vision.hyworld"
VERSION = "hy-worldmirror-2.0@9fff06539d3d"
CAPABILITIES = ["vision.depth.relative", "vision.surface.normal", "vision.camera.intrinsics", "vision.camera.pose", "vision.pointcloud", "vision.gaussian_splat"]


def run(job):
    for item in job.inputs:
        if Path(item["path"]).suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            fail("ASSET_DIGEST_MISMATCH", "image-input-required")
    size = job.config.get("targetResolution", 518)
    if not isinstance(size, int) or size < 112 or size > 952:
        fail("OUTPUT_LIMIT", "targetResolution-must-be-112-to-952")
    if job.config.get("precision", "bfloat16") != "bfloat16":
        fail("MODEL_LOAD_FAILED", "only-explicit-bfloat16-inference-supported")
    torch = job.torch()
    import numpy as np
    from hyworld2.worldrecon.pipeline import WorldMirrorPipeline
    from worldmirror_voxel import install_guard
    limitations = ["relative-depth-only", "metric-scale-unresolved", "quality-unverified", "camera-pose-not-calibrated", "model-relative-coordinate-frame", "gaussian-splat-is-not-editable-mesh", "license-territory-excludes-eu-uk-south-korea", "commercial-license-required-over-1m-mau", "bfloat16-inference-not-compared-with-float32"]
    if len(job.inputs) == 1:
        limitations.append("single-image-degenerate-use-multiview-recommended")
    t0 = time.perf_counter()
    pipeline = WorldMirrorPipeline.from_pretrained(str(job.weights.parent), subfolder="", enable_bf16=job.config.get("precision", "bfloat16") == "bfloat16")
    if hasattr(pipeline.model, "gs_renderer"):
        limitations.append(install_guard(pipeline.model.gs_renderer))
    job.cold_ms = round((time.perf_counter() - t0) * 1000)
    job.check()
    with torch.inference_mode():
        predictions, images, infer_seconds = pipeline._run_inference([item["path"] for item in job.inputs], size, None, None)
    job.check()
    artifact_dir = job.root / "artifacts"
    artifact_dir.mkdir(exist_ok=True)

    def array(tensor):
        if isinstance(tensor, list):
            tensor = tensor[0]
        return tensor.detach().float().cpu().numpy()

    def save_array(name, data, kind, **meta):
        path = artifact_dir / name
        np.save(path, data)
        job.artifact(path, kind, "application/x-npy", unit=None, **meta)

    depth = array(predictions["depth"])[0]
    if depth.ndim == 4 and depth.shape[-1] == 1:
        depth = depth[..., 0]
    finite = np.isfinite(depth) & (depth > 0)
    ratio = float(finite.mean())
    if ratio < 0.9:
        fail("MODEL_LOAD_FAILED", "quality-check-depth-valid-ratio-below-0.9:" + str(ratio))
    s, h, w = depth.shape
    normals = array(predictions["normals"])[0] if "normals" in predictions else None
    for i, frame in enumerate(depth):
        save_array("depth-%02d.npy" % i, frame, "relativeDepthRaster", width=w, height=h, channels=1)
        if normals is not None:
            normal = normals[i]
            if normal.shape[0] == 3 and normal.shape[-1] != 3:
                normal = normal.transpose(1, 2, 0)
            if not np.isfinite(normal).all():
                fail("MODEL_LOAD_FAILED", "nonfinite-normal-raster")
            save_array("normal-%02d.npy" % i, normal, "normalRaster", width=w, height=h, channels=3)
    camera = {"intrinsics": array(predictions["camera_intrs"])[0].tolist() if "camera_intrs" in predictions else None,
              "extrinsics": None, "calibrated": False, "poseStatus": "uncalibrated-not-published", "width": w, "height": h, "viewCount": s,
              "coordinateFrame": "model-relative", "unit": None}
    job.json("camera.json", camera, "cameraModel", unit=None)
    # Backproject depth with model-estimated cameras, solely in arbitrary model
    # coordinates. No external metric calibration or known poses are asserted.
    from hyworld2.worldrecon.hyworldmirror.utils.inference_utils import vector_to_camera_matrices, _compute_points_from_depth
    extrinsics, intrinsics = vector_to_camera_matrices(predictions["camera_params"], image_hw=(h, w))
    pts, cols = _compute_points_from_depth(predictions["depth"], images, extrinsics[0], intrinsics[0], s, h, w)
    keep = np.isfinite(pts).all(axis=-1)
    pts, cols = pts[keep], cols[keep]
    if len(pts) == 0:
        fail("MODEL_LOAD_FAILED", "empty-point-cloud")
    path = artifact_dir / "points.npz"
    np.savez_compressed(path, points=pts.astype(np.float32), colors=cols)
    job.artifact(path, "pointCloud", "application/x-npz", unit=None)
    gaussian_count = None
    dropped = None
    if "splats" in predictions:
        splats = predictions["splats"]
        data = {key: array(value)[0] if not isinstance(value, list) else array(value) for key, value in splats.items() if key in ("means", "scales", "quats", "sh", "colors", "opacities")}
        count = data["means"].shape[0]
        good = np.ones(count, dtype=bool)
        for value in data.values():
            good &= np.isfinite(value).reshape(count, -1).all(axis=1)
        good &= (data["scales"].reshape(count, -1) > 0).all(axis=1)
        dropped = int(count - good.sum())
        data = {key: value[good] for key, value in data.items()}
        gaussian_count = int(good.sum())
        if not gaussian_count:
            fail("MODEL_LOAD_FAILED", "no-valid-gaussian-splats")
        if dropped:
            limitations.append("nonfinite-or-invalid-gaussians-filtered:" + str(dropped))
        path = artifact_dir / "gaussians.npz"
        np.savez_compressed(path, **data)
        job.artifact(path, "gaussianSplat", "application/x-npz", unit=None)
    metrics = dict(viewCount=s, width=w, height=h, targetResolution=size, validPixelRatio=ratio,
                   relativeDepthMin=float(depth[finite].min()), relativeDepthMax=float(depth[finite].max()), pointCount=len(pts),
                   gaussianCount=gaussian_count, invalidGaussianCount=dropped, inferenceMs=round(infer_seconds * 1000),
                   benchmarkAccuracy=None, calibratedPoseCount=0)
    job.json("quality.json", {"metrics": metrics, "quality": "unverified", "limitations": limitations, "inputs": job.inputs, "config": job.config})
    return job.finish(PROVIDER_ID, VERSION, metrics, limitations)


if __name__ == "__main__":
    sys.exit(main(PROVIDER_ID, CAPABILITIES, run))
