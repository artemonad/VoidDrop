import { encode, decode } from 'cbor-x';
import { env } from '$env/dynamic/public';

function parseCandidate(candStr: string) {
    if (!candStr) return { ip: 'hidden', port: 0 };
    const parts = candStr.trim().split(/\s+/);
    // Format: candidate:foundation component protocol priority connection-address port typ type ...
    // E.g. "candidate:842163049 1 udp 16777215 172.93.108.210 64996 typ srflx ..."
    if (parts.length >= 6) {
        let ip = parts[4];
        let port = parseInt(parts[5], 10) || 0;
        return { ip, port };
    }
    return { ip: 'hidden', port: 0 };
}

// Type Definitions
export interface SignalMessage {
    v: 1;
    rid: string;
    sid: string;
    seq: number;
    type: 'offer' | 'answer' | 'ice' | 'close';
    payload: any; // Raw RTCSessionDescriptionInit or RTCIceCandidateInit
}

export type WebRTCStateCallback = (state: string) => void;
export type WebRTCFrameCallback = (type: number, payload: Uint8Array) => void;

export class WebRTCConnection {
    private pc: RTCPeerConnection;
    private dcControl: RTCDataChannel;
    private dcData: RTCDataChannel;
    private ws?: WebSocket;

    private roomId: string;
    private psk: Uint8Array;
    private myUuid: string;

    private wsConnectAttempts = 0;
    private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private isClosed = false;

    private lastSeenSequence: Map<string, number> = new Map();
    private outgoingSeq = 0;

    private makingOffer = false;
    private ignoreOffer = false;
    private polite: boolean;
    private hmacKey: CryptoKey | null = null;
    private apiBase!: string;

    private localTarget?: { ip: string; port: number };
    private unlistenLocalSignal?: () => void;
    private pendingSignals: Uint8Array[] = [];

    private lastActivePairId: string | null = null;
    private remoteCandidatesQueue: RTCIceCandidateInit[] = [];
    private turnCredentialsPromise: Promise<void>;
    private signalingQueue: Promise<void> = Promise.resolve();

    // Callbacks
    public onStateChange?: WebRTCStateCallback;
    public onFrame?: WebRTCFrameCallback;
    public onLog?: (msg: string) => void;

    private log(msg: string) {
        if (this.onLog) {
            this.onLog(msg);
        } else {
            console.log(`[WebRTC] ${msg}`);
        }
    }

    constructor(roomId: string, psk: Uint8Array, localTarget?: { ip: string; port: number }, apiBase?: string) {
        this.roomId = roomId;
        this.psk = psk;
        this.myUuid = crypto.randomUUID();
        this.polite = false;

        const base = apiBase || env.PUBLIC_API_BASE || 'https://api.voiddrop.ru';
        this.apiBase = base.replace(/\/$/, '');

        const iceServers: RTCIceServer[] = [
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ];

        // Setup PeerConnection
        this.pc = new RTCPeerConnection({ iceServers });

        // Pre-agreed DataChannel
        this.dcControl = this.pc.createDataChannel('voiddrop_control', {
            negotiated: true,
            id: 0,
            ordered: true
        });
        this.dcData = this.pc.createDataChannel('voiddrop_data', {
            negotiated: true,
            id: 1,
            ordered: true
        });

        this.setupPeerConnection();
        this.setupDataChannel();

        if (localTarget) {
            this.localTarget = localTarget;
            this.turnCredentialsPromise = Promise.resolve();
            this.setupLocalSignaling();
        } else {
            const wsBase = this.apiBase.replace('https://', 'wss://').replace('http://', 'ws://');
            this.ws = new WebSocket(`${wsBase}/ws/${this.roomId}`);
            this.turnCredentialsPromise = Promise.resolve(); // Will be fetched asynchronously on WebSocket open to prevent 403
            this.setupWebSocket();
        }
    }

    private async fetchAndApplyTurnCredentials() {
        try {
            const apiBase = this.apiBase;
            this.log(`[ICE] Fetching dynamic TURN credentials from ${apiBase}/api/turn-credentials...`);
            const res = await fetch(`${apiBase}/api/turn-credentials?room_id=${encodeURIComponent(this.roomId)}`);
            if (!res.ok) {
                throw new Error(`Failed to fetch TURN credentials: ${res.status} ${res.statusText}`);
            }
            const data = await res.json();
            
            if (data && data.urls && data.username && data.credential) {
                const currentConfig = this.pc.getConfiguration();
                const currentIceServers = currentConfig.iceServers || [];
                
                const turnServers: RTCIceServer[] = [];
                for (const url of data.urls) {
                    turnServers.push({
                        urls: url,
                        username: data.username,
                        credential: data.credential
                    });
                }
                
                const mergedIceServers = [...currentIceServers, ...turnServers];
                this.pc.setConfiguration({
                    ...currentConfig,
                    iceServers: mergedIceServers
                });
                
                this.log(`[ICE] Applied dynamic TURN credentials. Active ICE servers updated.`);

                // Force WebView2 or the browser to immediately start gathering TURN candidates if negotiation has started
                if (this.pc.signalingState !== 'stable' || this.pc.iceConnectionState === 'failed' || this.pc.iceGatheringState !== 'new') {
                    this.log(`[ICE] Restarting ICE gathering to utilize newly added TURN servers.`);
                    try {
                        this.pc.restartIce();
                    } catch (err) {
                        console.warn("[WebRTC] Failed to restart ICE:", err);
                    }
                }
            }
        } catch (err) {
            console.error("[WebRTC] Error fetching dynamic TURN credentials:", err);
            this.log(`[ICE] Warning: Could not fetch dynamic TURN credentials. Relying on STUN/Direct connection.`);
        }
    }

    private async setupLocalSignaling() {
        if (this.onStateChange) this.onStateChange('UDP Signaling: CONNECTING');
        
        try {
            const { listen } = await import('@tauri-apps/api/event');
            this.unlistenLocalSignal = await listen<string>('tauri_local_signal', (event) => {
                try {
                    const packetArray = JSON.parse(event.payload) as number[];
                    const packet = new Uint8Array(packetArray);
                    this.signalingQueue = this.signalingQueue.then(() => this.processIncomingSignal(packet, true));
                } catch (err) {
                    console.error("Local negotiation queueing failed", err);
                }
            });

            if (this.onStateChange) this.onStateChange('UDP Signaling: LISTENING');
            this.negotiate();
            this.startNegotiationRetry();
        } catch (err) {
            console.error("Failed to setup local signaling:", err);
            if (this.onStateChange) this.onStateChange('UDP Signaling: ERROR');
        }
    }

    private setupPeerConnection() {
        this.pc.onicecandidate = async ({ candidate }) => {
            if (candidate) {
                const candStr = candidate.candidate || '';
                const type = candStr.includes('typ host') ? 'LAN/Host' :
                             candStr.includes('typ srflx') ? 'STUN/Internet' :
                             candStr.includes('typ relay') ? 'TURN/Proxy' : 'Unknown';
                const parsed = parseCandidate(candStr);
                const finalPort = candidate.port ?? parsed.port;
                this.log(`[ICE] Gathered local candidate (${type}): ${parsed.ip}:${finalPort} (${candidate.protocol})`);
                await this.sendSignal({
                    type: 'ice',
                    payload: candidate.toJSON(),
                    sid: this.myUuid
                });
            }
        };

        this.pc.onconnectionstatechange = () => {
            if (this.onStateChange) this.onStateChange(`PeerConnection: ${this.pc.connectionState}`);
        };

        this.pc.oniceconnectionstatechange = () => {
            if (this.pc.iceConnectionState === 'failed') {
                this.pc.restartIce();
            }
        };

        this.pc.onnegotiationneeded = () => {
            this.negotiate();
        };
    }

    private setupDataChannel() {
        this.dcControl.binaryType = 'arraybuffer';
        this.dcData.binaryType = 'arraybuffer';

        this.dcData.onopen = () => {
            if (this.onStateChange) this.onStateChange('DataChannel: OPEN');
        };

        this.dcData.onclose = () => {
            if (this.onStateChange) this.onStateChange('DataChannel: CLOSED');
        };

        this.dcControl.onerror = (e: any) => {
            const err = e?.error;
            if (err && err.name === 'OperationError' && err.message?.includes('Close called')) {
                return; // Ignore normal programmatic close events
            }
            console.error('DataChannel Control error:', e);
        };
        this.dcData.onerror = (e: any) => {
            const err = e?.error;
            if (err && err.name === 'OperationError' && err.message?.includes('Close called')) {
                return; // Ignore normal programmatic close events
            }
            console.error('DataChannel Data error:', e);
        };

        this.dcControl.onmessage = (event) => {
            if (this.onFrame && event.data instanceof ArrayBuffer) {
                const buffer = new Uint8Array(event.data);
                if (buffer.length < 1) return;
                const type = buffer[0];
                const payload = buffer.slice(1);
                this.onFrame(type, payload);
            }
        };

        this.dcData.onmessage = (event) => {
            if (this.onFrame && event.data instanceof ArrayBuffer) {
                const buffer = new Uint8Array(event.data);
                this.onFrame(0x04, buffer); // 0x04 is Data Chunk
            }
        };
    }

    private setupWebSocket() {
        if (!this.ws) return;
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.wsConnectAttempts = 0;
            if (this.wsReconnectTimer) {
                clearTimeout(this.wsReconnectTimer);
                this.wsReconnectTimer = null;
            }

            if (this.onStateChange) this.onStateChange('WebSocket: CONNECTED');
            
            // Asynchronously fetch and apply dynamic TURN credentials now that the signaling room is active on backend
            this.turnCredentialsPromise = this.fetchAndApplyTurnCredentials();
            
            // Flush buffered signals
            if (this.pendingSignals.length > 0) {
                this.log(`Flushing ${this.pendingSignals.length} pending signals...`);
                for (const sig of this.pendingSignals) {
                    this.ws!.send(sig as any);
                }
                this.pendingSignals = [];
            }

            // If onnegotiationneeded already fired and created an offer before WS was ready,
            // re-send the pending offer now that WS is open
            if (this.pc.signalingState === 'have-local-offer' && this.pc.localDescription) {
                this.sendSignal({
                    type: 'offer',
                    payload: { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp },
                    sid: this.myUuid
                });
            } else {
                this.negotiate();
            }
            this.startNegotiationRetry();
        };

        this.ws.onerror = () => {
            if (this.onStateChange) this.onStateChange('WebSocket: ERROR (Backend Offline?)');
        };

        this.ws.onclose = () => {
            if (this.onStateChange) this.onStateChange('WebSocket: CLOSED');
            this.reconnectWebSocket();
        };

        this.ws.onmessage = (event) => {
            const buffer = new Uint8Array(event.data as ArrayBuffer);
            this.signalingQueue = this.signalingQueue.then(() => this.processIncomingSignal(buffer, false));
        };
    }

    private reconnectWebSocket() {
        if (this.isClosed) return;
        if (this.dcData.readyState === 'open' || this.pc.connectionState === 'connected') {
            return;
        }
        if (this.wsConnectAttempts >= 5) {
            this.log("[Signaling] WS Reconnection limit reached. Giving up.");
            return;
        }

        this.wsConnectAttempts++;
        this.log(`[Signaling] WebSocket closed before P2P established. Reconnecting (Attempt ${this.wsConnectAttempts}/5) in 2s...`);
        
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => {
            if (this.isClosed || this.dcData.readyState === 'open' || this.pc.connectionState === 'connected') return;
            const wsBase = this.apiBase.replace('https://', 'wss://').replace('http://', 'ws://');
            this.ws = new WebSocket(`${wsBase}/ws/${this.roomId}`);
            this.setupWebSocket();
        }, 2000);
    }

    private async processIncomingSignal(packet: Uint8Array, isLocalUdp = false) {
        // Guard Active Connections: if we are already connected, ignore incoming signaling to prevent stale replays
        if (this.pc.connectionState === 'connected' && this.dcData.readyState === 'open') {
            return;
        }

        const msg = await this.verifyAndDecodeSignal(packet);
        if (!msg) return;
        if (msg.sid === this.myUuid) return; // Ignore own echoed messages

        const lastSeq = this.lastSeenSequence.get(msg.sid) ?? 0;
        if (msg.seq <= lastSeq) {
            this.log(`[Signaling] Discarding out-of-order/duplicate signal (seq: ${msg.seq}, lastSeen: ${lastSeq}) from peer ${msg.sid}`);
            return;
        }
        this.lastSeenSequence.set(msg.sid, msg.seq);

        // Compare UUIDs to determine polite peer dynamically
        this.polite = this.myUuid > msg.sid;

        try {
            if (msg.type === 'offer' || msg.type === 'answer') {
                const description = msg.payload;

                // Safeguard against InvalidStateError when receiving duplicate answers
                if (msg.type === 'answer' && this.pc.signalingState === 'stable') {
                    return;
                }

                const offerCollision = msg.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');

                this.ignoreOffer = !this.polite && offerCollision;
                if (this.ignoreOffer) {
                    return;
                }

                // Explicit rollback for polite peer on offer collision (safety net for legacy browsers)
                if (offerCollision) {
                    if (this.pc.signalingState !== 'stable') {
                        await this.pc.setLocalDescription({ type: "rollback", sdp: "" });
                    }
                    await this.setRemoteDescriptionAndFlushCandidates(description);
                } else {
                    await this.setRemoteDescriptionAndFlushCandidates(description);
                }

                // SDP exchange complete — stop retrying
                if (msg.type === 'answer') {
                    this.stopNegotiationRetry();
                }

                if (msg.type === 'offer') {
                    await this.pc.setLocalDescription();
                    await this.sendSignal({
                        type: 'answer',
                        payload: { type: this.pc.localDescription!.type, sdp: this.pc.localDescription!.sdp },
                        sid: this.myUuid
                    });
                    // We answered their offer — stop retrying, SDP is done
                    this.stopNegotiationRetry();
                }
            } else if (msg.type === 'ice') {
                try {
                    const cand = msg.payload;
                    const candStr = cand.candidate || '';
                    const type = candStr.includes('typ host') ? 'LAN/Host' :
                                 candStr.includes('typ srflx') ? 'STUN/Internet' :
                                 candStr.includes('typ relay') ? 'TURN/Proxy' : 'Unknown';
                    const parsed = parseCandidate(candStr);
                    const finalPort = cand.port ?? parsed.port;
                    this.log(`[ICE] Received remote candidate ${isLocalUdp ? '(LocalUDP)' : ''} (${type}): ${parsed.ip}:${finalPort}`);
                    if (this.pc.remoteDescription) {
                        await this.pc.addIceCandidate(msg.payload);
                    } else {
                        this.remoteCandidatesQueue.push(msg.payload);
                        this.log(`[ICE] Queued remote candidate ${isLocalUdp ? '(LocalUDP)' : ''} (${type}) since remoteDescription is not set.`);
                    }
                } catch (err) {
                    if (!this.ignoreOffer) console.error("Bad ICE candidate", err);
                }
            }
        } catch (err) {
            console.error("Perfect negotiation failed", err);
        }
    }

    private async setRemoteDescriptionAndFlushCandidates(description: RTCSessionDescriptionInit) {
        await this.pc.setRemoteDescription(description);
        this.log(`[ICE] Remote description set successfully. Flushing ${this.remoteCandidatesQueue.length} queued remote candidates.`);
        for (const cand of this.remoteCandidatesQueue) {
            try {
                await this.pc.addIceCandidate(cand);
            } catch (err) {
                if (!this.ignoreOffer) console.error("Failed to add queued ICE candidate", err);
            }
        }
        this.remoteCandidatesQueue = [];
    }

    private async negotiate() {
        if (this.pc.signalingState !== 'stable') {
            return;
        }
        try {
            this.makingOffer = true;
            await this.pc.setLocalDescription();
            await this.sendSignal({
                type: 'offer',
                payload: { type: this.pc.localDescription!.type, sdp: this.pc.localDescription!.sdp },
                sid: this.myUuid
            });
        } catch (err) {
            console.error("Negotiation error:", err);
        } finally {
            this.makingOffer = false;
        }
    }

    private negotiationTimer: ReturnType<typeof setInterval> | null = null;

    private stopNegotiationRetry() {
        if (this.negotiationTimer) {
            clearInterval(this.negotiationTimer);
            this.negotiationTimer = null;
        }
    }

    private startNegotiationRetry() {
        this.stopNegotiationRetry();
        let attempts = 0;
        this.negotiationTimer = setInterval(() => {
            attempts++;
            if (this.dcData.readyState === 'open' 
                || this.pc.connectionState === 'connected' 
                || attempts > 15) {
                // Connected or gave up — stop retrying
                this.stopNegotiationRetry();
                return;
            }
            // Re-send existing offer if stuck in have-local-offer, or create new one
            if (this.pc.signalingState === 'have-local-offer' && this.pc.localDescription) {
                this.sendSignal({
                    type: 'offer',
                    payload: { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp },
                    sid: this.myUuid
                });
            } else {
                this.negotiate();
            }
        }, 4000);
    }

    private async getHmacKey(): Promise<CryptoKey> {
        if (this.hmacKey) return this.hmacKey;
        const keyMaterial = await crypto.subtle.importKey(
            "raw",
            this.psk as BufferSource,
            "HKDF",
            false,
            ["deriveKey"]
        );
        this.hmacKey = await crypto.subtle.deriveKey(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: new Uint8Array(),
                info: new TextEncoder().encode("signaling-mac"),
            },
            keyMaterial,
            { name: "HMAC", hash: "SHA-256", length: 256 },
            false,
            ["sign", "verify"]
        );
        return this.hmacKey;
    }

    private async sendSignal(msg: Omit<SignalMessage, 'seq' | 'v' | 'rid'>) {
        this.outgoingSeq++;
        const msgWithMeta: SignalMessage = {
            v: 1,
            rid: this.roomId,
            ...msg,
            seq: this.outgoingSeq
        };
        // Strict typing for browser crypto.subtle
        const payload = new Uint8Array(encode(msgWithMeta));

        const key = await this.getHmacKey();
        const macBuffer = await crypto.subtle.sign("HMAC", key, payload);
        const mac = new Uint8Array(macBuffer);

        // Final packet: 32 bytes MAC + CBOR Payload
        const packet = new Uint8Array(32 + payload.length);
        packet.set(mac, 0);
        packet.set(payload, 32);

        if (this.localTarget) {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const packetArray = Array.from(packet);
                await invoke('tauri_send_local_signal', {
                    targetIp: this.localTarget.ip,
                    targetPort: this.localTarget.port,
                    payload: JSON.stringify(packetArray)
                });
            } catch (err) {
                console.error("Failed to send local UDP signal:", err);
            }
        } else if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(packet as any);
            } else if (this.ws.readyState === WebSocket.CONNECTING) {
                this.pendingSignals.push(packet);
            }
        }
    }

    private async verifyAndDecodeSignal(packet: Uint8Array): Promise<SignalMessage | null> {
        if (packet.length < 32) return null;

        const mac = packet.slice(0, 32);
        const payload = packet.slice(32);

        const key = await this.getHmacKey();

        const isValid = await crypto.subtle.verify("HMAC", key, mac, payload);
        if (!isValid) {
            console.error("Invalid signaling MAC. Discarding injected/tampered packet.");
            return null;
        }

        return decode(payload) as SignalMessage;
    }

    public sendFrame(type: number, payload: Uint8Array) {
        if (this.dcControl && this.dcControl.readyState === 'open') {
            const frame = new Uint8Array(1 + payload.length);
            frame[0] = type;
            frame.set(payload, 1);
            this.dcControl.send(frame);
        } else {
            console.warn("DataChannel Control not open, state:", this.dcControl?.readyState);
        }
    }

    public sendData(payload: Uint8Array) {
        if (this.dcData && this.dcData.readyState === 'open') {
            this.dcData.send(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer);
        } else {
            console.warn("DataChannel Data not open, state:", this.dcData?.readyState);
        }
    }

    public getBufferedAmount(): number {
        return this.dcData ? this.dcData.bufferedAmount : 0;
    }

    public async getConnectionType(): Promise<'local' | 'p2p' | 'relay' | 'unknown'> {
        try {
            const stats = await this.pc.getStats();
            let activePairId: string | null = null;
            
            for (const [_, report] of stats) {
                if (report.type === 'transport' && report.selectedCandidatePairId) {
                    activePairId = report.selectedCandidatePairId;
                    break;
                }
            }
            
            if (!activePairId) {
                for (const [_, report] of stats) {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                        activePairId = report.id;
                        break;
                    }
                }
            }
            
            if (activePairId && activePairId !== this.lastActivePairId) {
                this.lastActivePairId = activePairId;
                const activePair = stats.get(activePairId);
                if (activePair) {
                    const localCandidate = stats.get(activePair.localCandidateId);
                    const remoteCandidate = stats.get(activePair.remoteCandidateId);
                    if (localCandidate && remoteCandidate) {
                        const localIp = localCandidate.ip || localCandidate.address || 'unknown';
                        const remoteIp = remoteCandidate.ip || remoteCandidate.address || 'unknown';
                        const lType = localCandidate.candidateType || 'unknown';
                        const rType = remoteCandidate.candidateType || 'unknown';
                        const lProtocol = localCandidate.protocol || 'udp';
                        
                        let pathMsg = '';
                        if (lType === 'relay' || rType === 'relay') {
                            pathMsg = `Relay/Proxy via TURN Server (traffic is proxied)`;
                        } else if (lType === 'host' && rType === 'host') {
                            pathMsg = `Direct local network (LAN / Offline Loop)`;
                        } else {
                            pathMsg = `Direct P2P Internet hole-punching`;
                        }
                        
                        this.log(`[Route] Path Established: ${pathMsg}`);
                        this.log(`[Route] Local (${lType}): ${localIp}:${localCandidate.port} (${lProtocol}) <-> Remote (${rType}): ${remoteIp}:${remoteCandidate.port}`);
                    }
                }
            }
            
            if (!activePairId) return 'unknown';
            
            const activePair = stats.get(activePairId);
            if (!activePair) return 'unknown';
            
            const localCandidate = stats.get(activePair.localCandidateId);
            const remoteCandidate = stats.get(activePair.remoteCandidateId);
            
            if (!localCandidate || !remoteCandidate) return 'unknown';
            
            const localType = localCandidate.candidateType;
            const remoteType = remoteCandidate.candidateType;
            
            if (localType === 'relay' || remoteType === 'relay') {
                return 'relay';
            }
            
            if (localType === 'host' && remoteType === 'host') {
                const isPrivate = (ip: string) => {
                    if (!ip) return false;
                    return ip.startsWith('192.168.') || 
                           ip.startsWith('10.') || 
                           ip.startsWith('127.') || 
                           ip.startsWith('localhost') ||
                           /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
                           ip.startsWith('fe80::') ||
                           ip.includes('.local');
                };
                
                const localIp = localCandidate.ip || localCandidate.address || '';
                const remoteIp = remoteCandidate.ip || remoteCandidate.address || '';
                
                if (isPrivate(localIp) || isPrivate(remoteIp)) {
                    return 'local';
                }
            }
            
            return 'p2p';
        } catch (err) {
            console.error("Failed to get connection type stats:", err);
            return 'unknown';
        }
    }

    public close() {
        this.isClosed = true;
        this.stopNegotiationRetry();
        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = null;
        }
        this.dcControl?.close();
        this.dcData?.close();
        this.pc.close();
        if (this.ws) this.ws.close();
        if (this.unlistenLocalSignal) {
            this.unlistenLocalSignal();
        }
    }
}