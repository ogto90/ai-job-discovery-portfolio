import os
from pathlib import Path

import pytest

from matching.cv_parser import parse_candidate_profile


@pytest.mark.integration
def test_parse_canonical_cv_with_openai():
    """Opt-in smoke test: RUN_OPENAI_CV_PARSER=1 pytest -m integration."""

    if os.getenv("RUN_OPENAI_CV_PARSER") != "1":
        pytest.skip("Set RUN_OPENAI_CV_PARSER=1 to spend one OpenAI API call")
    if not os.getenv("OPENAI_API_KEY"):
        pytest.skip("OPENAI_API_KEY is not configured")

    cv_path = Path(__file__).parents[1] / "cv" / "main_example.tex"
    profile = parse_candidate_profile(cv_path.read_text(encoding="utf-8"), 2)
    capabilities = {item.normalized_name.lower(): item for item in profile.capabilities}

    for name in (
        "vulnerability management",
        "sast",
        "sca",
        "threat modeling",
        "secure code review",
        "aws",
        "container security",
        "security automation",
        "web application scanning",
    ):
        assert name in capabilities, f"parser omitted required inspection capability: {name}"

    assert capabilities["vulnerability management"].evidence_level >= 3
    assert capabilities["aws"].production_experience is False
    assert capabilities["container security"].production_experience is False
