"""Profile-driven discovery eligibility, separate from vacancy lifecycle."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable

from .job_description import is_usable_full_job_description
from .work_model import classify_work_model

ROLE_TARGET_MATCH = "target_match"
ROLE_TARGET_ADJACENT = "target_adjacent"
ROLE_UNRELATED = "unrelated"
ROLE_EXCLUDED = "excluded"
ROLE_UNCLEAR = "unclear"

COUNTRY_ALIASES: dict[str, tuple[str, ...]] = {
    "Austria": ("Austria", "AT", "Vienna"), "Belgium": ("Belgium", "BE"), "Bulgaria": ("Bulgaria", "BG"),
    "Croatia": ("Croatia", "HR"), "Cyprus": ("Cyprus", "CY"), "Czechia": ("Czechia", "Czech Republic", "CZ"),
    "Denmark": ("Denmark", "DK"), "Estonia": ("Estonia", "EE"), "Finland": ("Finland", "FI"),
    "France": ("France", "FR"), "Germany": ("Germany", "DE"), "Greece": ("Greece", "GR"),
    "Hungary": ("Hungary", "HU"), "Iceland": ("Iceland", "IS"), "Ireland": ("Ireland", "IE"),
    "Italy": ("Italy", "IT"), "Latvia": ("Latvia", "LV"), "Liechtenstein": ("Liechtenstein", "LI"),
    "Lithuania": ("Lithuania", "LT"), "Luxembourg": ("Luxembourg", "LU"), "Malta": ("Malta", "MT"),
    "Netherlands": ("Netherlands", "NL"), "Norway": ("Norway", "NO"), "Poland": ("Poland", "PL"),
    "Portugal": ("Portugal", "PT", "Lisbon"), "Romania": ("Romania", "RO"), "Slovakia": ("Slovakia", "SK"),
    "Slovenia": ("Slovenia", "SI"), "Spain": ("Spain", "ES"), "Sweden": ("Sweden", "SE"),
    "Switzerland": ("Switzerland", "CH"), "United Kingdom": ("United Kingdom", "UK", "GB", "Britain", "London"),
    "United States": ("United States", "US", "USA", "U.S.", "U.S.A.", "San Francisco Bay Area", "San Francisco"), "Canada": ("Canada", "CA"),
    "Australia": ("Australia", "AU"), "India": ("India", "IN"), "Japan": ("Japan", "JP"),
    "New Zealand": ("New Zealand", "NZ"), "Brazil": ("Brazil", "BR"), "Mexico": ("Mexico", "MX"),
    "Argentina": ("Argentina", "AR"), "Singapore": ("Singapore", "SG"), "South Africa": ("South Africa", "ZA"),
    "United Arab Emirates": ("United Arab Emirates", "UAE", "AE"), "Israel": ("Israel", "IL"),
    "Saudi Arabia": ("Saudi Arabia", "KSA", "SA"), "Malaysia": ("Malaysia", "MY"),
}
REGION_MEMBERS: dict[str, set[str]] = {
    "europe": {"Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Iceland", "Ireland", "Italy", "Latvia", "Liechtenstein", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Norway", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden", "Switzerland", "United Kingdom"},
    "eu": {"Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden"},
    "eea": {"Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Iceland", "Ireland", "Italy", "Latvia", "Liechtenstein", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Norway", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden"},
    "north america": {"United States", "Canada"},
    "apac": {"Australia", "India", "Japan", "New Zealand", "Singapore"},
}
LANGUAGE_ALIASES: dict[str, tuple[str, ...]] = {
    "english": ("english", "england"), "german": ("german", "deutsch", "deutsche"),
    "french": ("french", "français", "francais", "française", "francaise"),
    "spanish": ("spanish", "español", "espanol"), "danish": ("danish", "dansk"),
    "swedish": ("swedish", "svenska"), "dutch": ("dutch", "nederlands"),
    "italian": ("italian", "italiano"), "portuguese": ("portuguese", "português", "portugues"),
}
_LANGUAGE_ALIAS_LOOKUP = {
    alias.casefold(): language
    for language, aliases in LANGUAGE_ALIASES.items()
    for alias in aliases
}
_LANGUAGE_ALIAS_PATTERN = re.compile(
    r"(?<!\w)(?P<alias>" + "|".join(
        re.escape(alias) for alias in sorted(_LANGUAGE_ALIAS_LOOKUP, key=len, reverse=True)
    ) + r")(?!\w)",
    re.I,
)
_LANGUAGE_REQUIRED_PATTERN = re.compile(
    r"(?<!\w)(?P<alias>" + "|".join(
        re.escape(alias) for alias in sorted(_LANGUAGE_ALIAS_LOOKUP, key=len, reverse=True)
    ) + r")(?:\s+language)?\s+(?:is\s+)?(?:required|essential|mandatory|needed|fluent|proficient)\b",
    re.I,
)
_GERMAN_REQUIRED_PATTERN = re.compile(r"\b(?:Deutschkenntnisse|Deutsch erforderlich|fließend Deutsch)\b", re.I)
LANGUAGE_MARKERS: dict[str, set[str]] = {
    "german": set("der die das und mit für fuer ist sind werden wir sie eine einen auf im von zu den dem auch nicht erforderlich kenntnisse bewerbung ihre unser".split()),
    "french": set("les des une dans avec pour nous vous votre notre sont est expérience equipe équipe poste travail".split()),
    "spanish": set("los las una para con nuestro nuestra experiencia equipo trabajo requisitos idioma".split()),
    "danish": set("og med til dig vores erfaring søger stilling arbejde krav".split()),
    "swedish": set("och att som erfarenhet vi är vårt arbetsuppgifter krav".split()),
    "dutch": set("het een met voor wij onze ervaring functie werkzaamheden".split()),
}
SENIORITY_ALIASES: dict[str, tuple[str, ...]] = {
    "intern": ("intern", "internship"), "junior": ("junior", "entry level", "graduate"),
    "mid": ("mid", "mid-level", "intermediate"), "senior": ("senior",),
    "staff": ("staff",), "principal": ("principal",), "lead": ("lead",),
    "manager": ("manager",), "director": ("director",), "executive": ("vp", "vice president", "chief", "c-level"),
}


@dataclass(frozen=True)
class JobEligibility:
    role: str
    location: str
    language: str
    reason: str
    employment_type: str = "eligible"
    seniority: str = "eligible"
    work_model: str = "eligible"
    role_reason: str = ""
    location_reason: str = ""
    work_model_reason: str = ""
    language_reason: str = ""
    employment_type_reason: str = ""
    seniority_reason: str = ""

    @property
    def actionable(self) -> bool:
        return (
            self.role == ROLE_TARGET_MATCH
            and self.location == "eligible"
            and self.employment_type == "eligible"
            and self.seniority == "eligible"
        )


def _definition(profile: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(profile, dict):
        return {}
    value = profile.get("definition", profile)
    return value if isinstance(value, dict) else {}


def _values(definition: dict[str, Any], *keys: str) -> list[str]:
    values: list[str] = []
    for key in keys:
        value = definition.get(key)
        if isinstance(value, list):
            values.extend(item.strip() for item in value if isinstance(item, str) and item.strip())
    return list(dict.fromkeys(values))


def _normal(value: str) -> str:
    words = re.sub(r"[^\w]+", " ", value.casefold(), flags=re.UNICODE).strip()
    return re.sub(r"\bcybersecurity\b", "security", words)


def _has_phrase(text: str, phrase: str) -> bool:
    haystack, needle = f" {_normal(text)} ", f" {_normal(phrase)} "
    return bool(needle.strip()) and needle in haystack


def _matches_any(text: str, terms: Iterable[str]) -> bool:
    return any(_has_phrase(text, term) for term in terms if term.strip())


def classify_role(title: str, profile: dict[str, Any] | None, description: str = "", *, full_description: bool = False) -> str:
    definition = _definition(profile)
    excluded = _values(definition, "excluded_titles", "excluded_title_patterns", "excluded_terms", "excluded_concepts")
    if _matches_any(title, excluded):
        return ROLE_EXCLUDED
    adjacent = _values(definition, "target_adjacent_terms")
    if _matches_any(title, adjacent):
        if full_description:
            if _matches_any(description, excluded):
                return ROLE_EXCLUDED
            if _matches_any(description, _values(definition, "target_titles", "target_terms", "role_families", "positive_concepts")):
                return ROLE_TARGET_MATCH
            return ROLE_UNRELATED
        return ROLE_TARGET_ADJACENT
    targets = _values(definition, "target_titles", "target_terms", "role_families", "positive_concepts")
    if not targets:
        return ROLE_UNCLEAR
    if _matches_any(title, targets):
        return ROLE_TARGET_MATCH
    return ROLE_UNRELATED


@lru_cache(maxsize=512)
def _canonical_geographies(text: str) -> set[str]:
    found: set[str] = set()
    normalized = re.sub(r"\beuropean union\b", "eu", text.casefold())
    for canonical, aliases in COUNTRY_ALIASES.items():
        if any(re.search(rf"(?<!\w){re.escape(alias if len(alias) == 2 else alias.casefold())}(?!\w)", text if len(alias) == 2 else normalized) for alias in aliases):
            found.add(canonical)
    for region in REGION_MEMBERS:
        if re.search(rf"(?<!\w){re.escape(region)}(?!\w)", normalized):
            found.update(REGION_MEMBERS[region])
    if re.search(r"\bemea\b", normalized):
        found.update(REGION_MEMBERS["europe"])
        found.update({"United Arab Emirates", "Israel", "South Africa"})
    # US job feeds commonly provide only the state abbreviation after a city.
    if re.search(r",\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b", text, re.I):
        found.add("United States")
    return found


def _accepted_geographies(definition: dict[str, Any]) -> tuple[set[str], bool]:
    constraints = definition.get("eligibility_constraints", {})
    legacy = str(constraints.get("remote_scope", "")) if isinstance(constraints, dict) else ""
    accepted_values = _values(definition, "allowed_regions", "allowed_countries", "locations") + [legacy]
    has_constraint = any(value.strip() for value in accepted_values)
    accepted = _canonical_geographies(" ".join(accepted_values))
    return accepted, has_constraint


def _work_models(definition: dict[str, Any]) -> set[str]:
    models = {value.casefold().replace("on-site", "onsite") for value in _values(definition, "work_models", "accepted_work_models")}
    if definition.get("remote_only") is True:
        models.add("remote")
    return models


def _country_scope_status(text: str, definition: dict[str, Any]) -> str | None:
    broad = re.search(r"\b(?:europe|european union|eu|eea|emea|worldwide|global|anywhere)\b", text, re.I)
    if broad and not re.search(r"\bonly\b|\brestricted\b|\blimited\b", text, re.I):
        return None
    countries = {country for country, aliases in COUNTRY_ALIASES.items() if any(
        re.search(rf"(?<!\w){re.escape(alias)}(?!\w)", text, 0 if len(alias) == 2 else re.I)
        for alias in aliases
    )}
    if not countries:
        return None
    constraints = definition.get("eligibility_constraints", {})
    legacy = str(constraints.get("remote_scope", "")) if isinstance(constraints, dict) else ""
    values = _values(definition, "allowed_countries", "locations", "allowed_regions") + re.split(r"[/,]", legacy)
    anchors = {country for country, aliases in COUNTRY_ALIASES.items() if any(
        value.strip().casefold() in {alias.casefold() for alias in aliases} for value in values
    )}
    if anchors:
        return "eligible" if countries & anchors else "ineligible"
    accepted, constrained = _accepted_geographies(definition)
    if not constrained or countries & accepted:
        return "eligible"
    return "unclear" if not accepted and re.search(r"\b(?:worldwide|global|anywhere)\b", " ".join(values), re.I) else "ineligible"


EMPLOYER_SCOPE = re.compile(
    r"(?:remote(?:ly)?\s+(?:(?:within|in|from|across)\b|(?:position|role|job)\s+(?:is\s+)?based\s+in)"
    r"|(?:must|need\s+to|required\s+to)\s+(?:(?:be|reside|live|work)\s+)?(?:(?:based|located|reside|live|work)\s+)?(?:in|within)\b"
    r"|(?:candidates|applicants|you)\s+(?:(?:must|need\s+to|are\s+required\s+to|can|may)\s+)?(?:be\s+)?(?:based|located|residing|resident)\s+(?:in|within)\b"
    r"|(?:if\s+you\s+are\s+based\s+in)\b"
    r"|(?:possibility\s+to\s+work\s+remotely\s*\(?if\s+you\s+are\s+based\s+in)\b"
    r"|(?:only|exclusively)\s+(?:for\s+)?(?:candidates\s+)?(?:based|located|residing)\s+in\b"
    r"|(?:united states|us|uk|united kingdom|germany|poland|austria|india|canada|australia)[- ]only)"
    r"[^.!?\n]{0,160}", re.I,
)
EMPLOYER_COUNTRY_ONLY = re.compile(r"\b(?:" + "|".join(map(re.escape, COUNTRY_ALIASES)) + r")[- ]only\b[^.!?\n]{0,160}", re.I)

_EMPLOYMENT_TYPE_ALIASES = {
    "contract": ("contract", "contractor", "b2b", "freelance", "freelancer", "independent contractor"),
    "permanent": ("permanent", "regular employee", "indefinite"),
    "full_time": ("full time", "full-time", "fulltime"),
    "part_time": ("part time", "part-time", "parttime"),
    "temporary": ("temporary", "fixed term", "fixed-term"),
    "internship": ("internship", "intern"),
}
_EMPLOYMENT_TYPE_LOOKUP = {
    term: kind for kind, terms in _EMPLOYMENT_TYPE_ALIASES.items() for term in terms
}
_EMPLOYMENT_TYPE_PATTERN = re.compile(
    r"(?<!\w)(?P<term>" + "|".join(
        re.escape(term) for term in sorted(_EMPLOYMENT_TYPE_LOOKUP, key=len, reverse=True)
    ) + r")(?!\w)"
)


def detected_employment_types(job_type: str | None, description: str | None) -> set[str]:
    """Return normalized employment types explicitly named by the listing."""
    raw = f"{job_type or ''} {description or ''}".casefold()
    return {
        _EMPLOYMENT_TYPE_LOOKUP[match.group("term")]
        for match in _EMPLOYMENT_TYPE_PATTERN.finditer(raw)
    }


def _employer_geography(description: str, title: str, definition: dict[str, Any], accepted: set[str]) -> str | None:
    if re.search(r"\b(?:excluding|except|not\s+available\s+in)\s+Austria\b", description, re.I) and "Austria" in accepted:
        return "ineligible"
    phrases = [match.group(0) for match in EMPLOYER_SCOPE.finditer(description)]
    phrases.extend(match.group(0) for match in EMPLOYER_COUNTRY_ONLY.finditer(description))
    if not phrases:
        phrases = [match.group(0) for match in EMPLOYER_SCOPE.finditer(title)]
    outcomes: list[bool | None] = []
    for phrase in phrases:
        geographies = _canonical_geographies(phrase)
        if not geographies and not re.search(r"\b(?:worldwide|global|anywhere)\b", phrase, re.I):
            continue
        country_status = _country_scope_status(phrase, definition)
        if country_status == "unclear":
            outcomes.append(None)
        elif country_status is not None:
            outcomes.append(country_status == "eligible")
        else:
            outcomes.append(bool(geographies & accepted))
    if None in outcomes or (True in outcomes and False in outcomes):
        return "unclear"
    if False in outcomes:
        return "ineligible"
    if True in outcomes:
        return "eligible"
    return "unclear" if any(re.search(r"^(?:must|need|required|candidates|applicants|if|only|exclusively|remote(?:ly)?\s+(?:within|in))\b", phrase, re.I) for phrase in phrases) else None


def _work_model_status(
    location: str,
    remote_scope: str,
    description: str,
    definition: dict[str, Any],
    title: str = "",
    verified_work_model: str | None = None,
) -> tuple[str, str]:
    accepted = _work_models(definition)
    if not accepted:
        return "eligible", "no work-model restriction"
    model = verified_work_model or classify_work_model(
        title=title, location=location, remote_scope=remote_scope, description=description
    )
    if model == "unknown":
        return "unclear", "The listing does not establish its work model."
    if model in accepted:
        return "eligible", "The listing's work model matches the configured preferences."
    accepted_label = ", ".join(sorted(accepted))
    return "ineligible", f"The listing is {model}; the profile accepts {accepted_label}."


def _location_status(
    location: str | None,
    remote_scope: str | None,
    description: str,
    definition: dict[str, Any],
    title: str = "",
    verified_work_model: str | None = None,
    work_model_result: tuple[str, str] | None = None,
) -> tuple[str, str]:
    location_text = location or ""
    scope_text = remote_scope or ""
    plain = html.unescape(re.sub(r"<[^<>]*>", " ", description or ""))
    accepted, has_geo_constraint = _accepted_geographies(definition)
    excluded = _canonical_geographies(" ".join(_values(definition, "excluded_regions", "excluded_countries")))
    constraints = definition.get("eligibility_constraints", {})
    legacy_scope = str(constraints.get("remote_scope", "")) if isinstance(constraints, dict) else ""
    if "worldwide" in legacy_scope.casefold() or "global" in legacy_scope.casefold():
        has_geo_constraint = True

    explicit = _canonical_geographies(f"{scope_text} {location_text}")
    if "Austria" in accepted and re.search(r"\b(?:excluding|except|not\s+available\s+in)\s+Austria\b", f"{scope_text} {location_text} {plain}", re.I):
        return "ineligible", "The listing explicitly excludes Austria."
    if explicit & excluded:
        return "ineligible", f"The listing is in an excluded location ({', '.join(sorted(explicit & excluded))})."
    employer_scope = _employer_geography(plain, title, definition, accepted) if has_geo_constraint else None
    if employer_scope == "ineligible":
        return "ineligible", "The employer's geographic restriction excludes the configured location."
    if employer_scope == "unclear":
        return "unclear", "The employer's geographic restriction could not be resolved."
    if employer_scope == "eligible":
        return "eligible", "The employer's geographic scope includes the configured location."
    country_status = _country_scope_status(f"{scope_text} {location_text}", definition)
    if country_status == "ineligible":
        return "ineligible", "The listing's country-restricted scope does not include the configured country."
    if country_status == "unclear":
        return "unclear", "The listing's country restriction needs a configured compatible country."
    if country_status == "eligible":
        return "eligible", "The listing's country scope includes the configured country."
    if re.search(r"\b(?:worldwide|global(?:ly)?|anywhere)\b", f"{scope_text} {location_text}", re.I):
        return "eligible", "The listing's global scope includes the configured locations."
    if explicit and has_geo_constraint:
        if not explicit & accepted:
            return "ineligible", f"The listing location ({', '.join(sorted(explicit))}) is outside the configured locations."
        return "eligible", "The listing location matches the configured locations."
    if not has_geo_constraint:
        return "eligible", "No geographic restriction is configured."
    if not explicit and re.search(r"\bworldwide\b|\bglobal(?:ly)?\b|\banywhere\b", f"{scope_text} {location_text} {plain}", re.I):
        return "eligible", "The listing's global scope includes the configured locations."
    if explicit & accepted:
        return "eligible", "The listing location matches the configured locations."
    return "unclear", "The listing does not establish a location allowed by the configured preferences."


def _detected_languages(text: str) -> set[str]:
    normalized = html.unescape(re.sub(r"<[^<>]*>", " ", text or "")).casefold()
    detected = {
        _LANGUAGE_ALIAS_LOOKUP[match.group("alias").casefold()]
        for match in _LANGUAGE_ALIAS_PATTERN.finditer(normalized)
    }
    words = re.findall(r"[^\W\d_]+", normalized, flags=re.UNICODE)
    for language, markers in LANGUAGE_MARKERS.items():
        if sum(word in markers for word in words) >= 6:
            detected.add(language)
    return detected


def _posting_language(text: str, *, detected: set[str] | None = None) -> str:
    normalized = html.unescape(re.sub(r"<[^<>]*>", " ", text or "")).casefold()
    words = re.findall(r"[^\W\d_]+", normalized, flags=re.UNICODE)
    if len(words) < 30:
        return "unknown"
    detected = detected if detected is not None else _detected_languages(normalized)
    if detected and "english" not in detected:
        return "non_english"
    english_markers = set("the and with your our you will have this for are we that experience team work role skills responsibilities required candidate position".split())
    english_count = sum(word in english_markers for word in words)
    if english_count >= 8:
        return "english"
    return "non_english" if detected else "unknown"


def _language_status(description: str, definition: dict[str, Any]) -> tuple[str, str]:
    constraints = definition.get("language_constraints", [])
    accepted = {value.casefold() for value in _values(definition, "accepted_languages")}
    if isinstance(constraints, list):
        accepted.update(str(item.get("language", "")).casefold() for item in constraints if isinstance(item, dict) and item.get("required", True))
    if definition.get("english_only") is True:
        accepted.add("english")
    if not accepted:
        return "eligible", "no language restriction"
    plain = html.unescape(re.sub(r"<[^<>]*>", " ", description or ""))
    detected = _detected_languages(plain)
    required = {
        _LANGUAGE_ALIAS_LOOKUP[match.group("alias").casefold()]
        for match in _LANGUAGE_REQUIRED_PATTERN.finditer(plain)
    }
    if _GERMAN_REQUIRED_PATTERN.search(plain):
        required.add("german")
    if required:
        if all(any(language in item or item in language for item in accepted) for language in required):
            return "eligible", f"Required language(s) {', '.join(sorted(required))} are accepted by the profile."
        return "ineligible", f"The listing requires {', '.join(sorted(required))}; accepted language(s): {', '.join(sorted(accepted))}."
    language = _posting_language(plain, detected=detected)
    if language == "english":
        return ("eligible", "The listing language is accepted.") if any("english" in item or item in "english" for item in accepted) else ("ineligible", f"The listing is in English; accepted language(s): {', '.join(sorted(accepted))}.")
    if language == "non_english":
        if detected and any(any(found in accepted_item or accepted_item in found for accepted_item in accepted) for found in detected):
            return "eligible", f"The listing language ({', '.join(sorted(detected))}) is accepted."
        if detected:
            return "ineligible", f"The listing appears to be in {', '.join(sorted(detected))}; accepted language(s): {', '.join(sorted(accepted))}."
        return "unclear", "posting language could not be identified"
    return "unclear", "The listing does not provide enough text to establish its language."


def _employment_status(job_type: str | None, description: str, definition: dict[str, Any]) -> tuple[str, str]:
    accepted = {value.casefold().replace("-", "_").replace(" ", "_") for value in _values(definition, "accepted_employment_types", "employment_types")}
    excluded = {value.casefold().replace("-", "_").replace(" ", "_") for value in _values(definition, "excluded_employment_types")}
    types = detected_employment_types(job_type, description)
    if types & excluded:
        return "ineligible", f"The listing is {', '.join(sorted(types & excluded))}; that employment type is excluded by the profile."
    if accepted:
        if not types:
            return "unclear", "The listing does not establish an accepted employment type."
        return ("eligible", "The listing's employment type is accepted.") if types & accepted else ("ineligible", f"The listing is {', '.join(sorted(types))}; accepted employment types: {', '.join(sorted(accepted))}.")
    return "eligible", "no employment-type restriction"


def _verified_employment_status(
    status: str | None, verified_type: str | None, job_type: str | None,
    description: str, definition: dict[str, Any],
) -> tuple[str, str] | None:
    if status not in {"accepted", "rejected"} or not verified_type:
        return None
    detected = detected_employment_types(job_type, description)
    if verified_type not in detected:
        return None
    if status == "rejected":
        return "ineligible", f"You declined this listing's {verified_type.replace('_', ' ')} employment type."
    excluded = {
        value.casefold().replace("-", "_").replace(" ", "_")
        for value in _values(definition, "excluded_employment_types")
    }
    other_excluded = detected & excluded - {verified_type}
    if other_excluded:
        return "ineligible", f"The listing also specifies excluded employment type(s): {', '.join(sorted(other_excluded))}."
    accepted = {
        value.casefold().replace("-", "_").replace(" ", "_")
        for value in _values(definition, "accepted_employment_types", "employment_types")
    }
    remaining_types = detected - {verified_type}
    if accepted and remaining_types and not remaining_types & accepted:
        return "ineligible", f"The listing also specifies employment type(s) outside the configured accepted types: {', '.join(sorted(remaining_types))}."
    return "eligible", f"You approved this listing's {verified_type.replace('_', ' ')} employment type."


def _seniority_status(title: str, definition: dict[str, Any]) -> tuple[str, str]:
    target = {item.casefold() for item in _values(definition, "target_seniority", "accepted_seniority")}
    excluded = {item.casefold() for item in _values(definition, "excluded_seniority")}
    if not target and not excluded:
        return "eligible", "no seniority restriction"
    title_lower = title.casefold()
    detected = {level for level, aliases in SENIORITY_ALIASES.items() if any(re.search(rf"(?<!\w){re.escape(alias)}(?!\w)", title_lower) for alias in aliases)}
    if detected & excluded:
        return "ineligible", "seniority is explicitly excluded"
    if target and not detected:
        return "unclear", "The listing title does not establish a configured seniority."
    if target and not detected & target:
        return "ineligible", f"The title indicates {', '.join(sorted(detected))}; configured seniority: {', '.join(sorted(target))}."
    return "eligible", "The title matches the configured seniority."


def _role_reason(title: str, role: str, profile: dict[str, Any] | None) -> str:
    definition = _definition(profile)
    if role == ROLE_EXCLUDED:
        excluded = _values(definition, "excluded_titles", "excluded_title_patterns", "excluded_terms", "excluded_concepts")
        matched = [term for term in excluded if _has_phrase(title, term)]
        return f"The title matches an exclusion in the active profile: {', '.join(matched)}." if matched else "The role matches an exclusion configured in the active profile."
    if role == ROLE_UNRELATED:
        return "The title does not match the target titles or role families in the active profile."
    if role == ROLE_TARGET_ADJACENT:
        return "The title is adjacent to the configured targets and needs a relevance review."
    if role == ROLE_UNCLEAR:
        return "The active SearchProfile is missing or does not define enough role targets."
    return "The role matches a configured target."


def assess_discovered_job(
    *, title: str, location: str | None, remote_scope: str | None, description: str | None,
    profile: dict[str, Any] | None, manual: bool = False, employment_type: str | None = None,
    description_kind: str | None = None, verified_work_model: str | None = None,
    verified_language: str | None = None, verified_location_status: str | None = None,
    verified_employment_type_status: str | None = None,
    verified_employment_type: str | None = None,
    preference_overrides: Iterable[str] = (),
) -> JobEligibility:
    if manual:
        return JobEligibility(ROLE_TARGET_MATCH, "eligible", "eligible", "User-created job.", role_reason="User-created job.")
    if profile is None:
        reason = "The active SearchProfile is unavailable."
        return JobEligibility(ROLE_UNCLEAR, "unclear", "unclear", reason, "unclear", "unclear", "unclear", reason, reason, reason, reason, reason, reason)
    definition = _definition(profile)
    full_description = description or ""
    is_full_description = is_usable_full_job_description(full_description)
    role = classify_role(title, profile, full_description, full_description=is_full_description)
    work_model_status, work_model_reason = "eligible", "Work arrangement is reviewed from the listing by the user."
    location_status, location_reason = _location_status(
        location, remote_scope, full_description, definition, title,
    )
    if verified_location_status in {"accepted", "rejected"}:
        location_status = "eligible" if verified_location_status == "accepted" else "ineligible"
        location_reason = (
            "User-approved location overrides the configured geography preference."
            if verified_location_status == "accepted"
            else "Location manually rejected by the user."
        )
    language_status, language_reason = "eligible", "Language is reviewed from the listing by the user."
    employment_decision = _verified_employment_status(
        verified_employment_type_status, verified_employment_type,
        employment_type, full_description, definition,
    )
    employment_status, employment_reason = (
        employment_decision
        if employment_decision is not None
        else _employment_status(employment_type, full_description, definition)
    )
    seniority_status, seniority_reason = _seniority_status(title, definition)
    # A per-listing approval affects only the selected preferences and never
    # changes the user's global SearchProfile.
    accepted_overrides = set(preference_overrides) & {
        "role", "location", "employment_type", "seniority"
    }
    for field in accepted_overrides:
        if field == "role" and role == ROLE_TARGET_ADJACENT:
            role = ROLE_TARGET_MATCH
        elif field == "location":
            location_status, location_reason = "eligible", "Location accepted for this listing despite saved preferences."
        elif field == "employment_type":
            employment_status, employment_reason = "eligible", "Employment type accepted for this listing despite saved preferences."
        elif field == "seniority":
            seniority_status, seniority_reason = "eligible", "Seniority accepted for this listing despite saved preferences."
    role_reason = _role_reason(title, role, profile)
    # Keep the legacy summary field useful, but make definitive facts outrank uncertainty.
    definitive = next((detail for state, detail in (
        (role, role_reason), (work_model_status, work_model_reason), (location_status, location_reason),
        (language_status, language_reason), (employment_status, employment_reason), (seniority_status, seniority_reason),
    ) if state in {ROLE_EXCLUDED, ROLE_UNRELATED, "ineligible"}), None)
    unresolved = next((detail for state, detail in (
        (role, role_reason), (location_status, location_reason), (work_model_status, work_model_reason),
        (language_status, language_reason), (employment_status, employment_reason), (seniority_status, seniority_reason),
    ) if state in {ROLE_UNCLEAR, ROLE_TARGET_ADJACENT, "unclear"}), None)
    reason = definitive or unresolved or "All configured preferences are satisfied."
    return JobEligibility(
        role, location_status, language_status, reason, employment_status, seniority_status,
        work_model_status, role_reason, location_reason, work_model_reason,
        language_reason, employment_reason, seniority_reason,
    )
