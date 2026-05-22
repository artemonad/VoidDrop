use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade, CloseFrame, Utf8Bytes},
    },
    response::IntoResponse,
};
use tracing::warn;
use std::sync::Arc;
use std::collections::VecDeque;

use crate::AppState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(room_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Validate room_id format: must be a valid UUID (36 chars with hyphens)
    if uuid::Uuid::parse_str(&room_id).is_err() {
        return (axum::http::StatusCode::BAD_REQUEST, "Invalid room ID").into_response();
    }
    ws.max_frame_size(65536)
        .max_message_size(65536)
        .on_upgrade(move |socket| handle_socket(socket, state, room_id))
}

pub(crate) struct ConnectionGuard {
    pub(crate) state: Arc<AppState>,
}

impl ConnectionGuard {
    pub(crate) fn new(state: Arc<AppState>) -> Self {
        state.ws_connections.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self { state }
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.state.ws_connections.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, room_id: String) {
    let _guard = ConnectionGuard::new(state.clone());
    let room = match state.get_room(&room_id).await {
        Some(r) => r,
        None => {
            warn!("[WebRTC] Room limit reached, rejecting connection for room_id={}", room_id);
            let _ = socket.send(Message::Close(Some(CloseFrame {
                code: 1013,
                reason: Utf8Bytes::from_static("Room limit reached"),
            }))).await;
            return;
        }
    };
    let mut rx = room.tx.subscribe();

    // Unique ID for this connection to filter self-echo
    let my_id: u64 = rand::random();

    // Replay history buffer of signaling messages to the newly connected client
    let history = {
        match room.buffer.lock() {
            Ok(buf) => buf.clone(),
            Err(_) => VecDeque::new(),
        }
    };
    for (sender_id, data) in history {
        if sender_id == my_id {
            continue;
        }
        if socket.send(Message::Binary(data.into())).await.is_err() {
            return;
        }
    }

    let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(30));
    ping_interval.tick().await; // consume first immediate tick

    let mut last_activity = std::time::Instant::now();

    // Per-connection Rate Limiter (Token Bucket)
    let mut rate_tokens = 150.0;
    let mut rate_last_refill = std::time::Instant::now();

    loop {
        tokio::select! {
            _ = ping_interval.tick() => {
                if last_activity.elapsed() > std::time::Duration::from_secs(60) {
                    warn!("[WebRTC] Connection timed out (no activity for 60s), disconnecting room_id={}", room_id);
                    break;
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            msg = rx.recv() => {
                match msg {
                    Ok((sender_id, data)) => {
                        // Skip messages from ourselves
                        if sender_id == my_id {
                            continue;
                        }
                        if socket.send(Message::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        warn!("[WebRTC] Client lagged in room_id={}, skipping missed messages", room_id);
                        continue;
                    }
                    Err(_) => break,
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Binary(bin))) => {
                        last_activity = std::time::Instant::now();
                        let data = bin.to_vec();
                        match process_incoming_message(
                            data,
                            my_id,
                            &room,
                            &room_id,
                            &mut rate_tokens,
                            &mut rate_last_refill,
                        ) {
                            Ok(()) => {}
                            Err("rate_limit_exceeded") => {
                                state.rate_limit_triggers.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1008,
                                    reason: Utf8Bytes::from_static("Rate limit exceeded"),
                                }))).await;
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        last_activity = std::time::Instant::now();
                        let data = text.as_bytes().to_vec();
                        match process_incoming_message(
                            data,
                            my_id,
                            &room,
                            &room_id,
                            &mut rate_tokens,
                            &mut rate_last_refill,
                        ) {
                            Ok(()) => {}
                            Err("rate_limit_exceeded") => {
                                state.rate_limit_triggers.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1008,
                                    reason: Utf8Bytes::from_static("Rate limit exceeded"),
                                }))).await;
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {
                        last_activity = std::time::Instant::now();
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    drop(rx);

    // Clean up room immediately if empty to prevent memory/room capacity exhaustion DDoS attacks
    if room.tx.receiver_count() == 0 {
        state.rooms.remove_if(&room_id, |_, r| {
            Arc::ptr_eq(r, &room) && Arc::strong_count(r) <= 2
        });
    }
}

fn process_incoming_message(
    data: Vec<u8>,
    my_id: u64,
    room: &crate::Room,
    room_id: &str,
    rate_tokens: &mut f64,
    rate_last_refill: &mut std::time::Instant,
) -> Result<(), &'static str> {
    let now = std::time::Instant::now();
    let elapsed = now.duration_since(*rate_last_refill).as_secs_f64();
    const MAX_TOKENS: f64 = 150.0;
    const REFILL_RATE: f64 = 100.0; // 100 tokens per second

    *rate_tokens = (*rate_tokens + elapsed * REFILL_RATE).min(MAX_TOKENS);
    *rate_last_refill = now;

    if *rate_tokens < 1.0 {
        warn!("[WebRTC] Rate limit exceeded for connection in room_id={}, disconnecting", room_id);
        return Err("rate_limit_exceeded");
    }
    *rate_tokens -= 1.0;

    if data.len() > 65536 {
        warn!("[WebRTC] Oversized WS message ({} bytes) in room_id={}, disconnecting", data.len(), room_id);
        return Err("oversized_message");
    }

    if let Ok(mut buf) = room.buffer.lock() {
        buf.push_back((my_id, data.clone()));
        if buf.len() > 100 {
            buf.pop_front();
        }
    }
    let _ = room.tx.send((my_id, data));
    Ok(())
}
