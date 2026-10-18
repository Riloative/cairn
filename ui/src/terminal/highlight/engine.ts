import type { HighlightRule, HighlightRuleSet, HighlightStyle, Match } from "./types";

/** Lines longer than this are only scanned up to the limit (keeps regexes cheap). */
export const MAX_LINE = 2000;
/** Matches per line beyond this are ignored. */
export const MAX_MATCHES = 64;

export interface CompiledRule {
  id: string;
  re: RegExp;
  style: HighlightStyle;
}

export function compileRule(rule: HighlightRule): CompiledRule | null {
  if (!rule.enabled || (!rule.fg && !rule.bg && !rule.bold && !rule.underline)) return null;
  try {
    const re = new RegExp(rule.pattern, `g${rule.caseInsensitive ? "i" : ""}m`);
    // Patterns that match the empty string would loop forever and highlight nothing.
    if (re.test("")) return null;
    return {
      id: rule.id,
      re,
      style: { fg: rule.fg, bg: rule.bg, bold: rule.bold, underline: rule.underline },
    };
  } catch {
    return null;
  }
}

/** Validate a user-entered pattern; returns an error message or null. */
export function patternError(pattern: string): string | null {
  if (!pattern) return "Enter a pattern.";
  try {
    const re = new RegExp(pattern, "g");
    if (re.test("")) return "The pattern matches empty text.";
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid regular expression.";
  }
  return null;
}

/**
 * Rules for a vendor: its set(s) first (they win overlaps), then the common set. Custom
 * sets replace built-in sets with the same id.
 */
export function rulesForVendor(
  vendor: string,
  builtin: readonly HighlightRuleSet[],
  custom: readonly HighlightRuleSet[] = [],
): CompiledRule[] {
  const byId = new Map(builtin.map((s) => [s.id, s]));
  for (const s of custom) byId.set(s.id, s);
  const sets = [...byId.values()];
  const vendorSets = sets.filter((s) => s.vendors.includes(vendor));
  const common = sets.filter((s) => s.vendors.includes("*"));
  const out: CompiledRule[] = [];
  for (const set of [...vendorSets, ...common]) {
    for (const r of set.rules) {
      const c = compileRule(r);
      if (c) out.push(c);
    }
  }
  return out;
}

/**
 * Find non-overlapping matches. The longest match wins; for equal lengths the earlier
 * rule wins (vendor rules come before common ones). So `err-disabled` beats `disabled`
 * and `administratively down` beats `down`.
 */
export function findMatches(text: string, rules: readonly CompiledRule[]): Match[] {
  const line = text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text;
  if (!line.trim()) return [];
  const candidates: (Match & { order: number })[] = [];
  rules.forEach((rule, order) => {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let found = 0;
    while ((m = rule.re.exec(line)) !== null && found < MAX_MATCHES * 4) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      found++;
      candidates.push({
        start: m.index,
        end: m.index + m[0].length,
        ruleId: rule.id,
        style: rule.style,
        order,
      });
    }
  });
  candidates.sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.order - b.order || a.start - b.start,
  );
  const taken: Match[] = [];
  for (const c of candidates) {
    if (taken.some((t) => c.start < t.end && c.end > t.start)) continue;
    taken.push({ start: c.start, end: c.end, ruleId: c.ruleId, style: c.style });
    if (taken.length >= MAX_MATCHES) break;
  }
  return taken.sort((a, b) => a.start - b.start);
}
