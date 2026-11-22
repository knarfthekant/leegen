import torch
import triton
import triton.language as tl


@triton.jit
def add_kernel(x_ptr, y_ptr, out_ptr, n, BLOCK: tl.constexpr):
    pid = tl.program_id(axis=0)
    # TODO: compute this program's offsets and mask, load x and y, store x + y
    pass


def add(x: torch.Tensor, y: torch.Tensor) -> torch.Tensor:
    out = torch.empty_like(x)
    # TODO: launch add_kernel over a 1-D grid with BLOCK=1024
    return out
