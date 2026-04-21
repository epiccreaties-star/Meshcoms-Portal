/**
 * MeshtasticModule — Self-contained Meshtastic protocol handler.
 *
 * Supports:
 *   - Serial: Web Serial API via TransportWebSerial (@meshtastic/transport-web-serial)
 *   - WiFi:   TCP via localhost WebSocket proxy  →  ws://127.0.0.1:<PROXY>?host=IP&port=PORT
 *             The launcher.py provides a WebSocket-to-TCP bridge so the browser
 *             can reach the Meshtastic node's TCP port (default 4403) directly.
 *
 * Usage in orchestrator:
 *   import { MeshtasticModule } from './modules/MeshtasticModule.js';
 *   registerModule(MeshtasticModule);
 */
import { ProtocolModule } from './ProtocolModule.js';
import { MeshDevice } from '@meshtastic/core';
import { TransportWebSerial } from '@meshtastic/transport-web-serial';

export class MeshtasticModule extends ProtocolModule {

    // ─── Module metadata ──────────────────────────────────────────────────────

    static get protocolId() { return 'meshtastic'; }
    static get label()      { return 'Meshtastic Node'; }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(options) {
        super(options);
        this.learnedNodeId  = null;
        this.lastSentText   = null;
        this.lastSentTime   = 0;
        this._wsSocket      = null;
        this._heartbeatId   = null;
    }

    // ─── Public connect ───────────────────────────────────────────────────────

    /**
     * @param {'serial'|'wifi'} connectionType
     * @param {{ host?: string, port?: number }} [opts]
     */
    async connect(connectionType, opts = {}) {
        this._connectionType = connectionType;
        if (connectionType === 'serial') {
            await this._connectSerial();
        } else if (connectionType === 'wifi') {
            await this._connectWifi(opts);
        } else {
            throw new Error(`Unknown connection type: ${connectionType}`);
        }
    }

    // ─── Serial ───────────────────────────────────────────────────────────────

    async _connectSerial() {
        if (!navigator.serial) throw new Error('Web Serial API is not supported in this browser.');

        let transport;
        try {
            transport = await TransportWebSerial.create(115200);
        } catch (err) {
            if (err.message?.includes('already open')) {
                console.warn('[Meshtastic] Port already open — attempting rescue...');
                const ports = await navigator.serial.getPorts();
                if (ports.length > 0) {
                    transport = await TransportWebSerial.createFromPort(ports[0], 115200).catch(() => null);
                }
            }
            if (!transport) throw err;
        }

        // Ensure transport has the properties MeshDevice expects (fromDevice/toDevice)
        if (transport.readable && !transport.fromDevice) transport.fromDevice = transport.readable;
        if (transport.writable && !transport.toDevice)   transport.toDevice   = transport.writable;

        this.device = new MeshDevice(transport);
        this._attachEvents();
        
        if (typeof this.device.connect === 'function') {
            await this.device.connect();
        }

        if (typeof this.device.configure === 'function') {
            await this.device.configure();
            this.onInfo('Meshtastic node configured');
        }

        // Start heartbeat to keep serial connection alive
        this._heartbeatId = setInterval(() => {
            if (this.device && typeof this.device.heartbeat === 'function') {
                this.device.heartbeat().catch(() => {});
            }
        }, 30000);

        this.onStatusChange('Serial · Connected', 'status-badge connected meshtastic');
        this.onInfo('Meshtastic connected via Serial');
    }

    // ─── WiFi — via local TCP proxy (WebSocket bridge) ────────────────────────

    async _connectWifi({ host, port }) {
        if (!host || !port) throw new Error('Host and port are required for WiFi connection.');

        this.onInfo(`Attempting connection to ${host}:${port}…`);

        // --- Strategy 1: Direct WebSocket (Some Meshtastic nodes support this natively) ---
        let ws = null;
        try {
            console.log(`[Meshtastic WiFi] Trying direct WebSocket: ws://${host}:${port}`);
            ws = await this._openWebSocket(`ws://${host}:${port}`, 3000); 
            this.onInfo(`Connected directly to node ✔`);
        } catch (e) {
            console.log(`[Meshtastic WiFi] Direct connection failed, falling back to TCP proxy: ${e.message}`);
        }

        // --- Strategy 2: TCP Proxy (launcher.py bridge) ---
        if (!ws) {
            const proxyInfo = await this._getProxyInfo();
            if (!proxyInfo.available) {
                throw new Error(
                    'TCP proxy is not running. Install "websockets" (pip install websockets) and restart the portal.'
                );
            }

            const proxyUrl = `ws://127.0.0.1:${proxyInfo.proxy_port}?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`;
            this.onInfo(`Connecting via TCP proxy → ${host}:${port}…`);
            console.log(`[Meshtastic WiFi] Opening WS proxy: ${proxyUrl}`);

            ws = await this._openWebSocket(proxyUrl);
        }

        this._wsSocket = ws;

        // Bridge the WebSocket into a full Transport object for MeshDevice
        const streams = this._createWsStreams(ws);
        const transport = {
            fromDevice: streams.readable,
            toDevice:   streams.writable,
            disconnect: async () => {
                if (ws.readyState === WebSocket.OPEN) ws.close();
            }
        };
        
        this.device = new MeshDevice(transport);
        this._attachEvents();

        this.onInfo('Handshaking with node…');
        if (typeof this.device.connect === 'function') {
            await this._withTimeout(this.device.connect(), 8000, 'Handshake').catch(e => {
                console.warn('[Meshtastic] Handshake timeout:', e.message);
                // Proceed anyway, some devices connect silently
            });
        }

        if (typeof this.device.configure === 'function') {
            this.onInfo('Configuring node…');
            await this._withTimeout(this.device.configure(), 5000, 'Configuration').catch(e => {
                console.warn('[Meshtastic] Configuration timeout:', e.message);
            });
            this.onInfo('Meshtastic node configured');
        }

        this.onStatusChange(`WiFi · Connected`, 'status-badge connected meshtastic');
        this.onInfo(`Meshtastic connected via TCP to ${host}:${port}`);
    }

    /** Fetch the proxy port written by launcher.py (with 3s timeout) */
    async _getProxyInfo() {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 3000);
        try {
            const resp = await fetch('./proxy_port.json', { cache: 'no-store', signal: controller.signal });
            clearTimeout(id);
            if (!resp.ok) throw new Error('proxy_port.json not found');
            return await resp.json();
        } catch (e) {
            clearTimeout(id);
            console.warn('[Meshtastic] Failed to fetch proxy_port.json:', e.message);
            return { available: false, proxy_port: 0 };
        }
    }

    /** Helper to wrap a promise with a timeout */
    _withTimeout(promise, ms, description = 'Command') {
        const timeout = new Promise((_, reject) => {
            const timer = setTimeout(() => {
                clearTimeout(timer);
                reject(new Error(`${description} timed out after ${ms}ms`));
            }, ms);
        });
        return Promise.race([promise, timeout]);
    }

    // ─── Test Connection ─────────────────────────────────────────────────────

    /**
     * Quick reachability test via TCP proxy: opens & immediately closes.
     * Does NOT perform the Meshtastic protocol handshake.
     * @param {{ host: string, port: string|number }} opts
     * @returns {Promise<{ ok: boolean, message: string }>}
     */
    async testConnection({ host, port }) {
        if (!host || !port) return { ok: false, message: 'Enter an IP address and port first.' };

        // --- Strategy 1: Direct native WebSocket ---
        try {
            await this._openWebSocket(`ws://${host}:${port}`, 3000).then(ws => ws.close());
            return { ok: true, message: `Reached ${host}:${port} via WebSocket ✔` };
        } catch (e) { /* fall through */ }

        // --- Strategy 2: TCP proxy ---
        const proxyInfo = await this._getProxyInfo();
        if (!proxyInfo.available) {
            return { ok: false, message: 'TCP proxy not running — run: pip install websockets and restart portal.' };
        }

        try {
            const proxyUrl = `ws://127.0.0.1:${proxyInfo.proxy_port}?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`;
            await this._openWebSocket(proxyUrl, 4000).then(ws => ws.close());
            return { ok: true, message: `Reached ${host}:${port} via TCP proxy ✔` };
        } catch (e) {
            return { ok: false, message: `Cannot reach ${host}:${port} — ${e.message}` };
        }
    }

    /** Open a WebSocket and resolve/reject on open/error with optional timeout */
    _openWebSocket(url, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            ws.binaryType = 'arraybuffer';

            const timer = setTimeout(() => {
                ws.onopen = ws.onerror = ws.onclose = null;
                ws.close();
                reject(new Error(`Connection timeout (${timeoutMs}ms)`));
            }, timeoutMs);

            ws.onopen  = () => {
                clearTimeout(timer);
                resolve(ws);
            };
            ws.onerror = () => {
                clearTimeout(timer);
                reject(new Error(`Failed to connect to ${url}`));
            };
            ws.onclose = () => {
                clearTimeout(timer);
                if (this.device) {
                    console.warn('[Meshtastic WiFi] WS closed unexpectedly');
                    this.onStatusChange('WiFi · Disconnected', 'status-badge');
                    this.device = null;
                    this._wsSocket = null;
                }
            };
        });
    }

    /** Wrap WebSocket as ReadableStream + WritableStream with Meshtastic TCP framing (0x94 0xC3) */
    _createWsStreams(ws) {
        let readController = null;
        let buffer = new Uint8Array(0);

        const readable = new ReadableStream({
            start(ctrl) { readController = ctrl; }
        });

        const writable = new WritableStream({
            write(chunk) {
                if (ws.readyState === WebSocket.OPEN) {
                    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                    // Meshtastic TCP framing: 0x94 0xC3 [MSB] [LSB]
                    const framed = new Uint8Array(4 + data.length);
                    framed[0] = 0x94;
                    framed[1] = 0xC3;
                    framed[2] = (data.length >> 8) & 0xFF;
                    framed[3] = data.length & 0xFF;
                    framed.set(data, 4);
                    
                    console.log(`[Meshtastic DEBUG] WS Send: ${data.length} bytes (framed: ${framed.length})`);
                    ws.send(framed);
                }
            }
        });

        ws.onmessage = (event) => {
            if (!readController) return;
            
            // event.data is an ArrayBuffer (due to binaryType set in _openWebSocket)
            const newData = new Uint8Array(event.data);
            
            // Efficiently grow buffer
            const nextBuffer = new Uint8Array(buffer.length + newData.length);
            nextBuffer.set(buffer);
            nextBuffer.set(newData, buffer.length);
            buffer = nextBuffer;

            // Process buffer for frames
            while (buffer.length >= 4) {
                // Sync bytes: 0x94 0xC3
                if (buffer[0] === 0x94 && buffer[1] === 0xC3) {
                    const length = (buffer[2] << 8) | buffer[3];
                    if (buffer.length >= 4 + length) {
                        const payload = buffer.slice(4, 4 + length);
                        
                        console.log(`[Meshtastic DEBUG] WS Rx Frame: ${length} bytes`);
                        
                        // CRITICAL FIX: Wrap payload in the DeviceOutput object format expected by @meshtastic/core
                        readController.enqueue({
                            type: 'packet',
                            data: payload
                        });
                        
                        buffer = buffer.slice(4 + length);
                    } else {
                        break; // Wait for more data
                    }
                } else {
                    // Out of sync — scan for next sync sequence
                    let syncIdx = -1;
                    for (let i = 1; i < buffer.length - 1; i++) {
                        if (buffer[i] === 0x94 && buffer[i+1] === 0xC3) {
                            syncIdx = i;
                            break;
                        }
                    }
                    if (syncIdx !== -1) {
                        console.warn(`[Meshtastic DEBUG] WS Rx Out of sync, skipping ${syncIdx} bytes`);
                        buffer = buffer.slice(syncIdx);
                    } else {
                        // Keep the last byte in case it's 0x94
                        buffer = buffer.slice(buffer.length - 1);
                        break;
                    }
                }
            }
        };

        return { readable, writable };
    }

    // ─── Shared event wiring ──────────────────────────────────────────────────

    _attachEvents() {
        if (!this.device?.events) return;

        // Current local node info
        if (this.device.events.onNodeInfo) {
            this.device.events.onNodeInfo.subscribe((info) => {
                console.log('[Meshtastic DEBUG] NodeInfo Received:', info);
                if (info.myNodeNum) {
                    this.learnedNodeId = info.myNodeNum;
                    this.onInfo(`Identified Node ID: ${info.myNodeNum} (${info.longName || 'Unnamed'})`);
                }
            });
        }

        // Standard Text Messages
        if (this.device.events.onMessagePacket) {
            this.device.events.onMessagePacket.subscribe((packet) => {
                console.info('[Meshtastic] onMessagePacket Received:', {
                    from: packet.from,
                    to: packet.to,
                    data: packet.data,
                    packet_from: packet.packet?.from,
                    packet_to: packet.packet?.to,
                    decoded_text: packet.decoded?.text
                });
                
                // Extract sender ID — check multiple possible fields
                const fromId = packet.from || packet.packet?.from || packet.sender;
                
                // Usually packet.data is the text, but let's be safe
                const text = packet.data || packet.decoded?.text || (packet.decoded?.payload ? new TextDecoder().decode(packet.decoded.payload) : null);
                if (!text) return;

                // AGGRESSIVE IDENTIFICATION for reflected messages
                // If it matches what we just sent, it IS from us, even if IDs haven't synced yet
                const isRecentlySent = (this.lastSentText && text === this.lastSentText && (Date.now() - this.lastSentTime < 10000));
                
                if (!this.learnedNodeId && isRecentlySent && fromId) {
                    console.log('[Meshtastic] Auto-learning our Node ID from reflected message:', fromId);
                    this.learnedNodeId = fromId;
                }

                const myId = this.device?.myNodeInfo?.myNodeNum || this.device?.myNodeNum || this.learnedNodeId;
                const isFromMe = isRecentlySent || (myId && fromId && myId.toString() === fromId.toString());

                // If it's from me, and it was recently sent, we already showed it in the UI via sendMessage()
                // so we suppress the duplicate "incoming" UI update.
                if (isFromMe && isRecentlySent) {
                    console.log('[Meshtastic] Suppressing UI update for reflected "Me" message:', text);
                    return;
                }

                const sender = isFromMe ? 'Me' : (fromId && fromId > 0 ? `Node-${fromId.toString(16).toUpperCase()}` : 'Unknown');
                this.onMessage(sender, text, 'meshtastic', isFromMe ? 'outgoing' : 'incoming');
            });
        }

        // Broad Packet Catch-all for Diagnostics
        if (this.device.events.onPacket) {
            this.device.events.onPacket.subscribe((p) => {
                console.debug('[Meshtastic DEBUG] Raw Packet Received:', p);
            });
        }
    }

    // ─── Disconnect ───────────────────────────────────────────────────────────

    async disconnect() {
        if (this._heartbeatId) {
            clearInterval(this._heartbeatId);
            this._heartbeatId = null;
        }
        if (this._wsSocket) {
            this._wsSocket.close();
            this._wsSocket = null;
        }
        if (this.device && typeof this.device.disconnect === 'function') {
            await this.device.disconnect().catch(() => {});
        }
        this.device = null;
        this._connectionType = null;
        this.learnedNodeId = null;
        this.onStatusChange('Offline', 'status-badge');
    }

    // ─── Send ─────────────────────────────────────────────────────────────────

    async sendMessage(text) {
        if (!this.device) throw new Error('Meshtastic is not connected.');

        if (typeof this.device.sendText === 'function') {
            // Store for deduplication in onMessagePacket
            this.lastSentText = text;
            this.lastSentTime = Date.now();
            
            // OPTIMISTIC UI UPDATE: Show it instantly
            this.onMessage('Me', text, 'meshtastic', 'outgoing');

            // Actual transmission
            // Signature: sendText(text, destination, wantAck, channelIndex)
            // 0xFFFFFFFF (hex: 4294967295) is the numeric broadcast ID
            await this.device.sendText(text, 0xFFFFFFFF, true, 0).catch(err => {
                console.error('[Meshtastic] sendText failed:', err);
                this.onInfo(`⚠ Failed to send: ${err.message}`);
            });
        } else {
            console.warn('[Meshtastic] sendText not available on device', this.device);
        }
    }
}
