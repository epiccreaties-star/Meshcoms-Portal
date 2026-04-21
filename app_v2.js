/**
 * app_v2.js — Module Orchestrator v5
 *
 * Clean, safe execution order:
 *   1. All helper functions defined
 *   2. Modal built
 *   3. registerModule() called for each protocol
 */

import { MeshCoreModule }   from './modules/MeshCoreModule.js?v=12';
import { MeshtasticModule } from './modules/MeshtasticModule.js?v=12';

// ─── Shared state ─────────────────────────────────────────────────────────────

const registeredModules = [];
let   activeProtocol    = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const moduleCardsContainer = document.getElementById('module-cards');
const chatMessages          = document.getElementById('chat-messages');
const chatInput             = document.getElementById('chat-input');
const btnSend               = document.getElementById('btn-send');
const chatForm              = document.getElementById('chat-form');
const sendTargetGroup       = document.getElementById('send-target-group');

// ─── LocalStorage helpers ─────────────────────────────────────────────────────

function saveWifiSettings(pid, host, port) {
    try { localStorage.setItem('meshcoms_wifi_' + pid, JSON.stringify({ host: host, port: port })); } catch (_) {}
}
function loadWifiSettings(pid) {
    try { return JSON.parse(localStorage.getItem('meshcoms_wifi_' + pid)) || {}; } catch (_) { return {}; }
}

// ─── Toast notifications ──────────────────────────────────────────────────────

function showToast(message, level) {
    level = level || 'info';
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'system-toast toast-' + level;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function() { toast.remove(); }, 4000);
}

// ─── Status / send control helpers ───────────────────────────────────────────

function updateModuleStatus(mod, statusText, badgeClass) {
    const pid   = mod._ModuleClass.protocolId;
    const badge = document.getElementById('status-' + pid);
    if (badge) {
        badge.textContent = statusText;
        badge.className   = badgeClass;
    }
}

function updateSendControls() {
    const connectedMods = registeredModules.filter(function(m) { return m.isConnected(); });
    const anyConnected = connectedMods.length > 0;
    
    chatInput.disabled = !anyConnected;
    btnSend.disabled   = !anyConnected;

    // Validate the currently selected target radio
    const checkedRadio = sendTargetGroup.querySelector('input[type=radio]:checked');
    if (checkedRadio) {
        const selMod = registeredModules.find(function(m) { return m._ModuleClass.protocolId === checkedRadio.value; });
        if (selMod && !selMod.isConnected()) {
             checkedRadio.checked = false;
        }
    }

    // Auto-fallback if the user doesn't have an active radio but something is connected
    if (anyConnected) {
         if (!sendTargetGroup.querySelector('input[type=radio]:checked')) {
             const fallbackPid = connectedMods[0]._ModuleClass.protocolId;
             const fallbackRadio = document.getElementById('radio-' + fallbackPid);
             if (fallbackRadio) {
                 fallbackRadio.checked = true;
                 activeProtocol = fallbackPid;
             }
         }
    }
}

// ─── Chat rendering ───────────────────────────────────────────────────────────

let lastMessageSignature = '';
let lastMessageTime      = 0;

function escHtml(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(str).replace(/[&<>"']/g, function(m) { return map[m]; });
}

function appendMessage(sender, text, protocol, type) {
    type = type || 'incoming';
    if (!text) return;

    const sig = sender + ':' + text + ':' + protocol + ':' + type;
    const now = Date.now();
    if (sig === lastMessageSignature && (now - lastMessageTime) < 2000) return;
    lastMessageSignature = sig;
    lastMessageTime      = now;

    chatMessages.querySelector('.chat-empty-state') && chatMessages.querySelector('.chat-empty-state').remove();

    const el = document.createElement('div');
    el.className = 'message-bubble ' + type + ' protocol-' + protocol;
    el.innerHTML =
        '<div class="message-meta">' +
            '<span class="message-sender">' + escHtml(sender) + '</span>' +
            '<span class="message-protocol">' + protocol.toUpperCase() + '</span>' +
            '<span class="message-time">' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>' +
        '</div>' +
        '<div class="message-content">' + escHtml(text) + '</div>';

    chatMessages.appendChild(el);
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
}

// ─── Connection modal ─────────────────────────────────────────────────────

// Helper: create element and set properties
function createElement(tag, props) {
    const el = document.createElement(tag);
    Object.keys(props || {}).forEach(function(k) {
        if (k === 'ariaLabel') { el.setAttribute('aria-label', props[k]); }
        else { el[k] = props[k]; }
    });
    return el;
}

let _modal_mod = null;
let _modal_pid = null;

const modalOverlay   = createElement('div', { id: 'conn-modal-overlay', className: 'conn-modal-overlay hidden' });
const modalBox       = createElement('div', { className: 'conn-modal', role: 'dialog' });
const modalHeader    = createElement('div', { className: 'conn-modal-header' });
const modalTitle     = createElement('span', { className: 'conn-modal-title', textContent: 'Connect' });
const modalCloseBtn  = createElement('button', { className: 'conn-modal-close', textContent: '✕', ariaLabel: 'Close' });
const choiceRow      = createElement('div', { className: 'conn-choice-row' });
const tileSerial     = createElement('button', { className: 'conn-choice-tile' });
const tileWifi       = createElement('button', { className: 'conn-choice-tile' });
const wifiSection    = createElement('div', { className: 'conn-wifi-section hidden' });
const wifiBack       = createElement('button', { className: 'conn-wifi-back', textContent: '← Back' });
const wifiFields     = createElement('div', { className: 'conn-wifi-fields' });
const labelHost      = createElement('label', { className: 'conn-field-label', textContent: 'IP Address' });
const inputHost      = createElement('input', { type: 'text', id: 'modal-wifi-host', className: 'wifi-input', placeholder: 'e.g. 192.168.1.50' });
const labelPort      = createElement('label', { className: 'conn-field-label', textContent: 'Port' });
const inputPort      = createElement('input', { type: 'number', id: 'modal-wifi-port', className: 'wifi-input', placeholder: 'e.g. 4403', value: '4403', min: '1', max: '65535' });
const btnTest        = createElement('button', { className: 'btn-test', textContent: '🔎 Test Connection' });
const btnWifiConnect = createElement('button', { className: 'btn-connect modal-pid', textContent: 'Connect via WiFi' });
const connectingDiv  = createElement('div', { className: 'conn-modal-connecting hidden' });
const spinner        = createElement('div', { className: 'conn-spinner' });
const connectingText = createElement('span', { textContent: 'Connecting…' });

// Tile Serial inner content
tileSerial.innerHTML =
    '<span class="conn-choice-icon">🔌</span>' +
    '<span class="conn-choice-label">Serial</span>' +
    '<span class="conn-choice-desc">USB cable via Web Serial API</span>';

// Tile WiFi inner content
tileWifi.innerHTML =
    '<span class="conn-choice-icon">📶</span>' +
    '<span class="conn-choice-label">TCP / WiFi</span>' +
    '<span class="conn-choice-desc">Connect over local network</span>';

// Assemble wifi fields
wifiFields.appendChild(labelHost);
wifiFields.appendChild(inputHost);
wifiFields.appendChild(labelPort);
wifiFields.appendChild(inputPort);

// Assemble wifi section
wifiSection.appendChild(wifiBack);
wifiSection.appendChild(wifiFields);
wifiSection.appendChild(btnTest);
wifiSection.appendChild(btnWifiConnect);

// Assemble connecting section
connectingDiv.appendChild(spinner);
connectingDiv.appendChild(connectingText);

// Assemble choice row
choiceRow.appendChild(tileSerial);
choiceRow.appendChild(tileWifi);

// Assemble header
modalHeader.appendChild(modalTitle);
modalHeader.appendChild(modalCloseBtn);

// Assemble modal box
modalBox.appendChild(modalHeader);
modalBox.appendChild(choiceRow);
modalBox.appendChild(wifiSection);
modalBox.appendChild(connectingDiv);

// Assemble overlay
modalOverlay.appendChild(modalBox);
document.body.appendChild(modalOverlay);

// --- Modal open/close ---

function modalOpen(mod, pid, label) {
    _modal_mod = mod;
    _modal_pid = pid;
    modalTitle.textContent = 'Connect — ' + label;

    // Restore saved WiFi
    const saved = loadWifiSettings(pid);
    inputHost.value = saved.host || '';
    inputPort.value = saved.port || '4403';

    // Reset to choice screen
    choiceRow.classList.remove('hidden');
    wifiSection.classList.add('hidden');
    connectingDiv.classList.add('hidden');

    modalOverlay.classList.remove('hidden');
    requestAnimationFrame(function() { modalOverlay.classList.add('open'); });
}

function modalClose() {
    modalOverlay.classList.remove('open');
    setTimeout(function() { modalOverlay.classList.add('hidden'); }, 260);
    _modal_mod = null;
    _modal_pid = null;
}

function modalShowConnecting(msg) {
    choiceRow.classList.add('hidden');
    wifiSection.classList.add('hidden');
    connectingDiv.classList.remove('hidden');
    connectingText.textContent = msg || 'Connecting…';
}

function modalShowWifi() {
    choiceRow.classList.add('hidden');
    wifiSection.classList.remove('hidden');
}

// --- Modal event wiring ---

modalOverlay.addEventListener('click', function(e) { if (e.target === modalOverlay) modalClose(); });
modalCloseBtn.addEventListener('click', modalClose);
document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) modalClose(); });

tileSerial.addEventListener('click', async function() {
    if (!_modal_mod) return;
    modalShowConnecting('Connecting via Serial…');
    try {
        await _modal_mod.connect('serial', {});
        onConnectSuccess(_modal_mod, _modal_pid);
        modalClose();
    } catch (err) {
        showToast((_modal_pid || 'Node') + ': ' + err.message, 'error');
        connectingDiv.classList.add('hidden');
        choiceRow.classList.remove('hidden');
    }
});

tileWifi.addEventListener('click', function() { modalShowWifi(); });
wifiBack.addEventListener('click', function() {
    wifiSection.classList.add('hidden');
    choiceRow.classList.remove('hidden');
});

btnTest.addEventListener('click', async function() {
    const host = inputHost.value.trim();
    const port = inputPort.value.trim();
    if (!host || !port) { showToast('Enter an IP address and port first.', 'error'); return; }
    const orig = btnTest.textContent;
    btnTest.disabled = true;
    btnTest.textContent = 'Testing…';
    try {
        const result = await _modal_mod.testConnection({ host: host, port: port });
        showToast(result.ok ? '✅ ' + result.message : '❌ ' + result.message, result.ok ? 'info' : 'error');
    } catch (e) {
        showToast('❌ Test failed: ' + e.message, 'error');
    } finally {
        btnTest.disabled = false;
        btnTest.textContent = orig;
    }
});

btnWifiConnect.addEventListener('click', async function() {
    const host = inputHost.value.trim();
    const port = inputPort.value.trim();
    if (!host || !port) { showToast('Please fill in the IP address and port.', 'error'); return; }
    modalShowConnecting('Connecting to ' + host + ':' + port + '…');
    saveWifiSettings(_modal_pid, host, port);
    try {
        await _modal_mod.connect('wifi', { host: host, port: port });
        onConnectSuccess(_modal_mod, _modal_pid);
        modalClose();
    } catch (err) {
        showToast((_modal_pid || 'Node') + ': ' + err.message, 'error');
        connectingDiv.classList.add('hidden');
        wifiSection.classList.remove('hidden');
    }
});

// ─── Called when connect succeeds ─────────────────────────────────────────────

function onConnectSuccess(mod, pid) {
    const connectBtn = document.getElementById('btn-connect-' + pid);
    if (connectBtn) {
        connectBtn.textContent = 'Disconnect';
        connectBtn.classList.add('connected');
    }
    const radios = sendTargetGroup.querySelectorAll('input[type=radio]');
    let anyChecked = false;
    radios.forEach(function(r) { if (r.checked) anyChecked = true; });
    if (!anyChecked) {
        const radio = document.getElementById('radio-' + pid);
        if (radio) { radio.checked = true; activeProtocol = pid; }
    }
    updateSendControls();
}

// ─── createElement helper (moved up, defined before use) ────────────────────
// (defined above the modal section)

// ─── Module registration ──────────────────────────────────────────────────────

function registerModule(ModuleClass) {
    const mod = new ModuleClass({
        onMessage:      function(s, t, p, tp) { appendMessage(s, t, p, tp); },
        onStatusChange: function(st, bc)       { updateModuleStatus(mod, st, bc); },
        onError:        function(msg)          { showToast('⚠️ ' + msg, 'error'); },
        onInfo:         function(msg)          { showToast(msg, 'info'); },
    });
    mod._ModuleClass = ModuleClass;
    registeredModules.push(mod);
    renderModuleCard(mod);
    renderSendTargetRadio(mod);
}

// ─── Render card ──────────────────────────────────────────────────────────────

function renderModuleCard(mod) {
    const pid   = mod._ModuleClass.protocolId;
    const label = mod._ModuleClass.label;

    const card = document.createElement('div');
    card.className = 'device-card ' + pid;
    card.id = 'card-' + pid;

    const info = document.createElement('div');
    info.className = 'device-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'device-name';
    nameSpan.textContent = label;

    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.id = 'status-' + pid;
    badge.textContent = 'Offline';

    info.appendChild(nameSpan);
    info.appendChild(badge);

    const connectBtn = document.createElement('button');
    connectBtn.className = 'btn-connect ' + pid;
    connectBtn.id = 'btn-connect-' + pid;
    connectBtn.textContent = 'Connect';

    connectBtn.addEventListener('click', async function() {
        if (mod.isConnected()) {
            await mod.disconnect();
            connectBtn.textContent = 'Connect';
            connectBtn.classList.remove('connected');
            updateSendControls();
        } else {
            modalOpen(mod, pid, label);
        }
    });

    card.appendChild(info);
    card.appendChild(connectBtn);
    moduleCardsContainer.appendChild(card);
}

// ─── Render send-target radio ─────────────────────────────────────────────────

function renderSendTargetRadio(mod) {
    const pid   = mod._ModuleClass.protocolId;
    const label = mod._ModuleClass.label;

    const lbl = document.createElement('label');
    lbl.className = 'radio-group';
    lbl.id = 'lbl-send-' + pid;

    const radio = document.createElement('input');
    radio.type  = 'radio';
    radio.name  = 'sendTarget';
    radio.value = pid;
    radio.id    = 'radio-' + pid;
    radio.addEventListener('change', function() { activeProtocol = pid; });

    lbl.appendChild(radio);
    lbl.appendChild(document.createTextNode(' Send via ' + label.replace(' Node', '')));
    sendTargetGroup.appendChild(lbl);
}

// ─── Send handler ─────────────────────────────────────────────────────────────

chatForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;

    const checkedRadio = sendTargetGroup.querySelector('input[type=radio]:checked');
    const pid = checkedRadio ? checkedRadio.value : activeProtocol;
    const mod = registeredModules.find(function(m) {
        return m._ModuleClass.protocolId === pid && m.isConnected();
    });

    if (!mod) { showToast('No connected module selected for sending.', 'error'); return; }

    try {
        await mod.sendMessage(text);
        chatInput.value = '';
    } catch (err) {
        showToast('Send failed: ' + err.message, 'error');
    }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

try {
    registerModule(MeshCoreModule);
    registerModule(MeshtasticModule);
    updateSendControls();
    console.log('[Meshcoms Portal] Loaded. Modules:', registeredModules.length);
} catch (err) {
    console.error('[Meshcoms Portal] Init failed:', err);
}
