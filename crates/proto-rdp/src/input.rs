//! Input events from the session view and their translation to RDP input operations.

use crate::keymap;
use ironrdp::input::{MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use serde::Deserialize;

/// One input event, in desktop coordinates.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RdpInput {
    /// A physical key by its DOM `KeyboardEvent.code`.
    Key {
        code: String,
        down: bool,
    },
    Move {
        x: u16,
        y: u16,
    },
    /// DOM `MouseEvent.button`: 0 left, 1 middle, 2 right, 3 back, 4 forward.
    Button {
        button: u8,
        down: bool,
    },
    /// Wheel rotation in RDP units (120 per notch), positive away from the user.
    Wheel {
        vertical: bool,
        units: i16,
    },
    /// Release every pressed key and button (focus lost).
    ReleaseAll,
}

/// The largest rotation the wheel field encodes.
const MAX_WHEEL: i16 = 255;

impl RdpInput {
    /// The operation for this event; `None` for unmapped keys and for `ReleaseAll`,
    /// which the input database handles itself.
    pub fn operation(&self) -> Option<Operation> {
        Some(match self {
            RdpInput::Key { code, down } => {
                let key = keymap::scancode(code)?;
                let scancode = scancode_of(key);
                if *down {
                    Operation::KeyPressed(scancode)
                } else {
                    Operation::KeyReleased(scancode)
                }
            }
            RdpInput::Move { x, y } => Operation::MouseMove(MousePosition { x: *x, y: *y }),
            RdpInput::Button { button, down } => {
                let button = MouseButton::from_web_button(*button)?;
                if *down {
                    Operation::MouseButtonPressed(button)
                } else {
                    Operation::MouseButtonReleased(button)
                }
            }
            RdpInput::Wheel { vertical, units } => Operation::WheelRotations(WheelRotations {
                is_vertical: *vertical,
                rotation_units: (*units).clamp(-MAX_WHEEL, MAX_WHEEL),
            }),
            RdpInput::ReleaseAll => return None,
        })
    }
}

pub(crate) fn scancode_of(key: keymap::KeyCode) -> Scancode {
    Scancode::from_u8(key.extended, key.code)
}

/// The Ctrl+Alt+Del chord: press all three, then release in reverse.
pub(crate) fn ctrl_alt_del() -> Vec<Operation> {
    let keys = [keymap::CTRL, keymap::ALT, keymap::DELETE].map(scancode_of);
    keys.iter()
        .map(|&k| Operation::KeyPressed(k))
        .chain(keys.iter().rev().map(|&k| Operation::KeyReleased(k)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> RdpInput {
        serde_json::from_str(json).expect("valid input")
    }

    #[test]
    fn parses_view_events() {
        assert_eq!(
            parse(r#"{"kind":"key","code":"KeyA","down":true}"#),
            RdpInput::Key {
                code: "KeyA".into(),
                down: true
            }
        );
        assert_eq!(
            parse(r#"{"kind":"move","x":10,"y":20}"#),
            RdpInput::Move { x: 10, y: 20 }
        );
        assert_eq!(parse(r#"{"kind":"releaseAll"}"#), RdpInput::ReleaseAll);
    }

    #[test]
    fn maps_keys_buttons_and_wheel() {
        let key = RdpInput::Key {
            code: "Delete".into(),
            down: false,
        };
        assert!(matches!(
            key.operation(),
            Some(Operation::KeyReleased(k)) if k == Scancode::from_u8(true, 0x53)
        ));
        let unknown = RdpInput::Key {
            code: "Fn".into(),
            down: true,
        };
        assert!(unknown.operation().is_none());
        assert!(matches!(
            RdpInput::Button {
                button: 2,
                down: true
            }
            .operation(),
            Some(Operation::MouseButtonPressed(MouseButton::Right))
        ));
        assert!(matches!(
            RdpInput::Wheel {
                vertical: true,
                units: -1000
            }
            .operation(),
            Some(Operation::WheelRotations(WheelRotations {
                is_vertical: true,
                rotation_units: -255
            }))
        ));
    }

    #[test]
    fn ctrl_alt_del_presses_then_releases_in_reverse() {
        let ops = ctrl_alt_del();
        assert_eq!(ops.len(), 6);
        let (ctrl, del) = (
            Scancode::from_u8(false, 0x1D),
            Scancode::from_u8(true, 0x53),
        );
        assert!(matches!(ops[0], Operation::KeyPressed(k) if k == ctrl));
        assert!(matches!(ops[2], Operation::KeyPressed(k) if k == del));
        assert!(matches!(ops[3], Operation::KeyReleased(k) if k == del));
        assert!(matches!(ops[5], Operation::KeyReleased(k) if k == ctrl));
    }
}
