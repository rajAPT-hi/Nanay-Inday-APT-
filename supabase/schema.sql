create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text not null default '',
  role text not null default 'renter' check (role in ('admin', 'renter')),
  created_at timestamptz not null default now()
);

create table if not exists public.renters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  full_name text not null,
  email text not null,
  phone text not null default '',
  unit_name text not null,
  rental_type text not null check (rental_type in ('Room', 'House', 'Apartment')),
  contract_months integer not null check (contract_months in (6, 12)),
  contract_start date not null,
  contract_end date not null,
  rent_amount numeric(12,2) not null check (rent_amount >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  renter_id uuid not null references public.renters(id) on delete cascade,
  period text not null,
  due_date date not null,
  base_amount numeric(12,2) not null default 0 check (base_amount >= 0),
  utility_amount numeric(12,2) not null default 0 check (utility_amount >= 0),
  amount numeric(12,2) not null check (amount >= 0),
  status text not null default 'pending' check (status in ('pending', 'review', 'paid')),
  receipt_path text,
  paid_at date,
  created_at timestamptz not null default now()
);

create table if not exists public.utility_bills (
  id uuid primary key default gen_random_uuid(),
  renter_id uuid not null references public.renters(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete set null,
  period text not null,
  water_previous numeric(12,2) not null check (water_previous >= 0),
  water_current numeric(12,2) not null check (water_current >= water_previous),
  water_usage numeric(12,2) not null check (water_usage >= 0),
  electricity_previous numeric(12,2) not null check (electricity_previous >= 0),
  electricity_current numeric(12,2) not null check (electricity_current >= electricity_previous),
  electricity_usage numeric(12,2) not null check (electricity_usage >= 0),
  electricity_total_bill numeric(12,2) not null default 0 check (electricity_total_bill >= 0),
  electricity_total_usage numeric(12,2) not null default 0 check (electricity_total_usage >= 0),
  water_rate numeric(12,2) not null check (water_rate >= 0),
  electricity_rate numeric(12,4) not null check (electricity_rate >= 0),
  water_charge numeric(12,2) not null default 0 check (water_charge >= 0),
  electricity_charge numeric(12,2) not null default 0 check (electricity_charge >= 0),
  amount numeric(12,2) not null check (amount >= 0),
  created_at timestamptz not null default now()
);

alter table public.utility_bills
  add column if not exists electricity_total_bill numeric(12,2) not null default 0 check (electricity_total_bill >= 0),
  add column if not exists electricity_total_usage numeric(12,2) not null default 0 check (electricity_total_usage >= 0),
  add column if not exists water_charge numeric(12,2) not null default 0 check (water_charge >= 0),
  add column if not exists electricity_charge numeric(12,2) not null default 0 check (electricity_charge >= 0);

alter table public.utility_bills
  alter column electricity_rate type numeric(12,4);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null
);

insert into public.settings (key, value) values
  ('water_rate', '45'::jsonb),
  ('electricity_rate', '13'::jsonb),
  ('electricity_total_bill', '0'::jsonb),
  ('electricity_total_usage', '0'::jsonb),
  ('late_fee_per_day', '50'::jsonb),
  ('grace_period_days', '3'::jsonb)
on conflict (key) do nothing;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    'renter'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;

create or replace function public.guard_renter_payment_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if not exists (
      select 1 from public.renters r
      where r.id = old.renter_id and r.user_id = auth.uid()
    ) or old.status = 'paid'
      or new.renter_id is distinct from old.renter_id
      or new.period is distinct from old.period
      or new.due_date is distinct from old.due_date
      or new.base_amount is distinct from old.base_amount
      or new.utility_amount is distinct from old.utility_amount
      or new.amount is distinct from old.amount
      or new.paid_at is distinct from old.paid_at
      or new.status is distinct from 'review'
      or new.receipt_path is null then
      raise exception 'Renter accounts may only submit a receipt for an unpaid payment.';
    end if;
    if split_part(new.receipt_path, '/', 1) <> auth.uid()::text
      or split_part(new.receipt_path, '/', 2) <> old.id::text then
      raise exception 'Receipt path does not match this renter and payment.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_renter_payment_update on public.payments;
create trigger guard_renter_payment_update
  before update on public.payments
  for each row execute function public.guard_renter_payment_update();

alter table public.profiles enable row level security;
alter table public.renters enable row level security;
alter table public.payments enable row level security;
alter table public.utility_bills enable row level security;
alter table public.settings enable row level security;

drop policy if exists "Profiles are visible to their owner and admins" on public.profiles;
create policy "Profiles are visible to their owner and admins"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "Admins manage profiles" on public.profiles;
create policy "Admins manage profiles"
  on public.profiles for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Renters can read their own profile record" on public.renters;
create policy "Renters can read their own profile record"
  on public.renters for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "Admins manage renters" on public.renters;
create policy "Admins manage renters"
  on public.renters for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Renters read their own payments" on public.payments;
create policy "Renters read their own payments"
  on public.payments for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.renters r
      where r.id = payments.renter_id and r.user_id = (select auth.uid())
    )
  );

drop policy if exists "Admins manage payments" on public.payments;
create policy "Admins manage payments"
  on public.payments for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Renters submit payment receipts" on public.payments;
create policy "Renters submit payment receipts"
  on public.payments for update to authenticated
  using (
    status <> 'paid' and exists (
      select 1 from public.renters r
      where r.id = payments.renter_id and r.user_id = (select auth.uid())
    )
  )
  with check (
    status = 'review' and exists (
      select 1 from public.renters r
      where r.id = payments.renter_id and r.user_id = (select auth.uid())
    )
  );

drop policy if exists "Renters read their utility bills" on public.utility_bills;
create policy "Renters read their utility bills"
  on public.utility_bills for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.renters r
      where r.id = utility_bills.renter_id and r.user_id = (select auth.uid())
    )
  );

drop policy if exists "Admins manage utility bills" on public.utility_bills;
create policy "Admins manage utility bills"
  on public.utility_bills for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Admins manage settings" on public.settings;
create policy "Admins manage settings"
  on public.settings for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Authenticated users can read rates" on public.settings;
create policy "Authenticated users can read rates"
  on public.settings for select to authenticated
  using (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

drop policy if exists "Renter uploads their own receipt" on storage.objects;
create policy "Renter uploads their own receipt"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.renters r
      join public.payments p on p.renter_id = r.id
      where r.user_id = (select auth.uid())
        and p.id::text = (storage.foldername(name))[2]
        and p.status <> 'paid'
    )
  );

drop policy if exists "Renter and admin read receipts" on storage.objects;
create policy "Renter and admin read receipts"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'receipts'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (select public.is_admin())
    )
  );

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;
