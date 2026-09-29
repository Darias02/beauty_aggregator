import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

export function getAdminKey() {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    return keys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
}

export async function validateInitData(initData: string, botToken: string) {
    if (!initData || !botToken) return null;

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;

    const checkString = [...params.entries()]
        .filter(([key]) => key !== 'hash')
        .sort(([a], [b]) => a.localeCompare(b))
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
        ['sign']
    );

    const signature = await crypto.subtle.sign(
        'HMAC',
        dataKey,
        encoder.encode(checkString)
    );

    const calculated = [...new Uint8Array(signature)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');

    if (calculated !== hash) return null;

    try {
        return JSON.parse(params.get('user') || 'null');
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