"""Start a packaged GeoD application and verify React and native initialization."""
import argparse
from contextlib import closing
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time


def has_rows(path, sql, expected):
    try:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.2)) as db:
            return db.execute(sql).fetchone() == (expected,)
    except sqlite3.Error:
        return False


def web_stores(roots):
    for root in roots:
        if root.is_dir():
            for folder, _, names in os.walk(root):
                for name in names:
                    if name.lower().endswith(".localstorage") or name.lower() == "localstorage.sqlite3":
                        yield Path(folder) / name


def verify_startup(executable, profile):
    env = os.environ.copy()
    roots = [profile]
    history = profile / "data/geo-downloader/history.db"
    if sys.platform == "darwin":
        # The ephemeral macOS runner has a GUI login session. Keep its identity
        # for WindowServer and WebKit's XPC services.
        library = Path.home() / "Library"
        roots = [library / "WebKit", library / "Containers/dev.geo-downloader",
                 library / "Application Support/dev.geo-downloader",
                 library / "Application Support/geo-downloader"]
        history = library / "Application Support/geo-downloader/history.db"
    else:
        env.update(HOME=str(profile), XDG_DATA_HOME=str(profile / "data"),
                   XDG_CONFIG_HOME=str(profile / "config"), XDG_CACHE_HOME=str(profile / "cache"),
                   LIBGL_ALWAYS_SOFTWARE="1")
    # Native library tests may already have opened a history DB. A WebKit store
    # containing this package's React markers must be new to this invocation.
    markers = "SELECT COUNT(*) FROM ItemTable WHERE key IN ('gd:theme-mode','gd:theme-accent')"
    old_markers = {p for p in web_stores(roots) if has_rows(p, markers, 2)}
    history_tables = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('download_history','task_outcomes')"
    child = subprocess.Popen([str(executable.resolve())], env=env, start_new_session=True)
    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError(f"{executable} exited during startup with code {child.returncode}")
            web_ready = any(p not in old_markers and has_rows(p, markers, 2) for p in web_stores(roots))
            if web_ready and history.is_file() and has_rows(history, history_tables, 2):
                time.sleep(3)
                if child.poll() is not None:
                    raise RuntimeError(f"{executable} exited after initialization with code {child.returncode}")
                print(f"Packaged {executable.name} started its React UI and initialized SQLite history.", flush=True)
                return
            time.sleep(1)
        raise RuntimeError(f"Timed out starting {executable}: React ready={web_ready}, history={history.is_file()}")
    finally:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        except ProcessLookupError:
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="geod-package-", dir=os.environ["RUNNER_TEMP"]) as directory:
        verify_startup(args.executable, Path(directory))
