-- BB-73 production audit 2026-11-13 confirmed these four validated CASCADE FKs.
-- Preparation only. Apply after reviewed BB-01/API dependencies, in a closed
-- window after a verified backup. No rows or Storage objects are changed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table public.users, public.masters, public.services, public.slots,
    public.bookings in access exclusive mode;

do $bb73$
declare
    expected record;
    actual pg_constraint%rowtype;
begin
    for expected in select * from (values
        ('slots', 'slots_master_id_fkey', 'master_id', 'masters', 'master_id'),
        ('slots', 'slots_service_id_fkey', 'service_id', 'services', 'service_id'),
        ('bookings', 'bookings_user_id_fkey', 'user_id', 'users', 'user_id'),
        ('bookings', 'bookings_slot_id_fkey', 'slot_id', 'slots', 'slot_id')
    ) as f(child, name, child_column, parent, parent_column)
    loop
        select * into actual from pg_constraint
        where conrelid = format('public.%I', expected.child)::regclass
          and conname = expected.name;
        if not found or actual.contype <> 'f' or not actual.convalidated
           or actual.condeferrable or actual.condeferred
           or actual.confrelid <> format('public.%I', expected.parent)::regclass
           or actual.confdeltype not in ('c', 'r') or actual.confupdtype <> 'a'
           or actual.confmatchtype <> 's'
           or actual.conkey <> array[(select attnum from pg_attribute
               where attrelid=actual.conrelid and attname=expected.child_column)]
           or actual.confkey <> array[(select attnum from pg_attribute
               where attrelid=actual.confrelid and attname=expected.parent_column)] then
            raise exception 'BB-73: FK drift on %.%, review required', expected.child, expected.name;
        end if;
        if actual.confdeltype = 'c' then
            execute format('alter table public.%I drop constraint %I, add constraint %I foreign key (%I) references public.%I (%I) on delete restrict',
                expected.child, expected.name, expected.name, expected.child_column,
                expected.parent, expected.parent_column);
        end if;
    end loop;
end;
$bb73$;

-- Required application CRUD is retained. TRUNCATE is not an application API.
revoke truncate on public.users, public.masters, public.services, public.slots,
    public.bookings from service_role;
commit;
