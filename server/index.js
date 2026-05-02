const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, '../client')));

const roomMetadata = new Map();

function cleanupRoomMetadata(ioInstance) {
  roomMetadata.forEach((value, key) => {
    const room = ioInstance.sockets.adapter.rooms.get(key);
    if (!room || room.size === 0) {
      roomMetadata.delete(key);
    }
  });
}

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('create-room', (data) => {
    const maxPeers = data?.maxPeers ? parseInt(data.maxPeers) : 2;
    const password = data?.password || null;
    
    const roomID = Math.floor(1000 + Math.random() * 9000).toString();
    socket.join(roomID);
    
    roomMetadata.set(roomID, { password, maxPeers });
    
    socket.emit('room-created', roomID);
    console.log(`Room created: ${roomID} by ${socket.id}. Max: ${maxPeers}`);
  });

  socket.on('check-room', (roomID) => {
    const id = roomID?.trim();
    const room = io.sockets.adapter.rooms.get(id);
    const meta = roomMetadata.get(id);
    
    if (room && room.size > 0) {
      socket.emit('room-info', { 
        exists: true, 
        hasPassword: !!meta?.password,
        maxPeers: meta?.maxPeers || 2 
      });
    } else {
      socket.emit('room-info', { exists: false });
    }
  });

  socket.on('join-room', (data) => {
    const roomID = typeof data === 'object' ? data.roomID : data;
    const password = typeof data === 'object' ? data.password : null;

    // 1. Bulletproof check: Is there a socket actively in this room?
    const room = io.sockets.adapter.rooms.get(roomID);
    
    if (room && room.size > 0) {
      const meta = roomMetadata.get(roomID);
      
      if (meta?.password && meta.password !== password) {
        return socket.emit('error', 'Incorrect password.');
      }
      if (meta?.maxPeers && room.size >= meta.maxPeers) {
        return socket.emit('error', 'This room is full.');
      }

      socket.join(roomID);
      socket.to(roomID).emit('peer-joined', { peerId: socket.id, roomID });
      socket.emit('joined-successfully', roomID);
      console.log(`User ${socket.id} joined room: ${roomID}`);
    } else {
      socket.emit('error', 'Room not found or host disconnected.');
    }
  });

  socket.on('signal', ({ roomID, signal, to }) => {
    if (to) {
      io.to(to).emit('signal', { signal, from: socket.id, roomID });
    } else {
      socket.to(roomID).emit('signal', { signal, from: socket.id, roomID });
    }
  });

  socket.on('leave-room', ({ roomID }) => {
    if (!roomID) return;

    socket.leave(roomID);
    socket.to(roomID).emit('peer-left', { peerId: socket.id, roomID });
    cleanupRoomMetadata(io);
    console.log(`User ${socket.id} left room: ${roomID}`);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    cleanupRoomMetadata(io);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});