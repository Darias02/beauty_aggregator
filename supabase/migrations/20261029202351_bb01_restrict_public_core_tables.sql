-- BB-01: staged containment, NOT applied to production.
-- Intentionally closes reads too, including services, until a reviewed catalog
-- projection is available. No public mutation or ownership policy is introduced.
-- Run as the table owner in ONE transaction, only after deployment approval.
-- Existing service_role/owner ACLs are retained; no FORCE ROW LEVEL SECURITY.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

lock table public.users, public.masters, public.services, public.slots,
    public.bookings in access exclusive mode;

-- Fail closed on policy/role drift instead of silently overriding new security
-- decisions. Review views/RPCs and service credentials again before applying.
do $bb01$
declare
    target oid;
    column_list text;
    seq record;
    client_role text;
begin
    if exists (
        select 1 from pg_roles
        where rolname in ('anon', 'authenticated')
          and (rolsuper or rolbypassrls)
    ) or exists (
        select 1 from pg_auth_members m
        join pg_roles r on r.oid = m.member
        where r.rolname in ('anon', 'authenticated')
    ) then
        raise exception 'BB-01: unexpected public role attributes/membership; review required';
    end if;

    if not exists (
        select 1 from pg_roles where rolname = 'service_role' and rolbypassrls
    ) then
        raise exception 'BB-01: service_role must retain BYPASSRLS';
    end if;

    foreach target in array array[
        'public.users'::regclass::oid, 'public.masters'::regclass::oid,
        'public.services'::regclass::oid, 'public.slots'::regclass::oid,
        'public.bookings'::regclass::oid
    ] loop
        if exists (select 1 from pg_policy where polrelid = target) then
            raise exception 'BB-01: policies exist on %, review required', target::regclass;
        end if;

        execute format('alter table %s enable row level security', target::regclass);
        execute format(
            'revoke all privileges on table %s from public, anon, authenticated',
            target::regclass
        );

        -- Table-level REVOKE alone does not remove independent column grants.
        select string_agg(quote_ident(attname), ', ' order by attnum)
        into column_list from pg_attribute
        where attrelid = target and attnum > 0 and not attisdropped;
        execute format(
            'revoke all privileges (%s) on table %s from public, anon, authenticated',
            column_list, target::regclass
        );

        -- Cover SERIAL and IDENTITY sequences owned by these tables only.
        for seq in
            select distinct s.oid
            from pg_depend d
            join pg_class s on s.oid = d.objid and s.relkind = 'S'
            where d.classid = 'pg_class'::regclass
              and d.refclassid = 'pg_class'::regclass
              and d.refobjid = target and d.deptype in ('a', 'i')
        loop
            execute format(
                'revoke all privileges on sequence %s from public, anon, authenticated',
                seq.oid::regclass
            );
            foreach client_role in array array['anon', 'authenticated'] loop
                if has_sequence_privilege(client_role, seq.oid, 'SELECT, USAGE, UPDATE') then
                    raise exception 'BB-01: residual sequence access for %', client_role;
                end if;
            end loop;
            if not has_sequence_privilege('service_role', seq.oid, 'USAGE') then
                raise exception 'BB-01: service_role sequence usage missing on %', seq.oid::regclass;
            end if;
        end loop;

        foreach client_role in array array['anon', 'authenticated'] loop
            if has_table_privilege(client_role, target,
                'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                or has_any_column_privilege(client_role, target,
                    'SELECT, INSERT, UPDATE, REFERENCES') then
                raise exception 'BB-01: residual table/column access for % on %',
                    client_role, target::regclass;
            end if;
        end loop;

        -- BYPASSRLS does not bypass SQL grants. Never commit a partial lockout
        -- that removed server CRUD through a formerly PUBLIC-only grant.
        if not (
            has_table_privilege('service_role', target, 'SELECT')
            and has_table_privilege('service_role', target, 'INSERT')
            and has_table_privilege('service_role', target, 'UPDATE')
            and has_table_privilege('service_role', target, 'DELETE')
        ) then
            raise exception 'BB-01: service_role CRUD missing on %', target::regclass;
        end if;
    end loop;
end;
$bb01$;

commit;
