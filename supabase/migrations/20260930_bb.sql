alter table public.masters
    add column if not exists address text,
    add column if not exists avatar_url text;

alter table public.slots
    add column if not exists city text,
    add column if not exists address text,
    add column if not exists description text;

alter table public.bookings
    add column if not exists reason text;

create unique index if not exists bookings_one_live_booking_per_slot
    on public.bookings (slot_id)
    where status in ('Ожидает подтверждения мастера', 'Активна');

create unique index if not exists slots_one_live_time_per_master
    on public.slots (master_id, date_time)
    where status in ('Свободен', 'Ожидает подтверждения', 'Занят');

create index if not exists slots_city_idx
    on public.slots (city);

create index if not exists bookings_user_idx
    on public.bookings (user_id);

create index if not exists slots_master_date_idx
    on public.slots (master_id, date_time);

insert into storage.buckets (id, name, public)
values ('master-avatars', 'master-avatars', true)
on conflict (id) do update set public = true;

drop policy if exists "master avatars public read" on storage.objects;
create policy "master avatars public read"
on storage.objects
for select
to public
using (bucket_id = 'master-avatars');

drop policy if exists "master avatars upload" on storage.objects;
create policy "master avatars upload"
on storage.objects
for insert
to public
with check (bucket_id = 'master-avatars');

drop policy if exists "master avatars update" on storage.objects;
create policy "master avatars update"
on storage.objects
for update
to public
using (bucket_id = 'master-avatars')
with check (bucket_id = 'master-avatars');
