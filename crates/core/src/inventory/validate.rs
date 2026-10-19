//! Input validation shared by inventory entities. Messages are shown to the user as-is.

use crate::error::CoreError;
use std::net::IpAddr;

pub(crate) fn invalid<T>(msg: impl Into<String>) -> Result<T, CoreError> {
    Err(CoreError::Validation(msg.into()))
}

/// Trimmed, non-empty name of at most `max` characters.
pub fn name(value: &str, what: &str, max: usize) -> Result<String, CoreError> {
    let v = value.trim();
    if v.is_empty() {
        return invalid(format!("Enter a {what}."));
    }
    if v.chars().count() > max {
        return invalid(format!("The {what} is longer than {max} characters."));
    }
    if v.chars().any(char::is_control) {
        return invalid(format!("The {what} contains control characters."));
    }
    Ok(v.to_owned())
}

/// Optional free text (notes, descriptions): trimmed, length-limited.
pub fn text(value: &str, what: &str, max: usize) -> Result<String, CoreError> {
    let v = value.trim();
    if v.chars().count() > max {
        return invalid(format!("The {what} is longer than {max} characters."));
    }
    Ok(v.to_owned())
}

/// A hostname as entered for a device: letters, digits and `-_.` (no spaces).
pub fn hostname(value: &str) -> Result<String, CoreError> {
    let v = name(value, "hostname", 253)?;
    if !v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return invalid("A hostname may only contain letters, digits, '-', '_' and '.'.");
    }
    Ok(v)
}

/// An IPv4 or IPv6 address, or empty. Returns the canonical text form.
pub fn ip_or_empty(value: &str, what: &str) -> Result<String, CoreError> {
    let v = value.trim().trim_start_matches('[').trim_end_matches(']');
    if v.is_empty() {
        return Ok(String::new());
    }
    match v.parse::<IpAddr>() {
        Ok(ip) => Ok(ip.to_string()),
        Err(_) => invalid(format!("{v} is not a valid IPv4 or IPv6 {what}.")),
    }
}

/// A prefix like `10.1.20.0/24` or `2001:db8::/64`, or empty. Host bits must be zero.
pub fn subnet_or_empty(value: &str) -> Result<String, CoreError> {
    let v = value.trim();
    if v.is_empty() {
        return Ok(String::new());
    }
    let bad = || invalid(format!("{v} is not a valid subnet (e.g. 10.1.20.0/24)."));
    let Some((addr, len)) = v.split_once('/') else {
        return bad();
    };
    let (Ok(ip), Ok(len)) = (addr.parse::<IpAddr>(), len.parse::<u8>()) else {
        return bad();
    };
    let (bits, value): (u8, u128) = match ip {
        IpAddr::V4(a) => (32, u128::from(u32::from(a))),
        IpAddr::V6(a) => (128, u128::from(a)),
    };
    if len > bits {
        return bad();
    }
    let host_mask = if len == bits {
        0
    } else {
        (1u128 << (bits - len)) - 1
    };
    if value & host_mask != 0 {
        return invalid(format!(
            "{v} has host bits set; did you mean the network address?"
        ));
    }
    Ok(format!("{ip}/{len}"))
}

/// Whether `ip` lies inside `subnet` (both already validated).
pub fn subnet_contains(subnet: &str, ip: &str) -> bool {
    let (Some((net, len)), Ok(ip)) = (subnet.split_once('/'), ip.parse::<IpAddr>()) else {
        return false;
    };
    let (Ok(net), Ok(len)) = (net.parse::<IpAddr>(), len.parse::<u32>()) else {
        return false;
    };
    match (net, ip) {
        (IpAddr::V4(n), IpAddr::V4(a)) => {
            let mask = u32::MAX.checked_shl(32 - len).unwrap_or(0);
            u32::from(n) & mask == u32::from(a) & mask
        }
        (IpAddr::V6(n), IpAddr::V6(a)) => {
            let mask = u128::MAX.checked_shl(128 - len).unwrap_or(0);
            u128::from(n) & mask == u128::from(a) & mask
        }
        _ => false,
    }
}

/// `#rrggbb` or empty.
pub fn color_or_empty(value: &str) -> Result<String, CoreError> {
    let v = value.trim();
    if v.is_empty() {
        return Ok(String::new());
    }
    if v.len() == 7 && v.starts_with('#') && v[1..].chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(v.to_ascii_lowercase())
    } else {
        invalid(format!("{v} is not a color like #3b82f6."))
    }
}

pub fn vlan_id(vid: u16) -> Result<u16, CoreError> {
    if (1..=4094).contains(&vid) {
        Ok(vid)
    } else {
        invalid(format!("VLAN {vid} is out of range (1–4094)."))
    }
}

/// Parse a VLAN list like `1,10-20,99` into sorted ids. Empty means none.
pub fn vlan_list(value: &str) -> Result<Vec<u16>, CoreError> {
    let mut out = Vec::new();
    for part in value.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let bad = || invalid(format!("'{part}' is not a VLAN or range (e.g. 10-20)."));
        let (a, b) = match part.split_once('-') {
            Some((a, b)) => (a.trim(), b.trim()),
            None => (part, part),
        };
        let (Ok(a), Ok(b)) = (a.parse::<u16>(), b.parse::<u16>()) else {
            return bad();
        };
        if a > b {
            return bad();
        }
        vlan_id(a)?;
        vlan_id(b)?;
        out.extend(a..=b);
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// Canonical text for a VLAN list: ranges collapsed (`1,10-12,99`).
pub fn format_vlan_list(ids: &[u16]) -> String {
    let mut parts = Vec::new();
    let mut iter = ids.iter().copied().peekable();
    while let Some(start) = iter.next() {
        let mut end = start;
        while iter.peek() == Some(&(end + 1)) {
            end += 1;
            iter.next();
        }
        parts.push(if start == end {
            start.to_string()
        } else {
            format!("{start}-{end}")
        });
    }
    parts.join(",")
}

pub fn port(port: u16, what: &str) -> Result<u16, CoreError> {
    if port == 0 {
        invalid(format!("The {what} port must be between 1 and 65535."))
    } else {
        Ok(port)
    }
}

/// An http(s) URL (opened in the system browser).
pub fn web_url(value: &str) -> Result<String, CoreError> {
    let v = value.trim();
    let rest = v
        .strip_prefix("https://")
        .or_else(|| v.strip_prefix("http://"));
    match rest {
        Some(r) if !r.is_empty() && !v.chars().any(char::is_whitespace) => Ok(v.to_owned()),
        _ => invalid(format!("{v} is not an http:// or https:// address.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ips_are_validated_and_canonical() {
        assert_eq!(
            ip_or_empty(" 10.0.0.1 ", "address").expect("v4"),
            "10.0.0.1"
        );
        assert_eq!(
            ip_or_empty("[2001:DB8::0:1]", "address").expect("v6"),
            "2001:db8::1"
        );
        assert_eq!(ip_or_empty("", "address").expect("empty"), "");
        assert!(ip_or_empty("10.0.0.256", "address").is_err());
        assert!(ip_or_empty("core-sw1", "address").is_err());
    }

    #[test]
    fn subnets_need_zero_host_bits() {
        assert_eq!(subnet_or_empty("10.1.20.0/24").expect("ok"), "10.1.20.0/24");
        assert_eq!(
            subnet_or_empty("2001:db8::/64").expect("ok"),
            "2001:db8::/64"
        );
        assert!(subnet_or_empty("10.1.20.1/24").is_err());
        assert!(subnet_or_empty("10.1.20.0/33").is_err());
        assert!(subnet_or_empty("10.1.20.0").is_err());
        assert!(subnet_contains("10.1.20.0/24", "10.1.20.77"));
        assert!(!subnet_contains("10.1.20.0/24", "10.1.21.1"));
        assert!(subnet_contains("0.0.0.0/0", "8.8.8.8"));
        assert!(subnet_contains("2001:db8::/64", "2001:db8::5"));
    }

    #[test]
    fn vlan_lists_round_trip() {
        let ids = vlan_list("99, 10-12,1,11").expect("parse");
        assert_eq!(ids, [1, 10, 11, 12, 99]);
        assert_eq!(format_vlan_list(&ids), "1,10-12,99");
        assert!(vlan_list("0").is_err());
        assert!(vlan_list("20-10").is_err());
        assert!(vlan_list("4095").is_err());
        assert!(vlan_list("a").is_err());
        assert!(vlan_list("").expect("empty").is_empty());
    }

    #[test]
    fn names_hostnames_colors_urls() {
        assert!(hostname("core sw").is_err());
        assert_eq!(hostname(" core-sw1.lab ").expect("ok"), "core-sw1.lab");
        assert!(name("", "name", 10).is_err());
        assert!(name("a\u{7}", "name", 10).is_err());
        assert!(name("abcdefghijk", "name", 10).is_err());
        assert_eq!(color_or_empty("#3B82F6").expect("ok"), "#3b82f6");
        assert!(color_or_empty("blue").is_err());
        assert!(web_url("https://10.0.0.1:8443/").is_ok());
        assert!(web_url("javascript:alert(1)").is_err());
        assert!(web_url("https://").is_err());
    }
}
