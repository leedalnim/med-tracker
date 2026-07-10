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
    mode: 'mt.mode',        // 'tracker' | 'simple'
    meds: 'mt.meds',        // [{id, name, doseLabel, unit, intervalHours, maxPerDay}]
    doses: 'mt.doses',      // [{id, medId, ts}]
    checks: 'mt.checks'     // [{slot, ts, dateKey}]
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
  function dateKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function todayKey() { return dateKey(Date.now()); }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  }
  function fmtDateLong(ts) {
    return new Date(ts).toLocaleDateString('ko-KR', {
      month: 'long', day: 'numeric', weekday: 'long'
    });
  }
  function fmtDateKeyLabel(key) {
    var parts = key.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
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
  function undoDose(doseId) {
    saveDoses(getDoses().filter(function (d) { return d.id !== doseId; }));
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
  function lastCheckToday() {
    var tk = todayKey();
    var todays = getChecks().filter(function (c) { return c.dateKey === tk; });
    if (!todays.length) return null;
    return todays.reduce(function (a, b) { return a.ts > b.ts ? a : b; });
  }

  /* ===== 라우팅 ===== */
  var state = { screen: 'home', editMedId: null };
  var app = document.getElementById('app');
  var tickTimer = null;

  function go(screen, opts) {
    state.screen = screen;
    state.editMedId = (opts && opts.editMedId) || null;
    render();
  }

  function render() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    var mode = getMode();

    if (!mode) { renderOnboarding(); return; }

    switch (state.screen) {
      case 'settings': renderSettings(); break;
      case 'medForm': renderMedForm(); break;
      case 'history': renderHistory(); break;
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
      if (state.screen === 'home') renderTrackerHome();
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

    var overMax = todays.length >= med.maxPerDay;
    var exceeded = todays.length > med.maxPerDay;

    /* 카운트다운 링: 남은 시간에 비례해 호가 줄어듦 */
    var C = 2 * Math.PI * 54; // 반지름 54
    var frac = ready ? 1 : Math.min(1, remainMs / intervalMs);
    var dashoffset = ready ? 0 : C * (1 - frac);

    var ringCenter = ready
      ? '<div class="ring-center ready"><div class="big">지금 복용<br>가능</div></div>'
      : '<div class="ring-center">' +
          '<div class="big">' + esc(fmtRemain(remainMs)) + '</div>' +
          '<div class="small">남음</div>' +
        '</div>';

    var statusLine;
    if (ready) {
      statusLine = last
        ? '<span class="hl">지금 복용 가능</span>해요<br>마지막 복용 ' + esc(fmtTime(last.ts))
        : '아직 복용 기록이 없어요';
    } else {
      statusLine = '다음 복용 가능까지<br><span class="hl">' + esc(fmtRemain(remainMs)) + ' 남음</span>' +
        '<br><span style="color:var(--text-dim);font-size:13px;font-weight:600">' +
        esc(fmtTime(last.ts + intervalMs)) + ' 이후 가능</span>';
    }

    var warn = '';
    if (exceeded) {
      warn = '<div class="warn-banner">오늘 등록된 최대치(' + med.maxPerDay + med.unit + ')를 초과했어요 — 현재 ' + todays.length + med.unit + '</div>';
    } else if (overMax) {
      warn = '<div class="warn-banner">오늘 등록된 최대치(' + med.maxPerDay + med.unit + ')에 도달했어요</div>';
    }

    var undoHtml = '';
    if (last && (now - last.ts) < UNDO_WINDOW_MS) {
      undoHtml = '<div class="undo-row"><button class="text-btn" data-undo="' + esc(last.id) + '">방금 기록 취소</button></div>';
    }

    return (
      '<section class="card med-card" data-med="' + esc(med.id) + '">' +
        '<div class="med-head">' +
          '<div>' +
            '<div class="med-name">' + esc(med.name) + '</div>' +
            '<div class="med-meta">간격 ' + med.intervalHours + '시간 · 1일 최대 ' + med.maxPerDay + med.unit + '</div>' +
          '</div>' +
          '<span class="badge neutral">오늘 ' + todays.length + '/' + med.maxPerDay + med.unit + '</span>' +
        '</div>' +
        warn +
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
            '<p class="status-line">' + statusLine + '</p>' +
            '<div class="today-count">복용 기록 ' + todays.length + '회' +
              (last ? ' · 마지막 ' + esc(fmtTime(last.ts)) : '') + '</div>' +
          '</div>' +
        '</div>' +
        '<button class="pill-btn" data-log="' + esc(med.id) + '">복용 기록하기</button>' +
        undoHtml +
      '</section>'
    );
  }

  function bindMedCards() {
    app.querySelectorAll('[data-log]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        logDose(btn.getAttribute('data-log'));
        renderTrackerHome();
      });
    });
    app.querySelectorAll('[data-undo]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        undoDose(btn.getAttribute('data-undo'));
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
        slotsHtml +=
          '<div class="slot-undo">' +
            '<button data-uncheck="' + s.key + '">잘못 눌렀어요? 취소</button>' +
          '</div>';
      }
    });

    app.innerHTML =
      '<div class="simple">' +
        '<div class="simple-top">' +
          '<div class="simple-date">' + esc(fmtDateLong(Date.now())) + '</div>' +
          '<button class="gear-btn" id="open-settings" aria-label="설정">⚙︎</button>' +
        '</div>' +
        lastHtml +
        slotsHtml +
      '</div>';

    app.querySelectorAll('[data-slot]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        logCheck(btn.getAttribute('data-slot'));
        renderSimpleHome();
      });
    });
    app.querySelectorAll('[data-uncheck]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        undoCheck(btn.getAttribute('data-uncheck'));
        renderSimpleHome();
      });
    });
    document.getElementById('open-settings').addEventListener('click', function () {
      go('settings');
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
      '이 앱은 사용자가 등록한 간격과 최대치를 기준으로 계산만 해요.</p>';

    app.innerHTML = html;

    document.getElementById('back').addEventListener('click', function () { go('home'); });

    app.querySelectorAll('.mode-option').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setMode(btn.getAttribute('data-mode'));
        renderSettings();
      });
    });

    if (isTracker) {
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
          var med = getMeds().find(function (m) { return m.id === btn.getAttribute('data-del'); });
          if (med && window.confirm('"' + med.name + '"을(를) 삭제할까요?\n복용 이력은 남아있어요.')) {
            saveMeds(getMeds().filter(function (m) { return m.id !== med.id; }));
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
      ? getMeds().find(function (m) { return m.id === state.editMedId; })
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
        meds = meds.map(function (m) {
          return m.id === editing.id
            ? { id: m.id, name: name, unit: unit, intervalHours: interval, maxPerDay: max }
            : m;
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

  /* ===== 이력 ===== */
  function renderHistory() {
    app.className = '';
    var meds = getMeds();
    var medById = {};
    meds.forEach(function (m) { medById[m.id] = m; });

    var doses = getDoses().slice().sort(function (a, b) { return b.ts - a.ts; });

    var html =
      '<header class="screen-head">' +
        '<h1>복용 이력</h1>' +
        '<p class="sub">이 기기에 저장된 기록이에요</p>' +
      '</header>';

    if (!doses.length) {
      html += '<div class="empty">아직 복용 기록이 없어요.</div>';
    } else {
      var currentKey = null;
      doses.forEach(function (d) {
        var k = dateKey(d.ts);
        if (k !== currentKey) {
          currentKey = k;
          html += '<div class="history-date">' + esc(fmtDateKeyLabel(k)) + '</div>';
        }
        var med = medById[d.medId];
        html +=
          '<div class="history-item">' +
            '<span class="h-name">' + esc(med ? med.name : '삭제된 약') + '</span>' +
            '<span class="h-time">' + esc(fmtTime(d.ts)) + '</span>' +
          '</div>';
      });
    }

    html += bottomNavHtml('history');
    app.innerHTML = html;
    bindBottomNav();
  }

  /* ===== 하단 내비 ===== */
  function bottomNavHtml(active) {
    function item(key, ico, label) {
      return '<button data-nav="' + key + '" class="' + (active === key ? 'active' : '') + '">' +
        '<span class="ico">' + ico + '</span>' + label + '</button>';
    }
    return '<nav class="bottom-nav">' +
      item('home', '⌂', '홈') +
      item('history', '≡', '이력') +
      item('settings', '⚙︎', '설정') +
      '</nav>';
  }
  function bindBottomNav() {
    app.querySelectorAll('[data-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        go(btn.getAttribute('data-nav') === 'home' ? 'home' : btn.getAttribute('data-nav'));
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
