-- 복약 알림(Web Push) — Supabase SQL 편집기에 그대로 붙여넣고 Run
--
-- 안전 원칙
--  * 기존 med_backup 테이블은 건드리지 않는다. 여기서 만드는 건 전부 새 테이블이다.
--  * 두 테이블 모두 RLS를 켜고 정책을 하나도 만들지 않는다 → 공개 키로는 직접 못 읽는다.
--  * 접근은 아래 SECURITY DEFINER 함수로만 하고, 복구 코드(uuid)를 아는 경우로 제한한다.

-- ===== 1. 푸시 구독 (기기 하나당 한 줄) =====
create table if not exists public.med_push (
  endpoint   text primary key,
  key        uuid not null,
  p256dh     text not null,
  auth       text not null,
  updated_at timestamptz not null default now()
);
create index if not exists med_push_key_idx on public.med_push (key);

alter table public.med_push enable row level security;
revoke all on public.med_push from anon, authenticated;

-- ===== 2. 예약된 알림 (약 하나당 한 줄) =====
create table if not exists public.med_alarm (
  key     uuid not null,
  med_id  text not null,
  title   text not null,
  body    text not null,
  due_at  timestamptz not null,
  sent_at timestamptz,
  primary key (key, med_id)
);
create index if not exists med_alarm_due_idx on public.med_alarm (due_at) where sent_at is null;

alter table public.med_alarm enable row level security;
revoke all on public.med_alarm from anon, authenticated;

-- ===== 3. 구독 등록 =====
create or replace function public.med_push_sub(
  p_key uuid, p_endpoint text, p_p256dh text, p_auth text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_key is null or p_endpoint is null or p_p256dh is null or p_auth is null then
    raise exception '잘못된 요청';
  end if;
  if length(p_endpoint) > 1000 or length(p_p256dh) > 200 or length(p_auth) > 100 then
    raise exception '잘못된 요청';
  end if;

  insert into med_push (endpoint, key, p256dh, auth, updated_at)
  values (p_endpoint, p_key, p_p256dh, p_auth, now())
  on conflict (endpoint) do update
    set key = excluded.key, p256dh = excluded.p256dh,
        auth = excluded.auth, updated_at = now();

  -- 코드 하나당 기기 5대까지만 유지 (오래된 것부터 정리)
  delete from med_push
  where key = p_key
    and endpoint not in (
      select endpoint from med_push where key = p_key order by updated_at desc limit 5
    );
end $$;

-- ===== 4. 구독 해지 =====
create or replace function public.med_push_unsub(p_key uuid, p_endpoint text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_key is null or p_endpoint is null then raise exception '잘못된 요청'; end if;
  delete from med_push where key = p_key and endpoint = p_endpoint;
end $$;

-- ===== 5. 예약 목록 통째로 맞추기 =====
-- 앱이 계산한 '다음 복용 시각'들을 그대로 반영한다. 빈 배열을 주면 전부 해제된다.
create or replace function public.med_alarm_sync(p_key uuid, p_alarms jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_key is null then raise exception '잘못된 요청'; end if;
  if p_alarms is null or jsonb_typeof(p_alarms) <> 'array' then raise exception '잘못된 요청'; end if;
  if jsonb_array_length(p_alarms) > 30 then raise exception '알림이 너무 많아요'; end if;

  delete from med_alarm where key = p_key;

  insert into med_alarm (key, med_id, title, body, due_at)
  select p_key,
         left(a ->> 'med_id', 64),
         left(a ->> 'title', 80),
         left(a ->> 'body', 120),
         (a ->> 'due_at')::timestamptz
  from jsonb_array_elements(p_alarms) a
  where a ->> 'med_id' is not null
    and a ->> 'title' is not null
    and (a ->> 'due_at')::timestamptz > now()
    and (a ->> 'due_at')::timestamptz < now() + interval '60 days'
  on conflict (key, med_id) do nothing;

  get diagnostics n = row_count;
  return n;
end $$;

-- ===== 6. 공개 키로 호출할 수 있는 건 위 함수뿐 =====
revoke all on function public.med_push_sub(uuid, text, text, text) from public;
revoke all on function public.med_push_unsub(uuid, text) from public;
revoke all on function public.med_alarm_sync(uuid, jsonb) from public;

grant execute on function public.med_push_sub(uuid, text, text, text) to anon;
grant execute on function public.med_push_unsub(uuid, text) to anon;
grant execute on function public.med_alarm_sync(uuid, jsonb) to anon;
