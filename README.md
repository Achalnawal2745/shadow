# 🌑 Shadow Assistant

Shadow is a premium, AI-powered Browser & System Assistant that connects a **Chrome Extension sidebar UI** to a powerful **local Python agent** via a WebSocket bridge server. It automates browser actions, reads your Google Workspace (Gmail, Drive, Docs, Sheets, Calendar), executes code, and learns from every interaction using persistent semantic memory.

---

## 📂 Project Structure

```
shadow-assistant/
├── Shadow/                        # Core Python agent (based on OpenManus)
│   ├── app/
│   │   ├── agent/                 # Agent loop, reasoning, tool execution
│   │   │   ├── base.py            # BaseAgent — state machine & step loop
│   │   │   ├── toolcall.py        # ToolCallAgent — LLM tool-calling logic
│   │   │   └── shadow.py          # Shadow agent — MCP integration & memory
│   │   ├── prompt/
│   │   │   └── shadow.py          # System & next-step prompts
│   │   ├── tool/
│   │   │   ├── mcp.py             # MCP client — connects to MCP servers
│   │   │   ├── extension_browser.py  # Browser automation via Chrome extension
│   │   │   └── ...                # Other tools (python_execute, terminate, etc.)
│   │   ├── config.py              # Configuration loader
│   │   ├── llm.py                 # LLM client (OpenAI-compatible)
│   │   ├── memory_manager.py      # Semantic memory (mem0 + HuggingFace)
│   │   └── schema.py              # Data models (Message, AgentState, etc.)
│   ├── config/
│   │   ├── config.toml            # LLM settings (gitignored)
│   │   ├── config.example.toml    # Example LLM config
│   │   ├── mcp.json               # MCP server connections (Google Workspace, etc.)
│   │   └── mcp.example.json       # Example MCP config
│   └── requirements.txt           # Python dependencies (core agent)
│
├── shadow-extension/              # Chrome Extension (Manifest V3)
│   ├── manifest.json              # Extension permissions & config
│   ├── background.js              # Service worker — WebSocket & message routing
│   ├── sidebar.html               # Sidebar chat UI
│   ├── sidebar.css                # Sidebar styles (dark theme, animations)
│   ├── sidebar.js                 # Sidebar logic — chat, settings, stop button
│   └── buildDomTree.js            # DOM tree parser for browser automation
│
├── shadow_server.py               # WebSocket bridge server (entry point)
├── .env                           # Environment variables (gitignored)
├── .gitignore                     # Git ignore rules
└── README.md                      # This file
```

---

## ✨ Key Features

### 🌐 Direct Chrome Browser Control
Drives browser automation through the extension sidebar — no sandboxed Playwright needed. Shadow operates on your **actual browser session**, clicking elements, navigating pages, and scraping content in real time.

### 🔗 Google Workspace Integration (via MCP)
Connects directly to your Google account via the **Model Context Protocol (MCP)** for fast, API-based access to:
- **Gmail** — Search, read, send, draft emails, download attachments
- **Google Drive** — Search files, list folders, download documents
- **Google Docs** — Read and edit documents
- **Google Sheets** — Read cells, get ranges, search data
- **Google Slides** — Read slide content
- **Google Calendar** — View schedule, create/update events, find free time, respond to invites
- **Google Chat** — Send messages, read conversations

### 🧠 Dynamic Semantic Memory
- Built on **mem0** with local **HuggingFace embeddings** (`all-MiniLM-L6-v2`) — no API key needed for memory
- **Self-improving**: Automatically summarizes lessons learned after every task
- **Recall**: Injects relevant past experiences into the prompt context at the start of each new task
- Stored locally in `mem0_db/` — fully private, no data leaves your machine

### 🛑 Emergency Stop
One-click stop button in the sidebar to immediately halt agent execution — cancels active tasks, resolves pending inputs, and resets state.

### 👤 Human-in-the-Loop
Proactively asks for clarifications, confirmations, or credentials using the `ask_human` tool during multi-step execution.

### 🔌 Extensible via MCP
Add new integrations (Slack, Notion, GitHub, etc.) by simply adding entries to `Shadow/config/mcp.json`. The agent auto-discovers and registers all tools from connected MCP servers.

---

## 🛠 Requirements

### System Requirements
- **Python** 3.11 – 3.13
- **Node.js** 18+ (for MCP servers via `npx`)
- **Google Chrome** (for the extension)
- **Git**

### Python Dependencies
Core dependencies (installed via `Shadow/requirements.txt`):
- `openai` — LLM client (OpenAI-compatible endpoints)
- `pydantic` — Data validation & settings
- `browser-use` — Browser automation framework
- `playwright` — Browser driver
- `mcp` — Model Context Protocol client
- `tiktoken` — Token counting
- `loguru` — Logging
- `fastapi` / `uvicorn` — Optional API server

Additional dependencies (installed separately):
- `mem0ai` — Semantic memory framework
- `langchain-community` — LLM integrations
- `sentence-transformers` — Local embedding model
- `websockets` — WebSocket server
- `python-docx` — Read `.docx` files from Google Drive

---

## 🚀 Setup Guide

### 1. Clone & Create Virtual Environment

```bash
git clone <repository-url>
cd shadow-assistant

python -m venv venv

# Windows (PowerShell):
.\venv\Scripts\Activate.ps1

# macOS / Linux:
source venv/bin/activate
```

### 2. Install Python Dependencies

```bash
# Core agent dependencies
pip install -r Shadow/requirements.txt

# Additional packages for memory, WebSocket bridge, and file reading
pip install mem0ai langchain-community sentence-transformers websockets python-docx
```

### 3. Configure LLM

Copy the example config and edit it with your LLM provider details:

```bash
cp Shadow/config/config.example.toml Shadow/config/config.toml
```

Edit `Shadow/config/config.toml`:
```toml
[llm.default]
model = "openai"                              # Model name
base_url = "https://text.pollinations.ai/openai"  # API endpoint
api_key = "your-api-key"                      # Or leave "none" for free endpoints
temperature = 0.0
```

Or use a `.env` file at the project root:
```env
OPENAI_API_KEY=your-key-here
POLLINATIONS_API_KEY=your-pollinations-key
```

### 4. Configure Google Workspace MCP (Optional but Recommended)

#### a. Create Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable these APIs: Gmail, Google Drive, Google Docs, Google Sheets, Google Slides, Google Calendar, Google Chat, People API
4. Navigate to **Credentials** → **Create Credentials** → **OAuth client ID**
5. Application type: **Desktop app**
6. Download the generated `credentials.json`

#### b. Place Credentials

Copy `credentials.json` to both directories:
```
# Windows:
%APPDATA%\google-workspace-mcp\credentials.json
%LOCALAPPDATA%\google-workspace-mcp\credentials.json

# macOS:
~/Library/Application Support/google-workspace-mcp/credentials.json

# Linux:
~/.config/google-workspace-mcp/credentials.json
```

#### c. Configure MCP Server

Edit `Shadow/config/mcp.json`:
```json
{
  "mcpServers": {
    "google-workspace": {
      "type": "stdio",
      "command": "npx.cmd",
      "args": ["-y", "@presto-ai/google-workspace-mcp"]
    }
  }
}
```

> **Note**: On macOS/Linux, use `"command": "npx"` (without `.cmd`).

#### d. First-Time OAuth

On the first run, a browser window will open asking you to sign in with your Google account and authorize the app. The token is saved locally — you won't be asked again.

### 5. Install Chrome Extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `shadow-extension/` folder
5. The Shadow icon appears in your toolbar

---

## 🎮 Usage

### Start the Server

```bash
python shadow_server.py
```

The WebSocket bridge server starts on `ws://localhost:3001`.

### Open the Sidebar

Click the Shadow icon in your Chrome toolbar to open the sidebar panel.

### Example Prompts

| Prompt | What happens |
|--------|-------------|
| *"Search my Gmail for emails about GFS project"* | Uses `gmail.search` → `gmail.get` via MCP |
| *"List all files in the SOW Drive folder"* | Uses `drive.search` to list folder contents |
| *"Read the SOW document and summarize it"* | Uses `docs.getText` or `drive.downloadFile` → Python |
| *"What meetings do I have tomorrow?"* | Uses `calendar.listEvents` via MCP |
| *"Schedule a standup at 10 AM"* | Uses `calendar.createEvent` via MCP |
| *"Draft a reply to Anudeep's email"* | Uses `gmail.createDraft` via MCP |
| *"Scrape this page and extract all links"* | Uses `browser_use` via Chrome extension |
| *"Write a Python script to process CSV data"* | Uses `python_execute` tool |

### Emergency Stop

Click the red **⬜ Stop** button in the sidebar to immediately halt the agent. You can also type `stop`, `cancel`, `exit`, or `quit` in the chat.

---

## ⚙️ Configuration Reference

### LLM Config — `Shadow/config/config.toml`

```toml
[llm.default]
model = "openai"
base_url = "https://text.pollinations.ai/openai"
api_key = "none"
temperature = 0.0
max_tokens = 4096
timeout = 45
max_retries = 3
```

### MCP Config — `Shadow/config/mcp.json`

```json
{
  "mcpServers": {
    "google-workspace": {
      "type": "stdio",
      "command": "npx.cmd",
      "args": ["-y", "@presto-ai/google-workspace-mcp"]
    }
  }
}
```

Add more MCP servers by adding entries:
```json
{
  "mcpServers": {
    "google-workspace": { "..." : "..." },
    "slack": {
      "type": "stdio",
      "command": "npx.cmd",
      "args": ["-y", "@anthropic/slack-mcp"],
      "env": { "SLACK_TOKEN": "xoxb-your-token" }
    }
  }
}
```

### Environment Variables — `.env`

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | API key for OpenAI-compatible endpoints |
| `POLLINATIONS_API_KEY` | API key for Pollinations.ai |
| `POLLINATIONS_MODEL` | Model name for Pollinations (e.g. `deepseek`) |

---

## 🔧 Troubleshooting

| Issue | Solution |
|-------|----------|
| `WinError 2` when starting MCP server | Use `"command": "npx.cmd"` (not `"npx"`) on Windows |
| `ModuleNotFoundError: No module named 'docx'` | Run `pip install python-docx` |
| Google Drive CSP errors in browser | Shadow now uses MCP tools instead of browser for Google Workspace |
| Rate limit (429) from Pollinations | Wait a few seconds and retry, or use a paid API key |
| `docs.getText` fails on `.docx` files | `.docx` files need `drive.downloadFile` → then read with Python |
| Extension not connecting | Ensure `shadow_server.py` is running on port 3001 |
| OAuth window doesn't appear | Delete token files in `%APPDATA%\google-workspace-mcp\` and restart |

---

## 🏗 Architecture

```
┌──────────────────┐    WebSocket     ┌──────────────────┐
│  Chrome          │◄───────────────►│  shadow_server.py │
│  Extension       │  localhost:3001  │  (Bridge Server)  │
│  (Sidebar UI)    │                  └────────┬─────────┘
└──────────────────┘                           │
                                               ▼
                                      ┌──────────────────┐
                                      │  Shadow Agent     │
                                      │  (AI Brain)       │
                                      └────────┬─────────┘
                                               │
                    ┌─────────────┬────────────┼────────────┬─────────────┐
                    ▼             ▼            ▼            ▼             ▼
             ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
             │browser_use│ │Google    │ │python    │ │ask_human │ │terminate │
             │(Chrome)   │ │Workspace │ │_execute  │ │(Sidebar) │ │(End task)│
             └───────────┘ │MCP Server│ └──────────┘ └──────────┘ └──────────┘
                           │├─gmail   │
                           │├─drive   │
                           │├─docs    │
                           │├─sheets  │
                           │├─calendar│
                           │└─chat    │
                           └────┬─────┘
                                ▼
                        ┌──────────────┐
                        │  Google APIs  │
                        └──────────────┘
```

---

## 📄 License

This project is for internal use. All rights reserved.
