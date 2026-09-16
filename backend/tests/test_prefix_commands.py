import pytest

from ispf_backend import prefix_commands
from ispf_backend.models import Command
from ispf_backend.prefix_commands import process


@pytest.fixture(autouse=True)
def _reset_clipboard():
    # The clipboard (cut/paste) is genuine module-level state, deliberately
    # not reset by process() itself (see its docstring) — tests must not
    # leak clipboard content between each other regardless of run order.
    prefix_commands._clipboard = []
    yield
    prefix_commands._clipboard = []


def cmd(line, code):
    return Command(line=line, code=code)


def run(lines, commands, labels=None, excluded_lines=None, pending_mark=None, execute_cut=False, execute_paste=None):
    return process(
        lines, [cmd(l, c) for l, c in commands], labels, excluded_lines,
        pending_mark, execute_cut, execute_paste,
    )


def assert_ok(result, expected_lines, expected_consumed=None, expected_labels=None, expected_excluded=None, expected_pending_mark="unset"):
    assert result.errors == [], result.errors
    assert result.plan is not None
    assert result.plan.lines == expected_lines
    if expected_consumed is not None:
        assert result.plan.consumed_lines == sorted(expected_consumed)
    if expected_labels is not None:
        assert result.labels == expected_labels
    if expected_excluded is not None:
        assert result.excluded_lines == sorted(expected_excluded)
    if expected_pending_mark != "unset":
        assert result.pending_mark == expected_pending_mark


def assert_error(result, line=None, substring=None):
    assert result.plan is None
    assert result.errors, "expected at least one error"
    if line is not None:
        assert any(e.line == line for e in result.errors), result.errors
    if substring is not None:
        assert any(substring in e.message for e in result.errors), result.errors


DOC = ["one", "two", "three", "four", "five"]


def test_no_commands_is_identity():
    result = run(DOC, [])
    assert_ok(result, DOC, expected_consumed=[])


def test_delete_single_line():
    result = run(DOC, [(2, "d")])
    assert_ok(result, ["one", "three", "four", "five"], [2])


def test_delete_with_count():
    result = run(DOC, [(2, "d3")])
    assert_ok(result, ["one", "five"], [2])


def test_delete_block():
    result = run(DOC, [(2, "dd"), (4, "dd")])
    assert_ok(result, ["one", "five"], [2, 4])


def test_repeat_default():
    result = run(DOC, [(2, "r")])
    assert_ok(result, ["one", "two", "two", "three", "four", "five"], [2])


def test_repeat_with_count():
    result = run(DOC, [(2, "r2")])
    assert_ok(result, ["one", "two", "two", "two", "three", "four", "five"], [2])


def test_insert_default():
    result = run(DOC, [(2, "i")])
    assert_ok(result, ["one", "two", "", "three", "four", "five"], [2])


def test_insert_with_count():
    result = run(DOC, [(1, "i2")])
    assert_ok(result, ["one", "", "", "two", "three", "four", "five"], [1])


def test_copy_single_after():
    result = run(DOC, [(1, "c"), (3, "a")])
    assert_ok(result, ["one", "two", "three", "one", "four", "five"], [1, 3])


def test_copy_single_before():
    result = run(DOC, [(1, "c"), (3, "b")])
    assert_ok(result, ["one", "two", "one", "three", "four", "five"], [1, 3])


def test_copy_count_after():
    result = run(DOC, [(1, "c2"), (4, "a")])
    assert_ok(result, ["one", "two", "three", "four", "one", "two", "five"], [1, 4])


def test_copy_block_before():
    result = run(DOC, [(1, "cc"), (2, "cc"), (5, "b")])
    assert_ok(result, ["one", "two", "three", "four", "one", "two", "five"], [1, 2, 5])


def test_move_single_after():
    result = run(DOC, [(1, "m"), (3, "a")])
    assert_ok(result, ["two", "three", "one", "four", "five"], [1, 3])


def test_move_single_before():
    result = run(DOC, [(5, "m"), (2, "b")])
    assert_ok(result, ["one", "five", "two", "three", "four"], [2, 5])


def test_move_block():
    result = run(DOC, [(1, "mm"), (2, "mm"), (5, "a")])
    assert_ok(result, ["three", "four", "five", "one", "two"], [1, 2, 5])


def test_unknown_code():
    result = run(DOC, [(1, "zz")])
    assert_error(result, line=1, substring="unknown line command")


def test_unmatched_dd():
    result = run(DOC, [(2, "dd")])
    assert_error(result, line=2, substring="unmatched 'dd'")


def test_cc_block_with_no_destination_becomes_a_pending_mark_not_an_error():
    # A valid cc-block source (properly closed by a second `cc`) with no
    # a/b destination doesn't error — it becomes a pending copy mark, only
    # resolved later by an explicit CUT primary command (execute_cut=True;
    # see the execute_cut/pending_mark tests below). The document and
    # clipboard are both untouched until that happens.
    result = run(DOC, [(1, "cc"), (2, "cc")])
    assert_ok(result, DOC, expected_pending_mark={"kind": "copy", "start": 1, "end": 2})
    assert prefix_commands._clipboard == []


def test_orphan_destination_marker_is_an_error():
    # Unchanged from the original design: a lone a/b with no pending
    # copy/move source is an error — PASTE (a primary command) is the
    # only route to the clipboard's destination side, and it doesn't use
    # a/b at all.
    result = run(DOC, [(3, "a")])
    assert_error(result, line=3, substring="no pending copy or move")


def test_second_source_before_destination():
    result = run(DOC, [(1, "c"), (2, "c"), (4, "a")])
    assert_error(result, line=2, substring="pending")


def test_destination_inside_own_source_range():
    result = run(DOC, [(1, "c3"), (2, "a")])
    assert_error(result, line=2, substring="falls inside its own source range")


def test_duplicate_line_in_batch():
    result = run(DOC, [(1, "d"), (1, "r")])
    assert_error(result, line=1, substring="more than once")


def test_line_out_of_range():
    result = run(DOC, [(99, "d")])
    assert_error(result, line=99, substring="out of range")


def test_range_extends_past_end_of_file():
    result = run(DOC, [(4, "d5")])
    assert_error(result, line=4, substring="extends past the end of the file")


def test_range_command_collides_with_separate_line_command():
    result = run(DOC, [(1, "d3"), (2, "r")])
    assert_error(result, line=2, substring="cannot also fall inside")


def test_repeat_count_zero_is_invalid():
    result = run(DOC, [(1, "d0")])
    assert_error(result, line=1, substring="at least 1")


def test_destination_without_repeat_count_rejected():
    result = run(DOC, [(1, "c"), (3, "a5")])
    assert_error(result, line=3, substring="unknown line command")


def test_case_insensitive_codes():
    result = run(DOC, [(1, "C"), (3, "A")])
    assert_ok(result, ["one", "two", "three", "one", "four", "five"], [1, 3])


def test_blank_codes_are_ignored():
    result = run(DOC, [(1, ""), (2, "   ")])
    assert_ok(result, DOC, [])


def test_combined_operations_in_one_batch():
    # delete line 5, repeat line 1, and move line 3 to before line 2 —
    # none of the ranges overlap so this should all apply together.
    result = run(DOC, [(5, "d"), (1, "r"), (3, "m"), (2, "b")])
    assert_ok(result, ["one", "one", "three", "two", "four"], [1, 2, 3, 5])


def test_label_set_persists_and_is_consumed_from_the_gutter():
    result = run(DOC, [(2, ".a")])
    assert_ok(result, DOC, expected_consumed=[2], expected_labels={"A": 2})


def test_label_clear():
    result = run(DOC, [(2, ".")], labels={"A": 2})
    assert_ok(result, DOC, expected_consumed=[2], expected_labels={})


def test_label_clear_when_nothing_set_is_a_noop():
    result = run(DOC, [(2, ".")])
    assert_ok(result, DOC, expected_labels={})


def test_label_reassigned_moves_off_old_line():
    result = run(DOC, [(4, ".a")], labels={"A": 2})
    assert_ok(result, DOC, expected_labels={"A": 4})


def test_label_reserved_z_name_rejected():
    result = run(DOC, [(2, ".zfirst")])
    assert_error(result, line=2, substring="reserved")


def test_label_name_must_start_with_a_letter():
    result = run(DOC, [(2, ".1abc")])
    assert_error(result, line=2, substring="unknown line command")


def test_label_duplicate_name_in_one_batch():
    result = run(DOC, [(1, ".a"), (2, ".a")])
    assert_error(result, line=2, substring="more than one line")


def test_label_case_insensitive_and_uppercased():
    result = run(DOC, [(1, ".fOo")])
    assert_ok(result, DOC, expected_labels={"FOO": 1})


def test_label_follows_a_moved_line():
    result = run(DOC, [(1, "m"), (3, "a")], labels={"A": 1})
    assert_ok(result, ["two", "three", "one", "four", "five"], expected_labels={"A": 3})


def test_label_dropped_when_its_line_is_deleted():
    result = run(DOC, [(2, "d")], labels={"A": 2})
    assert_ok(result, ["one", "three", "four", "five"], expected_labels={})


def test_label_shifts_when_lines_are_inserted_above_it():
    result = run(DOC, [(1, "i2")], labels={"A": 3})
    assert_ok(result, ["one", "", "", "two", "three", "four", "five"], expected_labels={"A": 5})


def test_label_shifts_when_an_earlier_line_is_deleted():
    result = run(DOC, [(2, "d")], labels={"A": 4})
    assert_ok(result, ["one", "three", "four", "five"], expected_labels={"A": 3})


def test_label_on_copy_source_is_unaffected_by_the_copy():
    result = run(DOC, [(1, "c"), (3, "a")], labels={"A": 1})
    assert_ok(result, ["one", "two", "three", "one", "four", "five"], expected_labels={"A": 1})


def test_exclude_single_line():
    result = run(DOC, [(2, "x")])
    assert_ok(result, DOC, expected_consumed=[2], expected_excluded=[2])


def test_exclude_with_count():
    result = run(DOC, [(2, "x3")])
    assert_ok(result, DOC, expected_excluded=[2, 3, 4])


def test_exclude_block():
    result = run(DOC, [(2, "xx"), (4, "xx")])
    assert_ok(result, DOC, expected_consumed=[2, 4], expected_excluded=[2, 3, 4])


def test_exclude_unmatched_xx():
    result = run(DOC, [(2, "xx")])
    assert_error(result, line=2, substring="unmatched 'xx'")


def test_exclude_accumulates_with_already_excluded_lines():
    result = run(DOC, [(4, "x")], excluded_lines=[1])
    assert_ok(result, DOC, expected_excluded=[1, 4])


def test_exclude_follows_a_moved_line():
    result = run(DOC, [(1, "m"), (3, "a")], excluded_lines=[1])
    assert_ok(result, ["two", "three", "one", "four", "five"], expected_excluded=[3])


def test_exclude_dropped_when_its_line_is_deleted():
    result = run(DOC, [(2, "d")], excluded_lines=[2])
    assert_ok(result, ["one", "three", "four", "five"], expected_excluded=[])


def test_exclude_shifts_when_an_earlier_line_is_deleted():
    result = run(DOC, [(2, "d")], excluded_lines=[4])
    assert_ok(result, ["one", "three", "four", "five"], expected_excluded=[3])


def test_exclude_line_cannot_also_fall_inside_another_commands_range():
    result = run(DOC, [(1, "d3"), (2, "x")])
    assert_error(result, line=2, substring="cannot also fall inside")


def test_exclude_range_extends_past_end_of_file():
    result = run(DOC, [(4, "x5")])
    assert_error(result, line=4, substring="extends past the end of the file")


def test_exclude_and_label_are_independent_in_the_same_batch():
    result = run(DOC, [(2, "x"), (3, ".a")])
    assert_ok(result, DOC, expected_excluded=[2], expected_labels={"A": 3})


def test_shift_right_default_width():
    result = run(["abc", "def"], [(1, ")")])
    assert_ok(result, ["  abc", "def"])


def test_shift_right_explicit_column_count():
    result = run(["abc", "def"], [(1, ")5")])
    assert_ok(result, ["     abc", "def"])


def test_shift_left_removes_leading_blanks():
    result = run(["  abc", "def"], [(1, "(")])
    assert_ok(result, ["abc", "def"])


def test_shift_left_can_truncate_non_blank_characters():
    result = run(["abcdef", "x"], [(1, "(")])
    assert_ok(result, ["cdef", "x"])


def test_shift_left_past_the_lines_length_yields_empty_not_an_error():
    result = run(["ab", "x"], [(1, "(5")])
    assert_ok(result, ["", "x"])


def test_shift_triple_character_is_unknown_command():
    # There's no 3+ repeated-character form — only a bare char (default
    # width), an explicit count (`)n`), or the doubled BLOCK form (`))`).
    result = run(DOC, [(1, ")))")])
    assert_error(result, line=1, substring="unknown line command")


def test_shift_angle_bracket_is_not_a_column_shift_alias():
    # Real ISPF's `<`/`>` are a different command entirely (Data Shift,
    # not Column Shift) that this project doesn't implement — see the
    # module docstring. They're plain unknown commands here, not aliases
    # of `(`/`)`.
    result = run(["abc"], [(1, "<")])
    assert_error(result, line=1, substring="unknown line command")


def test_shift_amount_zero_rejected():
    result = run(DOC, [(1, ")0")])
    assert_error(result, line=1, substring="at least 1")


def test_shift_does_not_move_or_drop_a_label_on_the_line():
    result = run(["abc", "def"], [(1, ")")], labels={"A": 1})
    assert_ok(result, ["  abc", "def"], expected_labels={"A": 1})


def test_shift_block_right_default_width():
    result = run(["a", "b", "c"], [(1, "))"), (3, "))")])
    assert_ok(result, ["  a", "  b", "  c"])


def test_shift_block_left_default_width():
    result = run(["  a", "  b", "  c"], [(1, "(("), (3, "((")])
    assert_ok(result, ["a", "b", "c"])


def test_shift_block_right_explicit_count_on_opening_marker():
    result = run(["a", "b"], [(1, "))3"), (2, "))")])
    assert_ok(result, ["   a", "   b"])


def test_shift_block_right_explicit_count_on_closing_marker():
    result = run(["a", "b"], [(1, "))"), (2, "))3")])
    assert_ok(result, ["   a", "   b"])


def test_shift_block_right_closing_count_wins_over_opening():
    result = run(["a", "b"], [(1, "))5"), (2, "))3")])
    assert_ok(result, ["   a", "   b"])


def test_shift_block_unmatched_is_an_error():
    result = run(DOC, [(1, "))")])
    assert_error(result, line=1, substring="unmatched '))'")


def test_shift_block_left_unmatched_is_an_error():
    result = run(DOC, [(1, "((")])
    assert_error(result, line=1, substring="unmatched '(('")


def test_shift_block_does_not_move_or_drop_labels():
    result = run(["a", "b", "c"], [(1, "))"), (3, "))")], labels={"X": 2})
    assert_ok(result, ["  a", "  b", "  c"], expected_labels={"X": 2})


def test_shift_block_overlapping_another_line_command_is_an_error():
    result = run(["a", "b", "c"], [(1, "))"), (2, "d"), (3, "))")])
    assert_error(result, line=2, substring="has its own line command")


def test_shift_malformed_code_is_unknown_command():
    result = run(DOC, [(1, "()")])
    assert_error(result, line=1, substring="unknown line command")


def test_repeat_block_default_once():
    result = run(DOC, [(2, "rr"), (3, "rr")])
    assert_ok(result, ["one", "two", "three", "two", "three", "four", "five"])


def test_repeat_block_count_on_opening_marker():
    result = run(DOC, [(2, "rr2"), (3, "rr")])
    assert_ok(result, ["one", "two", "three", "two", "three", "two", "three", "four", "five"])


def test_repeat_block_count_on_closing_marker():
    result = run(DOC, [(2, "rr"), (3, "rr3")])
    assert_ok(result, [
        "one", "two", "three", "two", "three", "two", "three", "two", "three", "four", "five",
    ])


def test_repeat_block_unmatched():
    result = run(DOC, [(2, "rr")])
    assert_error(result, line=2, substring="unmatched 'rr'")


def test_repeat_block_preserves_a_label_on_the_original_block():
    result = run(DOC, [(2, "rr"), (3, "rr")], labels={"A": 2})
    assert_ok(result, ["one", "two", "three", "two", "three", "four", "five"], expected_labels={"A": 2})


def test_uc_single_line():
    result = run(["abc", "def"], [(1, "uc")])
    assert_ok(result, ["ABC", "def"])


def test_lc_single_line():
    result = run(["ABC", "DEF"], [(1, "lc")])
    assert_ok(result, ["abc", "DEF"])


def test_uc_block_range():
    result = run(["abc", "def", "ghi"], [(1, "uc"), (3, "uc")])
    assert_ok(result, ["ABC", "DEF", "GHI"])


def test_uc_too_many_markers_is_ambiguous():
    result = run(DOC, [(1, "uc"), (2, "uc"), (3, "uc")])
    assert_error(result, line=1, substring="can mark at most one line or a two-line range")


def test_uc_code_is_case_insensitive():
    result = run(["abc"], [(1, "UC")])
    assert_ok(result, ["ABC"])


def test_uc_and_lc_are_independent_in_the_same_batch():
    result = run(["abc", "DEF"], [(1, "uc"), (2, "lc")])
    assert_ok(result, ["ABC", "def"])


def test_uc_does_not_affect_a_label_on_the_line():
    result = run(["abc", "def"], [(1, "uc")], labels={"A": 1})
    assert_ok(result, ["ABC", "def"], expected_labels={"A": 1})


def test_c_alone_becomes_a_pending_copy_mark():
    result = run(DOC, [(2, "c")])
    assert_ok(result, DOC, expected_pending_mark={"kind": "copy", "start": 2, "end": 2})
    assert prefix_commands._clipboard == []


def test_m_alone_becomes_a_pending_move_mark_without_removing_the_line_yet():
    result = run(DOC, [(2, "m")])
    assert_ok(result, DOC, expected_pending_mark={"kind": "move", "start": 2, "end": 2})
    assert prefix_commands._clipboard == []


def test_mm_block_alone_becomes_a_pending_move_mark():
    result = run(DOC, [(2, "mm"), (4, "mm")])
    assert_ok(result, DOC, expected_pending_mark={"kind": "move", "start": 2, "end": 4})


def test_setting_a_new_mark_while_one_is_already_pending_is_an_error():
    result = run(DOC, [(2, "c")], pending_mark={"kind": "copy", "start": 5, "end": 5})
    assert_error(result, line=2, substring="already pending")


def test_paired_c_plus_a_in_file_copy_coexists_with_an_unpaired_m_mark_in_one_batch():
    # Line 1's `c` pairs with line 3's `a` — an immediate, ordinary in-file
    # copy, completely unrelated to the clipboard. Line 5's `m` has no
    # pairing of its own, so it becomes a pending mark instead — both in
    # the same batch, independently. Since the copy inserts a new line,
    # line 5's mark is correctly remapped to its new position (6).
    result = run(DOC, [(1, "c"), (3, "a"), (5, "m")])
    assert_ok(result, ["one", "two", "three", "one", "four", "five"],
              expected_pending_mark={"kind": "move", "start": 6, "end": 6})
    assert prefix_commands._clipboard == []


def test_execute_cut_with_copy_mark_copies_non_destructively():
    result = run(DOC, [], pending_mark={"kind": "copy", "start": 2, "end": 2}, execute_cut=True)
    assert_ok(result, DOC, expected_pending_mark=None)
    assert prefix_commands._clipboard == ["two"]


def test_execute_cut_with_move_mark_removes_and_stores():
    result = run(DOC, [], pending_mark={"kind": "move", "start": 2, "end": 2}, execute_cut=True)
    assert_ok(result, ["one", "three", "four", "five"], expected_pending_mark=None)
    assert prefix_commands._clipboard == ["two"]


def test_execute_cut_with_a_block_mark():
    result = run(DOC, [], pending_mark={"kind": "move", "start": 2, "end": 4}, execute_cut=True)
    assert_ok(result, ["one", "five"], expected_pending_mark=None)
    assert prefix_commands._clipboard == ["two", "three", "four"]


def test_execute_cut_with_no_pending_mark_is_an_error():
    result = run(DOC, [], execute_cut=True)
    assert_error(result, substring="nothing marked for cut")


def test_execute_paste_after():
    prefix_commands._clipboard = ["X"]
    result = run(DOC, [], execute_paste={"line": 1, "before": False})
    assert_ok(result, ["one", "X", "two", "three", "four", "five"])


def test_execute_paste_before():
    prefix_commands._clipboard = ["X"]
    result = run(DOC, [], execute_paste={"line": 1, "before": True})
    assert_ok(result, ["X", "one", "two", "three", "four", "five"])


def test_execute_paste_with_empty_clipboard_is_an_error():
    result = run(DOC, [], execute_paste={"line": 1, "before": False})
    assert_error(result, line=1, substring="clipboard is empty")


def test_execute_paste_does_not_consume_the_clipboard():
    prefix_commands._clipboard = ["X"]
    run(DOC, [], execute_paste={"line": 1, "before": False})
    assert prefix_commands._clipboard == ["X"]
    result = run(DOC, [], execute_paste={"line": 5, "before": False})
    assert_ok(result, ["one", "two", "three", "four", "five", "X"])


def test_execute_cut_then_execute_paste_across_different_documents():
    # The whole point of the redesign: mark+CUT in one file, PASTE in a
    # completely different one.
    mark_result = run(["fileA-1", "fileA-2"], [(1, "m")])
    cut_result = run(mark_result.plan.lines, [], pending_mark=mark_result.pending_mark, execute_cut=True)
    assert cut_result.pending_mark is None
    assert prefix_commands._clipboard == ["fileA-1"]

    paste_result = run(["fileB-1", "fileB-2"], [], execute_paste={"line": 2, "before": False})
    assert_ok(paste_result, ["fileB-1", "fileB-2", "fileA-1"])


def test_pending_mark_is_remapped_through_a_later_unrelated_batch():
    mark_result = run(DOC, [(5, "c")])
    result = run(DOC, [(2, "d")], pending_mark=mark_result.pending_mark)
    assert_ok(result, ["one", "three", "four", "five"], expected_pending_mark={"kind": "copy", "start": 4, "end": 4})


def test_pending_mark_dropped_when_its_line_is_deleted():
    mark_result = run(DOC, [(2, "c")])
    result = run(DOC, [(2, "d")], pending_mark=mark_result.pending_mark)
    assert_ok(result, ["one", "three", "four", "five"], expected_pending_mark=None)


def test_a_rejected_batch_does_not_commit_a_cut_to_the_clipboard():
    prefix_commands._clipboard = ["preexisting"]
    result = run(DOC, [(99, "d")], pending_mark={"kind": "move", "start": 2, "end": 2}, execute_cut=True)
    assert result.errors
    assert prefix_commands._clipboard == ["preexisting"]
