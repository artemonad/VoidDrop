#[cfg(test)]
mod tests {
    use crate::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;
    use std::sync::Arc;

    async fn setup_test_app() -> Router {
        let app_state = AppState {
            rooms: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            trust_proxy: false,
            turn_shared_secret: Some("test_secret".to_string()),
            turn_server_url: Some("turn:test_url".to_string()),
            max_rooms: 1000,
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        };

        app_router(Arc::new(app_state))
    }

    #[test]
    fn test_room_allocation_and_management() {
        let state = AppState {
            rooms: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            trust_proxy: false,
            turn_shared_secret: Some("test_secret".to_string()),
            turn_server_url: Some("turn:test_url".to_string()),
            max_rooms: 1000,
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        };

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let room_id = "test-room-id";
            
            // Get non-existent room
            let tx1 = state.get_room(room_id).await;
            assert!(tx1.is_some());
            
            // Getting the same room again should return the same channel
            let tx2 = state.get_room(room_id).await;
            assert!(tx2.is_some());
            
            // Verify map size
            assert_eq!(state.rooms.len(), 1);
        });
    }

    #[tokio::test]
    async fn test_rate_limiter_blocks_abuse_on_signaling() {
        let app = setup_test_app().await;

        let mut hit_rate_limit = false;
        let test_room_uuid = uuid::Uuid::new_v4().to_string();

        for _ in 0..105 {
            let app_clone = app.clone();
            // Upgrading requests to WS route
            let response = app_clone
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri(format!("/ws/{}", test_room_uuid))
                        .header("cf-connecting-ip", "10.0.0.99")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            // When hit_rate_limit threshold (30 for WS) is exceeded, it should return TOO_MANY_REQUESTS
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                hit_rate_limit = true;
                break;
            }
        }

        assert!(
            hit_rate_limit,
            "Rate limiter did not block excessive requests on signaling route"
        );
    }

    #[tokio::test]
    async fn test_ws_handler_invalid_uuid() {
        let app = setup_test_app().await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/ws/invalid-room-uuid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_turn_credentials_validation() {
        let app = setup_test_app().await;

        // 1. Request without room_id -> 400 Bad Request
        let res_no_room = app.clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/turn-credentials")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_no_room.status(), StatusCode::BAD_REQUEST);

        // 2. Request with random room_id -> 403 Forbidden (since room doesn't exist/isn't active)
        let res_random_room = app.clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/turn-credentials?room_id=some-non-existent-room-uuid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_random_room.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn test_prometheus_metrics_endpoint() {
        let app = setup_test_app().await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/metrics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        
        let content_type = response.headers().get(axum::http::header::CONTENT_TYPE).unwrap();
        assert!(content_type.to_str().unwrap().contains("text/plain"));

        let body_bytes = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
        let body_str = String::from_utf8(body_bytes.to_vec()).unwrap();
        
        assert!(body_str.contains("voiddrop_active_rooms"));
        assert!(body_str.contains("voiddrop_ws_connections_total"));
        assert!(body_str.contains("voiddrop_rate_limit_triggers_total"));
    }

    #[tokio::test]
    async fn test_gc_sweeps_prunes_empty_rooms() {
        let rooms = Arc::new(DashMap::new());
        let (tx, _rx) = broadcast::channel(256);
        let room = Arc::new(Room {
            tx,
            buffer: std::sync::Mutex::new(VecDeque::new()),
        });
        
        rooms.insert("temp-room".to_string(), room);
        assert_eq!(rooms.len(), 1);

        // Simulated GC: prune rooms where strong_count is 1 (only DashMap holds the reference)
        rooms.retain(|_, room| Arc::strong_count(room) > 1);
        
        assert_eq!(rooms.len(), 0);
    }

    #[tokio::test]
    async fn test_gc_sweeps_keeps_active_rooms() {
        let rooms = Arc::new(DashMap::new());
        let (tx, _rx) = broadcast::channel(256);
        let room = Arc::new(Room {
            tx,
            buffer: std::sync::Mutex::new(VecDeque::new()),
        });
        
        rooms.insert("temp-room".to_string(), room.clone()); // cloned outside, strong_count is 2
        assert_eq!(rooms.len(), 1);

        // Simulated GC
        rooms.retain(|_, room| Arc::strong_count(room) > 1);
        
        assert_eq!(rooms.len(), 1);
    }

    #[tokio::test]
    async fn test_cors_preflight_request() {
        let app = setup_test_app().await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/api/turn-credentials")
                    .header("origin", "http://localhost:5173")
                    .header("access-control-request-method", "GET")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().contains_key("access-control-allow-origin"));
    }

    #[tokio::test]
    async fn test_cors_invalid_origin() {
        let app = setup_test_app().await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/health")
                    .header("origin", "http://malicious-site.com")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // In tower_http::cors, if origin doesn't match, the access-control-allow-origin header is not set.
        assert!(!response.headers().contains_key("access-control-allow-origin"));
    }

    #[tokio::test]
    async fn test_cors_valid_origin() {
        let app = setup_test_app().await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/health")
                    .header("origin", "http://localhost:5173")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.headers().get("access-control-allow-origin").unwrap(), "http://localhost:5173");
    }

    #[tokio::test]
    async fn test_rate_limiter_depletion_api() {
        // Setup rate limits with 0 tokens to trigger depletion immediately
        let app_state = Arc::new(AppState {
            rooms: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            trust_proxy: true,
            turn_shared_secret: Some("test_secret".to_string()),
            turn_server_url: Some("turn:test_url".to_string()),
            max_rooms: 1000,
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        });

        // Insert client ip bucket with 0.0 tokens
        app_state.rate_limits.insert("api:127.0.0.1".to_string(), RateLimitData {
            tokens: 0.0,
            last_updated: std::time::Instant::now(),
        });

        let app = app_router(app_state.clone());

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/turn-credentials?room_id=test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(app_state.rate_limit_triggers.load(std::sync::atomic::Ordering::Relaxed), 1);
    }

    #[test]
    fn test_rate_limiter_ipv6_masking() {
        use std::net::IpAddr;
        let ip1: IpAddr = "2001:db8:a0b:12f0::1".parse().unwrap();
        let ip2: IpAddr = "2001:db8:a0b:12f0:8675:5309:99:99".parse().unwrap();
        let ip_diff: IpAddr = "2001:db8:a0b:9999::1".parse().unwrap();

        let mask1 = middleware::normalize_ip_for_rate_limit(ip1);
        let mask2 = middleware::normalize_ip_for_rate_limit(ip2);
        let mask_diff = middleware::normalize_ip_for_rate_limit(ip_diff);

        // Same /64 network prefix must yield the same normalized IP string
        assert_eq!(mask1, mask2);
        assert_eq!(mask1, "2001:db8:a0b:12f0::/64");
        
        // Different prefix must yield different string
        assert_ne!(mask1, mask_diff);
    }

    #[tokio::test]
    async fn test_trust_proxy_cf_connecting_ip() {
        let app_state = Arc::new(AppState {
            rooms: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            trust_proxy: true,
            turn_shared_secret: Some("test_secret".to_string()),
            turn_server_url: Some("turn:test_url".to_string()),
            max_rooms: 1000,
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        });

        let app = app_router(app_state.clone());

        // We make a request with depleted CF-Connecting-IP
        app_state.rate_limits.insert("api:8.8.8.8".to_string(), RateLimitData {
            tokens: 0.0,
            last_updated: std::time::Instant::now(),
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/turn-credentials?room_id=test")
                    .header("cf-connecting-ip", "8.8.8.8")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // Limiter must block based on CF-Connecting-IP
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn test_trust_proxy_x_forwarded_for() {
        let app_state = Arc::new(AppState {
            rooms: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            trust_proxy: true,
            turn_shared_secret: Some("test_secret".to_string()),
            turn_server_url: Some("turn:test_url".to_string()),
            max_rooms: 1000,
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        });

        let app = app_router(app_state.clone());

        // First IP in X-Forwarded-For is client's real IP
        app_state.rate_limits.insert("api:9.9.9.9".to_string(), RateLimitData {
            tokens: 0.0,
            last_updated: std::time::Instant::now(),
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/turn-credentials?room_id=test")
                    .header("x-forwarded-for", "9.9.9.9, 10.0.0.1, 192.168.1.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn test_no_trust_proxy_ignores_headers() {
        let app_state = Arc::new(AppState {
            rooms: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            trust_proxy: false, // Do NOT trust proxy headers
            turn_shared_secret: Some("test_secret".to_string()),
            turn_server_url: Some("turn:test_url".to_string()),
            max_rooms: 1000,
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        });

        let app = app_router(app_state.clone());

        // Deplete the IP in CF-Connecting-IP
        app_state.rate_limits.insert("api:8.8.8.8".to_string(), RateLimitData {
            tokens: 0.0,
            last_updated: std::time::Instant::now(),
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/turn-credentials?room_id=test")
                    .header("cf-connecting-ip", "8.8.8.8")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // Should NOT be blocked because trust_proxy is false, so CF-Connecting-IP is ignored
        // and falls back to loopback or ConnectInfo address (which is not depleted).
        assert_ne!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn test_duplicate_room_allocation_under_capacity() {
        let state = AppState {
            rooms: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            trust_proxy: false,
            turn_shared_secret: None,
            turn_server_url: None,
            max_rooms: 10,
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        };

        let r1 = state.get_room("room-1").await.unwrap();
        let r2 = state.get_room("room-1").await.unwrap();

        // Both allocations must refer to the exact same channel/room
        assert!(Arc::ptr_eq(&r1, &r2));
        assert_eq!(state.rooms.len(), 1);
    }

    #[tokio::test]
    async fn test_room_allocation_max_capacity_reached() {
        let state = AppState {
            rooms: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            trust_proxy: false,
            turn_shared_secret: None,
            turn_server_url: None,
            max_rooms: 2, // Maximum 2 rooms allowed
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        };

        assert!(state.get_room("room-1").await.is_some());
        assert!(state.get_room("room-2").await.is_some());
        
        // Third allocation must fail because max capacity is 2
        assert!(state.get_room("room-3").await.is_none());
        assert_eq!(state.rooms.len(), 2);
    }

    #[tokio::test]
    async fn test_concurrent_ws_handshake_simulation() {
        let state = Arc::new(AppState {
            rooms: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            trust_proxy: false,
            turn_shared_secret: None,
            turn_server_url: None,
            max_rooms: 100,
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        });

        let mut handles = vec![];
        for _ in 0..10 {
            let state_clone = state.clone();
            handles.push(tokio::spawn(async move {
                state_clone.get_room("concurrent-room").await
            }));
        }

        let mut results = vec![];
        for h in handles {
            results.push(h.await.unwrap());
        }

        // Verify that all threads got a Room
        assert!(results.iter().all(|r| r.is_some()));
        
        // Verify that all rooms returned are the exact same room
        let first_room = results[0].as_ref().unwrap();
        for r in results.iter().skip(1) {
            assert!(Arc::ptr_eq(first_room, r.as_ref().unwrap()));
        }

        assert_eq!(state.rooms.len(), 1);
    }

    #[test]
    fn test_ws_connection_guard_increment_decrement() {
        let state = Arc::new(AppState {
            rooms: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            trust_proxy: false,
            turn_shared_secret: None,
            turn_server_url: None,
            max_rooms: 100,
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        });

        assert_eq!(state.ws_connections.load(std::sync::atomic::Ordering::Relaxed), 0);
        
        // Spawn guard in a scope
        {
            let _guard = handlers::ws::ConnectionGuard::new(state.clone());
            assert_eq!(state.ws_connections.load(std::sync::atomic::Ordering::Relaxed), 1);
        }

        // Out of scope, must decrement
        assert_eq!(state.ws_connections.load(std::sync::atomic::Ordering::Relaxed), 0);
    }
}
