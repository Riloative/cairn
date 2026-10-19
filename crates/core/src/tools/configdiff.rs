//! Line diffs of configuration snapshots: aligned side-by-side rows for the viewer and
//! a unified diff for export.

use serde::Serialize;
use similar::{DiffOp, TextDiff};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RowKind {
    Same,
    Added,
    Removed,
    /// A changed line, shown next to the line it replaced.
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// 1-based line number.
    pub n: usize,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub kind: RowKind,
    pub left: Option<DiffLine>,
    pub right: Option<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDiff {
    pub rows: Vec<DiffRow>,
    pub added: usize,
    pub removed: usize,
}

fn line(lines: &[&str], i: usize) -> Option<DiffLine> {
    lines.get(i).map(|t| DiffLine {
        n: i + 1,
        text: t.trim_end_matches(['\r', '\n']).to_owned(),
    })
}

/// Aligned rows: equal runs side by side, replacements paired line by line.
pub fn side_by_side(old: &str, new: &str) -> ConfigDiff {
    let diff = TextDiff::from_lines(old, new);
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let mut rows = Vec::new();
    let (mut added, mut removed) = (0, 0);
    let row = |kind, l: Option<usize>, r: Option<usize>| DiffRow {
        kind,
        left: l.and_then(|i| line(&a, i)),
        right: r.and_then(|i| line(&b, i)),
    };
    for op in diff.ops() {
        match *op {
            DiffOp::Equal {
                old_index,
                new_index,
                len,
            } => {
                for k in 0..len {
                    rows.push(row(RowKind::Same, Some(old_index + k), Some(new_index + k)));
                }
            }
            DiffOp::Delete {
                old_index, old_len, ..
            } => {
                removed += old_len;
                for k in 0..old_len {
                    rows.push(row(RowKind::Removed, Some(old_index + k), None));
                }
            }
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                added += new_len;
                for k in 0..new_len {
                    rows.push(row(RowKind::Added, None, Some(new_index + k)));
                }
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                removed += old_len;
                added += new_len;
                for k in 0..old_len.max(new_len) {
                    let (l, r) = (
                        (k < old_len).then_some(old_index + k),
                        (k < new_len).then_some(new_index + k),
                    );
                    let kind = match (l, r) {
                        (Some(_), Some(_)) => RowKind::Changed,
                        (Some(_), None) => RowKind::Removed,
                        _ => RowKind::Added,
                    };
                    rows.push(row(kind, l, r));
                }
            }
        }
    }
    ConfigDiff {
        rows,
        added,
        removed,
    }
}

/// A unified diff (3 lines of context) with the given file labels.
pub fn unified(old: &str, new: &str, old_label: &str, new_label: &str) -> String {
    TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(old_label, new_label)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aligns_changes_side_by_side() {
        let old = "hostname sw1\ninterface Gi1/0/1\n description old\n!\nend\n";
        let new = "hostname sw1\ninterface Gi1/0/1\n description uplink\n shutdown\n!\nend\n";
        let d = side_by_side(old, new);
        let kinds: Vec<RowKind> = d.rows.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            vec![
                RowKind::Same,
                RowKind::Same,
                RowKind::Changed,
                RowKind::Added,
                RowKind::Same,
                RowKind::Same
            ]
        );
        assert_eq!((d.added, d.removed), (2, 1));
        let changed = &d.rows[2];
        assert_eq!(
            changed.left.as_ref().map(|l| l.text.as_str()),
            Some(" description old")
        );
        assert_eq!(
            changed.right.as_ref().map(|l| (l.n, l.text.as_str())),
            Some((3, " description uplink"))
        );
        assert!(d.rows[3].left.is_none());
    }

    #[test]
    fn identical_configs_have_no_changes() {
        let d = side_by_side("a\nb\n", "a\nb\n");
        assert_eq!((d.added, d.removed), (0, 0));
        assert!(d.rows.iter().all(|r| r.kind == RowKind::Same));
    }

    #[test]
    fn unified_export() {
        let u = unified("a\nb\n", "a\nc\n", "sw1 2026-10-01", "sw1 2026-10-02");
        assert!(u.starts_with("--- sw1 2026-10-01\n+++ sw1 2026-10-02\n"));
        assert!(u.contains("-b\n+c\n"));
    }
}
