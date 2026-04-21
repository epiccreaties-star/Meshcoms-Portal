/**
 * ProtocolModule — Abstract base class for all mesh protocol modules.
 *
 * To add a new protocol:
 *   1. Create a class that extends ProtocolModule in /modules/
 *   2. Set static properties: `protocolId` (e.g. 'mymesh') and `label` (e.g. 'MyMesh Node')
 *   3. Override connect(connectionType, opts), disconnect(), sendMessage(text)
 *   4. In app_v2.js, import and call registerModule(MyMeshModule)
 *
 * Connection types your module supports should be returned from getSupportedConnectionTypes().
 * The orchestrator automatically builds the UI card based on those types.
 */
export class ProtocolModule {
    /**
     * @param {Object} options
     * @param {Function} options.onMessage       - (sender, text, protocol, type) => void
     * @param {Function} options.onStatusChange  - (statusText, badgeClass) => void
     * @param {Function} options.onError         - (errorMessage) => void
     * @param {Function} options.onInfo          - (infoMessage) => void
     */
    constructor(options = {}) {
        this.onMessage      = options.onMessage      || (() => {});
        this.onStatusChange = options.onStatusChange || (() => {});
        this.onError        = options.onError        || (() => {});
        this.onInfo         = options.onInfo         || (() => {});
        this.device         = null;
        this._connectionType = null;
    }

    // ─── Static metadata (override in subclasses) ─────────────────────────────

    /**
     * Machine-readable protocol identifier, e.g. 'meshcore' or 'meshtastic'.
     * Used for CSS class names and routing.
     * @returns {string}
     */
    static get protocolId() {
        throw new Error('protocolId must be defined as a static property on the subclass.');
    }

    /**
     * Human-readable label shown in the UI card, e.g. 'MeshCore Node'.
     * @returns {string}
     */
    static get label() {
        throw new Error('label must be defined as a static property on the subclass.');
    }

    // ─── Connection types ─────────────────────────────────────────────────────

    /**
     * Override to restrict available connection types.
     * @returns {Array<'serial'|'wifi'>}
     */
    getSupportedConnectionTypes() {
        return ['serial', 'wifi'];
    }

    // ─── Connection test ──────────────────────────────────────────────────────

    /**
     * Test reachability of a WiFi target without fully connecting.
     * Subclasses should override this.
     * @param {{ host: string, port: number|string }} opts
     * @returns {Promise<{ ok: boolean, message: string }>}
     */
    async testConnection(opts) {
        return { ok: false, message: 'Test not implemented for this module.' };
    }

    // ─── Lifecycle (must override) ────────────────────────────────────────────

    /**
     * @param {'serial'|'wifi'} connectionType
     * @param {{ host?: string, port?: number }} [opts]  — required when connectionType === 'wifi'
     */
    async connect(connectionType, opts = {}) {
        throw new Error('connect() must be implemented by subclass');
    }

    async disconnect() {
        throw new Error('disconnect() must be implemented by subclass');
    }

    async sendMessage(text) {
        throw new Error('sendMessage() must be implemented by subclass');
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    isConnected() {
        return this.device !== null;
    }

    get connectionType() {
        return this._connectionType;
    }
}
