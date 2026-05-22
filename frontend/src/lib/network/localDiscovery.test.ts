import { describe, it, expect, vi, beforeEach } from 'vitest';
import { localDiscovery, type DiscoveredPeer } from './localDiscovery';

// Mock isTauri to return true for testing
vi.mock('$lib/isTauri', () => ({
    isTauri: () => true
}));

// Mock Tauri APIs
const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: any) => mockInvoke(cmd, args)
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, handler: any) => mockListen(event, handler)
}));

describe('LocalDiscoveryEngine - Frontend Wrapper', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localDiscovery.stop();
    });

    it('should invoke tauri_start_discovery and set up listeners when starting', async () => {
        const mockUnlisten = vi.fn();
        mockListen.mockResolvedValue(mockUnlisten);
        mockInvoke.mockResolvedValue('OK');

        const peersCallback = vi.fn();
        const requestCallback = vi.fn();
        const approvedCallback = vi.fn();

        await localDiscovery.start(peersCallback, requestCallback, approvedCallback);

        expect(mockInvoke).toHaveBeenCalledWith('tauri_start_discovery', undefined);
        expect(mockListen).toHaveBeenCalledWith('tauri_local_peer_discovered', expect.any(Function));
        expect(mockListen).toHaveBeenCalledWith('tauri_connection_request_received', expect.any(Function));
        expect(mockListen).toHaveBeenCalledWith('tauri_connection_approved_received', expect.any(Function));
    });

    it('should map peers discovered event payloads properly', async () => {
        let triggerPeerDiscovered: any;
        mockListen.mockImplementation((event, handler) => {
            if (event === 'tauri_local_peer_discovered') {
                triggerPeerDiscovered = handler;
            }
            return Promise.resolve(vi.fn());
        });

        const peersCallback = vi.fn();
        await localDiscovery.start(peersCallback);

        const dummyPeers: DiscoveredPeer[] = [{
            sender_uuid: '123-uuid',
            device_name: "Phone",
            room_hash: "abc-hash",
            ip: "192.168.1.5",
            port: 52310
        }];

        triggerPeerDiscovered({ payload: dummyPeers });
        expect(peersCallback).toHaveBeenCalledWith(dummyPeers);
    });

    it('should map connection requests event payloads properly', async () => {
        let triggerConnRequest: any;
        mockListen.mockImplementation((event, handler) => {
            if (event === 'tauri_connection_request_received') {
                triggerConnRequest = handler;
            }
            return Promise.resolve(vi.fn());
        });

        const requestCallback = vi.fn();
        await localDiscovery.start(vi.fn(), requestCallback);

        const dummyRequest = {
            receiver_uuid: 'receiver-123',
            device_name: "Receiver Laptop",
            kyber_pk: [1, 2, 3],
            ip: "192.168.1.10",
            port: 52310
        };

        triggerConnRequest({ payload: dummyRequest });
        expect(requestCallback).toHaveBeenCalledWith(dummyRequest);
    });

    it('should map connection approved event payloads properly', async () => {
        let triggerApproved: any;
        mockListen.mockImplementation((event, handler) => {
            if (event === 'tauri_connection_approved_received') {
                triggerApproved = handler;
            }
            return Promise.resolve(vi.fn());
        });

        const approvedCallback = vi.fn();
        await localDiscovery.start(vi.fn(), vi.fn(), approvedCallback);

        triggerApproved({
            payload: {
                sender_uuid: 'sender-789',
                encrypted_payload: [9, 8, 7]
            }
        });
        expect(approvedCallback).toHaveBeenCalledWith('sender-789', [9, 8, 7]);
    });

    it('should correctly format arrays when sending connection request', async () => {
        const dummyPk = new Uint8Array([5, 6, 7]);
        await localDiscovery.sendConnectionRequest('192.168.1.5', 52310, dummyPk, 'My Phone');

        expect(mockInvoke).toHaveBeenCalledWith('tauri_send_connection_request', {
            targetIp: '192.168.1.5',
            targetPort: 52310,
            kyberPk: [5, 6, 7],
            deviceName: 'My Phone'
        });
    });

    it('should correctly format arrays when approving connection', async () => {
        const dummyEnvelope = new Uint8Array([10, 20, 30]);
        await localDiscovery.approveConnection('192.168.1.6', 52310, dummyEnvelope);

        expect(mockInvoke).toHaveBeenCalledWith('tauri_approve_connection', {
            targetIp: '192.168.1.6',
            targetPort: 52310,
            encryptedPayload: [10, 20, 30]
        });
    });

    it('should clean up all listeners when stopped', async () => {
        const mockUnlisten = vi.fn();
        mockListen.mockResolvedValue(mockUnlisten);

        await localDiscovery.start(vi.fn());
        localDiscovery.stop();

        expect(mockUnlisten).toHaveBeenCalled();
    });
});
