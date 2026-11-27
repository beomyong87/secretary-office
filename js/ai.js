/* =========================================================
   ai.js — 선택 기능: Gemini API로 AI 비서 자동 응답
   키는 사용자가 설정에서 입력한 값(localStorage)만 사용합니다.
   ========================================================= */
(function (global) {
  'use strict';

  var SO = global.SO = global.SO || {};
  var TIMEOUT_MS = 45000;

  function endpoint(model) {
    return 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent';
  }

  function systemPrompt(assistant, officeName) {
    var lines = [
      '당신은 "' + officeName + '"의 비서 "' + assistant.name + '"입니다.',
      '역할: ' + (assistant.role || '비서'),
      '사용자는 "대장님"이며, 당신은 대장님을 "대장님"이라고 부릅니다.',
      '한국어로 정중하고 간결하게, 2~4문장으로 답합니다.',
      '작업 지시를 받으면 시작 전에 "실행하겠습니다"라고 먼저 말하고, 진행 상황을 짧게 보고합니다.',
      '필요할 때만 이모지를 하나 붙입니다. 확실하지 않은 사실은 지어내지 말고 확인이 필요하다고 말합니다.'
    ];
    return lines.join('\n');
  }

  function buildContents(messages, assistantId, limit) {
    var recent = messages.slice(-limit);
    var turns = [];

    recent.forEach(function (m) {
      var role = m.senderId === 'me' ? 'user'
        : (m.senderId === assistantId ? 'model' : 'user');
      var speaker = m.senderId === 'me' ? '대장님' : (m.senderName || '비서');
      var text = speaker + ': ' + (m.text || '');

      if (turns.length && turns[turns.length - 1].role === role) {
        turns[turns.length - 1].parts[0].text += '\n' + text;
      } else {
        turns.push({ role: role, parts: [{ text: text }] });
      }
    });

    while (turns.length && turns[0].role === 'model') turns.shift();
    if (!turns.length) turns.push({ role: 'user', parts: [{ text: '안녕하세요.' }] });

    var last = turns[turns.length - 1];
    if (last.role !== 'user') {
      turns.push({ role: 'user', parts: [{ text: '(계속)' }] });
    }
    return turns;
  }

  function extractText(data) {
    var cand = data && data.candidates && data.candidates[0];
    if (!cand) {
      var block = data && data.promptFeedback && data.promptFeedback.blockReason;
      if (block) throw new Error('응답이 차단되었습니다 (' + block + ')');
      throw new Error('응답이 비어 있습니다.');
    }
    var parts = cand.content && cand.content.parts;
    if (!parts || !parts.length) {
      if (cand.finishReason) throw new Error('응답을 만들지 못했습니다 (' + cand.finishReason + ')');
      throw new Error('응답이 비어 있습니다.');
    }
    var text = parts.map(function (p) { return p.text || ''; }).join('').trim();
    if (!text) throw new Error('응답이 비어 있습니다.');
    return text;
  }

  function reply(opts) {
    var state = SO.store.get();
    var key = state.settings.geminiKey;
    var model = state.settings.geminiModel || 'gemini-3.5-flash-lite';

    if (!key) return Promise.reject(new Error('Gemini API 키가 설정되어 있지 않습니다.'));
    var room = state.rooms[opts.roomId];
    if (!room) return Promise.reject(new Error('회의실을 찾을 수 없습니다.'));

    var body = {
      systemInstruction: { parts: [{ text: systemPrompt(opts.assistant, state.officeName) }] },
      contents: buildContents(room.messages, opts.assistant.id, 14),
      generationConfig: { temperature: 0.8, topP: 0.95, maxOutputTokens: 700 }
    };

    var controller = null;
    var timerId = null;
    var fetchOpts = {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body)
    };

    if (typeof global.AbortController === 'function') {
      controller = new global.AbortController();
      fetchOpts.signal = controller.signal;
      timerId = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    }

    function done() { if (timerId) { clearTimeout(timerId); timerId = null; } }

    return fetch(endpoint(model), fetchOpts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
        if (!res.ok) {
          var msg = data && data.error && data.error.message ? data.error.message : ('HTTP ' + res.status);
          var e = new Error(msg);
          e.status = res.status;
          throw e;
        }
        return extractText(data);
      });
    }).then(function (text) {
      done();
      return clean(text, opts.assistant);
    }, function (err) {
      done();
      if (err && err.name === 'AbortError') throw new Error('응답 시간이 초과되었습니다.');
      if (err && err.message === 'Failed to fetch') {
        throw new Error('네트워크 오류 (API 키 또는 네트워크를 확인하세요)');
      }
      throw err;
    });
  }

  function clean(text, assistant) {
    var t = String(text).trim();
    // 모델이 "리서처: ..." 처럼 이름표를 붙인 경우 제거
    var prefix = new RegExp('^' + (assistant.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:：]\\s*');
    t = t.replace(prefix, '');
    return t.trim();
  }

  SO.ai = {
    available: function () { return !!SO.store.get().settings.geminiKey; },
    reply: reply,
    buildContents: buildContents,
    systemPrompt: systemPrompt
  };

})(window);
