import { createClient } from 'npm:@supabase/supabase-js@2';
import {
    corsHeaders,
    getAdminKey,
    validateInitData,
    sendTelegramMessage
} from '../_shared/telegram.ts';

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const body = await req.json();
        const botToken = Deno.env.get('BOT_TOKEN') || '';
        const actor = await validateInitData(body.init_data || '', botToken);

        const admin = createClient(
            Deno.env.get('SUPABASE_URL') || '',
            getAdminKey()
        );

        const { data: booking } = await admin
            .from('bookings')
            .select('booking_id,user_id,reason,slot_id')
            .eq('booking_id', body.booking_id)
            .single();

        if (!booking) {
            return Response.json(
                { error: 'Booking not found' },
                { status: 404, headers: corsHeaders }
            );
        }

        const { data: slot } = await admin
            .from('slots')
            .select('master_id,date_time,address,service_id')
            .eq('slot_id', booking.slot_id)
            .single();

        if (!actor || Number(actor.id) !== Number(slot?.master_id)) {
            return Response.json(
                { error: 'Invalid Telegram data' },
                { status: 401, headers: corsHeaders }
            );
        }

        const { data: service } = await admin
            .from('services')
            .select('name')
            .eq('service_id', slot.service_id)
            .single();

        const { data: master } = await admin
            .from('masters')
            .select('name')
            .eq('master_id', slot.master_id)
            .single();

        const date = new Date(slot.date_time)
            .toLocaleDateString('ru-RU');

        const time = new Date(slot.date_time)
            .toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit'
            });

        let text = '';

        if (body.type === 'booking_confirmed') {
            text =
                'Запись подтверждена\n\n' +
                `Услуга: ${service?.name || 'Услуга'}\n` +
                `Дата: ${date}\n` +
                `Время: ${time}\n` +
                `Адрес: ${slot.address || 'Адрес не указан'}\n` +
                `Мастер: ${master?.name || 'Мастер'}`;
        } else if (body.type === 'booking_rejected') {
            text =
                'Заявка отклонена\n\n' +
                `Услуга: ${service?.name || 'Услуга'}\n` +
                `Дата: ${date}\n` +
                `Время: ${time}\n` +
                `Причина: ${booking.reason === 'model' ? 'Не подходит модель' : 'Изменились планы'}`;
        } else if (body.type === 'slot_cancelled') {
            text =
                'Запись отменена мастером\n\n' +
                `Услуга: ${service?.name || 'Услуга'}\n` +
                `Дата: ${date}\n` +
                `Время: ${time}\n` +
                'Причина: Изменились планы';
        } else {
            return Response.json({ ok: true }, { headers: corsHeaders });
        }

        await sendTelegramMessage(
            Number(booking.user_id),
            text,
            botToken
        );

        return Response.json({ ok: true }, { headers: corsHeaders });
    } catch (error) {
        console.error(error);
        return Response.json(
            { error: 'Notification failed' },
            { status: 500, headers: corsHeaders }
        );
    }
});