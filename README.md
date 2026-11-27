# 범용님 합동 비서실

대장님과 비서들이 한 화면에서 회의하고, 작업을 관리하고, 메모를 공유하는 **모바일 전용 정적 웹앱**입니다.
빌드 도구 없이 `index.html` 하나로 동작하며, 그대로 GitHub Pages에 올릴 수 있습니다.

- 기본 상태: 브라우저 `localStorage`에 저장되는 **로컬 모드** (설정 없이 바로 사용)
- 선택 연결: **Firebase Realtime Database** URL을 넣으면 다른 기기·다른 피클과 3초 주기로 실시간 공유
- 선택 연결: **Gemini API Key**를 넣으면 `@호출`된 AI 비서가 자동으로 답변

## 화면 구성

| 탭 | 내용 |
| --- | --- |
| 🗺️ 오피스 맵 | 첫 화면. 3D 아이소메트릭 비서실 일러스트 위에 방 핀(`🎯 지휘실` `🏛️ 대회의실` `☕ 라운지` `📋 작업실`)과 비서 캐릭터 핀을 올려 놓았습니다. 방 핀은 해당 회의실·작업실로 이동하고, 캐릭터 핀은 역할·상태·최근 보고·담당 작업을 시트로 보여줍니다. `✨ 움직임 ON/OFF` 로 캐릭터 핀의 부드러운 움직임을 끄고 켤 수 있습니다. |
| 💬 회의실 | `대회의실` · `지휘실` · `라운지` 3개 방, 발신자 선택(대장님 + 비서), `@호출` 칩, `@멘션` 강조, 접속 인원 표시 |
| 📋 작업실 | 작업 추가 · 담당자 지정 · 상태(대기/진행중/완료) 전환 · 삭제, 상태별 필터 |
| 📊 비서현황 | 참여 비서 목록, 이름/역할/아이콘/AI 응답 여부 추가·수정·삭제 |
| 📝 메모 | 공유 메모·결정사항 기록·삭제 |

## 파일 구조

```
secretary-office/
├── index.html            # 화면 구조 (헤더 · 5개 탭 · 설정/편집/캐릭터 시트 모달)
├── css/style.css         # 크림/우드 톤 모바일 UI · 오피스 맵 핀 스타일
├── js/store.js           # 상태 · localStorage 저장 · Firebase 스냅샷 변환
├── js/sync.js            # Firebase RTDB REST 동기화 (GET/PUT/DELETE + 3초 폴링)
├── js/ai.js              # Gemini API 호출 (선택)
├── js/app.js             # 렌더링 · 이벤트 · 오피스 맵 핀 · 모달 · 토스트
├── assets/office-map.png # 3D 아이소메트릭 오피스 맵 일러스트 (1402×1122, 글자 없음)
├── assets/favicon.svg    # 왕관 아이콘
├── manifest.webmanifest  # 홈 화면 추가용
├── .nojekyll             # GitHub Pages Jekyll 처리 생략
└── README.md
```

## 오피스 맵 좌표 메모

`js/app.js`의 `MAP_ROOMS`(방 핀)와 `CHAR_SPOTS`(캐릭터 핀)이 일러스트 위 % 좌표를 정합니다.
캐릭터 핀은 `assistants` 목록 순서대로 `CHAR_SPOTS`를 차례로 쓰므로, 비서를 추가하면 다음 자리로 자동 배치됩니다.
핀 좌표를 손볼 때는 390px·320px 두 폭에서 핀이 겹치지 않는지 확인하세요.

## 로컬에서 보기

```bash
cd secretary-office
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000
```

> `index.html`을 파일로 직접 열어도 대부분 동작하지만, Firebase/Gemini 연결은 `http://` 또는 `https://`로 열어야 확실합니다.

## GitHub Pages 배포

1. 이 폴더를 저장소 루트에 push (예: `main` 브랜치)
2. GitHub → **Settings → Pages** → Source: `Deploy from a branch`, Branch: `main` / `/ (root)` → Save
3. 1~2분 뒤 `https://<아이디>.github.io/<저장소>/` 접속

## Firebase Realtime Database 연결 (선택)

1. <https://console.firebase.google.com> 에서 프로젝트를 만들고 **Realtime Database**를 생성합니다(위치 선택).
2. **규칙(Rules)** 을 열어 읽기/쓰기를 허용합니다. 개인용도라면 아래처럼 시작하고, 필요하면 사용자 인증 규칙으로 좁히세요.

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

3. 데이터 탭 상단의 URL(`https://<프로젝트>-default-rtdb.firebaseio.com` 또는 `...firebasedatabase.app`)을 복사합니다.
4. 앱에서 **⚙️ 설정 → Firebase Realtime Database URL**에 붙여넣고 **연결 테스트 → 저장**.
5. 연결되면 헤더 배지가 `실시간 DB 연결됨`으로 바뀌고, 상단에 `DB 내용을 불러왔습니다` 또는 `현재 내용을 새 DB에 올렸습니다` 안내가 뜹니다.

저장 경로는 다음과 같습니다.

```
/rooms/{main|command|lounge}/messages/{messageId}   메시지
/tasks/{taskId}                                      작업
/assistants/{assistantId}                            비서
/memos/{memoId}                                      메모
/meta/officeName                                     비서실 이름
```

> ⚠️ 공개 저장소에 DB URL을 적어두지 않았습니다. URL을 아는 사람은 규칙이 열려 있으면 읽고 쓸 수 있으므로, 공유 범위를 좁히려면 Firebase 인증 규칙을 함께 설정하세요.

## Gemini API 연결 (선택)

1. <https://aistudio.google.com/apikey> 에서 API 키를 발급합니다.
2. 앱에서 **⚙️ 설정 → Gemini API Key**에 입력하고 저장합니다(모델 기본값 `gemini-3.5-flash-lite`).
3. 비서현황에서 **AI 응답**이 켜진 비서(기본: 리서처, 기획담당)를 `@리서처` 처럼 호출하면 자동으로 답합니다. `@all`은 AI 비서 전체를 호출합니다.

키는 **이 브라우저의 localStorage에만** 저장되고 코드·저장소에는 들어가지 않습니다. 공용 기기에서는 사용 후 **설정 → 데이터 → 이 기기 데이터 초기화**로 지우세요(연결 설정은 유지됩니다).

## 동작 방식 메모

- **동기화 주기**: 연결 시 3초마다 5개 경로를 GET 합니다. 쓰기는 항목 단위 PUT/DELETE로 즉시 반영됩니다.
- **충돌 처리**: 서버(DB) 내용이 기준입니다. 같은 항목을 두 기기에서 동시에 고치면 나중에 저장된 값이 남습니다.
- **최초 연결**: DB가 비어 있으면 현재 이 기기의 내용을 DB에 올립니다(덮어쓰기 아님 — 빈 DB일 때만).
- **AI 응답**: 응답 생성 중에는 말풍선 자리에 점 3개가 표시되고, 실패하면 토스트로 이유를 알려줍니다.
- **제한**: 메시지 삭제 기능은 없습니다(기록 보존). 로컬 데이터 초기화는 연결된 DB 내용을 지우지 않습니다.
