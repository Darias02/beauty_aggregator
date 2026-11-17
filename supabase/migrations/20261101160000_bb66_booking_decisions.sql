begin;

-- Server-only operation API, extendable for model cancellation in BB-67.
create function public.bb66_decide_booking(
    p_master_id bigint, p_booking_id bigint, p_action text, p_reason text default null
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
    v_slot_id bigint;
    v_slot public.slots%rowtype;
    v_booking public.bookings%rowtype;
    v_before public.bookings%rowtype;
    v_status text;
    v_slot_status text;
begin
    if p_master_id is null or p_master_id <= 0 or p_booking_id is null or p_booking_id <= 0
       or p_action is null or p_action not in ('confirm', 'reject')
       or (p_action = 'confirm' and p_reason is not null)
       or (p_action = 'reject' and (p_reason is null or p_reason not in ('model', 'plans'))) then
        raise exception using errcode = 'PT422', message = 'BB66_INVALID_ARGUMENT';
    end if;

    -- Unlocked lookup only locates the slot; recheck the relationship after locks.
    select b.slot_id into v_slot_id from public.bookings b where b.booking_id = p_booking_id;
    select s.* into v_slot from public.slots s where s.slot_id = v_slot_id for update;
    if not found or v_slot.master_id is distinct from p_master_id then
        raise exception using errcode = 'PT404', message = 'BB66_BOOKING_NOT_FOUND';
    end if;
    -- Same order as BB-24/63/64. NOWAIT avoids cycles with reverse-order legacy writers.
    begin
        perform b.booking_id from public.bookings b where b.slot_id = v_slot_id
        order by b.booking_id for update nowait;
    exception when lock_not_available then
        raise exception using errcode = 'PT409', message = 'BB66_BOOKING_BUSY';
    end;
    select b.* into v_booking from public.bookings b
    where b.booking_id = p_booking_id and b.slot_id = v_slot_id;
    if not found then
        raise exception using errcode = 'PT404', message = 'BB66_BOOKING_NOT_FOUND';
    end if;
    if v_booking.user_id is null or exists (
        select 1 from public.bookings b where b.slot_id = v_slot_id
        and (b.status is null or b.status not in ('Ожидает подтверждения мастера',
            'Активна', 'Отменена мастером', 'Отменена моделью'))
    ) then
        raise exception using errcode = 'PT409', message = 'BB66_INVALID_STATE';
    end if;
    v_status := case when p_action = 'confirm' then 'Активна' else 'Отменена мастером' end;
    v_slot_status := case when p_action = 'confirm' then 'Занят'
        when p_reason = 'model' then 'Свободен' else 'Отменен' end;
    if v_booking.status = v_status and v_booking.reason is not distinct from p_reason
       and v_slot.status = v_slot_status and not exists (
           select 1 from public.bookings b where b.slot_id = v_slot_id
           and b.booking_id <> p_booking_id and b.status in ('Ожидает подтверждения мастера', 'Активна')
       ) then
        return jsonb_build_object('booking', to_jsonb(v_booking), 'replayed', true);
    end if;
    if v_booking.status is distinct from 'Ожидает подтверждения мастера'
       or v_booking.reason is not null or v_slot.status is distinct from 'Ожидает подтверждения'
       or exists (select 1 from public.bookings b where b.slot_id = v_slot_id
           and b.booking_id <> p_booking_id and b.status in ('Ожидает подтверждения мастера', 'Активна')) then
        raise exception using errcode = 'PT409', message = 'BB66_INVALID_STATE';
    end if;
    if p_action = 'confirm' and (v_slot.date_time is null or v_slot.date_time <= clock_timestamp()) then
        raise exception using errcode = 'PT409', message = 'BB66_SLOT_EXPIRED';
    end if;
    v_before := v_booking;
    update public.bookings set status = v_status, reason = p_reason
    where booking_id = p_booking_id and slot_id = v_slot_id
      and status = 'Ожидает подтверждения мастера'
    returning * into v_booking;
    if not found or v_booking.status is distinct from v_status
       or v_booking.reason is distinct from p_reason
       or v_booking.slot_id is distinct from v_slot_id
       or v_booking.user_id is distinct from v_before.user_id then
        raise exception using errcode = 'PT409', message = 'BB66_INVALID_STATE';
    end if;
    update public.slots set status = v_slot_status
    where slot_id = v_slot_id and status = 'Ожидает подтверждения'
    returning * into v_slot;
    if not found or v_slot.status is distinct from v_slot_status
       or v_slot.master_id is distinct from p_master_id then
        raise exception using errcode = 'PT409', message = 'BB66_INVALID_STATE';
    end if;
    -- Keep model rejection history: BB-24 and slots-read use it to hide the slot.
    -- Uncaught SQL/constraint errors roll back both table updates in this RPC.
    return jsonb_build_object('booking', to_jsonb(v_booking), 'replayed', false);
end;
$$;
revoke all on function public.bb66_decide_booking(bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function public.bb66_decide_booking(bigint, bigint, text, text) to service_role;
commit;
