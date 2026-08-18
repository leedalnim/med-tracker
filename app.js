/* 복약 트래커 — Vanilla JS, localStorage 전용 */
(function () {
  'use strict';

  /* ===== 확대(줌) 차단 — 더블탭 + 핀치(iOS 포함) ===== */
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
  });
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  /* ===== 저장소 (localStorage 불가 환경은 메모리로 폴백) ===== */
  var memStore = {};
  var storage = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return key in memStore ? memStore[key] : fallback;
      }
    },
    set: function (key, val) {
      memStore[key] = val;
      try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 메모리만 사용 */ }
    },
    has: function (key) {
      try { return localStorage.getItem(key) !== null; } catch (e) { return key in memStore; }
    }
  };

  var KEY = {
    meds: 'mt.meds',          // [{id, name, unit, type, intervalHours, maxPerDay}] — 홈에서 트래킹 중인 약
    favorites: 'mt.favorites',// [{id, name, unit, type, intervalHours, maxPerDay}] — 자주 찾는 약(홈 추가 시 후보). 홈엔 안 뜸
    doses: 'mt.doses',        // [{id, medId, ts}]
    period: 'mt.period',      // ['YYYY-MM-DD', ...] 생리로 표시한 날
    spotting: 'mt.spotting',  // ['YYYY-MM-DD', ...] 부정출혈로 표시한 날 (예측 계산엔 미포함)
    periodOn: 'mt.periodOn',  // 생리주기 기능 사용 여부 (기본 꺼짐, 설정에서 켬)
    theme: 'mt.theme',        // 'system' | 'light' | 'dark'
    migr: 'mt.migr'           // 데이터 마이그레이션 버전
  };

  // 약 type: 'interval' = 간격 트래커(다음 복용 가능 계산) / 'check' = 복용 체크(먹었는지만)

  // 약 선택 목록 겸 기본 등록 약 — 식약처 허가 용법 기준 (선택·등록 후 수정 가능)
  var MED_CATALOG = [
    { name: '타이레놀정 500mg', unit: '정', type: 'interval', intervalHours: 4, maxPerDay: 8 },
    { name: '타이레놀 8시간 이알 서방정 650mg', unit: '정', type: 'interval', intervalHours: 8, maxPerDay: 6 },
    { name: '이지엔6프로 (덱시부프로펜 300mg)', unit: '캡슐', type: 'interval', intervalHours: 6, maxPerDay: 4 },
    { name: '부루펜정 400mg (이부프로펜)', unit: '정', type: 'interval', intervalHours: 4, maxPerDay: 3 },
    { name: '탁센 (나프록센 250mg)', unit: '캡슐', type: 'interval', intervalHours: 6, maxPerDay: 5 },
    { name: '부스코판당의정 10mg', unit: '정', type: 'interval', intervalHours: 4, maxPerDay: 10 },
    { name: '로수바이브정', unit: '정', type: 'check', intervalHours: null, maxPerDay: 1 },
    { name: '본비바정 150mg (월 1회)', unit: '정', type: 'check', intervalHours: null, maxPerDay: 1 },
    { name: '라바로브정', unit: '정', type: 'check', intervalHours: null, maxPerDay: 1 },
    { name: '라바로하이정', unit: '정', type: 'check', intervalHours: null, maxPerDay: 1 }
  ];

  /* ===== 유틸 ===== */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() {
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function todayKey() { return dateKey(Date.now()); }
  function keyToDate(key) {
    var p = key.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function addDays(key, n) {
    var d = keyToDate(key);
    d.setDate(d.getDate() + n);
    return dateKey(d.getTime());
  }
  function diffDays(a, b) { // b - a (일)
    return Math.round((keyToDate(b) - keyToDate(a)) / 86400000);
  }
  function fmtTime(ts) {
    // 24시간제 H:MM:SS (한글 오전/오후 없이 글자 폭 축소) — 원형·상태 표기용
    var d = new Date(ts);
    return d.getHours() + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function fmtTimeKo(ts) {
    // 한글 시:분:초 — 복용 내역 기록 표기용
    var d = new Date(ts);
    return d.getHours() + '시 ' + d.getMinutes() + '분 ' + d.getSeconds() + '초';
  }
  function fmtTimeKoMin(ts) {
    // 한글 시:분 (초 생략) — 달력 하루 패널 등 간결 표기용
    var d = new Date(ts);
    return d.getHours() + '시 ' + d.getMinutes() + '분';
  }
  function fmtCountdown(ms) {
    // 남은 시간 H:MM:SS (매초 감소하는 카운트다운)
    var tot = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(tot / 3600);
    var m = Math.floor((tot % 3600) / 60);
    var s = tot % 60;
    return h + ':' + pad2(m) + ':' + pad2(s);
  }
  function fmtDateLong(ts) {
    return new Date(ts).toLocaleDateString('ko-KR', {
      month: 'long', day: 'numeric', weekday: 'long'
    });
  }
  function fmtKeyShort(key) {
    var d = keyToDate(key);
    var label = d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    if (key === todayKey()) label += ' · 오늘';
    return label;
  }
  function fmtRemain(ms) {
    var totalMin = Math.ceil(ms / 60000);
    if (totalMin < 1) totalMin = 1;
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h > 0 && m > 0) return h + '시간 ' + m + '분';
    if (h > 0) return h + '시간';
    return m + '분';
  }
  function fmtElapsed(ms) { // 경과 시간(내림) — '지남' 표기용
    var totalMin = Math.floor(ms / 60000);
    if (totalMin < 1) return '방금';
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h > 0 && m > 0) return h + '시간 ' + m + '분';
    if (h > 0) return h + '시간';
    return m + '분';
  }
  function timeInputValue(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function applyTimeToTs(ts, hms) { // 같은 날짜에 시:분:초 교체
    var p = hms.split(':');
    var d = new Date(ts);
    d.setHours(Number(p[0]), Number(p[1]), p[2] ? Number(p[2]) : 0, 0);
    return d.getTime();
  }
  function combineDateTime(dateStr, hms) { // 'YYYY-MM-DD' + 'HH:MM[:SS]' → ts
    var dp = dateStr.split('-');
    var tp = hms.split(':');
    return new Date(Number(dp[0]), Number(dp[1]) - 1, Number(dp[2]),
      Number(tp[0]), Number(tp[1]), tp[2] ? Number(tp[2]) : 0, 0).getTime();
  }

  /* ===== 데이터 ===== */
  // 첫 실행 시 카탈로그의 약들을 기본 등록 (수정·삭제 가능)
  // 홈에는 직접 등록한 약만 표시 — 자주 쓰는 약 목록은 약 추가 폼에서 선택
  function getMeds() { return storage.get(KEY.meds, []); }
  function saveMeds(meds) { storage.set(KEY.meds, meds); }
  function getFavorites() { return storage.get(KEY.favorites, []); }
  function saveFavorites(f) { storage.set(KEY.favorites, f); }
  // 약 추가 폼 콤보 후보 = 내가 등록한 '자주 찾는 약'(맨 위) + 기본 목록
  function comboList() { return getFavorites().concat(MED_CATALOG); }
  function medById(id) {
    return getMeds().find(function (m) { return m.id === id; }) || null;
  }

  // 기존 저장 데이터 보정
  function migrate() {
    var ver = storage.get(KEY.migr, 0);
    if (ver >= 6) return;
    // v1~2: type 기본값, 이지엔6프로 최대치(허가 용량 1일 4캡슐) 수정
    if (ver < 2 && storage.has(KEY.meds)) {
      var meds = storage.get(KEY.meds, []).map(function (m) {
        var out = {
          id: m.id, name: m.name, unit: m.unit,
          type: m.type || 'interval',
          intervalHours: m.intervalHours != null ? m.intervalHours : null,
          maxPerDay: m.maxPerDay != null ? m.maxPerDay : null
        };
        if (ver < 1 && m.id === 'preset-ezn6pro' && m.maxPerDay === 6) out.maxPerDay = 4;
        return out;
      });
      storage.set(KEY.meds, meds);
    }
    // v3: 생리 기능 기본값이 꺼짐으로 바뀜 — 이미 기록이 있는 사용자는 켠 상태 유지
    if (!storage.has(KEY.periodOn) && storage.get(KEY.period, []).length) {
      storage.set(KEY.periodOn, true);
    }
    // v4: 라바로브정·라바로하이정 1일 1회 확정 — 비어 있던 최대치 채움
    if (ver < 4 && storage.has(KEY.meds)) {
      storage.set(KEY.meds, storage.get(KEY.meds, []).map(function (m) {
        if ((m.name === '라바로브정' || m.name === '라바로하이정') && m.maxPerDay == null) {
          m.maxPerDay = 1;
        }
        return m;
      }));
    }
    // v5: 자동 등록됐던 기본 약 정리 — 복용 기록이 없는 것만 제거 (홈은 직접 등록한 약만)
    if (ver < 5 && storage.has(KEY.meds)) {
      var doses5 = storage.get(KEY.doses, []);
      storage.set(KEY.meds, storage.get(KEY.meds, []).filter(function (m) {
        if (String(m.id).indexOf('cat-') !== 0) return true;
        return doses5.some(function (d) { return d.medId === m.id; });
      }));
    }
    // v6: 이지엔6프로(덱시부프로펜) 최소 복용 간격 4→6시간 정정 (기존 4시간은 오류)
    if (ver < 6 && storage.has(KEY.meds)) {
      storage.set(KEY.meds, storage.get(KEY.meds, []).map(function (m) {
        if (m.name && m.name.indexOf('이지엔6프로') >= 0 && m.type === 'interval' && m.intervalHours === 4) {
          m.intervalHours = 6;
        }
        return m;
      }));
    }
    storage.set(KEY.migr, 6);
  }

  function getDoses() { return storage.get(KEY.doses, []); }
  function saveDoses(doses) { storage.set(KEY.doses, doses); }

  function isPeriodOn() { return storage.get(KEY.periodOn, false); } // 기본 꺼짐, 설정에서 켬

  /* ===== 화면 테마 ===== */
  function getTheme() { return storage.get(KEY.theme, 'system'); }
  function resolvedDark(t) {
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function applyTheme() {
    var t = getTheme();
    var root = document.documentElement;
    if (t === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    // 상태바 색(standalone PWA)도 맞춤
    var color = resolvedDark(t) ? '#0E0E10' : '#F4F4F5';
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      m.removeAttribute('media');
      m.setAttribute('content', color);
    });
  }

  /* ===== 데이터 백업(내보내기/불러오기) — 파일 하나로 저장·복원, 서버 없음 ===== */
  function exportData() {
    var payload = {
      app: 'med-tracker',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        meds: storage.get(KEY.meds, []),
        favorites: storage.get(KEY.favorites, []),
        doses: storage.get(KEY.doses, []),
        period: storage.get(KEY.period, []),
        spotting: storage.get(KEY.spotting, []),
        periodOn: storage.get(KEY.periodOn, false),
        theme: getTheme()
      }
    };
    var json = JSON.stringify(payload, null, 2);
    var name = '복약백업.json'; // 고정 이름 — 같은 위치에 저장하면 항상 최신 하나로 덮어씀
    var blob = new Blob([json], { type: 'application/json' });
    var file = null;
    try { file = new File([blob], name, { type: 'application/json' }); } catch (e) { file = null; }
    // 모바일: 공유 시트로 '파일에 저장'/카톡 등 선택
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: '복약 백업' }).catch(function () {});
      return;
    }
    // 폴백(데스크톱 등): 파일 다운로드
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importData(file, done) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(reader.result);
        var data = obj && obj.data ? obj.data : obj;
        if (!data || !Array.isArray(data.meds)) throw new Error('형식이 올바르지 않아요');
        storage.set(KEY.meds, data.meds || []);
        if (Array.isArray(data.favorites)) storage.set(KEY.favorites, data.favorites);
        storage.set(KEY.doses, Array.isArray(data.doses) ? data.doses : []);
        storage.set(KEY.period, Array.isArray(data.period) ? data.period : []);
        storage.set(KEY.spotting, Array.isArray(data.spotting) ? data.spotting : []);
        storage.set(KEY.periodOn, !!data.periodOn);
        if (data.theme) storage.set(KEY.theme, data.theme);
        done(true, '');
      } catch (e) { done(false, e.message || '불러오기 실패'); }
    };
    reader.onerror = function () { done(false, '파일을 읽지 못했어요'); };
    reader.readAsText(file);
  }

  function dosesForMed(medId) {
    return getDoses().filter(function (d) { return d.medId === medId; });
  }
  function todayDosesForMed(medId) {
    var tk = todayKey();
    return dosesForMed(medId).filter(function (d) { return dateKey(d.ts) === tk; });
  }
  function lastDoseForMed(medId) {
    var list = dosesForMed(medId);
    if (!list.length) return null;
    return list.reduce(function (a, b) { return a.ts > b.ts ? a : b; });
  }
  function logDose(medId) {
    var doses = getDoses();
    doses.push({ id: uid(), medId: medId, ts: Date.now() });
    saveDoses(doses);
  }
  function addDoseAt(medId, ts) {
    var doses = getDoses();
    doses.push({ id: uid(), medId: medId, ts: ts });
    saveDoses(doses);
  }
  function removeDose(doseId) {
    saveDoses(getDoses().filter(function (d) { return d.id !== doseId; }));
  }
  // 성공 시 true, 미래 시각이면 저장하지 않고 false
  function setDoseTime(doseId, hhmm) {
    var target = getDoses().find(function (d) { return d.id === doseId; });
    if (!target) return true;
    var newTs = applyTimeToTs(target.ts, hhmm);
    if (newTs > Date.now()) return false;
    saveDoses(getDoses().map(function (d) {
      return d.id === doseId ? { id: d.id, medId: d.medId, ts: newTs } : d;
    }));
    return true;
  }

  /* ===== 생리주기 ===== */
  function getPeriodDays() { return storage.get(KEY.period, []); }
  function togglePeriodDay(key) {
    var days = getPeriodDays();
    if (days.indexOf(key) >= 0) {
      days = days.filter(function (k) { return k !== key; });
    } else {
      days.push(key);
    }
    storage.set(KEY.period, days);
  }
  // 기간(시작~종료)을 생리 일자들로 추가
  function addPeriodRange(startKey, endKey) {
    var days = getPeriodDays();
    var k = startKey;
    while (k <= endKey) {
      if (days.indexOf(k) < 0) days.push(k);
      k = addDays(k, 1);
    }
    storage.set(KEY.period, days);
  }
  // 에피소드(시작~종료)에 속한 일자 전체 삭제
  function removePeriodRange(startKey, endKey) {
    storage.set(KEY.period, getPeriodDays().filter(function (k) {
      return k < startKey || k > endKey;
    }));
  }
  // 연속된 날들을 에피소드(한 번의 생리)로 묶기
  function episodesFrom(days) {
    var sorted = days.slice().sort();
    var eps = [];
    sorted.forEach(function (k) {
      var cur = eps[eps.length - 1];
      if (cur && diffDays(cur.end, k) === 1) cur.end = k;
      else eps.push({ start: k, end: k });
    });
    return eps;
  }
  function periodEpisodes() { return episodesFrom(getPeriodDays()); }

  // 부정출혈(별도 저장 — 예측 계산엔 절대 포함 안 함)
  function getSpottingDays() { return storage.get(KEY.spotting, []); }
  function addSpottingRange(startKey, endKey) {
    var days = getSpottingDays();
    var k = startKey;
    while (k <= endKey) { if (days.indexOf(k) < 0) days.push(k); k = addDays(k, 1); }
    storage.set(KEY.spotting, days);
  }
  function removeSpottingRange(startKey, endKey) {
    storage.set(KEY.spotting, getSpottingDays().filter(function (k) { return k < startKey || k > endKey; }));
  }
  function toggleSpottingDay(key) {
    var days = getSpottingDays();
    if (days.indexOf(key) >= 0) days = days.filter(function (k) { return k !== key; });
    else days.push(key);
    storage.set(KEY.spotting, days);
  }
  function spottingEpisodes() { return episodesFrom(getSpottingDays()); }
  // 사용자가 기록한 날짜들로만 산술 계산 (최근 6주기 평균)
  function cycleStats() {
    var eps = periodEpisodes();
    if (!eps.length) return null;
    var stats = { episodes: eps, avgCycle: null, nextStart: null, predDays: [] };
    if (eps.length >= 2) {
      var gaps = [];
      for (var i = 1; i < eps.length; i++) {
        gaps.push(diffDays(eps[i - 1].start, eps[i].start));
      }
      gaps = gaps.slice(-6);
      var avg = Math.round(gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length);
      var lenSum = 0;
      eps.forEach(function (e) { lenSum += diffDays(e.start, e.end) + 1; });
      var avgLen = Math.max(1, Math.round(lenSum / eps.length));
      var nextStart = addDays(eps[eps.length - 1].start, avg);
      stats.avgCycle = avg;
      stats.avgLen = avgLen;
      stats.nextStart = nextStart;
      for (var d = 0; d < avgLen; d++) stats.predDays.push(addDays(nextStart, d));
      // 배란 예정일 = 다음 생리 시작 14일 전(황체기 평균), 가임기 = 배란 -5 ~ +1일
      stats.ovulation = addDays(nextStart, -14);
      stats.fertileStart = addDays(stats.ovulation, -5);
      stats.fertileEnd = addDays(stats.ovulation, 1);
      stats.fertileDays = [];
      var fk = stats.fertileStart;
      while (fk <= stats.fertileEnd) { stats.fertileDays.push(fk); fk = addDays(fk, 1); }
    }
    return stats;
  }

  /* ===== 상태/라우팅 ===== */
  var now0 = new Date();
  var state = {
    screen: 'home',
    editMedId: null,
    detailMedId: null,
    returnTo: 'home',             // medForm에서 돌아갈 화면
    timeEdit: null,               // {kind:'dose'|'check', id}
    calY: now0.getFullYear(),
    calM: now0.getMonth(),        // 0-11
    selKey: todayKey(),
    sortMode: false,              // 홈 약 순서 변경 모드
    sortIds: null,                // 정렬 모드 임시 순서 (id 배열)
    periodFilter: 'all'           // 생리 기록 목록 필터: 'all'|'period'|'spotting'
  };
  var app = document.getElementById('app');
  var tickTimer = null;

  function go(screen, opts) {
    opts = opts || {};
    state.screen = screen;
    if ('editMedId' in opts) state.editMedId = opts.editMedId;
    else if (screen !== 'medForm') state.editMedId = null;
    if ('detailMedId' in opts) state.detailMedId = opts.detailMedId;
    if ('returnTo' in opts) state.returnTo = opts.returnTo;
    state.favMode = !!opts.favMode; // '자주 찾는 약' 추가 모드 (mt.favorites 저장, 홈엔 안 뜸)
    state.timeEdit = null;
    state.periodAdd = false;
    state.doseAdd = false;
    state.sortMode = false; // 다른 화면으로 이동하면 정렬 모드 해제
    state.sortIds = null;
    render();
  }

  function render() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }

    switch (state.screen) {
      case 'settings': renderSettings(); break;
      case 'medForm': renderMedForm(); break;
      case 'calendar': renderCalendar(); break;
      case 'medDetail': renderMedDetail(); break;
      case 'period':
        if (isPeriodOn()) { renderPeriod(); }
        else { state.screen = 'home'; render(); }
        break;
      default: renderTrackerHome();
    }
  }

  /* ===== 간격 트래커 홈 ===== */
  function renderTrackerHome() {
    if (state.sortMode) { renderSortMode(); return; }
    app.className = '';
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } // 직접 재호출 시 이전 타이머 정리
    var meds = getMeds();

    var sortBtn = meds.length >= 2
      ? '<button class="sort-toggle" id="sort-on" aria-label="약 순서 변경">' + ICON.sort + '정렬</button>'
      : '';
    var html =
      '<header class="screen-head with-action">' +
        '<div><h1>복약 트래커</h1>' +
        '<p class="sub">' + esc(fmtDateLong(Date.now())) + '</p></div>' +
        sortBtn +
      '</header>';

    if (!meds.length) {
      html += '<div class="empty">등록된 약이 없어요.<br>아래 버튼으로 추가해 주세요.</div>';
    } else {
      meds.forEach(function (med) { html += medCardHtml(med); });
    }

    html += '<button class="pill-btn secondary" id="add-med">+ 약 추가</button>';
    html += bottomNavHtml('home');
    app.innerHTML = html;

    bindMedCards();
    document.getElementById('add-med').addEventListener('click', function () {
      go('medForm', { editMedId: null, returnTo: 'home' });
    });
    var sortOn = document.getElementById('sort-on');
    if (sortOn) sortOn.addEventListener('click', function () {
      state.sortMode = true;
      state.sortIds = getMeds().map(function (m) { return m.id; }); // 현재 순서로 시작
      renderTrackerHome();
    });
    bindBottomNav();

    // 대기 중 약의 링 카운트다운을 매초 갱신 (상태 전환 시 전체 재렌더)
    var renderedDay = todayKey();
    tickTimer = setInterval(function () {
      if (state.screen !== 'home') { clearInterval(tickTimer); return; }
      // 자정을 넘기면 '오늘 N회' 집계·버튼 상태가 바뀌므로 한 번 전체 갱신
      if (todayKey() !== renderedDay) { renderTrackerHome(); return; }
      var needFull = false;
      // 유예 시간에 들어가 버튼이 활성화돼야 하는데 아직 비활성이면 전체 갱신
      function graceOpened(m, allowed) {
        if (!allowed) return false;
        var card = document.querySelector('[data-med="' + m.id + '"]');
        if (!card) return false;
        var btn = card.querySelector('button.pill-btn');
        return !!btn && btn.disabled && !btn.classList.contains('done');
      }
      getMeds().forEach(function (m) {
        if (m.type === 'check') {
          var crk = computeCheckRing(m);
          var cel = document.getElementById('crc-' + m.id);
          if (crk.active) {
            if (cel) cel.textContent = fmtHM(crk.remainMs); else needFull = true;
            if (graceOpened(m, crk.canLog)) needFull = true;
          } else if (cel) needFull = true; // 24시간 지남/날짜 바뀜 → 링 제거 위해 전체 갱신
          return;
        }
        var cs = computeInterval(m);
        var el = document.getElementById('rc-' + m.id);
        if (!cs.ready && !cs.reached) {
          if (el) el.textContent = fmtCountdown(cs.remainMs);
          else needFull = true;       // 새로 대기 상태가 됨
          if (graceOpened(m, cs.nearReady)) needFull = true;
        } else if (el) {
          needFull = true;            // 복용 가능/최대로 전환됨
        }
      });
      if (needFull) renderTrackerHome();
    }, 1000);
  }

  /* ===== 홈 약 순서 변경(정렬) 모드 ===== */
  function renderSortMode() {
    app.className = '';
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    var meds = getMeds();
    var byId = {};
    meds.forEach(function (m) { byId[m.id] = m; });
    // 저장 이후 삭제된 약이 있을 수 있으니 유효 id만, 누락된 약은 뒤에 보충
    var ids = (state.sortIds || []).filter(function (id) { return byId[id]; });
    meds.forEach(function (m) { if (ids.indexOf(m.id) < 0) ids.push(m.id); });
    state.sortIds = ids;

    var rows = ids.map(function (id, i) {
      var m = byId[id];
      var kind = m.type === 'check' ? '체크' : '간격';
      var upOff = i === 0 ? ' off' : '';
      var downOff = i === ids.length - 1 ? ' off' : '';
      return (
        '<div class="sort-card">' +
          '<span class="sort-handle">' + ICON.grip + '</span>' +
          '<span class="sort-name">' + esc(m.name) + '<span class="sort-kind"> · ' + kind + '</span></span>' +
          '<div class="sort-arrows">' +
            '<button class="sort-arrow' + upOff + '" data-up="' + esc(id) + '" aria-label="위로">' + ICON.arrowUp + '</button>' +
            '<button class="sort-arrow' + downOff + '" data-down="' + esc(id) + '" aria-label="아래로">' + ICON.arrowDown + '</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    app.innerHTML =
      '<div class="sort-bar">' +
        '<div class="sort-title">약 순서 변경</div>' +
        '<div class="sort-bar-btns">' +
          '<button class="sb-btn cancel" id="sort-cancel">취소</button>' +
          '<button class="sb-btn done" id="sort-done">완료</button>' +
        '</div>' +
      '</div>' +
      '<p class="sort-hint">▲▼로 순서를 바꾸고 <b>완료</b>를 누르면 저장, <b>취소</b>하면 원래대로 돌아가요.</p>' +
      '<div class="sort-list">' + rows + '</div>';

    function move(id, dir) {
      var i = state.sortIds.indexOf(id);
      var j = i + dir;
      if (i < 0 || j < 0 || j >= state.sortIds.length) return;
      var arr = state.sortIds.slice();
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      state.sortIds = arr;
      renderSortMode();
    }
    [].forEach.call(app.querySelectorAll('[data-up]'), function (b) {
      b.addEventListener('click', function () { move(b.getAttribute('data-up'), -1); });
    });
    [].forEach.call(app.querySelectorAll('[data-down]'), function (b) {
      b.addEventListener('click', function () { move(b.getAttribute('data-down'), 1); });
    });
    document.getElementById('sort-cancel').addEventListener('click', function () {
      state.sortMode = false; state.sortIds = null; // 변경 폐기
      renderTrackerHome();
    });
    document.getElementById('sort-done').addEventListener('click', function () {
      var order = state.sortIds.slice();
      var cur = getMeds();
      cur.sort(function (a, b) { return order.indexOf(a.id) - order.indexOf(b.id); });
      saveMeds(cur); // 순서만 저장 (기록·설정은 그대로)
      state.sortMode = false; state.sortIds = null;
      renderTrackerHome();
    });
  }

  // 간격 트래커 약의 상태·링 진행도 계산 (원시값)
  function computeInterval(med) {
    var now = Date.now();
    var last = lastDoseForMed(med.id);
    var todays = todayDosesForMed(med.id);
    var reached = med.maxPerDay ? todays.length >= med.maxPerDay : false;
    var intervalMs = med.intervalHours * 3600 * 1000;
    var ready = true;
    var remainMs = 0;
    if (last) {
      var nextAt = last.ts + intervalMs;
      if (nextAt > now) { ready = false; remainMs = nextAt - now; }
    }
    var C = 2 * Math.PI * 54;
    var frac = ready ? 1 : Math.min(1, remainMs / intervalMs);
    var dashoffset = reached ? 0 : (ready ? 0 : C * (1 - frac));
    return {
      last: last, reached: reached, ready: ready, remainMs: remainMs,
      // 복용 시각 직전 몇 분은 미리 눌러 기록할 수 있게 허용 (정각까지 기다리지 않도록)
      nearReady: !ready && remainMs <= GRACE_MS,
      intervalMs: intervalMs, C: C, dashoffset: dashoffset,
      ringCls: (reached || ready) ? ' ready' : ''
    };
  }

  function remainLabel(remainMs, br) {
    var totalMin = Math.max(1, Math.ceil(remainMs / 60000)); // 올림(보수적)
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h > 0 && m > 0) return h + '시간' + (br ? '<br>' : ' ') + m + '분';
    if (h > 0) return h + '시간';
    return m + '분';
  }

  function ringSvg(s) {
    return '<svg viewBox="0 0 120 120" aria-hidden="true">' +
        '<circle class="ring-bg" cx="60" cy="60" r="54"></circle>' +
        '<circle class="ring-fg' + s.ringCls + '" cx="60" cy="60" r="54" ' +
          'stroke-dasharray="' + s.C.toFixed(2) + '" stroke-dashoffset="' + s.dashoffset.toFixed(2) + '" ' +
          'transform="rotate(-90 60 60)"></circle>' +
      '</svg>';
  }

  var DAY_MS = 24 * 3600 * 1000;
  // 복용 예정 시각 직전 유예 — 이 시간 안에 들면 '먹었어요'를 미리 누를 수 있음
  var GRACE_MS = 3 * 60 * 1000;
  function fmtHM(ms) { // 남은 시간 H:MM (24시간 스케일용, 초 없음)
    var t = Math.max(0, ms);
    var h = Math.floor(t / 3600000);
    var m = Math.floor((t % 3600000) / 60000);
    return h + ':' + String(m).padStart(2, '0');
  }

  // 복용 체크 약의 24시간 링 상태 — '마지막 복용 시각 + 24시간' 기준.
  // 날짜(자정)와 무관하게 이어져야 하므로 오늘 기록이 아니라 마지막 복용을 본다.
  function computeCheckRing(med) {
    var last = lastDoseForMed(med.id);
    if (!last) return { active: false, last: null };
    var remainMs = last.ts + DAY_MS - Date.now();
    if (remainMs <= 0) return { active: false, last: last }; // 24시간 지남 → 복용 가능
    return {
      active: true, last: last, remainMs: remainMs,
      nextAt: last.ts + DAY_MS,
      canLog: remainMs <= GRACE_MS, // 예정 시각 직전이면 미리 기록 허용
      frac: Math.max(0, Math.min(1, remainMs / DAY_MS))
    };
  }

  // '내일 21시 0분'처럼 날짜가 넘어가면 앞에 오늘/내일을 붙여 표시
  function fmtWhenKo(ts) {
    var k = dateKey(ts), t = todayKey();
    var prefix = '';
    if (k === addDays(t, 1)) prefix = '내일 ';
    else if (k !== t) prefix = fmtKeyShort(k).replace(' · 오늘', '') + ' ';
    return prefix + fmtTimeKoMin(ts);
  }

  // 부채꼴(파이) 채우기 링 SVG — 남은 비율 frac 만큼 채우되, 소진되는 경계가 12시부터 '시계방향'으로 이동
  function pieRingSvg(frac, centerHtml) {
    var CX = 60, CY = 60, RR = 48, TAU = Math.PI * 2;
    frac = Math.max(0, Math.min(1, frac));
    var fill = '', arc = '';
    if (frac >= 0.999) {
      fill = '<circle class="pring-fill" cx="60" cy="60" r="' + RR + '"></circle>';
      arc = '<circle class="pring-arc" cx="60" cy="60" r="' + RR + '"></circle>';
    } else if (frac > 0.001) {
      // 남은 조각을 12시에서 반시계로 frac 만큼 물러난 지점 ~ 12시 사이에 배치.
      // → 빈(소진된) 조각은 12시부터 시계방향으로 커진다.
      var aEnd = -Math.PI / 2;                 // 12시
      var aStart = -Math.PI / 2 - frac * TAU;  // 채워진 영역의 시작(반시계로 frac)
      var x0 = CX + RR * Math.cos(aStart), y0 = CY + RR * Math.sin(aStart);
      var x1 = CX + RR * Math.cos(aEnd), y1 = CY + RR * Math.sin(aEnd);
      var large = frac > 0.5 ? 1 : 0;
      fill = '<path class="pring-fill" d="M60 60 L' + x0.toFixed(1) + ' ' + y0.toFixed(1) +
        ' A' + RR + ' ' + RR + ' 0 ' + large + ' 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' Z"></path>';
      arc = '<path class="pring-arc" fill="none" d="M' + x0.toFixed(1) + ' ' + y0.toFixed(1) +
        ' A' + RR + ' ' + RR + ' 0 ' + large + ' 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1) + '"></path>';
    }
    return '<svg viewBox="0 0 120 120" aria-hidden="true">' +
        '<circle class="pring-track" cx="60" cy="60" r="' + RR + '"></circle>' +
        fill + arc +
      '</svg>' + (centerHtml || '');
  }

  // 체크 약 홈/상세 공통 파이 링 (중앙: 남은 H:MM)
  function checkRingHtml(med, cr, sizeClass, centerId) {
    var center =
      '<div class="ring-center">' +
        '<div class="rc-time"' + (centerId ? ' id="' + centerId + '"' : '') + '>' + fmtHM(cr.remainMs) + '</div>' +
        '<div class="rc-label">남음</div>' +
      '</div>';
    return '<div class="ring-wrap' + (sizeClass ? ' ' + sizeClass : '') + '">' + pieRingSvg(cr.frac, center) + '</div>';
  }

  // 아직 안 먹은 체크 약의 빈 링 (회색 원 + '복용 전')
  function emptyCheckRingHtml(sizeClass) {
    var center = '<div class="ring-center"><div class="rc-pre">복용 전</div></div>';
    return '<div class="ring-wrap' + (sizeClass ? ' ' + sizeClass : '') + '">' + pieRingSvg(0, center) + '</div>';
  }

  // 마지막 복용 후 이 시간이 지나면 '경과 시간' 표시를 숨기고 깔끔한 '복용 가능'으로 초기화
  var ELAPSED_RESET_MS = 24 * 3600 * 1000;
  function recentElapsed(last) { // 24시간 이내면 경과 문자열, 아니면 null
    if (!last) return null;
    var el = Date.now() - last.ts;
    return el < ELAPSED_RESET_MS ? fmtElapsed(el) : null;
  }

  // 홈 카드용 소형 링 — 원 안엔 남은 시간 카운트다운(H:MM:SS, 매초 감소),
  // 원 밖엔 다음 복용 가능 시각을 라벨과 함께
  function buildIntervalRing(med, sizeClass) {
    var s = computeInterval(med);
    var innerTime, innerLabel, innerId, centerCls, statusLine;
    var elap = recentElapsed(s.last);
    if (s.reached) {
      centerCls = ' max'; innerTime = '오늘<br>최대'; innerLabel = '';
      statusLine = elap ? '마지막 복용 후 <span class="hl">' + esc(elap) + '</span> 지남' : '';
    } else if (s.ready) {
      centerCls = ' ready'; innerTime = '지금<br>가능'; innerLabel = '';
      statusLine = elap ? '마지막 복용 후 <span class="hl">' + esc(elap) + '</span> 지남'
        : (s.last ? '' : '아직 복용 기록이 없어요');
    } else {
      centerCls = ''; innerTime = esc(fmtCountdown(s.remainMs)); innerLabel = '남음';
      innerId = ' id="rc-' + esc(med.id) + '"';
      statusLine = s.nearReady
        ? '<span class="hl">곧 복용 시간</span> · 지금 기록할 수 있어요'
        : '<span class="hl">' + esc(fmtWhenKo(s.last.ts + s.intervalMs)) + '</span> 이후 복용 가능';
    }
    var ringCenter =
      '<div class="ring-center' + centerCls + '">' +
        '<div class="rc-time"' + (innerId || '') + '>' + innerTime + '</div>' +
        (innerLabel ? '<div class="rc-label">' + innerLabel + '</div>' : '') +
      '</div>';
    var frac = (s.reached || s.ready) ? 1 : Math.max(0, Math.min(1, s.remainMs / s.intervalMs));
    var ringHtml =
      '<div class="ring-wrap' + (sizeClass ? ' ' + sizeClass : '') + '">' +
        pieRingSvg(frac, ringCenter) +
      '</div>';
    return { ringHtml: ringHtml, statusLine: statusLine, ready: s.ready, reached: s.reached };
  }

  // 상세용 대형 히어로 링 — 대기 중엔 남은 시간을 매초 감소하는 H:MM:SS로 표시
  function buildDetailHero(med) {
    var s = computeInterval(med);
    var topLabel, bigVal, bigId, subLabel, cls;
    var elap = recentElapsed(s.last); // 24h 이내만, 아니면 null → 경과 숨김(초기화)
    if (s.reached) {
      cls = ' hl'; topLabel = '오늘 최대';
      bigVal = elap || '';
      subLabel = elap ? '마지막 복용 후 지남' : '';
    } else if (s.ready) {
      cls = ' hl'; topLabel = '지금 복용 가능';
      bigVal = elap || '';
      subLabel = elap ? '마지막 복용 후 지남' : (s.last ? '' : '기록 없음');
    } else {
      cls = ''; topLabel = '다음 복용까지';
      bigVal = fmtCountdown(s.remainMs);  // 카운트다운 (매초 감소)
      bigId = ' id="hero-count"';
      subLabel = fmtTimeKoMin(s.last.ts + s.intervalMs) + ' 예정';
    }
    var frac = (s.reached || s.ready) ? 1 : Math.max(0, Math.min(1, s.remainMs / s.intervalMs));
    var waiting = !s.reached && !s.ready && !s.nearReady; // 카운트다운 중(예정 3분 전부터는 허용)
    var heroBtn = waiting
      ? '<button class="pill-btn hero-log" disabled>' + ICON.pillPlus + '먹었어요</button>'
      : '<button class="pill-btn hero-log" id="detail-log">' + ICON.pillPlus + '먹었어요</button>';
    var heroCenter =
      '<div class="hero-center">' +
        '<div class="hero-label' + cls + '">' + topLabel + '</div>' +
        (bigVal ? '<div class="hero-big"' + (bigId || '') + '>' + esc(bigVal) + '</div>' : '') +
        (subLabel ? '<div class="hero-sub">' + esc(subLabel) + '</div>' : '') +
        heroBtn +
      '</div>';
    return '<div class="hero-ring pie">' + pieRingSvg(frac, heroCenter) + '</div>';
  }

  function medCardHtml(med) {
    var isCheck = med.type === 'check';
    var todays = todayDosesForMed(med.id);

    var reached = med.maxPerDay ? todays.length >= med.maxPerDay : false;
    var exceeded = med.maxPerDay ? todays.length > med.maxPerDay : false;
    var countTxt = med.maxPerDay ? todays.length + '/' + med.maxPerDay : todays.length + '회';

    var takenB = todays.length > 0;
    var ivState = isCheck ? null : computeInterval(med);
    // 대기중이라도 예정 시각 3분 전부터는 미리 누를 수 있게 허용
    var ivWaiting = ivState && !ivState.ready && !ivState.reached && !ivState.nearReady;
    var cr = isCheck ? computeCheckRing(med) : null;               // 체크 약 24시간 링(자정 무관)
    var crWaiting = cr && cr.active && !cr.canLog;

    // 먹었어요 버튼:
    //  - 체크 약: 오늘 먹었으면 '오늘 드셨어요!', 자정을 넘겼어도 24시간 전이면 비활성화
    //  - 간격 약: 남은 시간(카운트다운) 표시 중엔 비활성화, 복용 가능해지면 활성화
    var logBtn;
    if (isCheck && takenB) {
      logBtn = '<button class="pill-btn compact done" disabled>' + ICON.check + '오늘 드셨어요!</button>';
    } else if (ivWaiting || crWaiting) {
      logBtn = '<button class="pill-btn compact" disabled>' + ICON.pillPlus + '먹었어요</button>';
    } else {
      logBtn = '<button class="pill-btn compact" data-log="' + esc(med.id) + '">' + ICON.pillPlus + '먹었어요</button>';
    }

    // 우상단 배지: 체크 약이면 개수 태그만, 간격 약이면 오늘 N/최대
    var badgeHtml;
    if (isCheck) {
      badgeHtml = '<span class="count-tag' + (takenB ? ' on' : '') + '">' + countTxt + '</span>';
    } else {
      badgeHtml = '<span class="badge' + (reached ? ' filled' : '') + '">오늘 ' + countTxt + '</span>';
    }
    var titleRow =
      '<div class="mc-title">' +
        '<span class="med-name">' + esc(med.name) + '</span>' +
        '<span class="mc-badge-wrap">' + badgeHtml + '</span>' +
      '</div>';
    var actionsRow = '<div class="mc-actions">' + logBtn + '</div>';

    var statusLine = '';
    var ringHtml = '';
    if (isCheck) {
      var todayLast = todays.length
        ? todays.reduce(function (a, b) { return a.ts > b.ts ? a : b; })
        : null;
      if (todayLast) statusLine = '오늘 ' + esc(fmtTimeKoMin(todayLast.ts)) + ' 복용';
      else if (cr.active && cr.canLog) statusLine = '<span class="hl">곧 복용 시간</span> · 지금 기록할 수 있어요';
      else if (cr.active) statusLine = '<span class="hl">' + esc(fmtWhenKo(cr.nextAt)) + '</span> 이후 복용 가능';
      else statusLine = '오늘 아직 안 드셨어요';
      // 24시간 소진 파이 링(자정을 넘겨도 계속), 24시간 지났으면 빈 링('복용 전')
      ringHtml = cr.active ? checkRingHtml(med, cr, 'sm', 'crc-' + med.id) : emptyCheckRingHtml('sm');
    } else {
      var rv = buildIntervalRing(med, 'sm');
      ringHtml = rv.ringHtml;
      statusLine = rv.statusLine;
    }

    var warn = '';
    if (exceeded) {
      warn = '<div class="warn-banner">오늘 최대치 ' + med.maxPerDay + med.unit + ' 초과 — 현재 ' + todays.length + med.unit + '</div>';
    }

    // 레이아웃: (1) 링 있는 체크 약(오늘 먹음)·간격 약은 [제목·상태·버튼] 세로 스택,
    //          (2) 링 없는 체크 약은 상태와 버튼을 같은 줄(시각 왼쪽·버튼 오른쪽)
    var mcMain;
    if (isCheck && !ringHtml) {
      mcMain = '<div class="mc-main">' + titleRow +
          '<div class="mc-checkrow">' +
            '<p class="status-line">' + (statusLine || '') + '</p>' + logBtn +
          '</div>' +
        '</div>';
    } else {
      var acts = isCheck ? '<div class="mc-actions">' + logBtn + '</div>' : actionsRow;
      mcMain = '<div class="mc-main">' + titleRow +
          (statusLine ? '<p class="status-line">' + statusLine + '</p>' : '') +
          acts +
        '</div>';
    }

    // 스와이프 삭제: 카드를 왼쪽으로 밀면 뒤에서 삭제 버튼이 드러남
    return (
      '<div class="swipe-wrap">' +
        '<button class="swipe-delete" data-del-med="' + esc(med.id) + '" aria-label="약 삭제">' + ICON.trash + '<span>삭제</span></button>' +
        '<section class="card med-card swipe-content" data-med="' + esc(med.id) + '" role="button" tabindex="0">' +
          '<div class="mc-row">' +
            ringHtml +
            mcMain +
          '</div>' +
          warn +
        '</section>' +
      '</div>'
    );
  }

  function closeAllSwipe(except) {
    app.querySelectorAll('.swipe-wrap.open').forEach(function (w) {
      if (w !== except) w.classList.remove('open');
    });
  }

  // 공용 스와이프. moveActions=false: 콘텐츠가 왼쪽으로 밀림(카드).
  // moveActions=true: 콘텐츠는 고정, 뒤 액션이 오른쪽에서 슬라이드 인(복용 내역 행).
  function attachSwipe(wrap, openPx, onTap, moveActions) {
    var content = wrap.querySelector('.swipe-content');
    var mover = moveActions ? wrap.querySelector('.swipe-actions') : content;
    var closedX = moveActions ? openPx : 0;
    var openX = moveActions ? 0 : -openPx;
    var lo = Math.min(openX, closedX), hi = Math.max(openX, closedX);
    var startX = 0, startY = 0, lastDx = 0, dragging = false, moved = false, horiz = false, baseOpen = false;
    content.addEventListener('pointerdown', function (e) {
      startX = e.clientX; startY = e.clientY; lastDx = 0;
      dragging = true; moved = false; horiz = false;
      baseOpen = wrap.classList.contains('open');
      mover.style.transition = 'none';
    });
    content.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      lastDx = dx;
      if (!horiz && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) horiz = true;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
      if (horiz) {
        if (e.cancelable) e.preventDefault();
        var t = Math.max(lo, Math.min(hi, (baseOpen ? openX : closedX) + dx));
        mover.style.transform = 'translateX(' + t + 'px)';
      }
    });
    function end() {
      if (!dragging) return;
      dragging = false;
      mover.style.transition = '';
      mover.style.transform = '';
      if (horiz) {
        var t = (baseOpen ? openX : closedX) + lastDx;
        var opened = moveActions ? (t < openPx / 2) : (t < -openPx / 2);
        if (opened) { closeAllSwipe(wrap); wrap.classList.add('open'); }
        else wrap.classList.remove('open');
      }
    }
    content.addEventListener('pointerup', end);
    content.addEventListener('pointercancel', end);
    content.addEventListener('click', function (e) {
      if (e.target.closest('button') || e.target.closest('input')) return;
      if (moved) { e.preventDefault(); return; }
      if (wrap.classList.contains('open')) { wrap.classList.remove('open'); return; }
      if (onTap) onTap();
    });
  }

  function bindMedCards() {
    app.querySelectorAll('.swipe-wrap').forEach(function (wrap) {
      var content = wrap.querySelector('.swipe-content');
      attachSwipe(wrap, 84, function () {
        go('medDetail', { detailMedId: content.getAttribute('data-med') });
      });
    });

    app.querySelectorAll('[data-log]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        logDose(btn.getAttribute('data-log'));
        state.timeEdit = null;
        renderTrackerHome();
      });
    });
    app.querySelectorAll('[data-del-med]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var med = medById(btn.getAttribute('data-del-med'));
        if (med && window.confirm('"' + med.name + '"을(를) 삭제할까요?\n복용 이력은 남아있어요.')) {
          saveMeds(getMeds().filter(function (mm) { return mm.id !== med.id; }));
          renderTrackerHome();
        }
      });
    });
  }

  /* ===== 약 상세 ===== */
  function renderMedDetail() {
    var med = medById(state.detailMedId);
    if (!med) { go('home'); return; }
    app.className = 'no-nav';
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } // 직접 재호출 시 이전 타이머 정리

    var todays = todayDosesForMed(med.id);
    var isCheck = med.type === 'check';

    var summary =
      '<div class="detail-stats">' +
        '<div class="ds-item"><div class="ds-num">' + todays.length + '</div><div class="ds-label">오늘 복용</div></div>' +
        (med.maxPerDay
          ? '<div class="ds-item"><div class="ds-num">' + med.maxPerDay + '</div><div class="ds-label">1일 최대</div></div>'
          : '') +
        (!isCheck
          ? '<div class="ds-item"><div class="ds-num">' + med.intervalHours + '시간</div><div class="ds-label">최소 간격</div></div>'
          : '') +
      '</div>';

    // 상세 상단: 간격 트래커면 대형 히어로 링(버튼 내장), 복용 체크면 상태+버튼
    var topCard;
    if (isCheck) {
      var todayLastD = todays.length
        ? todays.reduce(function (a, b) { return a.ts > b.ts ? a : b; })
        : null;
      var crD = computeCheckRing(med); // '마지막 복용 + 24시간' 기준 (자정과 무관)
      var checkBtn = todayLastD
        ? '<button class="pill-btn check-log-full done" disabled>' + ICON.check + '오늘 드셨어요!</button>'
        : (crD.active && !crD.canLog
            ? '<button class="pill-btn check-log-full" disabled>' + ICON.pillPlus + '먹었어요</button>'
            : '<button class="pill-btn check-log-full" id="detail-log">' + ICON.pillPlus + '먹었어요</button>');
      var heroD = crD.active
        ? '<div class="hero-ring pie">' + pieRingSvg(crD.frac,
            '<div class="hero-center"><div class="hero-label">다음 복용까지</div>' +
            '<div class="hero-big" id="chero-count">' + fmtHM(crD.remainMs) + '</div>' +
            '<div class="hero-sub">' + esc(fmtWhenKo(crD.nextAt)) + ' 예정</div></div>') +
          '</div>'
        : '<div class="hero-ring pie">' + pieRingSvg(0,
            '<div class="hero-center"><div class="hero-label">복용 전</div>' +
            '<div class="hero-sub">먹으면 24시간 표시</div></div>') +
          '</div>';
      topCard =
        '<div class="card detail-hero-card">' +
          heroD + summary + checkBtn +
        '</div>';
    } else {
      topCard =
        '<div class="card detail-hero-card">' +
          buildDetailHero(med) +
          summary +
        '</div>';
    }

    // 최근 30일 기록을 날짜별로
    var cutoff = addDays(todayKey(), -30);
    var doses = dosesForMed(med.id)
      .filter(function (d) { return dateKey(d.ts) >= cutoff; })
      .sort(function (a, b) { return b.ts - a.ts; });

    var listHtml = '';
    if (!doses.length) {
      listHtml = '<div class="empty">최근 30일 기록이 없어요.</div>';
    } else {
      var curKey = null;
      doses.forEach(function (d) {
        var k = dateKey(d.ts);
        if (k !== curKey) {
          curKey = k;
          var dayCount = doses.filter(function (x) { return dateKey(x.ts) === k; }).length;
          var isToday = k === todayKey();
          var dateLabel = esc(fmtKeyShort(k).replace(' · 오늘', ''));
          listHtml += '<div class="history-date">' +
            (isToday ? '<span class="today-tag">오늘</span>' : '') +
            dateLabel + ' · ' + dayCount + med.unit + '</div>';
        }
        var editing = state.timeEdit && state.timeEdit.kind === 'dose' && state.timeEdit.id === d.id;
        if (editing) {
          listHtml +=
            '<div class="time-edit">' +
              '<input type="time" step="1" id="te-input" value="' + timeInputValue(d.ts) + '">' +
              '<button class="pill-btn" data-md-save="' + esc(d.id) + '">저장</button>' +
              '<button class="text-btn" data-md-cancel>닫기</button>' +
            '</div>';
        } else {
          // 밀면 수정·삭제가 드러나는 스와이프 행 (시각은 한글 서브텍스트)
          listHtml +=
            '<div class="swipe-wrap row-swipe time-lead">' +
              '<div class="swipe-actions">' +
                '<button class="sw-act edit" data-md-edit="' + esc(d.id) + '">수정</button>' +
                '<button class="sw-act del" data-md-del="' + esc(d.id) + '">삭제</button>' +
              '</div>' +
              '<div class="dose-row swipe-content">' +
                '<span class="d-time">' + esc(isCheck ? fmtTimeKoMin(d.ts) : fmtTimeKo(d.ts)) + '</span>' +
                '<span class="d-swipe-hint">' + ICON.chevronL + '</span>' +
              '</div>' +
            '</div>';
        }
      });
    }

    // 지난 복용 기록을 날짜·시각 지정해 직접 추가하는 폼
    var nowD = new Date();
    var addForm = state.doseAdd
      ? '<div class="card">' +
          '<div class="form-field"><label for="da-date">날짜</label>' +
            '<input id="da-date" type="date" max="' + todayKey() + '" value="' + todayKey() + '"></div>' +
          '<div class="form-field"><label for="da-time">시각</label>' +
            '<input id="da-time" type="time" step="1" value="' + timeInputValue(nowD.getTime()) + '"></div>' +
          '<p class="form-error" id="da-error"></p>' +
          '<div class="form-actions">' +
            '<button class="pill-btn secondary" id="da-cancel">취소</button>' +
            '<button class="pill-btn" id="da-save">기록 추가</button>' +
          '</div>' +
        '</div>'
      : '';

    app.innerHTML =
      '<div class="back-head">' +
        '<button id="back" aria-label="뒤로">←</button>' +
        '<div class="bh-titlerow">' +
          '<h1>' + esc(med.name) + '</h1>' +
        '</div>' +
      '</div>' +
      topCard +
      '<div class="section-head">' +
        '<h2 class="section-title">복용 내역 (최근 30일)</h2>' +
        (state.doseAdd ? '' : '<button class="text-btn" id="dose-add-btn">+ 기록 추가</button>') +
      '</div>' +
      addForm +
      '<div class="card">' + listHtml + '</div>' +
      '<div class="med-manage">' +
        '<button class="pill-btn secondary" id="edit-med-info">' + ICON.edit + '복용 정보 수정</button>' +
        '<button class="pill-btn danger-outline" id="delete-med">' + ICON.trash + '약 삭제</button>' +
      '</div>';

    document.getElementById('back').addEventListener('click', function () { go('home'); });
    var detailLogBtn = document.getElementById('detail-log');
    if (detailLogBtn) {
      detailLogBtn.addEventListener('click', function () {
        logDose(med.id);
        renderMedDetail();
      });
    }
    document.getElementById('edit-med-info').addEventListener('click', function () {
      go('medForm', { editMedId: med.id, returnTo: 'medDetail' });
    });
    document.getElementById('delete-med').addEventListener('click', function () {
      if (window.confirm('"' + med.name + '"을(를) 삭제할까요?\n복용 이력은 남아있어요.')) {
        saveMeds(getMeds().filter(function (mm) { return mm.id !== med.id; }));
        go('home');
      }
    });
    app.querySelectorAll('.row-swipe').forEach(function (wrap) { attachSwipe(wrap, 140, null, true); });
    app.querySelectorAll('[data-md-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.timeEdit = { kind: 'dose', id: btn.getAttribute('data-md-edit') };
        renderMedDetail();
      });
    });
    app.querySelectorAll('[data-md-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeDose(btn.getAttribute('data-md-del'));
        renderMedDetail();
      });
    });
    app.querySelectorAll('[data-md-save]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var val = document.getElementById('te-input').value;
        if (val && !setDoseTime(btn.getAttribute('data-md-save'), val)) {
          window.alert('지금보다 미래 시각으로는 저장할 수 없어요.');
          return;
        }
        state.timeEdit = null;
        renderMedDetail();
      });
    });
    app.querySelectorAll('[data-md-cancel]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.timeEdit = null;
        renderMedDetail();
      });
    });

    var addBtn = document.getElementById('dose-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        state.doseAdd = true;
        state.timeEdit = null;
        renderMedDetail();
      });
    }
    if (state.doseAdd) {
      document.getElementById('da-cancel').addEventListener('click', function () {
        state.doseAdd = false;
        renderMedDetail();
      });
      document.getElementById('da-save').addEventListener('click', function () {
        var dateVal = document.getElementById('da-date').value;
        var timeVal = document.getElementById('da-time').value;
        var errEl = document.getElementById('da-error');
        function fail(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }
        if (!dateVal) { fail('날짜를 선택해 주세요.'); return; }
        if (!timeVal) { fail('시각을 입력해 주세요.'); return; }
        var ts = combineDateTime(dateVal, timeVal);
        if (ts > Date.now()) { fail('미래 시각으로는 기록할 수 없어요.'); return; }
        addDoseAt(med.id, ts);
        state.doseAdd = false;
        renderMedDetail();
      });
    }

    // 대기 중일 때만 히어로 카운트다운을 매초 갱신 (복용 가능/최대·폼 열림 땐 멈춤)
    if (!isCheck && !state.doseAdd && !state.timeEdit) {
      var s0 = computeInterval(med);
      if (!s0.ready && !s0.reached) {
        tickTimer = setInterval(function () {
          if (state.screen !== 'medDetail') { clearInterval(tickTimer); return; }
          var s = computeInterval(med);
          var el = document.getElementById('hero-count');
          if (s.ready || s.reached || !el) {
            renderMedDetail(); // 대기 → 복용 가능으로 전환된 순간 1회 전체 갱신
            return;
          }
          // 유예 시간 진입 → 버튼을 활성화하기 위해 한 번 갱신
          var hb = document.querySelector('.hero-log');
          if (s.nearReady && hb && hb.disabled) { renderMedDetail(); return; }
          el.textContent = fmtCountdown(s.remainMs);
        }, 1000);
      }
    } else if (isCheck && !state.doseAdd && !state.timeEdit) {
      // 체크 약 24시간 파이 링 카운트다운 매초 갱신 (자정을 넘겨도 이어짐)
      var detailDay = todayKey();
      tickTimer = setInterval(function () {
        if (state.screen !== 'medDetail') { clearInterval(tickTimer); return; }
        if (todayKey() !== detailDay) { renderMedDetail(); return; } // 날짜 바뀜 → 집계·버튼 갱신
        var crk = computeCheckRing(med);
        var el = document.getElementById('chero-count');
        if (!crk.active) {
          if (el) renderMedDetail(); // 24시간 경과 → 복용 가능 상태로 전환
          return;
        }
        // 유예 시간 진입 → 버튼 활성화를 위해 한 번 갱신
        var cb = document.querySelector('.check-log-full');
        if (crk.canLog && cb && cb.disabled && !cb.classList.contains('done')) { renderMedDetail(); return; }
        if (el) el.textContent = fmtHM(crk.remainMs);
      }, 1000);
    }
  }

  /* ===== 달력 ===== */
  function renderCalendar() {
    app.className = '';
    var periodOn = isPeriodOn();
    var stats = periodOn ? cycleStats() : null;
    var periodSet = {};
    var spottingSet = {};
    if (periodOn) {
      getPeriodDays().forEach(function (k) { periodSet[k] = true; });
      getSpottingDays().forEach(function (k) { spottingSet[k] = true; });
    }
    var predSet = {};
    if (stats && stats.predDays) {
      stats.predDays.forEach(function (k) { predSet[k] = true; });
    }
    var fertileSet = {}, ovulKey = null;
    if (stats && stats.avgCycle) {
      stats.fertileDays.forEach(function (k) { fertileSet[k] = true; });
      ovulKey = stats.ovulation;
    }

    // 이 달의 복용 기록 수
    var doseCount = {};
    getDoses().forEach(function (d) {
      var k = dateKey(d.ts);
      doseCount[k] = (doseCount[k] || 0) + 1;
    });

    var y = state.calY, m = state.calM;
    var first = new Date(y, m, 1);
    var startWd = first.getDay();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var tk = todayKey();

    var html =
      '<header class="screen-head">' +
        '<h1>달력</h1>' +
        '<p class="sub">날짜를 누르면 그날의 기록을 볼 수 있어요</p>' +
      '</header>';

    // 생리 화면(기록 목록·추가·예측)으로 가는 버튼
    if (periodOn) {
      var ciText;
      if (stats && stats.avgCycle) {
        var dd = diffDays(tk, stats.nextStart);
        var ddLabel = dd > 0 ? 'D-' + dd : (dd === 0 ? '오늘' : dd * -1 + '일 지남');
        ciText = '다음 생리 예정일 ' + esc(fmtKeyShort(stats.nextStart).replace(' · 오늘', '')) + ' (' + ddLabel + ')';
      } else {
        ciText = '생리 기록 · 예측 보기';
      }
      html += '<button class="cycle-info" id="open-period"><span class="dot"></span>' +
        ciText + '<span class="ci-arrow">›</span></button>';
    }

    html += '<div class="card">' +
      '<div class="cal-head">' +
        '<button id="cal-prev" aria-label="이전 달">‹</button>' +
        '<div class="cal-title">' + y + '년 ' + (m + 1) + '월</div>' +
        '<button id="cal-next" aria-label="다음 달">›</button>' +
      '</div>' +
      '<div class="cal-grid">';

    ['일', '월', '화', '수', '목', '금', '토'].forEach(function (w) {
      html += '<div class="cal-wd">' + w + '</div>';
    });
    for (var b = 0; b < startWd; b++) html += '<button class="cal-day" disabled></button>';
    for (var day = 1; day <= daysInMonth; day++) {
      var k = y + '-' + pad2(m + 1) + '-' + pad2(day);
      var cls = 'cal-day';
      if (k === tk) cls += ' today';
      if (periodSet[k]) cls += ' period';
      else if (spottingSet[k]) cls += ' spotting';
      else if (predSet[k]) cls += ' pred';
      else if (k === ovulKey) cls += ' ovul';
      else if (fertileSet[k]) cls += ' fertile';
      if (k === state.selKey) cls += ' sel';
      html += '<button class="' + cls + '" data-day="' + k + '">' + day +
        (doseCount[k] ? '<span class="dd"></span>' : '') + '</button>';
    }
    html += '</div>';
    var hasSpotting = Object.keys(spottingSet).length > 0;
    var hasPeriod = Object.keys(periodSet).length > 0;
    if (periodOn && (hasPeriod || hasSpotting || (stats && stats.avgCycle))) {
      var legend = '<div class="cal-legend"><span><i class="lg period"></i>생리</span>';
      if (hasSpotting) legend += '<span><i class="lg spotting"></i>부정출혈</span>';
      if (stats && stats.avgCycle) {
        legend += '<span><i class="lg pred"></i>예정</span>' +
          '<span><i class="lg fertile"></i>가임기</span>' +
          '<span><i class="lg ovul"></i>배란</span>';
      }
      html += legend + '</div>';
    }
    html += '</div>';

    html += dayPanelHtml(state.selKey, periodOn, periodSet, spottingSet);
    html += bottomNavHtml('calendar');
    app.innerHTML = html;

    document.getElementById('cal-prev').addEventListener('click', function () {
      state.calM--;
      if (state.calM < 0) { state.calM = 11; state.calY--; }
      renderCalendar();
    });
    document.getElementById('cal-next').addEventListener('click', function () {
      state.calM++;
      if (state.calM > 11) { state.calM = 0; state.calY++; }
      renderCalendar();
    });
    app.querySelectorAll('[data-day]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.selKey = btn.getAttribute('data-day');
        state.timeEdit = null;
        renderCalendar();
      });
    });
    var openPeriod = document.getElementById('open-period');
    if (openPeriod) {
      openPeriod.addEventListener('click', function () { go('period'); });
    }
    bindDayPanel();
    bindBottomNav();
  }

  function dayPanelHtml(key, periodOn, periodSet, spottingSet) {
    spottingSet = spottingSet || {};
    var meds = getMeds();
    var medMap = {};
    meds.forEach(function (mm) { medMap[mm.id] = mm; });

    var doses = getDoses().filter(function (d) { return dateKey(d.ts) === key; })
      .sort(function (a, b) { return a.ts - b.ts; });

    var html = '<section class="card day-panel">' +
      '<div class="dp-head">' +
        '<div class="dp-title">' + esc(fmtKeyShort(key)) + '</div>' +
        (periodOn
          ? '<div class="dp-toggles">' +
              '<button class="period-toggle' + (periodSet[key] ? ' on' : '') + '" data-period-toggle>' +
                (periodSet[key] ? '생리 지우기' : '+ 생리') + '</button>' +
              '<button class="period-toggle spot' + (spottingSet[key] ? ' on' : '') + '" data-spotting-toggle>' +
                (spottingSet[key] ? '부정출혈 지우기' : '+ 부정출혈') + '</button>' +
            '</div>'
          : '') +
      '</div>';

    if (!doses.length) {
      html += '<p class="dp-empty">이날 복용 기록이 없어요.</p>';
    } else {
      doses.forEach(function (d) {
        var med = medMap[d.medId];
        var editing = state.timeEdit && state.timeEdit.kind === 'dose' && state.timeEdit.id === d.id;
        if (editing) {
          html +=
            '<div class="time-edit">' +
              '<input type="time" step="1" id="te-input" value="' + timeInputValue(d.ts) + '">' +
              '<button class="pill-btn" data-dp-save="' + esc(d.id) + '">저장</button>' +
              '<button class="text-btn" data-dp-cancel>닫기</button>' +
            '</div>';
        } else {
          // 밀면 수정·삭제가 드러나는 스와이프 행 (복용 내역과 동일 패턴)
          html +=
            '<div class="swipe-wrap row-swipe">' +
              '<div class="swipe-actions">' +
                '<button class="sw-act edit" data-dp-edit="' + esc(d.id) + '">수정</button>' +
                '<button class="sw-act del" data-dp-del="' + esc(d.id) + '">삭제</button>' +
              '</div>' +
              '<div class="dose-row swipe-content">' +
                '<span class="d-name">' + esc(med ? med.name : '삭제된 약') + '</span>' +
                '<span class="dp-right"><span class="d-time">' + esc(fmtTimeKoMin(d.ts)) + '</span>' +
                  '<span class="d-swipe-hint">' + ICON.chevronL + '</span></span>' +
              '</div>' +
            '</div>';
        }
      });
    }
    html += '</section>';
    return html;
  }

  function bindDayPanel() {
    var toggle = app.querySelector('[data-period-toggle]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        togglePeriodDay(state.selKey);
        renderCalendar();
      });
    }
    var spotToggle = app.querySelector('[data-spotting-toggle]');
    if (spotToggle) {
      spotToggle.addEventListener('click', function () {
        toggleSpottingDay(state.selKey);
        renderCalendar();
      });
    }
    app.querySelectorAll('.day-panel .row-swipe').forEach(function (wrap) { attachSwipe(wrap, 140, null, true); });
    app.querySelectorAll('[data-dp-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.timeEdit = { kind: 'dose', id: btn.getAttribute('data-dp-edit') };
        renderCalendar();
      });
    });
    app.querySelectorAll('[data-dp-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeDose(btn.getAttribute('data-dp-del'));
        renderCalendar();
      });
    });
    app.querySelectorAll('[data-dp-save]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var val = document.getElementById('te-input').value;
        if (val && !setDoseTime(btn.getAttribute('data-dp-save'), val)) {
          window.alert('지금보다 미래 시각으로는 저장할 수 없어요.');
          return;
        }
        state.timeEdit = null;
        renderCalendar();
      });
    });
    app.querySelectorAll('[data-dp-cancel]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.timeEdit = null;
        renderCalendar();
      });
    });
  }

  /* ===== 생리 주기 화면 (달력에서 진입) ===== */
  function renderPeriod() {
    app.className = 'no-nav';
    var stats = cycleStats();
    var eps = stats ? stats.episodes : [];
    var tk = todayKey();

    var html =
      '<div class="back-head">' +
        '<button id="back" aria-label="뒤로">←</button>' +
        '<h1>생리 주기</h1>' +
      '</div>';

    // 예측 요약
    if (stats && stats.avgCycle) {
      var dd = diffDays(tk, stats.nextStart);
      var ddLabel = dd > 0 ? 'D-' + dd : (dd === 0 ? '오늘' : dd * -1 + '일 지남');
      var lenSum = 0;
      eps.forEach(function (e) { lenSum += diffDays(e.start, e.end) + 1; });
      var avgLen = Math.max(1, Math.round(lenSum / eps.length));
      var ovDd = diffDays(tk, stats.ovulation);
      var ovLabel = ovDd > 0 ? 'D-' + ovDd : (ovDd === 0 ? '오늘' : ovDd * -1 + '일 지남');
      var stripPrefix = function (key) {
        return esc(fmtKeyShort(key).replace(' · 오늘', '').replace(/^\d+월 /, function (m) { return m; }));
      };
      html +=
        '<div class="card">' +
          '<div class="detail-stats">' +
            '<div class="ds-item"><div class="ds-num">' + stats.avgCycle + '일</div><div class="ds-label">평균 주기</div></div>' +
            '<div class="ds-item"><div class="ds-num">' + avgLen + '일</div><div class="ds-label">평균 기간</div></div>' +
          '</div>' +
          '<div class="ovul-box">' +
            '<div class="ovul-row"><span class="ovul-dot np"></span><span class="ovul-label">다음 예정일</span>' +
              '<b>' + stripPrefix(stats.nextStart) + '</b><span class="ovul-dd">' + ddLabel + '</span></div>' +
            '<div class="ovul-row"><span class="ovul-dot ov"></span><span class="ovul-label">배란 예정일</span>' +
              '<b>' + stripPrefix(stats.ovulation) + '</b><span class="ovul-dd">' + ovLabel + '</span></div>' +
            '<div class="ovul-row"><span class="ovul-dot fe"></span><span class="ovul-label">가임기</span>' +
              '<b>' + stripPrefix(stats.fertileStart) + ' ~ ' + stripPrefix(stats.fertileEnd) + '</b></div>' +
          '</div>' +
          '<p class="ovul-note">최근 기록 평균으로 계산한 <b>예측</b>이에요. 배란·가임기는 추정치이니 피임·임신 계획의 근거로 삼지 마세요.</p>' +
        '</div>';
    } else {
      html +=
        '<div class="cycle-info"><span class="dot"></span>기록이 2번 이상 쌓이면 다음 예정일을 계산해요</div>';
    }

    // 기록 추가/수정 — 시작일 + 기간(일)만 입력, 종료일은 자동 계산
    var editing = !!state.periodEdit;
    var curKind = editing ? (state.periodEdit.kind || 'period') : 'period';
    if (state.periodAdd || editing) {
      var lenSum = 0; eps.forEach(function (e) { lenSum += diffDays(e.start, e.end) + 1; });
      var defaultLen = eps.length ? Math.max(1, Math.round(lenSum / eps.length)) : 5;
      var startVal = editing ? state.periodEdit.start : tk;
      var lenVal = editing ? (diffDays(state.periodEdit.start, state.periodEdit.end) + 1) : defaultLen;
      html +=
        '<div class="card">' +
          '<div class="form-field"><label>기록 종류</label>' +
            '<div class="seg p-kind-seg" id="p-kind">' +
              '<button type="button" data-kind="period" class="' + (curKind === 'period' ? 'active' : '') + '">생리</button>' +
              '<button type="button" data-kind="spotting" class="' + (curKind === 'spotting' ? 'active' : '') + '">부정출혈</button>' +
            '</div>' +
          '</div>' +
          '<div class="form-row">' +
            '<div class="form-field"><label for="p-start">시작일</label>' +
              '<input id="p-start" type="date" max="' + tk + '" value="' + startVal + '"></div>' +
            '<div class="form-field"><label for="p-len">기간(일)</label>' +
              '<input id="p-len" type="number" min="1" max="14" inputmode="numeric" value="' + lenVal + '"></div>' +
          '</div>' +
          '<p class="form-hint">시작일과 기간만 넣으면 <b>종료일은 자동</b>이에요. <span id="p-endpreview" class="end-preview"></span></p>' +
          '<p class="form-error" id="p-error"></p>' +
          '<div class="form-actions">' +
            '<button class="pill-btn secondary" id="p-cancel">취소</button>' +
            '<button class="pill-btn" id="p-save">' + (editing ? '수정 저장' : '저장') + '</button>' +
          '</div>' +
        '</div>';
    } else {
      html += '<button class="pill-btn secondary" id="p-add">+ 지난 기록 추가 (생리·부정출혈)</button>';
    }

    // 기록 목록 — 생리(예측 대상) + 부정출혈(별도)을 합쳐 최근순. 박스당 하나, 밀면 수정·삭제
    var rows = [];
    eps.forEach(function (ep, i) {
      var len = diffDays(ep.start, ep.end) + 1;
      var cycleTxt = i > 0 ? '주기 ' + diffDays(eps[i - 1].start, ep.start) + '일' : '';
      rows.push({ kind: 'period', start: ep.start, end: ep.end, meta: len + '일간' + (cycleTxt ? ' · ' + cycleTxt : '') });
    });
    spottingEpisodes().forEach(function (ep) {
      var len = diffDays(ep.start, ep.end) + 1;
      rows.push({ kind: 'spotting', start: ep.start, end: ep.end, meta: len + '일간' });
    });
    rows.sort(function (a, b) { return a.start < b.start ? 1 : (a.start > b.start ? -1 : 0); });

    // 종류별로 모아 보기 (전체 / 생리 / 부정출혈)
    var nPeriod = 0, nSpot = 0;
    rows.forEach(function (r) { if (r.kind === 'spotting') nSpot++; else nPeriod++; });
    var filter = state.periodFilter || 'all';
    var shown = filter === 'all' ? rows : rows.filter(function (r) { return r.kind === filter; });

    html += '<h2 class="section-title">기록 (' + shown.length + '개)</h2>';
    if (rows.length) {
      var fBtn = function (key, label, n, cls) {
        return '<button class="pf-chip' + (cls ? ' ' + cls : '') + (filter === key ? ' active' : '') +
          '" data-pfilter="' + key + '">' + label + '<span class="pf-n">' + n + '</span></button>';
      };
      html += '<div class="pf-row">' +
        fBtn('all', '전체', rows.length, '') +
        fBtn('period', '생리', nPeriod, 'period') +
        fBtn('spotting', '부정출혈', nSpot, 'spot') +
      '</div>';
    }
    if (!rows.length) {
      html += '<div class="empty">아직 기록이 없어요.<br>달력에서 날짜를 누르거나 위 버튼으로 추가해 주세요.</div>';
    } else if (!shown.length) {
      html += '<div class="empty">' + (filter === 'spotting' ? '부정출혈' : '생리') + ' 기록이 아직 없어요.</div>';
    } else {
      shown.forEach(function (r) {
        var startLabel = esc(fmtKeyShort(r.start).replace(' · 오늘', ''));
        var badge = r.kind === 'spotting'
          ? '<span class="ep-badge spotting">부정출혈</span>'
          : '<span class="ep-badge period">생리</span>';
        var key = r.kind + '|' + r.start + '|' + r.end;
        html +=
          '<div class="swipe-wrap ep-wrap">' +
            '<div class="ep-actions">' +
              '<button class="ep-act edit" data-ep-edit="' + key + '">수정</button>' +
              '<button class="ep-act del" data-ep-del="' + key + '">삭제</button>' +
            '</div>' +
            '<section class="card ep-card swipe-content" role="button" tabindex="0">' +
              '<div class="ep-main">' +
                '<div class="ep-range">' + startLabel + ' ' + badge + '</div>' +
                '<div class="ep-meta">' + r.meta + '</div>' +
              '</div>' +
              '<span class="d-swipe-hint">' + ICON.chevronL + '</span>' +
            '</section>' +
          '</div>';
      });
    }

    app.innerHTML = html;

    document.getElementById('back').addEventListener('click', function () { go('calendar'); });

    // 기록 종류 필터 (전체/생리/부정출혈) — 보기만 바꿈, 데이터엔 영향 없음
    [].forEach.call(app.querySelectorAll('[data-pfilter]'), function (b) {
      b.addEventListener('click', function () {
        state.periodFilter = b.getAttribute('data-pfilter');
        renderPeriod();
      });
    });

    var addBtn = document.getElementById('p-add');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        state.periodAdd = true; state.periodEdit = null;
        renderPeriod();
      });
    }
    var saveBtn = document.getElementById('p-save');
    if (saveBtn) {
      var startEl = document.getElementById('p-start');
      var lenEl = document.getElementById('p-len');
      var prevEl = document.getElementById('p-endpreview');
      var calcEnd = function () {
        var st = startEl.value; var n = parseInt(lenEl.value, 10);
        if (!st || !n || n < 1) return null;
        return addDays(st, n - 1); // 진행 중인 주기는 종료일이 미래여도 기간 그대로 인정
      };
      var updatePreview = function () {
        var e = calcEnd();
        prevEl.textContent = e ? '종료일 ' + fmtKeyShort(e).replace(' · 오늘', '') : '';
      };
      updatePreview();
      startEl.addEventListener('change', updatePreview);
      lenEl.addEventListener('input', updatePreview);
      // 생리 / 부정출혈 선택
      app.querySelectorAll('#p-kind button').forEach(function (kb) {
        kb.addEventListener('click', function () {
          curKind = kb.getAttribute('data-kind');
          app.querySelectorAll('#p-kind button').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-kind') === curKind);
          });
        });
      });
      document.getElementById('p-cancel').addEventListener('click', function () {
        state.periodAdd = false; state.periodEdit = null;
        renderPeriod();
      });
      saveBtn.addEventListener('click', function () {
        var start = startEl.value;
        var n = parseInt(lenEl.value, 10);
        var errEl = document.getElementById('p-error');
        function fail(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }
        if (!start) { fail('시작일을 선택해 주세요.'); return; }
        if (start > tk) { fail('미래 날짜는 기록할 수 없어요.'); return; }
        if (!n || n < 1) { fail('기간(일)을 1 이상으로 입력해 주세요.'); return; }
        if (n > 14) { fail('기간은 최대 14일까지 입력할 수 있어요.'); return; }
        // 시작일은 오늘 이전이어야 하지만, 진행 중인 주기는 종료일이 미래여도 기간을 그대로 인정
        var end = addDays(start, n - 1);
        // 수정이면 원래 종류의 기록을 먼저 지우고(종류 바꿔도 정상 이동), 선택한 종류로 추가
        if (state.periodEdit) {
          if ((state.periodEdit.kind || 'period') === 'spotting') removeSpottingRange(state.periodEdit.start, state.periodEdit.end);
          else removePeriodRange(state.periodEdit.start, state.periodEdit.end);
        }
        if (curKind === 'spotting') addSpottingRange(start, end);
        else addPeriodRange(start, end);
        state.periodAdd = false; state.periodEdit = null;
        renderPeriod();
      });
    }
    // 밀면 카드 뒤에서 수정·삭제 버튼이 함께 드러남 (홈 카드식 스와이프)
    app.querySelectorAll('.ep-wrap').forEach(function (wrap) {
      attachSwipe(wrap, 152, null, false);
    });
    app.querySelectorAll('[data-ep-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = btn.getAttribute('data-ep-edit').split('|'); // kind|start|end
        state.periodEdit = { kind: p[0], start: p[1], end: p[2] };
        state.periodAdd = false;
        renderPeriod();
      });
    });
    app.querySelectorAll('[data-ep-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = btn.getAttribute('data-ep-del').split('|'); // kind|start|end
        var label = p[0] === 'spotting' ? '부정출혈' : '생리';
        if (window.confirm('이 ' + label + ' 기록을 삭제할까요?')) {
          if (p[0] === 'spotting') removeSpottingRange(p[1], p[2]);
          else removePeriodRange(p[1], p[2]);
          state.periodEdit = null;
          renderPeriod();
        }
      });
    });
  }

  /* ===== 설정 ===== */
  function renderSettings() {
    app.className = '';

    var html =
      '<header class="screen-head">' +
        '<h1>설정</h1>' +
        '<p class="sub">약 관리와 앱 환경을 설정해요</p>' +
      '</header>';

    function medMeta(med) {
      return med.type === 'check'
        ? '복용 체크' + (med.maxPerDay ? ' · 1일 최대 ' + med.maxPerDay + med.unit : '')
        : '최소 간격 ' + med.intervalHours + '시간 · 1일 최대 ' + med.maxPerDay + med.unit;
    }
    // 내 약 관리 = 홈에서 트래킹 중인 약 (여기선 수정/삭제만, 추가는 홈에서)
    html += '<div class="settings-group"><h2>내 약 관리</h2>';
    var meds = getMeds();
    if (!meds.length) {
      html += '<p class="settings-note">트래킹 중인 약이 없어요. 홈 화면에서 추가하세요.</p>';
    }
    meds.forEach(function (med) {
      html +=
        '<div class="med-row">' +
          '<div>' +
            '<div class="r-name">' + esc(med.name) + '</div>' +
            '<div class="r-meta">' + medMeta(med) + '</div>' +
          '</div>' +
          '<div class="r-actions">' +
            '<button data-edit="' + esc(med.id) + '">수정</button>' +
            '<button class="danger" data-del="' + esc(med.id) + '">삭제</button>' +
          '</div>' +
        '</div>';
    });
    html += '</div>';

    // 자주 찾는 약 = 홈에서 '약 추가'할 때 고르는 후보 목록 (여기 추가해도 홈엔 안 뜸)
    html += '<div class="settings-group"><h2>자주 찾는 약</h2>';
    var favs = getFavorites();
    html += '<p class="settings-note">홈에서 약을 추가할 때 여기서 골라요. 추가해도 홈엔 바로 뜨지 않아요.</p>';
    favs.forEach(function (f) {
      html +=
        '<div class="med-row">' +
          '<div>' +
            '<div class="r-name">' + esc(f.name) + '</div>' +
            '<div class="r-meta">' + medMeta(f) + '</div>' +
          '</div>' +
          '<div class="r-actions">' +
            '<button class="danger" data-fav-del="' + esc(f.id) + '">삭제</button>' +
          '</div>' +
        '</div>';
    });
    html += '<button class="pill-btn secondary" id="add-fav">+ 자주 찾는 약 추가</button></div>';

    // 화면 테마: 시스템 / 라이트 / 다크
    var curTheme = getTheme();
    function segBtn(v, label) {
      return '<button type="button" data-theme-set="' + v + '" class="' +
        (curTheme === v ? 'active' : '') + '">' + label + '</button>';
    }
    html += '<div class="settings-group"><h2>화면 테마</h2>' +
      '<div class="seg" id="theme-seg">' +
        segBtn('system', '시스템') + segBtn('light', '라이트') + segBtn('dark', '다크') +
      '</div>' +
      '<p class="settings-note">시스템은 폰 설정(라이트/다크)을 따라가요.</p>' +
    '</div>';

    // 생리주기: 기본 꺼짐 — 여기서 켜면 달력에 기록 기능이 나타남
    html += '<div class="settings-group"><h2>달력</h2>' +
      '<button class="toggle-row" id="period-toggle">' +
        '<div><div class="m-title">생리주기 기능</div>' +
        '<div class="m-desc">달력에서 생리 기록·예측 사용</div></div>' +
        '<span class="switch' + (isPeriodOn() ? ' on' : '') + '"></span>' +
      '</button></div>';

    html += '<div class="settings-group"><h2>데이터 백업</h2>' +
      '<div class="backup-actions">' +
        '<button class="pill-btn secondary" id="export-data">' + ICON.download + '내보내기</button>' +
        '<button class="pill-btn secondary" id="import-data">' + ICON.upload + '불러오기</button>' +
      '</div>' +
      '<input type="file" id="import-file" accept="application/json,.json" hidden>' +
      '<p class="settings-note">기록을 파일 하나로 저장/복원해요. <b>내보내기</b> → \'파일에 저장\'으로 백업, ' +
      '<b>불러오기</b> → 저장한 파일 선택으로 복원. 기기를 바꿔도 그대로 옮겨져요.</p>' +
    '</div>';

    html +=
      '<p class="settings-note">모든 데이터는 이 기기의 브라우저에만 저장돼요. 서버로 전송되지 않아요.<br>' +
      '이 앱은 사용자가 등록한 간격·최대치·날짜를 기준으로 계산만 해요.</p>';

    html += bottomNavHtml('settings');
    app.innerHTML = html;

    bindBottomNav();

    app.querySelectorAll('[data-theme-set]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        storage.set(KEY.theme, btn.getAttribute('data-theme-set'));
        applyTheme();
        renderSettings();
      });
    });
    document.getElementById('period-toggle').addEventListener('click', function () {
      storage.set(KEY.periodOn, !isPeriodOn());
      renderSettings();
    });
    document.getElementById('export-data').addEventListener('click', exportData);
    var impFile = document.getElementById('import-file');
    document.getElementById('import-data').addEventListener('click', function () { impFile.click(); });
    impFile.addEventListener('change', function () {
      var f = impFile.files && impFile.files[0];
      if (!f) return;
      if (!window.confirm('현재 기록을 이 파일 내용으로 덮어써요. 계속할까요?\n(먼저 내보내기로 백업해두면 안전해요)')) {
        impFile.value = '';
        return;
      }
      importData(f, function (ok, msg) {
        impFile.value = '';
        if (ok) { applyTheme(); window.alert('불러오기 완료!'); go('home'); }
        else { window.alert('불러오기 실패: ' + msg); }
      });
    });
    document.getElementById('add-fav').addEventListener('click', function () {
      go('medForm', { editMedId: null, favMode: true, returnTo: 'settings' });
    });
    app.querySelectorAll('[data-fav-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-fav-del');
        var f = getFavorites().filter(function (x) { return x.id === id; })[0];
        if (f && window.confirm('자주 찾는 약에서 "' + f.name + '"을(를) 뺄까요?')) {
          saveFavorites(getFavorites().filter(function (x) { return x.id !== id; }));
          renderSettings();
        }
      });
    });
    app.querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        go('medForm', { editMedId: btn.getAttribute('data-edit'), returnTo: 'settings' });
      });
    });
    app.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var med = medById(btn.getAttribute('data-del'));
        if (med && window.confirm('"' + med.name + '"을(를) 삭제할까요?\n복용 이력은 남아있어요.')) {
          saveMeds(getMeds().filter(function (mm) { return mm.id !== med.id; }));
          renderSettings();
        }
      });
    });
  }

  /* ===== 약 추가/수정 폼 ===== */
  function renderMedForm() {
    app.className = 'no-nav';
    var editing = state.editMedId ? medById(state.editMedId) : null;
    var curType = editing ? (editing.type || 'interval') : 'interval';
    // 설정에서 여는 '자주 찾는 약 추가' 모드(mt.favorites에 저장, 홈엔 안 뜸)
    var favMode = !!state.favMode;
    // 수정·자주찾는약추가에선 기록 방식 토글 없이 '간격 유무'로 타입 자동 판단(간격 있으면 트래킹, 비우면 매일 체크)
    var inferMode = editing || favMode;
    var CATALOG = comboList(); // 자주 찾는 약(맨 위) + 기본 목록
    var favCount = getFavorites().length; // 앞쪽 favCount개가 '자주 찾는 약'

    // 약 이름: 직접 만든 콤보(검색 + 목록 선택). datalist가 iOS에서 안 뜨는 문제 대응
    var nameFieldHtml =
      '<div class="form-field">' +
        '<label for="f-name">약 이름</label>' +
        '<div class="combo" id="name-combo">' +
          '<input id="f-name" type="text" autocomplete="off" ' +
            'placeholder="약 이름 검색 또는 직접 입력" value="' + (editing ? esc(editing.name) : '') + '">' +
          '<button type="button" class="combo-caret" id="name-caret" aria-label="약 목록 열기">' + ICON.chevron + '</button>' +
          '<ul class="combo-list" id="name-list" hidden>' +
            CATALOG.map(function (c, i) {
              var isFav = i < favCount;
              return '<li data-cat="' + i + '"' + (isFav ? ' class="fav"' : '') + '>' +
                (isFav ? '<span class="fav-star">★</span>' : '') + esc(c.name) + '</li>';
            }).join('') +
          '</ul>' +
        '</div>' +
        (editing ? '' : '<p class="form-hint">목록에서 고르면 간격·최대치·단위가 자동 입력돼요. 없는 약은 그냥 이름을 입력하세요.</p>') +
      '</div>';

    // 단위: 직접 입력 대신 선택
    var UNITS = ['정', '캡슐', '포', '회'];
    var curUnit = editing ? editing.unit : '정';
    if (UNITS.indexOf(curUnit) < 0) UNITS.unshift(curUnit); // 기존 커스텀 단위 보존
    var unitOptions = UNITS.map(function (u) {
      return '<option value="' + esc(u) + '"' + (u === curUnit ? ' selected' : '') + '>' + esc(u) + '</option>';
    }).join('');

    app.innerHTML =
      '<div class="back-head">' +
        '<button id="back" aria-label="뒤로">←</button>' +
        '<h1>' + (editing ? '약 수정' : (favMode ? '자주 찾는 약 추가' : '약 추가')) + '</h1>' +
      '</div>' +
      '<div class="card">' +
        nameFieldHtml +
        // 기록 방식은 '홈 약 추가'에서만 선택. 수정·자주찾는약추가에선 감춤(간격 유무로 자동 판단)
        (editing || favMode ? '' :
          '<div class="form-field">' +
            '<label>기록 방식</label>' +
            '<div class="type-select">' +
              '<button type="button" data-type="interval" class="' + (curType === 'interval' ? 'active' : '') + '">' +
                '<b>간격 트래커</b><span>다음 복용 가능 시각 계산</span></button>' +
              '<button type="button" data-type="check" class="' + (curType === 'check' ? 'active' : '') + '">' +
                '<b>복용 체크</b><span>먹었는지만 기록</span></button>' +
            '</div>' +
          '</div>') +
        '<div class="form-row">' +
          '<div class="form-field" id="field-interval">' +
            '<label for="f-interval">최소 간격 (시간)</label>' +
            '<input id="f-interval" type="number" inputmode="decimal" min="0.5" step="0.5" placeholder="4" value="' + (editing && editing.intervalHours != null ? editing.intervalHours : '') + '">' +
          '</div>' +
          '<div class="form-field">' +
            '<label for="f-max" id="label-max">1일 최대 (개수)</label>' +
            '<input id="f-max" type="number" inputmode="numeric" min="1" step="1" placeholder="8" value="' + (editing && editing.maxPerDay != null ? editing.maxPerDay : '') + '">' +
          '</div>' +
          '<div class="form-field form-unit">' +
            '<label for="f-unit">단위</label>' +
            '<select id="f-unit">' + unitOptions + '</select>' +
          '</div>' +
        '</div>' +
        (inferMode ? '<p class="form-hint">최소 간격을 넣으면 \'간격 트래커\', 비우면 \'복용 체크\'(매일 먹었는지만 기록)가 돼요.</p>' : '') +
        '<p class="form-error" id="form-error"></p>' +
        '<div class="form-actions">' +
          '<button type="button" class="pill-btn secondary" id="cancel">취소</button>' +
          '<button type="button" class="pill-btn" id="save">저장</button>' +
        '</div>' +
      '</div>';

    var typeButtons = app.querySelectorAll('.type-select button');
    function setType(t) {
      curType = t;
      typeButtons.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-type') === t); });
      applyTypeUI();
    }
    function applyTypeUI() {
      // 수정·간단추가에선 간격칸을 항상 보이게(비우면 매일 체크로 전환 가능)
      document.getElementById('field-interval').style.display = (inferMode || curType === 'interval') ? '' : 'none';
      document.getElementById('label-max').textContent = curType === 'interval' ? '1일 최대 (개수)' : '1일 최대 (선택)';
    }
    typeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () { setType(btn.getAttribute('data-type')); });
    });
    applyTypeUI();

    // 약 이름 콤보: 목록 선택/검색 + 직접 입력
    var nameInput = document.getElementById('f-name');
    var nameList = document.getElementById('name-list');
    var nameCaret = document.getElementById('name-caret');
    function fillFromCatalog(c) {
      nameInput.value = c.name;
      document.getElementById('f-interval').value = c.intervalHours != null ? c.intervalHours : '';
      document.getElementById('f-max').value = c.maxPerDay != null ? c.maxPerDay : '';
      var unitSel = document.getElementById('f-unit');
      if (![].some.call(unitSel.options, function (o) { return o.value === c.unit; })) {
        unitSel.add(new Option(c.unit, c.unit));
      }
      unitSel.value = c.unit;
      setType(c.type || 'interval');
    }
    function renderNameList(filter) {
      var f = (filter || '').trim().toLowerCase();
      var any = false;
      [].forEach.call(nameList.children, function (li) {
        var nm = CATALOG[Number(li.getAttribute('data-cat'))].name.toLowerCase();
        var show = !f || nm.indexOf(f) >= 0;
        li.hidden = !show;
        if (show) any = true;
      });
      nameList.hidden = !any;
    }
    nameCaret.addEventListener('click', function (e) {
      e.preventDefault();
      if (nameList.hidden) { renderNameList(''); } else { nameList.hidden = true; }
    });
    nameInput.addEventListener('focus', function () { renderNameList(nameInput.value); });
    nameInput.addEventListener('input', function () {
      renderNameList(nameInput.value);
      var c = CATALOG.find(function (m) { return m.name === nameInput.value; });
      if (c) fillFromCatalog(c); // 이름이 정확히 일치하면 자동 입력
    });
    nameList.addEventListener('click', function (e) {
      var li = e.target.closest('[data-cat]');
      if (!li) return;
      fillFromCatalog(CATALOG[Number(li.getAttribute('data-cat'))]);
      nameList.hidden = true;
    });
    document.addEventListener('click', function (e) {
      var combo = document.getElementById('name-combo');
      if (combo && !e.target.closest('#name-combo')) nameList.hidden = true;
    });

    document.getElementById('back').addEventListener('click', backFromForm);
    document.getElementById('cancel').addEventListener('click', backFromForm);
    document.getElementById('save').addEventListener('click', function () {
      var name = document.getElementById('f-name').value.trim();
      var interval = parseFloat(document.getElementById('f-interval').value);
      var maxRaw = document.getElementById('f-max').value;
      var max = parseInt(maxRaw, 10);
      var unit = document.getElementById('f-unit').value.trim() || '정';

      // 인라인 오류 표시 (alert가 막히는 환경에서도 반응이 보이도록)
      var errEl = document.getElementById('form-error');
      function fail(msg, fieldId) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
        var f = document.getElementById(fieldId);
        if (f) f.focus();
      }
      errEl.style.display = 'none';

      // 수정·간단추가에선 간격 유무로 방식 자동 판단(간격 있으면 트래킹, 비우면 매일 체크)
      var effType = inferMode ? (interval > 0 ? 'interval' : 'check') : curType;

      if (!name) { fail('약 이름을 검색하거나 직접 입력해 주세요.', 'f-name'); return; }
      if (effType === 'interval') {
        if (!(interval > 0)) { fail('최소 간격(시간)을 입력해 주세요.', 'f-interval'); return; }
        if (!(max > 0)) { fail('1일 최대 개수를 입력해 주세요.', 'f-max'); return; }
      } else {
        interval = null;
        max = maxRaw && max > 0 ? max : null;
      }

      var record = {
        id: editing ? editing.id : uid(),
        name: name, unit: unit, type: effType,
        intervalHours: interval, maxPerDay: max
      };
      if (favMode) {
        // '자주 찾는 약'은 mt.favorites에만 저장 — 홈(트래킹 약)엔 영향 없음
        var favs = getFavorites();
        favs.push(record);
        saveFavorites(favs);
      } else {
        var meds = getMeds();
        if (editing) meds = meds.map(function (mm) { return mm.id === editing.id ? record : mm; });
        else meds.push(record);
        saveMeds(meds);
      }
      backFromForm();
    });

    function backFromForm() {
      if (state.returnTo === 'medDetail' && state.detailMedId) go('medDetail', {});
      else if (state.returnTo === 'settings') go('settings');
      else go('home');
    }
  }

  /* ===== 하단 내비 ===== */
  // Lucide 아이콘 (viewBox 24, stroke 2, round)
  function lucide(inner, cls) {
    return '<svg class="lucide' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  var ICON = {
    // pill (lucide) — 아래쪽 절반만 아이콘 색의 저투명도로 채워 은은한 fill 느낌
    pillPlus: lucide('<path d="M15.5 15.5 10.5 20.5a4.95 4.95 0 0 1-7-7l5-5Z" fill="currentColor" fill-opacity="0.22" stroke="none"/><path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>', 'btn-ico'),
    // check (lucide)
    check: lucide('<path d="M20 6 9 17l-5-5"/>', 'btn-ico'),
    // pencil (lucide)
    edit: lucide('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'),
    // trash-2 (lucide)
    trash: lucide('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'),
    // house (lucide)
    home: lucide('<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    // calendar-days (lucide)
    cal: lucide('<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>'),
    // settings-2 / sliders (lucide)
    gear: lucide('<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>'),
    // chevron-down (lucide)
    chevron: lucide('<path d="m6 9 6 6 6-6"/>'),
    // chevron-left (lucide)
    chevronL: lucide('<path d="m15 18-6-6 6-6"/>'),
    // download (lucide) — 내보내기
    download: lucide('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
    // upload (lucide) — 불러오기
    upload: lucide('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'),
    // arrow-up-down (lucide) — 정렬 버튼
    sort: lucide('<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>', 'btn-ico'),
    // grip-vertical (lucide) — 드래그 핸들 느낌
    grip: lucide('<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>'),
    // chevron-up / down (lucide) — 순서 이동
    arrowUp: lucide('<path d="m18 15-6-6-6 6"/>'),
    arrowDown: lucide('<path d="m6 9 6 6 6-6"/>')
  };

  function bottomNavHtml(active) {
    function item(key, ico, label) {
      return '<button data-nav="' + key + '" class="' + (active === key ? 'active' : '') + '">' +
        ico + label + '</button>';
    }
    return '<nav class="bottom-nav">' +
      item('home', ICON.home, '홈') +
      item('calendar', ICON.cal, '달력') +
      item('settings', ICON.gear, '설정') +
      '</nav>';
  }
  function bindBottomNav() {
    app.querySelectorAll('[data-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        go(btn.getAttribute('data-nav'));
      });
    });
  }

  /* ===== 시작 ===== */
  migrate();
  applyTheme();
  render();

  // 시스템 테마 변경 추종 (테마가 '시스템'일 때만 상태바 색 갱신)
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (getTheme() === 'system') applyTheme();
    });
  }

  // 탭 복귀 시 화면 갱신 (자정 넘김·백그라운드 경과 반영)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) render();
  });

  // 서비스워커 등록 (미리보기 등 지원 안 되는 환경은 조용히 통과)
  if ('serviceWorker' in navigator) {
    // 새 버전이 제어를 넘겨받으면 한 번 자동 새로고침해 최신 화면 적용
    var hadController = !!navigator.serviceWorker.controller;
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing || !hadController) return; // 첫 설치 시엔 새로고침 안 함
      refreshing = true;
      window.location.reload();
    });
    var swReg = null;
    function checkForUpdate() {
      if (swReg && swReg.update) { try { swReg.update(); } catch (e) { /* noop */ } }
    }
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').then(function (reg) {
        swReg = reg;
        checkForUpdate(); // 새 배포를 최대한 빨리 확인
      }).catch(function () { /* noop */ });
    });
    // 앱을 다시 열거나 포그라운드로 돌아올 때마다 업데이트 확인 (PWA에서 새 버전이 잘 잡히도록)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
    window.addEventListener('focus', checkForUpdate);
  }
})();
