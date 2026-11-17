begin;

-- BB-06 resolves p_user_id on the server. Slot -> bookings matches BB-24/64/66.
create function public.bb67_cancel_booking(p_user_id bigint, p_booking_id bigint, p_reason text)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
    v_slot_id bigint;
    v_slot public.slots%rowtype;
    v_booking public.bookings%rowtype;
    v_before public.slots%rowtype;
begin
    if p_user_id is null or p_user_id <= 0 or p_booking_id is null or p_booking_id <= 0
       or p_reason is null or p_reason not in ('time', 'other') then
        raise exception using errcode = 'PT422', message = 'BB67_INVALID_ARGUMENT';
    end if;

    -- Locate only; ownership and relationship are checked again under locks.
    select b.slot_id into v_slot_id from public.bookings b where b.booking_id = p_booking_id;
    select s.* into v_slot from public.slots s where s.slot_id = v_slot_id for update;
    if not found then
        raise exception using errcode = 'PT404', message = 'BB67_BOOKING_NOT_FOUND';
    end if;
    begin
        perform b.booking_id from public.bookings b where b.slot_id = v_slot_id
        order by b.booking_id for update nowait;
    exception when lock_not_available then
        raise exception using errcode = 'PT409', message = 'BB67_BOOKING_BUSY';
    end;
    select b.* into v_booking from public.bookings b
    where b.booking_id = p_booking_id and b.slot_id = v_slot_id;
    if not found or v_booking.user_id is distinct from p_user_id then
        raise exception using errcode = 'PT404', message = 'BB67_BOOKING_NOT_FOUND';
    end if;
    if v_slot.master_id is null or v_slot.service_id is null or exists (
        select 1 from public.bookings b where b.slot_id = v_slot_id
        and (b.status is null or b.status not in ('Ожидает подтверждения мастера',
            'Активна', 'Отменена мастером', 'Отменена моделью'))
    ) or exists (
        select 1 from public.bookings b where b.slot_id = v_slot_id
        and b.booking_id <> p_booking_id and b.status in ('Ожидает подтверждения мастера', 'Активна')
    ) then
        raise exception using errcode = 'PT409', message = 'BB67_INVALID_STATE';
    end if;
    if v_booking.status = 'Отменена моделью' and v_booking.reason = p_reason
       and v_slot.status = 'Свободен' then
        return jsonb_build_object('booking', to_jsonb(v_booking), 'replayed', true);
    end if;
    if v_booking.reason is not null or (
        (v_booking.status = 'Ожидает подтверждения мастера' and v_slot.status = 'Ожидает подтверждения')
        or (v_booking.status = 'Активна' and v_slot.status = 'Занят')
    ) is not true then
        raise exception using errcode = 'PT409', message = 'BB67_INVALID_STATE';
    end if;

    v_before := v_slot;
    update public.bookings set status = 'Отменена моделью', reason = p_reason
    where booking_id = p_booking_id and slot_id = v_slot_id and user_id = p_user_id
      and status = v_booking.status and reason is null
    returning * into v_booking;
    if not found or v_booking.status is distinct from 'Отменена моделью'
       or v_booking.reason is distinct from p_reason
       or v_booking.slot_id is distinct from v_slot_id
       or v_booking.user_id is distinct from p_user_id
       or v_booking.booking_id is distinct from p_booking_id then
        raise exception using errcode = 'PT409', message = 'BB67_INVALID_STATE';
    end if;
    update public.slots set status = 'Свободен'
    where slot_id = v_slot_id and status = v_before.status
    returning * into v_slot;
    if not found or v_slot.status is distinct from 'Свободен'
       or v_slot.slot_id is distinct from v_slot_id
       or v_slot.master_id is distinct from v_before.master_id
       or v_slot.service_id is distinct from v_before.service_id then
        raise exception using errcode = 'PT409', message = 'BB67_INVALID_STATE';
    end if;
    -- Any SQL error or suppressed/rewritten update rolls back both writes.
    return jsonb_build_object('booking', to_jsonb(v_booking), 'replayed', false);
end;
$$;
revoke all on function public.bb67_cancel_booking(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.bb67_cancel_booking(bigint, bigint, text) to service_role;
commit;
