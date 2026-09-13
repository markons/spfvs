"""Data shapes shared between the stdio protocol and the prefix-command
engine. Kept dependency-free (stdlib dataclasses only) so prefix_commands.py
has no VS Code / IPC awareness at all.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Command:
    """One raw prefix-gutter entry as typed by the user."""
    line: int  # 1-indexed, matches editor line numbers
    code: str  # raw text, e.g. "d", "d5", "cc", "a"


@dataclass(frozen=True)
class CommandError:
    line: int
    message: str


@dataclass(frozen=True)
class LinePlan:
    """The result of successfully resolving a batch of prefix commands."""
    lines: list[str]
    # original (pre-resolution) line numbers that were consumed by this
    # batch, so the caller can clear those gutter cells.
    consumed_lines: list[int] = field(default_factory=list)


@dataclass(frozen=True)
class ProcessResult:
    errors: list[CommandError]
    plan: LinePlan | None
    # Updated name->line label map after applying this batch (labels on
    # deleted lines dropped, labels on moved lines follow the move). None
    # when the batch was rejected (labels are caller-owned state; on
    # rejection the caller keeps whatever it already had).
    labels: dict[str, int] | None = None
    # Updated sorted list of excluded (hidden) line numbers after applying
    # this batch's x/xx ops (same drop-on-delete/follow-on-move remap as
    # labels). None when the batch was rejected, for the same reason.
    excluded_lines: list[int] | None = None
    # Updated pending copy/move mark — {"kind": "copy"|"move", "start":
    # int, "end": int} or None — left behind by an unpaired c/cc/m/mm
    # (paired ones, i.e. c/m WITH an a/b destination in the same batch,
    # still do an immediate in-file copy/move exactly as always and never
    # touch this). Remapped the same way as labels/excluded_lines (follows
    # a moved line, dropped if its line is deleted). Cleared to None once
    # a CUT primary command (execute_cut=True) resolves it. Same
    # None-on-rejection rule as labels/excluded_lines.
    pending_mark: dict | None = None
