"""Profession-neutral sanity checks for company/title metadata."""

from __future__ import annotations

import re
import unicodedata


PAGE_HEADINGS = frozenset({
    "about us", "about the role", "about the company", "the role", "job description",
    "careers", "join us", "who we are", "what you will do", "what youll do",
    "what you ll do", "responsibilities", "requirements", "qualifications", "location", "our company", "our mission",
})
SCOPE_OR_NAV_COMPANIES = frozenset({
    "us", "u s", "usa", "uk", "u k", "eu", "emea", "apac", "remote", "hybrid",
    "on site", "onsite", "location", "careers", "jobs", "worldwide", "anywhere",
    "unknown company", "company not provided", "manual listing", "untitled role",
})
MANUAL_FALLBACK_TITLES = frozenset({"manual listing", "untitled role"})
MANUAL_FALLBACK_COMPANIES = frozenset({"unknown company", "company not provided"})


def normalize_metadata(value: object) -> str:
    text = unicodedata.normalize("NFKC", value if isinstance(value, str) else "")
    text = re.sub(r"\s+", " ", text).strip().casefold()
    return re.sub(r"[^\w]+", " ", text, flags=re.UNICODE).strip()


def title_metadata_issues(value: object) -> list[str]:
    raw = value.strip() if isinstance(value, str) else ""
    key = normalize_metadata(raw)
    issues: list[str] = []
    if not raw:
        issues.append("title_missing")
    elif key in PAGE_HEADINGS:
        issues.append("title_is_page_heading")
    elif key in SCOPE_OR_NAV_COMPANIES:
        issues.append("title_is_geographic_or_navigation_token")
    elif len(raw) > 180 or re.search(r"[.!?]$", raw):
        issues.append("title_looks_like_prose")
    return issues


def company_metadata_issues(value: object) -> list[str]:
    raw = value.strip() if isinstance(value, str) else ""
    key = normalize_metadata(raw)
    issues: list[str] = []
    if not raw:
        issues.append("company_missing")
    elif key in PAGE_HEADINGS:
        issues.append("company_is_page_heading")
    elif key in SCOPE_OR_NAV_COMPANIES:
        issues.append("company_is_geographic_or_navigation_token")
    elif len(raw) > 140:
        issues.append("company_looks_like_prose")
    return issues


def metadata_issues(company: object, title: object) -> list[str]:
    issues = [*company_metadata_issues(company), *title_metadata_issues(title)]
    company_key, title_key = normalize_metadata(company), normalize_metadata(title)
    if company_key and title_key and company_key == title_key:
        issues.append("company_and_title_identical")
    return issues


def metadata_is_sane(company: object, title: object) -> bool:
    return not metadata_issues(company, title)


def manual_metadata_issues(company: object, title: object) -> list[str]:
    """Allow intentional manual fallback labels without forgiving bad fields."""

    company_issues = (
        [] if normalize_metadata(company) in MANUAL_FALLBACK_COMPANIES
        else company_metadata_issues(company)
    )
    title_issues = (
        [] if normalize_metadata(title) in MANUAL_FALLBACK_TITLES
        else title_metadata_issues(title)
    )
    company_key, title_key = normalize_metadata(company), normalize_metadata(title)
    if company_key and title_key and company_key == title_key:
        return [*company_issues, *title_issues, "company_and_title_identical"]
    return [*company_issues, *title_issues]
