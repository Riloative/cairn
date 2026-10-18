//! A connect timeout that does not count time spent waiting for the user.
//!
//! Host-key decisions and password/OTP prompts can take as long as the user needs; only
//! network time counts against `connect_timeout`.

use std::future::Future;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
pub struct PromptClock {
    waiting: AtomicU32,
    waited: Mutex<Duration>,
}

impl PromptClock {
    /// Run `fut` (a user interaction) with the timeout paused.
    pub async fn pause_during<F: Future>(&self, fut: F) -> F::Output {
        self.waiting.fetch_add(1, Ordering::SeqCst);
        let start = Instant::now();
        let out = fut.await;
        if let Ok(mut w) = self.waited.lock() {
            *w += start.elapsed();
        }
        self.waiting.fetch_sub(1, Ordering::SeqCst);
        out
    }

    fn waiting(&self) -> bool {
        self.waiting.load(Ordering::SeqCst) > 0
    }

    fn waited(&self) -> Duration {
        self.waited.lock().map(|w| *w).unwrap_or_default()
    }

    /// Like `tokio::time::timeout`, excluding paused time. `Err(())` on timeout.
    pub async fn timeout<F: Future>(&self, limit: Duration, fut: F) -> Result<F::Output, ()> {
        let start = Instant::now();
        tokio::pin!(fut);
        loop {
            tokio::select! {
                out = &mut fut => return Ok(out),
                () = tokio::time::sleep(Duration::from_millis(100)) => {
                    let spent = start.elapsed().saturating_sub(self.waited());
                    if !self.waiting() && spent > limit {
                        return Err(());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn times_out_without_prompts() {
        let c = PromptClock::default();
        let r = c
            .timeout(
                Duration::from_millis(200),
                tokio::time::sleep(Duration::from_secs(5)),
            )
            .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn completes_in_time() {
        let c = PromptClock::default();
        assert_eq!(c.timeout(Duration::from_secs(1), async { 7 }).await, Ok(7));
    }

    #[tokio::test]
    async fn prompt_time_is_not_counted() {
        let c = PromptClock::default();
        let work = async {
            // A 600 ms "user prompt" inside a 300 ms network budget.
            c.pause_during(tokio::time::sleep(Duration::from_millis(600)))
                .await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            "done"
        };
        assert_eq!(
            c.timeout(Duration::from_millis(300), work).await,
            Ok("done")
        );
    }
}
