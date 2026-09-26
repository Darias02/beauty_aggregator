import { APP_CONFIG } from '../config.js';


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
        const { error } =
            await supabase
                .from('services')
                .select('service_id')
                .limit(1);


        return !error;
    } catch (error) {
        console.error(
            'Supabase connection error:',
            error
        );

        return false;
    }
}