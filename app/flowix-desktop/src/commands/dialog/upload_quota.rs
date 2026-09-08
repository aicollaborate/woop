use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) static UPLOAD_QUOTA: UploadQuota = UploadQuota::new(2);

pub(super) struct UploadQuota {
    active: AtomicUsize,
    limit: usize,
}

impl UploadQuota {
    pub(super) const fn new(limit: usize) -> Self {
        Self {
            active: AtomicUsize::new(0),
            limit,
        }
    }

    pub(super) fn acquire(&self) -> Result<UploadPermit<'_>, String> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < self.limit).then_some(active + 1)
            })
            .map_err(|_| "ATTACHMENT_BUSY".to_string())?;
        Ok(UploadPermit(self))
    }
}

pub(super) struct UploadPermit<'quota>(&'quota UploadQuota);

impl Drop for UploadPermit<'_> {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excess_uploads_fail_without_a_queue_and_release_on_drop() {
        let quota = UploadQuota::new(1);
        let permit = quota.acquire().unwrap();
        assert!(quota.acquire().is_err());
        drop(permit);
        assert!(quota.acquire().is_ok());
    }

    #[test]
    fn failed_operations_release_their_permits() {
        let quota = UploadQuota::new(1);
        let operation = || -> Result<(), String> {
            let _permit = quota.acquire()?;
            Err("failed".to_string())
        };
        assert!(operation().is_err());
        assert!(quota.acquire().is_ok());
    }
}
