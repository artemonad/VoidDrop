use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use crate::AppState;

type HmacSha1 = Hmac<Sha1>;

#[derive(Serialize)]
pub struct TurnCredentialsResponse {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
    pub ttl: u64,
}

// We use crate::ErrorRes instead of a local ErrorResponse struct to avoid duplication

#[derive(Deserialize)]
pub struct TurnQuery {
    room_id: Option<String>,
}

pub async fn turn_credentials_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TurnQuery>,
) -> impl IntoResponse {
    let room_id = match query.room_id {
        Some(id) if !id.trim().is_empty() => id,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(crate::ErrorRes {
                    error: "Missing or invalid 'room_id' parameter".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Check if the room exists and has at least one active connection
    let room_valid = match state.rooms.get(&room_id) {
        Some(room) => {
            let conn_count = room.tx.receiver_count();
            conn_count > 0
        }
        None => false,
    };

    if !room_valid {
        return (
            StatusCode::FORBIDDEN,
            Json(crate::ErrorRes {
                error: "Access denied: TURN credentials are only available to active room participants".to_string(),
            }),
        )
            .into_response();
    }

    let secret = match &state.turn_shared_secret {
        Some(val) => val,
        None => {
            tracing::warn!("TURN_SHARED_SECRET is not configured on the backend.");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(crate::ErrorRes {
                    error: "TURN server shared secret not configured".to_string(),
                }),
            )
                .into_response();
        }
    };

    let server_url = match &state.turn_server_url {
        Some(val) => val,
        None => {
            tracing::warn!("TURN_SERVER_URL is not configured on the backend.");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(crate::ErrorRes {
                    error: "TURN server URL not configured".to_string(),
                }),
            )
                .into_response();
        }
    };

    // TTL = 15 minutes (900 seconds) - maximum safety against token reuse
    let ttl = 900;

    let now_secs = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs(),
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(crate::ErrorRes {
                    error: "System time error".to_string(),
                }),
            )
                .into_response();
        }
    };

    let expiration = now_secs + ttl;
    // Format username: "timestamp:arbitrary_username"
    // Using super-abstract username 'anon' for maximal privacy and to hide application name in TURN logs.
    let username = format!("{}:anon", expiration);

    // Compute HMAC-SHA1 signature using the static shared secret
    let mut mac = match HmacSha1::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("Failed to initialize HMAC-SHA1: {:?}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(crate::ErrorRes {
                    error: "HMAC initialization failed".to_string(),
                }),
            )
                .into_response();
        }
    };

    mac.update(username.as_bytes());
    let result = mac.finalize();
    let code_bytes = result.into_bytes();

    // Encode to Base64
    let credential = STANDARD.encode(code_bytes);

    // Prepare both UDP and TCP fallback urls
    let urls = vec![
        format!("{}", server_url),
        format!("{}?transport=tcp", server_url),
    ];

    (
        StatusCode::OK,
        Json(TurnCredentialsResponse {
            urls,
            username,
            credential,
            ttl,
        }),
    )
        .into_response()
}
