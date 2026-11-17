-- BB-03: preparation only. Do not apply to production without separate approval.
-- Public avatar URLs remain readable. Existing objects and profile rows are
-- neither rewritten nor deleted. Only this bucket's future uploads are limited.
--
-- Until BB-05 provides a trusted server upload endpoint, browser uploads MUST
-- fail, including uploads to the caller's purported own directory. A browser
-- masterId, Telegram initDataUnsafe, object owner_id, or Supabase auth.uid() is
-- not a verified Telegram master identity in the current application.
--
-- BB-05 must validate Telegram initData signature and freshness, derive the
-- master ID from the verified user, authorize that master's profile, and build
-- the object path on the server. Only then may it use a server-held service key
-- through the Storage API and update that master's avatar_url. Never expose the
-- key to the browser or add client write policies to restore the old uploader.
-- service_role/BYPASSRLS bypasses these policies: ownership is the SERVER's job.
-- The server must also decode/validate image bytes (not trust a supplied MIME
-- type or filename), enforce the byte limit, and reject unsupported content.
-- Bucket MIME restrictions alone are not an image-content security check.
-- Previously issued signed upload URLs are bearer capabilities and are not
-- revoked by changing RLS. Before treating a later rollout as fully closed,
-- account for outstanding upload tokens and their expiry (normally 2 hours).

begin;

-- Abort atomically on an unexpected setup rather than silently leave it open.
do $bb03$
begin
    -- Lock the bucket so its public state cannot change between the check
    -- and the limits update in this transaction.
    perform 1 from storage.buckets where id = 'master-avatars' for update;
    if not found then
        raise exception 'BB-03: master-avatars bucket must already exist';
    end if;

    if not exists (
        select 1 from storage.buckets
        where id = 'master-avatars' and public is true
    ) then
        raise exception 'BB-03: master-avatars bucket must already be public';
    end if;

    if not exists (
        select 1
        from pg_catalog.pg_class as c
        join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
        where n.nspname = 'storage'
          and c.relname = 'objects'
          and c.relrowsecurity
    ) then
        raise exception 'BB-03: storage.objects RLS must be enabled';
    end if;
end;
$bb03$;

-- Exact MIME allowlist: excludes SVG, HTML, GIF and image/* wildcards.
-- 5 MiB = 5,242,880 bytes. The project-wide limit can impose a lower ceiling.
-- These Storage API settings do not inspect or alter existing objects.
update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']::text[]
where id = 'master-avatars';

drop policy if exists "master avatars upload" on storage.objects;
drop policy if exists "master avatars update" on storage.objects;

-- Restrictive policies are ANDed with any applicable permissive policy.
-- They grant no access, including to other buckets. TO PUBLIC covers anon,
-- authenticated and any other ordinary role without trusting client claims.
drop policy if exists "bb03 master avatars deny client insert" on storage.objects;
create policy "bb03 master avatars deny client insert"
on storage.objects
as restrictive
for insert
to public
with check (bucket_id is distinct from 'master-avatars');

-- Check both old and new rows: blocks overwrites, renames and moves both into
-- and out of the bucket, even if a broad permissive UPDATE/ALL policy exists.
drop policy if exists "bb03 master avatars deny client update" on storage.objects;
create policy "bb03 master avatars deny client update"
on storage.objects
as restrictive
for update
to public
using (bucket_id is distinct from 'master-avatars')
with check (bucket_id is distinct from 'master-avatars');

drop policy if exists "bb03 master avatars deny client delete" on storage.objects;
create policy "bb03 master avatars deny client delete"
on storage.objects
as restrictive
for delete
to public
using (bucket_id is distinct from 'master-avatars');

-- Keep the existing SELECT policy and public bucket; public URL delivery does
-- not require write access. No INSERT/UPDATE/DELETE allow policy is introduced.
-- This migration does not secure public.masters.avatar_url: table authorization
-- remains a separate dependency (BB-01/BB-05), outside this Storage-only change.

commit;
