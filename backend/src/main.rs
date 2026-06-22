use axum::http::Method;
use axum::{
    Router,
    routing::get,
    response::IntoResponse,
    extract::State,
};
use dashmap::DashMap;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use std::collections::VecDeque;
use tracing::{info, warn, error};

pub(crate) mod handlers;
pub(crate) mod middleware;

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub(crate) struct RateLimitData {
    pub tokens: f64,
    pub last_updated: Instant,
}

pub(crate) struct Room {
    pub tx: broadcast::Sender<(u64, Vec<u8>)>,
    pub buffer: std::sync::Mutex<VecDeque<(u64, Vec<u8>)>>,
}

pub(crate) struct AppState {
    pub rooms: Arc<DashMap<String, Arc<Room>>>,
    pub rate_limits: Arc<DashMap<String, RateLimitData>>,
    pub trust_proxy: bool,
    pub turn_shared_secret: Option<String>,
    pub turn_server_url: Option<String>,
    pub max_rooms: usize,
    pub ws_connections: std::sync::atomic::AtomicUsize,
    pub rate_limit_triggers: std::sync::atomic::AtomicUsize,
    pub rooms_created: std::sync::atomic::AtomicUsize,
    pub turn_requests: std::sync::atomic::AtomicUsize,
}

impl AppState {
    pub async fn get_room(&self, room_id: &str) -> Option<Arc<Room>> {
        // Fast path: room already exists
        if let Some(room) = self.rooms.get(room_id) {
            return Some(room.value().clone());
        }

        // Check capacity before acquiring the entry lock to avoid DashMap deadlock
        // (DashMap::len() iterates all shards and would deadlock if called while
        // holding a shard write lock from entry())
        if self.rooms.len() >= self.max_rooms {
            return None;
        }

        // Slow path: atomically insert inside DashMap's entry API
        match self.rooms.entry(room_id.to_string()) {
            dashmap::Entry::Occupied(e) => Some(e.get().clone()),
            dashmap::Entry::Vacant(e) => {
                let (tx, _rx) = broadcast::channel(256);
                let room = Arc::new(Room {
                    tx,
                    buffer: std::sync::Mutex::new(VecDeque::new()),
                });
                e.insert(room.clone());
                self.rooms_created.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Some(room)
            }
        }
    }
}

// Shared error response type
#[derive(Serialize)]
pub(crate) struct ErrorRes {
    pub error: String,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=info,axum=info".into()),
        )
        .init();

    let trust_proxy = std::env::var("TRUST_PROXY")
        .map(|v| v.to_lowercase() == "true")
        .unwrap_or(false);

    let turn_shared_secret = std::env::var("TURN_SHARED_SECRET").ok();
    let turn_server_url = std::env::var("TURN_SERVER_URL").ok();

    let max_rooms = std::env::var("MAX_ROOMS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1000);

    let app_state = Arc::new(AppState {
        rooms: Arc::new(DashMap::new()),
        rate_limits: Arc::new(DashMap::new()),
        trust_proxy,
        turn_shared_secret,
        turn_server_url,
        max_rooms,
        ws_connections: std::sync::atomic::AtomicUsize::new(0),
        rate_limit_triggers: std::sync::atomic::AtomicUsize::new(0),
        rooms_created: std::sync::atomic::AtomicUsize::new(0),
        turn_requests: std::sync::atomic::AtomicUsize::new(0),
    });

    // Rate limit cleanup task
    let limits_clone = app_state.rate_limits.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(600)).await;
            let now = Instant::now();
            limits_clone.retain(|_, data| now.duration_since(data.last_updated).as_secs() < 600);
        }
    });

    // Room GC — prune empty rooms every 5 minutes
    let rooms_clone = app_state.rooms.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            let before = rooms_clone.len();
            rooms_clone.retain(|_, room| Arc::strong_count(room) > 1);
            let pruned = before - rooms_clone.len();
            if pruned > 0 {
                info!(
                    "Pruned {} empty rooms ({} remaining)",
                    pruned,
                    rooms_clone.len()
                );
            }
        }
    });

    // Periodic stats logging task (every 10 minutes)
    let stats_state = app_state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(600)).await;
            let active_rooms = stats_state.rooms.len();
            let ws_connections = stats_state.ws_connections.load(std::sync::atomic::Ordering::Relaxed);
            let rate_limit_triggers = stats_state.rate_limit_triggers.load(std::sync::atomic::Ordering::Relaxed);
            let rooms_created = stats_state.rooms_created.load(std::sync::atomic::Ordering::Relaxed);
            let turn_requests = stats_state.turn_requests.load(std::sync::atomic::Ordering::Relaxed);

            info!(
                "VoidDrop Stats Summary -> Active Rooms: {}, WS Connections: {}, Rooms Created: {}, TURN Requests: {}, Rate Limit Triggers: {}",
                active_rooms, ws_connections, rooms_created, turn_requests, rate_limit_triggers
            );
        }
    });

    let app = app_router(app_state.clone());

    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3300);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Server running on 0.0.0.0:{}", port);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("Failed to bind to 0.0.0.0:{}: {}", port, e);
            if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(10013) {
                warn!(
                    "\n=======================================================\n\
                     WINDOWS PORT BIND EXCLUSION DETECTED (WSAEACCES 10013)\n\
                     -------------------------------------------------------\n\
                     Windows Hyper-V/WinNAT has excluded this port range.\n\
                     To fix this permanently, you can run as Admin:\n\
                       net stop winnat\n\
                       net start winnat\n\
                     Alternatively, you can choose a different port by setting\n\
                     the PORT environment variable (e.g. PORT=3301).\n\
                     =======================================================\n"
                );
            }
            // Fallback attempt on a safe alternative port
            let fallback_port = if port == 3300 { 3301 } else { port + 1 };
            let fallback_addr = SocketAddr::from(([127, 0, 0, 1], fallback_port));
            info!("Attempting fallback bind on local loopback 127.0.0.1:{}...", fallback_port);
            match tokio::net::TcpListener::bind(fallback_addr).await {
                Ok(l) => {
                    info!("Bound to fallback 127.0.0.1:{}", fallback_port);
                    l
                }
                Err(err) => {
                    panic!("Fatal: Failed to bind to fallback address 127.0.0.1:{}: {}", fallback_port, err);
                }
            }
        }
    };

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .unwrap();

    // Print final statistics on shutdown
    let active_rooms = app_state.rooms.len();
    let ws_connections = app_state.ws_connections.load(std::sync::atomic::Ordering::Relaxed);
    let rate_limit_triggers = app_state.rate_limit_triggers.load(std::sync::atomic::Ordering::Relaxed);
    let rooms_created = app_state.rooms_created.load(std::sync::atomic::Ordering::Relaxed);
    let turn_requests = app_state.turn_requests.load(std::sync::atomic::Ordering::Relaxed);

    info!(
        "VoidDrop Shutdown. Final Stats -> Active Rooms: {}, WS Connections: {}, Rooms Created: {}, TURN Requests: {}, Rate Limit Triggers: {}",
        active_rooms, ws_connections, rooms_created, turn_requests, rate_limit_triggers
    );
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            info!("Shutdown signal received (Ctrl+C). Gracefully shutting down...");
        },
        _ = terminate => {
            info!("Shutdown signal received (SIGTERM). Gracefully shutting down...");
        },
    }
}

async fn metrics_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let active_rooms = state.rooms.len();
    let ws_connections = state.ws_connections.load(std::sync::atomic::Ordering::Relaxed);
    let rate_limit_triggers = state.rate_limit_triggers.load(std::sync::atomic::Ordering::Relaxed);
    let rooms_created = state.rooms_created.load(std::sync::atomic::Ordering::Relaxed);
    let turn_requests = state.turn_requests.load(std::sync::atomic::Ordering::Relaxed);

    let metrics_data = format!(
        "# HELP voiddrop_active_rooms The total number of active signaling rooms.\n\
         # TYPE voiddrop_active_rooms gauge\n\
         voiddrop_active_rooms {}\n\
         # HELP voiddrop_ws_connections_total The total number of active websocket connections.\n\
         # TYPE voiddrop_ws_connections_total gauge\n\
         voiddrop_ws_connections_total {}\n\
         # HELP voiddrop_rate_limit_triggers_total The total number of times rate limits were triggered.\n\
         # TYPE voiddrop_rate_limit_triggers_total counter\n\
         voiddrop_rate_limit_triggers_total {}\n\
         # HELP voiddrop_rooms_created_total The total number of rooms created since startup.\n\
         # TYPE voiddrop_rooms_created_total counter\n\
         voiddrop_rooms_created_total {}\n\
         # HELP voiddrop_turn_requests_total The total number of TURN credentials requests.\n\
         # TYPE voiddrop_turn_requests_total counter\n\
         voiddrop_turn_requests_total {}\n",
        active_rooms, ws_connections, rate_limit_triggers, rooms_created, turn_requests
    );

    (
        [(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        metrics_data,
    )
}

pub(crate) fn app_router(state: Arc<AppState>) -> Router {
    let cors_origins_str = std::env::var("CORS_ORIGINS").unwrap_or_else(|_| {
        "http://localhost:5173,http://localhost:1420,http://127.0.0.1:1420,http://127.0.0.1:5173,https://voiddrop.ru,tauri://localhost,http://tauri.localhost".to_string()
    });
    let origins: Vec<axum::http::HeaderValue> = cors_origins_str
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::OPTIONS])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::ACCEPT,
            axum::http::header::RANGE,
        ])
        .expose_headers([axum::http::header::ETAG]);

    Router::new()
        .route("/api/turn-credentials", get(handlers::turn::turn_credentials_handler))
        .route("/ws/{room_id}", get(handlers::ws::ws_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::rate_limit_middleware,
        ))
        .route("/health", get(|| async { "OK" }))
        .route("/metrics", get(metrics_handler))
        .with_state(state)
        .layer(cors)
}
