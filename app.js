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
    meds: 'mt.meds',          // [{id, name, unit, intervalHours, maxPerDay}]
    doses: 'mt.doses',        // [{id, medId, ts}]
    checks: 'mt.checks',      // [{slot, ts, dateKey}]
    period: 'mt.period',      // ['YYYY-MM-DD', ...] 생리로 표시한 날
    periodOn: 'mt.periodOn'   // 달력에 생리주기 기능 표시 여부
  };

  var PRESET_MEDS = [
    { id: 'preset-tylenol', name: '타이레놀 500mg', unit: '정', intervalHours: 4, maxPerDay: 8 },
    { id: 'preset-ezn6pro', name: '이지엔6프로', unit: '캡슐', intervalHours: 4, maxPerDay: 6 }
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
    return new Date(ts).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
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
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function applyTimeToTs(ts, hhmm) { // 같은 날짜에 시:분만 교체
    var p = hhmm.split(':');
    var d = new Date(ts);
    d.setHours(Number(p[0]), Number(p[1]), 0, 0);
    return d.getTime();
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
    timeEdit: null,               // {kind:'dose'|'check', id}
    calY: now0.getFullYear(),
    calM: now0.getMonth(),        // 0-11
    selKey: todayKey()
  };
  var app = document.getElementById('app');
  var tickTimer = null;

  function go(screen, opts) {
    state.screen = screen;
    state.editMedId = (opts && opts.editMedId) || null;
    state.timeEdit = null;
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
      go('medForm');
    });
    bindBottomNav();

    tickTimer = setInterval(function () {
      if (state.screen === 'home' && !state.timeEdit) renderTrackerHome();
    }, 30000);
  }

  function medCardHtml(med) {
    var now = Date.now();
    var last = lastDoseForMed(med.id);
    var todays = todayDosesForMed(med.id);
    var intervalMs = med.intervalHours * 3600 * 1000;

    var ready = true;
    var remainMs = 0;
    if (last) {
      var nextAt = last.ts + intervalMs;
      if (nextAt > now) { ready = false; remainMs = nextAt - now; }
    }

    var reached = todays.length >= med.maxPerDay;
    var exceeded = todays.length > med.maxPerDay;

    /* 카운트다운 링: 남은 시간에 비례해 호가 줄어듦 */
    var C = 2 * Math.PI * 54;
    var frac = ready ? 1 : Math.min(1, remainMs / intervalMs);
    var dashoffset = ready ? 0 : C * (1 - frac);

    // 링 중앙은 "12시간" / "6분"처럼 줄을 나눠 표시
    var remainRing = (function () {
      var totalMin = Math.max(1, Math.ceil(remainMs / 60000));
      var h = Math.floor(totalMin / 60);
      var m = totalMin % 60;
      if (h > 0 && m > 0) return h + '시간<br>' + m + '분';
      if (h > 0) return h + '시간';
      return m + '분';
    })();
    var ringCenter = ready
      ? '<div class="ring-center ready"><div class="big">지금 복용<br>가능</div></div>'
      : '<div class="ring-center">' +
          '<div class="big">' + remainRing + '</div>' +
          '<div class="small">남음</div>' +
        '</div>';

    var statusMain, statusSub;
    if (ready) {
      statusMain = '<span class="hl">지금 복용 가능</span>해요';
      statusSub = last ? '마지막 복용 ' + esc(fmtTime(last.ts)) : '아직 복용 기록이 없어요';
    } else {
      statusMain = '다음 복용 가능까지<br><span class="hl">' + esc(fmtRemain(remainMs)) + ' 남음</span>';
      statusSub = esc(fmtTime(last.ts + intervalMs)) + ' 이후 가능';
    }

    var warn = '';
    if (exceeded) {
      warn = '<div class="warn-banner">오늘 최대치 ' + med.maxPerDay + med.unit + ' 초과 — 현재 ' + todays.length + med.unit + '</div>';
    } else if (reached) {
      warn = '<div class="warn-banner">오늘 최대치 ' + med.maxPerDay + med.unit + '에 도달했어요</div>';
    }

    var foot = '';
    if (last) {
      var editing = state.timeEdit && state.timeEdit.kind === 'dose' && state.timeEdit.id === last.id;
      if (editing) {
        foot =
          '<div class="time-edit">' +
            '<input type="time" id="te-input" value="' + timeInputValue(last.ts) + '">' +
            '<button class="pill-btn" data-te-save="' + esc(last.id) + '">저장</button>' +
            '<button class="text-btn" data-te-cancel>닫기</button>' +
          '</div>';
      } else {
        var parts = [];
        if (now - last.ts < UNDO_WINDOW_MS) {
          parts.push('<button class="text-btn" data-undo="' + esc(last.id) + '">방금 기록 취소</button>');
        }
        parts.push('<button class="text-btn" data-edit-time="' + esc(last.id) + '">마지막 시각 수정</button>');
        foot = '<div class="card-foot">' + parts.join('') + '</div>';
      }
    }

    return (
      '<section class="card" data-med="' + esc(med.id) + '">' +
        '<div class="med-head">' +
          '<div>' +
            '<div class="med-name">' + esc(med.name) + '</div>' +
            '<div class="med-meta">간격 ' + med.intervalHours + '시간 · 1일 최대 ' + med.maxPerDay + med.unit + '</div>' +
          '</div>' +
          '<span class="badge' + (reached ? ' filled' : '') + '">오늘 ' + todays.length + '/' + med.maxPerDay + '</span>' +
        '</div>' +
        '<div class="med-body">' +
          '<div class="ring-wrap">' +
            '<svg viewBox="0 0 120 120" aria-hidden="true">' +
              '<circle class="ring-bg" cx="60" cy="60" r="54"></circle>' +
              '<circle class="ring-fg' + (ready ? ' ready' : '') + '" cx="60" cy="60" r="54" ' +
                'stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + dashoffset.toFixed(2) + '" ' +
                'transform="rotate(-90 60 60)"></circle>' +
            '</svg>' +
            ringCenter +
          '</div>' +
          '<div class="med-status">' +
            '<p class="status-main">' + statusMain + '</p>' +
            '<p class="status-sub">' + statusSub + '</p>' +
          '</div>' +
        '</div>' +
        '<button class="pill-btn" data-log="' + esc(med.id) + '">복용 기록하기</button>' +
        warn +
        foot +
      '</section>'
    );
  }

  function bindMedCards() {
    app.querySelectorAll('[data-log]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        logDose(btn.getAttribute('data-log'));
        state.timeEdit = null;
        renderTrackerHome();
      });
    });
    app.querySelectorAll('[data-undo]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeDose(btn.getAttribute('data-undo'));
        renderTrackerHome();
      });
    });
    app.querySelectorAll('[data-edit-time]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.timeEdit = { kind: 'dose', id: btn.getAttribute('data-edit-time') };
        renderTrackerHome();
      });
    });
    app.querySelectorAll('[data-te-save]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var val = document.getElementById('te-input').value;
        if (val && !setDoseTime(btn.getAttribute('data-te-save'), val)) {
          window.alert('지금보다 미래 시각으로는 저장할 수 없어요.');
          return;
        }
        state.timeEdit = null;
        renderTrackerHome();
      });
    });
    app.querySelectorAll('[data-te-cancel]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.timeEdit = null;
        renderTrackerHome();
      });
    });
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
                '<input type="time" id="te-input" value="' + timeInputValue(check.ts) + '">' +
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

    if (periodOn && stats) {
      if (stats.avgCycle) {
        var dd = diffDays(tk, stats.nextStart);
        var ddLabel = dd > 0 ? 'D-' + dd : (dd === 0 ? '오늘' : dd * -1 + '일 지남');
        html += '<div class="cycle-info"><span class="dot"></span>평균 주기 ' + stats.avgCycle +
          '일 · 다음 예정일 ' + esc(fmtKeyShort(stats.nextStart).replace(' · 오늘', '')) +
          ' (' + ddLabel + ')</div>';
      } else {
        html += '<div class="cycle-info"><span class="dot"></span>생리 기록이 2번 이상 쌓이면 다음 예정일을 계산해요</div>';
      }
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
    bindDayPanel();
    bindBottomNav();
  }

  function dayPanelHtml(key, periodOn, periodSet) {
    var meds = getMeds();
    var medById = {};
    meds.forEach(function (mm) { medById[mm.id] = mm; });

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
        var med = medById[d.medId];
        var editing = state.timeEdit && state.timeEdit.kind === 'dose' && state.timeEdit.id === d.id;
        if (editing) {
          html +=
            '<div class="time-edit">' +
              '<input type="time" id="te-input" value="' + timeInputValue(d.ts) + '">' +
              '<button class="pill-btn" data-dp-save="' + esc(d.id) + '">저장</button>' +
              '<button class="text-btn" data-dp-cancel>닫기</button>' +
            '</div>';
        } else {
          html +=
            '<div class="dose-row">' +
              '<span class="d-name">' + esc(med ? med.name : '삭제된 약') + '</span>' +
              '<span class="d-time">' + esc(fmtTime(d.ts)) + '</span>' +
              '<span class="d-actions">' +
                '<button class="text-btn" data-dp-edit="' + esc(d.id) + '">수정</button>' +
                '<button class="text-btn danger" data-dp-del="' + esc(d.id) + '">삭제</button>' +
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

  /* ===== 설정 ===== */
  function renderSettings() {
    app.className = 'no-nav';
    var mode = getMode();
    var isTracker = mode === 'tracker';

    var html =
      '<div class="back-head">' +
        '<button id="back" aria-label="뒤로">←</button>' +
        '<h1>설정</h1>' +
      '</div>' +
      '<div class="settings-group">' +
        '<h2>화면 모드</h2>' +
        modeOptionHtml('tracker', '간격 트래커', '다음 복용 가능 시각을 계산해서 알려드려요', isTracker) +
        modeOptionHtml('simple', '심플 체크', '아침 · 점심 · 저녁 먹었는지만 확인해요', !isTracker) +
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
        html +=
          '<div class="med-row">' +
            '<div>' +
              '<div class="r-name">' + esc(med.name) + '</div>' +
              '<div class="r-meta">간격 ' + med.intervalHours + '시간 · 1일 최대 ' + med.maxPerDay + med.unit + '</div>' +
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
      '<p class="settings-note">모든 데이터는 이 기기의 브라우저에만 저장돼요. 서버로 전송되지 않아요.<br>' +
      '이 앱은 사용자가 등록한 간격·최대치·날짜를 기준으로 계산만 해요.</p>';

    app.innerHTML = html;

    document.getElementById('back').addEventListener('click', function () { go('home'); });

    app.querySelectorAll('.mode-option').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setMode(btn.getAttribute('data-mode'));
        renderSettings();
      });
    });

    if (isTracker) {
      document.getElementById('period-toggle').addEventListener('click', function () {
        storage.set(KEY.periodOn, !isPeriodOn());
        renderSettings();
      });
      document.getElementById('add-med').addEventListener('click', function () {
        go('medForm');
      });
      app.querySelectorAll('[data-edit]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          go('medForm', { editMedId: btn.getAttribute('data-edit') });
        });
      });
      app.querySelectorAll('[data-del]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var med = getMeds().find(function (mm) { return mm.id === btn.getAttribute('data-del'); });
          if (med && window.confirm('"' + med.name + '"을(를) 삭제할까요?\n복용 이력은 남아있어요.')) {
            saveMeds(getMeds().filter(function (mm) { return mm.id !== med.id; }));
            renderSettings();
          }
        });
      });
    }
  }

  function modeOptionHtml(modeKey, title, desc, active) {
    return (
      '<button class="mode-option' + (active ? ' active' : '') + '" data-mode="' + modeKey + '">' +
        '<div>' +
          '<div class="m-title">' + title + '</div>' +
          '<div class="m-desc">' + desc + '</div>' +
        '</div>' +
        (active ? '<span class="check">✓</span>' : '') +
      '</button>'
    );
  }

  /* ===== 약 추가/수정 폼 ===== */
  function renderMedForm() {
    app.className = 'no-nav';
    var editing = state.editMedId
      ? getMeds().find(function (mm) { return mm.id === state.editMedId; })
      : null;

    app.innerHTML =
      '<div class="back-head">' +
        '<button id="back" aria-label="뒤로">←</button>' +
        '<h1>' + (editing ? '약 수정' : '약 추가') + '</h1>' +
      '</div>' +
      '<div class="card">' +
        '<div class="form-field">' +
          '<label for="f-name">약 이름</label>' +
          '<input id="f-name" type="text" placeholder="예: 타이레놀 500mg" value="' + (editing ? esc(editing.name) : '') + '">' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-field">' +
            '<label for="f-interval">최소 간격 (시간)</label>' +
            '<input id="f-interval" type="number" inputmode="decimal" min="0.5" step="0.5" placeholder="4" value="' + (editing ? editing.intervalHours : '') + '">' +
          '</div>' +
          '<div class="form-field">' +
            '<label for="f-max">1일 최대 (개수)</label>' +
            '<input id="f-max" type="number" inputmode="numeric" min="1" step="1" placeholder="8" value="' + (editing ? editing.maxPerDay : '') + '">' +
          '</div>' +
        '</div>' +
        '<div class="form-field">' +
          '<label for="f-unit">단위</label>' +
          '<input id="f-unit" type="text" placeholder="정 / 캡슐 / 포" value="' + (editing ? esc(editing.unit) : '정') + '">' +
        '</div>' +
        '<div class="form-actions">' +
          '<button class="pill-btn secondary" id="cancel">취소</button>' +
          '<button class="pill-btn" id="save">저장</button>' +
        '</div>' +
      '</div>';

    document.getElementById('back').addEventListener('click', backFromForm);
    document.getElementById('cancel').addEventListener('click', backFromForm);
    document.getElementById('save').addEventListener('click', function () {
      var name = document.getElementById('f-name').value.trim();
      var interval = parseFloat(document.getElementById('f-interval').value);
      var max = parseInt(document.getElementById('f-max').value, 10);
      var unit = document.getElementById('f-unit').value.trim() || '정';

      if (!name) { window.alert('약 이름을 입력해 주세요.'); return; }
      if (!(interval > 0)) { window.alert('최소 간격(시간)을 입력해 주세요.'); return; }
      if (!(max > 0)) { window.alert('1일 최대 개수를 입력해 주세요.'); return; }

      var meds = getMeds();
      if (editing) {
        meds = meds.map(function (mm) {
          return mm.id === editing.id
            ? { id: mm.id, name: name, unit: unit, intervalHours: interval, maxPerDay: max }
            : mm;
        });
      } else {
        meds.push({ id: uid(), name: name, unit: unit, intervalHours: interval, maxPerDay: max });
      }
      saveMeds(meds);
      backFromForm();
    });

    function backFromForm() {
      go(state.editMedId ? 'settings' : 'home');
    }
  }

  /* ===== 하단 내비 ===== */
  var ICON = {
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
  render();

  // 탭 복귀 시 화면 갱신 (자정 넘김·백그라운드 경과 반영)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) render();
  });

  // 서비스워커 등록 (미리보기 등 지원 안 되는 환경은 조용히 통과)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* noop */ });
    });
  }
})();
