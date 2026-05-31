"""Importable shim that re-exports symbols from ``train-pointer-accel.py``.

``train-pointer-accel.py`` uses a hyphenated filename (matches the rest of
``ml/``) and cannot be imported by name. This shim does the hyphen->underscore
dance via importlib so both the trainer and the v1 eval script can share one
source of truth for: ``PointerAccelMLP``, the dataset/feature builders, the
SEED / VAL_FRACTION / FEATURE_DIM constants, and ``interp_cursor`` /
``instantaneous_velocity``.
"""
from __future__ import annotations

import importlib.util as _importlib_util
import sys as _sys
from pathlib import Path as _Path

_TRAINER = _Path(__file__).resolve().parent / "train-pointer-accel.py"
_spec = _importlib_util.spec_from_file_location("_train_pointer_accel", _TRAINER)
if _spec is None or _spec.loader is None:
    raise ImportError(f"could not locate {_TRAINER}")
_mod = _importlib_util.module_from_spec(_spec)
_sys.modules["_train_pointer_accel"] = _mod
_spec.loader.exec_module(_mod)

# Re-export the symbols the eval needs.
PointerAccelMLP = _mod.PointerAccelMLP
TrajectoryDataset = _mod.TrajectoryDataset
build_examples = _mod.build_examples
load_trajectory = _mod.load_trajectory
interp_cursor = _mod.interp_cursor
instantaneous_velocity = _mod.instantaneous_velocity
SEED = _mod.SEED
VAL_FRACTION = _mod.VAL_FRACTION
FEATURE_DIM = _mod.FEATURE_DIM
OUTPUT_DIM = _mod.OUTPUT_DIM
HORIZON_MS = _mod.HORIZON_MS
HISTORY_WINDOW_MS = _mod.HISTORY_WINDOW_MS
HIDDEN_DIM = _mod.HIDDEN_DIM
HIDDEN_LAYERS = _mod.HIDDEN_LAYERS
