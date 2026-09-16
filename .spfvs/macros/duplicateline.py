"""SPFVS edit macro demonstrating insert_after/insert_before/delete_line
-- Copy and Move have no dedicated methods, but are trivial to compose
from these plus get_line().

Invoke as:
  duplicateline        -- duplicates the cursor's line, right after it
  duplicateline before -- duplicates it BEFORE instead
  duplicateline move   -- MOVES the cursor's line to the end of the
                          file instead of copying it (insert + delete)
"""


def run(ctx, args):
    mode = args[0].lower() if args else "after"
    source_line = ctx.cursor_line
    text = ctx.get_line(source_line)

    if mode == "move":
        # Copy to the end, then remove the original -- a "move" is just
        # insert_after + delete_line, no dedicated method needed.
        ctx.insert_after(ctx.last_line, text)
        ctx.delete_line(source_line)
        ctx.message(f"moved line {source_line} to the end (now line {ctx.last_line})")
        return

    if mode == "before":
        ctx.insert_before(source_line, text)
        ctx.message(f"duplicated line {source_line} before itself")
    else:
        ctx.insert_after(source_line, text)
        ctx.message(f"duplicated line {source_line} after itself")
