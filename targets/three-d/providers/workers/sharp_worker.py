"""SHARP inference worker. Writes real Gaussian parameters; no substitute renderer."""
import time
from moge3_protocol import artifact, main


def infer(req, workdir, source, torch, np, Image, started):
    from sharp.models import PredictorParams, create_predictor
    # Import the official inference routine, preserving its preprocessing and unprojection.
    from sharp.cli.predict import predict_image
    from sharp.utils import io
    from sharp.utils.gaussians import save_ply
    device = req.get("config", {}).get("device", "cuda")
    model = create_predictor(PredictorParams())
    model.load_state_dict(torch.load(req["weightsPath"], map_location="cpu", weights_only=True))
    model.eval().to(device)
    image, _, focal_px = io.load_rgb(source)
    height, width = image.shape[:2]
    cold_ms = (time.perf_counter() - started) * 1000
    t0 = time.perf_counter()
    with torch.no_grad():
        gaussians = predict_image(model, image, focal_px, torch.device(device))
    if device == "cuda":
        torch.cuda.synchronize()
    inference_ms = (time.perf_counter() - t0) * 1000
    directory = workdir / "artifacts"
    directory.mkdir(exist_ok=True)
    save_ply(gaussians, focal_px, (height, width), directory / "gaussians.ply")
    from plyfile import PlyData
    ply = PlyData.read(directory / "gaussians.ply")
    data = ply["vertex"].data
    required = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    if any(name not in data.dtype.names for name in required) or len(data) == 0:
        raise ValueError("invalid Gaussian PLY")
    if not all(np.isfinite(data[name]).all() for name in required):
        raise ValueError("nonfinite Gaussian parameters")
    return {"artifacts": [artifact(workdir, "artifacts/gaussians.ply", "gaussianSplat", "application/x-ply")], "metrics": {"inferenceMs": round(inference_ms, 3), "gaussianCount": len(data), "renderQuality": None}, "resources": {"coldStartMs": round(cold_ms, 3)}, "limitations": ["gaussian-splat-is-not-editable-mesh", "scale-unverified", "focal-length-may-be-estimated-from-image-metadata", "gsplat-cuda-renderer-not-validated", "render-not-run-no-approximate-splat-substitution", "quality-benchmark-not-run"], "modelVersion": "sharp@2572gikvuh"}


if __name__ == "__main__":
    main("vision.sharp", ["vision.gaussian_splat"], infer)
