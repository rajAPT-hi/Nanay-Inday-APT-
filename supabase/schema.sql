create extension if not exists pgcrypto;
create extension if not exists pg_cron;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text not null default '',
  role text not null default 'renter' check (role in ('admin', 'renter')),
  account_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists account_enabled boolean not null default true;

create table if not exists public.renters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  full_name text not null,
  email text,
  phone text not null default '',
  unit_name text not null,
  location text check (location in ('Vasquez', 'Villa', 'Cabalawan', 'Kaskag', 'Cebu')),
  rental_type text not null check (rental_type in ('Room', 'House', 'Apartment')),
  contract_months integer not null check (contract_months in (6, 12)),
  contract_start date not null,
  contract_end date not null,
  rent_amount numeric(12,2) not null check (rent_amount >= 0),
  rent_due_day integer not null default 5 check (rent_due_day between 1 and 31),
  status text not null default 'active' check (status in ('active', 'terminated')),
  terminated_at timestamptz,
  termination_reason text,
  id_image_path text,
  contract_image_path text,
  created_at timestamptz not null default now()
);

create table if not exists public.renter_admin_notes (
  renter_id uuid primary key references public.renters(id) on delete cascade,
  note text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.renters
  add column if not exists status text not null default 'active',
  add column if not exists terminated_at timestamptz,
  add column if not exists termination_reason text,
  add column if not exists id_image_path text,
  add column if not exists contract_image_path text,
  add column if not exists location text,
  add column if not exists rent_due_day integer not null default 5;

alter table public.renters
  alter column email drop not null;

alter table public.renters
  drop constraint if exists renters_location_check,
  drop constraint if exists renters_rent_due_day_check;

alter table public.renters
  add constraint renters_location_check check (location is null or location in ('Vasquez', 'Villa', 'Cabalawan', 'Kaskag', 'Cebu')),
  add constraint renters_rent_due_day_check check (rent_due_day between 1 and 31);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.renters'::regclass
      and conname = 'renters_status_check'
  ) then
    alter table public.renters
      add constraint renters_status_check check (status in ('active', 'terminated'));
  end if;
end;
$$;

create table if not exists public.lease_changes (
  id uuid primary key default gen_random_uuid(),
  renter_id uuid not null references public.renters(id) on delete restrict,
  changed_by uuid not null references auth.users(id),
  action text not null check (action in ('lease_updated', 'lease_terminated')),
  reason text not null check (length(trim(reason)) > 0),
  previous_details jsonb not null,
  new_details jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.lease_renewal_requests (
  id uuid primary key default gen_random_uuid(),
  renter_id uuid not null references public.renters(id) on delete restrict,
  requested_by uuid not null references auth.users(id),
  request_message text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  admin_message text,
  responded_by uuid references auth.users(id),
  responded_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists lease_renewal_requests_one_pending_per_renter
  on public.lease_renewal_requests (renter_id)
  where status = 'pending';

grant select, insert, update, delete on public.lease_renewal_requests to authenticated;

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
  payment_method text check (payment_method in ('cash', 'online')),
  received_by text,
  online_receipt_path text,
  late_fee_amount numeric(12,2) not null default 0 check (late_fee_amount >= 0),
  paid_amount numeric(12,2) not null default 0 check (paid_amount >= 0),
  auto_generated boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.payments
  add column if not exists payment_method text,
  add column if not exists received_by text,
  add column if not exists online_receipt_path text,
  add column if not exists late_fee_amount numeric(12,2) not null default 0,
  add column if not exists paid_amount numeric(12,2) not null default 0,
  add column if not exists auto_generated boolean not null default false;

create unique index if not exists payments_one_auto_rent_charge_per_due_date
  on public.payments (renter_id, due_date)
  where auto_generated;

create table if not exists public.cleared_payment_charges (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null unique,
  renter_id uuid not null,
  period text not null,
  due_date date not null,
  base_amount numeric(12,2) not null,
  utility_amount numeric(12,2) not null,
  amount numeric(12,2) not null,
  status text not null,
  reason text not null,
  cleared_by uuid not null,
  receipt_path text,
  online_receipt_path text,
  cleared_at timestamptz not null default now()
);

alter table public.cleared_payment_charges enable row level security;
revoke all on public.cleared_payment_charges from public, anon, authenticated;
grant select on public.cleared_payment_charges to authenticated;

alter table public.payments
  drop constraint if exists payments_payment_method_check,
  drop constraint if exists payments_late_fee_amount_check,
  drop constraint if exists payments_paid_amount_check;

alter table public.payments
  add constraint payments_payment_method_check check (payment_method is null or payment_method in ('cash', 'online')),
  add constraint payments_late_fee_amount_check check (late_fee_amount >= 0),
  add constraint payments_paid_amount_check check (paid_amount >= 0);

update public.payments
set paid_amount = amount
where status = 'paid' and paid_amount = 0;

create or replace function public.schedule_renter_rent_payments(p_renter_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  renter_row public.renters;
  due_date_value date;
  target_month date;
  schedule_date date := timezone('Asia/Manila', now())::date;
  scheduled_due_dates date[] := array[]::date[];
begin
  select * into renter_row
  from public.renters
  where id = p_renter_id;

  if not found then
    return;
  end if;

  if renter_row.status <> 'active' then
    delete from public.payments
    where renter_id = renter_row.id
      and auto_generated
      and status = 'pending'
      and due_date >= schedule_date;
    return;
  end if;

  target_month := date_trunc('month', schedule_date + interval '1 month')::date;
  due_date_value := target_month + (
    least(
      renter_row.rent_due_day,
      extract(day from (target_month + interval '1 month' - interval '1 day'))::integer
    ) - 1
  );

  if due_date_value >= renter_row.contract_start
    and due_date_value <= renter_row.contract_end then
    scheduled_due_dates := array_append(scheduled_due_dates, due_date_value);

    if not exists (
      select 1
      from public.payments existing_payment
      where existing_payment.renter_id = renter_row.id
        and existing_payment.due_date = due_date_value
        and existing_payment.period not like '%Utilities'
    )
      and not exists (
        select 1
        from public.cleared_payment_charges cleared_charge
        where cleared_charge.renter_id = renter_row.id
          and cleared_charge.due_date = due_date_value
      ) then
      insert into public.payments as scheduled_payment (
        renter_id, period, due_date, base_amount, utility_amount, amount, status, auto_generated
      ) values (
        renter_row.id,
        to_char(due_date_value, 'FMMonth YYYY'),
        due_date_value,
        renter_row.rent_amount,
        0,
        renter_row.rent_amount,
        'pending',
        true
      )
      on conflict (renter_id, due_date) where auto_generated
      do update set
        period = excluded.period,
        base_amount = excluded.base_amount,
        utility_amount = excluded.utility_amount,
        amount = excluded.amount
      where scheduled_payment.status = 'pending';
    end if;
  end if;

  delete from public.payments scheduled_payment
  where scheduled_payment.renter_id = renter_row.id
    and scheduled_payment.auto_generated
    and scheduled_payment.status = 'pending'
    and scheduled_payment.due_date >= schedule_date
    and (
      scheduled_payment.due_date <> all(scheduled_due_dates)
      or exists (
        select 1
        from public.payments manual_payment
        where manual_payment.renter_id = renter_row.id
          and manual_payment.due_date = scheduled_payment.due_date
          and not manual_payment.auto_generated
          and manual_payment.period not like '%Utilities'
      )
    );
end;
$$;

create or replace function public.schedule_monthly_rent_payments()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  renter_row record;
begin
  for renter_row in
    select id from public.renters where status = 'active'
  loop
    perform public.schedule_renter_rent_payments(renter_row.id);
  end loop;
end;
$$;

create or replace function public.sync_renter_rent_payment_schedule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and old.status is not distinct from new.status
    and old.contract_start is not distinct from new.contract_start
    and old.contract_end is not distinct from new.contract_end
    and old.rent_amount is not distinct from new.rent_amount
    and old.rent_due_day is not distinct from new.rent_due_day then
    return new;
  end if;

  perform public.schedule_renter_rent_payments(new.id);
  return new;
end;
$$;

revoke all on function public.schedule_renter_rent_payments(uuid) from public, anon, authenticated;
revoke all on function public.schedule_monthly_rent_payments() from public, anon, authenticated;
revoke all on function public.sync_renter_rent_payment_schedule() from public, anon, authenticated;

select cron.schedule(
  'schedule-monthly-rent-payments',
  '0 16 14 * *',
  'select public.schedule_monthly_rent_payments();'
);

drop trigger if exists schedule_renter_rent_payments on public.renters;
create trigger schedule_renter_rent_payments
  after insert or update on public.renters
  for each row execute function public.sync_renter_rent_payment_schedule();

do $$
begin
  perform public.schedule_monthly_rent_payments();
end;
$$;

create table if not exists public.rent_reminder_emails (
  renter_id uuid not null references public.renters(id) on delete cascade,
  due_date date not null,
  reminder_days integer not null check (reminder_days in (0, 7)),
  status text not null check (status in ('sending', 'sent', 'failed')),
  sent_at timestamptz,
  error_message text,
  primary key (renter_id, due_date, reminder_days)
);

create table if not exists public.rent_reminder_email_deliveries (
  renter_id uuid not null references public.renters(id) on delete cascade,
  due_date date not null,
  reminder_days integer not null check (reminder_days in (0, 7)),
  recipient_email text not null,
  recipient_type text not null check (recipient_type in ('admin', 'renter')),
  status text not null check (status in ('sending', 'sent', 'failed')),
  sent_at timestamptz,
  error_message text,
  updated_at timestamptz not null default now(),
  primary key (renter_id, due_date, reminder_days, recipient_email)
);

alter table public.rent_reminder_email_deliveries
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.utility_bills (
  id uuid primary key default gen_random_uuid(),
  renter_id uuid not null references public.renters(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete set null,
  period text not null,
  water_previous numeric(12,2) check (water_previous >= 0),
  water_current numeric(12,2) check (water_current >= water_previous),
  water_usage numeric(12,2) check (water_usage >= 0),
  electricity_previous numeric(12,2) not null check (electricity_previous >= 0),
  electricity_current numeric(12,2) not null check (electricity_current >= electricity_previous),
  electricity_usage numeric(12,2) not null check (electricity_usage >= 0),
  electricity_total_bill numeric(12,2) not null default 0 check (electricity_total_bill >= 0),
  electricity_total_usage numeric(12,2) not null default 0 check (electricity_total_usage >= 0),
  water_rate numeric(12,2) check (water_rate >= 0),
  electricity_rate numeric(16,8) not null check (electricity_rate >= 0),
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
  alter column electricity_rate type numeric(16,8);

alter table public.utility_bills
  alter column water_previous drop not null,
  alter column water_current drop not null,
  alter column water_usage drop not null,
  alter column water_rate drop not null;

alter table public.utility_bills
  drop constraint if exists utility_bills_electricity_current_check,
  drop constraint if exists utility_bills_electricity_readings_nonnegative;

alter table public.utility_bills
  add constraint utility_bills_electricity_readings_nonnegative
  check (electricity_previous >= 0 and electricity_current >= 0);

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

drop function if exists public.admin_update_lease(uuid, text, text, integer, date, date, numeric, text);
drop function if exists public.admin_update_lease(uuid, text, text, text, integer, date, date, numeric, integer, text);

create function public.admin_update_lease(
  p_renter_id uuid,
  p_unit_name text,
  p_location text,
  p_rental_type text,
  p_contract_months integer,
  p_contract_start date,
  p_contract_end date,
  p_rent_amount numeric,
  p_rent_due_day integer,
  p_reason text
)
returns public.renters
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_renter public.renters;
  updated_renter public.renters;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A reason of at least 3 characters is required.';
  end if;
  if p_unit_name is null or length(trim(p_unit_name)) = 0
    or p_location is null or p_location not in ('Vasquez', 'Villa', 'Cabalawan', 'Kaskag', 'Cebu')
    or p_rental_type is null or p_rental_type not in ('Room', 'House', 'Apartment')
    or p_contract_months is null or p_contract_months not in (6, 12)
    or p_contract_start is null or p_contract_end is null or p_contract_end < p_contract_start
    or p_rent_amount is null or p_rent_amount < 0
    or p_rent_due_day is null or p_rent_due_day not between 1 and 31 then
    raise exception 'Lease details are invalid.';
  end if;

  select * into current_renter
  from public.renters
  where id = p_renter_id
  for update;
  if not found then
    raise exception 'Renter not found.';
  end if;
  if current_renter.status <> 'active' then
    raise exception 'Terminated leases cannot be edited.';
  end if;

  update public.renters
  set unit_name = trim(p_unit_name),
      location = p_location,
      rental_type = p_rental_type,
      contract_months = p_contract_months,
      contract_start = p_contract_start,
      contract_end = p_contract_end,
      rent_amount = p_rent_amount,
      rent_due_day = p_rent_due_day
  where id = p_renter_id
  returning * into updated_renter;

  insert into public.lease_changes (
    renter_id, changed_by, action, reason, previous_details, new_details
  ) values (
    p_renter_id, auth.uid(), 'lease_updated', trim(p_reason),
    jsonb_build_object(
      'unit_name', current_renter.unit_name,
      'location', current_renter.location,
      'rental_type', current_renter.rental_type,
      'contract_months', current_renter.contract_months,
      'contract_start', current_renter.contract_start,
      'contract_end', current_renter.contract_end,
      'rent_amount', current_renter.rent_amount,
      'rent_due_day', current_renter.rent_due_day
    ),
    jsonb_build_object(
      'unit_name', updated_renter.unit_name,
      'location', updated_renter.location,
      'rental_type', updated_renter.rental_type,
      'contract_months', updated_renter.contract_months,
      'contract_start', updated_renter.contract_start,
      'contract_end', updated_renter.contract_end,
      'rent_amount', updated_renter.rent_amount,
      'rent_due_day', updated_renter.rent_due_day
    )
  );
  return updated_renter;
end;
$$;

create or replace function public.admin_terminate_lease(
  p_renter_id uuid,
  p_reason text
)
returns public.renters
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_renter public.renters;
  updated_renter public.renters;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A reason of at least 3 characters is required.';
  end if;

  select * into current_renter
  from public.renters
  where id = p_renter_id
  for update;
  if not found then
    raise exception 'Renter not found.';
  end if;
  if current_renter.status <> 'active' then
    raise exception 'This lease is already terminated.';
  end if;

  update public.renters
  set status = 'terminated',
      terminated_at = now(),
      termination_reason = trim(p_reason)
  where id = p_renter_id
  returning * into updated_renter;

  if current_renter.user_id is not null then
    update public.profiles
    set account_enabled = false
    where id = current_renter.user_id;
  end if;

  insert into public.lease_changes (
    renter_id, changed_by, action, reason, previous_details, new_details
  ) values (
    p_renter_id, auth.uid(), 'lease_terminated', trim(p_reason),
    jsonb_build_object(
      'status', current_renter.status,
      'rent_amount', current_renter.rent_amount,
      'contract_end', current_renter.contract_end
    ),
    jsonb_build_object(
      'status', updated_renter.status,
      'terminated_at', updated_renter.terminated_at,
      'termination_reason', updated_renter.termination_reason
    )
  );
  return updated_renter;
end;
$$;

drop function if exists public.admin_create_utility_bill(uuid, text, date, numeric, numeric, numeric, numeric);

create or replace function public.admin_create_utility_bill(
  p_renter_id uuid,
  p_period text,
  p_due_date date,
  p_water_charge numeric,
  p_electricity_previous numeric,
  p_electricity_current numeric
)
returns public.utility_bills
language plpgsql
security invoker
set search_path = ''
as $$
declare
  renter_status text;
  provider_bill numeric;
  provider_usage numeric;
  electricity_rate_value numeric;
  electricity_usage_value numeric;
  water_charge_value numeric;
  electricity_charge_value numeric;
  total_charge numeric;
  new_payment_id uuid;
  new_utility_bill public.utility_bills;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.';
  end if;
  if p_period is null or length(trim(p_period)) = 0 or p_due_date is null
    or p_water_charge is null or p_water_charge < 0
    or p_electricity_previous is null or p_electricity_current is null
    or p_electricity_previous < 0 or p_electricity_current < 0 then
    raise exception 'Billing period, water amount, or electricity readings are invalid.';
  end if;

  select status into renter_status
  from public.renters
  where id = p_renter_id;
  if not found or renter_status <> 'active' then
    raise exception 'Choose an active renter for this utility bill.';
  end if;

  select (select value #>> '{}' from public.settings where key = 'electricity_total_bill')::numeric,
         (select value #>> '{}' from public.settings where key = 'electricity_total_usage')::numeric
  into provider_bill, provider_usage;
  if provider_bill is null or provider_usage is null or provider_usage <= 0
    or provider_bill <= 0 then
    raise exception 'Save the current provider bill and total kWh before calculating a utility bill.';
  end if;

  electricity_rate_value := round(provider_bill / provider_usage, 8);
  electricity_usage_value := greatest(p_electricity_current, p_electricity_previous)
                              - least(p_electricity_current, p_electricity_previous);
  water_charge_value := round(p_water_charge, 2);
  electricity_charge_value := round(electricity_usage_value * electricity_rate_value, 2);
  total_charge := round(water_charge_value + electricity_charge_value, 2);

  insert into public.payments (
    renter_id, period, due_date, base_amount, utility_amount, amount, status
  ) values (
    p_renter_id, trim(p_period) || ' · Utilities', p_due_date, 0, total_charge, total_charge, 'pending'
  )
  returning id into new_payment_id;

  insert into public.utility_bills (
    renter_id, payment_id, period, water_previous, water_current, water_usage,
    electricity_previous, electricity_current, electricity_usage,
    electricity_total_bill, electricity_total_usage, water_rate, electricity_rate,
    water_charge, electricity_charge, amount
  ) values (
    p_renter_id, new_payment_id, trim(p_period), null, null, null,
    p_electricity_previous, p_electricity_current, electricity_usage_value,
    provider_bill, provider_usage, null, electricity_rate_value,
    water_charge_value, electricity_charge_value, total_charge
  )
  returning * into new_utility_bill;

  return new_utility_bill;
end;
$$;

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

create or replace function public.admin_clear_payment_charge(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment_row public.payments;
  clean_reason text := btrim(p_reason);
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.';
  end if;

  if clean_reason is null or length(clean_reason) < 3 or length(clean_reason) > 1000 then
    raise exception 'Enter a reason between 3 and 1000 characters.';
  end if;

  select * into payment_row
  from public.payments
  where id = p_payment_id
  for update;

  if not found then
    raise exception 'This charge no longer exists.';
  end if;
  if payment_row.status = 'paid' then
    raise exception 'Paid charges cannot be cleared.';
  end if;

  insert into public.cleared_payment_charges (
    payment_id, renter_id, period, due_date, base_amount, utility_amount, amount,
    status, reason, cleared_by, receipt_path, online_receipt_path
  ) values (
    payment_row.id, payment_row.renter_id, payment_row.period, payment_row.due_date,
    payment_row.base_amount, payment_row.utility_amount, payment_row.amount,
    payment_row.status, clean_reason, auth.uid(), payment_row.receipt_path, payment_row.online_receipt_path
  );

  delete from public.payments where id = payment_row.id;

  return jsonb_build_object(
    'receipt_path', payment_row.receipt_path,
    'online_receipt_path', payment_row.online_receipt_path
  );
end;
$$;

revoke all on function public.admin_clear_payment_charge(uuid, text) from public, anon;
grant execute on function public.admin_clear_payment_charge(uuid, text) to authenticated;

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
      or new.payment_method is distinct from old.payment_method
      or new.received_by is distinct from old.received_by
      or new.online_receipt_path is distinct from old.online_receipt_path
      or new.late_fee_amount is distinct from old.late_fee_amount
      or new.paid_amount is distinct from old.paid_amount
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
alter table public.renter_admin_notes enable row level security;
alter table public.lease_changes enable row level security;
alter table public.lease_renewal_requests enable row level security;
alter table public.payments enable row level security;
alter table public.utility_bills enable row level security;
alter table public.settings enable row level security;
alter table public.rent_reminder_emails enable row level security;
alter table public.rent_reminder_email_deliveries enable row level security;

drop policy if exists "Admins read cleared payment charges" on public.cleared_payment_charges;
create policy "Admins read cleared payment charges"
  on public.cleared_payment_charges for select to authenticated
  using ((select public.is_admin()));

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
  using (
    (select public.is_admin())
    or (user_id = (select auth.uid()) and status = 'active')
  );

drop policy if exists "Admins manage renters" on public.renters;
create policy "Admins manage renters"
  on public.renters for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Admins manage renter notes" on public.renter_admin_notes;
create policy "Admins manage renter notes"
  on public.renter_admin_notes for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.renter_admin_notes from anon, authenticated;
grant select, insert, update, delete on public.renter_admin_notes to authenticated, service_role;

drop policy if exists "Admins manage lease change history" on public.lease_changes;
create policy "Admins manage lease change history"
  on public.lease_changes for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Admins manage lease renewal requests" on public.lease_renewal_requests;
create policy "Admins manage lease renewal requests"
  on public.lease_renewal_requests for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Renters read their own lease renewal requests" on public.lease_renewal_requests;
create policy "Renters read their own lease renewal requests"
  on public.lease_renewal_requests for select to authenticated
  using (
    exists (
      select 1 from public.renters r
      join public.profiles pr on pr.id = r.user_id
      where r.id = lease_renewal_requests.renter_id
        and r.user_id = (select auth.uid())
        and r.status = 'active'
        and pr.account_enabled
    )
  );

drop policy if exists "Renters request renewal for their active lease" on public.lease_renewal_requests;
create policy "Renters request renewal for their active lease"
  on public.lease_renewal_requests for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and status = 'pending'
    and admin_message is null
    and responded_by is null
    and responded_at is null
    and exists (
      select 1 from public.renters r
      join public.profiles pr on pr.id = r.user_id
      where r.id = lease_renewal_requests.renter_id
        and r.user_id = (select auth.uid())
        and r.status = 'active'
        and pr.account_enabled
    )
  );

drop policy if exists "Renters read their own payments" on public.payments;
create policy "Renters read their own payments"
  on public.payments for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.renters r
      join public.profiles pr on pr.id = r.user_id
      where r.id = payments.renter_id
        and r.user_id = (select auth.uid())
        and r.status = 'active'
        and pr.account_enabled
    )
  );

drop policy if exists "Admins manage payments" on public.payments;
drop policy if exists "Admins create payments" on public.payments;
drop policy if exists "Admins update payments" on public.payments;
create policy "Admins create payments"
  on public.payments for insert to authenticated
  with check ((select public.is_admin()));

create policy "Admins update payments"
  on public.payments for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Renters submit payment receipts" on public.payments;
create policy "Renters submit payment receipts"
  on public.payments for update to authenticated
  using (
    status <> 'paid' and exists (
      select 1 from public.renters r
      join public.profiles pr on pr.id = r.user_id
      where r.id = payments.renter_id
        and r.user_id = (select auth.uid())
        and r.status = 'active'
        and pr.account_enabled
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
      join public.profiles pr on pr.id = r.user_id
      where r.id = utility_bills.renter_id
        and r.user_id = (select auth.uid())
        and r.status = 'active'
        and pr.account_enabled
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
        and r.status = 'active'
        and exists (
          select 1 from public.profiles pr
          where pr.id = r.user_id and pr.account_enabled
        )
        and p.status <> 'paid'
    )
  );

drop policy if exists "Renter and admin read receipts" on storage.objects;
create policy "Renter and admin read receipts"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'receipts'
    and (
      (
        (storage.foldername(name))[1] = (select auth.uid())::text
        and exists (
          select 1 from public.renters r
          join public.profiles pr on pr.id = r.user_id
          join public.payments p on p.renter_id = r.id
          where r.user_id = (select auth.uid())
            and r.status = 'active'
            and pr.account_enabled
            and p.id::text = (storage.foldername(name))[2]
        )
      )
      or (select public.is_admin())
    )
  );

drop policy if exists "Admins delete uploaded receipts" on storage.objects;
create policy "Admins delete uploaded receipts"
  on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (select public.is_admin()));

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.admin_update_lease(uuid, text, text, text, integer, date, date, numeric, integer, text) from public;
grant execute on function public.admin_update_lease(uuid, text, text, text, integer, date, date, numeric, integer, text) to authenticated;
revoke all on function public.admin_terminate_lease(uuid, text) from public;
grant execute on function public.admin_terminate_lease(uuid, text) to authenticated;
revoke all on function public.admin_create_utility_bill(uuid, text, date, numeric, numeric, numeric) from public;
grant execute on function public.admin_create_utility_bill(uuid, text, date, numeric, numeric, numeric) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('renter-documents', 'renter-documents', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

drop policy if exists "Admins manage online payment proofs" on storage.objects;
create policy "Admins manage online payment proofs"
  on storage.objects for all to authenticated
  using (bucket_id = 'payment-proofs' and (select public.is_admin()))
  with check (bucket_id = 'payment-proofs' and (select public.is_admin()));

drop policy if exists "Admins manage renter documents" on storage.objects;
create policy "Admins manage renter documents"
  on storage.objects for all to authenticated
  using (bucket_id = 'renter-documents' and (select public.is_admin()))
  with check (bucket_id = 'renter-documents' and (select public.is_admin()));
