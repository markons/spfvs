"""SPFVS edit macro demonstrating ctx.resolve_label().

Invoke as:
  showlabel          -- reports .ZFIRST/.ZLAST/.ZCSR only
  showlabel <name>   -- also resolves a real label (e.g. one you set
                         with `.foo` in the gutter) and, if found,
                         jumps the cursor there

Try it: set a label with `.foo` in the gutter, commit that batch, then
type `showlabel foo` in COMMAND ===>.
"""


def run(ctx, args):
    lines = [
        f".ZFIRST -> line {ctx.resolve_label('.ZFIRST')}",
        f".ZLAST  -> line {ctx.resolve_label('.ZLAST')}",
        f".ZCSR   -> line {ctx.resolve_label('.ZCSR')} (the cursor's line when this macro started)",
    ]

    if args:
        # resolve_label() accepts the name with or without the leading
        # "." and is case-insensitive -- args[0] is passed through as-is.
        name = args[0]
        target = ctx.resolve_label(name)
        clean_name = name.lstrip(".")
        if target is None:
            lines.append(f".{clean_name} -> not set")
        else:
            lines.append(f".{clean_name} -> line {target} (jumping there)")
            # Demonstrates the "detect a label, then jump to it" combo --
            # real ISPF's LOCATE .label in one step.
            ctx.cursor_line = target

    ctx.message("\n".join(lines) + ':' + ctx.get_line(ctx.cursor_line))
