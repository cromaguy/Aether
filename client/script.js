const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const socket = isLocal ? io() : io('https://aether-jvts.onrender.com');const configuration = {
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
const disconnectPeerBtn = document.getElementById('disconnect-peer-btn');

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
        msg.innerHTML = `
            <span class="sender">${sender}</span>
            <span class="text">${formattedText}</span>
            <span class="timestamp">${timestamp}</span>
        `;
    }
    
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTypingIndicator(name) {
    let indicator = document.getElementById('typing-indicator');
    
    if (indicator) {
        indicator.querySelector('.typing-text').textContent = `${name} is typing...`;
        return;
    }

    indicator = document.createElement('div');
    indicator.id = 'typing-indicator';
    indicator.className = 'typing-indicator';
    indicator.innerHTML = `
        <span class="typing-text">${name} is typing...</span>
        <div class="typing-dots">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
        </div>
    `;
    chatMessages.appendChild(indicator);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function hideTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.remove();
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

settingsBtn.onclick = () => settingsModal.classList.remove('hidden');
closeSettings.onclick = () => settingsModal.classList.add('hidden');
closeSettingsX.onclick = () => settingsModal.classList.add('hidden');


verboseToggle.onchange = (e) => {
    settings.verbose = e.target.checked;
    saveSettings();
};

usernameInput.oninput = (e) => {
    settings.username = e.target.value.trim();
    saveSettings();
};

chunkSizeSelect.onchange = (e) => {
    settings.chunkSize = parseInt(e.target.value);
    saveSettings();
};

bufferLimitSelect.onchange = (e) => {
    settings.bufferLimit = parseInt(e.target.value);
    saveSettings();
};

autoDownloadToggle.onchange = (e) => {
    settings.autoDownload = e.target.checked;
    saveSettings();
};

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

disconnectPeerBtn.onclick = () => {
    // For multi-peer, this would normally target a specific peer
    // For now, it clears all connections
    peers.forEach((peer, id) => {
        peer.pc.close();
    });
    peers.clear();
    showSnackbar('All peers disconnected.', 'info');
    updatePeersList();
    transferSection.classList.add('hidden');
    setupSection.classList.remove('hidden');
    connectionDot.className = 'dot disconnected';
    chatContainer.classList.add('hidden');
    chatMessages.innerHTML = '';
};

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
    
    // Automatically transition UI to the transfer room
    setupSection.classList.add('hidden');
    transferSection.classList.remove('hidden');
    hostSettings.classList.remove('hidden');
    
    // Display Room ID in the status badge so it can still be shared
    const hostName = settings.username || 'Host';
    roleBadge.textContent = `${hostName}'s Room (ID: ${roomID})`;
    updateUIStatus('waiting-file', 'Waiting for peers to join...', 'Listening for peer connections...');
    
    showSnackbar(`Room created successfully! Code: ${roomID}`, 'success');
});

socket.on('joined-successfully', (roomID) => {
    // Peer joined, now we wait for signals to create connections
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


socket.on('joined-successfully', (roomID) => {
    userRole = 'Guest/Receiver';
    console.log("Joined successfully, waiting for host offer.");
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
        if (peer.pc.remoteDescription) {
            await peer.pc.addIceCandidate(new RTCIceCandidate(signal));
        } else {
            if (!iceCandidateQueue.has(from)) iceCandidateQueue.set(from, []);
            iceCandidateQueue.get(from).push(signal);
        }
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
            setupSection.classList.add('hidden');
            transferSection.classList.remove('hidden');
            updateUIStatus('waiting-file');
            showSnackbar(`Connected to ${getPeerName(peerId)}`, 'success');
            updatePeersList();
            chatContainer.classList.remove('hidden');
        };


    dc.onclose = () => {
        const name = getPeerName(peerId);
        showSnackbar(`${name} disconnected.`, 'error');
        appendChatMessage(`${name} left the room`, 'System', 'system');
        peers.delete(peerId);
        updatePeersList();
    };


    dc.onmessage = (event) => {
        handleIncomingData(event.data, peerId);
        // BRIDGE TO WINUI
        if (window.chrome && window.chrome.webview) {
            let data;
            if (event.data instanceof ArrayBuffer) {
                const bytes = new Uint8Array(event.data);
                data = btoa(String.fromCharCode.apply(null, bytes));
            } else {
                data = btoa(event.data);
            }
            window.chrome.webview.postMessage({
                type: 'DATA_RECEIVED',
                data: data
            });
        }
    };
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
    activePeers.forEach(([id, p]) => p.dc.send(fileMetadata));
    
    appendChatMessage(`🚀 Started sending *${file.name}*`, 'System', 'system');
    
    fileNameDisp.textContent = file.name;
    fileSizeDisp.textContent = `0 ${formatSize(file.size).split(' ')[1]} / ${formatSize(file.size)}`;
    updateUIStatus('sending', `Sending ${file.name}...`);

    const reader = new FileReader();
    let offset = 0;

    const sendNextChunk = async () => {
        const canSend = activePeers.every(([id, p]) => p.dc.bufferedAmount < settings.bufferLimit);
        if (!canSend) {
            setTimeout(sendNextChunk, 50);
            return;
        }

        if (offset < file.size) {
            const slice = file.slice(offset, offset + settings.chunkSize);
            reader.onload = (e) => {
                activePeers.forEach(([id, p]) => p.dc.send(e.target.result));
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
        }
    };
    sendNextChunk();
}

function handleIncomingData(data, peerId) {
    console.log(`Received data from peer ${peerId}, type: ${typeof data}, length: ${data.byteLength || data.length}`);
    
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

    const chatMsg = `CHAT:${text}`;
    activePeers.forEach(([id, p]) => p.dc.send(chatMsg));
    appendChatMessage(text, 'Me', 'sent');
    chatInput.value = '';
}

chatSend.onclick = sendChatMessage;
chatInput.onkeypress = (e) => {
    if (e.key === 'Enter') sendChatMessage();
};

chatInput.oninput = () => {
    const activePeers = Array.from(peers.entries()).filter(([id, p]) => p.dc && p.dc.readyState === 'open');
    if (activePeers.length === 0) return;

    activePeers.forEach(([id, p]) => p.dc.send('TYPING:'));
};

dropZone.onclick = () => fileInput.click();
fileInput.onchange = (e) => {
    if (e.target.files[0]) sendFile(e.target.files[0]);
};

dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
};

dropZone.ondragleave = () => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
};

dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]);
};

loadSettings();
