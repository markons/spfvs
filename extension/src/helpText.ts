/**
 * Plain-text quick reference for the `HELP`/`H` primary command — opened
 * as a new, ordinary (non-SPFVS) editor tab beside the current one (see
 * ispfEditorProvider.ts's `handlePrimaryAction`), rather than crammed
 * into the single-line `COMMAND ===>` status message. Kept here (the
 * extension host's `src/`, not the webview's `media/`) since opening a
 * new tab is an extension-host-only API; `README.md`'s command tables
 * are the fuller, prose-annotated reference — keep both in sync when a
 * command's syntax changes.
 */
export const HELP_TEXT = `SPFVS quick reference
======================

This is a static summary of every currently implemented command.
See README.md in the repo for full explanations and edge cases.

PREFIX (LINE) COMMANDS -- typed in the gutter to the left of a line
--------------------------------------------------------------------
d[n]              delete n lines starting here (default 1)
r[n]              repeat this line n times
rr ... rr         repeat the block between two rr markers
                  (count on either marker, e.g. rr3, repeats that many times)
i[n]              insert n blank lines after this line
c[n]              mark n lines as a copy source
                  -- pairs with a/b for an immediate in-file copy,
                  -- or becomes a PENDING MARK for CUT if left unpaired
m[n]              mark n lines as a move source (same as c[n], but CUT moves)
dd ... dd         delete the block between two dd markers
cc ... cc         mark a block as a copy source (must be closed by a 2nd cc)
mm ... mm         mark a block as a move source (must be closed by a 2nd mm)
a                 destination marker: after this line
b                 destination marker: before this line
x[n]              EXCLUDE: hide n lines starting here from view (default 1)
xx ... xx         EXCLUDE the block between two xx markers
)  ))  ...        SHIFT this line's text right, 2 columns per repeated char
>  >>  ...        (alias of the above)
)n  >n            SHIFT right by exactly n columns
(  ((  ...        SHIFT this line's text left, 2 columns per repeated char
<  <<  ...        (alias of the above)
(n  <n            SHIFT left by exactly n columns
.name             LABEL: assign a name (1-8 chars, starts with a letter)
.                 clear whatever label is on this line
uc                UPPERCASE this line
lc                lowercase this line
uc ... uc         UPPERCASE the range between two markers (lc likewise)
hx[n]             show n lines' hex bytes as two rows underneath (toggle
                  on a bare hx; hx3 always SHOWS, never hides)
cols              show/hide an ISPF-style column ruler under this line
                  (no counted form -- toggle only)

A lone (unpaired) c/cc/m/mm becomes a PENDING MARK, not an error --
resolved later by the CUT primary command. A lone a/b with no pending
source is still an ordinary error. Setting a new mark while one is
already pending is an error (use CUT first).

PRIMARY COMMANDS -- typed in the COMMAND ===> bar
--------------------------------------------------------------------
find <text>                       jump to the next match (wraps)
find <text> prev                  jump to the previous match (wraps)
find <text> first / last          jump to the first / last match in the file
find <text> all                   jump to the first match, report the count
find <text> <c1> <c2> [scope]     only match within columns c1-c2
find <text> word [c1 c2] [scope]  only match a whole word
find / f (no text)                repeat the last search (same as rfind)
rfind / rf                        repeat the last search (ISPF's PF5)
change <old> <new> [scope]        replace one match; scope is
                                   first/last/prev/next (default), or all
change <old> <new> <c1> <c2> [scope]        same, within columns c1-c2
change <old> <new> word [c1 c2] [scope]     same, old must be a whole word
sort                               sort all lines, whole-line, ascending
sort <c1> <c2> [a|d]               sort by column range c1-c2; d=descending
cut                                 resolve the pending c/cc/m/mm mark:
                                    copy or move it to the shared clipboard
paste / paste a                    insert the clipboard after the cursor's line
paste b                            insert the clipboard before the cursor's line
top / t                            move to the top of the file
bottom / bot                       move to the bottom of the file
locate .label / loc .label / l .label     move to the line with that label
locate <n> / loc <n> / l <n>              move to line n
exclude <text> / x <text>          hide lines containing text (view-only)
exclude all / x all                hide every line
exclude .a .b / x .a .b            hide the range between two labels
reset / res                        show all excluded lines again, hide any
                                   shown hx/cols rulers; leaves labels alone
reset lab / res lab                clear every LABEL (does not un-hide anything)
undo                                undo one edit
undo all                            discard all unsaved changes (revert to disk)
save                                save the file
cancel / can                        discard all unsaved changes and close
end / pf3                           save and close
help / h                            show this reference

GUTTER NAVIGATION
--------------------------------------------------------------------
Up / Down arrow (in a prefix cell)   move to the cell above/below,
                                      keeping the caret's column position
Home (in a prefix cell)              jump to the COMMAND ===> bar
Home (in the main editor, at 1,1)    jump to the COMMAND ===> bar
`;
