"""User-specific application workflow states and action rules."""

from __future__ import annotations

from collections.abc import Mapping


APPLICATION_STATES = frozenset({"applied", "interview", "offer", "hired", "rejected", "withdrawn", "no_response"})
REVIEW_STATES = frozenset({"interested", "ignored", "archived"})
CLOSED_STATES = frozenset({"hired", "rejected", "withdrawn", "no_response", "ignored", "archived"})
ACTIVE_APPLICATION_STATES = frozenset({"applied", "interview", "offer"})

ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "new": frozenset({"applied", "archived"}),
    "rated": frozenset({"applied", "archived"}),
    "applied": frozenset({"interview", "offer", "rejected", "withdrawn", "archived"}),
    "interview": frozenset({"offer", "rejected", "withdrawn", "archived"}),
    "offer": frozenset({"hired", "rejected", "withdrawn", "archived"}),
    "hired": frozenset({"reopen"}),
    "rejected": frozenset({"reopen"}),
    "withdrawn": frozenset({"reopen"}),
    "no_response": frozenset({"reopen"}),
    "ignored": frozenset({"reopen"}),
    "archived": frozenset({"reopen"}),
}


def lifecycle_state(
    application: Mapping[str, object] | None,
    review: Mapping[str, object] | None,
    *,
    has_current_fit: bool,
) -> str:
    """Derive the visible state from user-owned status and the current Fit."""

    application_status = str((application or {}).get("status") or "")
    if application_status in APPLICATION_STATES:
        return application_status
    review_status = str((review or {}).get("status") or "")
    if review_status in {"ignored", "archived"}:
        return review_status
    return "rated" if has_current_fit else "new"


def can_rate_state(state: str) -> bool:
    return state in {"new", "rated", "applied", "interview", "offer"}


def can_generate_cv_state(state: str) -> bool:
    return state in {"new", "rated", "applied", "interview", "offer"}


def can_apply_state(state: str) -> bool:
    return state in {"new", "rated"}


def can_archive_state(state: str) -> bool:
    return state in {"new", "rated", "applied", "interview", "offer"}


def can_transition(state: str, target: str) -> bool:
    return target in ALLOWED_TRANSITIONS.get(state, frozenset())


def workflow_timestamp_column(status: str) -> str | None:
    return {
        "applied": "applied_at",
        "interview": "interview_at",
        "offer": "offer_at",
        "hired": "hired_at",
        "rejected": "rejected_at",
        "withdrawn": "withdrawn_at",
    }.get(status)
