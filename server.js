#!/usr/bin/env node
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CacheManager } from './utils/cache-manager.js';
import { fetchQuota } from './utils/quota-fetcher.js';
import { findAntigravityProcess } from './utils/process-finder.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9000, 9001, 9002, 9003];
const DISCOVERY_INTERVAL = 10000;
const POLL_INTERVAL = 3000;

// Auto-Accept & Dashboard state
let autoAcceptEnabled = false;
let autoAcceptScriptContent = null;
try {
    const autoAcceptScriptPath = join(__dirname, 'scripts', 'auto-accept.js');
    autoAcceptScriptContent = fs.readFileSync(autoAcceptScriptPath, 'utf8');
} catch (e) {
    console.error(`Failed to load auto-accept.js: ${e.message}`);
}
const cacheManager = new CacheManager();

// Application State
let cascades = new Map(); // Map<cascadeId, { id, cdp: { ws, contexts, rootContextId }, metadata, snapshot, snapshotHash }>
let wss = null;

// --- Helpers ---

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve([]); } // return empty on parse error
            });
        });
        req.on('error', () => resolve([])); // return empty on network error
        req.setTimeout(2000, () => {
            req.destroy();
            resolve([]);
        });
    });
}

// --- CDP Logic ---

async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg);
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
                if (idx !== -1) contexts.splice(idx, 1);
            }
        } catch (e) { }
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 500)); // give time for contexts to load

    return { ws, call, contexts, rootContextId: null };
}

async function extractMetadata(cdp) {
    const SCRIPT = `(() => {
        const cascade = document.getElementById('cascade');
        if (!cascade) return { found: false };
        
        let chatTitle = null;
        const possibleTitleSelectors = ['h1', 'h2', 'header', '[class*="title"]'];
        for (const sel of possibleTitleSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.length > 2 && el.textContent.length < 50) {
                chatTitle = el.textContent.trim();
                break;
            }
        }
        
        return {
            found: true,
            chatTitle: chatTitle || 'Agent',
            isActive: document.hasFocus()
        };
    })()`;

    // Try finding context first if not known
    if (cdp.rootContextId) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SCRIPT, returnByValue: true, contextId: cdp.rootContextId });
            if (res.result?.value?.found) return { ...res.result.value, contextId: cdp.rootContextId };
        } catch (e) { cdp.rootContextId = null; } // reset if stale
    }

    // Search all contexts
    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", { expression: SCRIPT, returnByValue: true, contextId: ctx.id });
            if (result.result?.value?.found) {
                return { ...result.result.value, contextId: ctx.id };
            }
        } catch (e) { }
    }
    return null;
}

async function captureCSS(cdp) {
    const SCRIPT = `(() => {
        // Gather CSS and namespace it basic way to prevent leaks
        let css = '';
        for (const sheet of document.styleSheets) {
            try { 
                for (const rule of sheet.cssRules) {
                    let text = rule.cssText;
                    // Naive scoping: replace body/html with #cascade locator
                    // This prevents the monitored app's global backgrounds from overriding our monitor's body
                    text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1#cascade');
                    text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1#cascade');
                    css += text + '\\n'; 
                }
            } catch (e) { }
        }
        return { css };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        return result.result?.value?.css || '';
    } catch (e) { return ''; }
}

async function captureHTML(cdp) {
    const SCRIPT = `(() => {
        const cascade = document.getElementById('cascade');
        if (!cascade) return { error: 'cascade not found' };
        
        const clone = cascade.cloneNode(true);
        // Remove input box to keep snapshot clean
        const input = clone.querySelector('[contenteditable="true"]')?.closest('div[id^="cascade"] > div');
        if (input) input.remove();
        
        const bodyStyles = window.getComputedStyle(document.body);

        return {
            html: clone.outerHTML,
            bodyBg: bodyStyles.backgroundColor,
            bodyColor: bodyStyles.color
        };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        if (result.result?.value && !result.result.value.error) {
            return result.result.value;
        }
    } catch (e) { }
    return null;
}

// --- Main App Logic ---

async function discover() {
    // 1. Find all targets
    const allTargets = [];
    await Promise.all(PORTS.map(async (port) => {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        const workbenches = list.filter(t => t.url?.includes('workbench.html') || t.title?.includes('workbench'));
        workbenches.forEach(t => allTargets.push({ ...t, port }));
    }));

    const newCascades = new Map();

    // 2. Connect/Refresh
    for (const target of allTargets) {
        const id = hashString(target.webSocketDebuggerUrl);

        // Reuse existing
        if (cascades.has(id)) {
            const existing = cascades.get(id);
            if (existing.cdp.ws.readyState === WebSocket.OPEN) {
                // Refresh metadata
                const meta = await extractMetadata(existing.cdp);
                if (meta) {
                    existing.metadata = { ...existing.metadata, ...meta };
                    if (meta.contextId) existing.cdp.rootContextId = meta.contextId; // Update optimization
                    newCascades.set(id, existing);
                    continue;
                }
            }
        }

        // New connection
        try {
            console.log(`🔌 Connecting to ${target.title}`);
            const cdp = await connectCDP(target.webSocketDebuggerUrl);
            const meta = await extractMetadata(cdp);

            if (meta) {
                if (meta.contextId) cdp.rootContextId = meta.contextId;
                const cascade = {
                    id,
                    cdp,
                    metadata: {
                        windowTitle: target.title,
                        chatTitle: meta.chatTitle,
                        isActive: meta.isActive
                    },
                    snapshot: null,
                    css: await captureCSS(cdp), //only on init bc its huge
                    snapshotHash: null
                };
                newCascades.set(id, cascade);

                // Inject auto-accept script
                if (autoAcceptScriptContent) {
                    try {
                        await cdp.call("Runtime.evaluate", {
                            expression: autoAcceptScriptContent,
                            contextId: cdp.rootContextId
                        });
                        if (autoAcceptEnabled) {
                            await cdp.call("Runtime.evaluate", {
                                expression: "window.__autoAcceptStart({ ide: 'antigravity' })",
                                contextId: cdp.rootContextId
                            });
                        }
                    } catch (e) {
                         console.error('Failed to inject auto-accept logic', e);
                    }
                }

                console.log(`✨ Added cascade: ${meta.chatTitle}`);
            } else {
                cdp.ws.close();
            }
        } catch (e) {
            // console.error(`Failed to connect to ${target.title}: ${e.message}`);
        }
    }

    // 3. Cleanup old
    for (const [id, c] of cascades.entries()) {
        if (!newCascades.has(id)) {
            console.log(`👋 Removing cascade: ${c.metadata.chatTitle}`);
            try { c.cdp.ws.close(); } catch (e) { }
        }
    }

    const changed = cascades.size !== newCascades.size; // Simple check, could be more granular
    cascades = newCascades;

    if (changed) broadcastCascadeList();
}

async function updateSnapshots() {
    // Parallel updates
    await Promise.all(Array.from(cascades.values()).map(async (c) => {
        try {
            const snap = await captureHTML(c.cdp); // Only capture HTML
            if (snap) {
                const hash = hashString(snap.html);
                if (hash !== c.snapshotHash) {
                    c.snapshot = snap;
                    c.snapshotHash = hash;
                    broadcast({ type: 'snapshot_update', cascadeId: c.id });
                    // console.log(`📸 Updated ${c.metadata.chatTitle}`);
                }
            }
        } catch (e) { }
    }));
}

function broadcast(msg) {
    if (!wss) return;
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
    });
}

function broadcastCascadeList() {
    const list = Array.from(cascades.values()).map(c => ({
        id: c.id,
        title: c.metadata.chatTitle,
        window: c.metadata.windowTitle,
        active: c.metadata.isActive
    }));
    broadcast({ type: 'cascade_list', cascades: list });
}

// --- Server Setup ---

async function main() {
    const app = express();
    const server = http.createServer(app);
    wss = new WebSocketServer({ server });

    app.use(express.json());
    app.use(express.static(join(__dirname, 'public')));

    // API Routes
    app.get('/cascades', (req, res) => {
        res.json(Array.from(cascades.values()).map(c => ({
            id: c.id,
            title: c.metadata.chatTitle,
            active: c.metadata.isActive
        })));
    });

    app.get('/snapshot/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c || !c.snapshot) return res.status(404).json({ error: 'Not found' });
        res.json(c.snapshot);
    });

    app.get('/styles/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Not found' });
        res.json({ css: c.css || '' });
    });

    // --- Dashboard & Auto-Accept APIs ---
    app.post('/api/auto-accept', async (req, res) => {
        autoAcceptEnabled = !!req.body.enabled;
        const script = autoAcceptEnabled ? "window.__autoAcceptStart({ ide: 'antigravity' })" : "window.__autoAcceptStop()";
        
        await Promise.all(Array.from(cascades.values()).map(async (c) => {
            if (c.cdp.rootContextId) {
                try {
                    await c.cdp.call("Runtime.evaluate", {
                        expression: script,
                        contextId: c.cdp.rootContextId
                    });
                } catch(e) {}
            }
        }));
        res.json({ success: true, enabled: autoAcceptEnabled });
    });

    app.get('/api/auto-accept/status', (req, res) => {
        res.json({ enabled: autoAcceptEnabled });
    });

    app.get('/api/dashboard/quota', async (req, res) => {
        try {
            const serverInfo = await findAntigravityProcess();
            if (!serverInfo) {
                return res.status(503).json({ error: 'Language server not found' });
            }
            const quota = await fetchQuota(serverInfo.port, serverInfo.csrfToken);
            res.json(quota);
        } catch(e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/dashboard/cache', async (req, res) => {
        try {
            const info = await cacheManager.getCacheInfo();
            res.json({
                brainSizeHr: (info.brainSize / (1024*1024)).toFixed(2) + ' MB',
                conversationsSizeHr: (info.conversationsSize / (1024*1024)).toFixed(2) + ' MB',
                totalSizeHr: (info.totalSize / (1024*1024)).toFixed(2) + ' MB',
                brainCount: info.brainCount,
                ...info
            });
        } catch(e) {
            res.status(500).json({ error: e.message });
        }
    });
    // ------------------------------------

    // Alias for simple single-view clients (returns first active or first available)
    app.get('/snapshot', (req, res) => {
        const active = Array.from(cascades.values()).find(c => c.metadata.isActive) || cascades.values().next().value;
        if (!active || !active.snapshot) return res.status(503).json({ error: 'No snapshot' });
        res.json(active.snapshot);
    });

    app.post('/send/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        // Re-using the injection logic logic would be long, 
        // but let's assume valid injection for brevity in this single-file request:
        // We'll trust the previous logic worked, just pointing it to c.cdp

        // ... (Injection logic here would be same as before, simplified for brevity of this file edit)
        // For now, let's just log it to prove flow works
        console.log(`Message to ${c.metadata.chatTitle}: ${req.body.message}`);
        // TODO: Port the full injection script back in if needed, 
        // but user asked for "update" which implies features, I'll assume I should include it.
        // See helper below.

        const result = await injectMessage(c.cdp, req.body.message);
        if (result.ok) res.json({ success: true });
        else res.status(500).json(result);
    });


    wss.on('connection', (ws) => {
        broadcastCascadeList(); // Send list on connect
    });

    const PORT = process.env.PORT || 3000;
    await freePort(PORT);
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });

    // Start Loops
    discover();
    setInterval(discover, DISCOVERY_INTERVAL);
    setInterval(updateSnapshots, POLL_INTERVAL);
}

async function freePort(port) {
    try {
        let pids = [];
        if (process.platform === 'win32') {
            const { stdout } = await execAsync(
                `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique"`
            );
            pids = stdout.trim().split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
        } else {
            const { stdout } = await execAsync(`lsof -ti tcp:${port} 2>/dev/null || true`);
            pids = stdout.trim().split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
        }
        if (pids.length === 0) return;
        console.log(`⚡ Port ${port} in use (PID${pids.length > 1 ? 's' : ''}: ${pids.join(', ')}), rebooting...`);
        for (const pid of pids) {
            try {
                if (process.platform === 'win32') {
                    try {
                        await execAsync(`taskkill /F /PID ${pid}`);
                    } catch (e) {
                        // taskkill may fail on elevated processes — try Stop-Process as fallback
                        await execAsync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`);
                    }
                } else {
                    process.kill(pid, 'SIGKILL');
                }
            } catch (e) { /* already gone */ }
        }
        await new Promise(r => setTimeout(r, 600)); // give OS time to release port
    } catch (e) { /* non-fatal */ }
}

// Injection Helper (Moved down to keep main clear)
async function injectMessage(cdp, text) {
    const SCRIPT = `(async () => {
        // Try contenteditable first, then textarea
        const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if (!editor) return { ok: false, reason: "no editor found" };
        
        editor.focus();
        
        if (editor.tagName === 'TEXTAREA') {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeTextAreaValueSetter.call(editor, "${text.replace(/"/g, '\\"')}");
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, "${text.replace(/"/g, '\\"')}");
        }
        
        await new Promise(r => setTimeout(r, 100));
        
        // Try multiple button selectors
        const btn = document.querySelector('button[class*="arrow"]') || 
                   document.querySelector('button[aria-label*="Send"]') ||
                   document.querySelector('button[type="submit"]');

        if (btn) {
            btn.click();
        } else {
             // Fallback to Enter key
             editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter" }));
        }
        return { ok: true };
    })()`;

    try {
        const res = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: cdp.rootContextId
        });
        return res.result?.value || { ok: false };
    } catch (e) { return { ok: false, reason: e.message }; }
}

main();
