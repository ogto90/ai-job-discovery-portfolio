"""Profession-neutral, user-owned search preferences."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SalaryPreference(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    minimum: float | None = Field(default=None, ge=0)
    target: float | None = Field(default=None, ge=0)
    currency: str | None = None
    period: Literal["hourly", "monthly", "annual"] | None = None


class LanguageConstraint(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    language: str = Field(min_length=1)
    minimum_proficiency: str | None = None
    required: bool = True


class SearchProfile(BaseModel):
    """A reusable set of preferences for one user's job-search direction."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1)
    target_titles: list[str] = Field(default_factory=list)
    target_terms: list[str] = Field(default_factory=list)
    target_adjacent_terms: list[str] = Field(default_factory=list)
    role_families: list[str] = Field(default_factory=list)
    target_seniority: list[str] = Field(default_factory=list)
    accepted_seniority: list[str] = Field(default_factory=list)
    excluded_seniority: list[str] = Field(default_factory=list)
    industries_or_domains: list[str] = Field(default_factory=list)
    locations: list[str] = Field(default_factory=list)
    allowed_regions: list[str] = Field(default_factory=list)
    allowed_countries: list[str] = Field(default_factory=list)
    excluded_regions: list[str] = Field(default_factory=list)
    excluded_countries: list[str] = Field(default_factory=list)
    work_models: list[Literal["remote", "hybrid", "onsite", "flexible"]] = Field(default_factory=list)
    discovery_modes: list[Literal["targeted", "broad"]] = Field(default_factory=list)
    remote_only: bool = False
    english_only: bool = False
    salary: SalaryPreference | None = None
    employment_types: list[str] = Field(default_factory=list)
    accepted_employment_types: list[str] = Field(default_factory=list)
    excluded_employment_types: list[str] = Field(default_factory=list)
    accepted_languages: list[str] = Field(default_factory=list)
    language_constraints: list[LanguageConstraint] = Field(default_factory=list)
    positive_concepts: list[str] = Field(default_factory=list)
    excluded_titles: list[str] = Field(default_factory=list)
    excluded_title_patterns: list[str] = Field(default_factory=list)
    excluded_terms: list[str] = Field(default_factory=list)
    excluded_concepts: list[str] = Field(default_factory=list)
    minimum_fit_score: int = Field(default=0, ge=0, le=100)
    eligibility_constraints: dict[str, Any] = Field(default_factory=dict)

    @field_validator(
        "target_titles",
        "target_terms",
        "target_adjacent_terms",
        "role_families",
        "target_seniority",
        "accepted_seniority",
        "excluded_seniority",
        "industries_or_domains",
        "locations",
        "allowed_regions",
        "allowed_countries",
        "excluded_regions",
        "excluded_countries",
        "employment_types",
        "accepted_employment_types",
        "excluded_employment_types",
        "accepted_languages",
        "positive_concepts",
        "excluded_titles",
        "excluded_title_patterns",
        "excluded_terms",
        "excluded_concepts",
    )
    @classmethod
    def strip_nonblank_values(cls, values: list[str]) -> list[str]:
        return [value.strip() for value in values if value.strip()]
