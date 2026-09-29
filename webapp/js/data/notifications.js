import { APP_CONFIG } from '../config.js';
import { getTelegramInitData, getTelegramUserId } from '../telegram.js';

export async function sendNotification(functionName, payload = {}) {
    const initData = getTelegramInitData();
    const actorId = getTelegramUserId();

    if (!initData || !actorId) {
        console.warn('Telegram init data is unavailable.');
        return null;
    }

    const response = await fetch(
        `${APP_CONFIG.supabase.url}/functions/v1/${functionName}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: APP_CONFIG.supabase.key
            },
            body: JSON.stringify({
                ...payload,
                actor_id: actorId,
                init_data: initData
            })
        }
    );

    if (!response.ok) {
        console.warn(
            `Notification ${functionName} failed:`,
            await response.text()
        );
        return null;
    }

    return response.json();
}