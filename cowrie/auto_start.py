#!/usr/bin/env python3
"""Regenerate fs.pickle before starting Cowrie."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PYTHON_BIN = "/cowrie/cowrie-env/bin/python3"
CREATEFS_SCRIPT = "/cowrie/cowrie-git/src/cowrie/scripts/createfs.py"
TWISTD_BIN = "/cowrie/cowrie-env/bin/twistd"
FS_PICKLE = "/cowrie/cowrie-git/share/cowrie/fs.pickle"


def _is_enabled(var_name: str, default: bool = True) -> bool:
    value = os.getenv(var_name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def generate_fs_pickle() -> None:
    root_dir = os.getenv("COWRIE_CREATEFS_ROOT", "/")
    max_depth = os.getenv("COWRIE_CREATEFS_DEPTH", "6")
    include_proc = _is_enabled("COWRIE_CREATEFS_INCLUDE_PROC", default=False)

    Path(FS_PICKLE).parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        PYTHON_BIN,
        CREATEFS_SCRIPT,
        "-l",
        root_dir,
        "-d",
        str(max_depth),
        "-o",
        FS_PICKLE,
    ]
    if include_proc:
        cmd.insert(2, "-p")

    print(f"[auto_start] Generating fs.pickle: {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)


def start_cowrie() -> None:
    # Preserve optional command overrides passed to the container.
    args = [TWISTD_BIN, "-n", "--umask=0022", "--pidfile=", "cowrie"] + sys.argv[1:]
    print(f"[auto_start] Starting Cowrie: {' '.join(args)}", flush=True)
    os.execv(args[0], args)


def main() -> None:
    if _is_enabled("COWRIE_AUTO_CREATEFS", default=True):
        generate_fs_pickle()
    else:
        print("[auto_start] Skipping fs.pickle generation (COWRIE_AUTO_CREATEFS disabled)", flush=True)

    start_cowrie()


if __name__ == "__main__":
    main()
