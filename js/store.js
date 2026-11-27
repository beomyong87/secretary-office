/* =========================================================
   store.js — 상태 · localStorage 영속화
   ========================================================= */
(function (global) {
  'use strict';

  var SO = global.SO = global.SO || {};
  var STORAGE_KEY = 'secretaryOffice.v1';

  /* 기본 Gemini 모델 — 무료 API 키에서도 동작하는 모델 */
  var DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
  /* 예전 기본값으로 저장된 기기는 새 기본값으로 옮긴다 */
  var LEGACY_GEMINI_MODELS = { 'gemini-2.5-flash': DEFAULT_GEMINI_MODEL };

  /* ---------- 유틸 ---------- */
  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 7);
  }

  function nowTs() { return Date.now(); }

  function str(v, fallback) {
    return (typeof v === 'string' && v) ? v : (fallback || '');
  }

  function normalizeGeminiModel(v) {
    var m = str(v, DEFAULT_GEMINI_MODEL).trim();
    if (!m) return DEFAULT_GEMINI_MODEL;
    return LEGACY_GEMINI_MODELS[m] || m;
  }

  function me() {
    return { id: 'me', name: '범용', role: '대장님', icon: '👑' };
  }

  function defaultAssistants() {
    return [
      { id: 'a-yong', name: '용이', role: '피클 · 총괄', icon: '🥒', ai: false, pickle: true, createdAt: 1 },
      { id: 'a-research', name: '리서처', role: '조사 · 리서치', icon: '🔎', ai: true, createdAt: 2 },
      { id: 'a-plan', name: '기획담당', role: '기획 · 정리', icon: '📐', ai: true, createdAt: 3 }
    ];
  }

  function seedMessages(roomId) {
    if (roomId !== 'command') return [];
    var t = nowTs();
    var min = 60 * 1000;
    return [
      {
        id: 'seed-cmd-1', senderId: 'me', senderName: '범용', senderRole: '대장님', senderIcon: '👑',
        text: '오늘부터 작업은 여기서 지시한다. 작업 받은 사람은 시작하기 전에 먼저 "실행하겠습니다"라고 보고해. 진행 상황도 수시로 남겨줘 @all',
        ts: t - 42 * min
      },
      {
        id: 'seed-cmd-2', senderId: 'a-research', senderName: '리서처', senderRole: '조사 · 리서치', senderIcon: '🔎',
        text: '네, 대장님! 앞으로 작업 지시를 받으면 시작하기 전에 먼저 "실행하겠습니다"라고 보고드리고 진행하겠습니다! 🔎',
        ts: t - 39 * min
      },
      {
        id: 'seed-cmd-3', senderId: 'a-plan', senderName: '기획담당', senderRole: '기획 · 정리', senderIcon: '📐',
        text: '확인했습니다, 대장님. 지시 받으면 바로 "실행하겠습니다" 보고 후 착수하겠습니다. 📐',
        ts: t - 37 * min
      },
      {
        id: 'seed-cmd-4', senderId: 'a-yong', senderName: '용이', senderRole: '피클 · 총괄', senderIcon: '🥒',
        text: '대장님, 비서실 세팅 마쳤습니다. 회의실·작업실·메모 모두 이 화면에서 관리하실 수 있어요.',
        ts: t - 30 * min
      }
    ];
  }

  function seed() {
    return {
      version: 1,
      officeName: '범용님 합동 비서실',
      rooms: {
        main: { name: '대회의실', icon: '🏛️', messages: [] },
        command: { name: '지휘실', icon: '🎯', messages: seedMessages('command') },
        lounge: { name: '라운지', icon: '☕', messages: [] }
      },
      assistants: defaultAssistants(),
      tasks: [
        { id: 'task-1', title: '비서실 요구사항 정리', status: '완료', assignee: '기획담당', createdAt: nowTs() - 86400000 * 2 },
        { id: 'task-2', title: '실시간 DB 연동 테스트', status: '진행중', assignee: '리서처', createdAt: nowTs() - 86400000 },
        { id: 'task-3', title: '모바일 화면 마무리 점검', status: '대기', assignee: '용이', createdAt: nowTs() - 3600000 }
      ],
      memos: [
        { id: 'memo-1', text: '회의실은 지휘실을 기본으로 사용한다.', author: '범용', ts: nowTs() - 86400000 },
        { id: 'memo-2', text: '작업 시작 전 "실행하겠습니다" 보고 규칙은 계속 유지.', author: '범용', ts: nowTs() - 7200000 }
      ],
      settings: {
        senderId: 'me',
        firebaseUrl: '',
        geminiKey: '',
        geminiModel: DEFAULT_GEMINI_MODEL,
        defaultAll: true
      },
      ui: { tab: 'map', room: 'command', taskFilter: 'all', movement: true }
    };
  }

  /* ---------- 정규화 ---------- */
  function normalizeMessage(raw, fallbackId) {
    if (!raw || typeof raw !== 'object') return null;
    var ts = Number(raw.ts);
    return {
      id: str(raw.id, fallbackId || uid('msg')),
      senderId: str(raw.senderId, 'me'),
      senderName: str(raw.senderName, '비서'),
      senderRole: str(raw.senderRole, ''),
      senderIcon: str(raw.senderIcon, '💬'),
      text: String(raw.text == null ? '' : raw.text),
      ts: isFinite(ts) ? ts : nowTs(),
      ai: !!raw.ai
    };
  }

  function normalizeAssistant(raw, fallbackId) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: str(raw.id, fallbackId || uid('a')),
      name: str(raw.name, '비서'),
      role: str(raw.role, '비서'),
      icon: str(raw.icon, '🙂'),
      ai: !!raw.ai,
      pickle: !!raw.pickle,
      createdAt: Number(raw.createdAt) || nowTs()
    };
  }

  function normalizeTask(raw, fallbackId) {
    if (!raw || typeof raw !== 'object') return null;
    var st = raw.status === '진행중' || raw.status === '완료' ? raw.status : '대기';
    return {
      id: str(raw.id, fallbackId || uid('task')),
      title: String(raw.title == null ? '' : raw.title),
      status: st,
      assignee: str(raw.assignee, '미지정'),
      createdAt: Number(raw.createdAt) || nowTs()
    };
  }

  function normalizeMemo(raw, fallbackId) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: str(raw.id, fallbackId || uid('memo')),
      text: String(raw.text == null ? '' : raw.text),
      author: str(raw.author, '범용'),
      ts: Number(raw.ts) || nowTs()
    };
  }

  function normalize(raw) {
    var base = seed();
    if (!raw || typeof raw !== 'object') return base;

    var s = base;

    if (typeof raw.officeName === 'string' && raw.officeName.trim()) {
      s.officeName = raw.officeName.trim().slice(0, 40);
    }

    if (raw.rooms && typeof raw.rooms === 'object') {
      Object.keys(s.rooms).forEach(function (rid) {
        var src = raw.rooms[rid];
        if (!src || typeof src !== 'object') return;
        if (typeof src.name === 'string' && src.name) s.rooms[rid].name = src.name;
        if (typeof src.icon === 'string' && src.icon) s.rooms[rid].icon = src.icon;
        if (src.messages !== undefined) {
          s.rooms[rid].messages = objectToArray(src.messages)
            .map(function (m) { return normalizeMessage(m.value, m.key); })
            .filter(Boolean)
            .sort(function (a, b) { return a.ts - b.ts; });
        }
      });
    }

    if (Array.isArray(raw.assistants)) {
      var list = raw.assistants.map(function (a) { return normalizeAssistant(a); }).filter(Boolean);
      if (list.length) s.assistants = list;
    } else if (raw.assistants && typeof raw.assistants === 'object') {
      var alist = objectToArray(raw.assistants).map(function (a) { return normalizeAssistant(a.value, a.key); }).filter(Boolean);
      if (alist.length) s.assistants = alist;
    }

    if (Array.isArray(raw.tasks)) {
      s.tasks = raw.tasks.map(function (t) { return normalizeTask(t); }).filter(Boolean);
    } else if (raw.tasks && typeof raw.tasks === 'object') {
      s.tasks = objectToArray(raw.tasks).map(function (t) { return normalizeTask(t.value, t.key); }).filter(Boolean);
    }

    if (Array.isArray(raw.memos)) {
      s.memos = raw.memos.map(function (m) { return normalizeMemo(m); }).filter(Boolean);
    } else if (raw.memos && typeof raw.memos === 'object') {
      s.memos = objectToArray(raw.memos).map(function (m) { return normalizeMemo(m.value, m.key); }).filter(Boolean);
    }

    if (raw.settings && typeof raw.settings === 'object') {
      s.settings.senderId = str(raw.settings.senderId, 'me');
      s.settings.firebaseUrl = str(raw.settings.firebaseUrl, '');
      s.settings.geminiKey = str(raw.settings.geminiKey, '');
      s.settings.geminiModel = normalizeGeminiModel(raw.settings.geminiModel);
      /* 저장된 값이 없으면 기본 ON */
      s.settings.defaultAll = raw.settings.defaultAll === undefined
        ? true : !!raw.settings.defaultAll;
    }

    if (raw.ui && typeof raw.ui === 'object') {
      if (['map', 'chat', 'tasks', 'team', 'memos'].indexOf(raw.ui.tab) >= 0) s.ui.tab = raw.ui.tab;
      /* 이전 버전 저장값(movement 없음)은 첫 화면을 새 오피스 맵으로 한 번 맞춘다 */
      if (raw.ui.movement === undefined) s.ui.tab = 'map';
      if (s.rooms[raw.ui.room]) s.ui.room = raw.ui.room;
      if (['all', '대기', '진행중', '완료'].indexOf(raw.ui.taskFilter) >= 0) s.ui.taskFilter = raw.ui.taskFilter;
      s.ui.movement = raw.ui.movement === undefined ? true : !!raw.ui.movement;
    }

    return s;
  }

  function objectToArray(obj) {
    if (!obj || typeof obj !== 'object') return [];
    return Object.keys(obj).map(function (k) { return { key: k, value: obj[k] }; });
  }

  /* ---------- 상태 ---------- */
  var state = loadState();
  var subscribers = [];
  var writeHooks = [];

  function loadState() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return seed();
      var parsed = JSON.parse(raw);
      var storedModel = parsed && parsed.settings ? parsed.settings.geminiModel : undefined;
      var s = normalize(parsed);
      /* 모델명이 바뀐 경우(마이그레이션)는 다음 저장을 기다리지 않고 바로 확정한다 */
      if (storedModel !== s.settings.geminiModel) {
        try { global.localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (err) { /* ignore */ }
      }
      return s;
    } catch (err) {
      return seed();
    }
  }

  function persist() {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      return false;
    }
  }

  function notify() {
    for (var i = 0; i < subscribers.length; i++) {
      try { subscribers[i](state); } catch (err) { /* ignore */ }
    }
  }

  function emit(op) {
    for (var i = 0; i < writeHooks.length; i++) {
      try { writeHooks[i](op); } catch (err) { /* ignore */ }
    }
  }

  function commit(op) {
    persist();
    notify();
    if (op) emit(op);
  }

  function resolveSender(id) {
    if (!id || id === 'me') return me();
    for (var i = 0; i < state.assistants.length; i++) {
      if (state.assistants[i].id === id) {
        var a = state.assistants[i];
        return { id: a.id, name: a.name, role: a.role, icon: a.icon };
      }
    }
    return me();
  }

  /* ---------- 공개 API ---------- */
  var api = {
    uid: uid,
    me: function () { return me(); },

    get: function () { return state; },

    subscribe: function (fn) {
      if (typeof fn === 'function') subscribers.push(fn);
    },

    onWrite: function (fn) {
      if (typeof fn === 'function') writeHooks.push(fn);
    },

    resolveSender: resolveSender,

    senderOptions: function () {
      var opts = [{ id: 'me', name: me().name, role: me().role, icon: me().icon }];
      state.assistants.forEach(function (a) {
        opts.push({ id: a.id, name: a.name, role: a.role, icon: a.icon });
      });
      return opts;
    },

    /* --- UI --- */
    setTab: function (tab) {
      if (['map', 'chat', 'tasks', 'team', 'memos'].indexOf(tab) < 0) return;
      if (state.ui.tab === tab) return;
      state.ui.tab = tab;
      persist();
      notify();
    },

    /* 오피스 맵 캐릭터 움직임 (이 기기에만 저장 · DB로 동기화되지 않음) */
    setMovement: function (on) {
      var v = !!on;
      if (state.ui.movement === v) return;
      state.ui.movement = v;
      persist();
      notify();
    },

    setRoom: function (roomId) {
      if (!state.rooms[roomId] || state.ui.room === roomId) return;
      state.ui.room = roomId;
      persist();
      notify();
    },

    setTaskFilter: function (filter) {
      if (['all', '대기', '진행중', '완료'].indexOf(filter) < 0) return;
      state.ui.taskFilter = filter;
      persist();
      notify();
    },

    /* --- 메시지 --- */
    addMessage: function (roomId, text, senderId, extra) {
      var room = state.rooms[roomId];
      var body = String(text || '').trim();
      if (!room || !body) return null;
      var s = resolveSender(senderId);
      var msg = {
        id: uid('msg'),
        senderId: s.id,
        senderName: s.name,
        senderRole: s.role,
        senderIcon: s.icon,
        text: body,
        ts: nowTs(),
        ai: !!(extra && extra.ai)
      };
      room.messages.push(msg);
      commit({ type: 'set', path: 'rooms/' + roomId + '/messages/' + msg.id, value: msg });
      return msg;
    },

    /* --- 작업 --- */
    addTask: function (title, assignee) {
      var t = String(title || '').trim();
      if (!t) return null;
      var task = {
        id: uid('task'),
        title: t.slice(0, 200),
        status: '대기',
        assignee: String(assignee || '미지정'),
        createdAt: nowTs()
      };
      state.tasks.push(task);
      commit({ type: 'set', path: 'tasks/' + task.id, value: task });
      return task;
    },

    setTaskStatus: function (id, status) {
      var task = null;
      state.tasks.forEach(function (t) { if (t.id === id) task = t; });
      if (!task) return;
      task.status = status;
      commit({ type: 'set', path: 'tasks/' + task.id, value: task });
    },

    removeTask: function (id) {
      var idx = -1;
      state.tasks.forEach(function (t, i) { if (t.id === id) idx = i; });
      if (idx < 0) return;
      state.tasks.splice(idx, 1);
      commit({ type: 'remove', path: 'tasks/' + id });
    },

    /* --- 비서 --- */
    addAssistant: function (data) {
      var a = {
        id: uid('a'),
        name: String(data.name || '').trim().slice(0, 20) || '비서',
        role: String(data.role || '').trim().slice(0, 30) || '비서',
        icon: String(data.icon || '🙂').slice(0, 4) || '🙂',
        ai: !!data.ai,
        pickle: false,
        createdAt: nowTs()
      };
      state.assistants.push(a);
      commit({ type: 'set', path: 'assistants/' + a.id, value: a });
      return a;
    },

    updateAssistant: function (id, patch) {
      var a = null;
      state.assistants.forEach(function (x) { if (x.id === id) a = x; });
      if (!a || !patch) return;
      if (typeof patch.name === 'string' && patch.name.trim()) a.name = patch.name.trim().slice(0, 20);
      if (typeof patch.role === 'string' && patch.role.trim()) a.role = patch.role.trim().slice(0, 30);
      if (typeof patch.icon === 'string' && patch.icon) a.icon = patch.icon.slice(0, 4);
      if (typeof patch.ai === 'boolean') a.ai = patch.ai;
      commit({ type: 'set', path: 'assistants/' + a.id, value: a });
      return a;
    },

    removeAssistant: function (id) {
      if (id === 'me') return;
      var idx = -1;
      state.assistants.forEach(function (a, i) { if (a.id === id) idx = i; });
      if (idx < 0) return;
      state.assistants.splice(idx, 1);
      if (state.settings.senderId === id) state.settings.senderId = 'me';
      commit({ type: 'remove', path: 'assistants/' + id });
    },

    /* --- 메모 --- */
    addMemo: function (text) {
      var body = String(text || '').trim();
      if (!body) return null;
      var memo = {
        id: uid('memo'),
        text: body.slice(0, 1000),
        author: me().name,
        ts: nowTs()
      };
      state.memos.unshift(memo);
      commit({ type: 'set', path: 'memos/' + memo.id, value: memo });
      return memo;
    },

    removeMemo: function (id) {
      var idx = -1;
      state.memos.forEach(function (m, i) { if (m.id === id) idx = i; });
      if (idx < 0) return;
      state.memos.splice(idx, 1);
      commit({ type: 'remove', path: 'memos/' + id });
    },

    /* --- 설정 --- */
    setSender: function (id) {
      if (state.settings.senderId === id) return;
      state.settings.senderId = id;
      persist();
      notify();
    },

    /* @all 기본 토글 (이 기기에만 저장 · DB로 동기화되지 않음) */
    setDefaultAll: function (on) {
      var v = !!on;
      if (state.settings.defaultAll === v) return;
      state.settings.defaultAll = v;
      persist();
      notify();
    },

    renameOffice: function (name) {
      var n = String(name || '').trim().slice(0, 40);
      if (!n || n === state.officeName) return;
      state.officeName = n;
      commit({ type: 'set', path: 'meta/officeName', value: n });
    },

    setSettings: function (patch) {
      if (!patch) return;
      if (typeof patch.firebaseUrl === 'string') state.settings.firebaseUrl = patch.firebaseUrl.trim();
      if (typeof patch.geminiKey === 'string') state.settings.geminiKey = patch.geminiKey.trim();
      if (typeof patch.geminiModel === 'string' && patch.geminiModel.trim()) {
        state.settings.geminiModel = normalizeGeminiModel(patch.geminiModel);
      }
      if (typeof patch.defaultAll === 'boolean') state.settings.defaultAll = patch.defaultAll;
      if (!state.settings.geminiModel) state.settings.geminiModel = DEFAULT_GEMINI_MODEL;
      persist();
      notify();
    },

    /* --- 동기화 보조 --- */
    snapshot: function () {
      var rooms = {};
      Object.keys(state.rooms).forEach(function (rid) {
        var msgs = {};
        state.rooms[rid].messages.forEach(function (m) { msgs[m.id] = m; });
        rooms[rid] = { name: state.rooms[rid].name, icon: state.rooms[rid].icon, messages: msgs };
      });
      var tasks = {};
      state.tasks.forEach(function (t) { tasks[t.id] = t; });
      var assistants = {};
      state.assistants.forEach(function (a) { assistants[a.id] = a; });
      var memos = {};
      state.memos.forEach(function (m) { memos[m.id] = m; });
      return { rooms: rooms, tasks: tasks, assistants: assistants, memos: memos };
    },

    applyRemote: function (remote) {
      if (!remote) { persist(); notify(); return; }

      if (remote.meta && typeof remote.meta.officeName === 'string' && remote.meta.officeName.trim()) {
        state.officeName = remote.meta.officeName.trim().slice(0, 40);
      }

      if (remote.rooms && typeof remote.rooms === 'object') {
        Object.keys(state.rooms).forEach(function (rid) {
          var src = remote.rooms[rid];
          if (!src || typeof src !== 'object') return;
          if (typeof src.name === 'string' && src.name) state.rooms[rid].name = src.name;
          if (typeof src.icon === 'string' && src.icon) state.rooms[rid].icon = src.icon;
          var msgs = objectToArray(src.messages)
            .map(function (m) { return normalizeMessage(m.value, m.key); })
            .filter(Boolean)
            .sort(function (a, b) { return a.ts - b.ts; });
          state.rooms[rid].messages = msgs;
        });
      }

      if (remote.assistants !== undefined && remote.assistants !== null) {
        var alist = objectToArray(remote.assistants)
          .map(function (a) { return normalizeAssistant(a.value, a.key); })
          .filter(Boolean)
          .sort(function (a, b) { return a.createdAt - b.createdAt; });
        if (alist.length) state.assistants = alist;
      }

      if (remote.tasks !== undefined && remote.tasks !== null) {
        state.tasks = objectToArray(remote.tasks)
          .map(function (t) { return normalizeTask(t.value, t.key); })
          .filter(Boolean)
          .sort(function (a, b) { return a.createdAt - b.createdAt; });
      }

      if (remote.memos !== undefined && remote.memos !== null) {
        state.memos = objectToArray(remote.memos)
          .map(function (m) { return normalizeMemo(m.value, m.key); })
          .filter(Boolean)
          .sort(function (a, b) { return b.ts - a.ts; });
      }

      persist();
      notify();
    },

    resetLocal: function () {
      var settings = state.settings;
      var fresh = seed();
      fresh.settings = settings;
      fresh.ui = state.ui;
      state = fresh;
      persist();
      notify();
    }
  };

  SO.store = api;

})(window);
