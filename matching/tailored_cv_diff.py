"""Deterministic, human-readable comparison of base and tailored CV LaTeX."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from html import escape
from typing import Iterable


@dataclass(frozen=True)
class CVTextUnit:
    section: str
    text: str
    kind: str
    order: int


@dataclass(frozen=True)
class CVSectionChange:
    section: str
    kind: str
    base_units: tuple[CVTextUnit, ...] = ()
    tailored_units: tuple[CVTextUnit, ...] = ()


@dataclass(frozen=True)
class CVDiff:
    changes: tuple[CVSectionChange, ...]
    sections: tuple[str, ...]
    base_sha256: str
    tailored_sha256: str
    base_units: tuple[CVTextUnit, ...] = ()
    tailored_units: tuple[CVTextUnit, ...] = ()

    @property
    def changed_sections(self) -> int:
        return len({change.section for change in self.changes})

    @property
    def counts(self) -> dict[str, int]:
        return {
            "modified": sum(change.kind == "modified" for change in self.changes),
            "added": sum(change.kind == "added" for change in self.changes),
            "removed": sum(change.kind == "removed" for change in self.changes),
            "reordered": 0,
        }


def _strip_latex(text: str) -> str:
    value = re.sub(r"(?m)(?<!\\)%.*$", "", text)
    value = re.sub(r"\\href\{[^{}]*\}\{([^{}]*)\}", r"\1", value)
    value = re.sub(r"\\(?:begin|end)\{center\}", " ", value)
    value = re.sub(r"\\\\(?:\[[^\]]*\])?", " ", value)
    value = re.sub(r"\\[;,!:]", " ", value)
    # Preserve command arguments for common formatting macros.
    previous = None
    while previous != value:
        previous = value
        value = re.sub(r"\\[A-Za-z@]+(?:\[[^]]*\])?\{([^{}]*)\}", r"\1", value)
    value = re.sub(r"\\[A-Za-z@]+(?:\[[^]]*\])?", " ", value)
    value = value.replace(r"\&", "&").replace(r"\%", "%").replace(r"\#", "#")
    value = value.replace("~", " ")
    value = re.sub(r"\s+", " ", value)
    return value.strip(" \t{}")


def _arguments(command_text: str, count: int) -> list[str] | None:
    values = re.findall(r"\{([^{}]*)\}", command_text)
    return values[:count] if len(values) >= count else None


def _section_segments(source: str) -> list[tuple[str, str]]:
    headings = list(re.finditer(r"\\(?:cvsection|section|subsection)\{([^{}]*)\}", source))
    if not headings:
        return [("Document", source)]
    segments: list[tuple[str, str]] = []
    document_start = re.search(r"\\begin\{document\}", source)
    if document_start:
        header = source[document_start.end():headings[0].start()]
        rendered_header = _strip_latex(header)
        if re.search(r"[A-Za-z0-9]", rendered_header):
            segments.append(("Header", header))
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(source)
        segments.append((_strip_latex(heading.group(1)) or "Document", source[heading.end():end]))
    return segments


def extract_cv_units(source: str) -> tuple[CVTextUnit, ...]:
    """Extract sections, roles, bullets, skills, and meaningful paragraphs."""

    units: list[CVTextUnit] = []
    order = 0
    for section, segment in _section_segments(source):
        commands: list[tuple[int, int, str, str]] = []
        patterns = (
            (r"\\roleblock(?:\{[^{}]*\}){5}", "role"),
            (r"\\skillrow(?:\{[^{}]*\}){2}", "skill"),
            (r"\\item\s+.*?(?=\\item|\\end\{|$)", "bullet"),
        )
        for pattern, kind in patterns:
            for match in re.finditer(pattern, segment, flags=re.DOTALL):
                commands.append((match.start(), match.end(), kind, match.group(0)))
        commands.sort(key=lambda item: item[0])
        occupied: list[tuple[int, int]] = []
        for start, end, kind, command_text in commands:
            if any(start < other_end and end > other_start for other_start, other_end in occupied):
                continue
            occupied.append((start, end))
            if kind == "bullet":
                text = _strip_latex(command_text.split("\\item", 1)[1])
            else:
                args = _arguments(command_text, 5 if kind == "role" else 2)
                if not args:
                    continue
                if kind == "role":
                    text = " — ".join(part for part in (_strip_latex(args[0]), _strip_latex(args[2])) if part)
                else:
                    text = f"{_strip_latex(args[0])}: {_strip_latex(args[1])}"
            if text:
                units.append(CVTextUnit(section, text, kind, order))
                order += 1
        remainder = segment
        for start, end, _, _ in reversed(commands):
            remainder = remainder[:start] + " " + remainder[end:]
        for paragraph in re.split(r"\n\s*\n|\\par", remainder):
            text = _strip_latex(paragraph)
            if len(text) >= 20 and not text.startswith(("begin", "end", "vspace")):
                units.append(CVTextUnit(section, text, "paragraph", order))
                order += 1
    return tuple(units)


def _normal(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


def compare_cv_sources(base_source: str, tailored_source: str) -> CVDiff:
    """Compare CVs conservatively at section level.

    A section is changed when its extracted, formatting-normalized content
    differs.  We intentionally do not infer bullet identity, movement, or
    rewrites: the complete section contents are shown side by side in the UI.
    """

    base_units = extract_cv_units(base_source)
    tailored_units = extract_cv_units(tailored_source)

    base_by_section: dict[str, tuple[CVTextUnit, ...]] = {}
    tailored_by_section: dict[str, tuple[CVTextUnit, ...]] = {}
    for unit in base_units:
        base_by_section.setdefault(unit.section, ())
        base_by_section[unit.section] += (unit,)
    for unit in tailored_units:
        tailored_by_section.setdefault(unit.section, ())
        tailored_by_section[unit.section] += (unit,)

    section_order = tuple(dict.fromkeys(unit.section for unit in base_units + tailored_units))
    changes: list[CVSectionChange] = []
    for section in section_order:
        base_section = base_by_section.get(section, ())
        tailored_section = tailored_by_section.get(section, ())
        base_signature = tuple((unit.kind, _normal(unit.text)) for unit in base_section)
        tailored_signature = tuple((unit.kind, _normal(unit.text)) for unit in tailored_section)
        if base_signature == tailored_signature:
            continue
        kind = "modified" if base_section and tailored_section else "removed" if base_section else "added"
        changes.append(CVSectionChange(section, kind, base_section, tailored_section))

    return CVDiff(
        tuple(changes),
        tuple(change.section for change in changes),
        hashlib.sha256(base_source.encode("utf-8")).hexdigest(),
        hashlib.sha256(tailored_source.encode("utf-8")).hexdigest(),
        base_units,
        tailored_units,
    )


def render_word_changes(changes: Iterable[tuple[str, str]]) -> str:
    parts: list[str] = []
    for kind, text in changes:
        css = {"added": "diff-added", "removed": "diff-removed"}.get(kind, "")
        escaped = escape(text)
        parts.append(f"<span class='{css}'>{escaped}</span>" if css else escaped)
    return " ".join(parts)
