from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SANDBOX_PATH = ROOT / "matching" / "latex_sandbox.py"
SANDBOX_SPEC = importlib.util.spec_from_file_location("latex_sandbox", SANDBOX_PATH)
if SANDBOX_SPEC is None or SANDBOX_SPEC.loader is None:
    raise RuntimeError("Secure LaTeX sandbox module could not be loaded.")
SANDBOX_MODULE = importlib.util.module_from_spec(SANDBOX_SPEC)
SANDBOX_SPEC.loader.exec_module(SANDBOX_MODULE)
sandbox_command = SANDBOX_MODULE.sandbox_command


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: compile_latex_sandbox.py INPUT.tex OUTPUT.pdf", file=sys.stderr)
        return 2

    source = Path(sys.argv[1]).resolve()
    target = Path(sys.argv[2]).resolve()
    compiler = shutil.which("lualatex")
    if not compiler:
        print("Secure LaTeX compilation requires lualatex.", file=sys.stderr)
        return 1

    try:
        with tempfile.TemporaryDirectory(prefix="daily-report-tex-") as directory:
            workdir = Path(directory)
            shutil.copyfile(source, workdir / "tailored_cv.tex")
            command, environment = sandbox_command(compiler, workdir)
            with tempfile.TemporaryFile() as output:
                try:
                    result = subprocess.run(
                        command,
                        cwd=workdir,
                        env=environment,
                        stdin=subprocess.DEVNULL,
                        stdout=output,
                        stderr=subprocess.STDOUT,
                        timeout=90,
                        check=False,
                    )
                except subprocess.TimeoutExpired:
                    print("LaTeX compilation timed out.", file=sys.stderr)
                    return 1
                if result.returncode != 0:
                    output.seek(0, 2)
                    output.seek(max(0, output.tell() - 6000))
                    print(output.read().decode("utf-8", errors="replace"), file=sys.stderr)
                    return 1
            pdf = workdir / "tailored_cv.pdf"
            if not pdf.is_file():
                print("Sandboxed LaTeX completed without producing a PDF.", file=sys.stderr)
                return 1
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(pdf, target)
    except (OSError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
