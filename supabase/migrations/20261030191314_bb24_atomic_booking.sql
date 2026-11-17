begin;

-- Keep the existing definition of a live booking. Duplicate legacy data must
-- fail the migration; never delete or rewrite booking history to build an index.
create unique index if not exists bookings_one_live_booking_per_slot
    on public.bookings (slot_id)
    where status in ('Ожидает подтверждения мастера', 'Активна');

-- Internal server RPC. p_user_id is public.users.user_id (Telegram bigint),
-- resolved by server authentication, never an identity supplied by a browser.
-- SECURITY INVOKER deliberately relies on the server role's table privileges.
create function public.bb24_book_slot(p_user_id bigint, p_slot_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_slot public.slots%rowtype;
    v_booking public.bookings%rowtype;
begin
    if p_user_id is null or p_user_id <= 0
       or p_slot_id is null or p_slot_id <= 0 then
        raise exception using errcode = 'PT422', message = 'BB24_INVALID_ARGUMENT';
    end if;

    -- All booking writers must lock the slot before the booking. The lock is
    -- held until the caller's transaction commits, including on RPC retries.
    select s.* into v_slot
    from public.slots s
    where s.slot_id = p_slot_id
    for update;

    if not found then
        raise exception using errcode = 'PT404', message = 'BB24_SLOT_NOT_FOUND';
    end if;

    -- Legacy defaults ('confirmed', NULL, etc.) are not evidence of a cancelled
    -- booking. Fail closed for this slot instead of silently double booking it.
    if exists (
        select 1 from public.bookings b
        where b.slot_id = p_slot_id
          and (b.status is null or b.status not in (
              'Ожидает подтверждения мастера', 'Активна',
              'Отменена мастером', 'Отменена моделью'
          ))
    ) then
        raise exception using errcode = 'PT409', message = 'BB24_INVALID_STATE';
    end if;

    select b.* into v_booking
    from public.bookings b
    where b.slot_id = p_slot_id
      and b.status in ('Ожидает подтверждения мастера', 'Активна')
    for update;

    if found then
        if v_booking.user_id is distinct from p_user_id then
            raise exception using errcode = 'PT409', message = 'BB24_SLOT_UNAVAILABLE';
        end if;

        if (
            (v_booking.status = 'Ожидает подтверждения мастера'
             and v_slot.status = 'Ожидает подтверждения')
            or (v_booking.status = 'Активна' and v_slot.status = 'Занят')
        ) is not true then
            raise exception using errcode = 'PT409', message = 'BB24_INVALID_STATE';
        end if;

        -- A lost response can be retried even after the appointment time.
        -- Only an existing live booking is replayed; cancellations stay history.
        return jsonb_build_object('booking', to_jsonb(v_booking), 'replayed', true);
    end if;

    if v_slot.status is distinct from 'Свободен' then
        raise exception using errcode = 'PT409', message = 'BB24_SLOT_UNAVAILABLE';
    end if;

    if v_slot.master_id is null or v_slot.service_id is null then
        raise exception using errcode = 'PT409', message = 'BB24_INVALID_STATE';
    end if;

    perform 1 from public.users u where u.user_id = p_user_id for key share;
    if not found then
        raise exception using errcode = 'PT404', message = 'BB24_USER_NOT_FOUND';
    end if;

    -- Match the search screen's exclusion of a model rejected by this master.
    if exists (
        select 1 from public.bookings b
        where b.slot_id = p_slot_id and b.user_id = p_user_id
          and b.status = 'Отменена мастером' and b.reason = 'model'
    ) then
        raise exception using errcode = 'PT403', message = 'BB24_MODEL_REJECTED';
    end if;

    -- Check actual time after ALL locks, including the user's FK protection.
    -- Transaction start time may be stale after waiting for another writer.
    if v_slot.date_time is null or v_slot.date_time <= clock_timestamp() then
        raise exception using errcode = 'PT409', message = 'BB24_SLOT_EXPIRED';
    end if;

    insert into public.bookings (user_id, slot_id, status, reason)
    values (p_user_id, p_slot_id, 'Ожидает подтверждения мастера', null)
    returning * into v_booking;

    if not found then
        raise exception using errcode = 'PT409', message = 'BB24_INVALID_STATE';
    end if;

    update public.slots
    set status = 'Ожидает подтверждения'
    where slot_id = p_slot_id and status = 'Свободен'
    returning * into v_slot;

    if not found or v_slot.status is distinct from 'Ожидает подтверждения' then
        raise exception using errcode = 'PT409', message = 'BB24_INVALID_STATE';
    end if;

    -- No exception handler: any SQL/constraint/trigger error rolls back BOTH
    -- writes. An outer SQL transaction must commit before reporting success.
    return jsonb_build_object('booking', to_jsonb(v_booking), 'replayed', false);
end;
$$;

-- Postgres grants new functions to PUBLIC by default. Revoke direct grants
-- too, including grants inherited from Supabase default privileges.
revoke all on function public.bb24_book_slot(bigint, bigint)
    from public, anon, authenticated;
grant execute on function public.bb24_book_slot(bigint, bigint) to service_role;

comment on function public.bb24_book_slot(bigint, bigint) is
    'Server-only atomic booking. Caller must authenticate and resolve users.user_id; no browser identity. Returns booking + replayed. PT404 missing slot/user; PT409 unavailable/expired/inconsistent; PT403 rejected model; PT422 invalid IDs. Retry an existing live user/slot pair without another insert. Requires BB-01 table protection and BB-05/BB-06 before browser integration.';

commit;
