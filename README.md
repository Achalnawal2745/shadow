# 👥 Shadow Assistant

Shadow is a premium, highly collaborative, and intelligent AI Browser & System Assistant. It connects a **Chrome Extension UI** to a powerful **local Python Agent** via a WebSocket bridge server, allowing the agent to automate browser actions, execute commands, solve tasks, and learn dynamically from its experiences.

---

## 📂 Repository Structure

* **`Shadow/`**: The core Python agent workspace (built on top of the OpenManus architecture), containing tools, prompts, configurations, and the agent loop.
* **`shadow-extension/`**: The Chrome Extension files implementing the sidebar chat interface, DOM parsing, and action execution.
* **`shadow_server.py`**: The main entry point server. It spins up a WebSocket bridge on `ws://localhost:3001` to coordinate messages between the Chrome extension and the Shadow agent.

---

## ✨ Key Features

1. **Direct Chrome Control**: Drives browser automation directly through the extension sidebar context rather than spawning isolated sandboxed browsers, letting you collaborate on your active browser session.
2. **Dynamic Semantic Memory**:
   - Integrated with `mem0` and local HuggingFace embeddings (`all-MiniLM-L6-v2`) to store long-term memories in a local database (`mem0_db/`).
   - **No OpenAI key required** for memory. All embeddings are processed entirely offline for maximum privacy and performance.
   - **Self-Improving**: Automatically analyzes task execution logs (including user feedback) on completion to summarize lessons learned and preferences.
   - **Recall**: Instantly searches and injects relevant past experiences into the prompt context at the start of a new task.
3. **Human-in-the-Loop**: Proactively asks for clarifications, confirmations, or credentials during multi-step execution using the `ask_human` tool.

---

## 🚀 Setup Guide

### 1. Python Backend Setup

1. **Clone the Repository & Navigate to Workspace**:
   ```bash
   cd "E:/auto/antig assistant"
   ```

2. **Initialize and Activate Virtual Environment**:
   ```bash
   python -m venv venv
   # On Windows (PowerShell):
   .\venv\Scripts\Activate.ps1
   # On Unix/macOS:
   source venv/bin/activate
   ```

3. **Install Dependencies**:
   ```bash
   pip install -r Shadow/requirements.txt
   pip install mem0ai langchain-community sentence-transformers websockets
   ```

4. **Configure your LLM**:
   - Copy the example config file:
     ```bash
     cp Shadow/config/config.example.toml Shadow/config/config.toml
     ```
   - Edit `Shadow/config/config.toml` or create a `.env` file at the root to specify your API keys (e.g. OpenAI or Pollinations AI key).

---

### 2. Chrome Extension Setup

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Turn on **Developer mode** using the toggle switch in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the `shadow-extension` folder from this project directory.
5. The Shadow icon will now appear in your browser toolbar.

---

## 🎮 Running Shadow

1. **Start the backend server**:
   ```bash
   python shadow_server.py
   ```
   *The server starts listening on `ws://localhost:3001`.*

2. **Open the Extension**:
   - Click the Shadow icon in your toolbar to open the sidebar.
   - Enter your prompt or ask the agent to perform a task (e.g., *"Write a Python script to scrape this page"* or *"Help me research... "*).
   - Watch the agent think, explain its actions, execute steps, and learn from its completion!
