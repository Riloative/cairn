//! Physical key → RDP scancode mapping.
//!
//! The frontend sends `KeyboardEvent.code` values, which name the physical key
//! regardless of the local layout or OS. The server applies its own keyboard layout, so
//! sending scancodes (not characters) keeps shortcuts and dead keys working, including
//! on macOS where `key` values differ. Codes are set 1 scancodes; `0xE0xx` marks the
//! extended keys.

/// A set 1 scancode and whether it carries the `0xE0` extended prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyCode {
    pub code: u8,
    pub extended: bool,
}

const fn k(code: u8) -> Option<KeyCode> {
    Some(KeyCode {
        code,
        extended: false,
    })
}

const fn e(code: u8) -> Option<KeyCode> {
    Some(KeyCode {
        code,
        extended: true,
    })
}

/// Map a DOM `KeyboardEvent.code` to its scancode. `None` for keys RDP cannot send.
pub fn scancode(dom_code: &str) -> Option<KeyCode> {
    match dom_code {
        "Escape" => k(0x01),
        "Digit1" => k(0x02),
        "Digit2" => k(0x03),
        "Digit3" => k(0x04),
        "Digit4" => k(0x05),
        "Digit5" => k(0x06),
        "Digit6" => k(0x07),
        "Digit7" => k(0x08),
        "Digit8" => k(0x09),
        "Digit9" => k(0x0A),
        "Digit0" => k(0x0B),
        "Minus" => k(0x0C),
        "Equal" => k(0x0D),
        "Backspace" => k(0x0E),
        "Tab" => k(0x0F),
        "KeyQ" => k(0x10),
        "KeyW" => k(0x11),
        "KeyE" => k(0x12),
        "KeyR" => k(0x13),
        "KeyT" => k(0x14),
        "KeyY" => k(0x15),
        "KeyU" => k(0x16),
        "KeyI" => k(0x17),
        "KeyO" => k(0x18),
        "KeyP" => k(0x19),
        "BracketLeft" => k(0x1A),
        "BracketRight" => k(0x1B),
        "Enter" => k(0x1C),
        "ControlLeft" => k(0x1D),
        "KeyA" => k(0x1E),
        "KeyS" => k(0x1F),
        "KeyD" => k(0x20),
        "KeyF" => k(0x21),
        "KeyG" => k(0x22),
        "KeyH" => k(0x23),
        "KeyJ" => k(0x24),
        "KeyK" => k(0x25),
        "KeyL" => k(0x26),
        "Semicolon" => k(0x27),
        "Quote" => k(0x28),
        "Backquote" => k(0x29),
        "ShiftLeft" => k(0x2A),
        "Backslash" => k(0x2B),
        "KeyZ" => k(0x2C),
        "KeyX" => k(0x2D),
        "KeyC" => k(0x2E),
        "KeyV" => k(0x2F),
        "KeyB" => k(0x30),
        "KeyN" => k(0x31),
        "KeyM" => k(0x32),
        "Comma" => k(0x33),
        "Period" => k(0x34),
        "Slash" => k(0x35),
        "ShiftRight" => k(0x36),
        "NumpadMultiply" => k(0x37),
        "AltLeft" => k(0x38),
        "Space" => k(0x39),
        "CapsLock" => k(0x3A),
        "F1" => k(0x3B),
        "F2" => k(0x3C),
        "F3" => k(0x3D),
        "F4" => k(0x3E),
        "F5" => k(0x3F),
        "F6" => k(0x40),
        "F7" => k(0x41),
        "F8" => k(0x42),
        "F9" => k(0x43),
        "F10" => k(0x44),
        "NumLock" => k(0x45),
        "ScrollLock" => k(0x46),
        "Numpad7" => k(0x47),
        "Numpad8" => k(0x48),
        "Numpad9" => k(0x49),
        "NumpadSubtract" => k(0x4A),
        "Numpad4" => k(0x4B),
        "Numpad5" => k(0x4C),
        "Numpad6" => k(0x4D),
        "NumpadAdd" => k(0x4E),
        "Numpad1" => k(0x4F),
        "Numpad2" => k(0x50),
        "Numpad3" => k(0x51),
        "Numpad0" => k(0x52),
        "NumpadDecimal" => k(0x53),
        "IntlBackslash" => k(0x56),
        "F11" => k(0x57),
        "F12" => k(0x58),
        "NumpadEqual" => k(0x59),
        "F13" => k(0x64),
        "F14" => k(0x65),
        "F15" => k(0x66),
        "F16" => k(0x67),
        "F17" => k(0x68),
        "F18" => k(0x69),
        "F19" => k(0x6A),
        "KanaMode" => k(0x70),
        "IntlRo" => k(0x73),
        "Convert" => k(0x79),
        "NonConvert" => k(0x7B),
        "IntlYen" => k(0x7D),
        "NumpadComma" => k(0x7E),
        "NumpadEnter" => e(0x1C),
        "ControlRight" => e(0x1D),
        "AudioVolumeMute" => e(0x20),
        "AudioVolumeDown" => e(0x2E),
        "AudioVolumeUp" => e(0x30),
        "NumpadDivide" => e(0x35),
        "PrintScreen" => e(0x37),
        "AltRight" => e(0x38),
        "Home" => e(0x47),
        "ArrowUp" => e(0x48),
        "PageUp" => e(0x49),
        "ArrowLeft" => e(0x4B),
        "ArrowRight" => e(0x4D),
        "End" => e(0x4F),
        "ArrowDown" => e(0x50),
        "PageDown" => e(0x51),
        "Insert" => e(0x52),
        "Delete" => e(0x53),
        // Windows keys; the macOS Command keys arrive as these codes.
        "MetaLeft" | "OSLeft" => e(0x5B),
        "MetaRight" | "OSRight" => e(0x5C),
        "ContextMenu" => e(0x5D),
        _ => None,
    }
}

/// Left Ctrl, left Alt and Delete: the Ctrl+Alt+Del chord.
pub const CTRL: KeyCode = KeyCode {
    code: 0x1D,
    extended: false,
};
pub const ALT: KeyCode = KeyCode {
    code: 0x38,
    extended: false,
};
pub const DELETE: KeyCode = KeyCode {
    code: 0x53,
    extended: true,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_letters_digits_and_modifiers() {
        assert_eq!(scancode("KeyA"), k(0x1E));
        assert_eq!(scancode("Digit0"), k(0x0B));
        assert_eq!(scancode("ShiftLeft"), k(0x2A));
        assert_eq!(scancode("ControlLeft"), Some(CTRL));
    }

    #[test]
    fn marks_extended_keys() {
        for code in [
            "ArrowUp",
            "Delete",
            "ControlRight",
            "AltRight",
            "NumpadEnter",
        ] {
            assert!(scancode(code).is_some_and(|k| k.extended), "{code}");
        }
        assert_eq!(scancode("Delete"), Some(DELETE));
        // Numpad digits are not extended, unlike the navigation block.
        assert_eq!(scancode("Numpad8"), k(0x48));
        assert_eq!(scancode("ArrowUp"), e(0x48));
    }

    #[test]
    fn macos_command_is_the_windows_key() {
        assert_eq!(scancode("MetaLeft"), e(0x5B));
        assert_eq!(scancode("MetaRight"), e(0x5C));
    }

    #[test]
    fn unknown_codes_are_ignored() {
        assert_eq!(scancode("Fn"), None);
        assert_eq!(scancode(""), None);
    }
}
