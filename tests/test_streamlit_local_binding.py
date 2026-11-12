from pathlib import Path
import tomllib


ROOT = Path(__file__).resolve().parents[1]


def test_streamlit_binds_to_loopback_by_default():
    config = tomllib.loads((ROOT / ".streamlit" / "config.toml").read_text())

    assert config["server"]["address"] == "127.0.0.1"
