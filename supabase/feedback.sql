-- Private testing feedback. Browser roles cannot read or write these tables.
create table public.user_feedback (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 user_email text not null,
 request_id uuid not null,
 category text not null check (category in ('suggestion','request','bug')),
 message text not null check (char_length(btrim(message)) between 10 and 5000),
 created_at timestamptz not null default now(),
 email_status text not null default 'pending' check (email_status in ('pending','sent','failed')),
 email_sent_at timestamptz,
 unique(user_id,request_id)
);
create index user_feedback_user_created_idx on public.user_feedback(user_id,created_at desc);
alter table public.user_feedback enable row level security;
revoke all on public.user_feedback from public,anon,authenticated;
grant all on public.user_feedback to service_role;
create table public.feedback_delivery_config (
 id boolean primary key default true check (id),
 recipient text not null
);
alter table public.feedback_delivery_config enable row level security;
revoke all on public.feedback_delivery_config from public,anon,authenticated;
grant select on public.feedback_delivery_config to service_role;
create function public.enforce_feedback_rate_limit() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,7234));
 if exists(select 1 from public.user_feedback where user_id=new.user_id and request_id=new.request_id) then return new; end if;
 if (select count(*) from public.user_feedback where user_id=new.user_id and created_at > now()-interval '10 minutes') >= 3 then
  raise exception 'feedback_rate_limited';
 end if;
 return new;
end;
$$;
revoke all on function public.enforce_feedback_rate_limit() from public,anon,authenticated;
grant execute on function public.enforce_feedback_rate_limit() to service_role;
create trigger feedback_rate_limit before insert on public.user_feedback
for each row execute function public.enforce_feedback_rate_limit();
