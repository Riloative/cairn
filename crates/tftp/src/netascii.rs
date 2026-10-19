//! netascii transfer mode (RFC 764): CR LF line ends on the wire, a bare CR as CR NUL.

/// Local bytes → wire (the whole file at once).
pub fn encode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() + input.len() / 32);
    for &b in input {
        match b {
            b'\n' => out.extend_from_slice(b"\r\n"),
            b'\r' => out.extend_from_slice(b"\r\0"),
            b => out.push(b),
        }
    }
    out
}

/// Wire → local, streaming: a CR at the end of a chunk waits for the next one.
#[derive(Debug, Default)]
pub struct Decoder {
    cr: bool,
}

impl Decoder {
    pub fn push(&mut self, input: &[u8], out: &mut Vec<u8>) {
        for &b in input {
            if self.cr {
                self.cr = false;
                match b {
                    b'\n' => out.push(b'\n'),
                    0 => out.push(b'\r'),
                    b'\r' => {
                        out.push(b'\r');
                        self.cr = true;
                    }
                    other => {
                        out.push(b'\r');
                        out.push(other);
                    }
                }
            } else if b == b'\r' {
                self.cr = true;
            } else {
                out.push(b);
            }
        }
    }

    pub fn finish(&mut self, out: &mut Vec<u8>) {
        if std::mem::take(&mut self.cr) {
            out.push(b'\r');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_across_chunks() {
        let text = b"hostname sw1\nline1\rraw\n";
        let wire = encode(text);
        assert_eq!(wire, b"hostname sw1\r\nline1\r\0raw\r\n");
        let mut d = Decoder::default();
        let mut out = Vec::new();
        for chunk in wire.chunks(3) {
            d.push(chunk, &mut out);
        }
        d.finish(&mut out);
        assert_eq!(out, text);
    }
}
