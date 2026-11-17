import { equal } from 'node:assert/strict';
import type { Row } from './helpers.ts';

export function postgrestMock(initialRows: Row[] = []) {
    const rows = new Map(initialRows.map((row) => [row.user_id, { ...row }]));
    const calls: {
        method: string;
        url: URL;
        headers: Headers;
        body: Record<string, unknown> | null;
    }[] = [];
    const mock = {
        rows,
        calls,
        failMethod: '',
        beforeInsert: null as (() => void) | null,
        fetch: (async (input, init) => {
            const req = new Request(input, init);
            const url = new URL(req.url);
            equal(url.origin, 'https://profile.test');
            equal(url.pathname, '/rest/v1/users');
            equal(req.headers.get('apikey'), 'server-only-test-key');
            const body = req.body ? await req.json() : null;
            calls.push({ method: req.method, url, headers: req.headers, body });
            if (req.method === mock.failMethod) {
                return Response.json({
                    code: '42501',
                    message: 'Sensitive SQL and server-only-test-key',
                }, { status: 400 });
            }
            const filter = url.searchParams.get('user_id');
            const id = filter ? Number(filter.slice(3)) : body?.user_id;
            if (req.method === 'POST') {
                equal(url.searchParams.get('on_conflict'), 'user_id');
                equal(req.headers.get('prefer')?.includes('resolution=ignore-duplicates'), true);
                mock.beforeInsert?.();
                if (!rows.has(id)) rows.set(id, { ...body, phone_number: null });
                return new Response(null, { status: 201 });
            }
            equal(filter?.startsWith('eq.'), true);
            equal(url.searchParams.get('select'), 'user_id,name');
            const row = rows.get(id);
            if (req.method === 'PATCH' && row) Object.assign(row, body);
            return Response.json(row ? [{ user_id: row.user_id, name: row.name }] : []);
        }) as typeof fetch,
    };
    return mock;
}
