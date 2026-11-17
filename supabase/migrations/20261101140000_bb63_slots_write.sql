begin;

-- The existing slots_one_live_time_per_master partial unique index (20260930_bb)
-- arbitrates concurrent inserts across services, including equal instants with
-- different timezone offsets. Do not replace it with a check-then-insert query.
create function public.bb63_create_slot(
    p_master_id bigint, p_service_id bigint, p_date_time timestamptz,
    p_city text, p_address text, p_description text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_slot public.slots%rowtype;
begin
    if p_master_id is null or p_master_id <= 0
       or p_service_id is null or p_service_id <= 0
       or p_date_time is null or not isfinite(p_date_time)
       or p_city is null or btrim(p_city) in ('', 'Город') or char_length(p_city) > 200
       or p_address is null or char_length(p_address) > 500
       or p_description is null or char_length(p_description) > 2000 then
        raise exception using errcode = 'PT422', message = 'BB63_INVALID_ARGUMENT';
    end if;

    -- IDs come only from BB-06 on the server. Never create a master implicitly.
    perform 1 from public.masters where master_id = p_master_id for key share;
    if not found then
        raise exception using errcode = 'PT404', message = 'BB63_MASTER_NOT_FOUND';
    end if;
    perform 1 from public.services where service_id = p_service_id for key share;
    if not found then
        raise exception using errcode = 'PT422', message = 'BB63_SERVICE_NOT_FOUND';
    end if;
    -- Recheck actual time after waiting on FK locks, not transaction start time.
    if p_date_time <= clock_timestamp() then
        raise exception using errcode = 'PT410', message = 'BB63_SLOT_EXPIRED';
    end if;
    insert into public.slots (master_id, service_id, date_time, status, city, address, description)
    values (p_master_id, p_service_id, p_date_time, 'Свободен', p_city, p_address, p_description)
    returning * into v_slot;
    -- A concurrent insert can block on the unique index until this time has passed.
    if p_date_time <= clock_timestamp() then
        raise exception using errcode = 'PT410', message = 'BB63_SLOT_EXPIRED';
    end if;
    return to_jsonb(v_slot);
end;
$$;

create function public.bb63_delete_slot(p_master_id bigint, p_slot_id bigint)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_slot public.slots%rowtype;
begin
    if p_master_id is null or p_master_id <= 0 or p_slot_id is null or p_slot_id <= 0 then
        raise exception using errcode = 'PT422', message = 'BB63_INVALID_ARGUMENT';
    end if;
    -- Same lock order as BB-24: slot, then bookings. Hold it through deletion.
    select s.* into v_slot from public.slots s where s.slot_id = p_slot_id for update;
    if not found or v_slot.master_id is distinct from p_master_id then
        raise exception using errcode = 'PT404', message = 'BB63_SLOT_NOT_FOUND';
    end if;
    if v_slot.status is distinct from 'Свободен' then
        raise exception using errcode = 'PT409', message = 'BB63_SLOT_UNAVAILABLE';
    end if;
    -- Fail closed for live/unknown legacy bookings even if slot status drifted.
    -- Known cancelled history follows the existing ON DELETE CASCADE schema.
    if exists (select 1 from public.bookings b where b.slot_id = p_slot_id
        and (b.status is null or b.status not in ('Отменена мастером', 'Отменена моделью'))) then
        raise exception using errcode = 'PT409', message = 'BB63_SLOT_UNAVAILABLE';
    end if;
    delete from public.slots where slot_id = p_slot_id;
    return true;
end;
$$;

revoke all on function public.bb63_create_slot(bigint, bigint, timestamptz, text, text, text)
    from public, anon, authenticated;
revoke all on function public.bb63_delete_slot(bigint, bigint) from public, anon, authenticated;
grant execute on function public.bb63_create_slot(bigint, bigint, timestamptz, text, text, text)
    to service_role;
grant execute on function public.bb63_delete_slot(bigint, bigint) to service_role;

commit;
