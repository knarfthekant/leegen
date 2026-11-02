"""Compatibility shim: the models live in `leegen.core.models` (pure, Pyodide-safe)."""

from leegen.core.models import *  # noqa: F401,F403
from leegen.core.models import FROM_REFERENCE  # noqa: F401
