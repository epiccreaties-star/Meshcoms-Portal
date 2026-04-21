/**
 * MeshCoreModule — Self-contained MeshCore protocol handler.
 *
 * Supports:
 *   - Serial: Web Serial API via WebSerialConnection (meshcore.js)
 *   - WiFi:   TCP via localhost WebSocket proxy → ws://127.0.0.1:<PROXY>?host=IP&port=PORT
 *             The launcher.py provides a WebSocket-to-TCP bridge so the browser
 *             can reach the MeshCore node's TCP port directly.
 *             MeshCore also supports WebSocketConnection natively in meshcore.js,
 *             which is tried first if the node has a WS server; otherwise the
 *             TCP proxy bridge is used as a fallback.
 *
 * Usage in orchestrator:
 *   import { MeshCoreModule } from './modules/MeshCoreModule.js';
 *   registerModule(MeshCoreModule);
 */
import { ProtocolModule } from './ProtocolModule.js';
import { WebSerialConnection, Connection } from '@liamcottle/meshcore.js';

export class MeshCoreModule extends ProtocolModule {

    // ─── Module metadata ──────────────────────────────────────────────────────

    static get protocolId() { return 'meshcore'; }
    static get label()      { return 'MeshCore Node'; }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(options) {
        super(options);
        this.syncInterval = null;
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
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });

        this.device = new WebSerialConnection(port);
        this._attachDecoder();
        await this._initDevice(false);

        this.onStatusChange('Serial · Connected', 'status-badge connected meshcore');
        this.onInfo('MeshCore connected via Serial');
    }

    // ─── WiFi — native WS or local TCP proxy ──────────────────────────────────

    async _connectWifi({ host, port }) {
        if (!host || !port) throw new Error('Host and port are required for WiFi connection.');

        // ── Strategy 2: Local TCP proxy (launcher.py bridge) ──
        const proxyInfo = await this._getProxyInfo();

        if (!proxyInfo.available) {
            throw new Error(
                'WiFi connection failed. The node may not have a WebSocket server, ' +
                'and the TCP proxy is not running. Install "websockets" (pip install websockets) and restart the portal.'
            );
        }

        const proxyUrl = `ws://127.0.0.1:${proxyInfo.proxy_port}?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`;
        this.onInfo(`Connecting via TCP proxy → ${host}:${port}…`);
        console.log(`[MeshCore WiFi] Opening proxy: ${proxyUrl}`);

        const ws = await this._openWebSocket(proxyUrl);

        // Wrap proxy WebSocket as a meshcore-compatible connection object
        this.device = this._buildProxyDevice(ws);
        this._attachDecoder();
        await this._initDevice(true);

        this.onStatusChange(`WiFi · Connected`, 'status-badge connected meshcore');
        this.onInfo(`MeshCore connected via TCP to ${host}:${port}`);
    }

    /** Fetch the proxy WebSocket port from launcher.py's proxy_port.json */
    async _getProxyInfo() {
        try {
            const resp = await fetch('./proxy_port.json', { cache: 'no-store' });
            if (!resp.ok) throw new Error('not found');
            return await resp.json();
        } catch {
            return { available: false, proxy_port: 0 };
        }
    }

    // ─── Test Connection ─────────────────────────────────────────────────────

    /**
     * Quick reachability test: opens and immediately closes a WebSocket.
     * Does NOT perform any MeshCore handshake.
     * @param {{ host: string, port: string|number }} opts
     * @returns {Promise<{ ok: boolean, message: string }>}
     */
    async testConnection({ host, port }) {
        if (!host || !port) return { ok: false, message: 'Enter an IP address and port first.' };

        // --- Strategy 1: direct native WebSocket (if node has WS server) ---
        try {
            await new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://${host}:${port}`);
                const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
                ws.onopen  = () => { clearTimeout(timer); ws.close(); resolve(); };
                ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
            });
            return { ok: true, message: `Reached ${host}:${port} via WebSocket ✔` };
        } catch { /* fall through */ }

        // --- Strategy 2: TCP proxy ---
        const proxyInfo = await this._getProxyInfo();
        if (!proxyInfo.available) {
            return { ok: false, message: 'Cannot reach node — proxy not running (pip install websockets).' };
        }

        try {
            const proxyUrl = `ws://127.0.0.1:${proxyInfo.proxy_port}?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`;
            await new Promise((resolve, reject) => {
                const ws = new WebSocket(proxyUrl);
                const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 4000);
                ws.onopen  = () => { clearTimeout(timer); ws.close(); resolve(); };
                ws.onerror = () => { clearTimeout(timer); reject(new Error('proxy ws error')); };
            });
            return { ok: true, message: `Reached ${host}:${port} via TCP proxy ✔` };
        } catch (e) {
            return { ok: false, message: `Cannot reach ${host}:${port} — ${e.message}` };
        }
    }

    /** Open a WebSocket, resolving/rejecting on open/error */
    _openWebSocket(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            ws.binaryType = 'arraybuffer';
            ws.onopen  = () => resolve(ws);
            ws.onerror = () => reject(new Error('Cannot open proxy WebSocket. Is launcher.py running?'));
            ws.onclose = () => {
                if (this.device) {
                    console.warn('[MeshCore WiFi] Proxy WS closed unexpectedly');
                    this.onStatusChange('WiFi · Disconnected', 'status-badge');
                    this.device = null;
                }
            };
        });
    }

    /**
     * Build a minimal device shim around a raw WebSocket so the existing
     * decoder and event infrastructure works identically to WebSerialConnection.
     */
    _buildProxyDevice(ws) {
        const shim = new Connection();
        shim._ws = ws;

        // Simulate serialPort presence for sync interval check
        shim.serialPort = true;

        // Write raw bytes to the device
        shim.write = async (data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data instanceof Uint8Array ? data : new Uint8Array(data));
            }
        };

        // Inject the Serial protocol framing so MeshCore commands can be sent
        shim.sendToRadioFrame = async (data) => {
            shim.emit('tx', data);

            const frame = new Uint8Array(3 + data.length);
            frame[0] = 0x3c;
            frame[1] = data.length & 0xff;
            frame[2] = (data.length >> 8) & 0xff;
            frame.set(data, 3);

            await shim.write(frame);
        };

        shim.close = async () => {
            ws.close();
            return Promise.resolve();
        };

        // Route incoming bytes through the decoder
        ws.onmessage = async (event) => {
            const chunk = event.data instanceof ArrayBuffer
                ? new Uint8Array(event.data)
                : event.data;
            if (shim.onDataReceived) await shim.onDataReceived(chunk);
        };

        return shim;
    }

    // ─── Shared decoder ───────────────────────────────────────────────────────

    /**
     * Overrides onDataReceived with a hardened binary-frame decoder.
     * MeshCore mixes ASCII debug logs with binary frames starting with 0x3e ('>').
     */
    _attachDecoder() {
        let frameBuffer = new Uint8Array(0);
        let inFrame     = false;
        let expectedLen = 0;

        this.device.onDataReceived = async (chunk) => {
            const newBuf = new Uint8Array(frameBuffer.length + chunk.length);
            newBuf.set(frameBuffer);
            newBuf.set(chunk, frameBuffer.length);
            frameBuffer = newBuf;

            while (frameBuffer.length > 0) {
                if (!inFrame) {
                    const startIndex = frameBuffer.indexOf(0x3e);
                    if (startIndex === -1) {
                        const text = new TextDecoder().decode(frameBuffer);
                        if (text.trim().length > 2) console.log('%c[MESHCORE LOG]', 'color:#888;font-style:italic', text.trim());
                        frameBuffer = new Uint8Array(0);
                        break;
                    }

                    if (frameBuffer.length >= 3) {
                        const testLen = frameBuffer[startIndex + 1] | (frameBuffer[startIndex + 2] << 8);
                        if (testLen > 0 && testLen < 512) {
                            if (startIndex > 0) {
                                console.log('%c[MESHCORE LOG]', 'color:#888;font-style:italic',
                                    new TextDecoder().decode(frameBuffer.slice(0, startIndex)).trim());
                            }
                            frameBuffer = frameBuffer.slice(startIndex);
                            expectedLen = testLen;
                            inFrame = true;
                        } else {
                            const junk = frameBuffer.slice(0, startIndex + 1);
                            console.log('%c[MESHCORE LOG]', 'color:#888;font-style:italic', new TextDecoder().decode(junk).trim());
                            frameBuffer = frameBuffer.slice(startIndex + 1);
                            continue;
                        }
                    } else {
                        break;
                    }
                }

                if (inFrame) {
                    const totalFrameSize = 3 + expectedLen;
                    if (frameBuffer.length < totalFrameSize) break;

                    const payload = frameBuffer.slice(3, totalFrameSize);
                    console.log(`[MeshCore DECODER] Frame (len=${expectedLen}):`, payload);

                    if (typeof this.device.onFrameReceived === 'function') {
                        this.device.onFrameReceived(payload);
                    } else {
                        this.device.emit('rx', payload);
                    }

                    frameBuffer = frameBuffer.slice(totalFrameSize);
                    inFrame = false;
                }
            }
        };
    }

    /** Helper to wrap a promise with a timeout to prevent portal hangs */
    _withTimeout(promise, ms, description = 'Command') {
        const timeout = new Promise((_, reject) => {
            const id = setTimeout(() => {
                clearTimeout(id);
                reject(new Error(`${description} timed out after ${ms}ms`));
            }, ms);
        });
        return Promise.race([promise, timeout]);
    }

    // ─── Device init ──────────────────────────────────────────────────────────

    async _initDevice(isWifi) {
        if (!isWifi && typeof this.device.connect === 'function') {
            await this.device.connect().catch(e => console.warn('[MeshCore] connect():', e));
        }
        if (typeof this.device.onConnected === 'function') {
            // Handle connection handshake with a timeout to prevent hanging the portal if DeviceInfo isn't sent
            await this._withTimeout(this.device.onConnected(), 4000, 'Handshake').catch(e => {
                console.warn('[MeshCore] Handshake timed out - proceeding in basic mode:', e.message);
            });
        }

        this._patchEmitter();
        this._attachMessageEvents();
        this._startSyncLoop();

        // 1. Sync time (essential for messaging success)
        if (typeof this.device.syncDeviceTime === 'function') {
            await this._withTimeout(this.device.syncDeviceTime(), 2000, 'Time Sync').catch(() => {});
        }

        // 2. Announce presence to the mesh
        if (typeof this.device.sendFloodAdvert === 'function') {
            await this._withTimeout(this.device.sendFloodAdvert(), 2000, 'Flood Advert').catch(() => {});
        }

        // 2b. Set Default Flood Scope (Essential for nodes to broadcast companion flood packets)
        if (typeof this.device.sendCommandSetFloodScope === 'function') {
            const defaultKey = new Uint8Array(32); // 32 zeros for public mesh
            console.log('[MeshCore] Setting Flood Scope...');
            await this.device.sendCommandSetFloodScope(defaultKey).catch(e => console.warn('[MeshCore] SetFloodScope not supported:', e));
        }

        // 2c. Explicit Companion Handshake (Tells node we are a Companion app)
        if (typeof this.device.sendCommandAppStart === 'function') {
            const appVer = 1;
            const reserved = new Uint8Array(6);
            const appName = "Meshcoms Companion";
            console.log('[MeshCore] Sending AppStart...');
            await this.device.sendCommandAppStart(appVer, reserved, appName).catch(e => console.warn('[MeshCore] AppStart error:', e));
        }

        // 3. Fetch initial info and contacts for name resolution (non-blocking)
        if (typeof this.device.getSelfInfo === 'function') {
            this.device.getSelfInfo().then(info => {
                this.onInfo(`Connected to ${info.name || 'MeshCore Node'}`);
            }).catch(() => {});
        }

        if (typeof this.device.getContacts === 'function') {
            this.device.getContacts().then(contacts => {
                this._contacts = contacts;
                this.onInfo(`Retrieved ${contacts.length} contacts`);
            }).catch(() => {});
        } else if (typeof this.device.sendCommandGetContacts === 'function') {
            this.device.sendCommandGetContacts();
        }
    }

    /** Helper to resolve a human-readable node name from pubKeyPrefix or nodeID */
    async _getDisplayName(data) {
        if (data.senderName) return data.senderName;

        // Try to match via pubKeyPrefix if available
        if (data.pubKeyPrefix && this.device) {
            const prefix = data.pubKeyPrefix;
            // Use cached contacts if available, otherwise fetch
            const contacts = this._contacts || await this.device.getContacts().catch(() => []);
            this._contacts = contacts;

            const contact = contacts.find(c => {
                if (!c.publicKey) return false;
                const cPrefix = c.publicKey.subarray(0, prefix.length);
                return Array.from(cPrefix).every((val, i) => val === prefix[i]);
            });

            if (contact && contact.advName) return contact.advName;
        }

        if (data.senderNodeId) return `Node-${data.senderNodeId.toString(16)}`;
        return 'MeshCore CH';
    }

    _patchEmitter() {
        if (typeof this.device.emit !== 'function') return;
        const originalEmit = this.device.emit.bind(this.device);
        this.device.emit = (eventName, ...args) => {
            console.log(`[MeshCore EVENT] ${String(eventName)}`, args);
            // We rely on specific listeners in _attachMessageEvents for chat UI
            return originalEmit(eventName, ...args);
        };
    }

    _attachMessageEvents() {
        this.device.on('rx', (data) => {
            if (data instanceof Uint8Array) {
                console.log('[MeshCore RX HEX]', Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '));
            }
        });

        this.device.on(8, async (data) => {
            if (data?.text) {
                console.log(`[MeshCore CH] Rx on Channel Index: ${data.channelIdx || 0}`);
                const sender = await this._getDisplayName(data);
                this.onMessage(sender, data.text, 'meshcore', 'incoming');
            }
        });

        this.device.on(7, async (data) => {
            if (data?.text) {
                const sender = await this._getDisplayName(data);
                this.onMessage(sender, data.text, 'meshcore', 'incoming');
            }
        });

        this.device.on(131, () => {
            console.log('[MeshCore] Pending messages (event 131)');
            this._fetchWaitingMessages();
        });

        this.device.on(136, (d) => console.debug('[MeshCore Auth]', d));
        this.device.on(128, (d) => console.debug('[MeshCore Advert]', d));
        this.device.on(129, (d) => console.debug('[MeshCore NodeUpdate]', d));
        
        // Protocol Responses
        this.device.on(0, () => {
            console.log('[MeshCore] Node OK (Request accepted)');
            this.onStatusChange('WiFi · Connected', 'status-badge connected meshcore');
        });
        this.device.on(6, (res) => {
            console.log('[MeshCore] Node SENT (Packet on air)', res);
            // Confirmation log removed for cleaner UI
        });
        this.device.on(1, (res) => {
            console.error('[MeshCore] Node ERR', res);
            // UnsupportedCmd (1) is common on older firmware, don't show as a toast unless it stops function.
            if (res.errCode === 1) {
                console.warn('[MeshCore] Command rejected: UnsupportedCmd (1). Node may have older firmware.');
            } else {
                this.onError(`Node rejected command: ${res.errCode || 'Unknown Err'}`);
            }
        });

        this.device.on(130, (d) => console.debug('[MeshCore ACK]', d));
    }

    _startSyncLoop() {
        this.syncInterval = setInterval(() => {
            if (this.device) this._fetchWaitingMessages();
        }, 30000);
    }

    async _fetchWaitingMessages() {
        try {
            if (typeof this.device.getWaitingMessages === 'function') {
                await this.device.getWaitingMessages();
            } else if (typeof this.device.syncNextMessage === 'function') {
                await this.device.syncNextMessage();
            }
        } catch (err) {
            console.warn('[MeshCore] fetchWaitingMessages:', err);
        }
    }

    // ─── Disconnect ───────────────────────────────────────────────────────────

    async disconnect() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        if (this.device && typeof this.device.close === 'function') {
            await this.device.close().catch(() => {});
        }
        this.device = null;
        this._connectionType = null;
        this.onStatusChange('Offline', 'status-badge');
    }

    // ─── Send ─────────────────────────────────────────────────────────────────

    async sendMessage(text) {
        if (!this.device) throw new Error('MeshCore is not connected.');

        try {
            // Using the pattern from official meshcore.js examples:
            // 1. Ensure time is synced (we did this in init, but we can do a fire-and-forget here)
            if (typeof this.device.sendCommandSetDeviceTime === 'function') {
                this.device.sendCommandSetDeviceTime(Math.floor(Date.now() / 1000)).catch(() => {});
            }

            // 2. Send via high-level method with timeout protection
            if (typeof this.device.sendChannelTextMessage === 'function') {
                console.log('[MeshCore] Sending via sendChannelTextMessage (channel 0)...');
                // We await it with a timeout so even if no 'Ok' comes back, the UI remains responsive
                await this._withTimeout(this.device.sendChannelTextMessage(0, text), 5000, 'Message Confirmation').catch(e => {
                    console.warn('[MeshCore] Message confirmation timeout (it may still have been sent):', e.message);
                });
            } else if (typeof this.device.sendCommandSendChannelTxtMsg === 'function') {
                // Fallback to lowest-level command if high-level is missing
                const timestamp = Math.floor(Date.now() / 1000);
                await this.device.sendCommandSendChannelTxtMsg(0, 0, timestamp, text);
            }
            
            this.onMessage('Me', text, 'meshcore', 'outgoing');
        } catch (err) {
            console.error('[MeshCore SEND ERROR]', err);
            this.onError(`Failed to send message: ${err.message || 'Unknown error'}`);
        }
    }
}
