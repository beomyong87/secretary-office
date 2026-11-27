/* =========================================================
   sync.js — Firebase Realtime Database 동기화 (REST + polling)
   키 하드코딩 없음. 사용자가 설정에서 입력한 DB URL과
   (선택) 비서실 계정 이메일·비밀번호·웹 API 키만 사용합니다.
   계정을 넣으면 Firebase Auth로 로그인해 idToken을 발급·갱신하고
   모든 REST 요청에 ?auth=<idToken>을 붙입니다.
   ========================================================= */
(function (global) {
  'use strict';

  var SO = global.SO = global.SO || {};
  var PATHS = ['rooms', 'tasks', 'assistants', 'memos', 'meta'];
  var POLL_MS = 3000;

  var AUTH_SIGNIN_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
  var AUTH_REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
  /* 만료 5분 전에 미리 갱신한다 (expiresIn 3600초) */
  var REFRESH_MARGIN_MS = 5 * 60 * 1000;
  /* 로그인 실패를 연속으로 재시도하지 않도록 잠시 쉬는 시간 */
  var AUTH_FAIL_BACKOFF_MS = 30 * 1000;

  var baseUrl = '';
  var timer = null;
  var pulling = false;
  var pending = 0;
  var failureCount = 0;
  var lastRemoteJson = '';
  var status = { mode: 'local', message: '' };
  var subscribers = [];

  var auth = {
    idToken: '',
    refreshToken: '',
    expiresAt: 0,
    email: '',
    sig: '',            /* 현재 토큰을 발급한 계정 설정 지문 */
    pending: null,      /* 진행 중인 로그인/갱신 Promise */
    failAt: 0,
    failMsg: ''
  };

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

  /* ---------- 인증 (Firebase Auth 이메일/비밀번호) ---------- */
  function authConfig() {
    var settings = (SO.store.get() && SO.store.get().settings) || {};
    return {
      email: String(settings.firebaseEmail || '').trim(),
      password: String(settings.firebasePassword || ''),
      apiKey: String(settings.firebaseApiKey || '').trim()
    };
  }

  function configSignature(c) {
    c = c || authConfig();
    return c.email + '\u0001' + c.password + '\u0001' + c.apiKey;
  }

  function isAuthConfigured() {
    var c = authConfig();
    return !!(c.email && c.password && c.apiKey);
  }

  function authError(code, detail) {
    var e = new Error('비서실 계정 로그인에 실패했습니다: ' + (detail || code || '알 수 없는 오류'));
    e.kind = 'auth';
    e.code = code || '';
    return e;
  }

  function storeTokens(data, fallbackEmail) {
    auth.idToken = String(data.idToken || '');
    if (data.refreshToken) auth.refreshToken = String(data.refreshToken);
    var ttl = Number(data.expiresIn || 3600) * 1000;
    if (!isFinite(ttl) || ttl <= 0) ttl = 3600 * 1000;
    auth.expiresAt = Date.now() + ttl;
    auth.email = String(data.email || fallbackEmail || '');
    auth.sig = configSignature();
    auth.failAt = 0;
    auth.failMsg = '';
    return auth.idToken;
  }

  function resetTokens() {
    auth.idToken = '';
    auth.refreshToken = '';
    auth.expiresAt = 0;
    auth.sig = '';
  }

  function signIn() {
    var c = authConfig();
    if (!(c.email && c.password && c.apiKey)) return Promise.resolve('');
    resetTokens();
    return fetch(AUTH_SIGNIN_URL + '?key=' + encodeURIComponent(c.apiKey), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: c.email, password: c.password, returnSecureToken: true })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || !data.idToken) {
          var raw = data && data.error && data.error.message ? data.error.message : ('HTTP ' + res.status);
          var code = raw;
          var friendly = raw;
          if (raw === 'EMAIL_NOT_FOUND' || raw === 'INVALID_PASSWORD' || raw === 'INVALID_LOGIN_CREDENTIALS') {
            friendly = '이메일 또는 비밀번호가 맞지 않습니다. (' + raw + ')';
          } else if (raw === 'API_KEY_INVALID' || raw === 'INVALID_API_KEY') {
            friendly = '웹 API 키가 올바르지 않습니다. (' + raw + ')';
          } else if (raw === 'OPERATION_NOT_ALLOWED') {
            friendly = '이메일/비밀번호 로그인이 사용 설정되지 않았습니다. (' + raw + ')';
          } else if (raw === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
            friendly = '시도가 너무 많습니다. 잠시 뒤에 다시 시도하세요. (' + raw + ')';
          }
          throw authError(code, friendly);
        }
        return storeTokens(data, c.email);
      });
    });
  }

  function refresh() {
    var c = authConfig();
    if (!auth.refreshToken || !c.apiKey) return signIn();
    return fetch(AUTH_REFRESH_URL + '?key=' + encodeURIComponent(c.apiKey), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(auth.refreshToken)
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || !data.id_token) {
          /* refreshToken이 폐기·만료됐으면 비밀번호로 다시 로그인한다 */
          return signIn();
        }
        return storeTokens({
          idToken: data.id_token,
          refreshToken: data.refresh_token,
          expiresIn: data.expires_in,
          email: data.user_id
        }, c.email);
      });
    }, function () {
      return signIn();
    });
  }

  function ensureToken(force) {
    if (!isAuthConfigured()) return Promise.resolve('');
    var sig = configSignature();
    if (auth.sig && auth.sig !== sig) resetTokens();
    if (!force && auth.idToken && Date.now() < auth.expiresAt - REFRESH_MARGIN_MS && auth.sig === sig) {
      return Promise.resolve(auth.idToken);
    }
    if (auth.failAt && Date.now() - auth.failAt < AUTH_FAIL_BACKOFF_MS) {
      return Promise.reject(authError('BACKOFF', auth.failMsg || '잠시 뒤 다시 시도합니다.'));
    }
    if (auth.pending) return auth.pending;

    var job = (auth.refreshToken ? refresh() : signIn()).then(function (token) {
      auth.pending = null;
      return token;
    }, function (err) {
      auth.pending = null;
      auth.failAt = Date.now();
      auth.failMsg = err && err.message ? err.message : '';
      throw err;
    });

    auth.pending = job;
    return job;
  }

  function withAuth(url, force) {
    return ensureToken(force).then(function (token) {
      if (!token) return url;
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'auth=' + encodeURIComponent(token);
    });
  }

  /* ---------- 요청 ---------- */
  function parseBody(res, path) {
    if (res.status === 401 || res.status === 403) {
      var e1 = new Error('데이터베이스 규칙이 접근을 막았습니다 (HTTP ' + res.status + '). ' +
        '설정(⚙️)의 비서실 계정 이메일·비밀번호·웹 API 키를 확인하거나, ' +
        'Firebase 콘솔 → Realtime Database → 규칙에서 로그인한 사용자의 읽기/쓰기를 허용하세요.');
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

  function request(method, path, body, base) {
    var url = endpoint(path, base);

    function exec(isRetry) {
      return withAuth(url, isRetry).then(function (fullUrl) {
        var opts = { method: method, cache: 'no-store' };
        if (method === 'PUT') {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(body == null ? null : body);
        } else if (method === 'GET') {
          opts.headers = { 'Accept': 'application/json' };
        }
        return fetch(fullUrl, opts).then(function (res) {
          /* 토큰 만료·폐기로 막히면 한 번 새 토큰으로 다시 시도한다 */
          if ((res.status === 401 || res.status === 403) && isAuthConfigured() && !isRetry) {
            return exec(true);
          }
          return parseBody(res, path);
        });
      });
    }

    return exec(false);
  }

  function get(path, base) {
    return request('GET', path, undefined, base);
  }

  function put(path, value) {
    return request('PUT', path, value);
  }

  function del(path) {
    return request('DELETE', path);
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

  function authLabel() {
    if (!isAuthConfigured()) return '';
    return auth.email ? auth.email + ' 인증됨' : '비서실 계정 인증됨';
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
        setStatus('live', authLabel() || (status.mode === 'live' ? status.message : ''));
        return true;
      }
      lastRemoteJson = json;
      SO.store.applyRemote(remote);
      setStatus('live', authLabel());
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
    ]).then(function () { return true; });
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
      resetTokens();
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
    setStatus('connecting', isAuthConfigured() ? '비서실 계정으로 로그인 중…' : '연결 확인 중…');

    return ensureToken().then(function () {
      return fetchAll();
    }).then(function (remote) {
      if (isEmptyDb(remote)) {
        return pushSnapshot().then(function () {
          setStatus('live', '새 DB에 현재 내용을 올렸습니다' + (authLabel() ? ' · ' + authLabel() : ''));
          startTimer();
          return { ok: true, seeded: true, mode: 'live' };
        });
      }
      SO.store.applyRemote(remote);
      setStatus('live', authLabel());
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
    resetTokens();
    setStatus('local', '');
  }

  function test(url) {
    var u = normalizeUrl(url);
    if (!u) return Promise.reject(new Error('URL을 입력해 주세요.'));
    if (!isDbUrl(u)) return Promise.reject(new Error('URL 형식이 올바르지 않습니다.'));
    return ensureToken().then(function () {
      return fetchAll(u);
    }).then(function () { return true; });
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
    hasAuth: isAuthConfigured,
    authEmail: function () { return isAuthConfigured() ? auth.email : ''; },
    POLL_MS: POLL_MS
  };

})(window);
