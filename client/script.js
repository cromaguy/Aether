const socket = io('https://aether-jvts.onrender.com');
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

let pc = null;
let dataChannel = null;
let currentRoomID = null;
let isVerbose = false;
let userRole = '';
let iceCandidateQueue = [];
let handshakeTimer = null;

const setupSection = document.getElementById('setup-section');
const transferSection = document.getElementById('transfer-section');
const loader = document.getElementById('loader');
const loaderText = document.getElementById('loader-text');
const statusText = document.getElementById('status');
const roleBadge = document.getElementById('role-badge');
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

// Settings Elements
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettings = document.getElementById('close-settings');
const verboseToggle = document.getElementById('verbose-toggle');

const STATUS_MAP = {
    'creating-room': { layman: 'Creating your secure room...', tech: 'Emitting create-room event to signaling server...' },
    'joining-room': { layman: 'Connecting to room...', tech: 'Joining room and waiting for peer signal...' },
    'handshake': { layman: 'Establishing direct connection...', tech: 'Performing WebRTC SDP handshake & ICE gathering...' },
    'connecting-dc': { layman: 'Opening data pipeline...', tech: 'Initializing RTCDataChannel...' },
    'connected': { layman: 'Connected! Ready to transfer.', tech: 'RTCPeerConnection state: connected. DataChannel open.' },
    'waiting-file': { layman: 'Waiting for files...', tech: 'DataChannel idle. Listening for binary stream...' },
    'sending': { layman: 'Sending file...', tech: 'Slicing file into 16KB chunks and streaming...' },
    'receiving': { layman: 'Receiving file...', tech: 'Collecting binary chunks into Blob array...' },
    'complete': { layman: 'Transfer complete!', tech: 'All chunks received. Blob reassembled and triggered.' }
};

function showSnackbar(message, type = 'info') {
    const container = document.getElementById('snackbar-container');
    const snack = document.createElement('div');
    snack.className = `snackbar ${type}`;
    snack.textContent = message;
    container.appendChild(snack);
    setTimeout(() => snack.remove(), 5000);
}

function updateUIStatus(key, customLayman = null, customTech = null) {
    const status = STATUS_MAP[key] || { layman: 'Processing...', tech: 'Unknown state...' };
    const text = isVerbose ? (customTech || status.tech) : (customLayman || status.layman);
    
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
            showSnackbar('Connection taking longer than usual... this may be due to strict firewall/NAT settings.', 'error');
        }, 15000);
    }
}

function hideLoader() {
    loader.classList.add('hidden');
    if (handshakeTimer) clearTimeout(handshakeTimer);
}

// --- Settings Logic ---
settingsBtn.onclick = () => settingsModal.classList.remove('hidden');
closeSettings.onclick = () => settingsModal.classList.add('hidden');
verboseToggle.onchange = (e) => {
    isVerbose = e.target.checked;
};

async function processIceQueue() {
    while (iceCandidateQueue.length > 0 && pc && pc.remoteDescription) {
        const candidate = iceCandidateQueue.shift();
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('Error adding queued ICE candidate', e);
        }
    }
}

function initPeerConnection() {
    if (pc) {
        pc.close();
    }
    iceCandidateQueue = [];
    pc = new RTCPeerConnection(configuration);
    
    pc.onicecandidate = (event) => {
        if (event.candidate && currentRoomID) {
            socket.emit('signal', { roomID: currentRoomID, signal: event.candidate });
        }
    };

    pc.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupDataChannelEvents();
    };
}

// --- Room Management ---
document.getElementById('create-room-btn').onclick = () => {
    showLoader('creating-room');
    socket.emit('create-room');
};

document.getElementById('join-room-btn').onclick = () => {
    const roomID = document.getElementById('join-room-input').value;
    if (roomID) {
        showLoader('joining-room');
        currentRoomID = roomID;
        initPeerConnection();
        socket.emit('join-room', roomID);
    }
};

socket.on('room-created', (roomID) => {
    hideLoader();
    userRole = 'Host/Sender';
    currentRoomID = roomID;
    roomIdSpan.textContent = roomID;
    roomDisplay.classList.remove('hidden');
    initPeerConnection();
    showSnackbar('Room created successfully!', 'success');
});

socket.on('error', (msg) => {
    hideLoader();
    showSnackbar(msg, 'error');
});

socket.on('peer-joined', (peerId) => {
    showSnackbar('A peer has joined the room!', 'success');
    createOffer();
});

socket.on('signal', async ({ signal, from }) => {
    if (!pc) initPeerConnection();

    if (signal.type === 'offer') {
        showLoader('handshake');
        userRole = 'Guest/Receiver';
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            await processIceQueue();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('signal', { roomID: currentRoomID, signal: pc.localDescription });
        } catch (e) {
            console.error('Offer handling failed', e);
        }
    } else if (signal.type === 'answer') {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            await processIceQueue();
        } catch (e) {
            console.error('Answer handling failed', e);
        }
    } else if (signal.candidate) {
        if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(signal));
        } else {
            iceCandidateQueue.push(signal);
        }
    }
});

// --- WebRTC Setup ---
async function createOffer() {
    showLoader('handshake');
    dataChannel = pc.createDataChannel('file-transfer');
    setupDataChannelEvents();
    
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('signal', { roomID: currentRoomID, signal: pc.localDescription });
    } catch (e) {
        console.error('Offer creation failed', e);
    }
}

function setupDataChannelEvents() {
    dataChannel.onopen = () => {
        hideLoader();
        roleBadge.textContent = userRole;
        updateUIStatus('connected');
        setupSection.classList.add('hidden');
        transferSection.classList.remove('hidden');
        updateUIStatus('waiting-file');
        showSnackbar('Direct P2P connection established!', 'success');
    };

    dataChannel.onclose = () => {
        statusText.textContent = 'Disconnected';
        showSnackbar('Connection closed by peer.', 'error');
    };

    dataChannel.onmessage = (event) => {
        handleIncomingData(event.data);
    };
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- File Transfer Logic ---
const CHUNK_SIZE = 16384; 
let receivedChunks = [];
let receivingFileName = '';
let receivingFileSize = 0;

async function sendFile(file) {
    if (!dataChannel || dataChannel.readyState !== 'open') return;

    const fileMetadata = JSON.stringify({
        name: file.name,
        size: file.size
    });
    
    dataChannel.send(fileMetadata);
    
    fileNameDisp.textContent = file.name;
    fileSizeDisp.textContent = `0 ${formatSize(file.size).split(' ')[1]} / ${formatSize(file.size)}`;
    
    updateUIStatus('sending', `Sending ${file.name}...`, `Streaming ${file.name} (${file.size} bytes)...`);

    const reader = new FileReader();
    let offset = 0;

    const readNextChunk = () => {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
        dataChannel.send(e.target.result);
        offset += CHUNK_SIZE;
        
        const progress = Math.min(100, Math.floor((offset / file.size) * 100));
        updateProgress(progress, offset, file.size);

        if (offset < file.size) {
            readNextChunk();
        } else {
            progressFill.classList.add('complete');
            updateUIStatus('complete');
            showSnackbar('File sent successfully!', 'success');
        }
    };

    readNextChunk();
}

function handleIncomingData(data) {
    if (typeof data === 'string') {
        const metadata = JSON.parse(data);
        receivingFileName = metadata.name;
        receivingFileSize = metadata.size;
        receivedChunks = [];
        
        fileNameDisp.textContent = receivingFileName;
        fileSizeDisp.textContent = `0 ${formatSize(receivingFileSize).split(' ')[1]} / ${formatSize(receivingFileSize)}`;
        
        progressContainer.classList.remove('hidden');
        updateProgress(0, 0, receivingFileSize);
        updateUIStatus('receiving', `Receiving ${receivingFileName}...`, `Collecting chunks for ${receivingFileName}...`);
        showSnackbar(`Peer started sending: ${receivingFileName}`, 'info');
        return;
    }

    receivedChunks.push(data);
    const currentSize = receivedChunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
    const progress = Math.min(100, Math.floor((currentSize / receivingFileSize) * 100));
    updateProgress(progress, currentSize, receivingFileSize);

    if (currentSize >= receivingFileSize) {
        progressFill.classList.add('complete');
        const blob = new Blob(receivedChunks);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = receivingFileName;
        a.click();
        updateUIStatus('complete');
        showSnackbar('File received successfully!', 'success');
    }
}

function updateProgress(percent, current, total) {
    progressContainer.classList.remove('hidden');
    progressFill.style.width = percent + '%';
    progressText.textContent = percent + '%';
    fileSizeDisp.textContent = `${formatSize(current)} / ${formatSize(total)}`;
}

// --- UI Event Listeners ---
dropZone.onclick = () => fileInput.click();
fileInput.onchange = (e) => {
    if (e.target.files[0]) sendFile(e.target.files[0]);
};

dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
    dropZone.style.backgroundColor = '#1e293b';
};

dropZone.ondragleave = () => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    dropZone.style.backgroundColor = 'transparent';
};

dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    dropZone.style.backgroundColor = 'transparent';
    if (e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]);
};
