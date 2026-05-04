#!/usr/bin/env python3
"""Regenerate fs.pickle before starting Cowrie."""

from __future__ import annotations

import os
import pickle
import stat
import subprocess
import time
from pathlib import Path

PYTHON_BIN = "/cowrie/cowrie-env/bin/python3"
CREATEFS_SCRIPT = "/cowrie/cowrie-git/src/cowrie/scripts/createfs.py"
TWISTD_BIN = "/cowrie/cowrie-env/bin/twistd"
DEFAULT_FS_PICKLE = "/cowrie/cowrie-git/var/lib/cowrie/fs.pickle"
COWRIE_ROOT = "/cowrie/cowrie-git"
HONEYFS_PATH = "/cowrie/cowrie-git/honeyfs"

T_DIR = 1
T_FILE = 2


def _dir_node(name: str) -> list[object]:
    now = int(time.time())
    return [name, T_DIR, 0, 0, 0, stat.S_IFDIR | 0o755, now, [], None, None]


def _file_node(name: str, file_path: Path) -> list[object]:
    st = file_path.stat()
    mode = stat.S_IFREG | stat.S_IMODE(st.st_mode)
    return [name, T_FILE, 0, 0, st.st_size, mode, int(st.st_ctime), [], None, str(file_path)]


def _find_child(parent: list[object], name: str) -> list[object] | None:
    children = parent[7]
    if not isinstance(children, list):
        return None
    for child in children:
        if isinstance(child, list) and child and child[0] == name:
            return child
    return None


def _ensure_dir_path(root: list[object], rel_parts: list[str]) -> list[object] | None:
    node = root
    for part in rel_parts:
        if not part:
            continue
        child = _find_child(node, part)
        if child is None:
            child = _dir_node(part)
            node[7].append(child)
        elif len(child) < 2 or child[1] != T_DIR:
            return None
        node = child
    return node


def merge_honeyfs_into_pickle(fs_pickle: str) -> None:
    with open(fs_pickle, "rb") as handle:
        root = pickle.load(handle)

    honeyfs = Path(os.getenv("COWRIE_HONEYFS_PATH", HONEYFS_PATH))
    added_dirs = 0
    added_files = 0
    updated_files = 0

    if not honeyfs.exists():
        print(f"[auto_start] Honeyfs path not found, skipping merge: {honeyfs}", flush=True)
        return

    for current_dir, dirnames, filenames in os.walk(honeyfs):
        current_path = Path(current_dir)
        rel_dir = current_path.relative_to(honeyfs)
        rel_parts = [] if str(rel_dir) == "." else list(rel_dir.parts)

        parent = _ensure_dir_path(root, rel_parts)
        if parent is None:
            print(f"[auto_start] Skipping non-directory path in virtual tree: /{'/'.join(rel_parts)}", flush=True)
            continue

        for dirname in dirnames:
            existing = _find_child(parent, dirname)
            if existing is None:
                parent[7].append(_dir_node(dirname))
                added_dirs += 1

        for filename in filenames:
            file_path = current_path / filename
            existing = _find_child(parent, filename)
            if existing is None:
                parent[7].append(_file_node(filename, file_path))
                added_files += 1
            elif len(existing) >= 2 and existing[1] == T_FILE:
                existing[:] = _file_node(filename, file_path)
                updated_files += 1

    with open(fs_pickle, "wb") as handle:
        pickle.dump(root, handle)

    print(
        f"[auto_start] honeyfs merge complete: +dirs={added_dirs} +files={added_files} updated_files={updated_files}",
        flush=True,
    )


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
    merge_honeyfs_into_pickle(str(fs_pickle_path))


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
