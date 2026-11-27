/* =========================================================
   sync.js — Firebase Realtime Database 동기화 (REST + polling)
   키 하드코딩 없음. 사용자가 설정에서 입력한 DB URL만 사용합니다.
   ========================================================= */
(function (global) {
  'use strict';

  var SO = global.SO = global.SO || {};
  var PATHS = ['rooms', 'tasks', 'assistants', 'memos', 'meta'];
  var POLL_MS = 3000;

  var baseUrl = '';
  var timer = null;
  var pulling = false;
  var pending = 0;
  var failureCount = 0;
  var lastRemoteJson = '';
  var status = { mode: 'local', message: '' };
  var subscribers = [];

  /* ---------- 상태 알림 ---------- */
  function setStatus(mode, message) {
    message = message || '';
    if (status.mode === mode && status.message === message) return;
    status = { mode: mode, message: message };
    for (var i = 0; i < subscribers.length; i++) {
      try { subscribers[i](status); } catch (err) { /* ignore */ }
    }
  }

  function subscribe(fn) {
    if (typeof fn === 'function') subscribers.push(fn);
  }

  function getStatus() { return status; }

  /* ---------- URL ---------- */
  function normalizeUrl(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    s = s.replace(/\/+$/, '');
    if (/\.json$/i.test(s)) s = s.slice(0, -5);
    return s;
  }

  function isDbUrl(s) {
    return /^https?:\/\/[^\s]+$/i.test(s);
  }

  function endpoint(path, base) {
    return (base || baseUrl) + '/' + path + '.json';
  }

  /* ---------- 요청 ---------- */
  function parseBody(res, path) {
    if (res.status === 401 || res.status === 403) {
      var e1 = new Error('데이터베이스 규칙이 접근을 막았습니다 (HTTP ' + res.status + '). Firebase 콘솔 → Realtime Database → 규칙에서 읽기/쓰기를 허용하세요.');
      e1.kind = 'rules';
      throw e1;
    }
    if (!res.ok) {
      var e2 = new Error('HTTP ' + res.status + ' · ' + path);
      e2.kind = 'http';
      throw e2;
    }
    return res.text().then(function (text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch (err) { return null; }
    });
  }

  function get(path, base) {
    return fetch(endpoint(path, base), {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    }).then(function (res) { return parseBody(res, path); });
  }

  function put(path, value) {
    return fetch(endpoint(path), {
      method: 'PUT',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value == null ? null : value)
    }).then(function (res) { return parseBody(res, path); });
  }

  function del(path) {
    return fetch(endpoint(path), { method: 'DELETE', cache: 'no-store' })
      .then(function (res) { return parseBody(res, path); });
  }

  function fetchAll(base) {
    return Promise.all(PATHS.map(function (p) { return get(p, base); }))
      .then(function (res) {
        return {
          rooms: res[0], tasks: res[1], assistants: res[2], memos: res[3], meta: res[4]
        };
      });
  }

  /* ---------- 쓰기 ---------- */
  function write(op) {
    if (!baseUrl || !op || !op.path) return Promise.resolve(false);
    pending++;
    var isRemove = op.type === 'remove';
    var req = isRemove ? del(op.path) : put(op.path, op.value);
    return req.then(function () {
      pending--;
      return true;
    }, function (err) {
      pending--;
      setStatus('error', '동기화 실패: ' + err.message);
      return false;
    });
  }

  /* ---------- 읽기 ---------- */
  function hasAny(v) {
    return !!v && typeof v === 'object' && Object.keys(v).length > 0;
  }

  function isEmptyDb(remote) {
    if (!remote) return true;
    if (hasAny(remote.tasks) || hasAny(remote.assistants) || hasAny(remote.memos)) return false;
    if (remote.rooms && typeof remote.rooms === 'object') {
      var keys = Object.keys(remote.rooms);
      for (var i = 0; i < keys.length; i++) {
        var room = remote.rooms[keys[i]];
        if (room && hasAny(room.messages)) return false;
      }
    }
    return true;
  }

  function pull(force) {
    if (!baseUrl) return Promise.resolve(false);
    if (pulling) return Promise.resolve(false);
    if (pending > 0 && !force) return Promise.resolve(false);
    pulling = true;
    return fetchAll().then(function (remote) {
      pulling = false;
      if (pending > 0) return false;
      failureCount = 0;
      var json = JSON.stringify(remote);
      if (json === lastRemoteJson) {
        setStatus('live', status.mode === 'live' ? status.message : '');
        return true;
      }
      lastRemoteJson = json;
      SO.store.applyRemote(remote);
      setStatus('live', '');
      return true;
    }, function (err) {
      pulling = false;
      failureCount++;
      setStatus('error', err.message);
      return false;
    });
  }

  function pushSnapshot() {
    var snap = SO.store.snapshot();
    return Promise.all([
      put('rooms', snap.rooms),
      put('tasks', snap.tasks),
      put('assistants', snap.assistants),
      put('memos', snap.memos),
      put('meta/officeName', SO.store.get().officeName)
    ]).then(function (results) {
      if (results.indexOf(false) >= 0) throw new Error('초기 데이터 업로드에 실패했습니다.');
      return true;
    });
  }

  function pushMissing(remote) {
    var snap = SO.store.snapshot();
    var jobs = [];
    if (!hasAny(remote.rooms)) jobs.push(put('rooms', snap.rooms));
    if (!hasAny(remote.tasks)) jobs.push(put('tasks', snap.tasks));
    if (!hasAny(remote.assistants)) jobs.push(put('assistants', snap.assistants));
    if (!hasAny(remote.memos)) jobs.push(put('memos', snap.memos));
    if (!remote.meta || !remote.meta.officeName) {
      jobs.push(put('meta/officeName', SO.store.get().officeName));
    }
    if (!jobs.length) return Promise.resolve(true);
    return Promise.all(jobs).then(function () { return true; });
  }

  /* ---------- 타이머 ---------- */
  function startTimer() {
    stopTimer();
    timer = setInterval(function () { pull(); }, POLL_MS);
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* ---------- 연결 ---------- */
  function connect(urlOverride) {
    var raw = urlOverride === undefined ? SO.store.get().settings.firebaseUrl : urlOverride;
    var url = normalizeUrl(raw);

    stopTimer();
    pending = 0;
    failureCount = 0;
    lastRemoteJson = '';

    if (!url) {
      baseUrl = '';
      setStatus('local', '');
      return Promise.resolve({ ok: true, mode: 'local' });
    }

    if (!isDbUrl(url)) {
      baseUrl = '';
      var msg = 'URL 형식이 아닙니다. https://…firebaseio.com 형태로 입력해 주세요.';
      if (url.indexOf('console.firebase.google.com') >= 0) {
        msg = 'Firebase 콘솔 주소가 아니라 Realtime Database URL을 넣어야 합니다. (예: https://내프로젝트-default-rtdb.firebaseio.com)';
      }
      setStatus('error', msg);
      return Promise.resolve({ ok: false, error: msg });
    }

    baseUrl = url;
    setStatus('connecting', '연결 확인 중…');

    return fetchAll().then(function (remote) {
      if (isEmptyDb(remote)) {
        return pushSnapshot().then(function () {
          setStatus('live', '새 DB에 현재 내용을 올렸습니다');
          startTimer();
          return { ok: true, seeded: true, mode: 'live' };
        });
      }
      SO.store.applyRemote(remote);
      setStatus('live', '');
      startTimer();
      return pushMissing(remote).then(function () {
        return { ok: true, seeded: false, mode: 'live' };
      });
    }).then(function (result) {
      return result;
    }, function (err) {
      stopTimer();
      setStatus('error', err.message);
      return { ok: false, error: err.message };
    });
  }

  function disconnect() {
    stopTimer();
    baseUrl = '';
    pending = 0;
    lastRemoteJson = '';
    setStatus('local', '');
  }

  function test(url) {
    var u = normalizeUrl(url);
    if (!u) return Promise.reject(new Error('URL을 입력해 주세요.'));
    if (!isDbUrl(u)) return Promise.reject(new Error('URL 형식이 올바르지 않습니다.'));
    return fetchAll(u).then(function () { return true; });
  }

  function init() {
    SO.store.onWrite(function (op) { write(op); });

    if (global.document) {
      global.document.addEventListener('visibilitychange', function () {
        if (!global.document.hidden && baseUrl) pull();
      });
    }
    global.addEventListener('online', function () { if (baseUrl) pull(); });

    var url = normalizeUrl(SO.store.get().settings.firebaseUrl);
    if (url) {
      connect();
    } else {
      setStatus('local', '');
    }
  }

  SO.sync = {
    init: init,
    connect: connect,
    disconnect: disconnect,
    pull: pull,
    test: test,
    subscribe: subscribe,
    status: getStatus,
    hasUrl: function () { return !!baseUrl; },
    POLL_MS: POLL_MS
  };

})(window);
