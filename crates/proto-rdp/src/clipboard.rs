//! Text clipboard redirection (CLIPRDR), plain Unicode text in both directions.
//!
//! The backend lives inside the static channel processor and cannot write to the
//! connection itself; it hands messages to the session loop through a channel. The
//! local text it offers to the server is shared with the loop, which sets it when the
//! user copies something on this computer.

use ironrdp::cliprdr::backend::{ClipboardMessage, CliprdrBackend};
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
};
use ironrdp::core::impl_as_any;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

/// What the backend asks of the session loop.
#[derive(Debug)]
pub(crate) enum ClipboardEvent {
    /// Encode and send a CLIPRDR message.
    Send(ClipboardMessage),
    /// The server's clipboard now holds this text.
    RemoteText(String),
}

#[derive(Debug)]
pub(crate) struct TextClipboard {
    tx: UnboundedSender<ClipboardEvent>,
    local: Arc<Mutex<Option<String>>>,
}

impl_as_any!(TextClipboard);

impl TextClipboard {
    pub(crate) fn new(
        tx: UnboundedSender<ClipboardEvent>,
        local: Arc<Mutex<Option<String>>>,
    ) -> Self {
        Self { tx, local }
    }

    fn send(&self, msg: ClipboardMessage) {
        // The loop is gone only when the session is ending.
        let _ = self.tx.send(ClipboardEvent::Send(msg));
    }

    fn local_text(&self) -> Option<String> {
        self.local.lock().ok().and_then(|t| t.clone())
    }

    /// Offer our formats: Unicode text when we hold some, else an empty list.
    fn announce(&self) {
        let formats = match self.local_text() {
            Some(_) => vec![ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)],
            None => Vec::new(),
        };
        self.send(ClipboardMessage::SendInitiateCopy(formats));
    }
}

/// Decode CF_UNICODETEXT data: UTF-16LE, NUL-terminated.
pub(crate) fn decode_unicode(data: &[u8]) -> String {
    let units: Vec<u16> = data
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&c| u16::from_le_bytes(c))
        .take_while(|&u| u != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

impl CliprdrBackend for TextClipboard {
    fn temporary_directory(&self) -> &str {
        ""
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::empty()
    }

    fn on_ready(&mut self) {
        self.announce();
    }

    fn on_request_format_list(&mut self) {
        self.announce();
    }

    fn on_process_negotiated_capabilities(&mut self, _: ClipboardGeneralCapabilityFlags) {}

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        if available_formats
            .iter()
            .any(|f| f.id() == ClipboardFormatId::CF_UNICODETEXT)
        {
            self.send(ClipboardMessage::SendInitiatePaste(
                ClipboardFormatId::CF_UNICODETEXT,
            ));
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let response = match (request.format, self.local_text()) {
            (ClipboardFormatId::CF_UNICODETEXT, Some(text)) => {
                FormatDataResponse::new_unicode_string(&text)
            }
            _ => FormatDataResponse::new_error(),
        };
        self.send(ClipboardMessage::SendFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if !response.is_error() {
            let _ = self
                .tx
                .send(ClipboardEvent::RemoteText(decode_unicode(response.data())));
        }
    }

    fn on_file_contents_request(&mut self, _: FileContentsRequest) {}

    fn on_file_contents_response(&mut self, _: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _: LockDataId) {}

    fn on_unlock(&mut self, _: LockDataId) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn backend(text: Option<&str>) -> (TextClipboard, mpsc::UnboundedReceiver<ClipboardEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let local = Arc::new(Mutex::new(text.map(str::to_owned)));
        (TextClipboard::new(tx, local), rx)
    }

    #[test]
    fn decodes_nul_terminated_utf16() {
        let mut data: Vec<u8> = "héllo ✓"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        data.extend_from_slice(&[0, 0, b'x', 0]);
        assert_eq!(decode_unicode(&data), "héllo ✓");
    }

    #[test]
    fn announces_text_only_when_holding_some() {
        let (mut b, mut rx) = backend(None);
        b.on_ready();
        assert!(matches!(
            rx.try_recv(),
            Ok(ClipboardEvent::Send(ClipboardMessage::SendInitiateCopy(f))) if f.is_empty()
        ));
        let (mut b, mut rx) = backend(Some("x"));
        b.on_request_format_list();
        assert!(matches!(
            rx.try_recv(),
            Ok(ClipboardEvent::Send(ClipboardMessage::SendInitiateCopy(f))) if f.len() == 1
        ));
    }

    #[test]
    fn pastes_remote_text_and_ignores_other_formats() {
        let (mut b, mut rx) = backend(None);
        b.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_DIB)]);
        assert!(rx.try_recv().is_err());
        b.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)]);
        assert!(matches!(
            rx.try_recv(),
            Ok(ClipboardEvent::Send(ClipboardMessage::SendInitiatePaste(id)))
                if id == ClipboardFormatId::CF_UNICODETEXT
        ));
        let data = FormatDataResponse::new_unicode_string("abc");
        b.on_format_data_response(data);
        assert!(matches!(rx.try_recv(), Ok(ClipboardEvent::RemoteText(t)) if t == "abc"));
    }

    #[test]
    fn answers_data_requests_from_local_text() {
        let (mut b, mut rx) = backend(Some("local"));
        b.on_format_data_request(FormatDataRequest {
            format: ClipboardFormatId::CF_UNICODETEXT,
        });
        let Ok(ClipboardEvent::Send(ClipboardMessage::SendFormatData(resp))) = rx.try_recv() else {
            panic!("expected format data");
        };
        assert_eq!(decode_unicode(resp.data()), "local");
        b.on_format_data_request(FormatDataRequest {
            format: ClipboardFormatId::CF_DIB,
        });
        assert!(matches!(
            rx.try_recv(),
            Ok(ClipboardEvent::Send(ClipboardMessage::SendFormatData(r))) if r.is_error()
        ));
    }
}
