from ispf_backend.models import Command
from ispf_backend.prefix_commands import process


def cmd(line, code):
    return Command(line=line, code=code)


def run(lines, commands, labels=None, excluded_lines=None):
    return process(lines, [cmd(l, c) for l, c in commands], labels, excluded_lines)


def assert_ok(result, expected_lines, expected_consumed=None, expected_labels=None, expected_excluded=None):
    assert result.errors == [], result.errors
    assert result.plan is not None
    assert result.plan.lines == expected_lines
    if expected_consumed is not None:
        assert result.plan.consumed_lines == sorted(expected_consumed)
    if expected_labels is not None:
        assert result.labels == expected_labels
    if expected_excluded is not None:
        assert result.excluded_lines == sorted(expected_excluded)


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


def test_unmatched_cc_block_no_destination():
    result = run(DOC, [(1, "cc"), (2, "cc")])
    assert_error(result, line=1, substring="has no destination marker")


def test_orphan_destination_marker():
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


def test_shift_right_double_is_twice_the_default_width():
    result = run(["abc", "def"], [(1, "))")])
    assert_ok(result, ["    abc", "def"])


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
    result = run(["ab", "x"], [(1, "(((")])
    assert_ok(result, ["", "x"])


def test_shift_angle_bracket_left_is_an_alias_for_parenthesis():
    result = run(["abc"], [(1, "<")])
    assert_ok(result, ["c"])


def test_shift_angle_bracket_right_double():
    result = run(["abc"], [(1, ">>")])
    assert_ok(result, ["    abc"])


def test_shift_amount_zero_rejected():
    result = run(DOC, [(1, ")0")])
    assert_error(result, line=1, substring="at least 1")


def test_shift_does_not_move_or_drop_a_label_on_the_line():
    result = run(["abc", "def"], [(1, ")")], labels={"A": 1})
    assert_ok(result, ["  abc", "def"], expected_labels={"A": 1})


def test_shift_malformed_code_is_unknown_command():
    result = run(DOC, [(1, "()")])
    assert_error(result, line=1, substring="unknown line command")
