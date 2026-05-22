use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, UdpSocket, Ipv4Addr};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use socket2::{Socket, Domain, Type, Protocol};
use log::error;

const MULTICAST_IP: Ipv4Addr = Ipv4Addr::new(239, 255, 42, 99);
const MULTICAST_PORT: u16 = 52310;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum DiscoveryPacket {
    #[serde(rename = "beacon")]
    Beacon {
        sender_uuid: String,
        device_name: String,
        room_hash: String,
        port: u16,
    },
    #[serde(rename = "connection_request")]
    ConnectionRequest {
        receiver_uuid: String,
        device_name: String,
        kyber_pk: Vec<u8>,
    },
    #[serde(rename = "connection_approved")]
    ConnectionApproved {
        sender_uuid: String,
        encrypted_payload: Vec<u8>,
    },
    #[serde(rename = "signal")]
    Signal {
        sender_uuid: String,
        payload: String, // Stringified JSON SignalMessage
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiscoveredPeer {
    pub sender_uuid: String,
    pub device_name: String,
    pub room_hash: String,
    pub ip: String,
    pub port: u16,
    pub last_seen: u64, // Unix timestamp in seconds
}

pub struct DiscoveryState {
    pub active_share: Arc<RwLock<Option<ActiveShare>>>,
    pub discovered_peers: Arc<RwLock<Vec<DiscoveredPeer>>>,
    pub socket: Arc<Mutex<Option<UdpSocket>>>,
    pub running: Arc<RwLock<bool>>,
    pub my_uuid: String,
}

#[derive(Clone, Debug)]
pub struct ActiveShare {
    pub room_hash: String,
    pub device_name: String,
}

impl DiscoveryState {
    pub fn new() -> Self {
        Self {
            active_share: Arc::new(RwLock::new(None)),
            discovered_peers: Arc::new(RwLock::new(Vec::new())),
            socket: Arc::new(Mutex::new(None)),
            running: Arc::new(RwLock::new(false)),
            my_uuid: generate_pseudo_uuid(), // Generate simple pseudo uuid
        }
    }
}

// Simple fallback UUID generator if uuid crate isn't preferred (since standard uuid crate might not be in Cargo.toml)
// Wait, we can generate a random string using standard system time or rand if we don't have uuid crate, 
// but actually, we can just use a simple pseudo-random string using SystemTime to avoid adding uuid dependency!
// Let's do that to avoid dependency issues.
fn generate_pseudo_uuid() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let rand_val = rand::random::<u128>();
    let mixed = secs ^ rand_val;
    format!("{:x}", mixed)
}

fn get_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn get_default_interface_ip() -> Option<Ipv4Addr> {
    // Briefly connect a UDP socket to a public address (e.g. 8.8.8.8:80) to determine the default active gateway adapter IP.
    // This doesn't actually send any data or require internet access, it just triggers the OS routing table lookup locally.
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let local_addr = socket.local_addr().ok()?;
    match local_addr.ip() {
        std::net::IpAddr::V4(ipv4) => Some(ipv4),
        _ => None,
    }
}

// Initialize the discovery listener and broadcaster
fn init_udp_socket() -> Result<UdpSocket, String> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
        .map_err(|e| format!("Failed to create socket: {}", e))?;
    
    #[cfg(not(windows))]
    socket.set_reuse_port(true).map_err(|e| format!("Failed to set reuse_port: {}", e))?;
    socket.set_reuse_address(true).map_err(|e| format!("Failed to set reuse_address: {}", e))?;

    let addr = SocketAddr::from(([0, 0, 0, 0], MULTICAST_PORT));
    socket.bind(&addr.into()).map_err(|e| format!("Failed to bind socket: {}", e))?;

    let interface_ip = get_default_interface_ip().unwrap_or_else(|| Ipv4Addr::new(0, 0, 0, 0));
    let udp_socket: UdpSocket = socket.into();
    udp_socket.join_multicast_v4(&MULTICAST_IP, &interface_ip)
        .map_err(|e| format!("Failed to join multicast group: {}", e))?;
    
    udp_socket.set_nonblocking(true)
        .map_err(|e| format!("Failed to set nonblocking: {}", e))?;

    Ok(udp_socket)
}

#[tauri::command]
pub fn tauri_start_discovery(app: AppHandle, state: State<'_, DiscoveryState>) -> Result<String, String> {
    let mut running = state.running.write().map_err(|_| "Failed to lock running state")?;
    if *running {
        return Ok("Discovery already running".to_string());
    }

    let socket = init_udp_socket()?;
    let socket_clone = socket.try_clone().map_err(|e| format!("Failed to clone socket: {}", e))?;

    {
        let mut socket_guard = state.socket.lock().map_err(|_| "Failed to lock socket")?;
        *socket_guard = Some(socket);
    }

    *running = true;

    // Spawn Listener Thread
    let discovered_peers = state.discovered_peers.clone();
    let running_flag = state.running.clone();
    let app_handle = app.clone();
    let my_uuid = state.my_uuid.clone();

    thread::spawn(move || {
        let mut buf = [0u8; 65535];
        while *running_flag.read().unwrap() {
            match socket_clone.recv_from(&mut buf) {
                Ok((size, src_addr)) => {
                    let data = &buf[..size];
                    if let Ok(packet) = serde_json::from_slice::<DiscoveryPacket>(data) {
                        handle_packet(packet, src_addr, &app_handle, &discovered_peers, &my_uuid);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // Periodic cleanup of stale peers (stale after 8 seconds)
                    cleanup_stale_peers(&app_handle, &discovered_peers);
                    thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    error!("Error receiving UDP packet: {}", e);
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });

    // Spawn Broadcaster Thread
    let active_share_broadcast = state.active_share.clone();
    let socket_broadcast = state.socket.clone();
    let running_broadcast = state.running.clone();
    let my_uuid_broadcast = state.my_uuid.clone();

    thread::spawn(move || {
        let dest = SocketAddr::from((MULTICAST_IP, MULTICAST_PORT));
        while *running_broadcast.read().unwrap() {
            let active = active_share_broadcast.read().unwrap().clone();
            if let Some(share) = active {
                let packet = DiscoveryPacket::Beacon {
                    sender_uuid: my_uuid_broadcast.clone(),
                    device_name: share.device_name.clone(),
                    room_hash: share.room_hash.clone(),
                    port: MULTICAST_PORT,
                };
                if let Ok(serialized) = serde_json::to_vec(&packet) {
                    let socket_guard = socket_broadcast.lock().unwrap();
                    if let Some(ref sock) = *socket_guard {
                        let _ = sock.send_to(&serialized, dest);
                    }
                }
            }
            thread::sleep(Duration::from_millis(2500));
        }
    });

    Ok("Discovery started successfully".to_string())
}

fn handle_packet(
    packet: DiscoveryPacket,
    src_addr: SocketAddr,
    app: &AppHandle,
    discovered_peers: &Arc<RwLock<Vec<DiscoveredPeer>>>,
    my_uuid: &str,
) {
    let src_ip = src_addr.ip().to_string();

    match packet {
        DiscoveryPacket::Beacon { sender_uuid, device_name, room_hash, port } => {
            if sender_uuid == my_uuid {
                return; // Ignore own beacons
            }

            let mut peers = discovered_peers.write().unwrap();
            let now = get_now_secs();
            let mut found = false;

            for peer in peers.iter_mut() {
                if peer.sender_uuid == sender_uuid {
                    peer.last_seen = now;
                    peer.room_hash = room_hash.clone();
                    peer.ip = src_ip.clone();
                    peer.port = port;
                    found = true;
                    break;
                }
            }

            if !found {
                peers.push(DiscoveredPeer {
                    sender_uuid,
                    device_name,
                    room_hash,
                    ip: src_ip,
                    port,
                    last_seen: now,
                });
            }

            // Emit the updated peer list to Svelte
            let _ = app.emit("tauri_local_peer_discovered", peers.clone());
        }
        DiscoveryPacket::ConnectionRequest { receiver_uuid, device_name, kyber_pk } => {
            // Emitted to Svelte so the sender user can authorize the download request
            let payload = serde_json::json!({
                "receiver_uuid": receiver_uuid,
                "device_name": device_name,
                "kyber_pk": kyber_pk,
                "ip": src_ip,
                "port": MULTICAST_PORT,
            });
            let _ = app.emit("tauri_connection_request_received", payload);
        }
        DiscoveryPacket::ConnectionApproved { sender_uuid, encrypted_payload } => {
            if sender_uuid == my_uuid {
                return;
            }
            // Emitted to Svelte receiver so it can decapsulate roomId/psk
            let payload = serde_json::json!({
                "sender_uuid": sender_uuid,
                "encrypted_payload": encrypted_payload,
            });
            let _ = app.emit("tauri_connection_approved_received", payload);
        }
        DiscoveryPacket::Signal { sender_uuid, payload } => {
            if sender_uuid == my_uuid {
                return;
            }
            // Relayed WebRTC signal
            let _ = app.emit("tauri_local_signal", payload);
        }
    }
}

fn cleanup_stale_peers(app: &AppHandle, discovered_peers: &Arc<RwLock<Vec<DiscoveredPeer>>>) {
    let now = get_now_secs();
    let mut peers = discovered_peers.write().unwrap();
    let len_before = peers.len();
    peers.retain(|peer| now - peer.last_seen < 8);

    if peers.len() != len_before {
        let _ = app.emit("tauri_local_peer_discovered", peers.clone());
    }
}

#[tauri::command]
pub fn tauri_broadcast_room_share(
    state: State<'_, DiscoveryState>,
    room_hash: String,
    device_name: String,
) -> Result<(), String> {
    let mut share = state.active_share.write().map_err(|_| "Failed to lock share state")?;
    *share = Some(ActiveShare { room_hash, device_name });
    Ok(())
}

#[tauri::command]
pub fn tauri_stop_room_share(state: State<'_, DiscoveryState>) -> Result<(), String> {
    let mut share = state.active_share.write().map_err(|_| "Failed to lock share state")?;
    *share = None;
    Ok(())
}

#[tauri::command]
pub fn tauri_stop_discovery(state: State<'_, DiscoveryState>) -> Result<String, String> {
    let mut running = state.running.write().map_err(|_| "Failed to lock running state")?;
    if !*running {
        return Ok("Discovery not running".to_string());
    }

    *running = false;

    // Clear active share
    if let Ok(mut share) = state.active_share.write() {
        *share = None;
    }

    // Drop the socket to close it and wake up recv_from (since it's nonblocking, the loop will exit cleanly)
    if let Ok(mut socket_guard) = state.socket.lock() {
        *socket_guard = None;
    }

    // Clear discovered peers
    if let Ok(mut peers) = state.discovered_peers.write() {
        peers.clear();
    }

    Ok("Discovery stopped successfully".to_string())
}

#[tauri::command]
pub fn tauri_send_connection_request(
    state: State<'_, DiscoveryState>,
    target_ip: String,
    target_port: u16,
    kyber_pk: Vec<u8>,
    device_name: String,
) -> Result<(), String> {
    let socket_guard = state.socket.lock().map_err(|_| "Failed to lock socket")?;
    if let Some(ref socket) = *socket_guard {
        let packet = DiscoveryPacket::ConnectionRequest {
            receiver_uuid: state.my_uuid.clone(),
            device_name,
            kyber_pk,
        };
        let serialized = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
        let dest = format!("{}:{}", target_ip, target_port);
        socket.send_to(&serialized, dest).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("UDP Socket not initialized. Run tauri_start_discovery first.".to_string())
    }
}

#[tauri::command]
pub fn tauri_approve_connection(
    state: State<'_, DiscoveryState>,
    target_ip: String,
    target_port: u16,
    encrypted_payload: Vec<u8>,
) -> Result<(), String> {
    let socket_guard = state.socket.lock().map_err(|_| "Failed to lock socket")?;
    if let Some(ref socket) = *socket_guard {
        let packet = DiscoveryPacket::ConnectionApproved {
            sender_uuid: state.my_uuid.clone(),
            encrypted_payload,
        };
        let serialized = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
        let dest = format!("{}:{}", target_ip, target_port);
        socket.send_to(&serialized, dest).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("UDP Socket not initialized.".to_string())
    }
}

#[tauri::command]
pub fn tauri_send_local_signal(
    state: State<'_, DiscoveryState>,
    target_ip: String,
    target_port: u16,
    payload: String,
) -> Result<(), String> {
    let socket_guard = state.socket.lock().map_err(|_| "Failed to lock socket")?;
    if let Some(ref socket) = *socket_guard {
        let packet = DiscoveryPacket::Signal {
            sender_uuid: state.my_uuid.clone(),
            payload,
        };
        let serialized = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
        let dest = format!("{}:{}", target_ip, target_port);
        socket.send_to(&serialized, dest).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("UDP Socket not initialized.".to_string())
    }
}

#[tauri::command]
pub fn tauri_get_my_uuid(state: State<'_, DiscoveryState>) -> String {
    state.my_uuid.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pseudo_uuid_generation() {
        let uuid1 = generate_pseudo_uuid();
        let uuid2 = generate_pseudo_uuid();
        assert!(!uuid1.is_empty());
        assert!(!uuid2.is_empty());
        // Simple assertion that successive calls within nanos produce valid hex strings
        assert!(u128::from_str_radix(&uuid1, 16).is_ok());
    }

    #[test]
    fn test_discovery_packet_serialization() {
        let beacon = DiscoveryPacket::Beacon {
            sender_uuid: "test-uuid-1".to_string(),
            device_name: "Test Phone".to_string(),
            room_hash: "room-abc".to_string(),
            port: 52310,
        };
        let serialized = serde_json::to_string(&beacon).unwrap();
        assert!(serialized.contains(r#""type":"beacon""#));
        assert!(serialized.contains(r#""sender_uuid":"test-uuid-1""#));

        let deserialized: DiscoveryPacket = serde_json::from_str(&serialized).unwrap();
        match deserialized {
            DiscoveryPacket::Beacon { sender_uuid, device_name, room_hash, port } => {
                assert_eq!(sender_uuid, "test-uuid-1");
                assert_eq!(device_name, "Test Phone");
                assert_eq!(room_hash, "room-abc");
                assert_eq!(port, 52310);
            }
            _ => panic!("Expected Beacon packet"),
        }

        let req = DiscoveryPacket::ConnectionRequest {
            receiver_uuid: "receiver-uuid".to_string(),
            device_name: "Receiver Laptop".to_string(),
            kyber_pk: vec![1, 2, 3, 4],
        };
        let serialized_req = serde_json::to_string(&req).unwrap();
        assert!(serialized_req.contains(r#""type":"connection_request""#));

        let deserialized_req: DiscoveryPacket = serde_json::from_str(&serialized_req).unwrap();
        match deserialized_req {
            DiscoveryPacket::ConnectionRequest { receiver_uuid, device_name, kyber_pk } => {
                assert_eq!(receiver_uuid, "receiver-uuid");
                assert_eq!(device_name, "Receiver Laptop");
                assert_eq!(kyber_pk, vec![1, 2, 3, 4]);
            }
            _ => panic!("Expected ConnectionRequest packet"),
        }
    }

    #[test]
    fn test_discovery_state_init() {
        let state = DiscoveryState::new();
        assert!(!state.my_uuid.is_empty());
        assert!(!*state.running.read().unwrap());
        assert!(state.active_share.read().unwrap().is_none());
        assert_eq!(state.discovered_peers.read().unwrap().len(), 0);
    }
}

