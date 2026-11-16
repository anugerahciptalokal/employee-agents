<p align="center">
  <img src="assets/logo.svg" alt="Employee Agents Logo" width="120" />
</p>

# Employee Agents — Open-Source Backend

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Runtime](https://img.shields.io/badge/Runtime-Node.js%2020%2B%20%7C%20Docker-blue.svg)](https://github.com/anugerahciptalokal/employee-agents)

The official **open-source, self-hosted backend engine** for **Employee Agents**. Run persistent AI teammates, SQLite workspace memory, encrypted credential vault, and headless Chromium automation on your own machine or VPS, and connect seamlessly to the hosted Employee Agents web/mobile clients.

---

## Key Features

- **Single-Owner Self-Hosted Engine**: Full data sovereignty — your SQLite database, agent memory, uploaded files, and LLM API keys stay on your own server (`/app/.data`).
- **Zero-Config Cloud Link**: Register on the hosted Employee Agents web app, choose **Connect Self-Hosted Backend**, and paste the generated `OE-LINK-*` code on your backend's `/` page. Your backend automatically detects its public URL and links securely.
- **Cross-Origin Auth & WebSocket Support**: Built-in `Authorization: Bearer` tokens (short-lived access + rotating refresh tokens), one-time WebSocket tickets (`/api/auth/ws-ticket`), dynamic `CORS_ALLOWED_ORIGINS`, and `/api/meta` capability discovery.
- **Headless Browser & Deliverables**: Built-in headless Chromium remote streaming (`ENABLE_HEADLESS_BROWSER=1`) and presentation deck generation (`pptxgenjs`).
- **100% MIT Licensed**: Open, auditable, and free to self-host.

---

## Architecture

```text
packages/
  contracts/   # Shared TypeScript contracts & helpers (@open-employee/contracts)
  backend/     # Standalone HTTP/WS server, SQLite DB, Vault, Agent Runner, Headless Browser
docker-compose.yml
Dockerfile
.env.example
```

---

## Quick Start (Docker — Recommended)

1. Clone this repository:
   ```bash
   git clone https://github.com/anugerahciptalokal/employee-agents.git
   cd employee-agents
   ```

2. Configure your environment:
   ```bash
   cp .env.example .env
   ```
   Set `CORS_ALLOWED_ORIGINS` to your remote frontend origin and optionally `PUBLIC_URL` if running behind a reverse proxy or Cloudflare Tunnel:
   ```env
   APP_PORT=3060
   PUBLIC_URL=https://your-backend.example.com
   CORS_ALLOWED_ORIGINS=https://your-frontend.example.com
   ```

3. Start the backend container:
   ```bash
   docker compose up -d --build
   ```

4. Open your backend URL in a browser (`https://your-backend.example.com/`), paste the **Link Code** from your Employee Agents registration page, and click **Link to Cloud**.

---

## Quick Start (Node.js)

Requires **Node.js 20+**:

```bash
npm install
npm run build:server
CORS_ALLOWED_ORIGINS=https://your-frontend.example.com npm start
```

---

## Core API Endpoints

- `GET /` — Self-hosted Link Code setup page
- `GET /api/meta` — Backend edition (`oss`), API version, and capabilities
- `POST /api/pairing/claim-control-plane` — Claim a Cloud Link Code using auto-detected `backendUrl`
- `POST /api/auth/setup` / `POST /api/auth/login` / `POST /api/auth/refresh` — Single-owner Bearer authentication
- `POST /api/auth/ws-ticket` — Issue one-time short-lived WebSocket ticket

---

## License

MIT — see [LICENSE](LICENSE).
