"""Typed candidate evidence models used by the future matching layer."""

from .candidate_profile import (
    CandidateProfile,
    Capability,
    EvidenceItem,
    EvidenceLevel,
    EvidenceType,
    representative_profile_json,
)
from .search_profile import SearchProfile
from .holistic_matcher import (
    HOLISTIC_MATCHER_VERSION,
    CandidateProjection,
    HolisticFitOutput,
    VerifiedJob,
    candidate_projection_sha256,
    evaluate_holistic_match,
    evaluation_fingerprint,
    project_candidate,
    project_candidate_for_fit,
    parse_model_output_for_diagnostics,
    response_diagnostics,
)
from .holistic_match_planning import (
    JobMatchPlan,
    MatchPlanAction,
    MatchPlanBatch,
    MatchPlanSummary,
    VerifiedDiscoveredJob,
    plan_holistic_matches,
)
__all__ = [
    "CandidateProfile",
    "Capability",
    "EvidenceItem",
    "EvidenceLevel",
    "EvidenceType",
    "representative_profile_json",
    "SearchProfile",
    "HOLISTIC_MATCHER_VERSION",
    "CandidateProjection",
    "HolisticFitOutput",
    "VerifiedJob",
    "candidate_projection_sha256",
    "evaluate_holistic_match",
    "evaluation_fingerprint",
    "project_candidate",
    "project_candidate_for_fit",
    "parse_model_output_for_diagnostics",
    "response_diagnostics",
    "JobMatchPlan",
    "MatchPlanAction",
    "MatchPlanBatch",
    "MatchPlanSummary",
    "VerifiedDiscoveredJob",
    "plan_holistic_matches",
]
