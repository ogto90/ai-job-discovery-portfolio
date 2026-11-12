from matching.tailored_cv_diff import CVTextUnit
from ui.cv_diff import _change_summary, _presented_section_changes


def _units(*texts: str) -> tuple[CVTextUnit, ...]:
    return tuple(CVTextUnit("Experience", text, "bullet", index) for index, text in enumerate(texts))


def test_inserted_item_does_not_create_false_moves():
    changes = _presented_section_changes(_units("A", "B", "C", "D"), _units("X", "A", "B", "C", "D"))

    assert [(change.kind, change.tailored.text, change.tailored_position) for change in changes] == [("added", "X", 1)]


def test_moved_item_is_presented_once_with_one_based_positions():
    changes = _presented_section_changes(_units("A", "B", "C", "D"), _units("A", "D", "B", "C"))

    assert len(changes) == 1
    assert changes[0].kind == "moved"
    assert changes[0].base.text == changes[0].tailored.text == "D"
    assert changes[0].base_position == 4
    assert changes[0].tailored_position == 2


def test_rewrite_is_modified_and_has_word_level_changes():
    changes = _presented_section_changes(
        _units("Integrated security tooling into development workflows."),
        _units("Integrated Coverity SAST and Black Duck SCA into CI/CD development workflows."),
    )

    assert len(changes) == 1
    assert changes[0].kind == "modified"
    assert ("removed", "security tooling") in changes[0].word_changes
    assert ("added", "Coverity SAST and Black Duck SCA") in changes[0].word_changes


def test_added_and_removed_items_are_one_sided():
    removed = _presented_section_changes(_units("A", "B", "C"), _units("A", "C"))
    added = _presented_section_changes(_units("A"), _units("A", "X"))

    assert [(change.kind, change.base.text) for change in removed] == [("removed", "B")]
    assert [(change.kind, change.tailored.text) for change in added] == [("added", "X")]


def test_summary_counts_only_presented_changes():
    changes = _presented_section_changes(_units("A", "B", "C", "D"), _units("X", "A", "D", "B", "C"))

    assert _change_summary(changes) == "1 moved · 1 added"
