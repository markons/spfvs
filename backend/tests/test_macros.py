from pathlib import Path

from ispf_backend.macros import EditContext, MacroError, run_macro


def write_macro(tmp_path: Path, source: str) -> str:
    path = tmp_path / "test_macro.py"
    path.write_text(source, encoding="utf-8")
    return str(path)


# --- EditContext, in isolation -------------------------------------------

def test_edit_context_basic_properties():
    ctx = EditContext(["a", "b", "c"], cursor_line=2)
    assert ctx.line_count == 3
    assert ctx.first_line == 1
    assert ctx.last_line == 3
    assert ctx.cursor_line == 2


def test_edit_context_clamps_an_out_of_range_initial_cursor():
    assert EditContext(["a", "b"], cursor_line=99).cursor_line == 2
    assert EditContext(["a", "b"], cursor_line=0).cursor_line == 1


def test_edit_context_get_set_line():
    ctx = EditContext(["a", "b"], cursor_line=1)
    assert ctx.get_line(2) == "b"
    ctx.set_line(2, "B")
    assert ctx.get_line(2) == "B"
    assert ctx.result_lines() == ["a", "B"]


def test_edit_context_change_line_is_an_alias_for_set_line():
    ctx = EditContext(["a"], cursor_line=1)
    ctx.change_line(1, "A")
    assert ctx.result_lines() == ["A"]


def test_edit_context_out_of_range_line_raises_macro_error():
    ctx = EditContext(["a"], cursor_line=1)
    for bad in (0, 2):
        try:
            ctx.get_line(bad)
            assert False, "expected MacroError"
        except MacroError:
            pass


def test_edit_context_cursor_line_setter_validates_range():
    ctx = EditContext(["a", "b"], cursor_line=1)
    ctx.cursor_line = 2
    assert ctx.cursor_line == 2
    try:
        ctx.cursor_line = 3
        assert False, "expected MacroError"
    except MacroError:
        pass


def test_edit_context_find_all_is_a_snapshot():
    ctx = EditContext(["TODO 1", "nothing", "TODO 2"], cursor_line=1)
    matches = ctx.find_all("TODO")
    assert [m.line for m in matches] == [1, 3]
    assert [m.text for m in matches] == ["TODO 1", "TODO 2"]
    ctx.set_line(1, "changed")
    # The already-returned match list still reflects the pre-mutation text
    # (see find_all's own docstring) — re-calling it picks up the change.
    assert matches[0].text == "TODO 1"
    assert [m.line for m in ctx.find_all("TODO")] == [3]


def test_edit_context_message_log():
    ctx = EditContext(["a"], cursor_line=1)
    ctx.message("hello")
    ctx.message(42)
    assert ctx.messages == ["hello", "42"]


def test_edit_context_resolve_label_known_name():
    ctx = EditContext(["a", "b", "c"], cursor_line=1, labels={"FOO": 2})
    assert ctx.resolve_label("FOO") == 2


def test_edit_context_resolve_label_accepts_lowercase_and_leading_dot():
    ctx = EditContext(["a", "b", "c"], cursor_line=1, labels={"FOO": 2})
    assert ctx.resolve_label(".foo") == 2
    assert ctx.resolve_label("foo") == 2
    assert ctx.resolve_label(".FOO") == 2


def test_edit_context_resolve_label_unknown_returns_none():
    ctx = EditContext(["a"], cursor_line=1, labels={"FOO": 1})
    assert ctx.resolve_label("BAR") is None


def test_edit_context_resolve_label_with_no_labels_at_all():
    ctx = EditContext(["a"], cursor_line=1)
    assert ctx.resolve_label("FOO") is None


def test_edit_context_resolve_label_reserved_names():
    ctx = EditContext(["a", "b", "c"], cursor_line=2, labels={})
    assert ctx.resolve_label(".ZFIRST") == 1
    assert ctx.resolve_label(".ZLAST") == 3
    assert ctx.resolve_label(".ZCSR") == 2


def test_edit_context_resolve_label_zcsr_tracks_cursor_line_changes():
    ctx = EditContext(["a", "b", "c"], cursor_line=1)
    ctx.cursor_line = 3
    assert ctx.resolve_label(".ZCSR") == 3


def test_edit_context_resolve_label_reserved_names_are_not_overridable_by_a_real_label():
    # A label literally named "ZFIRST" can't exist anyway (LABEL rejects
    # names starting with 'Z' as reserved — see prefix_commands.py), but
    # resolve_label() checks the reserved names FIRST regardless, so it
    # can never be shadowed even if a stale/malformed labels dict had one.
    ctx = EditContext(["a", "b"], cursor_line=1, labels={"ZFIRST": 2})
    assert ctx.resolve_label(".ZFIRST") == 1


def test_set_label_assigns_a_name_folded_to_uppercase():
    ctx = EditContext(["a", "b"], cursor_line=1)
    ctx.set_label(".foo", 2)
    assert ctx.resolve_label("FOO") == 2
    assert ctx.result_labels() == {"FOO": 2}


def test_set_label_accepts_name_without_leading_dot():
    ctx = EditContext(["a", "b"], cursor_line=1)
    ctx.set_label("foo", 1)
    assert ctx.resolve_label(".FOO") == 1


def test_set_label_rejects_invalid_format():
    ctx = EditContext(["a"], cursor_line=1)
    for bad in ("1abc", "", "toolongname", "a b"):
        try:
            ctx.set_label(bad, 1)
            assert False, f"expected MacroError for {bad!r}"
        except MacroError:
            pass


def test_set_label_rejects_reserved_z_names():
    ctx = EditContext(["a"], cursor_line=1)
    try:
        ctx.set_label("ZFOO", 1)
        assert False, "expected MacroError"
    except MacroError:
        pass


def test_set_label_out_of_range_line_raises_macro_error():
    ctx = EditContext(["a"], cursor_line=1)
    try:
        ctx.set_label("FOO", 5)
        assert False, "expected MacroError"
    except MacroError:
        pass


def test_set_label_replaces_any_existing_label_on_the_same_line():
    ctx = EditContext(["a", "b"], cursor_line=1, labels={"OLD": 2})
    ctx.set_label("NEW", 2)
    assert ctx.result_labels() == {"NEW": 2}


def test_set_label_can_move_an_existing_name_to_a_different_line():
    ctx = EditContext(["a", "b", "c"], cursor_line=1, labels={"FOO": 1})
    ctx.set_label("FOO", 3)
    assert ctx.result_labels() == {"FOO": 3}


def test_clear_label_removes_an_existing_label():
    ctx = EditContext(["a", "b"], cursor_line=1, labels={"FOO": 2})
    ctx.clear_label("FOO")
    assert ctx.result_labels() == {}


def test_clear_label_accepts_leading_dot_and_lowercase():
    ctx = EditContext(["a"], cursor_line=1, labels={"FOO": 1})
    ctx.clear_label(".foo")
    assert ctx.result_labels() == {}


def test_clear_label_is_a_no_op_when_the_label_is_not_set():
    ctx = EditContext(["a"], cursor_line=1)
    ctx.clear_label("FOO")  # must not raise
    assert ctx.result_labels() == {}


# --- EditContext insert/delete ---------------------------------------------

def test_insert_after_appends_using_last_line():
    ctx = EditContext(["a", "b"], cursor_line=1)
    ctx.insert_after(ctx.last_line, "c")
    assert ctx.result_lines() == ["a", "b", "c"]
    assert ctx.line_count == 3


def test_insert_after_in_the_middle():
    ctx = EditContext(["a", "b", "c"], cursor_line=1)
    ctx.insert_after(1, "X")
    assert ctx.result_lines() == ["a", "X", "b", "c"]


def test_insert_before_prepends_using_first_line():
    ctx = EditContext(["a", "b"], cursor_line=1)
    ctx.insert_before(ctx.first_line, "z")
    assert ctx.result_lines() == ["z", "a", "b"]


def test_insert_before_in_the_middle():
    ctx = EditContext(["a", "b", "c"], cursor_line=1)
    ctx.insert_before(3, "X")
    assert ctx.result_lines() == ["a", "b", "X", "c"]


def test_insert_out_of_range_raises_macro_error():
    ctx = EditContext(["a"], cursor_line=1)
    for bad in (0, 2):
        try:
            ctx.insert_after(bad, "x")
            assert False, "expected MacroError"
        except MacroError:
            pass


def test_delete_line_removes_and_shifts():
    ctx = EditContext(["a", "b", "c"], cursor_line=1)
    ctx.delete_line(2)
    assert ctx.result_lines() == ["a", "c"]
    assert ctx.line_count == 2


def test_delete_lines_removes_an_inclusive_range():
    ctx = EditContext(["a", "b", "c", "d", "e"], cursor_line=1)
    ctx.delete_lines(2, 4)
    assert ctx.result_lines() == ["a", "e"]


def test_delete_lines_end_before_start_raises_macro_error():
    ctx = EditContext(["a", "b", "c"], cursor_line=1)
    try:
        ctx.delete_lines(3, 1)
        assert False, "expected MacroError"
    except MacroError:
        pass


def test_delete_out_of_range_raises_macro_error():
    ctx = EditContext(["a"], cursor_line=1)
    try:
        ctx.delete_line(5)
        assert False, "expected MacroError"
    except MacroError:
        pass


def test_cursor_line_is_clamped_after_a_delete_shrinks_past_it():
    ctx = EditContext(["a", "b", "c", "d", "e"], cursor_line=5)
    ctx.delete_lines(3, 5)
    assert ctx.line_count == 2
    assert ctx.cursor_line == 2


def test_cursor_line_is_unaffected_by_a_delete_that_does_not_reach_it():
    ctx = EditContext(["a", "b", "c", "d"], cursor_line=2)
    ctx.delete_line(4)
    assert ctx.cursor_line == 2


def test_insert_does_not_disturb_a_cursor_line_still_in_range():
    ctx = EditContext(["a", "b"], cursor_line=1)
    ctx.insert_after(2, "c")
    assert ctx.cursor_line == 1


def test_copy_line_via_composition_get_line_plus_insert_after():
    # No dedicated copy method — get_line + insert_after does it.
    ctx = EditContext(["a", "b", "c"], cursor_line=1)
    ctx.insert_after(3, ctx.get_line(1))
    assert ctx.result_lines() == ["a", "b", "c", "a"]


def test_move_line_via_composition_insert_then_delete():
    # No dedicated move method — insert at the destination, then
    # delete the (now-shifted, if after the source) original.
    ctx = EditContext(["a", "b", "c"], cursor_line=1)
    text = ctx.get_line(1)
    ctx.insert_after(3, text)
    ctx.delete_line(1)
    assert ctx.result_lines() == ["b", "c", "a"]


# --- label remapping through insert/delete ---------------------------------

def test_insert_after_shifts_a_label_at_or_after_the_new_line():
    ctx = EditContext(["a", "b", "c"], cursor_line=1, labels={"FOO": 2, "BAR": 1})
    ctx.insert_after(1, "X")  # new line becomes line 2
    assert ctx.result_labels() == {"FOO": 3, "BAR": 1}


def test_insert_before_shifts_a_label_at_or_after_the_new_line():
    ctx = EditContext(["a", "b", "c"], cursor_line=1, labels={"FOO": 2, "BAR": 1})
    ctx.insert_before(2, "X")  # new line becomes line 2, pushing FOO to 3
    assert ctx.result_labels() == {"FOO": 3, "BAR": 1}


def test_delete_line_drops_a_label_on_the_deleted_line():
    ctx = EditContext(["a", "b", "c"], cursor_line=1, labels={"FOO": 2})
    ctx.delete_line(2)
    assert ctx.result_labels() == {}


def test_delete_line_shifts_a_label_after_the_deleted_line():
    ctx = EditContext(["a", "b", "c"], cursor_line=1, labels={"FOO": 3})
    ctx.delete_line(1)
    assert ctx.result_labels() == {"FOO": 2}


def test_delete_lines_drops_labels_inside_the_range_and_shifts_ones_after():
    ctx = EditContext(
        ["a", "b", "c", "d", "e"], cursor_line=1,
        labels={"BEFORE": 1, "INSIDE": 3, "AFTER": 5},
    )
    ctx.delete_lines(2, 4)
    assert ctx.result_labels() == {"BEFORE": 1, "AFTER": 2}


def test_label_before_an_insert_or_delete_is_unaffected():
    ctx = EditContext(["a", "b", "c"], cursor_line=1, labels={"FOO": 1})
    ctx.insert_after(2, "X")
    ctx.delete_line(3)
    assert ctx.result_labels() == {"FOO": 1}


# --- run_macro(), end to end ----------------------------------------------

def test_run_macro_applies_line_changes_and_returns_cursor(tmp_path):
    source = """
def run(ctx, args):
    ctx.set_line(1, ctx.get_line(1).upper())
    ctx.cursor_line = 2
"""
    result = run_macro(write_macro(tmp_path, source), ["abc", "def"], 1, [])
    assert result.ok
    assert result.lines == ["ABC", "def"]
    assert result.cursor_line == 2


def test_run_macro_captures_ctx_message_and_print(tmp_path):
    source = """
def run(ctx, args):
    ctx.message("from message()")
    print("from print()")
"""
    result = run_macro(write_macro(tmp_path, source), ["a"], 1, [])
    assert result.ok
    assert "from message()" in result.message
    assert "from print()" in result.message


def test_run_macro_receives_args(tmp_path):
    source = """
def run(ctx, args):
    ctx.message(",".join(args))
"""
    result = run_macro(write_macro(tmp_path, source), ["a"], 1, ["x", "y"])
    assert result.ok
    assert result.message == "x,y"


def test_run_macro_passes_labels_through_for_resolve_label(tmp_path):
    source = """
def run(ctx, args):
    ctx.message(str(ctx.resolve_label("FOO")))
"""
    result = run_macro(write_macro(tmp_path, source), ["a", "b"], 1, [], labels={"FOO": 2})
    assert result.ok
    assert result.message == "2"


def test_run_macro_without_labels_argument_still_works(tmp_path):
    # labels is optional (defaults to {}) — a macro that never resolves
    # a label shouldn't require the caller to pass one.
    source = """
def run(ctx, args):
    ctx.message(str(ctx.resolve_label("FOO")))
"""
    result = run_macro(write_macro(tmp_path, source), ["a"], 1, [])
    assert result.ok
    assert result.message == "None"


def test_run_macro_result_reflects_set_label_and_clear_label(tmp_path):
    source = """
def run(ctx, args):
    ctx.set_label("NEW", 2)
    ctx.clear_label("OLD")
"""
    result = run_macro(
        write_macro(tmp_path, source), ["a", "b"], 1, [], labels={"OLD": 1}
    )
    assert result.ok
    assert result.labels == {"NEW": 2}


def test_run_macro_result_labels_reflect_remapping_through_a_delete(tmp_path):
    source = """
def run(ctx, args):
    ctx.delete_line(1)
"""
    result = run_macro(
        write_macro(tmp_path, source), ["a", "b"], 1, [], labels={"FOO": 2}
    )
    assert result.ok
    assert result.labels == {"FOO": 1}


def test_run_macro_missing_file_is_a_reported_error(tmp_path):
    result = run_macro(str(tmp_path / "does_not_exist.py"), ["a"], 1, [])
    assert not result.ok
    assert "could not read" in result.error


def test_run_macro_without_a_run_function_is_a_reported_error(tmp_path):
    result = run_macro(write_macro(tmp_path, "x = 1\n"), ["a"], 1, [])
    assert not result.ok
    assert "no run(ctx, args)" in result.error


def test_run_macro_syntax_error_is_a_reported_error(tmp_path):
    result = run_macro(write_macro(tmp_path, "def run(:\n"), ["a"], 1, [])
    assert not result.ok
    assert "failed to load" in result.error


def test_run_macro_exception_inside_run_is_a_reported_error(tmp_path):
    source = """
def run(ctx, args):
    raise ValueError("boom")
"""
    result = run_macro(write_macro(tmp_path, source), ["a"], 1, [])
    assert not result.ok
    assert "boom" in result.error


def test_run_macro_out_of_range_line_is_a_reported_error(tmp_path):
    source = """
def run(ctx, args):
    ctx.set_line(99, "x")
"""
    result = run_macro(write_macro(tmp_path, source), ["a"], 1, [])
    assert not result.ok
    assert "out of range" in result.error


def test_run_macro_does_not_mutate_the_caller_supplied_lines_list(tmp_path):
    source = """
def run(ctx, args):
    ctx.set_line(1, "changed")
"""
    original = ["a"]
    run_macro(write_macro(tmp_path, source), original, 1, [])
    assert original == ["a"]


def test_run_macro_can_insert_and_delete_lines_end_to_end(tmp_path):
    source = """
def run(ctx, args):
    ctx.insert_after(ctx.last_line, "new last line")
    ctx.delete_line(1)
    ctx.message(f"line_count is now {ctx.line_count}")
"""
    result = run_macro(write_macro(tmp_path, source), ["a", "b", "c"], 1, [])
    assert result.ok, result.error
    assert result.lines == ["b", "c", "new last line"]
    assert result.message == "line_count is now 3"


def test_run_macro_failure_leaves_lines_and_cursor_line_none(tmp_path):
    source = """
def run(ctx, args):
    raise ValueError("boom")
"""
    result = run_macro(write_macro(tmp_path, source), ["a"], 1, [])
    assert result.lines is None
    assert result.cursor_line is None


# --- the actual shipped example macros -------------------------------------

def _repo_example_macro_path(name: str) -> str:
    return str(Path(__file__).resolve().parents[2] / ".spfvs" / "macros" / name)


def test_shipped_todocomment_example_macro():
    lines = [
        "/* a comment */",
        "x = 1;  /* TODO fix this */",
        "y = 2;",
    ]
    result = run_macro(_repo_example_macro_path("todocomment.py"), lines, 1, [])
    assert result.ok, result.error
    assert result.lines == [
        "COMMENT: /* a comment */",
        "x = 1;  COMMENT: /* TODO fix this */",
        "y = 2;",
    ]
    assert "ISPF EDIT MACRO FINISHED" in result.message


def test_shipped_showlabel_example_macro_reserved_names_only():
    lines = ["a", "b", "c"]
    result = run_macro(_repo_example_macro_path("showlabel.py"), lines, cursor_line=2, args=[])
    assert result.ok, result.error
    assert result.lines == lines  # read-only demo, never edits the document
    assert ".ZFIRST -> line 1" in result.message
    assert ".ZLAST  -> line 3" in result.message
    assert ".ZCSR   -> line 2" in result.message


def test_shipped_showlabel_example_macro_resolves_and_jumps_to_a_real_label():
    lines = ["a", "b", "c"]
    result = run_macro(
        _repo_example_macro_path("showlabel.py"), lines, cursor_line=1, args=["foo"], labels={"FOO": 3}
    )
    assert result.ok, result.error
    assert ".foo -> line 3 (jumping there)" in result.message
    assert result.cursor_line == 3


def test_shipped_showlabel_example_macro_reports_an_unset_label():
    lines = ["a"]
    result = run_macro(_repo_example_macro_path("showlabel.py"), lines, 1, ["bar"], labels={})
    assert result.ok, result.error
    assert ".bar -> not set" in result.message
    assert result.cursor_line == 1  # unchanged, since nothing to jump to


def test_shipped_duplicateline_example_macro_default_after():
    lines = ["a", "b", "c"]
    result = run_macro(_repo_example_macro_path("duplicateline.py"), lines, cursor_line=2, args=[])
    assert result.ok, result.error
    assert result.lines == ["a", "b", "b", "c"]
    assert "duplicated line 2 after itself" in result.message


def test_shipped_duplicateline_example_macro_before():
    lines = ["a", "b", "c"]
    result = run_macro(_repo_example_macro_path("duplicateline.py"), lines, cursor_line=2, args=["before"])
    assert result.ok, result.error
    assert result.lines == ["a", "b", "b", "c"]
    assert "duplicated line 2 before itself" in result.message


def test_shipped_duplicateline_example_macro_move():
    lines = ["a", "b", "c"]
    result = run_macro(_repo_example_macro_path("duplicateline.py"), lines, cursor_line=1, args=["move"])
    assert result.ok, result.error
    assert result.lines == ["b", "c", "a"]
    assert "moved line 1 to the end (now line 3)" in result.message


def test_shipped_setlabel_example_macro_assigns_to_the_cursor_line():
    lines = ["a", "b", "c"]
    result = run_macro(_repo_example_macro_path("setlabel.py"), lines, cursor_line=2, args=["foo"])
    assert result.ok, result.error
    assert result.lines == lines  # label-only, never edits the document
    assert result.labels == {"FOO": 2}
    assert ".FOO -> line 2" in result.message


def test_shipped_setlabel_example_macro_assigns_to_an_explicit_line():
    lines = ["a", "b", "c"]
    result = run_macro(_repo_example_macro_path("setlabel.py"), lines, cursor_line=1, args=["foo", "3"])
    assert result.ok, result.error
    assert result.labels == {"FOO": 3}
    assert ".FOO -> line 3" in result.message


def test_shipped_setlabel_example_macro_clears_an_existing_label():
    lines = ["a", "b", "c"]
    result = run_macro(
        _repo_example_macro_path("setlabel.py"), lines, cursor_line=1, args=["foo", "clear"], labels={"FOO": 2}
    )
    assert result.ok, result.error
    assert result.labels == {}
    assert ".FOO cleared" in result.message
