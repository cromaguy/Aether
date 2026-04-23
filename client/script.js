const socket = io();
const configuration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

let pc = new RTCPeerConnection(configuration);
let dataChannel = null;
let currentRoomID = null;

const setupSection = document.getElementById('setup-section');
const transferSection = document.getElementById('transfer-section');
const statusText = document.getElementById('status');
const roomDisplay = document.getElementById('room-display');
const roomIdSpan = document.getElementById('room-id');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

// --- Room Management ---

document.getElementById('create-room-btn').onclick = () => {
    socket.emit('create-room');
};

document.getElementById('join-room-btn').onclick = () => {
    const roomID = document.getElementById('join-room-input').value;
    if (roomID) {
        currentRoomID = roomID;
        socket.emit('join-room', roomID);
    }
};

socket.on('room-created', (roomID) => {
    currentRoomID = roomID;
    roomIdSpan.textContent = roomID;
    roomDisplay.classList.remove('hidden');
    setupDataChannel();
});

socket.on('peer-joined', (peerId) => {
    console.log('Peer joined:', peerId);
    createOffer();
});

socket.on('signal', async ({ signal, from }) => {
    if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { roomID: currentRoomID, signal: pc.localDescription });
    } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
    } else if (signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal));
    }
});

// --- WebRTC Setup ---

function setupDataChannel() {
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { roomID: currentRoomID, signal: event.candidate });
        }
    };

    pc.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupDataChannelEvents();
    };
}

async function createOffer() {
    dataChannel = pc.createDataChannel('file-transfer');
    setupDataChannelEvents();
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { roomID: currentRoomID, signal: pc.localDescription });
}

function setupDataChannelEvents() {
    dataChannel.onopen = () => {
        statusText.textContent = 'Connected';
        setupSection.classList.add('hidden');
        transferSection.classList.remove('hidden');
    };

    dataChannel.onclose = () => {
        statusText.textContent = 'Disconnected';
    };

    dataChannel.onmessage = (event) => {
        handleIncomingData(event.data);
    };
}

// --- File Transfer Logic ---

const CHUNK_SIZE = 16384; // 16KB
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
        updateProgress(progress);

        if (offset < file.size) {
            readNextChunk();
        } else {
            progressText.textContent = 'Transfer Complete!';
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
        progressContainer.classList.remove('hidden');
        updateProgress(0);
        return;
    }

    receivedChunks.push(data);
    const currentSize = receivedChunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
    const progress = Math.min(100, Math.floor((currentSize / receivingFileSize) * 100));
    updateProgress(progress);

    if (currentSize >= receivingFileSize) {
        const blob = new Blob(receivedChunks);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = receivingFileName;
        a.click();
        progressText.textContent = 'File Received!';
    }
}

function updateProgress(percent) {
    progressContainer.classList.remove('hidden');
    progressFill.style.width = percent + '%';
    progressText.textContent = percent + '%';
}

// --- UI Event Listeners ---

dropZone.onclick = () => fileInput.click();
fileInput.onchange = (e) => {
    if (e.target.files[0]) sendFile(e.target.files[0]);
};

dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.style.backgroundColor = '#1e293b';
};

dropZone.ondragleave = () => {
    dropZone.style.backgroundColor = 'transparent';
};

dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.style.backgroundColor = 'transparent';
    if (e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]);
};
