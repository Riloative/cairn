//! Minimal RFC 4180 CSV writing for exports (audit log, inventory).
//!
//! Cells that a spreadsheet would evaluate as a formula (`=`, `+`, `-`, `@`, tab, CR at
//! the start) are prefixed with `'`. Exported values come from devices and the network
//! (hostnames, banners, file names), so opening an export must never run a formula.

use std::io::{self, Write};

/// Writes rows with CRLF line endings, as RFC 4180 and spreadsheets expect.
#[derive(Debug)]
pub struct CsvWriter<W: Write> {
    out: W,
}

impl<W: Write> CsvWriter<W> {
    pub fn new(out: W) -> Self {
        Self { out }
    }

    pub fn row<I, S>(&mut self, cells: I) -> io::Result<()>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut first = true;
        for cell in cells {
            if !first {
                self.out.write_all(b",")?;
            }
            first = false;
            self.out.write_all(cell_text(cell.as_ref()).as_bytes())?;
        }
        self.out.write_all(b"\r\n")
    }

    pub fn into_inner(self) -> W {
        self.out
    }
}

/// One cell, neutralized and quoted when needed.
pub fn cell_text(value: &str) -> String {
    let formula = value.starts_with(['=', '+', '-', '@', '\t', '\r']);
    let value = if formula {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_and_escapes() {
        assert_eq!(cell_text("plain"), "plain");
        assert_eq!(cell_text("a,b"), "\"a,b\"");
        assert_eq!(cell_text("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(cell_text("two\nlines"), "\"two\nlines\"");
        assert_eq!(cell_text(""), "");
    }

    #[test]
    fn neutralizes_formulas() {
        assert_eq!(cell_text("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
        assert_eq!(cell_text("+1"), "'+1");
        assert_eq!(cell_text("-cmd"), "'-cmd");
        assert_eq!(cell_text("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(cell_text("sw1-core"), "sw1-core");
    }

    #[test]
    fn writes_rows_with_crlf() {
        let mut w = CsvWriter::new(Vec::new());
        w.row(["a", "b,c"]).expect("row");
        w.row(["1", ""]).expect("row");
        assert_eq!(w.into_inner(), b"a,\"b,c\"\r\n1,\r\n");
    }
}
