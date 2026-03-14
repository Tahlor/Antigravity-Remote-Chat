/** Cache manager — reads, sizes, and cleans Antigravity IDE local cache dirs. */
import fs from 'fs';
import path from 'path';
import os from 'os';

function getGeminiDir() { return path.join(os.homedir(), '.gemini'); }
function getAntigravityDir() { return path.join(getGeminiDir(), 'antigravity'); }
export function getBrainDir() { return path.join(getAntigravityDir(), 'brain'); }
export function getConversationsDir() { return path.join(getAntigravityDir(), 'conversations'); }
export function getCodeTrackerDir() { return path.join(getAntigravityDir(), 'code_tracker', 'active'); }

export class CacheManager {
    constructor(brainDir, conversationsDir, codeTrackerDir) {
        this.brainDir = brainDir || getBrainDir();
        this.conversationsDir = conversationsDir || getConversationsDir();
        this.codeTrackerDir = codeTrackerDir || getCodeTrackerDir();
    }

    async getCacheInfo() {
        const [brainSize, conversationsSize, brainTasks, codeContexts, conversationsCount] = await Promise.all([
            this.getDirectorySize(this.brainDir),
            this.getDirectorySize(this.conversationsDir),
            this.getBrainTasks(),
            this.getCodeContexts(),
            this.getFileCount(this.conversationsDir),
        ]);
        return {
            brainSize,
            conversationsSize,
            totalSize: brainSize + conversationsSize,
            brainCount: brainTasks.length,
            conversationsCount,
            brainTasks,
            codeContexts,
        };
    }

    async getBrainTasks() {
        try {
            const entries = await fs.promises.readdir(this.brainDir, { withFileTypes: true });
            const tasks = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const taskPath = path.join(this.brainDir, entry.name);
                const [size, fileCount, label, stat] = await Promise.all([
                    this.getDirectorySize(taskPath),
                    this.getFileCount(taskPath),
                    this.getTaskLabel(taskPath, entry.name),
                    fs.promises.stat(taskPath),
                ]);
                tasks.push({
                    id: entry.name,
                    label,
                    path: taskPath,
                    size,
                    fileCount,
                    createdAt: stat.birthtimeMs || stat.mtimeMs,
                });
            }
            return tasks.sort((a, b) => b.createdAt - a.createdAt);
        } catch {
            return [];
        }
    }

    async getCodeContexts() {
        try {
            const entries = await fs.promises.readdir(this.codeTrackerDir, { withFileTypes: true });
            const contexts = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const ctxPath = path.join(this.codeTrackerDir, entry.name);
                const size = await this.getDirectorySize(ctxPath);
                contexts.push({ id: entry.name, name: entry.name, size });
            }
            return contexts.sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return [];
        }
    }

    async getDirectorySize(dirPath) {
        try {
            const stat = await fs.promises.stat(dirPath);
            if (!stat.isDirectory()) return stat.size;
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            let total = 0;
            for (const entry of entries) {
                const entryPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) total += await this.getDirectorySize(entryPath);
                else if (entry.isFile()) {
                    const s = await fs.promises.stat(entryPath);
                    total += s.size;
                }
            }
            return total;
        } catch {
            return 0;
        }
    }

    async getFileCount(dirPath) {
        try {
            return (await fs.promises.readdir(dirPath, { withFileTypes: true })).filter(e => e.isFile()).length;
        } catch {
            return 0;
        }
    }

    async getTaskLabel(taskPath, id) {
        try {
            const mdPath = path.join(taskPath, 'task.md');
            const content = await fs.promises.readFile(mdPath, 'utf-8');
            const firstLine = content.split('\n')[0];
            if (firstLine?.startsWith('#')) return firstLine.replace(/^#+\s*/, '').trim();
            return content.trim().split('\n')[0] || id;
        } catch {
            return id;
        }
    }
}

export function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let val = bytes / 1024;
    let idx = 0;
    while (val >= 1024 && idx < units.length - 1) { val /= 1024; idx++; }
    return `${val.toFixed(1)} ${units[idx]}`;
}
