use serde_json::Value;
use tokio::sync::mpsc;

#[async_trait::async_trait]
pub(crate) trait DshClient: Send + Sync {
    fn next_request_id(&self) -> u64;
    fn is_closed(&self) -> bool;
    async fn request(&self, value: Value) -> Result<Value, String>;
    async fn subscribe(&self, thread_id: &str, run_id: &str) -> mpsc::UnboundedReceiver<Value>;
    async fn unsubscribe(&self, thread_id: &str, run_id: &str);
    async fn shutdown(&self);
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use tokio::sync::Mutex;

    pub(crate) struct FakeDshClient {
        next_id: AtomicU64,
        closed: AtomicBool,
        responses: Mutex<VecDeque<Result<Value, String>>>,
    }
    impl FakeDshClient {
        pub(crate) fn new(responses: Vec<Result<Value, String>>) -> Self {
            Self {
                next_id: AtomicU64::new(1),
                closed: AtomicBool::new(false),
                responses: Mutex::new(responses.into()),
            }
        }
    }
    #[async_trait::async_trait]
    impl DshClient for FakeDshClient {
        fn next_request_id(&self) -> u64 {
            self.next_id.fetch_add(1, Ordering::Relaxed)
        }
        fn is_closed(&self) -> bool {
            self.closed.load(Ordering::Acquire)
        }
        async fn request(&self, _value: Value) -> Result<Value, String> {
            self.responses
                .lock()
                .await
                .pop_front()
                .unwrap_or_else(|| Err("no fake response".into()))
        }
        async fn subscribe(
            &self,
            _thread_id: &str,
            _run_id: &str,
        ) -> mpsc::UnboundedReceiver<Value> {
            let (_tx, rx) = mpsc::unbounded_channel();
            rx
        }
        async fn unsubscribe(&self, _thread_id: &str, _run_id: &str) {}
        async fn shutdown(&self) {
            self.closed.store(true, Ordering::Release);
        }
    }

    #[tokio::test]
    async fn fake_preserves_response_order_and_shutdown_state() {
        let client = FakeDshClient::new(vec![Ok(serde_json::json!({"one":1})), Err("two".into())]);
        assert_eq!(client.request(Value::Null).await.unwrap()["one"], 1);
        assert_eq!(client.request(Value::Null).await.unwrap_err(), "two");
        client.shutdown().await;
        assert!(client.is_closed());
    }
}
