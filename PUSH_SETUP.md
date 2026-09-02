# 복약 알림 켜기 — 설치 순서

앱 코드는 이미 다 올라가 있어요. 남은 건 **Supabase 쪽 설정 4가지**예요.
전부 대시보드에서 붙여넣기로 끝나고, **기존 데이터(med_backup)는 하나도 건드리지 않아요.**

> 비밀값(VAPID 비밀키, 크론 비밀문자열)은 이 저장소가 공개라서 여기에 적지 않았어요.
> 대화창에 알려드린 값을 쓰세요.

---

## 1. 표 만들기 (SQL Editor)

`supabase/alarm.sql` 내용을 통째로 붙여넣고 **Run**.

새로 생기는 것: `med_push`(기기 구독), `med_alarm`(예약된 알림), 그리고 함수 3개.
두 표 모두 RLS를 켜고 정책을 안 만들어서, 공개 키로는 직접 못 읽어요 — 기존 백업 표와 같은 방식이에요.

---

## 2. 알림 발송 함수 올리기 (Edge Functions)

**Edge Functions > Deploy a new function**

- 이름: `med-push`
- 코드: `supabase/functions/med-push/index.ts` 내용 붙여넣기
- **Enforce JWT verification 끄기** ← 이거 꼭. 대신 아래 `MED_CRON_SECRET`으로 막아요.

---

## 3. 비밀값 넣기 (Edge Functions > Secrets)

| 이름 | 값 |
|---|---|
| `VAPID_PUBLIC_KEY` | `BLcQAxK9b6qvp3Pb4iloYxB06MzbH_QZ1tMXYueFVa6jVWzu9EapPWolmCOm8wzWwlprJPgJN0VTOD2DUwLHnB0` |
| `VAPID_PRIVATE_KEY` | 대화창에 알려드린 비밀키 |
| `VAPID_SUBJECT` | `mailto:본인메일주소` |
| `MED_CRON_SECRET` | 대화창에 알려드린 크론 비밀문자열 |

`SUPABASE_URL`과 `SUPABASE_SERVICE_ROLE_KEY`는 Supabase가 알아서 넣어주니 안 적어도 돼요.

> 공개키는 앱(`app.js`)에 들어있는 값과 **반드시 같아야** 해요. 다르면 알림이 안 옵니다.

---

## 4. 1분마다 깨우기 (SQL Editor)

`supabase/cron.sql`을 열어 `<크론_비밀문자열>`을 3번에서 넣은 값으로 바꾼 뒤 붙여넣고 **Run**.

확인:

```sql
select jobname, schedule, active from cron.job;
select status, start_time from cron.job_run_details order by start_time desc limit 5;
```

---

## 5. 폰에서 켜기

1. 홈 화면 아이콘으로 앱 열기 (**사파리 탭에서는 안 돼요** — iOS 제한)
2. 설정 > 버전이 **v101** 이상인지 확인 (아니면 앱을 닫았다 다시 열기)
3. **복약 알림 > 알림 받기** 켜기 → 아이폰이 권한을 물어보면 **허용**
4. 알림 받을 약을 각각 켜기

약 이름 밑에 `내일 21시 30분 알림`처럼 예정 시각이 뜨면 정상이에요.

---

## 바로 테스트해보고 싶다면

간격이 짧은 약을 하나 만들어서 확인하는 게 제일 빨라요.

1. 홈에서 약 추가 → 최소 간격 **1시간**짜리로 저장
2. 먹었어요 누르기 → 설정에서 그 약 알림 켜기
3. SQL Editor에서 예정 시각을 1분 뒤로 당기기

```sql
update med_alarm set due_at = now() + interval '1 minute', sent_at = null
where key = '내_복구_코드';
```

4. 1~2분 안에 알림이 오면 성공

> 주의: 앱을 다시 열면 앱이 계산한 원래 시각으로 되돌려 놔요. 테스트 중엔 앱을 닫아두세요.

---

## 안 올 때 확인 순서

| 증상 | 볼 곳 |
|---|---|
| 알림 켜기가 안 눌림 | 홈 화면 아이콘으로 열었는지 |
| 켰는데 권한 거부됨 | iOS 설정 > 알림 > 복약 트래커 |
| 예약은 잡혔는데 안 옴 | `select * from med_alarm;` — `sent_at`이 찍히는지 |
| `sent_at`도 안 찍힘 | `cron.job_run_details`에서 실행 여부 |
| 실행은 되는데 실패 | Edge Functions > med-push > Logs |
| 로그에 403 | `MED_CRON_SECRET`과 cron.sql의 값이 다름 |

---

## 알아둘 것

- 알림 시각은 **마지막 복용 + 간격**이에요. 한 번도 안 먹은 약은 기준이 없어서 알림이 안 가요.
- cron이 1분 단위라 **최대 1분쯤 늦게** 올 수 있어요.
- 알림 설정은 **폰마다 따로**예요 (백업에 안 들어감). 폰을 바꾸면 새 폰에서 다시 켜면 돼요.
- 알림이 안 되더라도 **앱 본체와 기록은 아무 영향 없어요.**
