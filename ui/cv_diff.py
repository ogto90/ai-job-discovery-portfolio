"""Read-only Streamlit view for inspecting tailored-CV changes."""

from __future__ import annotations

from dataclasses import dataclass
import difflib
from html import escape
import re
from typing import Any
from urllib.parse import urlencode

import streamlit as st

from matching.candidate_profile_persistence import PersistenceError, SupabaseRestClient
from matching.tailored_cv import TailoredCVError, compile_latex
from matching.tailored_cv_diff import CVTextUnit, CVDiff, compare_cv_sources
from matching.job_metadata_overrides import get_job_metadata_override, resolve_effective_job_metadata
from .dashboard_data import job_pdf_filename


@dataclass(frozen=True)
class DiffContext:
    tailored: dict[str, Any]
    base: dict[str, Any]
    job: dict[str, Any] | None
    base_source: str
    tailored_source: str
    tailored_pdf: bytes


@dataclass(frozen=True)
class PresentedChange:
    kind: str
    base: CVTextUnit | None = None
    tailored: CVTextUnit | None = None
    base_position: int | None = None
    tailored_position: int | None = None
    word_changes: tuple[tuple[str, str], ...] = ()


def _normalized_text(value: str) -> str:
    return " ".join(value.casefold().split())


def _word_changes(base: str, tailored: str) -> tuple[tuple[str, str], ...]:
    base_words = re.findall(r"\w+|[^\w\s]", base)
    tailored_words = re.findall(r"\w+|[^\w\s]", tailored)
    matcher = difflib.SequenceMatcher(a=base_words, b=tailored_words)
    result: list[tuple[str, str]] = []
    for tag, a_start, a_end, b_start, b_end in matcher.get_opcodes():
        if tag == "equal":
            result.append(("equal", " ".join(tailored_words[b_start:b_end])))
        elif tag in {"delete", "replace"}:
            result.append(("removed", " ".join(base_words[a_start:a_end])))
            if tag == "replace":
                result.append(("added", " ".join(tailored_words[b_start:b_end])))
        elif tag == "insert":
            result.append(("added", " ".join(tailored_words[b_start:b_end])))
    return tuple((kind, text) for kind, text in result if text)


def _side_word_html(changes: tuple[tuple[str, str], ...], side: str) -> str:
    visible = []
    for kind, text in changes:
        if side == "base" and kind == "added":
            continue
        if side == "tailored" and kind == "removed":
            continue
        visible.append((kind, text))
    parts: list[str] = []
    for kind, text in visible:
        css = {"added": "diff-added", "removed": "diff-removed"}.get(kind, "")
        value = escape(text)
        parts.append(f"<span class='{css}'>{value}</span>" if css else value)
    return " ".join(parts)


def _presented_section_changes(base_units: tuple[CVTextUnit, ...], tailored_units: tuple[CVTextUnit, ...]) -> tuple[PresentedChange, ...]:
    """Create display-only item changes without changing the diff engine."""

    base_text = [_normalized_text(unit.text) for unit in base_units]
    tailored_text = [_normalized_text(unit.text) for unit in tailored_units]
    matcher = difflib.SequenceMatcher(a=base_text, b=tailored_text, autojunk=False)
    changes: list[PresentedChange] = []
    pending_removed: dict[str, list[tuple[int, CVTextUnit]]] = {}
    pending_added: dict[str, list[tuple[int, CVTextUnit]]] = {}

    for tag, a_start, a_end, b_start, b_end in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "replace":
            shared = min(a_end - a_start, b_end - b_start)
            for offset in range(shared):
                base_position = a_start + offset + 1
                tailored_position = b_start + offset + 1
                changes.append(PresentedChange(
                    "modified",
                    base_units[base_position - 1],
                    tailored_units[tailored_position - 1],
                    base_position,
                    tailored_position,
                    _word_changes(base_units[base_position - 1].text, tailored_units[tailored_position - 1].text),
                ))
            for index in range(a_start + shared, a_end):
                pending_removed.setdefault(base_text[index], []).append((index + 1, base_units[index]))
            for index in range(b_start + shared, b_end):
                pending_added.setdefault(tailored_text[index], []).append((index + 1, tailored_units[index]))
        elif tag == "delete":
            for index in range(a_start, a_end):
                pending_removed.setdefault(base_text[index], []).append((index + 1, base_units[index]))
        elif tag == "insert":
            for index in range(b_start, b_end):
                pending_added.setdefault(tailored_text[index], []).append((index + 1, tailored_units[index]))

    for text in set(pending_removed) | set(pending_added):
        removed = pending_removed.get(text, [])
        added = pending_added.get(text, [])
        while removed and added:
            old_position, base = removed.pop(0)
            new_position, tailored = added.pop(0)
            changes.append(PresentedChange("moved", base, tailored, old_position, new_position))
        changes.extend(PresentedChange("removed", base=base, base_position=position) for position, base in removed)
        changes.extend(PresentedChange("added", tailored=tailored, tailored_position=position) for position, tailored in added)

    return tuple(changes)


def _change_summary(changes: tuple[PresentedChange, ...]) -> str:
    labels = (("modified", "modified"), ("moved", "moved"), ("added", "added"), ("removed", "removed"))
    return " · ".join(f"{sum(change.kind == key for change in changes)} {label}" for key, label in labels if any(change.kind == key for change in changes))


def _rows(client: SupabaseRestClient, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    rows = client.get_json(f"/rest/v1/{table}?{urlencode(params)}")
    if not isinstance(rows, list):
        raise PersistenceError(f"Supabase returned invalid {table} data.")
    return rows


@st.cache_data(show_spinner=False)
def _compile_base_pdf(base_source: str) -> bytes:
    """Compile the exact base source for download without persisting it."""

    return compile_latex(base_source)


def load_diff_context(client: SupabaseRestClient, tailored_cv_id: int, user_id: str | None = None) -> DiffContext:
    """Resolve and verify the complete tailored -> exact source CV lineage."""

    current_user_cv = client.resolve_active_base_cv(user_id) if user_id else client.resolve_active_base_cv()
    owner_id = user_id or current_user_cv.user_id
    tailored_rows = _rows(
        client,
        "cv_versions",
        {"select": "id,user_id,job_id,is_base,source_cv_version_id,storage_bucket,tex_file_path,pdf_file_path,file_path,created_at,artifacts_deleted_at", "id": f"eq.{tailored_cv_id}", "user_id": f"eq.{owner_id}"},
    )
    if len(tailored_rows) != 1:
        raise PersistenceError("The tailored CV could not be found.")
    tailored = tailored_rows[0]
    if str(tailored.get("user_id")) != owner_id:
        raise PersistenceError("You do not have access to this tailored CV.")
    if tailored.get("is_base") is True or not tailored.get("source_cv_version_id"):
        raise PersistenceError("This CV is not a tailored CV with a source lineage.")
    if tailored.get("artifacts_deleted_at") or not tailored.get("tex_file_path") or not tailored.get("pdf_file_path"):
        raise PersistenceError("Comparison unavailable: this tailored CV's source files have expired.")

    source_id = int(tailored["source_cv_version_id"])
    base_rows = _rows(
        client,
        "cv_versions",
        {"select": "id,user_id,is_base,is_active,storage_bucket,file_path,label,created_at", "id": f"eq.{source_id}", "user_id": f"eq.{owner_id}"},
    )
    if len(base_rows) != 1:
        raise PersistenceError("The source CV for this tailored version could not be found.")
    base = base_rows[0]
    if str(base.get("user_id")) != current_user_cv.user_id or base.get("is_base") is not True:
        raise PersistenceError("The tailored CV source does not belong to the current user.")

    bucket = str(base.get("storage_bucket") or tailored.get("storage_bucket"))
    base_bytes = client.download_storage_object(bucket, str(base["file_path"]))
    tailored_bytes = client.download_storage_object(bucket, str(tailored["tex_file_path"]))
    tailored_pdf = client.download_storage_object(bucket, str(tailored["pdf_file_path"]))
    try:
        base_source = base_bytes.decode("utf-8")
        tailored_source = tailored_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PersistenceError("The stored CV source is not valid UTF-8 LaTeX.") from exc
    job_id = tailored.get("job_id")
    jobs = _rows(client, "jobs", {"select": "company,title", "id": f"eq.{job_id}"}) if job_id else []
    job = jobs[0] if jobs else None
    if job is not None:
        override = get_job_metadata_override(client, user_id=owner_id, job_id=int(job_id))
        effective = resolve_effective_job_metadata(job.get("company"), job.get("title"), override)
        job = {**job, "company": effective.company, "title": effective.title}
    return DiffContext(tailored, base, job, base_source, tailored_source, tailored_pdf)


def _render_section_units(units: tuple[CVTextUnit, ...]) -> None:
    if not units:
        st.markdown("<div class='diff-empty'>No content in this version</div>", unsafe_allow_html=True)
        return
    for unit in units:
        st.markdown(
            f"<div class='diff-unit'><div class='diff-unit-kind'>{escape(unit.kind.title())}</div>"
            f"<div class='diff-unit-text'>{escape(unit.text)}</div></div>",
            unsafe_allow_html=True,
        )


def _render_presented_change(change: PresentedChange) -> None:
    if change.kind == "moved":
        direction = "UP" if change.tailored_position < change.base_position else "DOWN"
        st.markdown(f"<div class='diff-change-card diff-change-moved'><div class='diff-state'>MOVED {direction}</div><div class='diff-unit-kind'>{escape(change.base.kind.title())}</div><div class='diff-unit-text'>{escape(change.base.text)}</div><div class='diff-position'>{change.base_position} → {change.tailored_position}</div></div>", unsafe_allow_html=True)
        return
    if change.kind in {"added", "removed"}:
        unit = change.tailored if change.kind == "added" else change.base
        position = change.tailored_position if change.kind == "added" else change.base_position
        label = "ADDED" if change.kind == "added" else "REMOVED"
        st.markdown(f"<div class='diff-change-card diff-change-{change.kind}'><div class='diff-state'>{label}</div><div class='diff-unit-kind'>{escape(unit.kind.title())}</div><div class='diff-unit-text'>{escape(unit.text)}</div><div class='diff-position'>Position {position}</div></div>", unsafe_allow_html=True)
        return
    columns = st.columns(2)
    with columns[0]:
        st.markdown("<div class='diff-side-label'>BASE CV</div>", unsafe_allow_html=True)
        st.markdown(f"<div class='diff-change-card diff-change-modified'><div class='diff-unit-kind'>{escape(change.base.kind.title())}</div><div class='diff-unit-text'>{_side_word_html(change.word_changes, 'base')}</div></div>", unsafe_allow_html=True)
    with columns[1]:
        st.markdown("<div class='diff-side-label'>TAILORED CV</div>", unsafe_allow_html=True)
        st.markdown(f"<div class='diff-change-card diff-change-modified'><div class='diff-unit-kind'>{escape(change.tailored.kind.title())}</div><div class='diff-unit-text'>{_side_word_html(change.word_changes, 'tailored')}</div></div>", unsafe_allow_html=True)


def _render_diff(diff: CVDiff, *, changes_only: bool) -> None:
    change_lookup = {change.section: change for change in diff.changes}
    sections = diff.sections if changes_only else tuple(dict.fromkeys(unit.section for unit in diff.base_units + diff.tailored_units))
    for section in sections:
        change = change_lookup.get(section)
        if changes_only and change is not None:
            base_units = change.base_units
            tailored_units = change.tailored_units
            presented = _presented_section_changes(base_units, tailored_units)
            if not presented:
                continue
            st.markdown(
                f"<div class='diff-section-heading'><h3 id='section-{escape(section.lower().replace(' ', '-'))}'>{escape(section)}</h3></div>"
                f"<div class='diff-section-summary'>{escape(_change_summary(presented))}</div>",
                unsafe_allow_html=True,
            )
            for item in presented:
                _render_presented_change(item)
            continue
        status = change.kind.upper() if change else "UNCHANGED"
        status_class = change.kind if change else "unchanged"
        st.markdown(
            f"<div class='diff-section-heading'><h3 id='section-{escape(section.lower().replace(' ', '-'))}'>{escape(section)}</h3>"
            f"<span class='diff-state diff-state-{status_class}'>{status}</span></div>",
            unsafe_allow_html=True,
        )
        base_units = change.base_units if change else tuple(unit for unit in diff.base_units if unit.section == section)
        tailored_units = change.tailored_units if change else tuple(unit for unit in diff.tailored_units if unit.section == section)
        columns = st.columns(2)
        with columns[0]:
            st.markdown("<div class='diff-side-label'>BASE CV</div>", unsafe_allow_html=True)
            _render_section_units(base_units)
        with columns[1]:
            st.markdown("<div class='diff-side-label'>TAILORED CV</div>", unsafe_allow_html=True)
            _render_section_units(tailored_units)


def render_cv_diff(client: SupabaseRestClient, user_id: str | None = None) -> None:
    raw_id = st.query_params.get("cv_version_id")
    try:
        tailored_cv_id = int(str(raw_id))
    except (TypeError, ValueError):
        st.error("A valid tailored CV was not specified.")
        return
    try:
        context = load_diff_context(client, tailored_cv_id, user_id)
    except PersistenceError as exc:
        st.title("Tailored CV Changes")
        st.error(str(exc))
        st.link_button("Back to Jobs", "?view=jobs")
        return

    diff = compare_cv_sources(context.base_source, context.tailored_source)
    job = context.job or {}
    title = f"{job.get('title', 'Tailored CV')} · {job.get('company', '')}".strip(" ·")
    st.markdown("# Tailored CV Changes")
    st.caption(title)
    st.markdown(
        f"<div class='diff-context'>Generated {escape(str(context.tailored.get('created_at', ''))[:10])} · "
        f"Base CV {escape(str(context.base.get('created_at', ''))[:10])}</div>",
        unsafe_allow_html=True,
    )
    counts = diff.counts
    presented_changes = tuple(
        item
        for change in diff.changes
        for item in _presented_section_changes(change.base_units, change.tailored_units)
    )
    page_summary = _change_summary(presented_changes)
    st.caption(f"{diff.changed_sections} sections changed" + (f" · {page_summary}" if page_summary else ""))
    st.markdown(
        "<style>"
        ".stApp{background:#0f1117;color:#f3f4f6}.block-container{max-width:1180px;padding-top:1.5rem}"
        ".diff-context,.diff-unit-kind,.diff-side-label,.diff-section-summary{color:#a8afbd;font-size:.8rem}.diff-section-heading{display:flex;align-items:center;gap:.7rem;margin-top:1.2rem}.diff-section-heading h3{margin:0;color:#f3f4f6}.diff-section-summary{margin:.15rem 0 .65rem}.diff-state{font-size:.65rem;font-weight:800;letter-spacing:.08em}.diff-change-card{background:#181b24;border:1px solid #2b3040;border-radius:10px;padding:.7rem .8rem;margin:.4rem 0}.diff-change-moved{border-left:3px solid #6c5ce7}.diff-change-added{border-left:3px solid #55cfa3}.diff-change-removed{border-left:3px solid #c97886}.diff-change-modified{border-left:3px solid #8d80ef}.diff-change-moved .diff-state{color:#afa7ff}.diff-change-added .diff-state{color:#70dfb4}.diff-change-removed .diff-state{color:#e49aa5}.diff-change-modified .diff-state{color:#afa7ff}.diff-position{color:#727b8c;font-size:.75rem;margin-top:.45rem}.diff-unit{background:#181b24;border:1px solid #2b3040;border-radius:10px;padding:.75rem;margin:.45rem 0;min-height:4.5rem}.diff-unit-text{color:#f3f4f6;line-height:1.45}.diff-added{background:rgba(46,190,125,.25);color:#8ff0c1;padding:0 .12rem}.diff-removed{background:rgba(230,85,101,.22);color:#ffacb4;text-decoration:line-through;padding:0 .12rem}.diff-empty{border:1px dashed #2b3040;border-radius:10px;color:#727b8c;padding:1.2rem;margin:.45rem 0}.diff-link{display:inline-flex;align-items:center;justify-content:center;width:1.8rem;height:1.8rem;border:1px solid #343a4a;border-radius:8px;color:#d6d9e0;text-decoration:none;background:#242936;font-size:1rem}.diff-link:hover{background:#303746;color:white}"
        "</style>",
        unsafe_allow_html=True,
    )
    controls = st.columns([1.3, 1.7, 1.7])
    with controls[0]:
        view = st.radio("View", ["Changes only", "Full CV"], horizontal=True, label_visibility="collapsed")
    with controls[1]:
        try:
            base_pdf = _compile_base_pdf(context.base_source)
        except TailoredCVError as exc:
            st.error(f"Base CV PDF could not be prepared: {exc}")
        else:
            st.download_button("Download Base CV", base_pdf, file_name="base_cv.pdf", mime="application/pdf")
    with controls[2]:
        job = context.job or {}
        st.download_button(
            "Download Tailored CV", context.tailored_pdf,
            file_name=job_pdf_filename(job.get("company"), job.get("title")),
            mime="application/pdf",
        )
    _render_diff(diff, changes_only=view == "Changes only")
