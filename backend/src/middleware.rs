use axum::{
    extract::{ConnectInfo, Json, Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;

use crate::{AppState, ErrorRes, RateLimitData};

/// Normalize an IP string to a rate-limit bucket key.
/// IPv4 addresses are used as-is.
/// IPv6 addresses are masked to /64 prefix to prevent trivial bypass
/// via cheap VPS subnets where each request uses a different address.
pub(crate) fn normalize_ip_for_rate_limit(addr: IpAddr) -> String {
    match addr {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            // Keep only the first 4 segments (64 bits) — the network prefix
            format!(
                "{:x}:{:x}:{:x}:{:x}::/64",
                segments[0], segments[1], segments[2], segments[3]
            )
        }
    }
}

pub async fn rate_limit_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let trust_proxy = state.trust_proxy;

    let client_ip = if trust_proxy {
        if let Some(ip_str) = req
            .headers()
            .get("cf-connecting-ip")
            .and_then(|h| h.to_str().ok())
        {
            ip_str.parse::<IpAddr>().ok()
        } else if let Some(ip_str) = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|h| h.to_str().ok())
        {
            ip_str
                .split(',')
                .next()
                .and_then(|s| s.trim().parse::<IpAddr>().ok())
        } else {
            None
        }
    } else {
        None
    };

    let resolved_ip = client_ip
        .or_else(|| {
            req.extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ConnectInfo(addr)| addr.ip())
        })
        .unwrap_or_else(|| IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)));

    let ip = normalize_ip_for_rate_limit(resolved_ip);

    let path = req.uri().path();
    let is_ws = path.starts_with("/ws/");

    // Separate buckets for API and WS to prevent API traffic from blocking signaling
    let bucket_key = if is_ws {
        format!("ws:{}", ip)
    } else {
        format!("api:{}", ip)
    };

    let capacity = if is_ws { 30.0 } else { 100.0 };
    let refill_rate_sec = 60.0;

    {
        let mut entry = state
            .rate_limits
            .entry(bucket_key)
            .or_insert(RateLimitData {
                tokens: capacity,
                last_updated: Instant::now(),
            });

        let now = Instant::now();
        let elapsed = now.duration_since(entry.last_updated).as_secs_f64();

        let new_tokens = entry.tokens + (elapsed * (capacity / refill_rate_sec));
        entry.tokens = new_tokens.min(capacity);
        entry.last_updated = now;

        if entry.tokens < 1.0 {
            state.rate_limit_triggers.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return (
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                Json(ErrorRes {
                    error: "Too Many Requests".into(),
                }),
            )
                .into_response();
        }

        entry.tokens -= 1.0;
    }

    next.run(req).await
}
