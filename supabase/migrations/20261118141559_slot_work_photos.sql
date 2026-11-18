-- Prepared only. Apply explicitly after review.
begin;
create table public.slot_photos (
 photo_id uuid primary key,
 slot_id bigint references public.slots(slot_id) on delete set null,
 master_id bigint not null,
 position smallint not null check (position between 0 and 2),
 object_path text not null unique,
 state text not null default 'pending' check (state in ('pending','ready','deleting')),
 last_cleanup_at timestamptz,
 created_at timestamptz not null default clock_timestamp()
);
create unique index slot_photos_position on public.slot_photos(slot_id,position) where state in ('pending','ready');
alter table public.slot_photos enable row level security;
revoke all on public.slot_photos from public,anon,authenticated;
grant select,insert,update,delete on public.slot_photos to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('slot-photos','slot-photos',false,2097152,array['image/jpeg']);
create policy slot_photos_no_client_insert on storage.objects as restrictive for insert to anon,authenticated with check (bucket_id <> 'slot-photos');
create policy slot_photos_no_client_update on storage.objects as restrictive for update to anon,authenticated using (bucket_id <> 'slot-photos') with check (bucket_id <> 'slot-photos');
create policy slot_photos_no_client_delete on storage.objects as restrictive for delete to anon,authenticated using (bucket_id <> 'slot-photos');
create policy slot_photos_no_client_read on storage.objects as restrictive for select to anon,authenticated using (bucket_id <> 'slot-photos');

create function public.slot_photos_access(p_actor bigint,p_slot bigint) returns boolean
language sql stable security invoker set search_path = '' as $$
select exists(select 1 from public.slots s where s.slot_id=p_slot and (
 s.master_id=p_actor or exists(select 1 from public.bookings b where b.slot_id=s.slot_id and b.user_id=p_actor)
 or (s.status='Свободен' and s.date_time>now()
 and exists(select 1 from public.users u where u.user_id=p_actor)
 and not exists(select 1 from public.bookings b where b.slot_id=s.slot_id and b.user_id=p_actor
 and b.status='Отменена мастером' and b.reason='model'))));
$$;
create function public.slot_photos_list(p_actor bigint,p_slot bigint) returns setof public.slot_photos
language plpgsql security invoker set search_path = '' as $$
begin
 if not public.slot_photos_access(p_actor,p_slot) then raise exception using errcode='PT404',message='PHOTO_NOT_FOUND'; end if;
 return query select * from public.slot_photos where slot_id=p_slot and (state='ready' or (master_id=p_actor and state='pending')) order by position;
end; $$;
create function public.slot_photos_write(p_actor bigint,p_slot bigint,p_photo uuid,p_action text)
returns public.slot_photos language plpgsql security invoker set search_path = '' as $$
declare s public.slots%rowtype; r public.slot_photos%rowtype; pos smallint;
begin
 select * into s from public.slots where slot_id=p_slot for update;
 if not found or s.master_id is distinct from p_actor then raise exception using errcode='PT404',message='PHOTO_NOT_FOUND'; end if;
 if p_action='reserve' then
  select * into r from public.slot_photos where photo_id=p_photo;
  if found then
   if r.slot_id=p_slot and r.master_id=p_actor and r.state in ('pending','ready') then return r; end if;
   raise exception using errcode='PT409',message='PHOTO_CONFLICT';
  end if;
  select n into pos from generate_series(0,2) n where not exists(
   select 1 from public.slot_photos p where p.slot_id=p_slot and p.position=n and state in ('pending','ready')) order by n limit 1;
  if pos is null then raise exception using errcode='PT409',message='PHOTO_LIMIT'; end if;
  insert into public.slot_photos(photo_id,slot_id,master_id,position,object_path)
  values(p_photo,p_slot,p_actor,pos,p_actor::text||'/'||p_slot::text||'/'||p_photo::text||'.jpg') returning * into r;
 elsif p_action='finish' then
  update public.slot_photos set state='ready' where photo_id=p_photo and slot_id=p_slot and master_id=p_actor and state in ('pending','ready') returning * into r;
 elsif p_action='delete' then
  update public.slot_photos set state='deleting' where photo_id=p_photo and slot_id=p_slot and master_id=p_actor returning * into r;
 else raise exception using errcode='PT422',message='INVALID_REQUEST'; end if;
 if r.photo_id is null then raise exception using errcode='PT404',message='PHOTO_NOT_FOUND'; end if;
 return r;
end; $$;
-- Mark first, remove through Storage API afterwards. Tombstones retain late-upload cleanup paths.
create function public.slot_photos_cleanup() returns setof public.slot_photos
language sql security invoker set search_path = '' as $$
 update public.slot_photos set state='deleting'
 where photo_id in (select photo_id from public.slot_photos
 where (slot_id is null or state='deleting' or (state='pending' and created_at < now()-interval '24 hours'))
 and (last_cleanup_at is null or last_cleanup_at < now()-interval '24 hours')
 order by last_cleanup_at nulls first,created_at limit 500) returning *;
$$;
revoke all on function public.slot_photos_access(bigint,bigint),public.slot_photos_list(bigint,bigint),public.slot_photos_write(bigint,bigint,uuid,text),public.slot_photos_cleanup() from public,anon,authenticated;
grant execute on function public.slot_photos_access(bigint,bigint),public.slot_photos_list(bigint,bigint),public.slot_photos_write(bigint,bigint,uuid,text),public.slot_photos_cleanup() to service_role;
commit;
