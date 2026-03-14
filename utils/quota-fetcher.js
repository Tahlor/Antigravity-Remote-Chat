/**
 * Quota fetcher — calls the local Antigravity GetUserStatus API
 * Ported from antigravity-dashboard
 */
import http from 'http';
import https from 'https';

export async function fetchQuota(
    port,
    csrfToken,
    host = '127.0.0.1',
    apiPath = '/exa.language_server_pb.LanguageServerService/GetUserStatus'
) {
    const data = await postWithFallback(port, csrfToken, host, apiPath, {
        metadata: {
            ideName: 'antigravity',
            extensionName: 'antigravity',
            locale: 'en',
        },
    });
    return parseResponse(data);
}

async function postWithFallback(port, csrfToken, host, path, body) {
    try {
        return await post(port, csrfToken, host, path, body, 'http');
    } catch {
        return await post(port, csrfToken, host, path, body, 'https');
    }
}

function post(port, csrfToken, host, path, body, protocol) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const lib = protocol === 'https' ? https : http;
        const req = lib.request({
            hostname: host,
            port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken,
            },
            rejectUnauthorized: false,
            timeout: 10000,
        }, res => {
            let raw = '';
            res.on('data', chunk => (raw += chunk));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(raw));
                } catch {
                    reject(new Error('Invalid JSON from Antigravity API'));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(payload);
        req.end();
    });
}

function parseResponse(data) {
    const userStatus = data.userStatus;
    const planInfo = userStatus?.planStatus?.planInfo;
    const availablePrompt = userStatus?.planStatus?.availablePromptCredits;
    const availableFlow = userStatus?.planStatus?.availableFlowCredits;

    let promptCredits;
    if (planInfo && availablePrompt !== undefined) {
        const monthly = Number(planInfo.monthlyPromptCredits);
        const available = Number(availablePrompt);
        if (monthly > 0) {
            promptCredits = { available, monthly, remainingPct: (available / monthly) * 100 };
        }
    }

    let flowCredits;
    if (planInfo?.monthlyFlowCredits && availableFlow !== undefined) {
        const monthly = Number(planInfo.monthlyFlowCredits);
        const available = Number(availableFlow);
        if (monthly > 0) {
            flowCredits = { available, monthly, remainingPct: (available / monthly) * 100 };
        }
    }

    let tokenUsage;
    if (promptCredits || flowCredits) {
        const totalAvailable = (promptCredits?.available || 0) + (flowCredits?.available || 0);
        const totalMonthly = (promptCredits?.monthly || 0) + (flowCredits?.monthly || 0);
        tokenUsage = {
            promptCredits,
            flowCredits,
            totalAvailable,
            totalMonthly,
            overallRemainingPct: totalMonthly > 0 ? (totalAvailable / totalMonthly) * 100 : 0,
        };
    }

    const tier = userStatus?.userTier;
    let userInfo;
    if (userStatus?.name || tier) {
        userInfo = {
            name: userStatus.name,
            email: userStatus.email,
            tier: tier?.name || planInfo?.teamsTier,
            tierDescription: tier?.description,
            planName: planInfo?.planName,
            browserEnabled: planInfo?.browserEnabled,
            knowledgeBaseEnabled: planInfo?.knowledgeBaseEnabled,
        };
    }

    const rawModels = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const models = rawModels
        .filter(m => m.quotaInfo)
        .map(m => {
            const resetTime = new Date(m.quotaInfo.resetTime);
            const diff = resetTime.getTime() - Date.now();
            const fraction = m.quotaInfo.remainingFraction ?? 0;
            return {
                label: m.label || 'Unknown',
                modelId: m.modelOrAlias?.model || 'unknown',
                remainingPct: fraction * 100,
                isExhausted: fraction === 0,
                resetTime,
                timeUntilReset: formatTime(diff),
            };
        });

    return { models, userInfo, tokenUsage, timestamp: new Date() };
}

function formatTime(ms) {
    if (ms <= 0) return 'Ready';
    const mins = Math.ceil(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    if (h >= 24) {
        const d = Math.floor(h / 24);
        const remH = h % 24;
        return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
    }
    return `${h}h ${mins % 60}m`;
}
