"""SPFVS edit macro demonstrating ctx.set_label()/ctx.clear_label().

Invoke as:
  setlabel <name>          -- assigns <name> to the cursor's current line
  setlabel <name> <line>   -- assigns <name> to a specific line number
  setlabel <name> clear    -- clears <name> if it's currently set

Labels set here follow exactly the same rules as a gutter `.name` commit
(1-8 letters/digits, must start with a letter, folded to uppercase,
names starting with 'Z' rejected as reserved) and show up in the gutter
immediately -- no document edit is needed for a label-only change.
"""


def run(ctx, args):
    if not args:
        ctx.message("usage: setlabel <name> [<line> | clear]")
        return

    name = args[0]
    clean_name = name.lstrip(".").upper()

    if len(args) > 1 and args[1].lower() == "clear":
        ctx.clear_label(name)
        ctx.message(f".{clean_name} cleared")
        return

    target = int(args[1]) if len(args) > 1 else ctx.cursor_line
    ctx.set_label(name, target)
    ctx.message(f".{clean_name} -> line {target}")
