begin;

-- Server-only cancellation. Identity is resolved by BB-06, never by the browser.
-- BB-24's unique live-booking index and BB-63 deletion semantics are preserved.
create function public.bb64_cancel_slot(p_master_id bigint, p_slot_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_slot public.slots%rowtype;
    v_booking public.bookings%rowtype;
begin
    if p_master_id is null or p_master_id <= 0 or p_slot_id is null or p_slot_id <= 0 then
        raise exception using errcode = 'PT422', message = 'BB64_INVALID_ARGUMENT';
    end if;

    -- Slot first, then booking, just like BB-24/BB-63. A missing and a foreign
    -- slot are indistinguishable, including when a concurrent deletion wins.
    select s.* into v_slot from public.slots s
    where s.slot_id = p_slot_id for update;
    if not found or v_slot.master_id is distinct from p_master_id then
        raise exception using errcode = 'PT404', message = 'BB64_SLOT_NOT_FOUND';
    end if;

    -- Never wait for a legacy writer holding a booking before its slot: that
    -- could form a lock cycle. Fail with a conflict; the entire RPC rolls back.
    begin
        perform b.booking_id from public.bookings b where b.slot_id = p_slot_id
        order by b.booking_id for update nowait;
    exception when lock_not_available then
        raise exception using errcode = 'PT409', message = 'BB64_BOOKING_BUSY';
    end;

    if exists (select 1 from public.bookings b where b.slot_id = p_slot_id
        and (b.status is null or b.status not in (
            'Ожидает подтверждения мастера', 'Активна',
            'Отменена мастером', 'Отменена моделью'
        ))) then
        raise exception using errcode = 'PT409', message = 'BB64_INVALID_STATE';
    end if;

    select b.* into v_booking from public.bookings b
    where b.slot_id = p_slot_id
      and b.status in ('Ожидает подтверждения мастера', 'Активна');
    if not found then
        -- Retry only a completed plans cancellation; preserve model rejections
        -- and unknown/inconsistent slot states rather than overwriting history.
        if v_slot.status = 'Отменен' then
            select b.* into v_booking from public.bookings b
            where b.slot_id = p_slot_id and b.status = 'Отменена мастером'
              and b.reason = 'plans'
            order by b.booking_id desc limit 1;
            if found then
                return jsonb_build_object('deleted', false, 'booking', to_jsonb(v_booking));
            end if;
        end if;
        -- Reuses the exact owner, free-state and history checks of BB-63.
        perform public.bb63_delete_slot(p_master_id, p_slot_id);
        return jsonb_build_object('deleted', true);
    end if;

    -- A live booking on a free slot can occur in legacy data: cancel it safely.
    -- Unknown/terminal slot states fail closed.
    if v_slot.status is null or v_slot.status not in (
        'Свободен', 'Ожидает подтверждения', 'Занят'
    ) then
        raise exception using errcode = 'PT409', message = 'BB64_INVALID_STATE';
    end if;
    update public.bookings set status = 'Отменена мастером', reason = 'plans'
    where booking_id = v_booking.booking_id
      and status in ('Ожидает подтверждения мастера', 'Активна')
    returning * into v_booking;
    if not found or v_booking.status is distinct from 'Отменена мастером'
       or v_booking.reason is distinct from 'plans' then
        raise exception using errcode = 'PT409', message = 'BB64_INVALID_STATE';
    end if;

    update public.slots set status = 'Отменен' where slot_id = p_slot_id
    returning * into v_slot;
    if not found or v_slot.status is distinct from 'Отменен' then
        raise exception using errcode = 'PT409', message = 'BB64_INVALID_STATE';
    end if;
    -- No catch for write errors: constraints/triggers roll back both changes.
    return jsonb_build_object('deleted', false, 'booking', to_jsonb(v_booking));
end;
$$;

revoke all on function public.bb64_cancel_slot(bigint, bigint) from public, anon, authenticated;
grant execute on function public.bb64_cancel_slot(bigint, bigint) to service_role;

commit;
