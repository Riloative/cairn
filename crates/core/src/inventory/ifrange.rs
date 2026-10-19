//! Interface name patterns for bulk creation, e.g. `Gi1/0/1-48`, `xe-0/0/[0-3]`,
//! `eth0-3, mgmt0`.

use crate::error::CoreError;

/// Most interfaces one pattern may create (a 4-slot chassis is ~200).
pub const MAX_EXPANSION: usize = 1024;

/// Expand a comma-separated list of names and ranges into interface names, in order.
///
/// A range is the last number in a part followed by `-N` (`Gi1/0/1-48`) or written in
/// brackets anywhere (`xe-0/[0-1]/[0-3]`, expanded left to right). A part without a
/// range is taken literally. Leading zeros are kept (`port01-12`).
pub fn expand(pattern: &str) -> Result<Vec<String>, CoreError> {
    let mut out = Vec::new();
    for part in pattern.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        for name in expand_part(part)? {
            if out.len() >= MAX_EXPANSION {
                return Err(CoreError::Validation(format!(
                    "That pattern makes more than {MAX_EXPANSION} interfaces."
                )));
            }
            out.push(name);
        }
    }
    if out.is_empty() {
        return Err(CoreError::Validation(
            "Enter interface names or a range like Gi1/0/1-48.".into(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|n| seen.insert(n.clone()));
    Ok(out)
}

fn bad(part: &str) -> CoreError {
    CoreError::Validation(format!(
        "Could not read '{part}'. Use a range like Gi1/0/1-48 or xe-0/0/[0-3]."
    ))
}

fn expand_part(part: &str) -> Result<Vec<String>, CoreError> {
    if part.contains('[') {
        return expand_brackets(part);
    }
    // Trailing `<digits>-<digits>`; the dash must follow a digit so `xe-0/0/1` and
    // `Port-channel1` stay literal.
    if let Some((head, end)) = part.rsplit_once('-') {
        let start_digits = head.chars().rev().take_while(char::is_ascii_digit).count();
        if start_digits > 0 && !end.is_empty() && end.chars().all(|c| c.is_ascii_digit()) {
            let split = head.len() - start_digits;
            let (prefix, start) = head.split_at(split);
            return numbered(prefix, start, end, "", part);
        }
    }
    if part.chars().any(char::is_whitespace) {
        return Err(bad(part));
    }
    Ok(vec![part.to_owned()])
}

fn numbered(
    prefix: &str,
    start: &str,
    end: &str,
    suffix: &str,
    part: &str,
) -> Result<Vec<String>, CoreError> {
    let (Ok(a), Ok(b)) = (start.parse::<u32>(), end.parse::<u32>()) else {
        return Err(bad(part));
    };
    if a > b || (b - a) as usize >= MAX_EXPANSION {
        return Err(bad(part));
    }
    // Zero-padded ranges keep their width (port01-12).
    let width = if start.starts_with('0') && start.len() > 1 {
        start.len()
    } else {
        0
    };
    Ok((a..=b)
        .map(|n| format!("{prefix}{n:0width$}{suffix}"))
        .collect())
}

fn expand_brackets(part: &str) -> Result<Vec<String>, CoreError> {
    let Some(open) = part.find('[') else {
        return Ok(vec![part.to_owned()]);
    };
    let close = part[open..]
        .find(']')
        .map(|i| open + i)
        .ok_or_else(|| bad(part))?;
    let (prefix, inner, rest) = (&part[..open], &part[open + 1..close], &part[close + 1..]);
    let (a, b) = inner.split_once('-').unwrap_or((inner, inner));
    let heads = numbered(prefix, a.trim(), b.trim(), "", part)?;
    let tails = expand_brackets(rest)?;
    let mut out = Vec::with_capacity(heads.len() * tails.len());
    for h in &heads {
        for t in &tails {
            out.push(format!("{h}{t}"));
            if out.len() > MAX_EXPANSION {
                return Err(CoreError::Validation(format!(
                    "That pattern makes more than {MAX_EXPANSION} interfaces."
                )));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_ranges() {
        let v = expand("Gi1/0/1-48").expect("expand");
        assert_eq!(v.len(), 48);
        assert_eq!(v[0], "Gi1/0/1");
        assert_eq!(v[47], "Gi1/0/48");
        assert_eq!(expand("eth0-2").expect("eth"), ["eth0", "eth1", "eth2"]);
        assert_eq!(
            expand("port01-03").expect("pad"),
            ["port01", "port02", "port03"]
        );
    }

    #[test]
    fn literals_and_lists() {
        assert_eq!(
            expand("xe-0/0/1, Port-channel1, mgmt0").expect("lit"),
            ["xe-0/0/1", "Port-channel1", "mgmt0"]
        );
        assert_eq!(
            expand("Te1/1/1-2, Gi1/0/1, Te1/1/2").expect("dedup"),
            ["Te1/1/1", "Te1/1/2", "Gi1/0/1"]
        );
    }

    #[test]
    fn bracket_ranges_nest_left_to_right() {
        assert_eq!(
            expand("xe-0/[0-1]/[0-1]").expect("brackets"),
            ["xe-0/0/0", "xe-0/0/1", "xe-0/1/0", "xe-0/1/1"]
        );
        assert_eq!(expand("ge-0/0/[3]").expect("single"), ["ge-0/0/3"]);
    }

    #[test]
    fn rejects_nonsense() {
        assert!(expand("").is_err());
        assert!(expand("Gi1/0/48-1").is_err());
        assert!(expand("xe-0/[0-").is_err());
        assert!(expand("Gi 1").is_err());
        assert!(expand("e0-5000").is_err());
        assert!(expand("e[0-40]/[0-40]").is_err());
    }
}
