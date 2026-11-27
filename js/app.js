/* =========================================================
   app.js — 화면 렌더링 · 이벤트
   ========================================================= */
(function (global) {
  'use strict';

  var SO = global.SO;
  var store = SO.store;
  var doc = global.document;

  var dom = {};
  var typing = {};              /* roomId -> [assistantId] */
  var lastRenderedRoom = null;
  var aiHintShown = false;
  var toastTimer = null;
  var hideToastTimer = null;
  var confirmHandler = null;

  var ICONS = ['🥒', '🔎', '📐', '🌸', '💙', '☕', '📎', '🗂️', '✍️', '📊',
               '🧮', '🎯', '🛰️', '🧠', '🐣', '🦉', '🐝', '🍀'];

  /* =======================================================
     유틸
     ======================================================= */
  function $(id) { return doc.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatTime(ts) {
    var d = new Date(ts);
    var h = d.getHours();
    var ap = h < 12 ? '오전' : '오후';
    var hh = h % 12;
    if (hh === 0) hh = 12;
    return ap + ' ' + hh + ':' + pad2(d.getMinutes());
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function formatDay(ts) {
    var d = new Date(ts);
    var days = ['일', '월', '화', '수', '목', '금', '토'];
    var label = d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' +
      days[d.getDay()] + '요일';
    if (dayKey(ts) === dayKey(Date.now())) label = '오늘 · ' + label;
    return label;
  }

  function formatShort(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s/g, '').replace(/^@/, '').toLowerCase();
  }

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* =======================================================
     헤더 · 탭
     ======================================================= */
  function renderHeader() {
    var s = store.get();
    var chief = s.assistants.length ? s.assistants[0].name : '';
    dom.officeName.textContent = s.officeName;
    dom.officeSub.textContent = '범용님 전용' + (chief ? ' · ' + chief + ' 본부' : '');
    doc.title = s.officeName;
  }

  function renderTabs() {
    var tab = store.get().ui.tab;
    var tabs = dom.mainTabs.querySelectorAll('.main-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-tab') === tab);
    }
    var views = dom.views.querySelectorAll('.view');
    for (var j = 0; j < views.length; j++) {
      views[j].classList.toggle('is-active', views[j].getAttribute('data-view') === tab);
    }
    if (dom.toast) dom.toast.classList.toggle('toast--above', tab === 'chat');
  }

  function renderConn() {
    var st = SO.sync.status();
    var map = {
      local: ['로컬 모드', 'is-local'],
      connecting: ['연결 중…', 'is-connecting'],
      live: ['실시간 DB 연결됨', 'is-live'],
      error: ['연결 오류', 'is-error']
    };
    var info = map[st.mode] || map.local;
    dom.connText.textContent = info[0];
    dom.connBadge.className = 'conn-badge ' + info[1];
    dom.connBadge.title = st.message ? info[0] + ' · ' + st.message : info[0];
    if (dom.settingsModal && !dom.settingsModal.hidden) renderSettingsConnStatus(st);
  }

  /* =======================================================
     오피스 맵
     ======================================================= */
  /* 방 핀 위치는 일러스트(assets/office-map.png) 기준 % 좌표 */
  var MAP_ROOMS = [
    { key: 'command', tab: 'chat', room: 'command', icon: '🎯', label: '지휘실', x: 55, y: 20 },
    { key: 'main', tab: 'chat', room: 'main', icon: '🏛️', label: '대회의실', x: 13, y: 52 },
    { key: 'lounge', tab: 'chat', room: 'lounge', icon: '☕', label: '라운지', x: 80, y: 66 },
    { key: 'tasks', tab: 'tasks', room: null, icon: '📋', label: '작업실', x: 50, y: 74 }
  ];

  /* 캐릭터 핀 자리 — 일러스트 속 캐릭터들 근처 */
  var CHAR_SPOTS = [
    { x: 44, y: 34 }, { x: 66, y: 34 }, { x: 38, y: 50 }, { x: 60, y: 50 },
    { x: 76, y: 26 }, { x: 88, y: 45 }, { x: 26, y: 34 }, { x: 31, y: 69 }
  ];

  /* 가장 최근에 남긴 보고 메시지 (모든 방 통틀어) */
  function latestReport(s, assistantId) {
    var best = null;
    Object.keys(s.rooms).forEach(function (rid) {
      var room = s.rooms[rid];
      room.messages.forEach(function (m) {
        if (m.senderId !== assistantId) return;
        if (!best || m.ts > best.msg.ts) best = { msg: m, roomId: rid, room: room };
      });
    });
    return best;
  }

  /* 담당 작업 기준 진행 상황 */
  function assistantProgress(s, a) {
    var counts = { '대기': 0, '진행중': 0, '완료': 0 };
    s.tasks.forEach(function (t) {
      if (t.assignee === a.name && counts[t.status] !== undefined) counts[t.status]++;
    });
    return { counts: counts, working: counts['진행중'] > 0 };
  }

  function clipText(text, max) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  var lastPinSig = '';

  function renderPins(s) {
    var sig = s.assistants.map(function (a) {
      return a.id + '|' + a.name + '|' + a.icon;
    }).join('~');
    if (sig === lastPinSig) return;
    lastPinSig = sig;

    var html = MAP_ROOMS.map(function (r) {
      return '<button type="button" class="map-pin map-pin--room" data-map-room="' + esc(r.key) +
        '" style="--x:' + r.x + '%;--y:' + r.y + '%" aria-label="' + esc(r.label) + '로 이동">' +
        '<span class="map-pin-icon" aria-hidden="true">' + esc(r.icon) + '</span>' +
        '<span class="map-pin-text">' + esc(r.label) + '</span></button>';
    }).join('');

    html += s.assistants.map(function (a, i) {
      var spot = CHAR_SPOTS[i % CHAR_SPOTS.length];
      var delay = (-1 * (0.35 * (i % 6) + 0.2)).toFixed(2);
      return '<button type="button" class="map-pin map-pin--char" data-char="' + esc(a.id) +
        '" style="--x:' + spot.x + '%;--y:' + spot.y + '%;--delay:' + delay + 's"' +
        ' aria-label="' + esc(a.name) + ' 정보 보기">' +
        '<span class="map-pin-avatar" aria-hidden="true">' + esc(a.icon) +
        '<span class="map-pin-dot"></span></span>' +
        '<span class="map-pin-name">' + esc(a.name) + '</span></button>';
    }).join('');

    dom.mapPins.innerHTML = html;
  }

  function renderMap() {
    var s = store.get();
    var n = s.assistants.length;
    var chief = n ? s.assistants[0].name : '';

    dom.mapHeroTitle.textContent = n
      ? '대표님, ' + n + '개 파트가 대기 중이에요'
      : '대표님, 아직 등록된 파트가 없어요';

    dom.mapPartsChip.textContent = '🟢 ' + n + '개 파트 가동';
    dom.mapOnChip.textContent = n > 1
      ? '👥 ON ' + chief + ' 외 ' + (n - 1) + '파트'
      : (n === 1 ? '👥 ON ' + chief + ' 1파트' : '👥 ON 0파트');

    var moving = !!s.ui.movement;
    dom.motionToggle.classList.toggle('is-on', moving);
    dom.motionToggle.setAttribute('aria-pressed', moving ? 'true' : 'false');
    dom.motionLabel.textContent = moving ? '움직임 ON' : '움직임 OFF';
    dom.mapStage.classList.toggle('is-moving', moving);

    renderPins(s);

    dom.mapReportSub.textContent = n + '개 파트';
    if (!n) {
      dom.mapPartList.innerHTML = '<p class="empty-note">비서현황에서 파트를 추가하면 여기에 나타납니다.</p>';
      return;
    }

    dom.mapPartList.innerHTML = s.assistants.map(function (a) {
      var report = latestReport(s, a.id);
      var prog = assistantProgress(s, a);
      var statusCls = prog.working ? 'is-working' : 'is-waiting';
      var statusText = prog.working ? '작업 중' : '대기 중';
      var body = report
        ? '<span class="part-report">' + esc(clipText(report.msg.text, 90)) + '</span>' +
          '<span class="part-meta">' + esc(report.room.name) + ' · ' + esc(formatShort(report.msg.ts) + ' ' + formatTime(report.msg.ts)) + '</span>'
        : '<span class="part-report is-empty">아직 남긴 보고가 없어요.</span>' +
          '<span class="part-meta">진행중 ' + prog.counts['진행중'] + ' · 대기 ' + prog.counts['대기'] + '</span>';
      return '<button type="button" class="part-card" data-char="' + esc(a.id) + '">' +
        '<span class="part-avatar" aria-hidden="true">' + esc(a.icon) + '</span>' +
        '<span class="part-body">' +
        '<span class="part-top"><span class="part-name">' + esc(a.name) + '</span>' +
        '<span class="part-role">' + esc(a.role) + '</span></span>' +
        body +
        '<span class="part-meta"><span class="part-status ' + statusCls + '">' + statusText + '</span>' +
        '<span>진행중 ' + prog.counts['진행중'] + '</span></span>' +
        '</span></button>';
    }).join('');
  }

  /* 캐릭터 정보 시트 */
  var charTargetId = null;
  var charTargetRoom = 'command';

  function openCharModal(id) {
    var s = store.get();
    var a = findById(s.assistants, id);
    if (!a) return;

    charTargetId = a.id;
    dom.charAvatar.textContent = a.icon;
    dom.charName.textContent = a.name;
    dom.charRole.textContent = a.role || '비서';

    var prog = assistantProgress(s, a);
    var chips = '<span class="pill ' + (prog.working ? 'pill--doing' : 'pill--done') + '">' +
      (prog.working ? '🟠 작업 진행 중' : '🟢 대기 중') + '</span>' +
      '<span class="pill pill--wait">진행중 ' + prog.counts['진행중'] + ' · 대기 ' + prog.counts['대기'] +
      ' · 완료 ' + prog.counts['완료'] + '</span>' +
      (a.pickle ? '<span class="pill pill--doing">피클</span>' : '') +
      (a.ai ? '<span class="pill" style="color:#46699e;background:#eaf0fb;border-color:#d3e0f4">AI 응답</span>' : '');
    dom.charStatus.innerHTML = chips;

    var report = latestReport(s, a.id);
    if (report) {
      charTargetRoom = report.roomId;
      dom.charReport.className = 'char-report';
      dom.charReport.innerHTML =
        '<p class="char-report-text">' + esc(report.msg.text) + '</p>' +
        '<div class="char-report-foot"><span>' + esc(report.room.icon + ' ' + report.room.name) + '</span>' +
        '<span>·</span><span>' + esc(formatShort(report.msg.ts) + ' ' + formatTime(report.msg.ts)) + '</span></div>';
    } else {
      charTargetRoom = s.ui.room;
      dom.charReport.className = 'char-report is-empty';
      dom.charReport.innerHTML = '<p class="char-report-text">아직 남긴 보고가 없어요. 회의실에서 ' +
        esc(a.name) + '에게 첫 지시를 남겨보세요.</p>';
    }

    var mine = s.tasks.filter(function (t) { return t.assignee === a.name; })
      .sort(function (x, y) { return y.createdAt - x.createdAt; })
      .slice(0, 4);

    if (!mine.length) {
      dom.charTasks.innerHTML = '<p class="empty-note">담당으로 지정된 작업이 없습니다.</p>';
    } else {
      dom.charTasks.innerHTML = mine.map(function (t) {
        var cls = t.status === '완료' ? 'pill--done' : (t.status === '진행중' ? 'pill--doing' : 'pill--wait');
        return '<div class="char-task"><span class="pill ' + cls + '">' + esc(t.status) + '</span>' +
          '<span class="char-task-title">' + esc(t.title) + '</span></div>';
      }).join('');
    }

    openModal('charModal');
  }

  /* =======================================================
     회의실
     ======================================================= */
  function renderChat() {
    var s = store.get();
    renderRoomTabs(s);
    renderRoomMeta(s);
    renderSenderChips(s);
    renderMentionChips(s);
    renderComposer(s);
    renderMessages(false);
  }

  /* @all 기본 토글 상태 · 입력창 안내문 */
  function renderComposer(s) {
    var on = !!s.settings.defaultAll;
    if (dom.defaultAllToggle) {
      dom.defaultAllToggle.classList.toggle('is-on', on);
      dom.defaultAllToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      dom.defaultAllToggle.title = on
        ? '@all 기본 켜짐 · @멘션 없이 보내도 AI 비서 전체가 답합니다'
        : '@all 기본 꺼짐 · @이름으로 부를 때만 AI 비서가 답합니다';
    }
    if (dom.msgInput) {
      dom.msgInput.placeholder = on
        ? '메시지를 입력하세요 · @all'
        : '메시지를 입력하세요 (@이름)';
    }
  }

  function renderRoomTabs(s) {
    var html = Object.keys(s.rooms).map(function (rid) {
      var r = s.rooms[rid];
      var active = rid === s.ui.room ? ' is-active' : '';
      return '<button type="button" class="room-tab' + active + '" data-room="' + esc(rid) +
        '" role="tab" aria-selected="' + (rid === s.ui.room ? 'true' : 'false') + '">' +
        '<span class="room-tab-icon" aria-hidden="true">' + esc(r.icon) + '</span>' +
        esc(r.name) + '</button>';
    }).join('');
    dom.roomTabs.innerHTML = html;
  }

  function renderRoomMeta(s) {
    var room = s.rooms[s.ui.room];
    if (!room) return;
    dom.roomMetaName.textContent = room.icon + ' ' + room.name;
    dom.roomMetaOn.textContent = 'ON ' + (s.assistants.length + 1) + '명';
    dom.roomMetaOn.title = '참여 인원 (대장님 + 비서 ' + s.assistants.length + '명)';
  }

  function renderSenderChips(s) {
    var options = store.senderOptions();
    var activeId = s.settings.senderId || 'me';
    var html = options.map(function (o) {
      var label = o.id === 'me' ? o.name + '(' + o.role + ')' : o.name;
      return '<button type="button" class="chip' + (o.id === activeId ? ' is-active' : '') +
        '" data-sender="' + esc(o.id) + '" aria-pressed="' + (o.id === activeId ? 'true' : 'false') + '">' +
        '<span aria-hidden="true">' + esc(o.icon) + '</span>' + esc(label) + '</button>';
    }).join('');
    dom.senderChips.innerHTML = html;
  }

  function renderMentionChips(s) {
    var html = '<button type="button" class="chip chip--mention" data-mention="@all">@all</button>' +
      s.assistants.map(function (a) {
        return '<button type="button" class="chip chip--mention" data-mention="@' + esc(a.name) + '">@' +
          esc(a.name) + '</button>';
      }).join('');
    dom.mentionChips.innerHTML = html;
  }

  function highlight(escaped) {
    return escaped.replace(/@[^\s@<]+/g, function (m) {
      return '<span class="mention">' + m + '</span>';
    });
  }

  function messageHtml(m, s) {
    var activeSender = s.settings.senderId || 'me';
    var isMe = m.senderId === activeSender;
    var head = '<div class="msg-head">' +
      '<span class="msg-name">' + esc(m.senderName) + '</span>' +
      (m.senderRole ? '<span class="msg-role">' + esc(m.senderRole) + '</span>' : '') +
      (m.ai ? '<span class="msg-ai-tag">AI</span>' : '') +
      '<span class="msg-time">' + esc(formatTime(m.ts)) + '</span>' +
      '</div>';
    var avatar = '<div class="msg-avatar" aria-hidden="true">' + esc(m.senderIcon) + '</div>';
    var bubble = '<div class="bubble">' + highlight(esc(m.text)) + '</div>';

    if (isMe) {
      return '<div class="msg msg--me"><div class="msg-body">' + head + bubble + '</div>' +
        avatar + '</div>';
    }
    return '<div class="msg">' + avatar + '<div class="msg-body">' + head + bubble + '</div></div>';
  }

  function renderMessages(forceScroll) {
    var s = store.get();
    var roomId = s.ui.room;
    var room = s.rooms[roomId];
    var list = dom.messageList;
    if (!room) { list.innerHTML = ''; return; }

    var nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    var html = '';
    var prevDay = '';

    room.messages.forEach(function (m) {
      var dk = dayKey(m.ts);
      if (dk !== prevDay) {
        html += '<div class="day-divider">' + esc(formatDay(m.ts)) + '</div>';
        prevDay = dk;
      }
      html += messageHtml(m, s);
    });

    var t = typing[roomId] || [];
    t.forEach(function (aid) {
      var a = findById(s.assistants, aid);
      if (!a) return;
      html += '<div class="msg">' +
        '<div class="msg-avatar" aria-hidden="true">' + esc(a.icon) + '</div>' +
        '<div class="msg-body"><div class="msg-head">' +
        '<span class="msg-name">' + esc(a.name) + '</span>' +
        '<span class="msg-role">' + esc(a.role) + '</span></div>' +
        '<div class="typing-dots"><i></i><i></i><i></i></div></div></div>';
    });

    if (!html) {
      html = '<div class="msg-empty"><span>💬</span>' + esc(room.name) +
        '에 아직 대화가 없습니다.<br>아래에서 첫 메시지를 보내보세요.</div>';
    }

    list.innerHTML = html;

    if (forceScroll || lastRenderedRoom !== roomId || nearBottom) {
      list.scrollTop = list.scrollHeight;
    }
    lastRenderedRoom = roomId;
  }

  /* =======================================================
     작업실
     ======================================================= */
  function taskHtml(t) {
    var pillCls = t.status === '완료' ? 'pill--done'
      : (t.status === '진행중' ? 'pill--doing' : 'pill--wait');
    var nextLabel = t.status === '대기' ? '시작'
      : (t.status === '진행중' ? '완료' : '되돌리기');
    return '<div class="card' + (t.status === '완료' ? ' is-done' : '') + '">' +
      '<div class="card-main">' +
      '<p class="card-title">' + esc(t.title) + '</p>' +
      '<div class="card-meta">' +
      '<span class="pill ' + pillCls + '">' + esc(t.status) + '</span>' +
      '<span>담당 · ' + esc(t.assignee) + '</span><span>·</span>' +
      '<span>' + esc(formatShort(t.createdAt)) + '</span></div></div>' +
      '<button type="button" class="status-btn" data-task-next="' + esc(t.id) + '">' +
      nextLabel + '</button>' +
      '<button type="button" class="icon-x" data-task-del="' + esc(t.id) +
      '" aria-label="작업 삭제">✕</button></div>';
  }

  function renderTasks() {
    var s = store.get();
    var counts = { '대기': 0, '진행중': 0, '완료': 0 };
    s.tasks.forEach(function (t) {
      if (counts[t.status] !== undefined) counts[t.status]++;
    });
    dom.taskSummary.textContent = '대기 ' + counts['대기'] + ' · 진행중 ' + counts['진행중'] +
      ' · 완료 ' + counts['완료'];

    var prev = dom.taskAssignee.value;
    var opts = ['<option value="미지정">담당 미지정</option>'];
    s.assistants.forEach(function (a) {
      opts.push('<option value="' + esc(a.name) + '">' + esc(a.icon + ' ' + a.name) + '</option>');
    });
    dom.taskAssignee.innerHTML = opts.join('');
    if (prev) {
      var exists = false;
      for (var i = 0; i < dom.taskAssignee.options.length; i++) {
        if (dom.taskAssignee.options[i].value === prev) exists = true;
      }
      dom.taskAssignee.value = exists ? prev : '미지정';
    }

    var filters = [['all', '전체'], ['대기', '대기'], ['진행중', '진행중'], ['완료', '완료']];
    dom.taskFilters.innerHTML = filters.map(function (f) {
      return '<button type="button" class="filter-chip' +
        (s.ui.taskFilter === f[0] ? ' is-active' : '') + '" data-filter="' + f[0] + '">' +
        f[1] + '</button>';
    }).join('');

    var list = s.tasks.filter(function (t) {
      return s.ui.taskFilter === 'all' || t.status === s.ui.taskFilter;
    });

    if (!list.length) {
      dom.taskList.innerHTML = '<p class="empty-note">표시할 작업이 없습니다.</p>';
      return;
    }
    dom.taskList.innerHTML = list.map(taskHtml).join('');
  }

  /* =======================================================
     비서현황
     ======================================================= */
  function renderTeam() {
    var s = store.get();
    dom.teamSummary.textContent = '참여 중인 비서 ' + s.assistants.length + '명';

    var meCard = '<div class="member-card is-me">' +
      '<div class="member-avatar" aria-hidden="true">👑</div>' +
      '<div class="member-body">' +
      '<p class="member-name">범용 <span class="tag tag--me">대장님</span></p>' +
      '<p class="member-role">비서실 총괄 · 메시지 발신자</p></div></div>';

    var cards = s.assistants.map(function (a) {
      var tags = '';
      if (a.pickle) tags += '<span class="tag tag--pickle">피클</span>';
      if (a.ai) tags += '<span class="tag tag--ai">AI 응답</span>';
      return '<div class="member-card">' +
        '<div class="member-avatar" aria-hidden="true">' + esc(a.icon) + '</div>' +
        '<div class="member-body">' +
        '<p class="member-name">' + esc(a.name) + tags + '</p>' +
        '<p class="member-role">' + esc(a.role) + '</p></div>' +
        '<div class="member-actions">' +
        '<button type="button" class="member-edit" data-assistant-edit="' + esc(a.id) +
        '" aria-label="' + esc(a.name) + ' 수정">✏️</button>' +
        '<button type="button" class="member-edit" data-assistant-del="' + esc(a.id) +
        '" aria-label="' + esc(a.name) + ' 삭제">🗑️</button>' +
        '</div></div>';
    }).join('');

    dom.teamList.innerHTML = meCard + cards;
  }

  /* =======================================================
     메모
     ======================================================= */
  function renderMemos() {
    var s = store.get();
    dom.memoSummary.textContent = '공유 메모 ' + s.memos.length + '개 · 결정사항';

    if (!s.memos.length) {
      dom.memoList.innerHTML = '<p class="empty-note">아직 기록된 메모가 없습니다.</p>';
      return;
    }

    dom.memoList.innerHTML = s.memos.map(function (m) {
      return '<div class="memo-card">' +
        '<p class="memo-text">' + esc(m.text) + '</p>' +
        '<div class="memo-foot"><span>' + esc(m.author) + '</span><span>·</span>' +
        '<span>' + esc(formatShort(m.ts) + ' ' + formatTime(m.ts)) + '</span>' +
        '<button type="button" class="memo-del" data-memo-del="' + esc(m.id) + '">삭제</button>' +
        '</div></div>';
    }).join('');
  }

  /* =======================================================
     전체 렌더
     ======================================================= */
  function renderAll() {
    renderHeader();
    renderTabs();
    renderMap();
    renderChat();
    renderTasks();
    renderTeam();
    renderMemos();
    if (dom.settingsModal && !dom.settingsModal.hidden) renderSettingsInfo();
  }

  /* =======================================================
     모달
     ======================================================= */
  function openModal(id) {
    var m = $(id);
    if (!m) return;
    m.hidden = false;
    doc.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    var m = $(id);
    if (!m) return;
    m.hidden = true;
    var anyOpen = doc.querySelector('.modal:not([hidden])');
    if (!anyOpen) doc.body.style.overflow = '';
  }

  function confirmAction(title, message, onOk) {
    dom.confirmTitle.textContent = title;
    dom.confirmMessage.textContent = message;
    confirmHandler = onOk;
    openModal('confirmModal');
  }

  /* =======================================================
     설정
     ======================================================= */
  function renderSettingsInfo() {
    var s = store.get();
    var msgCount = 0;
    Object.keys(s.rooms).forEach(function (rid) { msgCount += s.rooms[rid].messages.length; });
    dom.dataInfo.textContent = '이 기기 저장소(localStorage)에 메시지 ' + msgCount + '개 · 작업 ' +
      s.tasks.length + '개 · 비서 ' + s.assistants.length + '명 · 메모 ' + s.memos.length +
      '개가 저장되어 있습니다.';
  }

  function renderSettingsConnStatus(st) {
    st = st || SO.sync.status();
    var box = dom.settingsConnStatus;
    box.className = 'conn-status';
    var text;
    if (st.mode === 'live') {
      box.classList.add('is-live');
      text = st.message ? st.message + ' · 3초마다 동기화 중' : '실시간 DB 연결됨 · 3초마다 동기화 중';
    } else if (st.mode === 'error') {
      box.classList.add('is-error');
      text = '연결 오류 · ' + st.message;
    } else if (st.mode === 'connecting') {
      text = '연결 확인 중…';
    } else {
      text = '로컬 모드로 동작 중 · 이 기기에만 저장됩니다.';
    }
    box.textContent = text;
  }

  function openSettings() {
    var s = store.get();
    dom.settingOfficeName.value = s.officeName;
    dom.settingFirebaseUrl.value = s.settings.firebaseUrl;
    dom.settingFirebaseEmail.value = s.settings.firebaseEmail || '';
    dom.settingFirebasePassword.value = s.settings.firebasePassword || '';
    dom.settingFirebaseApiKey.value = s.settings.firebaseApiKey || '';
    dom.settingGeminiKey.value = s.settings.geminiKey;
    dom.settingGeminiModel.value = s.settings.geminiModel || 'gemini-3.5-flash-lite';
    renderSettingsInfo();
    renderSettingsConnStatus(SO.sync.status());
    openModal('settingsModal');
  }

  function saveSettings() {
    var name = dom.settingOfficeName.value.trim();
    var url = dom.settingFirebaseUrl.value.trim();
    var hadUrl = !!SO.sync.hasUrl();

    store.setSettings({
      firebaseUrl: url,
      firebaseEmail: dom.settingFirebaseEmail.value.trim(),
      firebasePassword: dom.settingFirebasePassword.value,
      firebaseApiKey: dom.settingFirebaseApiKey.value.trim(),
      geminiKey: dom.settingGeminiKey.value.trim(),
      geminiModel: dom.settingGeminiModel.value.trim() || 'gemini-3.5-flash-lite'
    });
    if (name) store.renameOffice(name);

    closeModal('settingsModal');

    if (!url) {
      if (hadUrl || SO.sync.status().mode !== 'local') SO.sync.disconnect();
      toast('설정을 저장했습니다. 로컬 모드로 동작합니다.');
      return;
    }

    toast('설정을 저장했습니다.');
    SO.sync.connect().then(function (res) {
      if (!res || !res.ok) {
        toast('DB 연결 실패: ' + (res && res.error ? res.error : '알 수 없는 오류'), 4200);
        return;
      }
      if (res.seeded) toast('실시간 DB 연결됨 · 현재 내용을 새 DB에 올렸습니다.', 3200);
      else toast('실시간 DB 연결됨 · DB 내용을 불러왔습니다.', 3200);
    });
  }

  function testConnection() {
    var url = dom.settingFirebaseUrl.value.trim();
    dom.settingsConnStatus.className = 'conn-status';
    dom.settingsConnStatus.textContent = '연결 확인 중…';
    SO.sync.test(url).then(function () {
      dom.settingsConnStatus.className = 'conn-status is-live';
      var label = SO.sync.hasAuth() ? '인증 후 ' : '';
      dom.settingsConnStatus.textContent = '연결 성공 · ' + label + '읽기 가능. (저장을 누르면 동기화가 시작됩니다)';
    }, function (err) {
      dom.settingsConnStatus.className = 'conn-status is-error';
      dom.settingsConnStatus.textContent = '연결 실패 · ' + (err && err.message ? err.message : '알 수 없는 오류');
    });
  }

  function disconnectDb() {
    store.setSettings({ firebaseUrl: '' });
    dom.settingFirebaseUrl.value = '';
    SO.sync.disconnect();
    renderSettingsConnStatus(SO.sync.status());
    toast('연결을 해제했습니다. 이 기기 저장 내용으로 동작합니다.');
  }

  function resetData() {
    confirmAction('이 기기 데이터 초기화',
      '이 브라우저에 저장된 메시지·작업·비서·메모를 처음 상태로 되돌립니다.\n' +
      '연결된 DB의 데이터는 그대로 남아 있습니다.\n계속할까요?',
      function () {
        store.resetLocal();
        closeModal('settingsModal');
        toast('이 기기 데이터를 초기화했습니다.');
        if (SO.sync.hasUrl()) SO.sync.connect();
      });
  }

  /* =======================================================
     비서 편집
     ======================================================= */
  function renderIconPicker(selected) {
    dom.iconPicker.innerHTML = ICONS.map(function (ic) {
      return '<button type="button" class="icon-choice' + (ic === selected ? ' is-active' : '') +
        '" data-icon="' + esc(ic) + '">' + esc(ic) + '</button>';
    }).join('');
  }

  function openAssistantModal(id) {
    var s = store.get();
    var a = id ? findById(s.assistants, id) : null;
    dom.assistantTitle.textContent = a ? '비서 수정' : '비서 추가';
    dom.assistantId.value = a ? a.id : '';
    dom.assistantName.value = a ? a.name : '';
    dom.assistantRole.value = a ? a.role : '';
    dom.assistantIcon.value = a ? a.icon : '🙂';
    dom.assistantAi.checked = a ? !!a.ai : false;
    renderIconPicker(a ? a.icon : '🙂');
    openModal('assistantModal');
    if (!a) setTimeout(function () { dom.assistantName.focus(); }, 250);
  }

  function saveAssistant() {
    var name = dom.assistantName.value.trim();
    if (!name) { toast('이름을 입력해 주세요.'); dom.assistantName.focus(); return; }

    var data = {
      name: name,
      role: dom.assistantRole.value.trim() || '비서',
      icon: dom.assistantIcon.value.trim() || '🙂',
      ai: dom.assistantAi.checked
    };

    if (dom.assistantId.value) {
      store.updateAssistant(dom.assistantId.value, data);
      toast('비서 정보를 수정했습니다.');
    } else {
      store.addAssistant(data);
      toast('비서를 추가했습니다.');
    }
    closeModal('assistantModal');
  }

  /* =======================================================
     메시지 전송 · AI 호출
     ======================================================= */
  function autoGrow() {
    var el = dom.msgInput;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  function insertMention(token) {
    var el = dom.msgInput;
    var start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
    var end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
    var val = el.value;
    var insert = token + ' ';
    el.value = val.slice(0, start) + insert + val.slice(end);
    var pos = start + insert.length;
    el.focus();
    try { el.setSelectionRange(pos, pos); } catch (err) { /* ignore */ }
    autoGrow();
  }

  function pickAiTargets(text, useDefaultAll) {
    var tokens = (text.match(/@[^\s@]+/g) || []).map(function (t) { return t.slice(1); });
    var senderId = store.get().settings.senderId || 'me';
    var all = tokens.some(function (t) { return t === 'all' || t === '전체' || t === '모두'; });

    /* @멘션이 없으면 ‘@all 기본’이 켜진 동안 전체 AI 비서를 호출한다 */
    if (!tokens.length && useDefaultAll) all = true;

    return store.get().assistants.filter(function (a) {
      if (!a.ai || a.id === senderId) return false;
      if (all) return true;
      var an = norm(a.name);
      return tokens.some(function (t) {
        var tn = norm(t);
        return tn === an || tn.indexOf(an) === 0 || an.indexOf(tn) === 0;
      });
    });
  }

  function addTyping(roomId, id) {
    if (!typing[roomId]) typing[roomId] = [];
    if (typing[roomId].indexOf(id) < 0) typing[roomId].push(id);
    renderMessages(false);
  }

  function removeTyping(roomId, id) {
    if (!typing[roomId]) return;
    typing[roomId] = typing[roomId].filter(function (x) { return x !== id; });
    if (!typing[roomId].length) delete typing[roomId];
    renderMessages(false);
  }

  function askOne(roomId, assistant) {
    addTyping(roomId, assistant.id);
    return SO.ai.reply({ roomId: roomId, assistant: assistant }).then(function (text) {
      removeTyping(roomId, assistant.id);
      if (text) store.addMessage(roomId, text, assistant.id, { ai: true });
    }, function (err) {
      removeTyping(roomId, assistant.id);
      throw err;
    });
  }

  function runReplies(roomId, targets) {
    var chain = Promise.resolve();
    targets.forEach(function (a) {
      chain = chain.then(function () { return delay(400); })
        .then(function () { return askOne(roomId, a); });
    });
    chain.catch(function (err) {
      toast('AI 응답 실패: ' + (err && err.message ? err.message : '알 수 없는 오류'), 4200);
    });
  }

  function sendMessage() {
    var text = dom.msgInput.value;
    if (!text.trim()) return;

    var s = store.get();
    var roomId = s.ui.room;
    store.addMessage(roomId, text, s.settings.senderId || 'me');
    dom.msgInput.value = '';
    autoGrow();

    var targets = pickAiTargets(text, !!s.settings.defaultAll);
    if (!targets.length) return;

    if (!SO.ai.available()) {
      if (!aiHintShown) {
        aiHintShown = true;
        toast('AI 비서 응답을 쓰려면 설정(⚙️)에서 Gemini API 키를 입력하세요.', 3800);
      }
      return;
    }
    runReplies(roomId, targets);
  }

  /* =======================================================
     토스트
     ======================================================= */
  function toast(message, ms) {
    if (hideToastTimer) { clearTimeout(hideToastTimer); hideToastTimer = null; }
    dom.toast.hidden = false;
    dom.toast.textContent = message;
    dom.toast.classList.remove('is-show');
    void dom.toast.offsetWidth;
    dom.toast.classList.add('is-show');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      dom.toast.classList.remove('is-show');
      hideToastTimer = setTimeout(function () { dom.toast.hidden = true; }, 240);
    }, ms || 2600);
  }

  /* =======================================================
     이벤트
     ======================================================= */
  function bindEvents() {
    dom.mainTabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.main-tab');
      if (btn) store.setTab(btn.getAttribute('data-tab'));
    });

    dom.motionToggle.addEventListener('click', function () {
      var on = !store.get().ui.movement;
      store.setMovement(on);
      toast(on ? '캐릭터가 움직이기 시작했어요 ✨' : '캐릭터 움직임을 잠시 멈췄어요', 2200);
    });

    dom.mapPins.addEventListener('click', function (e) {
      var charBtn = e.target.closest('[data-char]');
      if (charBtn) { openCharModal(charBtn.getAttribute('data-char')); return; }

      var roomBtn = e.target.closest('[data-map-room]');
      if (!roomBtn) return;
      var key = roomBtn.getAttribute('data-map-room');
      var target = null;
      MAP_ROOMS.forEach(function (r) { if (r.key === key) target = r; });
      if (!target) return;
      if (target.room) store.setRoom(target.room);
      store.setTab(target.tab);
    });

    dom.mapPartList.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-char]');
      if (btn) openCharModal(btn.getAttribute('data-char'));
    });

    dom.charGoRoomBtn.addEventListener('click', function () {
      if (!charTargetId) { closeModal('charModal'); return; }
      store.setRoom(charTargetRoom);
      store.setTab('chat');
      closeModal('charModal');
    });

    dom.roomTabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.room-tab');
      if (btn) store.setRoom(btn.getAttribute('data-room'));
    });

    dom.senderChips.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-sender]');
      if (btn) store.setSender(btn.getAttribute('data-sender'));
    });

    dom.mentionChips.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-mention]');
      if (btn) insertMention(btn.getAttribute('data-mention'));
    });

    dom.sendBtn.addEventListener('click', sendMessage);

    dom.defaultAllToggle.addEventListener('click', function () {
      var on = !store.get().settings.defaultAll;
      store.setDefaultAll(on);
      toast(on ? '@all 기본 켜짐 · 이제 @멘션 없이 보내도 전체가 답합니다.'
               : '@all 기본 꺼짐 · @이름으로 부를 때만 답합니다.', 2600);
    });

    dom.msgInput.addEventListener('input', autoGrow);
    dom.msgInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });

    dom.taskForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = dom.taskTitle.value.trim();
      if (!title) { dom.taskTitle.focus(); return; }
      store.addTask(title, dom.taskAssignee.value || '미지정');
      dom.taskTitle.value = '';
      toast('작업을 추가했습니다.');
    });

    dom.taskFilters.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-filter]');
      if (btn) store.setTaskFilter(btn.getAttribute('data-filter'));
    });

    dom.taskList.addEventListener('click', function (e) {
      var nextBtn = e.target.closest('[data-task-next]');
      if (nextBtn) {
        var id = nextBtn.getAttribute('data-task-next');
        var task = findById(store.get().tasks, id);
        if (task) {
          var next = task.status === '대기' ? '진행중' : (task.status === '진행중' ? '완료' : '대기');
          store.setTaskStatus(id, next);
        }
        return;
      }
      var delBtn = e.target.closest('[data-task-del]');
      if (delBtn) {
        var tid = delBtn.getAttribute('data-task-del');
        confirmAction('작업 삭제', '이 작업을 삭제할까요?', function () {
          store.removeTask(tid);
          toast('작업을 삭제했습니다.');
        });
      }
    });

    dom.teamList.addEventListener('click', function (e) {
      var editBtn = e.target.closest('[data-assistant-edit]');
      if (editBtn) { openAssistantModal(editBtn.getAttribute('data-assistant-edit')); return; }

      var delBtn = e.target.closest('[data-assistant-del]');
      if (delBtn) {
        var aid = delBtn.getAttribute('data-assistant-del');
        var a = findById(store.get().assistants, aid);
        confirmAction('비서 삭제', (a ? a.name : '이 비서') + '를 목록에서 삭제할까요?\n지난 대화는 그대로 남습니다.', function () {
          store.removeAssistant(aid);
          toast('비서를 삭제했습니다.');
        });
      }
    });

    dom.addAssistantBtn.addEventListener('click', function () { openAssistantModal(null); });

    dom.iconPicker.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-icon]');
      if (!btn) return;
      dom.assistantIcon.value = btn.getAttribute('data-icon');
      renderIconPicker(dom.assistantIcon.value);
    });

    dom.assistantForm.addEventListener('submit', function (e) {
      e.preventDefault();
      saveAssistant();
    });

    dom.memoForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = dom.memoInput.value.trim();
      if (!text) { dom.memoInput.focus(); return; }
      store.addMemo(text);
      dom.memoInput.value = '';
      toast('메모를 기록했습니다.');
    });

    dom.memoList.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-memo-del]');
      if (!btn) return;
      var id = btn.getAttribute('data-memo-del');
      confirmAction('메모 삭제', '이 메모를 삭제할까요?', function () {
        store.removeMemo(id);
        toast('메모를 삭제했습니다.');
      });
    });

    dom.settingsBtn.addEventListener('click', openSettings);
    dom.saveSettingsBtn.addEventListener('click', saveSettings);
    dom.testConnBtn.addEventListener('click', testConnection);
    dom.disconnectBtn.addEventListener('click', disconnectDb);
    dom.resetDataBtn.addEventListener('click', resetData);

    dom.confirmOkBtn.addEventListener('click', function () {
      var fn = confirmHandler;
      confirmHandler = null;
      closeModal('confirmModal');
      if (typeof fn === 'function') fn();
    });

    dom.confirmCancelBtn.addEventListener('click', function () {
      confirmHandler = null;
      closeModal('confirmModal');
    });

    doc.addEventListener('click', function (e) {
      var closer = e.target.closest('[data-close]');
      if (closer) closeModal(closer.getAttribute('data-close'));
    });

    doc.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      ['charModal', 'confirmModal', 'assistantModal', 'settingsModal'].forEach(function (id) {
        var m = $(id);
        if (m && !m.hidden) closeModal(id);
      });
    });
  }

  /* =======================================================
     초기화
     ======================================================= */
  function cacheDom() {
    dom.officeName = $('officeName');
    dom.officeSub = $('officeSub');
    dom.connBadge = $('connBadge');
    dom.connText = $('connText');
    dom.settingsBtn = $('settingsBtn');
    dom.mainTabs = $('mainTabs');
    dom.views = $('views');
    dom.mapHeroTitle = $('mapHeroTitle');
    dom.mapPartsChip = $('mapPartsChip');
    dom.mapOnChip = $('mapOnChip');
    dom.motionToggle = $('motionToggle');
    dom.motionLabel = $('motionLabel');
    dom.mapStage = $('mapStage');
    dom.mapPins = $('mapPins');
    dom.mapPartList = $('mapPartList');
    dom.mapReportSub = $('mapReportSub');
    dom.charModal = $('charModal');
    dom.charAvatar = $('charAvatar');
    dom.charName = $('charName');
    dom.charRole = $('charRole');
    dom.charStatus = $('charStatus');
    dom.charReport = $('charReport');
    dom.charTasks = $('charTasks');
    dom.charGoRoomBtn = $('charGoRoomBtn');
    dom.roomTabs = $('roomTabs');
    dom.roomMetaName = $('roomMetaName');
    dom.roomMetaOn = $('roomMetaOn');
    dom.messageList = $('messageList');
    dom.senderChips = $('senderChips');
    dom.mentionChips = $('mentionChips');
    dom.msgInput = $('msgInput');
    dom.sendBtn = $('sendBtn');
    dom.defaultAllToggle = $('defaultAllToggle');
    dom.taskForm = $('taskForm');
    dom.taskTitle = $('taskTitle');
    dom.taskAssignee = $('taskAssignee');
    dom.taskFilters = $('taskFilters');
    dom.taskList = $('taskList');
    dom.taskSummary = $('taskSummary');
    dom.teamList = $('teamList');
    dom.teamSummary = $('teamSummary');
    dom.addAssistantBtn = $('addAssistantBtn');
    dom.memoForm = $('memoForm');
    dom.memoInput = $('memoInput');
    dom.memoList = $('memoList');
    dom.memoSummary = $('memoSummary');
    dom.settingsModal = $('settingsModal');
    dom.settingOfficeName = $('settingOfficeName');
    dom.settingFirebaseUrl = $('settingFirebaseUrl');
    dom.settingFirebaseEmail = $('settingFirebaseEmail');
    dom.settingFirebasePassword = $('settingFirebasePassword');
    dom.settingFirebaseApiKey = $('settingFirebaseApiKey');
    dom.settingGeminiKey = $('settingGeminiKey');
    dom.settingGeminiModel = $('settingGeminiModel');
    dom.settingsConnStatus = $('settingsConnStatus');
    dom.testConnBtn = $('testConnBtn');
    dom.disconnectBtn = $('disconnectBtn');
    dom.resetDataBtn = $('resetDataBtn');
    dom.dataInfo = $('dataInfo');
    dom.saveSettingsBtn = $('saveSettingsBtn');
    dom.assistantModal = $('assistantModal');
    dom.assistantTitle = $('assistantTitle');
    dom.assistantForm = $('assistantForm');
    dom.assistantId = $('assistantId');
    dom.assistantIcon = $('assistantIcon');
    dom.assistantName = $('assistantName');
    dom.assistantRole = $('assistantRole');
    dom.assistantAi = $('assistantAi');
    dom.iconPicker = $('iconPicker');
    dom.confirmModal = $('confirmModal');
    dom.confirmTitle = $('confirmTitle');
    dom.confirmMessage = $('confirmMessage');
    dom.confirmOkBtn = $('confirmOkBtn');
    dom.confirmCancelBtn = $('confirmCancelBtn');
    dom.toast = $('toast');
  }

  function init() {
    cacheDom();
    bindEvents();

    store.subscribe(renderAll);
    SO.sync.subscribe(renderConn);

    renderAll();
    renderConn();
    autoGrow();
    SO.sync.init();

    /* 첫 화면에서 지휘실 대화가 바로 보이도록 */
    setTimeout(function () { renderMessages(true); }, 60);
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);
