// 복약 알림 발송 — 1분마다 cron이 호출한다.
// 보낼 때가 된 예약을 찾아 해당 기기로 Web Push를 보내고, 보낸 표시를 남긴다.
//
// 필요한 환경변수 (Edge Functions > Secrets)
//   VAPID_PUBLIC_KEY   앱에 들어있는 공개키와 같은 값
//   VAPID_PRIVATE_KEY  비밀키 — 절대 저장소에 올리지 말 것
//   VAPID_SUBJECT      mailto:내메일 또는 앱 주소
//   MED_CRON_SECRET    cron만 호출할 수 있게 하는 임의의 문자열
//
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동으로 넣어준다.

import webpush from 'npm:web-push@3.6.7';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'https://leedalnim.github.io/med-tracker/';
const CRON_SECRET = Deno.env.get('MED_CRON_SECRET') ?? '';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

type Alarm = { key: string; med_id: string; title: string; body: string; due_at: string };
type Sub = { endpoint: string; key: string; p256dh: string; auth: string };

function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

// 하나의 기기로 발송. 만료된 구독(404/410)은 지우도록 알린다.
async function send(sub: Sub, payload: string): Promise<'ok' | 'gone' | 'fail'> {
  const req = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    payload,
    // urgency high — 기본값(normal)이면 애플이 배터리를 아끼려고 모아뒀다 늦게 배달한다.
    // 복약 시각 알림은 제때 도착해야 하므로 즉시 배달을 요청한다.
    { TTL: 3 * 3600, contentEncoding: 'aes128gcm', urgency: 'high' },
  );
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // Content-Length는 fetch가 직접 붙인다 (직접 넣으면 무시되거나 오류)
    if (k.toLowerCase() === 'content-length') continue;
    headers[k] = String(v);
  }

  try {
    const res = await fetch(req.endpoint, { method: 'POST', headers, body: req.body });
    if (res.ok) return 'ok';
    if (res.status === 404 || res.status === 410) return 'gone';
    console.error('push failed', res.status, await res.text());
    return 'fail';
  } catch (e) {
    console.error('push error', e);
    return 'fail';
  }
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get('x-med-cron') !== CRON_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  const nowIso = new Date().toISOString();
  const dueRes = await rest(
    `med_alarm?sent_at=is.null&due_at=lte.${encodeURIComponent(nowIso)}` +
    `&select=key,med_id,title,body,due_at&limit=200`,
  );
  if (!dueRes.ok) {
    return new Response(JSON.stringify({ error: await dueRes.text() }), { status: 500 });
  }
  const due: Alarm[] = await dueRes.json();
  if (!due.length) return Response.json({ due: 0, sent: 0 });

  // 필요한 코드의 구독만 한 번에 가져오기
  const keys = [...new Set(due.map((a) => a.key))];
  const subRes = await rest(
    `med_push?key=in.(${keys.join(',')})&select=endpoint,key,p256dh,auth`,
  );
  const subs: Sub[] = subRes.ok ? await subRes.json() : [];
  const byKey = new Map<string, Sub[]>();
  for (const s of subs) {
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key)!.push(s);
  }

  let sent = 0;
  const gone: string[] = [];

  for (const a of due) {
    const targets = byKey.get(a.key) ?? [];
    const payload = JSON.stringify({ title: a.title, body: a.body, tag: a.med_id, url: './' });

    let anyOk = false;
    for (const s of targets) {
      const r = await send(s, payload);
      if (r === 'ok') anyOk = true;
      else if (r === 'gone') gone.push(s.endpoint);
    }
    if (anyOk) sent++;

    // 구독이 하나도 없거나 만료됐어도 '보냄'으로 닫는다 — 안 그러면 매분 다시 시도한다
    await rest(
      `med_alarm?key=eq.${a.key}&med_id=eq.${encodeURIComponent(a.med_id)}`,
      { method: 'PATCH', body: JSON.stringify({ sent_at: new Date().toISOString() }) },
    );
  }

  for (const endpoint of gone) {
    await rest(`med_push?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE' });
  }

  // 오래된 기록 정리 (하루에 몇 줄 수준이라 여기서 같이 처리)
  const old = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  await rest(`med_alarm?due_at=lt.${encodeURIComponent(old)}`, { method: 'DELETE' });

  return Response.json({ due: due.length, sent, removed: gone.length });
});
