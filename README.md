# 🌌 Aether

**Fast, Private, and Decentralized Peer-to-Peer File Transfer.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![WebRTC](https://img.shields.io/badge/Protocol-WebRTC-blue.svg)](https://webrtc.org/)

Aether is a browser-based P2P tool that allows users to send large files directly to each other without the need for a central storage server. By leveraging WebRTC, Aether establishes a direct "pipeline" between two browsers, ensuring your data never touches a third-party server.

[🚀 Live Demo](https://aether-ch.vercel.app/) | [🛠️ Backend Status](https://aether-jvts.onrender.com)

---

## ✨ Features

- **🚀 Direct P2P Transfer**: Files are streamed directly from Peer A to Peer B using WebRTC Data Channels.
- **🔒 Privacy First**: Since files aren't uploaded to a server, your data remains private and secure.
- **📦 Large File Support**: Intelligent file chunking (16KB slices) allows the transfer of massive files without crashing the browser.
- **📱 Fully Responsive**: A sleek, modern UI that works seamlessly on desktops, tablets, and smartphones.
- **🛠️ Verbose Mode**: A toggle for power users to see the technical WebRTC handshake and signaling process in real-time.
- **⚡ Instant Connection**: Unique room codes for quick pairing via a lightweight Socket.io signaling server.

---

## 🛠️ Tech Stack

| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend** | HTML5, CSS3, JavaScript | Modern, responsive user interface |
| **Signaling** | Node.js, Socket.io | Matchmaking peers and swapping connection details |
| **Protocol** | WebRTC | Establishing the direct peer-to-peer data channel |
| **Infrastructure** | Vercel & Render | High-availability hosting for frontend and backend |

---

## ⚙️ How It Works

Aether follows a four-step process to connect two strangers across the internet:

1. **Signaling**: User A creates a room. User B joins using a code. The signaling server (Node.js) helps them find each other.
2. **The Handshake**: The browsers exchange **SDP (Session Description Protocol)** packets and **ICE Candidates** to negotiate the best network path.
3. **Direct Pipeline**: Once a path is found, a `RTCDataChannel` is opened. The signaling server now steps out of the way.
4. **Chunked Streaming**: The file is sliced into small binary chunks, sent across the P2P line, and reassembled on the receiver's end as a `Blob`.

---

## 📜 License

Distributed under the **MIT License**. See `LICENSE` for more information.

---

<p align="center">Built with ❤️ by Team ChromaHub</p>
