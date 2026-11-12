"""Linux-only, fail-closed execution boundary for untrusted CV LaTeX."""

from pathlib import Path
import shutil


def sandbox_command(compiler: str, workdir: Path) -> tuple[list[str], dict[str, str]]:
    bwrap = shutil.which("bwrap")
    prlimit = shutil.which("prlimit")
    if not bwrap or not prlimit:
        raise RuntimeError("Secure LaTeX compilation requires bubblewrap and prlimit; no unsandboxed fallback is allowed.")
    if not Path(compiler).resolve().is_relative_to("/usr"):
        raise RuntimeError("Secure LaTeX compilation requires a system TeX installation under /usr.")

    # Never inherit credentials, TeX overrides, loader variables, or the user's HOME.
    environment = {
        "PATH": "/usr/bin:/bin", "HOME": "/work", "LANG": "C.UTF-8",
        "TEXMFVAR": "/work/texmf-var", "TEXMFCONFIG": "/work/texmf-config",
        "openin_any": "p", "openout_any": "p",
    }
    command = [
        bwrap, "--unshare-all", "--die-with-parent", "--new-session",
        "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr",
    ]
    for directory in ("/bin", "/lib", "/lib64"):
        path = Path(directory)
        if path.is_symlink():
            command.extend(["--symlink", str(path.readlink()), directory])
        elif path.exists():
            command.extend(["--ro-bind", directory, directory])
    # Mount only system TeX/font configuration, never all of /etc, /var, or /home.
    for directory in ("/etc/texmf", "/etc/fonts", "/etc/ld.so.cache", "/var/lib/texmf", "/var/cache/fontconfig"):
        if Path(directory).exists():
            command.extend(["--ro-bind", directory, directory])
    command.extend([
        "--proc", "/proc", "--dev", "/dev", "--size", "134217728", "--tmpfs", "/tmp",
        "--bind", str(workdir), "/work", "--chdir", "/work",
        "--", prlimit, "--cpu=60", "--as=1610612736", "--fsize=33554432",
        "--nofile=128", "--core=0", "--", compiler, "-no-shell-escape",
        "-interaction=nonstopmode", "-halt-on-error", "tailored_cv.tex",
    ])
    return command, environment
