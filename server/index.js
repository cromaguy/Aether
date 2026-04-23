const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

app.use(express.static(path.join(__dirname, '../client')));

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('create-room', () => {
    const roomID = Math.floor(1000 + Math.random() * 9000).toString();
    socket.join(roomID);
    socket.emit('room-created', roomID);
    console.log(`Room created: ${roomID} by ${socket.id}`);
  });

  socket.on('join-room', (roomID) => {
    const room = io.sockets.adapter.rooms.get(roomID);
    if (room && room.size > 0) {
      socket.join(roomID);
      socket.to(roomID).emit('peer-joined', socket.id);
      console.log(`User ${socket.id} joined room: ${roomID}`);
    } else {
      socket.emit('error', 'Room not found');
    }
  });

  socket.on('signal', ({ roomID, signal }) => {
    socket.to(roomID).emit('signal', {
      signal,
      from: socket.id,
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});
