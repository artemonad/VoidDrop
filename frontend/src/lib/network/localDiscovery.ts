import { isTauri } from '$lib/isTauri';

export interface DiscoveredPeer {
    sender_uuid: string;
    device_name: string;
    room_hash: string;
    ip: string;
    port: number;
}

export type PeerDiscoveryCallback = (peers: DiscoveredPeer[]) => void;
export type ConnectionRequestCallback = (req: {
    receiver_uuid: string;
    device_name: string;
    kyber_pk: number[];
    ip: string;
    port: number;
}) => void;
export type ConnectionApprovedCallback = (sender_uuid: string, encrypted_payload: number[]) => void;

class LocalDiscoveryEngine {
    private isRunning = false;
    private unlisteners: (() => void)[] = [];

    public async start(
        onPeersDiscovered: PeerDiscoveryCallback,
        onConnectionRequest?: ConnectionRequestCallback,
        onConnectionApproved?: ConnectionApprovedCallback
    ) {
        if (!isTauri()) return;
        if (this.isRunning) return;

        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const { listen } = await import('@tauri-apps/api/event');

            // Start UDP socket & listener threads
            await invoke('tauri_start_discovery');
            this.isRunning = true;

            // Peer discovered event
            const unlistenPeers = await listen<DiscoveredPeer[]>('tauri_local_peer_discovered', (event) => {
                onPeersDiscovered(event.payload);
            });
            this.unlisteners.push(unlistenPeers);

            // Connection request event
            if (onConnectionRequest) {
                const unlistenRequest = await listen<any>('tauri_connection_request_received', (event) => {
                    onConnectionRequest({
                        receiver_uuid: event.payload.receiver_uuid,
                        device_name: event.payload.device_name,
                        kyber_pk: event.payload.kyber_pk,
                        ip: event.payload.ip,
                        port: event.payload.port,
                    });
                });
                this.unlisteners.push(unlistenRequest);
            }

            // Connection approved event
            if (onConnectionApproved) {
                const unlistenApproved = await listen<any>('tauri_connection_approved_received', (event) => {
                    onConnectionApproved(event.payload.sender_uuid, event.payload.encrypted_payload);
                });
                this.unlisteners.push(unlistenApproved);
            }
        } catch (err) {
            console.error("Failed to start Local Discovery Engine:", err);
        }
    }

    public async broadcastRoomShare(roomHash: string, deviceName: string) {
        if (!isTauri()) return;
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('tauri_broadcast_room_share', { roomHash, deviceName }).catch(err => {
            console.error("Failed to broadcast room share:", err);
        });
    }

    public async stopRoomShare() {
        if (!isTauri()) return;
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('tauri_stop_room_share').catch(err => {
            console.error("Failed to stop room share:", err);
        });
    }

    public async sendConnectionRequest(targetIp: string, targetPort: number, kyberPk: Uint8Array, deviceName: string) {
        if (!isTauri()) return;
        const { invoke } = await import('@tauri-apps/api/core');
        const pkArray = Array.from(kyberPk);
        await invoke('tauri_send_connection_request', {
            targetIp,
            targetPort,
            kyberPk: pkArray,
            deviceName,
        }).catch(err => {
            console.error("Failed to send connection request:", err);
        });
    }

    public async approveConnection(targetIp: string, targetPort: number, encryptedPayload: Uint8Array) {
        if (!isTauri()) return;
        const { invoke } = await import('@tauri-apps/api/core');
        const payloadArray = Array.from(encryptedPayload);
        await invoke('tauri_approve_connection', {
            targetIp,
            targetPort,
            encryptedPayload: payloadArray,
        }).catch(err => {
            console.error("Failed to approve connection:", err);
        });
    }

    public async stop() {
        for (const unlisten of this.unlisteners) {
            unlisten();
        }
        this.unlisteners = [];
        this.isRunning = false;

        if (isTauri()) {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('tauri_stop_discovery');
            } catch (err) {
                console.error("Failed to stop Local Discovery Engine backend:", err);
            }
        }
    }
}

export const localDiscovery = new LocalDiscoveryEngine();
