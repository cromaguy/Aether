const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Use explicit websocket transport and sensible reconnection options for remote host
const socket = isLocal
    ? io()
    : io('https://aether-jvts.onrender.com', { transports: ['websocket'], secure: true, reconnectionAttempts: 5 });

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.stunprotocol.org:3478' },
        { urls: 'stun:stun.stunprotocol.org:5349' },
        { urls: 'stun:stun.cloudflare.com:3478' }
    ]
};

const peers = new Map();
let currentRoomID = null;
let isVerbose = false;
let userRole = '';
let iceCandidateQueue = new Map();
let handshakeTimer = null;
let typingTimer = null;
const remoteTypingTimers = new Map();

let settings = {
    username: '',
    accentColor: '#38bdf8',
    verbose: false,
    chunkSize: 16384,
    bufferLimit: 1048576,
    autoDownload: true
};

const setupSection = document.getElementById('setup-section');
const transferSection = document.getElementById('transfer-section');
const loader = document.getElementById('loader');
const loaderText = document.getElementById('loader-text');
const statusText = document.getElementById('status');
const roleBadge = document.getElementById('role-badge');
const connectionDot = document.getElementById('connection-dot');
const roomDisplay = document.getElementById('room-display');
const roomIdSpan = document.getElementById('room-id');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const fileNameDisp = document.getElementById('file-name');
const fileSizeDisp = document.getElementById('file-size');
const dropZone = document.getElementById('drop-zone');
const dropZoneText = document.getElementById('drop-zone-text');
const fileInput = document.getElementById('file-input');
const peersList = document.getElementById('peers-list');
const chatContainer = document.getElementById('chat-container');
const chatAttachBtn = document.getElementById('chat-attach');
const chatFileInput = document.getElementById('chat-file-input');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');

const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettings = document.getElementById('close-settings');
const closeSettingsX = document.getElementById('close-settings-x');
const verboseToggle = document.getElementById('verbose-toggle');
const chunkSizeSelect = document.getElementById('chunk-size-select');
const bufferLimitSelect = document.getElementById('buffer-limit-select');
const autoDownloadToggle = document.getElementById('auto-download-toggle');
const usernameInput = document.getElementById('username-input');
const hostSettings = document.getElementById('host-settings');
const disconnectRoomBtn = document.getElementById('disconnect-room-btn');
const disconnectPeersSettingsBtn = document.getElementById('disconnect-peers-settings-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');

// Chat view connection indicators
const connectionDotChat = document.getElementById('connection-dot-chat');
const statusChat = document.getElementById('status-chat');

const STATUS_MAP = {
    'creating-room': { layman: 'Initializing secure space...', tech: 'Emitting create-room event to signaling server...' },
    'joining-room': { layman: 'Entering the room...', tech: 'Joining room and waiting for peer signal...' },
    'handshake': { layman: 'Establishing P2P tunnel...', tech: 'Performing WebRTC SDP handshake & ICE gathering...' },
    'connected': { layman: 'Securely connected.', tech: 'RTCPeerConnection state: connected. DataChannel open.' },
    'waiting-file': { layman: 'Awaiting transfer...', tech: 'DataChannel idle. Listening for binary stream...' },
    'sending': { layman: 'Streaming data...', tech: 'Slicing file into binary chunks and streaming...' },
    'receiving': { layman: 'Incoming data...', tech: 'Collecting binary chunks into Blob array...' },
    'complete': { layman: 'Transfer successful!', tech: 'All chunks received. Blob reassembled and triggered.' }
};

function getPeerName(peerId) {
    const peer = peers.get(peerId);
    return peer?.username || `Peer ${peerId.slice(0, 4)}`;
}

function showSnackbar(message, type = 'info') {
    const container = document.getElementById('snackbar-container');
    const snack = document.createElement('div');
    snack.className = `snackbar ${type}`;
    snack.textContent = message;
    container.appendChild(snack);
    setTimeout(() => snack.remove(), 5000);
}

function appendChatMessage(text, sender, type) {
    const msg = document.createElement('div');
    msg.className = `chat-msg ${type}`;
    
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let formattedText = text
        .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
        .replace(/_(.*?)_/g, '<em>$1</em>')
        .replace(/~~(.*?)~~/g, '<del>$1</del>')
        .replace(/`(.*?)`/g, '<code>$1</code>');

    if (type === 'system') {
        msg.innerHTML = `<span>${formattedText}</span>`;
    } else {
        // Hide redundant sender label for local 'Me' messages
        const showSender = !(type === 'sent' && (sender === 'Me' || sender === settings.username));
        msg.innerHTML = `
            ${showSender ? `<span class="sender">${sender}</span>` : ''}
            <span class="text">${formattedText}</span>
            <span class="timestamp">${timestamp}</span>
        `;
    }
    
    // Append to home view chat
    chatMessages.appendChild(msg);
    
    // Also append to dedicated chat view if it exists
    const chatMessagesView = document.getElementById('chat-messages-view');
    if (chatMessagesView) {
        const msgClone = msg.cloneNode(true);
        chatMessagesView.appendChild(msgClone);
    }
    
    // Autoscroll to latest message in whichever view is visible
    setTimeout(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
        if (chatMessagesView) {
            chatMessagesView.scrollTop = chatMessagesView.scrollHeight;
        }
    }, 10);
}

function getChatMessageContainers() {
    const containers = [];
    if (chatMessages) containers.push(chatMessages);
    const chatMessagesView = document.getElementById('chat-messages-view');
    if (chatMessagesView) containers.push(chatMessagesView);
    return containers;
}

function showTypingIndicator(name) {
    const containers = getChatMessageContainers();
    containers.forEach(container => {
        let indicator = container.querySelector('.typing-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'typing-indicator';
            indicator.innerHTML = `
                <span class="typing-avatar"><i class="fas fa-ellipsis-h"></i></span>
                <span class="typing-text">${name} is typing...</span>
                <div class="typing-dots">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                </div>
            `;
            container.appendChild(indicator);
        } else {
            const text = indicator.querySelector('.typing-text');
            if (text) text.textContent = `${name} is typing...`;
        }
        container.scrollTop = container.scrollHeight;
    });
}

function hideTypingIndicator() {
    getChatMessageContainers().forEach(container => {
        const indicator = container.querySelector('.typing-indicator');
        if (indicator) indicator.remove();
    });
}

function updatePeersList() {
    peersList.innerHTML = '';
    peers.forEach((peer, id) => {
        const item = document.createElement('div');
        item.className = 'peer-item';
        const name = getPeerName(id);
        item.textContent = name;
        peersList.appendChild(item);
    });
    
    // Also update peer count display in chat view
    const peerCountDisplay = document.getElementById('peer-count-display');
    if (peerCountDisplay) {
        peerCountDisplay.textContent = peers.size;
    }
}

function updateConnectionIndicators(connected) {
    // Update all connection status indicators across views
    if (connected) {
        // Update home view connection dot
        if (connectionDot) connectionDot.className = 'dot connected';
        
        // Update chat view connection dot and show chat content
        if (connectionDotChat) {
            connectionDotChat.className = 'dot connected';
            if (statusChat) statusChat.textContent = 'Connected';
        }
        const chatContent = document.getElementById('chat-content');
        const chatNotConnected = document.getElementById('chat-not-connected');
        if (chatContent) chatContent.style.display = 'block';
        if (chatNotConnected) chatNotConnected.style.display = 'none';
        
        // Update transfer view and show transfer content
        const transferContent = document.getElementById('transfer-content');
        const transferNotConnected = document.getElementById('transfer-not-connected');
        if (transferContent) transferContent.style.display = 'block';
        if (transferNotConnected) transferNotConnected.style.display = 'none';
        
        // Show transfer section, hide setup section in home view
        if (setupSection) setupSection.classList.add('hidden');
        if (transferSection) transferSection.classList.remove('hidden');
        
        // Show room info display
        if (roomDisplay) roomDisplay.classList.remove('hidden');
    } else {
        // Update home view connection dot
        if (connectionDot) connectionDot.className = 'dot disconnected';
        
        // Update chat view connection dot and hide chat content
        if (connectionDotChat) {
            connectionDotChat.className = 'dot disconnected';
            if (statusChat) statusChat.textContent = 'Waiting for connection...';
        }
        const chatContent = document.getElementById('chat-content');
        const chatNotConnected = document.getElementById('chat-not-connected');
        if (chatContent) chatContent.style.display = 'none';
        if (chatNotConnected) chatNotConnected.style.display = 'flex';
        
        // Update transfer view and show not-connected state
        const transferContent = document.getElementById('transfer-content');
        const transferNotConnected = document.getElementById('transfer-not-connected');
        if (transferContent) transferContent.style.display = 'none';
        if (transferNotConnected) transferNotConnected.style.display = 'flex';
        
        // Hide transfer section, show setup section in home view
        if (setupSection) setupSection.classList.remove('hidden');
        if (transferSection) transferSection.classList.add('hidden');
        
        // Hide room info display
        if (roomDisplay) roomDisplay.classList.add('hidden');
    }
}

function updateUIStatus(key, customLayman = null, customTech = null) {
    const status = STATUS_MAP[key] || { layman: 'Processing...', tech: 'Unknown state...' };
    const text = settings.verbose ? (customTech || status.tech) : (customLayman || status.layman);
    
    if (!loader.classList.contains('hidden')) {
        loaderText.textContent = text;
    } else {
        statusText.textContent = text;
    }
}

function showLoader(statusKey) {
    updateUIStatus(statusKey);
    loader.classList.remove('hidden');
    if (statusKey === 'handshake') {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = setTimeout(() => {
            showSnackbar('Connection taking longer than usual... check firewall settings.', 'error');
        }, 15000);
    }
}

function hideLoader() {
    loader.classList.add('hidden');
    if (handshakeTimer) clearTimeout(handshakeTimer);
}

if (settingsBtn && settingsModal) {
    settingsBtn.onclick = () => settingsModal.classList.remove('hidden');
}
if (closeSettings && settingsModal) {
    closeSettings.onclick = () => settingsModal.classList.add('hidden');
}
if (closeSettingsX && settingsModal) {
    closeSettingsX.onclick = () => settingsModal.classList.add('hidden');
}


if (verboseToggle) {
    verboseToggle.onchange = (e) => {
        settings.verbose = e.target.checked;
        saveSettings();
    };
}

if (usernameInput) {
    usernameInput.oninput = (e) => {
        settings.username = e.target.value.trim();
        saveSettings();
    };
}

if (chunkSizeSelect) {
    chunkSizeSelect.onchange = (e) => {
        settings.chunkSize = parseInt(e.target.value);
        saveSettings();
    };
}

if (bufferLimitSelect) {
    bufferLimitSelect.onchange = (e) => {
        settings.bufferLimit = parseInt(e.target.value);
        saveSettings();
    };
}

if (autoDownloadToggle) {
    autoDownloadToggle.onchange = (e) => {
        settings.autoDownload = e.target.checked;
        saveSettings();
    };
}

document.querySelectorAll('.color-option').forEach(option => {
    option.onclick = () => {
        const color = option.getAttribute('data-color');
        settings.accentColor = color;
        document.documentElement.style.setProperty('--accent-color', color);
        document.documentElement.style.setProperty('--accent-hover', color + 'CC');
        document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('active'));
        option.classList.add('active');
        saveSettings();
    };
});

function disconnectCurrentRoom() {
    // Notify server that we're leaving
    if (socket && currentRoomID) {
        socket.emit('leave-room', { roomID: currentRoomID, role: userRole });
    }
    
    // For multi-peer, this would normally target a specific peer
    // For now, it clears all connections
    peers.forEach((peer, id) => {
        peer.pc.close();
    });
    peers.clear();
    currentRoomID = null;
    userRole = '';
    showSnackbar('All peers disconnected.', 'info');
    updatePeersList();
    connectionDot.className = 'dot disconnected';
    if (connectionDotChat) connectionDotChat.className = 'dot disconnected';
    chatMessages.innerHTML = '';
    
    // Hide transfer section and show setup section
    setupSection.classList.remove('hidden');
    transferSection.classList.add('hidden');
    
    // Update connection state for currently visible view
    const currentView = document.querySelector('.view-section:not(.hidden)');
    if (currentView && currentView.id === 'transfer-view') {
        updateConnectionState('transfer');
    } else if (currentView && currentView.id === 'chat-view') {
        updateConnectionState('chat');
    }
}

if (disconnectRoomBtn) disconnectRoomBtn.onclick = disconnectCurrentRoom;
if (disconnectPeersSettingsBtn) disconnectPeersSettingsBtn.onclick = disconnectCurrentRoom;

if (clearHistoryBtn) {
    clearHistoryBtn.onclick = () => {
        localStorage.removeItem('aether_history');
        loadHistoryView();
        showSnackbar('Transfer history cleared.', 'info');
    };
}

function saveSettings() {
    localStorage.setItem('aether_settings', JSON.stringify(settings));
}

function loadSettings() {
    const saved = localStorage.getItem('aether_settings');
    if (saved) {
        settings = { ...settings, ...JSON.parse(saved) };
        document.documentElement.style.setProperty('--accent-color', settings.accentColor);
        document.documentElement.style.setProperty('--accent-hover', settings.accentColor + 'CC');
        verboseToggle.checked = settings.verbose;
        chunkSizeSelect.value = settings.chunkSize;
        bufferLimitSelect.value = settings.bufferLimit;
        autoDownloadToggle.checked = settings.autoDownload;
        usernameInput.value = settings.username || '';
        document.querySelectorAll('.color-option').forEach(opt => {
            if (opt.getAttribute('data-color') === settings.accentColor) opt.classList.add('active');
            else opt.classList.remove('active');
        });
    }
}

function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(configuration);
    
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { roomID: currentRoomID, signal: event.candidate, to: peerId });
        } else {
            socket.emit('signal', { roomID: currentRoomID, signal: { candidate: null }, to: peerId });
        }
    };

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
            connectionDot.className = 'dot connected';
            if (window.chrome && window.chrome.webview) {
                window.chrome.webview.postMessage({
                    type: 'CONNECTION_STATE',
                    state: 'Connected'
                });
            }
        } else if (state === 'failed') {
            connectionDot.className = 'dot disconnected';
            if (window.chrome && window.chrome.webview) {
                window.chrome.webview.postMessage({
                    type: 'CONNECTION_STATE',
                    state: 'Failed'
                });
            }
        }
    };

    pc.ondatachannel = (event) => {
        const dc = event.channel;
        setupDataChannelEvents(peerId, dc);
        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage({
                type: 'CONNECTION_STATE',
                state: 'Connected' // Simplified state mapping
            });
        }
    };

    return pc;
}

async function processIceQueue(peerId) {
    const queue = iceCandidateQueue.get(peerId) || [];
    const peer = peers.get(peerId);
    if (!peer || !peer.pc.remoteDescription) return;

    while (queue.length > 0) {
        const candidate = queue.shift();
        try {
            await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) { console.error('ICE error', e); }
    }
    iceCandidateQueue.set(peerId, queue);
}

document.getElementById('create-room-btn').onclick = () => {
    const maxPeers = document.getElementById('create-max-peers').value;
    const password = document.getElementById('create-password').value;
    showLoader('creating-room');
    socket.emit('create-room', { maxPeers, password });
};

document.getElementById('join-room-input').oninput = (e) => {
    const roomID = e.target.value;
    if (roomID.length === 4) {
        socket.emit('check-room', roomID);
    }
};

socket.on('room-info', (info) => {
    const pwdGroup = document.getElementById('join-password-group');
    if (info.exists && info.hasPassword) {
        pwdGroup.classList.remove('hidden');
    } else {
        pwdGroup.classList.add('hidden');
    }
});

document.getElementById('join-room-btn').onclick = () => {
    const roomID = document.getElementById('join-room-input').value.trim();
    const password = document.getElementById('join-password').value.trim();
    if (roomID) {
        showLoader('joining-room');
        currentRoomID = roomID;
        // REMOVED: initPeerConnection(); 
        socket.emit('join-room', { roomID, password });
    }
};


socket.on('room-created', (roomID) => {
    hideLoader();
    userRole = 'Host/Sender';
    currentRoomID = roomID;
    
    // Host must explicitly join its own room to receive peer-joined events
    socket.emit('join-room', { roomID, password: '' });
    
    // Update UI to show room management
    setupSection.classList.add('hidden');
    transferSection.classList.remove('hidden');
    if (hostSettings) hostSettings.classList.remove('hidden');
    
    // Display Room ID in the status badge so it can still be shared
    const hostName = settings.username || 'Host';
    roleBadge.textContent = `${hostName}'s Room (ID: ${roomID})`;
    
    // Update room display
    if (roomIdSpan) roomIdSpan.textContent = roomID;
    if (roomDisplay) roomDisplay.classList.remove('hidden');
    
    updateUIStatus('waiting-file', 'Waiting for peers to join...', 'Listening for peer connections...');
    
    showSnackbar(`Room created successfully! Code: ${roomID}`, 'success');
});

socket.on('joined-successfully', (roomID) => {
    userRole = 'Guest/Receiver';
    currentRoomID = roomID;
    
    // Update UI to show room management
    setupSection.classList.add('hidden');
    transferSection.classList.remove('hidden');
    
    // Update room display
    if (roomIdSpan) roomIdSpan.textContent = roomID;
    if (roomDisplay) roomDisplay.classList.remove('hidden');
    
    console.log("Joined successfully, waiting for host offer.");
});

socket.on('error', (msg) => {
    hideLoader();
    showSnackbar(msg, 'error');
});

socket.on('peer-joined', ({ peerId, roomID }) => {
    console.log(`Peer ${peerId} joined. Initiating offer...`);
    showSnackbar(`${getPeerName(peerId)} joined!`, 'success');
    appendChatMessage(`${getPeerName(peerId)} joined the room`, 'System', 'system');
    createOffer(peerId); 
});

socket.on('peer-left', ({ peerId }) => {
    const departingPeer = peers.get(peerId);
    if (departingPeer) {
        const name = departingPeer.username || getPeerName(peerId);
        departingPeer.pc.close();
        peers.delete(peerId);
        updatePeersList();
        appendChatMessage(`${name} left the room.`, 'System', 'system');
    }

    if (peers.size === 0) {
        updateConnectionIndicators(false);
    }
});

socket.on('signal', async ({ signal, from, roomID }) => {
    if (!peers.has(from)) {
        const pc = createPeerConnection(from);
        peers.set(from, { pc, dc: null });
    }
    const peer = peers.get(from);

    if (signal.type === 'offer') {
        showLoader('handshake');
        userRole = 'Guest/Receiver';
        try {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(signal));
            await processIceQueue(from);
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            socket.emit('signal', { roomID: currentRoomID, signal: peer.pc.localDescription, to: from });
        } catch (e) { console.error('Offer fail', e); }
    } else if (signal.type === 'answer') {
        try {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(signal));
            await processIceQueue(from);
        } catch (e) { console.error('Answer fail', e); }
    } else if (signal.candidate) {
        try {
            let candidateObj = signal;
            if (typeof signal.candidate === 'string') {
                // Some senders stringify the candidate; normalize it.
                try { candidateObj = { candidate: JSON.parse(signal.candidate).candidate, sdpMid: JSON.parse(signal.candidate).sdpMid, sdpMLineIndex: JSON.parse(signal.candidate).sdpMLineIndex }; } catch { candidateObj = signal; }
            }

            if (peer.pc.remoteDescription) {
                await peer.pc.addIceCandidate(new RTCIceCandidate(candidateObj));
            } else {
                if (!iceCandidateQueue.has(from)) iceCandidateQueue.set(from, []);
                iceCandidateQueue.get(from).push(candidateObj);
            }
        } catch (e) { console.error('ICE handling error', e); }
    }
});

async function createOffer(peerId) {
    showLoader('handshake');
    if (!peers.has(peerId)) {
        const pc = createPeerConnection(peerId);
        peers.set(peerId, { pc, dc: null });
    }
    const peer = peers.get(peerId);
    
    const dc = peer.pc.createDataChannel('file-transfer');
    peer.dc = dc;
    setupDataChannelEvents(peerId, dc);
    
    try {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        socket.emit('signal', { roomID: currentRoomID, signal: peer.pc.localDescription, to: peerId });
    } catch (e) { console.error('Offer fail', e); }
}

function setupDataChannelEvents(peerId, dc) {
    const peer = peers.get(peerId);
    if (peer) peer.dc = dc;
    
        dc.onopen = () => {
            const username = settings.username || 'Anonymous';
            dc.send(`USER_INFO:${username}`);

    
            hideLoader();
            roleBadge.textContent = userRole;
            updateUIStatus('connected');
            updateUIStatus('waiting-file');
            showSnackbar(`Connected to ${getPeerName(peerId)}`, 'success');
            updatePeersList();
            
            // Update all connection indicators across views
            updateConnectionIndicators(true);
            
            // Update connection state for currently visible views
            const currentView = document.querySelector('.view-section:not(.hidden)');
            if (currentView && currentView.id === 'transfer-view') {
                updateConnectionState('transfer');
            } else if (currentView && currentView.id === 'chat-view') {
                updateConnectionState('chat');
            }
        };


    dc.onclose = () => {
        const name = getPeerName(peerId);
        showSnackbar(`${name} disconnected.`, 'error');
        appendChatMessage(`${name} left the room`, 'System', 'system');
        peers.delete(peerId);
        updatePeersList();
        
        // Update connection state if no more peers
        if (peers.size === 0) {
            updateConnectionIndicators(false);
            
            const currentView = document.querySelector('.view-section:not(.hidden)');
            if (currentView && currentView.id === 'transfer-view') {
                updateConnectionState('transfer');
            } else if (currentView && currentView.id === 'chat-view') {
                updateConnectionState('chat');
            }
        }
    };


    dc.onmessage = (event) => {
        handleIncomingData(event.data, peerId);
        // BRIDGE TO WINUI
        if (window.chrome && window.chrome.webview) {
                let data;
                if (event.data instanceof ArrayBuffer) {
                    const bytes = new Uint8Array(event.data);
                    data = base64FromUint8Array(bytes);
                } else {
                    const encoder = new TextEncoder();
                    const bytes = encoder.encode(event.data);
                    data = base64FromUint8Array(bytes);
                }
            window.chrome.webview.postMessage({
                type: 'DATA_RECEIVED',
                data: data
            });
        }
    };
}

// Safe base64 conversion for Uint8Array using chunking to avoid apply() limits
function base64FromUint8Array(bytes) {
    const CHUNK_SIZE = 0x8000; // 32KB chunks
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const slice = bytes.subarray(i, i + CHUNK_SIZE);
        let chunk = '';
        for (let k = 0; k < slice.length; k++) {
            chunk += String.fromCharCode(slice[k]);
        }
        binary += chunk;
    }
    return btoa(binary);
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// File Transfer Logic
let receivedChunks = [];
let receivingFileName = '';
let receivingFileSize = 0;

async function sendFile(file) {
    const activePeers = Array.from(peers.entries()).filter(([id, p]) => p.dc && p.dc.readyState === 'open');
    if (activePeers.length === 0) {
        showSnackbar('No connected peers to send to!', 'error');
        return;
    }

    const fileMetadata = JSON.stringify({ name: file.name, size: file.size });
    let sendSuccess = false;
    activePeers.forEach(([id, p]) => {
        try {
            if (p.dc.readyState === 'open') {
                p.dc.send(fileMetadata);
                sendSuccess = true;
            }
        } catch (e) {
            console.error(`Failed to send metadata to peer ${id}:`, e);
        }
    });
    
    if (!sendSuccess) {
        showSnackbar('Failed to send file metadata!', 'error');
        return;
    }
    
    appendChatMessage(`🚀 Started sending *${file.name}*`, 'System', 'system');
    
    fileNameDisp.textContent = file.name;
    fileSizeDisp.textContent = `0 ${formatSize(file.size).split(' ')[1]} / ${formatSize(file.size)}`;
    updateUIStatus('sending', `Sending ${file.name}...`);

    const reader = new FileReader();
    let offset = 0;

    const sendNextChunk = async () => {
        const canSend = activePeers.every(([id, p]) => p.dc && p.dc.readyState === 'open' && p.dc.bufferedAmount < settings.bufferLimit);
        if (!canSend) {
            setTimeout(sendNextChunk, 50);
            return;
        }

        if (offset < file.size) {
            const slice = file.slice(offset, offset + settings.chunkSize);
            reader.onload = (e) => {
                activePeers.forEach(([id, p]) => {
                    try {
                        if (p.dc && p.dc.readyState === 'open') {
                            p.dc.send(e.target.result);
                        }
                    } catch (err) {
                        console.error(`Failed to send chunk to peer ${id}:`, err);
                    }
                });
                offset += settings.chunkSize;
                updateProgress(Math.min(100, Math.floor((offset / file.size) * 100)), offset, file.size);
                sendNextChunk();
            };
            reader.readAsArrayBuffer(slice);
        } else {
            progressFill.classList.add('complete');
            updateUIStatus('complete');
            showSnackbar('File sent to all peers!', 'success');
            appendChatMessage(`✅ *${file.name}* sent successfully!`, 'System', 'system');
                    // Save to local history
                    saveHistoryEntry(file.name, file.size);
        }
    };
    sendNextChunk();
}

function saveHistoryEntry(name, size) {
    try {
        const key = 'aether_history';
        let arr = [];
        const raw = localStorage.getItem(key);
        if (raw) {
            try { arr = JSON.parse(raw); } catch { arr = []; }
        }
        arr.unshift({ FileName: name, FileSize: size, Timestamp: new Date().toISOString() });
        // keep last 200 entries
        if (arr.length > 200) arr = arr.slice(0, 200);
        localStorage.setItem(key, JSON.stringify(arr));
    } catch (e) { console.error('Failed to save history', e); }
}

function handleIncomingData(data, peerId) {
    console.log(`Received data from peer ${peerId}, type: ${typeof data}, length: ${data.byteLength || data.length}`);
    // If data is binary (ArrayBuffer/Uint8Array), attempt to detect if it's UTF-8 text (chat/typing/metadata)
    if (!(typeof data === 'string')) {
        try {
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data instanceof Uint8Array ? data : null);
            if (bytes) {
                const maxProbe = Math.min(1024, bytes.length);
                const prefix = new TextDecoder().decode(bytes.subarray(0, maxProbe));
                if (prefix.startsWith('CHAT:') || prefix.startsWith('TYPING:') || prefix.startsWith('USER_INFO:') || (prefix.startsWith('{') && prefix.includes('"name"') && prefix.includes('"size"'))) {
                    // Treat as text message/metadata
                    data = new TextDecoder().decode(bytes);
                }
            }
        } catch (e) { console.error('Text probe failed', e); }
    }

        if (typeof data === 'string') {
            if (data.startsWith('CHAT:')) {
                const msg = data.substring(5);
                const name = getPeerName(peerId);
                appendChatMessage(msg, name, 'received');
                hideTypingIndicator();
                return;
            }
            if (data.startsWith('TYPING:')) {
                const name = getPeerName(peerId);
                showTypingIndicator(name);
                if (remoteTypingTimers.has(peerId)) clearTimeout(remoteTypingTimers.get(peerId));
                const timer = setTimeout(() => {
                    hideTypingIndicator();
                    remoteTypingTimers.delete(peerId);
                }, 3000);
                remoteTypingTimers.set(peerId, timer);
                return;
            }
            if (data.startsWith('USER_INFO:')) {

            const username = data.substring(10);
            const peer = peers.get(peerId);
            if (peer) {
                peer.username = username;
                updatePeersList();
            }
            return;
        }
    }

    let metadata = null;
    
    // Try to parse incoming data as JSON metadata
    if (typeof data === 'string') {
        try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed.name === 'string' && typeof parsed.size === 'number' && parsed.size > 0) {
                metadata = parsed;
            }
        } catch (e) { /* not JSON metadata */ }
    }
    
    if (metadata) {

            receivingFileName = metadata.name;
            receivingFileSize = metadata.size;
            receivedChunks = [];
            
            const name = getPeerName(peerId);
            appendChatMessage(`📥 ${name} is sending *${metadata.name}*...`, 'System', 'system');
            
            fileNameDisp.textContent = receivingFileName;
            fileSizeDisp.textContent = `0 ${formatSize(receivingFileSize).split(' ')[1]} / ${formatSize(receivingFileSize)}`;
            progressContainer.classList.remove('hidden');
            updateProgress(0, 0, receivingFileSize);
            updateUIStatus('receiving');
            showSnackbar(`${name} is sending: ${receivingFileName}`, 'info');
            return;

    }

    // It's a data chunk
    receivedChunks.push(data);
    const currentSize = receivedChunks.reduce((acc, chunk) => acc + (chunk.byteLength || chunk.length), 0);
    const progress = Math.min(100, Math.floor((currentSize / receivingFileSize) * 100));
    updateProgress(progress, currentSize, receivingFileSize);

        if (currentSize >= receivingFileSize) {
            progressFill.classList.add('complete');
            const blob = new Blob(receivedChunks);
            const url = URL.createObjectURL(blob);
            if (settings.autoDownload) {
                const a = document.createElement('a');
                a.href = url;
                a.download = receivingFileName;
                a.click();
            }
            updateUIStatus('complete');
            showSnackbar('File received successfully!', 'success');
            appendChatMessage(`✅ Received *${receivingFileName}*`, 'System', 'system');
                // Save to local history
                saveHistoryEntry(receivingFileName, currentSize);
            
            // Reset after completion

        receivingFileSize = 0;
        receivedChunks = [];
    }
}

function updateProgress(percent, current, total) {
    progressContainer.classList.remove('hidden');
    progressFill.style.width = percent + '%';
    progressText.textContent = percent + '%';
    fileSizeDisp.textContent = `${formatSize(current)} / ${formatSize(total)}`;
}

// UI Event Listeners
document.querySelectorAll('.markup-btn').forEach(btn => {
    btn.onclick = () => {
        const type = btn.getAttribute('data-markup');
        const start = chatInput.selectionStart;
        const end = chatInput.selectionEnd;
        const text = chatInput.value;
        const selectedText = text.substring(start, end);
        
        const markers = {
            bold: { start: '*', end: '*' },
            italic: { start: '_', end: '_' },
            strike: { start: '~~', end: '~~' },
            code: { start: '`', end: '`' }
        };
        
        const marker = markers[type];
        
        if (selectedText.length > 0) {
            const isWrapped = selectedText.startsWith(marker.start) && selectedText.endsWith(marker.end);
            
            if (isWrapped) {
                const unwrapped = selectedText.substring(marker.start.length, selectedText.length - marker.end.length);
                chatInput.value = text.substring(0, start) + unwrapped + text.substring(end);
                chatInput.focus();
                chatInput.setSelectionRange(start, start + unwrapped.length);
            } else {
                const wrapped = `${marker.start}${selectedText}${marker.end}`;
                chatInput.value = text.substring(0, start) + wrapped + text.substring(end);
                chatInput.focus();
                chatInput.setSelectionRange(start + marker.start.length, start + marker.start.length + selectedText.length);
            }
        } else {
            const insertion = `${marker.start}${marker.end}`;
            chatInput.value = text.substring(0, start) + insertion + text.substring(end);
            chatInput.focus();
            chatInput.setSelectionRange(start + marker.start.length, start + marker.start.length);
        }
    };
});


document.querySelectorAll('.suggestion-btn').forEach(btn => {
    btn.onclick = () => {
        chatInput.value = btn.textContent;
        chatInput.focus();
        sendChatMessage();
    };
});

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    const activePeers = Array.from(peers.entries()).filter(([id, p]) => p.dc && p.dc.readyState === 'open');
    if (activePeers.length === 0) {
        showSnackbar('No connected peers to chat with!', 'error');
        return;
    }

    // Show message immediately (optimistic UI)
    appendChatMessage(text, 'Me', 'sent');
    chatInput.value = '';
    
    // Send in background
    const chatMsg = `CHAT:${text}`;
    activePeers.forEach(([id, p]) => {
        try {
            p.dc.send(chatMsg);
        } catch (e) {
            console.error('Error sending chat:', e);
            showSnackbar('Failed to send message', 'error');
        }
    });
}

chatSend.onclick = sendChatMessage;
chatInput.onkeypress = (e) => {
    if (e.key === 'Enter') sendChatMessage();
};

// Chat view input handlers (for dedicated chat page)
const chatSendView = document.getElementById('chat-send-view');
const chatInputView = document.getElementById('chat-input-view');
if (chatSendView && chatInputView) {
    chatSendView.onclick = () => {
        const text = chatInputView.value.trim();
        if (!text) return;

        const activePeers = Array.from(peers.entries()).filter(([id, p]) => p.dc && p.dc.readyState === 'open');
        if (activePeers.length === 0) {
            showSnackbar('No connected peers to chat with!', 'error');
            return;
        }

        // Show message immediately (optimistic UI)
        appendChatMessage(text, 'Me', 'sent');
        chatInputView.value = '';
        
        // Send in background
        const chatMsg = `CHAT:${text}`;
        activePeers.forEach(([id, p]) => {
            try {
                p.dc.send(chatMsg);
            } catch (e) {
                console.error('Error sending chat:', e);
                showSnackbar('Failed to send message', 'error');
            }
        });
    };
    
    chatInputView.onkeypress = (e) => {
        if (e.key === 'Enter') {
            const text = chatInputView.value.trim();
            if (!text) return;

            const activePeers = Array.from(peers.entries()).filter(([id, p]) => p.dc && p.dc.readyState === 'open');
            if (activePeers.length === 0) {
                showSnackbar('No connected peers to chat with!', 'error');
                return;
            }

            appendChatMessage(text, 'Me', 'sent');
            chatInputView.value = '';
            
            const chatMsg = `CHAT:${text}`;
            activePeers.forEach(([id, p]) => {
                try {
                    p.dc.send(chatMsg);
                } catch (e) {
                    console.error('Error sending chat:', e);
                    showSnackbar('Failed to send message', 'error');
                }
            });
        }
    };
    
    chatInputView.oninput = () => {
        const activePeers = Array.from(peers.entries()).filter(([id, p]) => p.dc && p.dc.readyState === 'open');
        if (activePeers.length === 0) return;

        activePeers.forEach(([id, p]) => p.dc.send('TYPING:'));
    };
}

// Chat attach support
if (chatAttachBtn && chatFileInput) {
    chatAttachBtn.onclick = () => chatFileInput.click();
    chatFileInput.onchange = (e) => {
        const f = e.target.files ? e.target.files[0] : null;
        if (f) {
            appendChatMessage(`Sending file: ${f.name}`, 'Me', 'sent');
            sendFile(f);
        }
        // clear selection
        chatFileInput.value = '';
    };
}

// Chat view attach support (for dedicated chat page view)
const chatAttachViewBtn = document.getElementById('chat-attach-view');
const chatFileInputView = document.getElementById('chat-file-input-view');
if (chatAttachViewBtn && chatFileInputView) {
    chatAttachViewBtn.onclick = () => chatFileInputView.click();
    chatFileInputView.onchange = (e) => {
        const f = e.target.files ? e.target.files[0] : null;
        if (f) {
            appendChatMessage(`Sending file: ${f.name}`, 'Me', 'sent');
            sendFile(f);
        }
        chatFileInputView.value = '';
    };
}

chatInput.oninput = () => {
    const activePeers = Array.from(peers.entries()).filter(([id, p]) => p.dc && p.dc.readyState === 'open');
    if (activePeers.length === 0) return;

    activePeers.forEach(([id, p]) => p.dc.send('TYPING:'));
};

dropZone.onclick = () => fileInput.click();
if (dropZone && fileInput) {
    dropZone.onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
        if (e.target.files[0]) sendFile(e.target.files[0]);
    };

    dropZone.ondragover = (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    };

    dropZone.ondragleave = () => {
        dropZone.classList.remove('drag-over');
    };

    dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]);
    };
}

loadSettings();

// ===== CONNECTION STATE CHECK =====
function isConnected() {
    return currentRoomID && peers.size > 0;
}

function updateConnectionState(page) {
    if (page === 'transfer') {
        const transferContent = document.getElementById('transfer-content');
        const transferNotConnected = document.getElementById('transfer-not-connected');
        
        if (transferContent && transferNotConnected) {
            if (isConnected()) {
                transferNotConnected.style.display = 'none';
                transferContent.style.display = 'block';
            } else {
                transferNotConnected.style.display = 'flex';
                transferContent.style.display = 'none';
            }
        }
    } else if (page === 'chat') {
        const chatContent = document.getElementById('chat-content');
        const chatNotConnected = document.getElementById('chat-not-connected');
        
        if (chatContent && chatNotConnected) {
            if (isConnected()) {
                chatNotConnected.style.display = 'none';
                chatContent.style.display = 'block';
            } else {
                chatNotConnected.style.display = 'flex';
                chatContent.style.display = 'none';
            }
        }
    }
}

// ===== SPA NAVIGATION =====
function navigateTo(page) {
    // Hide all views
    document.querySelectorAll('.view-section').forEach(view => view.classList.add('hidden'));
    
    // Show the requested view
    const viewMap = {
        'home': 'home-view',
        'transfer': 'transfer-view',
        'chat': 'chat-view',
        'history': 'history-view',
        'settings': 'settings-view'
    };
    
    const viewId = viewMap[page];
    if (viewId) {
        const viewElement = document.getElementById(viewId);
        if (viewElement) {
            viewElement.classList.remove('hidden');
        }
    }
    
    // Update navigation highlights
    document.querySelectorAll('.nav-bottom-item, .rail-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll(`[data-page="${page}"]`).forEach(el => el.classList.add('active'));
    
    // Handle special view logic
    if (page === 'chat') {
        // Sync room display in chat view
        const roomDisplay = document.getElementById('current-room-display');
        if (roomDisplay && currentRoomID) {
            roomDisplay.textContent = currentRoomID;
        } else if (roomDisplay) {
            roomDisplay.textContent = 'Not Connected';
        }
        // Check connection state for chat view
        updateConnectionState('chat');
    } else if (page === 'transfer') {
        // Check connection state for transfer view
        updateConnectionState('transfer');
    } else if (page === 'history') {
        // Load and display history
        loadHistoryView();
    } else if (page === 'settings') {
        // Populate settings when opening
        if (typeof loadSettings === 'function') loadSettings();
    }
}

function loadHistoryView() {
    const historyList = document.getElementById('history-list');
    const raw = localStorage.getItem('aether_history');
    if (!raw) {
        historyList.innerHTML = '<p class="muted">No history yet.</p>';
        return;
    }

    try {
        const items = JSON.parse(raw);
        if (!items || items.length === 0) {
            historyList.innerHTML = '<p class="muted">No history yet.</p>';
            return;
        }

        historyList.innerHTML = '';
        items.forEach(it => {
            const el = document.createElement('div');
            el.className = 'history-item';
            const date = new Date(it.Timestamp);
            const formattedDate = date.toLocaleString();
            const fileSize = formatSize(it.FileSize);
            el.style.cssText = `
                padding: 1rem 1.5rem;
                border-radius: 12px;
                border: 1px solid var(--input-border);
                background: var(--card-bg);
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 1rem;
                margin-bottom: 0.75rem;
                transition: all 0.2s ease;
                cursor: pointer;
            `;
            el.onmouseover = () => el.style.background = 'var(--hover-bg)';
            el.onmouseout = () => el.style.background = 'var(--card-bg)';

            const fileInfo = document.createElement('div');
            fileInfo.style.cssText = 'flex: 1;';
            fileInfo.innerHTML = `
                <div style="font-weight: 600; margin-bottom: 0.25rem; color: var(--text-color);">${it.FileName}</div>
                <div style="font-size: 0.85rem; color: var(--text-muted);">${formattedDate} • ${fileSize}</div>
            `;

            const icon = document.createElement('div');
            icon.style.cssText = 'color: var(--accent-color); font-size: 1.2rem;';
            icon.innerHTML = '<i class="fas fa-check-circle"></i>';

            el.appendChild(fileInfo);
            el.appendChild(icon);
            historyList.appendChild(el);
        });
    } catch (e) {
        console.error('Failed to load history:', e);
        historyList.innerHTML = '<p class="muted">No history yet.</p>';
    }
}

// Navigation highlighting and behavior
function initNavigation() {
    // Setup navigation click handlers for SPA
    document.querySelectorAll('[data-page]').forEach(navItem => {
        navItem.onclick = (e) => {
            e.preventDefault();
            const page = navItem.getAttribute('data-page');
            navigateTo(page);
        };
    });

    // Wire settings buttons
    const settingsBtnTop = document.getElementById('settings-btn');
    if (settingsBtnTop) settingsBtnTop.onclick = () => document.getElementById('settings-modal').classList.remove('hidden');
    
    // Show home view by default
    navigateTo('home');
}

initNavigation();
