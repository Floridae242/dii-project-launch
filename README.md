# DII: Project Launch! (Open House Game)
Real-time multiplayer web game inspired by *Muffin Time*, re-themed for the Digital Industry Integration (DII) program.

**Goal**: Be the first to *Launch* with **exactly 10 Project Progress cards** in hand and survive the reaction window.

## Quick Start
1. Install Node 18+
2. In terminal:
   ```bash
   cd dii-project-launch
   npm install
   npm run start
   ```
3. Open http://localhost:3000 in a browser.
4. Create a room, share the QR, and let others join from their phones.

## Features
- Lobby with room code + QR sharing
- Real-time play via Socket.IO
- Core role abilities (Mobile Dev, System Architect, QA, Product Owner, IT Support)
- Card types: Progress, Action, Bug (Trap), Solution (Counter)
- Launch reaction window (15s) so others can try to stop the launch
- Simple in‑memory server (sufficient for Open House).

## Room Flow
- Create room -> choose role -> ready -> host starts game
- Each turn choose: **Develop (Draw)** or **Manage (Play one card)**
- Some cards require selecting a target (UI will prompt)
- Traps are set face-down and auto-trigger on conditions
- When you have exactly **10** progress cards, press **Declare Launch!**

## Production Tips
- Use a process manager (pm2) or Docker for deployment (optional).
- For HTTPS, put behind Nginx/Caddy.
- In-memory store is for demo; for persistence, swap with Redis/DB.

## License
MIT — Use freely for your Open House.
