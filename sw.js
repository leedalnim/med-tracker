/* 복약 트래커 서비스워커 — 오프라인 캐싱 */
var CACHE_NAME = 'med-tracker-v112';
var ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './fonts/PretendardVariable.woff2',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* ===== 복약 알림 =====
   서버가 '다음 복용 시각'에 푸시를 보내면 여기서 알림을 띄운다.
   iOS는 푸시를 받으면 반드시 알림을 하나 보여줘야 하므로 실패해도 기본 문구로 표시한다. */
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  var title = data.title || '복약 트래커';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '복용할 시간이에요',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: data.tag || 'med-dose',
      renotify: true,
      // tag에 약 id가 들어온다 — 눌렀을 때 그 약 화면으로 바로 보내려고 같이 넘긴다
      data: { url: data.url || './', med: data.tag || null }
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var info = event.notification.data || {};
  var med = info.med || null;
  var url = med ? './?med=' + encodeURIComponent(med) : (info.url || './');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) {
          // 이미 열려 있는 앱은 새로 열리지 않으므로 어떤 약인지 따로 알려준다
          if (med) { try { c.postMessage({ type: 'open-med', med: med }); } catch (e) {} }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        // 같은 출처의 정상 응답만 캐시에 추가
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, copy);
          });
        }
        return response;
      }).catch(function () {
        // 오프라인 내비게이션은 캐시된 index.html로
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return Response.error();
      });
    })
  );
});
