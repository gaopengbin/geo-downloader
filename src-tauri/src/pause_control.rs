//! Runtime-independent pause control shared by desktop and headless downloads.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone)]
pub struct PauseControl {
    pub flag: Arc<AtomicBool>,
    pub notify: Arc<Notify>,
}

impl Default for PauseControl {
    fn default() -> Self {
        Self::new()
    }
}

impl PauseControl {
    pub(crate) fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn is_paused(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    pub async fn wait_if_paused(&self) {
        loop {
            // Register before checking the flag so a concurrent resume cannot
            // notify between the check and await and leave this worker stuck.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.flag.load(Ordering::Relaxed) {
                return;
            }
            notified.await;
        }
    }
}
