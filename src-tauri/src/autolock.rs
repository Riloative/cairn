//! Background auto-lock: locks the vault after the configured idle time and when the
//! system wakes from sleep.
//!
//! Sleep detection compares wall-clock time with the monotonic clock between ticks.
//! `Instant` does not advance while the machine is suspended (CLOCK_MONOTONIC on Linux,
//! mach_absolute_time on macOS) but `SystemTime` does, so a large gap means we slept.

use crate::state::AppState;
use cairn_core::audit::LockReason;
use cairn_core::{settings, VaultStatus};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

pub const TICK: Duration = Duration::from_secs(5);
/// Extra wall-clock time beyond the monotonic tick that counts as a suspend.
pub const SLEEP_GAP: Duration = Duration::from_secs(20);
/// Event emitted to the frontend when the vault locks itself.
pub const LOCKED_EVENT: &str = "vault://locked";

/// Decide whether to lock, given the elapsed clocks and settings.
pub fn should_lock(
    wall_elapsed: Duration,
    mono_elapsed: Duration,
    idle_for: Duration,
    auto_lock_minutes: u32,
    lock_on_sleep: bool,
) -> Option<LockReason> {
    if lock_on_sleep && wall_elapsed.saturating_sub(mono_elapsed) > SLEEP_GAP {
        return Some(LockReason::SystemSleep);
    }
    if auto_lock_minutes > 0 && idle_for >= Duration::from_secs(u64::from(auto_lock_minutes) * 60) {
        return Some(LockReason::Idle);
    }
    None
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_wall = SystemTime::now();
        let mut last_mono = Instant::now();
        loop {
            tokio::time::sleep(TICK).await;
            let now_wall = SystemTime::now();
            let now_mono = Instant::now();
            let wall_elapsed = now_wall.duration_since(last_wall).unwrap_or_default();
            let mono_elapsed = now_mono.duration_since(last_mono);
            last_wall = now_wall;
            last_mono = now_mono;
            check(&app, wall_elapsed, mono_elapsed, now_wall);
        }
    });
}

fn check(app: &AppHandle, wall_elapsed: Duration, mono_elapsed: Duration, now: SystemTime) {
    let state = app.state::<AppState>();
    let idle_for = now
        .duration_since(*state.last_activity.lock())
        .unwrap_or_default();
    let mut vault = state.vault.lock();
    if vault.status() != VaultStatus::Unlocked {
        return;
    }
    let Ok(s) = vault.with_conn(settings::load) else {
        return;
    };
    if let Some(reason) = should_lock(
        wall_elapsed,
        mono_elapsed,
        idle_for,
        s.auto_lock_minutes,
        s.lock_on_sleep,
    ) {
        if vault.lock(reason).is_ok() {
            // The frontend may be gone during shutdown; nothing to do if emit fails.
            let _ = app.emit(LOCKED_EVENT, reason);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_secs;

    #[test]
    fn no_lock_while_active() {
        assert_eq!(should_lock(S(5), S(5), S(60), 15, true), None);
    }

    #[test]
    fn idle_lock_after_timeout() {
        assert_eq!(
            should_lock(S(5), S(5), S(15 * 60), 15, true),
            Some(LockReason::Idle)
        );
        assert_eq!(should_lock(S(5), S(5), S(15 * 60 - 1), 15, true), None);
    }

    #[test]
    fn idle_lock_disabled_with_zero() {
        assert_eq!(should_lock(S(5), S(5), S(100_000), 0, true), None);
    }

    #[test]
    fn sleep_detected_from_clock_gap() {
        assert_eq!(
            should_lock(S(600), S(5), S(0), 0, true),
            Some(LockReason::SystemSleep)
        );
        assert_eq!(should_lock(S(600), S(5), S(0), 0, false), None);
        // Scheduler jitter is not a sleep.
        assert_eq!(should_lock(S(12), S(5), S(0), 0, true), None);
    }
}
