"""leegen's pure core, shared by the server and the browser edition's runner.

Rules for everything in this package:
- stdlib + pydantic (+ pyyaml in `parse`) only: no FastAPI, no subprocess, no filesystem access;
- it must import and run inside Pyodide, where the browser runner plans runs, assembles
  results and validates problems with exactly this code.
"""
