-- PostgreSQL-only stand-in for the Storage metadata referenced by migrations.
-- NEVER an application migration; does NOT test the real Storage API/platform.
create schema storage;
create table storage.buckets (
    id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (id bigint, bucket_id text, name text, created_at timestamptz default now());
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
