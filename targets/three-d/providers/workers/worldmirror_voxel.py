"""Process-local guard for HY-WorldMirror's 3-D -> int64 voxel overflow.
The upstream files are never written. Merge formulas remain upstream-defined.
"""
import inspect
import textwrap


def install_guard(renderer):
    import torch
    cls = type(renderer)
    source = textwrap.dedent(inspect.getsource(cls.prune_gs))
    start = source.index("        # Compute voxel indices")
    end = source.index("        K = len(unique_voxels)", start)
    replacement = '''        # Runtime-only: reject nonfinite inputs before integer conversion.
        valid = torch.ones(splats_i["means"].shape[0], dtype=torch.bool, device=device)
        for value in splats_i.values():
            valid &= torch.isfinite(value).reshape(value.shape[0], -1).all(dim=1)
        valid &= (splats_i["means"].abs() < 1e6).all(dim=1)
        splats_i = {key: value[valid] for key, value in splats_i.items()}
        if not valid.any():
            raise ValueError("No finite Gaussian splats remain after voxel guard")
        voxel_indices = (splats_i["means"].double() / voxel_size).floor().long()
        # Never flatten coordinate triples into a potentially overflowing int64.
        unique_voxels, inverse_indices = torch.unique(voxel_indices, dim=0, return_inverse=True)
'''
    namespace = dict(cls.prune_gs.__globals__)
    exec(compile(source[:start] + replacement + source[end:], __file__, "exec"), namespace)
    renderer.prune_gs = namespace["prune_gs"].__get__(renderer, cls)
    return "runtime-voxel-int64-overflow-guard"
