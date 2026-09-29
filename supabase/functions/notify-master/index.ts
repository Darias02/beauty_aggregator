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

        if (!actor || Number(actor.id) !== Number(body.actor_id)) {
            return Response.json(
                { error: 'Invalid Telegram data' },
                { status: 401, headers: corsHeaders }
            );
        }

        const admin = createClient(
            Deno.env.get('SUPABASE_URL') || '',
            getAdminKey()
        );

        const { data: booking } = await admin
            .from('bookings')
            .select('booking_id,user_id,reason,slot_id')
            .eq('booking_id', body.booking_id)
            .single();

        if (!booking || Number(booking.user_id) !== Number(actor.id)) {
            return Response.json(
                { error: 'Booking not found' },
                { status: 404, headers: corsHeaders }
            );
        }

        const { data: slot } = await admin
            .from('slots')
            .select('master_id,date_time,city,address,service_id')
            .eq('slot_id', booking.slot_id)
            .single();

        if (!slot?.master_id) {
            return Response.json(
                { error: 'Master not found' },
                { status: 404, headers: corsHeaders }
            );
        }

        const { data: service } = await admin
            .from('services')
            .select('name')
            .eq('service_id', slot.service_id)
            .single();

        const { data: model } = await admin
            .from('users')
            .select('name')
            .eq('user_id', booking.user_id)
            .single();

        const date = new Date(slot.date_time)
            .toLocaleDateString('ru-RU');

        const time = new Date(slot.date_time)
            .toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit'
            });

        let text = '';

        if (body.type === 'booking_created') {
            text =
                'Новая заявка\n\n' +
                `Услуга: ${service?.name || 'Услуга'}\n` +
                `Дата: ${date}\n` +
                `Время: ${time}\n` +
                `Модель: ${model?.name || 'Модель'}\n\n` +
                'Откройте BB, чтобы посмотреть заявку.';
        } else if (body.type === 'model_cancelled') {
            text =
                'Модель отменила запись\n\n' +
                `Услуга: ${service?.name || 'Услуга'}\n` +
                `Дата: ${date}\n` +
                `Время: ${time}\n` +
                `Причина: ${booking.reason === 'time' ? 'Не подходит время' : 'Другая причина'}`;
        } else {
            return Response.json({ ok: true }, { headers: corsHeaders });
        }

        await sendTelegramMessage(
            Number(slot.master_id),
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