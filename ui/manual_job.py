"""Create private manual jobs and run the normal holistic Fit pipeline."""

from __future__ import annotations

import hashlib
import re
from typing import Any
from urllib.parse import urlencode

from matching.candidate_profile_persistence import PersistenceError, SupabaseRestClient
from matching.job_metadata import PAGE_HEADINGS, SCOPE_OR_NAV_COMPANIES, normalize_metadata
from .manual_jd import rate_job_with_manual_jd, validate_manual_jd


def _clean_metadata(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = re.sub(r"\s+", " ", value).strip()
    return cleaned or None


def _extract_title(text: str) -> str:
    first_line = next((line.strip().lstrip("#*- ").strip() for line in text.splitlines() if line.strip()), "")
    normalized_title = normalize_metadata(first_line)
    # The first non-empty JD line is often a section heading from copied page text.
    if first_line and len(first_line) <= 120 and not re.search(r"[.!?]$", first_line) and normalized_title not in PAGE_HEADINGS | SCOPE_OR_NAV_COMPANIES:
        return first_line
    return "Manual listing"


def _extract_company(text: str) -> str:
    generic_headings = {"about us", "about the role", "about the company", "the role", "company"}
    nonempty_lines = 0
    for line in text.splitlines()[:12]:
        line = re.sub(r"^\s*#+\s*", "", line).strip()
        if not line:
            continue
        nonempty_lines += 1
        # The first line is commonly a pasted job title, not employer metadata.
        if nonempty_lines == 1:
            continue
        about = re.match(r"^about\s+(.+?)(?:[.:](?:\s|$)|$)", line, re.IGNORECASE)
        if about:
            candidate = about.group(1).strip(" .:-")
            if normalize_metadata(candidate) not in generic_headings | PAGE_HEADINGS | SCOPE_OR_NAV_COMPANIES:
                return candidate
            continue
        intro = re.match(r"^([A-Z][A-Za-z0-9&.' -]{1,79}?)\s+is\b", line)
        if intro:
            candidate = intro.group(1).strip()
            if normalize_metadata(candidate) not in generic_headings | PAGE_HEADINGS | SCOPE_OR_NAV_COMPANIES:
                return candidate
    return "Unknown company"


def manual_metadata(jd_text: str, *, title: str | None = None, company: str | None = None) -> tuple[str, str]:
    """Preserve supplied metadata; use only conservative deterministic fallbacks."""

    return _clean_metadata(title) or _extract_title(jd_text), _clean_metadata(company) or _extract_company(jd_text)


def normalize_listing_url(value: str | None) -> str:
    value = _clean_metadata(value)
    if not value:
        raise ValueError("Enter the job listing URL.")
    from .dashboard import validate_listing_url

    return validate_listing_url(value)


def _required_metadata(value: str | None, label: str, *, max_length: int) -> str:
    cleaned = _clean_metadata(value)
    if not cleaned:
        raise ValueError(f"Enter the {label}.")
    if len(cleaned) > max_length:
        raise ValueError(f"The {label} must be {max_length} characters or fewer.")
    return cleaned


def _manual_rows(client: SupabaseRestClient, *, user_id: str, jd_sha256: str) -> list[dict[str, Any]]:
    params = urlencode({
        "select": "*",
        "source": "eq.manual",
        "manual_owner_user_id": f"eq.{user_id}",
        "manual_jd_sha256": f"eq.{jd_sha256}",
        "limit": "1",
    })
    rows = client.get_json(f"/rest/v1/jobs?{params}")
    if not isinstance(rows, list):
        raise PersistenceError("Supabase returned invalid manual job data.")
    return rows


def create_or_reuse_manual_job(
    client: SupabaseRestClient,
    *,
    user_id: str,
    jd_text: str,
    title: str,
    company: str,
    listing_url: str,
) -> tuple[dict[str, Any], bool]:
    """Create or reuse a private manual listing using normalized JD identity."""

    normalized = validate_manual_jd(jd_text)
    title_value = _required_metadata(title, "job title", max_length=180)
    company_value = _required_metadata(company, "company name", max_length=140)
    url = normalize_listing_url(listing_url)
    jd_sha256 = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    existing = _manual_rows(client, user_id=user_id, jd_sha256=jd_sha256)
    if existing:
        row = existing[0]
        updates: dict[str, Any] = {}
        if title_value != row.get("title"):
            updates["title"] = title_value
        if company_value != row.get("company"):
            updates["company"] = company_value
        if url != row.get("application_url"):
            updates["application_url"] = url
        if updates:
            rows = client.json_request("PATCH", f"/rest/v1/jobs?id=eq.{row['id']}", updates, prefer="return=representation")
            if isinstance(rows, list) and len(rows) == 1:
                row = rows[0]
        return row, False

    rows = client.json_request(
        "POST",
        "/rest/v1/jobs",
        {
            "source": "manual",
            "source_job_id": None,
            "source_url": None,
            "application_url": url,
            "company": company_value,
            "title": title_value,
            "description": normalized,
            "description_kind": "full",
            "availability_status": "active",
            "manual_owner_user_id": user_id,
            "manual_jd_sha256": jd_sha256,
        },
        prefer="return=representation",
    )
    if not isinstance(rows, list) or len(rows) != 1:
        raise PersistenceError("Expected one inserted manual job.")
    return rows[0], True


def create_and_rate_manual_job(
    client: SupabaseRestClient,
    *,
    user_id: str,
    cv_version_id: int,
    candidate_profile_id: int,
    jd_text: str,
    title: str,
    company: str,
    listing_url: str,
) -> dict[str, Any]:
    """Save/reuse the job, then perform the existing cache-or-one-call rating."""

    row, created = create_or_reuse_manual_job(
        client,
        user_id=user_id,
        jd_text=jd_text,
        title=title,
        company=company,
        listing_url=listing_url,
    )
    try:
        rating = rate_job_with_manual_jd(
            client,
            user_id=user_id,
            cv_version_id=cv_version_id,
            candidate_profile_id=candidate_profile_id,
            job_id=int(row["id"]),
            jd_text=jd_text,
        )
    except Exception as exc:
        raise RuntimeError(f"Manual job saved, but rating failed: {exc}") from exc
    return {"job": row, "created": created, "rating": rating}
