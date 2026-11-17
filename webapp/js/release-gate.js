// Production boot installs this guard before importing app.js. Staging is unchanged.
export function createReleaseGate({ release, projectUrl, fetchImpl, block }) {
    const message = 'Приложение обновляется. Закройте Mini App и откройте его заново через Telegram.';
    let blocked = false;

    async function check() {
        if (blocked) throw new Error('APP_UPDATE_REQUIRED');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await fetchImpl('/release.json', {
                cache: 'no-store', credentials: 'omit', redirect: 'error',
                signal: controller.signal,
            });
            const state = await response.json();
            if (!response.ok || state?.release !== release || state?.maintenance !== false) {
                throw new Error('APP_UPDATE_REQUIRED');
            }
            if (blocked) throw new Error('APP_UPDATE_REQUIRED');
        } catch {
            blocked = true;
            block(message);
            throw new Error('APP_UPDATE_REQUIRED');
        } finally {
            clearTimeout(timeout);
        }
    }

    async function guardedFetch(input, options) {
        const target = typeof input === 'string' || input instanceof URL ? input : input.url;
        const url = new URL(target, projectUrl);
        if (url.origin === new URL(projectUrl).origin && url.pathname.startsWith('/functions/v1/')) {
            await check();
            if (blocked) throw new Error('APP_UPDATE_REQUIRED');
        }
        return fetchImpl(input, options);
    }

    return { check, fetch: guardedFetch };
}
