"""Deterministic completeness checks for job-description text."""

from __future__ import annotations

import html
import re

_BLOCK_TAGS = re.compile(r"</?(?:address|article|br|dd|div|dl|dt|h[1-6]|li|ol|p|section|table|td|th|tr|ul)\b[^>]*>", re.I)
_SCRIPT_STYLE = re.compile(r"<(script|style|noscript)\b[^>]*>.*?</\1\s*>", re.I | re.S)
_TAG = re.compile(r"<[^<>]*>")
_BOILERPLATE = re.compile(
    r"\b(cookie (?:policy|preferences)|privacy policy|terms of (?:use|service)|all rights reserved|"
    r"sign in|log in|create an account|browse (?:all )?jobs|job alerts|subscribe to|newsletter|"
    r"accessibility statement|equal opportunity employer|equal employment opportunity|"
    r"reasonable accommodation|©\s*\d{4})\b",
    re.I,
)
_SECTION_HEADING = re.compile(
    r"\b(responsibilities|what you(?:'|’)ll do|what you will do|requirements|qualifications|"
    r"what you(?:'|’)ll bring|what we(?:'|’)re looking for|about the role|about you|your impact|"
    r"the opportunity|role overview|who you are)\b",
    re.I,
)
_ACTION_TERMS = re.compile(
    r"\b(build|design|develop|drive|implement|lead|manage|own|partner|protect|review|"
    r"secure|support|operate|assess|respond|establish|deliver|maintain|create|collaborate)\b",
    re.I,
)


def normalized_job_description(value: str | None) -> str:
    """Remove markup and common page chrome while preserving paragraph boundaries."""
    raw = value or ""
    raw = _SCRIPT_STYLE.sub(" ", raw)
    raw = _BLOCK_TAGS.sub("\n", raw)
    raw = _TAG.sub(" ", raw)
    raw = html.unescape(raw)
    lines = [
        re.sub(r"\s+", " ", _BOILERPLATE.sub(" ", line)).strip()
        for line in raw.splitlines()
    ]
    lines = [line for line in lines if line]
    return "\n".join(lines)


def is_usable_full_job_description(value: str | None) -> bool:
    """Accept substantive job content, not a character-count or page-chrome proxy."""
    text = normalized_job_description(value)
    words = re.findall(r"[^\W_]+(?:['’][^\W_]+)?", text, flags=re.UNICODE)
    if len(words) < 40:
        return False
    unique_ratio = len({word.casefold() for word in words}) / len(words)
    if unique_ratio < 0.25:
        return False
    headings = len(_SECTION_HEADING.findall(text))
    actions = len(_ACTION_TERMS.findall(text))
    return len(words) >= 100 or (len(words) >= 40 and headings >= 1 and actions >= 3)


def classify_job_description(value: str | None, declared_kind: str | None = None) -> str:
    """Return full only for validated substantive text; otherwise preserve partial/missing."""
    text = normalized_job_description(value)
    if not text:
        return "missing"
    if is_usable_full_job_description(value):
        return "full"
    return "snippet"
