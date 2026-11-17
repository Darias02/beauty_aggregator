-- Durable deduplication across Edge Function workers; no Telegram profile data.
create table public.telegram_webhook_updates (
    bot_id bigint not null check (bot_id > 0),
    update_id bigint not null check (update_id >= 0),
    owner uuid not null,
    status text not null default 'claimed'
        check (status in ('claimed', 'sending', 'completed')),
    lease_until timestamptz not null default (now() + interval '2 minutes'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (bot_id, update_id)
);

alter table public.telegram_webhook_updates enable row level security;
revoke all on public.telegram_webhook_updates from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_webhook_updates to service_role;

create function public.telegram_webhook_claim(
    p_bot_id bigint, p_update_id bigint, p_owner uuid
) returns text
language plpgsql security invoker strict set search_path = ''
as $$
declare
    receipt public.telegram_webhook_updates%rowtype;
begin
    insert into public.telegram_webhook_updates (bot_id, update_id, owner)
    values (p_bot_id, p_update_id, p_owner)
    on conflict (bot_id, update_id) do nothing;
    if found then
        return 'acquired';
    end if;

    select * into receipt from public.telegram_webhook_updates
    where bot_id = p_bot_id and update_id = p_update_id
    for update;
    if not found then
        -- A previous owner may have released the row while we waited.
        return 'busy';
    end if;

    -- 'sending' is intentionally terminal for automatic retries. Telegram's
    -- sendMessage has no idempotency key; ambiguous deliveries need review.
    if receipt.status in ('sending', 'completed') then
        return 'duplicate';
    end if;
    if receipt.lease_until > now() then
        return 'busy';
    end if;

    update public.telegram_webhook_updates
    set owner = p_owner, lease_until = now() + interval '2 minutes', updated_at = now()
    where bot_id = p_bot_id and update_id = p_update_id;
    return 'acquired';
end;
$$;

create function public.telegram_webhook_begin_send(
    p_bot_id bigint, p_update_id bigint, p_owner uuid
) returns boolean
language plpgsql security invoker strict set search_path = ''
as $$
begin
    update public.telegram_webhook_updates
    set status = 'sending', updated_at = now()
    where bot_id = p_bot_id and update_id = p_update_id
        and owner = p_owner and status = 'claimed';
    return found;
end;
$$;

create function public.telegram_webhook_complete(
    p_bot_id bigint, p_update_id bigint, p_owner uuid
) returns boolean
language plpgsql security invoker strict set search_path = ''
as $$
begin
    update public.telegram_webhook_updates
    set status = 'completed', updated_at = now()
    where bot_id = p_bot_id and update_id = p_update_id
        and owner = p_owner and status = 'sending';
    return found;
end;
$$;

create function public.telegram_webhook_release(
    p_bot_id bigint, p_update_id bigint, p_owner uuid
) returns boolean
language plpgsql security invoker strict set search_path = ''
as $$
begin
    -- Called only before sendMessage, or after a definite Bot API rejection.
    delete from public.telegram_webhook_updates
    where bot_id = p_bot_id and update_id = p_update_id
        and owner = p_owner and status in ('claimed', 'sending');
    return found;
end;
$$;

revoke all on function public.telegram_webhook_claim(bigint, bigint, uuid)
    from public, anon, authenticated;
revoke all on function public.telegram_webhook_begin_send(bigint, bigint, uuid)
    from public, anon, authenticated;
revoke all on function public.telegram_webhook_complete(bigint, bigint, uuid)
    from public, anon, authenticated;
revoke all on function public.telegram_webhook_release(bigint, bigint, uuid)
    from public, anon, authenticated;

grant execute on function public.telegram_webhook_claim(bigint, bigint, uuid) to service_role;
grant execute on function public.telegram_webhook_begin_send(bigint, bigint, uuid) to service_role;
grant execute on function public.telegram_webhook_complete(bigint, bigint, uuid) to service_role;
grant execute on function public.telegram_webhook_release(bigint, bigint, uuid) to service_role;
