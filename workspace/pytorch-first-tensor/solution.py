import torch


def linear_relu(
    x: torch.Tensor,
    weight: torch.Tensor,
    bias: torch.Tensor,
) -> torch.Tensor:
    """Apply a linear layer followed by ReLU to a batch of rows."""
    # TODO: matrix multiply, add the bias, then apply ReLU.
    y = torch.relu(x @ weight.T + bias)
    return y
