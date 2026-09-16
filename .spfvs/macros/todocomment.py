"""SPFVS edit macro — invoke by typing `todocomment` in COMMAND ===>.

A worked translation of a sample REXX ISPF edit macro (the exact one
used while designing the macro-support feature — see CLAUDE.md). The
original REXX:

    /* REXX */
    /* ISPF EDIT MACRO - simple line processing demonstration */
    ADDRESS ISREDIT
    "NUMBER"
    "STATS"
    parse var RC .
    "CURSOR = 0"
    "FIND FIRST TODO"
    do while RC = 0
        "CHANGE TODO TODO ALL"
        "FIND NEXT TODO"
    end
    "FIND FIRST '/*'"
    do while RC = 0
        "CHANGE FIRST '/*' 'COMMENT: /*'"
        "FIND NEXT '/*'"
    end
    "NUMBER"
    "GET_LINES .ZLAST"
    say "ISPF EDIT MACRO FINISHED"
    say "Lines in member:" .ZLAST
    exit 0

The REXX/ISREDIT idioms this drops entirely, and why: ADDRESS ISREDIT +
quoted host-command strings (not needed — this macro calls EditContext
methods directly); RC checked after every command + DO WHILE loops
(replaced by find_all()'s plain Python iterator — no repeat-find state
to track, no numeric return code to test); .ZLAST read like a variable
(real ISPF's own mechanism is actually a query-then-assign into a REXX
variable, since .ZLAST is a line-pointer token, not a readable value —
here it's just the ctx.line_count property, a plain int).
"""


def run(ctx, args):
    # "FIND FIRST TODO" / do-while-RC=0 / "CHANGE TODO TODO ALL" /
    # "FIND NEXT TODO" -> a single iterator. As literally written the
    # original REXX changes "TODO" to "TODO" (a no-op) on every match;
    # kept as-is to mirror the source faithfully rather than "fix" it.
    for match in ctx.find_all("TODO"):
        ctx.change_line(match.line, match.text.replace("TODO", "TODO"))

    # "FIND FIRST '/*'" / do-while-RC=0 / "CHANGE FIRST '/*' 'COMMENT: /*'"
    # / "FIND NEXT '/*'" -> for every line containing "/*", replace just
    # the FIRST occurrence on that line with "COMMENT: /*" (CHANGE
    # FIRST's single-occurrence-per-hit scope, not CHANGE ALL).
    for match in ctx.find_all("/*"):
        ctx.change_line(match.line, match.text.replace("/*", "COMMENT: /*", 1))

    # "NUMBER" / "GET_LINES .ZLAST" + the two SAY statements.
    ctx.message(f"ISPF EDIT MACRO FINISHED\nLines in member: {ctx.line_count}")
