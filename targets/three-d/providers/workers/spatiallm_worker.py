"""Optional SpatialLM 1.1 semantic layout worker; never produces a fine mesh."""
from dataclasses import asdict
import importlib.util
from pathlib import Path
import sys
import time
from worldmirror_protocol import main, fail

PROVIDER_ID = "vision.spatiallm"
VERSION = "spatiallm-1.1-qwen-0.5b@ed2e1ca161d9"
CAPABILITIES = ["vision.spatial.semantic"]


def run(job):
    if len(job.inputs) != 1 or Path(job.inputs[0]["path"]).suffix.lower() != ".ply":
        fail("ASSET_DIGEST_MISMATCH", "one-ply-pointcloud-required")
    if job.config.get("axisUp") != "z" or job.config.get("axisAligned") is not True or job.config.get("inputUnit") != "m":
        fail("ASSET_DIGEST_MISMATCH", "pointcloud-requires-metric-z-up-axis-aligned-metadata")
    max_tokens = job.config.get("maxNewTokens", 4096)
    if not isinstance(max_tokens, int) or not 32 <= max_tokens <= 8192:
        fail("OUTPUT_LIMIT", "maxNewTokens-must-be-32-to-8192")
    torch = job.torch()
    import numpy as np
    import spatiallm
    from spatiallm import Layout
    from spatiallm.pcd import load_o3d_pcd, get_points_and_colors, cleanup_pcd
    from transformers import AutoTokenizer, AutoModelForCausalLM, set_seed
    # Reuse upstream preprocessing and prompt; no subprocess, download or source edits.
    source = Path(spatiallm.__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location("spatiallm_upstream_inference", source / "inference.py")
    upstream = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upstream)
    t0 = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(str(job.weights), local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(str(job.weights), torch_dtype=torch.bfloat16, local_files_only=True)
    model.to("cuda")
    model.set_point_backbone_dtype(torch.float32)
    model.eval()
    job.cold_ms = round((time.perf_counter() - t0) * 1000)
    job.check()
    cloud = load_o3d_pcd(job.inputs[0]["path"])
    grid_size = Layout.get_grid_size(model.config.point_config["num_bins"])
    cloud = cleanup_pcd(cloud, voxel_size=grid_size)
    points, colors = get_points_and_colors(cloud)
    if len(points) < 32 or not np.isfinite(points).all():
        fail("ASSET_DIGEST_MISMATCH", "pointcloud-empty-or-nonfinite")
    minimum = np.min(points, axis=0)
    extent = np.ptp(points, axis=0)
    bins = model.config.point_config["num_bins"]
    features = upstream.preprocess_point_cloud(points, colors, grid_size, bins)
    template = (source / "code_template.txt").read_text(encoding="utf-8")
    detect = job.config.get("detectType", "all")
    if detect not in upstream.DETECT_TYPE_PROMPT:
        fail("ASSET_DIGEST_MISMATCH", "unsupported-detectType")
    prompt = "<|point_start|><|point_pad|><|point_end|>" + upstream.DETECT_TYPE_PROMPT[detect] + " The reference code is as followed: " + template
    conversation = [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": prompt}]
    input_ids = tokenizer.apply_chat_template(conversation, add_generation_prompt=True, return_tensors="pt").to(model.device)
    seed = job.config.get("seed", 42)
    set_seed(seed)
    inference_started = time.perf_counter()
    with torch.inference_mode():
        generated = model.generate(input_ids=input_ids, attention_mask=torch.ones_like(input_ids), point_clouds=features, max_new_tokens=max_tokens,
                                   do_sample=True, use_cache=True, temperature=0.6, top_p=0.95, top_k=10, num_beams=1)
    torch.cuda.synchronize()
    inference_ms = round((time.perf_counter() - inference_started) * 1000)
    job.check()
    token_ids = generated[0, input_ids.shape[1]:]
    text = tokenizer.decode(token_ids, skip_special_tokens=True)
    layout = Layout(text)
    layout.undiscretize_and_unnormalize(num_bins=bins)
    layout.translate(minimum)
    nodes = []
    for kind, entities in (("wall", layout.walls), ("door", layout.doors), ("window", layout.windows), ("bbox", layout.bboxes)):
        nodes.extend({"kind": kind, **asdict(entity)} for entity in entities)
    boxes = [{key: value.tolist() if isinstance(value, np.ndarray) else value for key, value in box.items()} for box in layout.to_boxes()]
    limitations = ["noncommercial-cc-by-nc-4.0", "pointcloud-input-required", "metric-z-up-axis-aligned-input-required", "semantic-boxes-are-not-fine-mesh", "quality-unverified", "residential-training-domain-shift-large-13.5m-atrium", "input-scale-is-caller-asserted-not-model-calibrated", "generated-layout-requires-review", "bfloat16-inference-not-compared-with-float32"]
    if not nodes:
        limitations.append("no-semantic-entities-detected")
    if len(token_ids) >= max_tokens:
        limitations.append("generation-token-budget-reached")
    if float(extent.max()) > 32:
        limitations.append("pointcloud-exceeds-32m-normalization-domain")
    job.json("spatial-graph.json", {"nodes": nodes, "edges": [], "coordinateFrame": "world-z-up", "unit": "m", "quality": "unverified"}, "spatialGraph", unit="m")
    job.json("boxes.json", {"boxes": boxes, "coordinateFrame": "world-z-up", "unit": "m", "fineMesh": False}, "bbox3d", unit="m")
    job.json("generated-layout.json", {"raw": text, "normalizedLayout": layout.to_language_string(), "seed": seed})
    metrics = dict(pointCount=len(points), inputExtent=extent.tolist(), wallCount=len(layout.walls), doorCount=len(layout.doors), windowCount=len(layout.windows),
                   boxCount=len(layout.bboxes), semanticEntityCount=len(nodes), generatedTokens=len(token_ids), inferenceMs=inference_ms, benchmarkAccuracy=None, semanticIoU=None)
    job.json("quality.json", {"metrics": metrics, "limitations": limitations, "inputs": job.inputs, "config": job.config})
    return job.finish(PROVIDER_ID, VERSION, metrics, limitations)


if __name__ == "__main__":
    sys.exit(main(PROVIDER_ID, CAPABILITIES, run))
