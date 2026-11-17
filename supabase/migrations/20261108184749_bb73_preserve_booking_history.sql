-- Local contract fix. Production applicability requires the BB-73 readonly
-- schema audit and separate rollout approval. Never replay BB-70 in production.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
    if to_regprocedure('public.bb63_delete_slot(bigint,bigint)') is null then
        raise exception 'BB-73: existing BB-63 RPC required; review schema first';
    end if;
end;
$$;

create or replace function public.bb63_delete_slot(p_master_id bigint, p_slot_id bigint)
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
    -- Slot first, as in BB-24/64/66/67. FOR UPDATE also excludes the FK key-share
    -- lock of a concurrent legacy INSERT referencing this slot until commit.
    select s.* into v_slot from public.slots s where s.slot_id = p_slot_id for update;
    if not found or v_slot.master_id is distinct from p_master_id then
        raise exception using errcode = 'PT404', message = 'BB63_SLOT_NOT_FOUND';
    end if;
    if v_slot.status is distinct from 'Свободен' then
        raise exception using errcode = 'PT409', message = 'BB63_SLOT_UNAVAILABLE';
    end if;
    -- No status allowlist: cancelled, unknown and NULL states are all history.
    -- BB-64 delegates its free-slot deletion to this function, so both paths
    -- reject deletion without changing bookings, slots, statuses or FK actions.
    if exists (select 1 from public.bookings b where b.slot_id = p_slot_id) then
        raise exception using errcode = 'PT409', message = 'BB73_SLOT_HAS_HISTORY';
    end if;
    delete from public.slots where slot_id = p_slot_id;
    if not found then
        raise exception using errcode = 'PT409', message = 'BB63_SLOT_UNAVAILABLE';
    end if;
    return true;
end;
$$;

revoke all on function public.bb63_delete_slot(bigint, bigint) from public, anon, authenticated;
grant execute on function public.bb63_delete_slot(bigint, bigint) to service_role;

commit;
