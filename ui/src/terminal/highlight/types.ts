/**
 * Keyword highlighting rules. Colors are palette ANSI names (`red`, `brightGreen`, …) so
 * highlights follow the terminal palette, or `#rrggbb`.
 */
export interface HighlightRule {
  id: string;
  name: string;
  /** JavaScript regular expression source (no delimiters). */
  pattern: string;
  caseInsensitive: boolean;
  fg: string | null;
  bg: string | null;
  bold: boolean;
  underline: boolean;
  enabled: boolean;
}

export interface HighlightRuleSet {
  id: string;
  name: string;
  /** Vendor ids that select this set automatically (see VENDORS). */
  vendors: string[];
  rules: HighlightRule[];
}

export interface HighlightStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  underline: boolean;
}

export interface Match {
  /** UTF-16 offsets into the line text, end exclusive. */
  start: number;
  end: number;
  ruleId: string;
  style: HighlightStyle;
}
