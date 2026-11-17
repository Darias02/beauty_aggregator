import { createClient } from '@supabase/supabase-js';
import type { CatalogRepository, Service } from './handler.ts';

const serviceColumns = 'service_id,name,description';
const PAGE_SIZE = 500;

export function createSupabaseCatalogRepository(
    url: string,
    key: string,
    fetchImpl: typeof fetch = fetch,
): CatalogRepository {
    const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: fetchImpl },
    });

    return {
        async getServices() {
            const services: Service[] = [];
            // Preserve the existing ordered, at-most-100 service contract.
            while (services.length < 100) {
                const { data, error } = await admin.from('services').select(serviceColumns)
                    .order('service_id').range(services.length, 99);
                if (error) throw error;
                if (!data?.length) break;
                // UI-only fields are absent from public.services; preserve the API shape.
                services.push(...data.map((service) => ({
                    ...service,
                    icon_url: null,
                    duration: null,
                })));
            }
            return services;
        },
        async getAvailableServiceCounts() {
            const counts: Record<string, number> = {};
            let offset = 0;
            while (true) {
                const { data, error } = await admin.from('slots').select('service_id')
                    .eq('status', 'Свободен').order('slot_id')
                    .range(offset, offset + PAGE_SIZE - 1);
                if (error) throw error;
                if (!data?.length) break;
                for (const slot of data) {
                    counts[slot.service_id] = (counts[slot.service_id] || 0) + 1;
                }
                // Advance by actual rows, even if the server cap is smaller than PAGE_SIZE.
                // A short page is not proof that all rows have been read.
                offset += data.length;
            }
            return counts;
        },
        async getAvailableCities() {
            const cities = new Set<string>();
            let offset = 0;
            while (true) {
                const { data, error } = await admin.from('slots').select('city')
                    .not('city', 'is', null).order('slot_id')
                    .range(offset, offset + PAGE_SIZE - 1);
                if (error) throw error;
                if (!data?.length) break;
                for (const row of data) {
                    const city = String(row.city || '').trim();
                    if (city) cities.add(city);
                }
                offset += data.length;
            }
            return [...cities].sort((a, b) => a.localeCompare(b, 'ru'));
        },
    };
}
