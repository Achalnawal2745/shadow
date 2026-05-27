let socket = null;
let reconnectInterval = 3000;
let isConnected = false;

// Cache for index-based browser element selection
let latestSelectorMap = new Map();

// Helper to check and inject buildDomTree.js
async function ensureBuildDomTreeInjected(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => typeof window.buildDomTree === 'function'
        });
        
        const frameIdsToInject = [];
        for (const res of results) {
            if (!res.result) {
                frameIdsToInject.push(res.frameId);
            }
        }
        
        if (frameIdsToInject.length > 0) {
            console.log("Injecting buildDomTree.js in frames:", frameIdsToInject);
            await chrome.scripting.executeScript({
                target: { tabId, frameIds: frameIdsToInject },
                files: ['buildDomTree.js']
            });
        }
    } catch (e) {
        console.error("Error checking or injecting buildDomTree.js:", e);
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['buildDomTree.js']
            });
        } catch (err) {
            console.error("Fallback injection failed:", err);
        }
    }
}

// Parse raw DOM tree mapping returned by buildDomTree.js
function parseDomTree(evalPage) {
    const jsNodeMap = evalPage.map;
    const jsRootId = evalPage.rootId;
    
    const selectorMap = new Map();
    const nodeMap = {};
    
    for (const [id, nodeData] of Object.entries(jsNodeMap)) {
        if (!nodeData) continue;
        
        let node;
        if (nodeData.type === 'TEXT_NODE') {
            node = {
                type: 'TEXT_NODE',
                text: nodeData.text,
                isVisible: nodeData.isVisible,
                parent: null
            };
        } else {
            node = {
                type: 'ELEMENT_NODE',
                tagName: nodeData.tagName,
                xpath: nodeData.xpath,
                attributes: nodeData.attributes || {},
                children: [],
                isVisible: nodeData.isVisible || false,
                isInteractive: nodeData.isInteractive || false,
                isTopElement: nodeData.isTopElement || false,
                isInViewport: nodeData.isInViewport || false,
                highlightIndex: nodeData.highlightIndex !== undefined && nodeData.highlightIndex !== null ? nodeData.highlightIndex : null,
                shadowRoot: nodeData.shadowRoot || false,
                parent: null
            };
            if (node.highlightIndex !== null && node.highlightIndex !== undefined) {
                selectorMap.set(node.highlightIndex, node);
            }
        }
        nodeMap[id] = node;
    }
    
    for (const [id, node] of Object.entries(nodeMap)) {
        if (node.type === 'ELEMENT_NODE') {
            const nodeData = jsNodeMap[id];
            const childrenIds = nodeData.children || [];
            for (const childId of childrenIds) {
                const childNode = nodeMap[childId];
                if (childNode) {
                    childNode.parent = node;
                    node.children.push(childNode);
                }
            }
        }
    }
    
    const rootNode = nodeMap[jsRootId];
    return { rootNode, selectorMap };
}

function getAllTextTillNextClickableElement(node, maxDepth = -1) {
    const textParts = [];
    
    function collectText(currentNode, currentDepth) {
        if (maxDepth !== -1 && currentDepth > maxDepth) return;
        if (currentNode.type === 'ELEMENT_NODE' && currentNode !== node && currentNode.highlightIndex !== null) return;
        
        if (currentNode.type === 'TEXT_NODE') {
            textParts.push(currentNode.text);
        } else if (currentNode.type === 'ELEMENT_NODE') {
            for (const child of currentNode.children) {
                collectText(child, currentDepth + 1);
            }
        }
    }
    
    collectText(node, 0);
    return textParts.join('\n').trim();
}

function hasParentWithHighlightIndex(node) {
    let current = node.parent;
    while (current != null) {
        if (current.highlightIndex !== null && current.highlightIndex !== undefined) {
            return true;
        }
        current = current.parent;
    }
    return false;
}

function convertSimpleXPathToCssSelector(xpath) {
    if (!xpath) return '';
    const cleanXpath = xpath.replace(/^\//, '');
    const parts = cleanXpath.split('/');
    const cssParts = [];
    
    for (const part of parts) {
        if (!part) continue;
        if (part.includes(':') && !part.includes('[')) {
            cssParts.push(part.replace(/:/g, '\\:'));
            continue;
        }
        if (part.includes('[')) {
            const bracketIndex = part.indexOf('[');
            let basePart = part.substring(0, bracketIndex);
            if (basePart.includes(':')) {
                basePart = basePart.replace(/:/g, '\\:');
            }
            const indexPart = part.substring(bracketIndex);
            const indices = indexPart.split(']').slice(0, -1).map(i => i.replace('[', ''));
            for (const idx of indices) {
                if (/^\d+$/.test(idx)) {
                    const index = parseInt(idx, 10);
                    basePart += `:nth-of-type(${index})`;
                } else if (idx === 'last()') {
                    basePart += ':last-of-type';
                } else if (idx.includes('position()')) {
                    if (idx.includes('>1')) {
                        basePart += ':nth-of-type(n+2)';
                    }
                }
            }
            cssParts.push(basePart);
        } else {
            cssParts.push(part);
        }
    }
    return cssParts.join(' > ');
}

function getEnhancedCssSelector(node) {
    try {
        if (!node.xpath) return '';
        let cssSelector = convertSimpleXPathToCssSelector(node.xpath);
        const classValue = node.attributes.class;
        if (classValue) {
            const validClassNamePattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
            const classes = classValue.trim().split(/\s+/);
            for (const className of classes) {
                if (className.trim() && validClassNamePattern.test(className)) {
                    cssSelector += `.${className}`;
                }
            }
        }
        const SAFE_ATTRIBUTES = new Set([
            'id', 'name', 'type', 'placeholder', 'aria-label', 'aria-labelledby',
            'aria-describedby', 'role', 'for', 'autocomplete', 'required',
            'readonly', 'alt', 'title', 'src', 'href', 'target',
            'data-id', 'data-qa', 'data-cy', 'data-testid'
        ]);
        
        for (const [attribute, value] of Object.entries(node.attributes)) {
            if (attribute === 'class' || !attribute.trim() || !SAFE_ATTRIBUTES.has(attribute)) continue;
            const safeAttribute = attribute.replace(':', '\\:');
            if (value === '') {
                cssSelector += `[${safeAttribute}]`;
            } else if (/["'<>`\n\r\t]/.test(value)) {
                const collapsedValue = value.replace(/\s+/g, ' ').trim();
                const safeValue = collapsedValue.replace(/"/g, '\\"');
                cssSelector += `[${safeAttribute}*="${safeValue}"]`;
            } else {
                cssSelector += `[${safeAttribute}="${value}"]`;
            }
        }
        return cssSelector;
    } catch (e) {
        return `*[highlightIndex='${node.highlightIndex}']`;
    }
}

function clickableElementsToString(rootNode) {
    const formattedText = [];
    const includeAttributes = [
      'title',
      'type',
      'checked',
      'name',
      'role',
      'value',
      'placeholder',
      'data-date-format',
      'data-state',
      'alt',
      'aria-checked',
      'aria-label',
      'aria-expanded',
      'href',
    ];
    
    function processNode(node, depth) {
        let nextDepth = depth;
        const depthStr = '\t'.repeat(depth);
        
        if (node.type === 'ELEMENT_NODE') {
            if (node.highlightIndex !== null && node.highlightIndex !== undefined) {
                nextDepth += 1;
                const text = getAllTextTillNextClickableElement(node);
                let attributesHtmlStr = null;
                
                const attributesToInclude = {};
                for (const [key, value] of Object.entries(node.attributes)) {
                    if (includeAttributes.includes(key) && String(value).trim() !== '') {
                        attributesToInclude[key] = String(value).trim();
                    }
                }
                
                const orderedKeys = includeAttributes.filter(key => key in attributesToInclude);
                if (orderedKeys.length > 1) {
                    const keysToRemove = new Set();
                    const seenValues = {};
                    for (const key of orderedKeys) {
                        const value = attributesToInclude[key];
                        if (value.length > 5) {
                            if (value in seenValues) {
                                keysToRemove.add(key);
                            } else {
                                seenValues[value] = key;
                            }
                        }
                    }
                    for (const key of keysToRemove) {
                        delete attributesToInclude[key];
                    }
                }
                
                if (node.tagName === attributesToInclude.role) {
                    delete attributesToInclude.role;
                }
                
                const attrsToRemoveIfTextMatches = ['aria-label', 'placeholder', 'title'];
                for (const attr of attrsToRemoveIfTextMatches) {
                    if (attributesToInclude[attr] && attributesToInclude[attr].trim().toLowerCase() === text.trim().toLowerCase()) {
                        delete attributesToInclude[attr];
                    }
                }
                
                if (Object.keys(attributesToInclude).length > 0) {
                    attributesHtmlStr = Object.entries(attributesToInclude)
                        .map(([key, value]) => {
                            const capped = value.length > 15 ? value.substring(0, 15) + '...' : value;
                            return `${key}="${capped}"`;
                        })
                        .join(' ');
                }
                
                let line = `${depthStr}[${node.highlightIndex}]<${node.tagName}`;
                if (attributesHtmlStr) {
                    line += ` ${attributesHtmlStr}`;
                }
                if (text) {
                    if (!attributesHtmlStr) {
                        line += ' ';
                    }
                    line += `>${text}`;
                } else if (!attributesHtmlStr) {
                    line += ' ';
                }
                line += ' />';
                formattedText.push(line);
            }
            
            for (const child of node.children) {
                processNode(child, nextDepth);
            }
        } else if (node.type === 'TEXT_NODE') {
            if (hasParentWithHighlightIndex(node)) {
                return;
            }
            if (node.parent && node.parent.isVisible && node.parent.isTopElement) {
                formattedText.push(`${depthStr}${node.text}`);
            }
        }
    }
    
    processNode(rootNode, 0);
    return formattedText.join('\n');
}


// Open sidepanel when clicking extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

function connectWS() {
    console.log("Connecting to Antigravity WebSocket server...");
    socket = new WebSocket("ws://localhost:3001");

    socket.onopen = () => {
        console.log("Connected to server!");
        isConnected = true;
        broadcastToSidebar({ type: 'STATUS', status: 'connected' });
    };

    socket.onmessage = async (event) => {
        try {
            sendWS({ type: 'LOG', data: 'Received WS message: ' + event.data.substring(0, 150) });
            const message = JSON.parse(event.data);
            console.log("Received message from server:", message);
            
            if (message.type === 'COMMAND') {
                const cmd = message.data;
                sendWS({ type: 'LOG', data: 'Executing action: ' + cmd.action });
                const result = await executeCommand(cmd);
                sendWS({ type: 'LOG', data: 'Action complete, status: ' + result.status });
                sendWS({
                    type: 'RESPONSE',
                    data: result
                });
            } else if (message.type === 'BROWSER_COMMAND') {
                const cmd = message.data;
                sendWS({ type: 'LOG', data: 'Executing BROWSER_COMMAND: ' + cmd.action });
                const result = await executeCommand(cmd);
                sendWS({
                    type: 'BROWSER_RESPONSE',
                    id: message.id,
                    data: result
                });
            } else if (message.type === 'REPLY' || message.type === 'STREAM' || message.type === 'STATUS_UPDATE' || message.type === 'AGENT_STATE') {
                // Relay agent replies, streams, and status updates to sidebar chat
                broadcastToSidebar(message);
            }
        } catch (err) {
            console.error("Error processing message:", err);
            sendWS({ type: 'LOG', data: 'Error in onmessage: ' + err.message + '\nStack: ' + err.stack });
            sendWS({
                type: 'RESPONSE',
                data: { status: "error", error: "onmessage error: " + err.message }
            });
        }
    };

    socket.onclose = () => {
        console.log("Disconnected from server.");
        isConnected = false;
        broadcastToSidebar({ type: 'STATUS', status: 'disconnected' });
        setTimeout(connectWS, reconnectInterval);
    };

    socket.onerror = (err) => {
        console.error("WS error:", err);
    };
}

function sendWS(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

// Relay events to sidebar
function broadcastToSidebar(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {
        // Sidebar might not be open, ignore error
    });
}

// Receive prompts and stop requests from sidebar and send to server
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PROMPT' || message.type === 'STOP') {
        sendWS(message);
    } else if (message.type === 'GET_STATUS') {
        sendResponse({ status: isConnected ? 'connected' : 'disconnected' });
    }
    return true;
});

// Execute Chrome Automation Commands
async function executeCommand(cmd) {
    const { action, url, selector, text, code, index, direction } = cmd;
    
    try {
        // 1. Get active tab
        let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!activeTab) {
            const [fallbackTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            activeTab = fallbackTab;
        }

        if (!activeTab && action !== 'navigate') {
            return { status: "error", error: "No active tab found" };
        }

        const tabId = activeTab ? activeTab.id : null;

        if (action === 'navigate') {
            if (!url) return { status: "error", error: "No URL specified for navigate action" };
            
            return new Promise((resolve) => {
                const targetTabId = tabId;
                const updateProps = { url: url };
                
                try {
                    const callback = (tab) => {
                        try {
                            if (chrome.runtime.lastError || !tab) {
                                chrome.tabs.create(updateProps, (newTab) => {
                                    try {
                                        setupLoadListener(newTab.id, resolve);
                                    } catch (e) {
                                        resolve({ status: "error", error: "create callback error: " + e.message });
                                    }
                                });
                                return;
                            }
                            setupLoadListener(tab.id, resolve);
                        } catch (e) {
                            resolve({ status: "error", error: "update callback error: " + e.message });
                        }
                    };

                    function setupLoadListener(id, resolveFn) {
                        try {
                            const listener = (updatedTabId, changeInfo) => {
                                try {
                                    if (updatedTabId === id && changeInfo.status === 'complete') {
                                        chrome.tabs.onUpdated.removeListener(listener);
                                        chrome.tabs.get(id, (t) => {
                                            try {
                                                if (chrome.runtime.lastError || !t) {
                                                    resolveFn({ status: "success", url: url, note: "loaded, title unavailable" });
                                                } else {
                                                    resolveFn({ status: "success", url: url, title: t.title });
                                                }
                                            } catch (e) {
                                                resolveFn({ status: "success", url: url, note: "loaded, metadata fetch failed: " + e.message });
                                            }
                                        });
                                    }
                                } catch (e) {
                                    chrome.tabs.onUpdated.removeListener(listener);
                                    resolveFn({ status: "error", error: "listener callback error: " + e.message });
                                }
                            };
                            chrome.tabs.onUpdated.addListener(listener);
                            
                            // Fallback timeout in case page hangs
                            setTimeout(() => {
                                try {
                                    chrome.tabs.onUpdated.removeListener(listener);
                                    resolveFn({ status: "success", note: "navigation completed, wait timeout reached", url: url });
                                } catch (e) {
                                    resolveFn({ status: "error", error: "timeout handler error: " + e.message });
                                }
                            }, 8000);
                        } catch (e) {
                            resolveFn({ status: "error", error: "setupLoadListener error: " + e.message });
                        }
                    }

                    if (targetTabId) {
                        chrome.tabs.update(targetTabId, updateProps, callback);
                    } else {
                        chrome.tabs.create(updateProps, (newTab) => {
                            try {
                                setupLoadListener(newTab.id, resolve);
                            } catch (e) {
                                resolve({ status: "error", error: "direct create error: " + e.message });
                            }
                        });
                    }
                } catch (e) {
                    resolve({ status: "error", error: "navigate promise body error: " + e.message });
                }
            });
        }

        if (action === 'click') {
            let xpathVal = null;
            let selectorVal = selector;
            let tagNameVal = null;
            let attributesVal = null;
            
            if (index !== undefined && index !== null) {
                const elementInfo = latestSelectorMap.get(parseInt(index, 10));
                if (!elementInfo) {
                    return { status: "error", error: `Element with index ${index} not found in cache. Please run 'scrape' first to build the DOM tree.` };
                }
                xpathVal = elementInfo.xpath;
                selectorVal = elementInfo.selector;
                tagNameVal = elementInfo.tagName;
                attributesVal = elementInfo.attributes;
            }
            
            if (!xpathVal && !selectorVal) {
                return { status: "error", error: "No target element specified (index or selector is required)" };
            }
            
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                func: (xpath, sel, tagName, attributes) => {
                    function locate() {
                        if (xpath) {
                            try {
                                const res = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                                if (res.singleNodeValue) return res.singleNodeValue;
                            } catch (e) {}
                        }
                        if (sel) {
                            try {
                                const el = document.querySelector(sel);
                                if (el) return el;
                            } catch (e) {}
                        }
                        if (attributes && attributes.id) {
                            const el = document.getElementById(attributes.id);
                            if (el) return el;
                        }
                        if (tagName) {
                            const els = document.getElementsByTagName(tagName);
                            for (const el of els) {
                                if (attributes.placeholder && el.placeholder === attributes.placeholder) return el;
                                if (attributes.title && el.title === attributes.title) return el;
                                if (attributes.name && el.name === attributes.name) return el;
                            }
                        }
                        return null;
                    }
                    
                    const el = locate();
                    if (!el) return null;
                    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                    el.click();
                    return { success: true };
                },
                args: [xpathVal, selectorVal, tagNameVal, attributesVal]
            });
            
            const successResult = results.find(r => r.result && r.result.success);
            if (!successResult) {
                return { status: "error", error: `Element not found or not clickable (index: ${index}, selector: ${selectorVal})` };
            }
            return { status: "success", result: successResult.result };
        }

        if (action === 'type') {
            if (text === undefined) return { status: "error", error: "No text specified for type action" };
            
            let xpathVal = null;
            let selectorVal = selector;
            let tagNameVal = null;
            let attributesVal = null;
            
            if (index !== undefined && index !== null) {
                const elementInfo = latestSelectorMap.get(parseInt(index, 10));
                if (!elementInfo) {
                    return { status: "error", error: `Element with index ${index} not found in cache. Please run 'scrape' first.` };
                }
                xpathVal = elementInfo.xpath;
                selectorVal = elementInfo.selector;
                tagNameVal = elementInfo.tagName;
                attributesVal = elementInfo.attributes;
            }
            
            if (!xpathVal && !selectorVal) {
                return { status: "error", error: "No target element specified (index or selector is required)" };
            }
            
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                func: (xpath, sel, tagName, attributes, val) => {
                    function locate() {
                        if (xpath) {
                            try {
                                const res = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                                if (res.singleNodeValue) return res.singleNodeValue;
                            } catch (e) {}
                        }
                        if (sel) {
                            try {
                                const el = document.querySelector(sel);
                                if (el) return el;
                            } catch (e) {}
                        }
                        if (attributes && attributes.id) {
                            const el = document.getElementById(attributes.id);
                            if (el) return el;
                        }
                        if (tagName) {
                            const els = document.getElementsByTagName(tagName);
                            for (const el of els) {
                                if (attributes.placeholder && el.placeholder === attributes.placeholder) return el;
                                if (attributes.title && el.title === attributes.title) return el;
                                if (attributes.name && el.name === attributes.name) return el;
                            }
                        }
                        return null;
                    }
                    
                    const el = locate();
                    if (!el) return null;
                    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                    
                    function getDeepActiveElement() {
                        let active = document.activeElement;
                        while (active && active.shadowRoot && active.shadowRoot.activeElement) {
                            active = active.shadowRoot.activeElement;
                        }
                        while (active && active.tagName === 'IFRAME') {
                            try {
                                if (active.contentDocument && active.contentDocument.activeElement) {
                                    active = active.contentDocument.activeElement;
                                } else {
                                    break;
                                }
                            } catch (e) {
                                break;
                            }
                        }
                        return active;
                    }
                    
                    const activeEl = getDeepActiveElement();
                    let targetEl = el;
                    if (activeEl) {
                        let temp = activeEl;
                        let isInside = false;
                        while (temp) {
                            if (temp === el) {
                                isInside = true;
                                break;
                            }
                            if (temp.parentNode) {
                                temp = temp.parentNode;
                            } else if (temp.defaultView && temp.defaultView.frameElement) {
                                temp = temp.defaultView.frameElement;
                            } else {
                                temp = null;
                            }
                        }
                        if (isInside) {
                            targetEl = activeEl;
                        }
                    }
                    
                    if (targetEl !== activeEl) {
                        targetEl.focus();
                    }
                    
                    const isInputOrTextarea = targetEl.tagName === 'INPUT' || targetEl.tagName === 'TEXTAREA';
                    const isContentEditable = targetEl.isContentEditable || targetEl.getAttribute('contenteditable') === 'true';
                    
                    if (isInputOrTextarea) {
                        targetEl.value = val;
                        targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                        targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (isContentEditable) {
                        let execSuccess = false;
                        try {
                            execSuccess = document.execCommand('insertText', false, val);
                        } catch (e) {}
                        
                        if (!execSuccess) {
                            targetEl.innerText = val;
                            targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                            targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    } else {
                        // Canvas or other rich text capture targets (like Google Docs target)
                        for (let i = 0; i < val.length; i++) {
                            const char = val[i];
                            const keyCode = char.charCodeAt(0);
                            
                            const keydown = new KeyboardEvent('keydown', {
                                key: char,
                                code: char === ' ' ? 'Space' : `Key${char.toUpperCase()}`,
                                keyCode: keyCode,
                                which: keyCode,
                                bubbles: true,
                                cancelable: true
                            });
                            targetEl.dispatchEvent(keydown);
                            
                            let inputEventAllowed = true;
                            try {
                                const beforeinput = new InputEvent('beforeinput', {
                                    data: char,
                                    inputType: 'insertText',
                                    bubbles: true,
                                    cancelable: true
                                });
                                inputEventAllowed = targetEl.dispatchEvent(beforeinput);
                            } catch (e) {}
                            
                            if (inputEventAllowed) {
                                try {
                                    const textEvent = document.createEvent('TextEvent');
                                    textEvent.initTextEvent('textInput', true, true, window, char, 9, 'en-US');
                                    targetEl.dispatchEvent(textEvent);
                                } catch (e) {}
                            }
                            
                            const keypress = new KeyboardEvent('keypress', {
                                key: char,
                                keyCode: keyCode,
                                which: keyCode,
                                bubbles: true,
                                cancelable: true
                            });
                            targetEl.dispatchEvent(keypress);
                            
                            const keyup = new KeyboardEvent('keyup', {
                                key: char,
                                code: char === ' ' ? 'Space' : `Key${char.toUpperCase()}`,
                                keyCode: keyCode,
                                which: keyCode,
                                bubbles: true,
                                cancelable: true
                            });
                            targetEl.dispatchEvent(keyup);
                        }
                    }
                    return { success: true };
                },
                args: [xpathVal, selectorVal, tagNameVal, attributesVal, text]
            });
            
            const successResult = results.find(r => r.result && r.result.success);
            if (!successResult) {
                return { status: "error", error: `Element not found or not editable (index: ${index}, selector: ${selectorVal})` };
            }
            return { status: "success", result: successResult.result };
        }

        if (action === 'scrape') {
            await ensureBuildDomTreeInjected(tabId);
            
            const mainFrameResult = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    try {
                        return window.buildDomTree({
                            showHighlightElements: true,
                            focusHighlightIndex: -1,
                            viewportExpansion: 0,
                            startId: 0,
                            startHighlightIndex: 0,
                            debugMode: false
                        });
                    } catch (e) {
                        return { error: e.toString() };
                    }
                }
            });
            
            let evalResult = mainFrameResult[0]?.result;
            if (!evalResult || evalResult.error) {
                return { status: "error", error: "Failed to build DOM tree: " + (evalResult?.error || "No result") };
            }
            
            const parsed = parseDomTree(evalResult);
            latestSelectorMap.clear();
            for (const [idx, node] of parsed.selectorMap.entries()) {
                latestSelectorMap.set(idx, {
                    xpath: node.xpath,
                    selector: getEnhancedCssSelector(node),
                    tagName: node.tagName,
                    attributes: node.attributes
                });
            }
            
            const markdown = clickableElementsToString(parsed.rootNode);
            const title = activeTab.title || "Unknown Page";
            const url = activeTab.url || "";
            
            return { 
                status: "success", 
                result: {
                    title: title,
                    url: url,
                    innerText: markdown
                } 
            };
        }

        if (action === 'scroll') {
            let xpathVal = null;
            let selectorVal = null;
            
            if (index !== undefined && index !== null) {
                const elementInfo = latestSelectorMap.get(parseInt(index, 10));
                if (elementInfo) {
                    xpathVal = elementInfo.xpath;
                    selectorVal = elementInfo.selector;
                }
            }
            
            const dir = direction || "down";
            
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                func: (xpath, sel, d) => {
                    function locate() {
                        if (xpath) {
                            try {
                                const res = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                                if (res.singleNodeValue) return res.singleNodeValue;
                            } catch (e) {}
                        }
                        if (sel) {
                            try {
                                const el = document.querySelector(sel);
                                if (el) return el;
                            } catch (e) {}
                        }
                        return null;
                    }
                    
                    const target = (xpath || sel) ? locate() : document.documentElement;
                    if (!target) return null;
                    
                    const isWindow = target === document.documentElement;
                    const scrollContainer = isWindow ? window : target;
                    
                    let amount = 0;
                    if (d === 'down') {
                        amount = isWindow ? window.innerHeight * 0.8 : target.clientHeight * 0.8;
                    } else if (d === 'up') {
                        amount = -(isWindow ? window.innerHeight * 0.8 : target.clientHeight * 0.8);
                    }
                    
                    if (d === 'top') {
                        scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
                    } else if (d === 'bottom') {
                        const maxScroll = isWindow ? document.documentElement.scrollHeight : target.scrollHeight;
                        scrollContainer.scrollTo({ top: maxScroll, behavior: 'smooth' });
                    } else {
                        if (isWindow) {
                            window.scrollBy({ top: amount, left: 0, behavior: 'smooth' });
                        } else {
                            target.scrollBy({ top: amount, left: 0, behavior: 'smooth' });
                        }
                    }
                    return { success: true };
                },
                args: [xpathVal, selectorVal, dir]
            });
            
            const successResult = results.find(r => r.result && r.result.success);
            if (!successResult) {
                return { status: "error", error: `Failed to scroll target.` };
            }
            return { status: "success", result: successResult.result };
        }

        if (action === 'eval') {
            if (!code) return { status: "error", error: "No code specified for eval action" };
            
            const [result] = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: (codeStr) => {
                    try {
                        const val = eval(codeStr);
                        return { value: val };
                    } catch (e) {
                        return { error: e.toString() };
                    }
                },
                args: [code]
            });

            if (result.result.error) {
                return { status: "error", error: result.result.error };
            }
            return { status: "success", result: result.result.value };
        }

        return { status: "error", error: `Unknown action type: ${action}` };

    } catch (e) {
        return { status: "error", error: e.message || e.toString() };
    }
}

// Start connection on load
connectWS();

// Persistent port connection listener to keep background service worker alive
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "antigravity-sidebar") {
        console.log("Sidebar port connected.");
        port.onMessage.addListener((msg) => {
            if (msg.type === "HEARTBEAT") {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'LOG', data: 'Heartbeat ping from active sidebar' }));
                }
            }
        });
        port.onDisconnect.addListener(() => {
            console.log("Sidebar port disconnected.");
        });
    }
});
