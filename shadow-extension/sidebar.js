const chatMessages = document.getElementById('chat-messages');
const promptInput = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const statusPill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');

// Navigation toggles
const toggleSettingsBtn = document.getElementById('toggle-settings-btn');
const backChatBtn = document.getElementById('back-chat-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const chatPanel = document.getElementById('chat-panel');
const settingsPanel = document.getElementById('settings-panel');
const settingsToast = document.getElementById('settings-toast');

// Settings Input elements
const settingBaseUrl = document.getElementById('setting-base-url');
const settingApiKey = document.getElementById('setting-api-key');
const settingModel = document.getElementById('setting-model');
const settingTemp = document.getElementById('setting-temp');

// Load configurations on initialization
function loadConfigurations() {
    chrome.storage.local.get(['baseUrl', 'apiKey', 'model', 'temperature'], (res) => {
        settingBaseUrl.value = res.baseUrl || 'https://gen.pollinations.ai/v1';
        settingApiKey.value = res.apiKey || '';
        settingModel.value = res.model || 'deepseek';
        settingTemp.value = res.temperature !== undefined ? res.temperature : '0.0';
    });
}

// Save configurations
function saveConfigurations() {
    const baseUrl = settingBaseUrl.value.trim();
    const apiKey = settingApiKey.value.trim();
    const model = settingModel.value.trim();
    const temp = parseFloat(settingTemp.value) || 0.0;

    chrome.storage.local.set({
        baseUrl: baseUrl,
        apiKey: apiKey,
        model: model,
        temperature: temp
    }, () => {
        // Show Toast
        settingsToast.classList.add('show');
        setTimeout(() => {
            settingsToast.classList.remove('show');
        }, 2000);
    });
}

// Switch panels
toggleSettingsBtn.addEventListener('click', () => {
    chatPanel.classList.remove('active');
    settingsPanel.classList.add('active');
});

backChatBtn.addEventListener('click', () => {
    settingsPanel.classList.remove('active');
    chatPanel.classList.add('active');
});

saveSettingsBtn.addEventListener('click', () => {
    saveConfigurations();
    setTimeout(() => {
        settingsPanel.classList.remove('active');
        chatPanel.classList.add('active');
    }, 800);
});

// Load config at startup
loadConfigurations();

// Handle typing textarea expansion
promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`;
});

// Send message with active settings
function sendMessage() {
    const text = promptInput.value.trim();
    if (!text) return;

    // Append user query to sidebar Chat
    appendMessage(text, 'user');

    // Fetch latest configurations to forward to the Python server
    chrome.storage.local.get(['baseUrl', 'apiKey', 'model', 'temperature'], (config) => {
        // Fallback default configurations
        const activeConfig = {
            baseUrl: config.baseUrl || 'https://gen.pollinations.ai/v1',
            apiKey: config.apiKey || '',
            model: config.model || 'deepseek',
            temperature: config.temperature !== undefined ? config.temperature : 0.0
        };

        // Send payload containing message and settings to service worker
        chrome.runtime.sendMessage({
            type: 'PROMPT',
            data: {
                message: text,
                config: activeConfig,
                timestamp: Date.now()
            }
        });
    });

    // Clear prompt input
    promptInput.value = '';
    promptInput.style.height = '38px';
}

sendBtn.addEventListener('click', sendMessage);
promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

let activeStreamBubble = null;

// Append messages to panel
function appendMessage(text, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message');
    if (sender === 'user') {
        msgDiv.classList.add('user-msg');
    } else if (sender === 'status') {
        msgDiv.classList.add('status-msg');
    } else {
        msgDiv.classList.add('agent-msg');
    }
    
    msgDiv.innerText = text;
    
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return msgDiv;
}

// Receive messages from background script
chrome.runtime.onMessage.addListener((message) => {
    console.log("Sidebar received message:", message);
    
    if (message.type === 'STATUS') {
        const connected = message.status === 'connected';
        if (connected) {
            statusPill.className = 'status-pill connected';
            statusText.innerText = 'ONLINE';
        } else {
            statusPill.className = 'status-pill disconnected';
            statusText.innerText = 'OFFLINE';
        }
    } else if (message.type === 'STREAM') {
        const text = message.data.text;
        if (!activeStreamBubble) {
            activeStreamBubble = appendMessage("", 'agent');
        }
        activeStreamBubble.innerText += text;
        chatMessages.scrollTop = chatMessages.scrollHeight;
    } else if (message.type === 'STATUS_UPDATE') {
        const statusMsg = message.data.message;
        appendMessage(`⚙️ ${statusMsg}`, 'status');
        activeStreamBubble = null; // Reset stream bubble on status switch
    } else if (message.type === 'REPLY') {
        const reply = message.data.reply;
        if (activeStreamBubble) {
            activeStreamBubble.innerText = reply;
            activeStreamBubble = null;
        } else {
            appendMessage(reply, 'agent');
        }
    }
});

// Request current status when sidebar opens
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (response && response.status) {
        const connected = response.status === 'connected';
        statusPill.className = connected ? 'status-pill connected' : 'status-pill disconnected';
        statusText.innerText = connected ? 'ONLINE' : 'OFFLINE';
    }
});

// Keep background service worker alive with heartbeat
const bgPort = chrome.runtime.connect({ name: "antigravity-sidebar" });
setInterval(() => {
    try {
        bgPort.postMessage({ type: "HEARTBEAT" });
    } catch (e) {
        // Ignore closed port
    }
}, 8000);
