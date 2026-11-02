"""leegen test harness. Copied into every job bundle; runs inside the problem environment.

Only depends on the standard library (plus pytest for the pytest judge). Problem code may use
`from leegen_harness import device` to get the selected device ("cuda", "mps" or "cpu").
"""

from leegen_harness.protocol import device, emit

__all__ = ["device", "emit"]
