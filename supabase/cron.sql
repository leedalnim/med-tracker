-- 복약 알림 발송 스케줄 — 1분마다 med-push 함수를 깨운다.
-- ※ 아래 <크론_비밀문자열> 을 Edge Function Secrets의 MED_CRON_SECRET 과 같은 값으로 바꾼 뒤 실행하세요.
--    (이 파일은 공개 저장소에 올라가므로 실제 값을 적어두지 마세요.)

-- 확장 켜기 — Dashboard > Database > Extensions 에서 켜도 됩니다
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 이미 등록돼 있으면 지우고 다시 (중복 등록 방지)
select cron.unschedule('med-push-every-minute')
where exists (select 1 from cron.job where jobname = 'med-push-every-minute');

select cron.schedule(
  'med-push-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://wjqjebemglkitgrekzzz.supabase.co/functions/v1/med-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-med-cron', '<크론_비밀문자열>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- 확인
-- select jobname, schedule, active from cron.job;
-- select * from cron.job_run_details order by start_time desc limit 10;

-- 끄고 싶을 때
-- select cron.unschedule('med-push-every-minute');
