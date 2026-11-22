import torch

from attention import attend, merge_heads, split_heads


class KVCache:
    def __init__(self, batch: int, n_heads: int, max_len: int, head_dim: int, *,
                 device: torch.device, dtype: torch.dtype = torch.float32) -> None:
        # TODO: preallocate key/value buffers [batch, n_heads, max_len, head_dim]
        ...

    def append(self, k: torch.Tensor, v: torch.Tensor) -> None:
        """k, v: [batch, n_heads, t_new, head_dim]. Raise ValueError on overflow."""
        raise NotImplementedError

    def get(self) -> tuple[torch.Tensor, torch.Tensor]:
        """(k, v) for all positions so far: [batch, n_heads, length, head_dim]."""
        raise NotImplementedError

    def __len__(self) -> int:
        raise NotImplementedError


def decode_with_cache(x: torch.Tensor, w_q: torch.Tensor, w_k: torch.Tensor,
                      w_v: torch.Tensor, n_heads: int) -> torch.Tensor:
    """x: [B, T, D] -> [B, T, D], one position at a time with a KVCache."""
    raise NotImplementedError
