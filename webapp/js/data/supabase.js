import { APP_CONFIG } from '../config.js';
import { getServices } from './services.js';


function createSupabaseClient() {
    if (
        !window.supabase ||
        typeof window.supabase.createClient !==
            'function'
    ) {
        throw new Error(
            'Supabase JS library is not loaded.'
        );
    }


    return window.supabase.createClient(
        APP_CONFIG.supabase.url,
        APP_CONFIG.supabase.key
    );
}


export const supabase =
    createSupabaseClient();


export async function checkSupabaseConnection() {
    try {
        await getServices();


        return true;
    } catch (error) {
        console.error(
            'Supabase connection error:',
            error
        );

        return false;
    }
}
