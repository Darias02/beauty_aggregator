export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

export function getAdminKey(env: (name: string) => string | undefined = Deno.env.get) {
    const value = env('SUPABASE_SECRET_KEYS');
    if (value) {
        const keys = JSON.parse(value);
        if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
            throw new Error('Invalid server key configuration');
        }
        if (typeof keys.default === 'string' && keys.default.trim()) return keys.default;
    }
    return env('SUPABASE_SERVICE_ROLE_KEY') || '';
}

// Preserve the existing notification TTL. A shorter TTL must be chosen explicitly
// by server code, taking long-lived Mini App sessions into account.
export const INIT_DATA_MAX_AGE_SECONDS = 86400;

export interface VerifiedTelegramUser {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    [key: string]: unknown;
}

// BB-07 profile contract; notification callers keep VerifiedTelegramUser.
export type TelegramUser = VerifiedTelegramUser;

export interface InitDataOptions {
    nowSeconds?: number;
    maxAgeSeconds?: number;
}

function isTelegramUser(value: unknown): value is VerifiedTelegramUser {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const user = value as Record<string, unknown>;
    if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) return false;
    if (typeof user.first_name !== 'string') return false;

    const strings = ['last_name', 'username', 'language_code', 'photo_url'];
    const booleans = ['is_bot', 'is_premium', 'added_to_attachment_menu', 'allows_write_to_pm'];
    return strings.every((key) => !(key in user) || typeof user[key] === 'string') &&
        booleans.every((key) => !(key in user) || typeof user[key] === 'boolean');
}

/**
 * Accept only Telegram.WebApp.initData, never initDataUnsafe or a client actor ID.
 * Returns a user (including its verified numeric ID) only after all checks pass.
 * maxAgeSeconds is server policy; never populate it from a request body.
 * This authenticates a user, but does not authorize an operation or prevent replay
 * within the TTL. Callers must still check access to the requested resource.
 */
export async function validateInitData(
    initData: unknown,
    botToken: string,
    { maxAgeSeconds = INIT_DATA_MAX_AGE_SECONDS, nowSeconds }: InitDataOptions = {}
): Promise<VerifiedTelegramUser | null> {
    if (typeof initData !== 'string' || !initData || initData.length > 8192 || typeof botToken !== 'string' || !botToken) return null;
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) return null;

    // URLSearchParams tolerates broken escapes and missing '='. Fail closed instead.
    try {
        for (const entry of initData.split('&')) {
            const separator = entry.indexOf('=');
            if (separator <= 0) return null;
            decodeURIComponent(entry.slice(0, separator).replace(/\+/g, ' '));
            decodeURIComponent(entry.slice(separator + 1).replace(/\+/g, ' '));
        }
    } catch {
        return null;
    }

    const params = new URLSearchParams(initData);
    const seen = new Set<string>();
    for (const [key, value] of params) {
        // Reject duplicates after decoding, including unknown parameters. Newlines
        // and '=' in keys would make the signed key=value representation ambiguous.
        if (!key || /[\r\n=]/.test(key) || /[\r\n]/.test(value) || seen.has(key)) return null;
        seen.add(key);
    }

    const hash = params.get('hash');
    const authDateString = params.get('auth_date');
    const userString = params.get('user');
    if (!hash || !/^[a-f0-9]{64}$/.test(hash) || !userString) return null;
    if (!authDateString || !/^[1-9]\d*$/.test(authDateString)) return null;

    const authDate = Number(authDateString);
    // Clock injection is server-owned and supports deterministic profile tests.
    // Preserve BB-06: no future-date grace period.
    const now = nowSeconds ?? Date.now() / 1000;
    if (!Number.isFinite(now)) return null;
    if (!Number.isSafeInteger(authDate) || authDate > now || now - authDate > maxAgeSeconds) return null;

    const checkString = [...params.entries()]
        .filter(([key]) => key !== 'hash')
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    const encoder = new TextEncoder();

    const botKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode('WebAppData'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const secret = await crypto.subtle.sign(
        'HMAC',
        botKey,
        encoder.encode(botToken)
    );

    const dataKey = await crypto.subtle.importKey(
        'raw',
        secret,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
    );

    const signature = Uint8Array.from(hash.match(/.{2}/g)!, (byte) => parseInt(byte, 16));
    // Native HMAC verification avoids an ordinary string comparison of secrets.
    const valid = await crypto.subtle.verify(
        'HMAC',
        dataKey,
        signature,
        encoder.encode(checkString)
    );

    if (!valid) return null;

    try {
        const user: unknown = JSON.parse(userString);
        return isTelegramUser(user) ? user : null;
    } catch {
        return null;
    }
}

export async function sendTelegramMessage(chatId: number, text: string, botToken: string) {
    const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text })
        }
    );

    if (!response.ok) {
        throw new Error(await response.text());
    }
}
