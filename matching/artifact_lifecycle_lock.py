"""Cross-process coordination for the local, single-host deployment."""

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import time


def _lock_directory() -> Path:
    return Path(__file__).resolve().parents[1] / ".diagnostics" / "artifact-locks"


@contextmanager
def artifact_lifecycle_lock(project_url: str, *, timeout: float = 5.0, application_write: bool = False, cleanup: bool = False):
    # flock coordinates the Streamlit worker threads and standalone cleanup CLI.
    # It is not a distributed lock: all writers must run under this OS account.
    import fcntl

    directory = _lock_directory()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid():
        raise RuntimeError("Unsafe artifact lock directory")
    name = hashlib.sha256(project_url.rstrip("/").encode()).hexdigest()
    fd = os.open(directory / f"{name}.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("CV cleanup or an application update is in progress. Please retry shortly.") from None
                time.sleep(0.05)
        marker = directory / f"{name}.pending"
        if cleanup and marker.exists():
            raise RuntimeError("Cleanup paused: an application write has an unconfirmed outcome. Reconcile it before cleanup.")
        created_marker = False
        if application_write:
            try:
                marker.touch(mode=0o600, exist_ok=False)
                created_marker = True
            except FileExistsError:
                pass
        yield
        if created_marker:
            marker.unlink()
    finally:
        os.close(fd)
