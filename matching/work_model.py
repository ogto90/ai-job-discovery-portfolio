"""Role-level work-model evidence, separate from geography and general benefits."""

from __future__ import annotations

import re
from typing import Literal

WorkModel = Literal["remote", "hybrid", "onsite", "unknown"]

_HYBRID = re.compile(
    r"\b(?:hybrid (?:role|position|job|working model)|hybrid (?:in|based in) [A-Z][^.!?\n]{0,60}|(?:role|position|job|work(?:ing)? model|workplace type)\s*(?::|is|—|-)\s*hybrid|\d+\s+days?\s+in(?: the)? office[^.!?\n]{0,80}\d+\s+days?\s+remote)\b", re.I,
)
_ONSITE = re.compile(
    r"\b(?:on[- ]?site (?:role|position|job|in\b)|office[- ]based (?:role|position|job)|(?:role|position|job|work(?:ing)? model|workplace type)\s*(?::|is|—|-)\s*(?:on[- ]?site|in[- ]?office)|must work from (?:our|the) [^.!?\n]{0,60}office)\b", re.I,
)
_REMOTE = re.compile(
    r"\b(?:(?:fully|100%|completely|entirely) remote\b|remote[- ]first (?:role|position|job)\b|remote (?:role|position|job)\b|(?:role|position|job|work(?:ing)? model|workplace type|location)\s*(?::|is|—|-)\s*(?:fully )?remote\b|remote (?:within|across|throughout|in|from)\b|work remotely from\b|(?:role|position|job) can be performed remotely from\b|work from anywhere\b)", re.I,
)


def _source_model(value: str) -> WorkModel:
    text = value.strip()
    if re.fullmatch(r"(?:hybrid|hybrid work(?:ing)?|hybrid[ ,/-].+)", text, re.I):
        return "hybrid"
    if re.fullmatch(r"(?:on[- ]?site|in[- ]?office|office[- ]based)(?:[ ,/-].*)?", text, re.I):
        return "onsite"
    if re.fullmatch(r"(?:remote|fully remote|full remote|100% remote)(?:[ ,/-].*)?", text, re.I):
        return "remote"
    if re.search(r"(?:\s[-—]\s|\s/\s)(?:fully |full |100% )?remote$", text, re.I):
        return "remote"
    return "unknown"


def classify_work_model(
    *, title: str = "", location: str = "", remote_scope: str = "", description: str = "",
    structured_work_model: str = "",
) -> WorkModel:
    structured = _source_model(structured_work_model)
    if structured != "unknown":
        return structured
    text = re.sub(r"<[^>]*>", " ", f"{title}\n{description}")
    text = re.sub(r"\bThis (?:is )?a (?:Full|Fully|100%)? ?Remote job,? the offer is available from:", "", text, flags=re.I)
    exact = {
        model for model, pattern in (("hybrid", _HYBRID), ("onsite", _ONSITE), ("remote", _REMOTE))
        if pattern.search(text)
    }
    if re.search(r"\bhybrid\b", title, re.I):
        exact.add("hybrid")
    if re.search(r"\b(?:on[- ]?site|in[- ]?office)\b", title, re.I):
        exact.add("onsite")
    if re.search(r"\bremote\b", title, re.I):
        exact.add("remote")
    if len(exact) > 1:
        return "unknown"
    if exact:
        return next(iter(exact))
    scope = _source_model(remote_scope)
    return scope if scope != "unknown" else _source_model(location)
