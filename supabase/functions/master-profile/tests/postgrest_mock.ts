import { equal } from 'node:assert/strict';
import type { Row } from './helpers.ts';

export function postgrestMock(initialRows: Row[] = []) {
    const rows = new Map(initialRows.map((row) => [row.master_id, { ...row }]));
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
            equal(url.pathname, '/rest/v1/masters');
            equal(req.headers.get('apikey'), 'server-only-test-key');
            const body = req.body ? await req.json() : null;
            calls.push({ method: req.method, url, headers: req.headers, body });
            if (req.method === mock.failMethod) {
                return Response.json({
                    code: '42501',
                    message: 'Sensitive SQL and server-only-test-key',
                }, { status: 400 });
            }
            const filter = url.searchParams.get('master_id');
            const id = filter ? Number(filter.slice(3)) : body?.master_id;
            if (req.method === 'POST') {
                equal(url.searchParams.get('on_conflict'), 'master_id');
                equal(req.headers.get('prefer')?.includes('resolution=ignore-duplicates'), true);
                mock.beforeInsert?.();
                if (!rows.has(id)) {
                    rows.set(id, { ...body, phone_number: null, address: null, avatar_url: null });
                }
                return new Response(null, { status: 201 });
            }
            equal(filter?.startsWith('eq.'), true);
            equal(url.searchParams.get('select'), 'master_id,name,address,avatar_url');
            const row = rows.get(id);
            if (req.method === 'PATCH' && row) Object.assign(row, body);
            return Response.json(
                row
                    ? [{
                        master_id: row.master_id,
                        name: row.name,
                        address: row.address,
                        avatar_url: row.avatar_url,
                    }]
                    : [],
            );
        }) as typeof fetch,
    };
    return mock;
}
