#!/usr/bin/env python3
"""Regenerate fs.pickle before starting Cowrie."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

PYTHON_BIN = "/cowrie/cowrie-env/bin/python3"
CREATEFS_SCRIPT = "/cowrie/cowrie-git/src/cowrie/scripts/createfs.py"
TWISTD_BIN = "/cowrie/cowrie-env/bin/twistd"
DEFAULT_FS_PICKLE = "/cowrie/cowrie-git/var/lib/cowrie/fs.pickle"
COWRIE_ROOT = "/cowrie/cowrie-git"


def _is_enabled(var_name: str, default: bool = True) -> bool:
    value = os.getenv(var_name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def generate_fs_pickle() -> None:
    root_dir = os.getenv("COWRIE_CREATEFS_ROOT", "/")
    max_depth = os.getenv("COWRIE_CREATEFS_DEPTH", "6")
    include_proc = _is_enabled("COWRIE_CREATEFS_INCLUDE_PROC", default=False)
    fs_pickle = os.getenv("COWRIE_FS_PICKLE", DEFAULT_FS_PICKLE)

    fs_pickle_path = Path(fs_pickle)
    fs_pickle_path.parent.mkdir(parents=True, exist_ok=True)
    if fs_pickle_path.exists():
        fs_pickle_path.unlink()

    cmd = [
        PYTHON_BIN,
        CREATEFS_SCRIPT,
        "-l",
        root_dir,
        "-d",
        str(max_depth),
        "-o",
        str(fs_pickle_path),
    ]
    if include_proc:
        cmd.insert(2, "-p")

    print(f"[auto_start] Generating fs.pickle: {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)


def start_cowrie() -> None:
    args = [TWISTD_BIN, "-n", "--umask=0022", "--pidfile=", "cowrie"]
    print(f"[auto_start] Starting Cowrie: {' '.join(args)}", flush=True)
    os.execv(args[0], args)


def main() -> None:
    os.chdir(COWRIE_ROOT)

    if _is_enabled("COWRIE_AUTO_CREATEFS", default=True):
        generate_fs_pickle()
    else:
        print("[auto_start] Skipping fs.pickle generation (COWRIE_AUTO_CREATEFS disabled)", flush=True)

    start_cowrie()


if __name__ == "__main__":
    main()
