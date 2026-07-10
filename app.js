/* 복약 트래커 — Vanilla JS, localStorage 전용 */
(function () {
  'use strict';

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
    mode: 'mt.mode',          // 'tracker' | 'simple'
    meds: 'mt.meds',          // [{id, name, unit, type, intervalHours, maxPerDay}]
    doses: 'mt.doses',        // [{id, medId, ts}]
    checks: 'mt.checks',      // [{slot, ts, dateKey}]
    period: 'mt.period',      // ['YYYY-MM-DD', ...] 생리로 표시한 날
    periodOn: 'mt.periodOn',  // 달력에 생리주기 기능 표시 여부
    migr: 'mt.migr'           // 데이터 마이그레이션 버전
  };

  // type: 'interval' = 간격 트래커(다음 복용 가능 계산) / 'check' = 복용 체크(먹었는지만)
  var PRESET_MEDS = [
    { id: 'preset-tylenol', name: '타이레놀 500mg', unit: '정', type: 'interval', intervalHours: 4, maxPerDay: 8 },
    { id: 'preset-ezn6pro', name: '이지엔6프로', unit: '캡슐', type: 'interval', intervalHours: 4, maxPerDay: 4 }
  ];

  var SLOTS = [
    { key: 'morning', label: '아침' },
    { key: 'lunch', label: '점심' },
    { key: 'dinner', label: '저녁' }
  ];

  var UNDO_WINDOW_MS = 10 * 60 * 1000; // 복용 기록 후 10분간 취소 표시

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
    // 24시간제 H:MM:SS (한글 오전/오후 없이 글자 폭 축소)
    var d = new Date(ts);
    return d.getHours() + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
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
  function getMode() { return storage.get(KEY.mode, null); }
  function setMode(m) { storage.set(KEY.mode, m); }

  function getMeds() {
    if (!storage.has(KEY.meds)) {
      storage.set(KEY.meds, PRESET_MEDS);
      return PRESET_MEDS.slice();
    }
    return storage.get(KEY.meds, []);
  }
  function saveMeds(meds) { storage.set(KEY.meds, meds); }
  function medById(id) {
    return getMeds().find(function (m) { return m.id === id; }) || null;
  }

  // 기존 저장 데이터 보정: type 기본값, 이지엔6프로 최대치(허가 용량 1일 4캡슐) 수정
  function migrate() {
    var ver = storage.get(KEY.migr, 0);
    if (ver >= 2) return;
    if (storage.has(KEY.meds)) {
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
    storage.set(KEY.migr, 2);
  }

  function getDoses() { return storage.get(KEY.doses, []); }
  function saveDoses(doses) { storage.set(KEY.doses, doses); }

  function getChecks() { return storage.get(KEY.checks, []); }
  function saveChecks(checks) { storage.set(KEY.checks, checks); }

  function isPeriodOn() { return storage.get(KEY.periodOn, true); }

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

  function checkForSlot(slotKey) {
    var tk = todayKey();
    return getChecks().find(function (c) {
      return c.slot === slotKey && c.dateKey === tk;
    }) || null;
  }
  function logCheck(slotKey) {
    if (checkForSlot(slotKey)) return;
    var checks = getChecks();
    checks.push({ slot: slotKey, ts: Date.now(), dateKey: todayKey() });
    saveChecks(checks);
  }
  function undoCheck(slotKey) {
    var tk = todayKey();
    saveChecks(getChecks().filter(function (c) {
      return !(c.slot === slotKey && c.dateKey === tk);
    }));
  }
  // 성공 시 true, 미래 시각이면 저장하지 않고 false
  function setCheckTime(slotKey, hhmm) {
    var tk = todayKey();
    var target = getChecks().find(function (c) { return c.slot === slotKey && c.dateKey === tk; });
    if (!target) return true;
    var newTs = applyTimeToTs(target.ts, hhmm);
    if (newTs > Date.now()) return false;
    saveChecks(getChecks().map(function (c) {
      return (c.slot === slotKey && c.dateKey === tk)
        ? { slot: c.slot, ts: newTs, dateKey: c.dateKey }
        : c;
    }));
    return true;
  }
  function lastCheckToday() {
    var tk = todayKey();
    var todays = getChecks().filter(function (c) { return c.dateKey === tk; });
    if (!todays.length) return null;
    return todays.reduce(function (a, b) { return a.ts > b.ts ? a : b; });
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
  function periodEpisodes() {
    var days = getPeriodDays().slice().sort();
    var eps = [];
    days.forEach(function (k) {
      var cur = eps[eps.length - 1];
      if (cur && diffDays(cur.end, k) === 1) cur.end = k;
      else eps.push({ start: k, end: k });
    });
    return eps;
  }
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
      stats.nextStart = nextStart;
      for (var d = 0; d < avgLen; d++) stats.predDays.push(addDays(nextStart, d));
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
    selKey: todayKey()
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
    state.timeEdit = null;
    state.periodAdd = false;
    state.doseAdd = false;
    render();
  }

  function render() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    var mode = getMode();
    if (!mode) { renderOnboarding(); return; }

    switch (state.screen) {
      case 'settings': renderSettings(); break;
      case 'medForm': renderMedForm(); break;
      case 'calendar': renderCalendar(); break;
      case 'medDetail': renderMedDetail(); break;
      case 'period':
        if (isPeriodOn()) { renderPeriod(); }
        else { state.screen = 'home'; render(); }
        break;
      default:
        if (mode === 'simple') renderSimpleHome();
        else renderTrackerHome();
    }
  }

  /* ===== 온보딩 ===== */
  function renderOnboarding() {
    app.className = 'no-nav';
    app.innerHTML =
      '<div class="onboard">' +
        '<img class="logo" src="./icons/icon.svg" alt="">' +
        '<h1>어떤 기능이 필요하세요?</h1>' +
        '<p class="sub">언제든 설정에서 바꿀 수 있어요</p>' +
        '<button class="choice-card" data-mode="tracker">' +
          '<span class="c-title"><span class="dot"></span>다음 약 먹을 시간을 계산하고 싶어요</span>' +
          '<span class="c-desc">등록한 복용 간격과 하루 최대치를 기준으로 다음 복용 가능 시각을 알려드려요</span>' +
        '</button>' +
        '<button class="choice-card" data-mode="simple">' +
          '<span class="c-title"><span class="dot"></span>약을 먹었는지만 확인하고 싶어요</span>' +
          '<span class="c-desc">아침 · 점심 · 저녁 큰 버튼을 한 번만 누르면 돼요</span>' +
        '</button>' +
      '</div>';

    app.querySelectorAll('.choice-card').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setMode(btn.getAttribute('data-mode'));
        go('home');
      });
    });
  }

  /* ===== 간격 트래커 홈 ===== */
  function renderTrackerHome() {
    app.className = '';
    var meds = getMeds();

    var html =
      '<header class="screen-head">' +
        '<h1>복약 트래커</h1>' +
        '<p class="sub">' + esc(fmtDateLong(Date.now())) + '</p>' +
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
    bindBottomNav();

    tickTimer = setInterval(function () {
      if (state.screen === 'home' && !state.timeEdit) renderTrackerHome();
    }, 30000);
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

  // 홈 카드용 소형 링 — 원 안엔 시각(H:MM:SS), 원 밖엔 남은 시간(n시간 n분)
  function buildIntervalRing(med, sizeClass) {
    var s = computeInterval(med);
    var innerLabel, innerTime, centerCls, statusLine;
    if (s.reached) {
      centerCls = ' max';
      innerLabel = s.last ? '마지막' : '';
      innerTime = s.last ? esc(fmtTime(s.last.ts)) : '오늘<br>최대';
      statusLine = '<span class="hl">오늘 최대</span>';
    } else if (s.ready) {
      centerCls = ' ready';
      if (s.last) {
        innerLabel = '마지막'; innerTime = esc(fmtTime(s.last.ts));
        statusLine = '<span class="hl">지금 복용 가능</span>';
      } else {
        innerLabel = ''; innerTime = '지금<br>가능';
        statusLine = '아직 복용 기록이 없어요';
      }
    } else {
      centerCls = '';
      innerLabel = '다음';
      innerTime = esc(fmtTime(s.last.ts + s.intervalMs));
      statusLine = '<span class="hl">' + esc(remainLabel(s.remainMs, false)) + ' 남음</span>';
    }
    var ringCenter =
      '<div class="ring-center' + centerCls + '">' +
        (innerLabel ? '<div class="rc-label">' + innerLabel + '</div>' : '') +
        '<div class="rc-time">' + innerTime + '</div>' +
      '</div>';
    var ringHtml =
      '<div class="ring-wrap' + (sizeClass ? ' ' + sizeClass : '') + '">' +
        ringSvg(s) + ringCenter +
      '</div>';
    return { ringHtml: ringHtml, statusLine: statusLine, ready: s.ready, reached: s.reached };
  }

  // 상세용 대형 히어로 링 (가운데 시각 H:MM:SS 크게 + 먹었어요 버튼 내장)
  function buildDetailHero(med) {
    var s = computeInterval(med);
    var topLabel, bigTime, subLabel, cls;
    if (s.reached) {
      cls = ' hl'; topLabel = '오늘 최대';
      bigTime = s.last ? fmtTime(s.last.ts) : '';
      subLabel = s.last ? '마지막 복용' : '';
    } else if (s.ready) {
      cls = ' hl'; topLabel = '지금 복용 가능';
      bigTime = s.last ? fmtTime(s.last.ts) : '';
      subLabel = s.last ? '마지막 복용' : '기록 없음';
    } else {
      cls = ''; topLabel = '다음 복용 가능';
      bigTime = fmtTime(s.last.ts + s.intervalMs);
      subLabel = remainLabel(s.remainMs, false) + ' 남음';
    }
    return (
      '<div class="hero-ring">' +
        ringSvg(s) +
        '<div class="hero-center">' +
          '<div class="hero-label' + cls + '">' + topLabel + '</div>' +
          (bigTime ? '<div class="hero-big">' + esc(bigTime) + '</div>' : '') +
          (subLabel ? '<div class="hero-sub">' + esc(subLabel) + '</div>' : '') +
          '<button class="pill-btn hero-log" id="detail-log">' + ICON.pillPlus + '먹었어요</button>' +
        '</div>' +
      '</div>'
    );
  }

  function medCardHtml(med) {
    var isCheck = med.type === 'check';
    var todays = todayDosesForMed(med.id);

    var reached = med.maxPerDay ? todays.length >= med.maxPerDay : false;
    var exceeded = med.maxPerDay ? todays.length > med.maxPerDay : false;
    var badge = med.maxPerDay
      ? '오늘 ' + todays.length + '/' + med.maxPerDay
      : '오늘 ' + todays.length + '회';

    var logBtn = '<button class="pill-btn compact" data-log="' + esc(med.id) + '">' + ICON.pillPlus + '먹었어요</button>';
    var titleRow =
      '<div class="mc-title">' +
        '<span class="med-name">' + esc(med.name) + '</span>' +
        '<span class="badge' + (reached ? ' filled' : '') + '">' + badge + '</span>' +
      '</div>';
    var actionsRow = '<div class="mc-actions">' + logBtn + '</div>';

    var statusLine = '';
    var ringHtml = '';
    if (isCheck) {
      var todayLast = todays.length
        ? todays.reduce(function (a, b) { return a.ts > b.ts ? a : b; })
        : null;
      statusLine = todayLast
        ? '<span class="ok">✓</span> 오늘 드셨어요 · ' + esc(fmtTime(todayLast.ts))
        : '오늘 아직 기록이 없어요';
    } else {
      var rv = buildIntervalRing(med, 'sm');
      ringHtml = rv.ringHtml;
      statusLine = rv.statusLine;
    }

    var warn = '';
    if (exceeded) {
      warn = '<div class="warn-banner">오늘 최대치 ' + med.maxPerDay + med.unit + ' 초과 — 현재 ' + todays.length + med.unit + '</div>';
    }

    return (
      '<section class="card med-card" data-med="' + esc(med.id) + '" role="button" tabindex="0">' +
        '<div class="mc-row">' +
          ringHtml +
          '<div class="mc-main">' +
            titleRow +
            (statusLine ? '<p class="status-line">' + statusLine + '</p>' : '') +
            actionsRow +
          '</div>' +
        '</div>' +
        warn +
      '</section>'
    );
  }

  function bindMedCards() {
    app.querySelectorAll('[data-med]').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('button') || e.target.closest('input')) return;
        go('medDetail', { detailMedId: card.getAttribute('data-med') });
      });
    });
    app.querySelectorAll('[data-log]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        logDose(btn.getAttribute('data-log'));
        state.timeEdit = null;
        renderTrackerHome();
      });
    });
  }

  /* ===== 약 상세 ===== */
  function renderMedDetail() {
    var med = medById(state.detailMedId);
    if (!med) { go('home'); return; }
    app.className = 'no-nav';

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
      var checkStatus = todayLastD
        ? '<p class="detail-status"><b class="hl">오늘 드셨어요</b> · ' + esc(fmtTime(todayLastD.ts)) + '</p>'
        : '<p class="detail-status">오늘 아직 기록이 없어요</p>';
      topCard =
        '<div class="card">' +
          summary + checkStatus +
          '<div class="status-actions">' +
            '<button class="pill-btn compact" id="detail-log">' + ICON.pillPlus + '먹었어요</button>' +
          '</div>' +
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
          listHtml +=
            '<div class="dose-row">' +
              '<span class="d-time">' + esc(fmtTime(d.ts)) + '</span>' +
              '<span class="d-actions">' +
                '<button class="ico-btn" data-md-edit="' + esc(d.id) + '" aria-label="시간 수정">' + ICON.edit + '</button>' +
                '<button class="ico-btn danger" data-md-del="' + esc(d.id) + '" aria-label="삭제">' + ICON.trash + '</button>' +
              '</span>' +
            '</div>';
        }
      });
    }

    // 지난 복용 기록을 날짜·시각 지정해 직접 추가하는 폼
    var nowD = new Date();
    var addForm = state.doseAdd
      ? '<div class="card">' +
          '<div class="form-row">' +
            '<div class="form-field"><label for="da-date">날짜</label>' +
              '<input id="da-date" type="date" max="' + todayKey() + '" value="' + todayKey() + '"></div>' +
            '<div class="form-field"><label for="da-time">시각</label>' +
              '<input id="da-time" type="time" step="1" value="' + timeInputValue(nowD.getTime()) + '"></div>' +
          '</div>' +
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
          '<button class="ico-btn sm" id="edit-med-info" aria-label="약 정보 수정">' + ICON.edit + '</button>' +
        '</div>' +
      '</div>' +
      topCard +
      '<div class="section-head">' +
        '<h2 class="section-title">복용 내역 (최근 30일)</h2>' +
        (state.doseAdd ? '' : '<button class="text-btn" id="dose-add-btn">+ 기록 추가</button>') +
      '</div>' +
      addForm +
      '<div class="card">' + listHtml + '</div>';

    document.getElementById('back').addEventListener('click', function () { go('home'); });
    document.getElementById('detail-log').addEventListener('click', function () {
      logDose(med.id);
      renderMedDetail();
    });
    document.getElementById('edit-med-info').addEventListener('click', function () {
      go('medForm', { editMedId: med.id, returnTo: 'medDetail' });
    });
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
  }

  /* ===== 심플 체크 홈 ===== */
  function renderSimpleHome() {
    app.className = 'no-nav';
    var last = lastCheckToday();
    var slotLabel = '';
    if (last) {
      var slot = SLOTS.find(function (s) { return s.key === last.slot; });
      slotLabel = slot ? slot.label : '';
    }

    var lastHtml = last
      ? '<div class="last-taken">' +
          '<div class="label">마지막으로 드신 시간</div>' +
          '<div class="time">' + esc(fmtTime(last.ts)) + '</div>' +
          '<div class="when">오늘 ' + esc(slotLabel) + ' 약</div>' +
        '</div>'
      : '<div class="last-taken none">' +
          '<div class="label">마지막으로 드신 시간</div>' +
          '<div class="time">오늘은 아직<br>기록이 없어요</div>' +
        '</div>';

    var slotsHtml = '';
    SLOTS.forEach(function (s) {
      var check = checkForSlot(s.key);
      slotsHtml +=
        '<button class="slot-btn' + (check ? ' checked' : '') + '" data-slot="' + s.key + '"' +
          (check ? ' disabled' : '') + '>' +
          '<span class="slot-name">' + s.label + ' 약</span>' +
          '<span class="slot-state">' + (check ? esc(fmtTime(check.ts)) + ' 드셨어요' : '누르면 기록돼요') + '</span>' +
        '</button>';
      if (check) {
        var fixing = state.timeEdit && state.timeEdit.kind === 'check' && state.timeEdit.id === s.key;
        if (fixing) {
          slotsHtml +=
            '<div class="slot-fix">' +
              '<div class="time-edit">' +
                '<input type="time" step="1" id="te-input" value="' + timeInputValue(check.ts) + '">' +
                '<button class="pill-btn" data-fix-save="' + s.key + '">저장</button>' +
              '</div>' +
            '</div>';
        } else {
          slotsHtml +=
            '<div class="slot-undo">' +
              '<button data-fix-time="' + s.key + '">시간 고치기</button>' +
              '<button data-uncheck="' + s.key + '">잘못 눌렀어요? 취소</button>' +
            '</div>';
        }
      }
    });

    app.innerHTML =
      '<div class="simple">' +
        '<div class="simple-top">' +
          '<div class="simple-date">' + esc(fmtDateLong(Date.now())) + '</div>' +
          '<button class="gear-btn" id="open-settings" aria-label="설정">' + ICON.gear + '</button>' +
        '</div>' +
        lastHtml +
        slotsHtml +
      '</div>';

    app.querySelectorAll('[data-slot]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        logCheck(btn.getAttribute('data-slot'));
        state.timeEdit = null;
        renderSimpleHome();
      });
    });
    app.querySelectorAll('[data-uncheck]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        undoCheck(btn.getAttribute('data-uncheck'));
        state.timeEdit = null;
        renderSimpleHome();
      });
    });
    app.querySelectorAll('[data-fix-time]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.timeEdit = { kind: 'check', id: btn.getAttribute('data-fix-time') };
        renderSimpleHome();
      });
    });
    app.querySelectorAll('[data-fix-save]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var val = document.getElementById('te-input').value;
        if (val && !setCheckTime(btn.getAttribute('data-fix-save'), val)) {
          window.alert('지금보다 미래 시각으로는 저장할 수 없어요.');
          return;
        }
        state.timeEdit = null;
        renderSimpleHome();
      });
    });
    document.getElementById('open-settings').addEventListener('click', function () {
      go('settings');
    });
  }

  /* ===== 달력 ===== */
  function renderCalendar() {
    app.className = '';
    var periodOn = isPeriodOn();
    var stats = periodOn ? cycleStats() : null;
    var periodSet = {};
    if (periodOn) {
      getPeriodDays().forEach(function (k) { periodSet[k] = true; });
    }
    var predSet = {};
    if (stats && stats.predDays) {
      stats.predDays.forEach(function (k) { predSet[k] = true; });
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
      else if (predSet[k]) cls += ' pred';
      if (k === state.selKey) cls += ' sel';
      html += '<button class="' + cls + '" data-day="' + k + '">' + day +
        (doseCount[k] ? '<span class="dd"></span>' : '') + '</button>';
    }
    html += '</div></div>';

    html += dayPanelHtml(state.selKey, periodOn, periodSet);
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

  function dayPanelHtml(key, periodOn, periodSet) {
    var meds = getMeds();
    var medMap = {};
    meds.forEach(function (mm) { medMap[mm.id] = mm; });

    var doses = getDoses().filter(function (d) { return dateKey(d.ts) === key; })
      .sort(function (a, b) { return a.ts - b.ts; });

    var html = '<section class="card day-panel">' +
      '<div class="dp-head">' +
        '<div class="dp-title">' + esc(fmtKeyShort(key)) + '</div>' +
        (periodOn
          ? '<button class="period-toggle' + (periodSet[key] ? ' on' : '') + '" data-period-toggle>' +
              (periodSet[key] ? '생리 기록됨 · 지우기' : '+ 생리 기록') + '</button>'
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
          html +=
            '<div class="dose-row">' +
              '<span class="d-name">' + esc(med ? med.name : '삭제된 약') + '</span>' +
              '<span class="d-time">' + esc(fmtTime(d.ts)) + '</span>' +
              '<span class="d-actions">' +
                '<button class="ico-btn" data-dp-edit="' + esc(d.id) + '" aria-label="시간 수정">' + ICON.edit + '</button>' +
                '<button class="ico-btn danger" data-dp-del="' + esc(d.id) + '" aria-label="삭제">' + ICON.trash + '</button>' +
              '</span>' +
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
      html +=
        '<div class="card">' +
          '<div class="detail-stats">' +
            '<div class="ds-item"><div class="ds-num">' + ddLabel + '</div><div class="ds-label">다음 예정일</div></div>' +
            '<div class="ds-item"><div class="ds-num">' + stats.avgCycle + '일</div><div class="ds-label">평균 주기</div></div>' +
            '<div class="ds-item"><div class="ds-num">' + avgLen + '일</div><div class="ds-label">평균 기간</div></div>' +
          '</div>' +
          '<p class="detail-status">다음 예정일 <b>' + esc(fmtKeyShort(stats.nextStart).replace(' · 오늘', '')) + '</b> · 최근 기록 평균 기준</p>' +
        '</div>';
    } else {
      html +=
        '<div class="cycle-info"><span class="dot"></span>기록이 2번 이상 쌓이면 다음 예정일을 계산해요</div>';
    }

    // 기록 추가
    if (state.periodAdd) {
      html +=
        '<div class="card">' +
          '<div class="form-row">' +
            '<div class="form-field"><label for="p-start">시작일</label>' +
              '<input id="p-start" type="date" max="' + tk + '"></div>' +
            '<div class="form-field"><label for="p-end">종료일</label>' +
              '<input id="p-end" type="date" max="' + tk + '"></div>' +
          '</div>' +
          '<p class="form-error" id="p-error"></p>' +
          '<div class="form-actions">' +
            '<button class="pill-btn secondary" id="p-cancel">취소</button>' +
            '<button class="pill-btn" id="p-save">저장</button>' +
          '</div>' +
        '</div>';
    } else {
      html += '<button class="pill-btn secondary" id="p-add">+ 지난 생리 기록 추가</button>';
    }

    // 기록 목록 (최근 회차부터)
    html += '<h2 class="section-title">기록 (' + eps.length + '회)</h2>';
    if (!eps.length) {
      html += '<div class="empty">아직 기록이 없어요.<br>달력에서 날짜를 누르거나 위 버튼으로 추가해 주세요.</div>';
    } else {
      var rows = '';
      for (var ei = eps.length - 1; ei >= 0; ei--) {
        var ep = eps[ei];
        var len = diffDays(ep.start, ep.end) + 1;
        var cycleTxt = ei > 0 ? '주기 ' + diffDays(eps[ei - 1].start, ep.start) + '일' : '';
        var range = ep.start === ep.end
          ? esc(fmtKeyShort(ep.start).replace(' · 오늘', ''))
          : esc(fmtKeyShort(ep.start).replace(' · 오늘', '')) + ' ~ ' + esc(fmtKeyShort(ep.end).replace(' · 오늘', ''));
        rows +=
          '<div class="dose-row">' +
            '<div><div class="d-name">' + range + '</div>' +
            '<div class="d-time">' + len + '일' + (cycleTxt ? ' · ' + cycleTxt : '') + '</div></div>' +
            '<button class="ico-btn danger" data-ep-del="' + ep.start + '|' + ep.end + '" aria-label="기록 삭제">' + ICON.trash + '</button>' +
          '</div>';
      }
      html += '<section class="card">' + rows + '</section>';
    }

    app.innerHTML = html;

    document.getElementById('back').addEventListener('click', function () { go('calendar'); });

    var addBtn = document.getElementById('p-add');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        state.periodAdd = true;
        renderPeriod();
      });
    }
    var saveBtn = document.getElementById('p-save');
    if (saveBtn) {
      document.getElementById('p-cancel').addEventListener('click', function () {
        state.periodAdd = false;
        renderPeriod();
      });
      saveBtn.addEventListener('click', function () {
        var start = document.getElementById('p-start').value;
        var end = document.getElementById('p-end').value || start;
        var errEl = document.getElementById('p-error');
        function fail(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }
        if (!start) { fail('시작일을 선택해 주세요.'); return; }
        if (end < start) { fail('종료일이 시작일보다 빨라요.'); return; }
        if (start > tk || end > tk) { fail('미래 날짜는 기록할 수 없어요.'); return; }
        addPeriodRange(start, end);
        state.periodAdd = false;
        renderPeriod();
      });
    }
    app.querySelectorAll('[data-ep-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = btn.getAttribute('data-ep-del').split('|');
        if (window.confirm('이 생리 기록을 삭제할까요?')) {
          removePeriodRange(p[0], p[1]);
          renderPeriod();
        }
      });
    });
  }

  /* ===== 설정 ===== */
  function renderSettings() {
    app.className = 'no-nav';
    var mode = getMode();
    var isTracker = mode === 'tracker';

    var html =
      '<div class="back-head">' +
        '<button id="back" aria-label="뒤로">←</button>' +
        '<h1>설정</h1>' +
      '</div>';

    if (isTracker) {
      html += '<div class="settings-group"><h2>달력</h2>' +
        '<button class="toggle-row" id="period-toggle">' +
          '<div><div class="m-title">생리주기 기능</div>' +
          '<div class="m-desc">달력에서 생리 기록과 다음 예정일 계산을 사용해요</div></div>' +
          '<span class="switch' + (isPeriodOn() ? ' on' : '') + '"></span>' +
        '</button></div>';

      html += '<div class="settings-group"><h2>내 약 관리</h2>';
      var meds = getMeds();
      if (!meds.length) {
        html += '<p class="settings-note">등록된 약이 없어요.</p>';
      }
      meds.forEach(function (med) {
        var meta = med.type === 'check'
          ? '복용 체크' + (med.maxPerDay ? ' · 1일 최대 ' + med.maxPerDay + med.unit : '')
          : '최소 간격 ' + med.intervalHours + '시간 · 1일 최대 ' + med.maxPerDay + med.unit;
        html +=
          '<div class="med-row">' +
            '<div>' +
              '<div class="r-name">' + esc(med.name) + '</div>' +
              '<div class="r-meta">' + meta + '</div>' +
            '</div>' +
            '<div class="r-actions">' +
              '<button data-edit="' + esc(med.id) + '">수정</button>' +
              '<button class="danger" data-del="' + esc(med.id) + '">삭제</button>' +
            '</div>' +
          '</div>';
      });
      html += '<button class="pill-btn secondary" id="add-med">+ 약 추가</button></div>';
    }

    html +=
      '<div class="settings-group"><h2>화면</h2>' +
        '<button class="toggle-row" id="mode-switch">' +
          '<div><div class="m-title">' + (isTracker ? '심플 체크 모드로 전환' : '간격 트래커 모드로 전환') + '</div>' +
          '<div class="m-desc">' + (isTracker
            ? '아침 · 점심 · 저녁 큰 버튼만 있는 화면으로 바꿔요'
            : '간격 계산 · 달력이 있는 화면으로 바꿔요') + '</div></div>' +
          '<span class="check">→</span>' +
        '</button></div>';

    html +=
      '<p class="settings-note">모든 데이터는 이 기기의 브라우저에만 저장돼요. 서버로 전송되지 않아요.<br>' +
      '이 앱은 사용자가 등록한 간격·최대치·날짜를 기준으로 계산만 해요.</p>';

    app.innerHTML = html;

    document.getElementById('back').addEventListener('click', function () { go('home'); });

    document.getElementById('mode-switch').addEventListener('click', function () {
      setMode(isTracker ? 'simple' : 'tracker');
      go('home');
    });

    if (isTracker) {
      document.getElementById('period-toggle').addEventListener('click', function () {
        storage.set(KEY.periodOn, !isPeriodOn());
        renderSettings();
      });
      document.getElementById('add-med').addEventListener('click', function () {
        go('medForm', { editMedId: null, returnTo: 'settings' });
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
  }

  /* ===== 약 추가/수정 폼 ===== */
  function renderMedForm() {
    app.className = 'no-nav';
    var editing = state.editMedId ? medById(state.editMedId) : null;
    var curType = editing ? (editing.type || 'interval') : 'interval';

    app.innerHTML =
      '<div class="back-head">' +
        '<button id="back" aria-label="뒤로">←</button>' +
        '<h1>' + (editing ? '약 수정' : '약 추가') + '</h1>' +
      '</div>' +
      '<div class="card">' +
        '<div class="form-field">' +
          '<label>기록 방식</label>' +
          '<div class="type-select">' +
            '<button type="button" data-type="interval" class="' + (curType === 'interval' ? 'active' : '') + '">' +
              '<b>간격 트래커</b><span>다음 복용 가능 시각 계산</span></button>' +
            '<button type="button" data-type="check" class="' + (curType === 'check' ? 'active' : '') + '">' +
              '<b>복용 체크</b><span>먹었는지만 기록</span></button>' +
          '</div>' +
        '</div>' +
        '<div class="form-field">' +
          '<label for="f-name">약 이름</label>' +
          '<input id="f-name" type="text" placeholder="예: 타이레놀 500mg" value="' + (editing ? esc(editing.name) : '') + '">' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-field" id="field-interval">' +
            '<label for="f-interval">최소 간격 (시간)</label>' +
            '<input id="f-interval" type="number" inputmode="decimal" min="0.5" step="0.5" placeholder="4" value="' + (editing && editing.intervalHours != null ? editing.intervalHours : '') + '">' +
          '</div>' +
          '<div class="form-field">' +
            '<label for="f-max" id="label-max">1일 최대 (개수)</label>' +
            '<input id="f-max" type="number" inputmode="numeric" min="1" step="1" placeholder="8" value="' + (editing && editing.maxPerDay != null ? editing.maxPerDay : '') + '">' +
          '</div>' +
        '</div>' +
        '<div class="form-field">' +
          '<label for="f-unit">단위</label>' +
          '<input id="f-unit" type="text" placeholder="정 / 캡슐 / 포" value="' + (editing ? esc(editing.unit) : '정') + '">' +
        '</div>' +
        '<p class="form-error" id="form-error"></p>' +
        '<div class="form-actions">' +
          '<button type="button" class="pill-btn secondary" id="cancel">취소</button>' +
          '<button type="button" class="pill-btn" id="save">저장</button>' +
        '</div>' +
      '</div>';

    var typeButtons = app.querySelectorAll('.type-select button');
    function applyTypeUI() {
      document.getElementById('field-interval').style.display = curType === 'interval' ? '' : 'none';
      document.getElementById('label-max').textContent = curType === 'interval' ? '1일 최대 (개수)' : '1일 최대 (선택)';
    }
    typeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        curType = btn.getAttribute('data-type');
        typeButtons.forEach(function (b) { b.classList.toggle('active', b === btn); });
        applyTypeUI();
      });
    });
    applyTypeUI();

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

      if (!name) { fail('약 이름을 입력해 주세요.', 'f-name'); return; }
      if (curType === 'interval') {
        if (!(interval > 0)) { fail('최소 간격(시간)을 입력해 주세요.', 'f-interval'); return; }
        if (!(max > 0)) { fail('1일 최대 개수를 입력해 주세요.', 'f-max'); return; }
      } else {
        interval = null;
        max = maxRaw && max > 0 ? max : null;
      }

      var newMed = {
        id: editing ? editing.id : uid(),
        name: name, unit: unit, type: curType,
        intervalHours: interval, maxPerDay: max
      };
      var meds = getMeds();
      if (editing) {
        meds = meds.map(function (mm) { return mm.id === editing.id ? newMed : mm; });
      } else {
        meds.push(newMed);
      }
      saveMeds(meds);
      backFromForm();
    });

    function backFromForm() {
      if (state.returnTo === 'medDetail' && state.detailMedId) go('medDetail', {});
      else if (state.returnTo === 'settings') go('settings');
      else go('home');
    }
  }

  /* ===== 하단 내비 ===== */
  var ICON = {
    pillPlus: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.2" y="10.6" width="12.6" height="6.6" rx="3.3" transform="rotate(-45 9.5 13.9)"/><path d="M7.2 11.6l4.6 4.6"/><path d="M18.5 3.5v6M15.5 6.5h6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-1L20 7.5a2.1 2.1 0 0 0-3-3L5.5 16 4 20z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.2 12 4l9 7.2"/><path d="M5.5 10v10h13V10"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 9.5h17M8 3v3.5M16 3v3.5"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/></svg>'
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
  render();

  // 탭 복귀 시 화면 갱신 (자정 넘김·백그라운드 경과 반영)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) render();
  });

  // 서비스워커 등록 (미리보기 등 지원 안 되는 환경은 조용히 통과)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').then(function (reg) {
        if (reg && reg.update) reg.update(); // 새 배포를 최대한 빨리 반영
      }).catch(function () { /* noop */ });
    });
  }
})();
