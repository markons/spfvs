import type * as monacoNs from "monaco-editor/esm/vs/editor/editor.api";

// Keyword set ported from pli-pygen/pli/lexer.py's `reserved` table (the
// synonym pairs collapse to their target token there; here we just need
// every surface spelling for coloring). Read that file again before
// extending this list — don't re-derive it from memory.
const KEYWORDS = [
  "PROCEDURE", "PROC", "DECLARE", "DCL", "CHARACTER", "CHAR", "INITIAL", "INIT",
  "BINARY", "BIN", "DECIMAL", "DEC", "OTHERWISE", "OTHER", "IF", "THEN", "ELSE",
  "DO", "END", "TO", "BY", "WHILE", "UNTIL", "SELECT", "WHEN", "CALL", "RETURN",
  "RETURNS", "GOTO", "GO", "PUT", "GET", "LIST", "EDIT", "SKIP", "PAGE", "STOP",
  "BEGIN", "LEAVE", "ITERATE", "OPTIONS", "FIXED", "FLOAT", "BIT", "VARYING",
  "STATIC", "AUTOMATIC", "LABEL", "ON", "SIGNAL", "REVERT", "SYSTEM", "SNAP",
  "LIKE", "DATA", "FORMAT", "PICTURE", "PIC", "STRING", "ALLOCATE", "ALLOC",
  "FREE", "BASED", "CONTROLLED", "CTL", "DEFINED", "DEF", "FILE", "OPEN",
  "CLOSE", "READ", "WRITE", "REWRITE", "DELETE", "WAIT", "DISPLAY", "ENTRY",
  "LOCATE", "UNLOCK", "REFER",
];

export function registerPliLanguage(monaco: typeof monacoNs): void {
  monaco.languages.register({ id: "pli", extensions: [".pli", ".pl1"], aliases: ["PL/I", "pli"] });

  monaco.languages.setLanguageConfiguration("pli", {
    comments: { blockComment: ["/*", "*/"] },
    brackets: [["(", ")"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider("pli", {
    ignoreCase: true,
    keywords: KEYWORDS,
    tokenizer: {
      root: [
        [/\/\*/, "comment", "@comment"],
        [/[A-Za-z_$#@][A-Za-z0-9_$#@]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/'([^']|'')*'[Bb]?/, "string"],
        [/(\d+\.\d*|\.\d+|\d+)([Ee][+-]?\d+)?[BbIi]?/, "number"],
        [/[()]/, "@brackets"],
        [/[+\-*/&|]|\|\||\*\*|->|[¬^~]?[=<>]=?|<>/, "operator"],
        [/[,;:.]/, "delimiter"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });
}
