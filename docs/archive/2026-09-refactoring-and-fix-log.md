# 하다 학원관리 — 리팩토링 & 점검·수정 로그 아카이브

이 문서는 완료된 작업의 **역사적 기록(로그)**입니다. 현재 시스템이 실제로 어떻게 동작하는지는
이 파일이 아니라 Notion의 "메뉴얼"(하다 학원관리 구조·실행 설명서, 8. 기타 설정 > 메뉴얼)과
저장소 코드 자체를 기준으로 판단하세요.

이 문서는 2026-09-22에 다음 두 문서를 합쳐 보관용으로 옮긴 것입니다:
1. Notion "처리 상태 관리 리팩토링 마스터플랜 (2026-09-21 작성)" 페이지 전체
2. Notion 메뉴얼의 옛 "10. 2026-09-18 전체 점검 결과와 수정 제안" 절 전체(10-1~10-19)

원본 두 Notion 페이지는 그대로 보관(archive) 처리되었고, 메뉴얼 쪽은 현재 상태만 남기도록
정리되었습니다. 이 파일이 두 원본의 유일한 전체 보존본입니다.

---

# 1부. 처리 상태 관리 리팩토링 마스터플랜 (2026-09-21 작성)

> 배경: 메뉴 DB "다음주 수업 일괄 생성" 버튼(버그1) 조사 중 실제로 시간표 3개 + 메뉴 1개의 "생성중" 체크박스가 9분 넘게 꺼지지 않는 현재진행형 멈춤을 발견함. 원인은 (a) generate-classes 자체의 동시처리(concurrency=4)가 애초부터(9/11) 갖고 있던, Notion API 호출이 응답없이 멈추면 영원히 대기하는 취약점(fetchWithRetry에 타임아웃 없음), (b) PART N-4/N-5로 여러 개별 버튼이 sync_queue(순차 처리 워커)를 거치지 않고 즉시 동시 처리로 바뀌면서, 원래 큐가 자연스럽게 눌러주던 동시 Notion API 호출량이 늘어나 같은 취약점이 더 자주 드러남. 두 경로 다 근본 원인은 하나(응답 없는 요청을 감지/회수할 방법이 없음)라고 결론.
>
> 방향: 시간 기반 타임아웃보다 "실제 작업 시작/완료" 신호에 기반해 판단하되, 응답이 영원히 안 오는 경우를 위한 최소한의 안전판(워치독)은 필요하다는 데 합의. 체크박스(생성중=true/false) 대신 **상태(select) 속성**으로 바꿔서 대기/작업중/완료/오류/타임아웃복구를 명확히 구분하기로 함.

## 목표 상태 모델

각 DB의 기존 "OO 처리중"(checkbox) + "마지막 오류"(text) + "실시간 처리 상태"(formula) 조합을 아래로 교체:

- **상태** (select, 신규): ⚪ 대기 / 🔄 작업중 / ✅ 완료 / ⚠️ 오류 / ⏱️ 타임아웃 복구
- **처리 시작 시각** (date, 신규): "작업중"으로 바뀌는 시점에 기록. 워치독이 이 값으로 "얼마나 오래 멈춰 있었는지" 판단.
- **마지막 오류** (text, 기존 유지): 오류 메시지 본문.
- **워치독**: 여러 (데이터소스, 상태속성, 시작시각속성) 조합을 순회하며, "작업중"인데 시작시각이 임계값(함수별로 다를 수 있음, 기본 10~15분)보다 오래된 항목을 "⏱️ 타임아웃 복구"로 전환 + 마지막 오류에 회수 사실을 남김.

## 대상 전체 목록 (조사 완료, 20개 플래그 / 약 10개 DB)

| DB | 속성명 | 담당 함수 |
| --- | --- | --- |
| 시간표 | 생성중 | generate-classes (단일/일괄) |
| 메뉴("시간표" 행) | 생성중 | generate-classes (일괄) |
| 수업 | 생성중 | generate-classes (세션 출석 생성) |
| 수업 | 출석조정 처리중 | fix-attendance |
| 수업 | 학습기록 생성중 | create-learning-record |
| 수업 | 보고서 일괄전송중 | send-class-daily-reports |
| 등록 | 시간표 처리중 | sync-registration-timetable |
| 등록 | 교재 처리중 | sync-registration-textbook(create-individual) |
| 등록 | 수업 처리중 | sync-registration-class-session |
| 등록 | 종료 처리중 | sync-registration-end |
| 등록 | 등록 처리중 | sync-registration-enroll |
| 클래스 | 보고서 생성중 | generate-report |
| 클래스 | 수강료 생성중 | generate-tuition |
| 클래스 | 교재비 생성중 | sync-textbook-distribution(from-class-carts) |
| 클래스 | 교재 생성중 | sync-registration-textbook(create-class) |
| 클래스 | 학생 페이지 동기화중 | sync-class-report-cache |
| 시험범위 | 처리중 | sync-exam-scope |
| 수업/출석/학습기록/학습활동(4DB 공통) | 삭제 처리중 | cascade-delete |
| 학습활동 | 출제 처리중 | create-assignment |
| 교재비(카트) | 담기 처리중 | sync-textbook-distribution(from-cart) |
| 알림톡 발송함 | 일괄전송중 | send-selected-notifications |

## Phase 0 — 설계 확정

- [x] 상태값/색상/이모지 확정 (대기=gray, 작업중=blue, 완료=green, 오류=red, 타임아웃복구=orange)
- [x] 대상 전체 목록 조사 완료 (위 표)
- [x] 워치독 임계값(분) 함수별 기본값 확정 (기본 15분, 무거운 일괄 작업은 개별 조정)
- [x] 신규 공용 헬퍼 시그니처 확정 (markRunning/markDone/markError/isRunning/sweepStaleStatus)

## Phase 1 — 공용 인프라 구현

- [x] `_shared/statusTracking.ts` 신규: 상태 설정 헬퍼 (setCombinedSyncStatus/markGenRunning류 대체) — 커밋 15e2f8e
- [x] 범용 워치독 함수: 여러 DB/속성 조합을 순회하며 stale "작업중" 항목을 회수 (sweepStaleStatus, 같은 커밋)
- [x] 로컬 문법 검증(deno check 대응 node --check) 통과

## Phase 2 — 파일럿 전환: generate-classes (시간표 DB + 메뉴 DB)

- [x] 시간표 DB 스키마 변경 (생성중 checkbox → 상태 select + 처리 시작 시각 date 추가) + 실시간 처리 상태 수식 갱신
- [x] 메뉴 DB("시간표" 행) 동일 스키마 변경
- [x] generate-classes/index.ts 코드 전환 — 커밋 d5d1a7a
- [x] 오늘 멈춰있던 실제 시간표 3개 + 메뉴 1개 정리(수동 회수)
- [x] 실제 데이터로 단일 버튼 + 일괄 버튼 재검증 — 아래 검증 기록 참고
- [x] 워치독을 이 두 DB 대상으로 실제 연결 및 확인 — status-watchdog 함수(커밋 d4e1fc4) 배포 후 수동 호출로 검증 완료. ⚠️ pg_cron 정기 등록은 아직 안 함(Supabase SQL 편집기 접근 필요, Phase 4에서 일괄 등록 예정)

**Phase 2 검증 기록 (2026-09-22)**

- 단일 버튼(`{timetableId}`): 실제 시간표("고2 B반 (화)")로 호출 → 즉시 완료, 상태=✅ 완료 / 처리 시작 시각 기록됨 / 마지막 오류 비어있음 / 실시간 처리 상태 수식 정상(완료 시 공백) 확인.
- 일괄 버튼(`?mode=bulk`, 메뉴 페이지 id 포함): 상태=🔄 작업중 전환 및 실시간 처리 상태 수식("🔄 생성 중") 정상 확인. 그런데 처리 도중 **같은 행 3개(고2 B반(화)/고2 B반(목)/고2 A반(수))가 다시 멈추는 실제 재현** 발생 — 근본 원인(fetchWithRetry 타임아웃 없음)이 아직 안 고쳐졌으므로 예상된 현상. 새로 만든 `status-watchdog` 함수를 배포 후 수동 호출(staleMinutes=3)해서 3개 모두 "⏱️ 타임아웃 복구"로 정상 회수되는 것 확인(마지막 오류에 회수 메시지 기록, 실시간 처리 상태 수식도 정상 표시) → 워치독 설계가 실제 장애 상황에서 의도대로 동작함을 실증. 이후 4개 행 모두 ⚪ 대기로 정리함.
- 결론: 상태 모델/헬퍼/워치독 로직 자체는 검증 완료. 근본 원인(네트워크 계층 타임아웃 부재)은 이번 Phase 범위 밖으로 남겨둠 — 필요 시 별도 논의 후 notionClient.ts에 fetch 타임아웃 추가를 검토.

## Phase 3 — 나머지 DB/함수 순차 전환

- [x] 등록(학원) DB 5개 플래그 — 아래 검증 기록 참고
- [x] 수업(학원) DB 4개 플래그 — 아래 검증 기록 참고 (범위 확장: 출석/진도교재 DB의 "학습기록 상태" 포함)
- [x] 클래스(학원) DB 5개 플래그 — 아래 검증 기록 참고
- [x] 시험범위(학원) DB — 아래 검증 기록 참고
- [x] 삭제 처리중 (수업/출석/학습기록/학습활동/교재비(카트)/교재배부/교재결제 7DB 공통 — 원래 표에는 4DB로 적혀있었으나 실제 코드(CONFIG) 확인 후 7DB로 범위 확장, 아래 검증 기록 참고)
- [x] 학습기록 DB 출제 처리중 (마스터플랜 표 오기 정정: "학습활동 DB"가 아니라 학습기록 DB에 있음 — 아래 검증 기록 참고)
- [x] 교재비(카트) DB 담기 처리중 — 아래 검증 기록 참고
- [x] 알림톡 발송함 DB 일괄전송중 — 아래 검증 기록 참고

**Phase 3 검증 기록 — 등록(학원) DB 5개 (2026-09-22)**

- 5개 속성(종료/시간표/수업/등록/교재 상태 + 각 처리 시작 시각) 신규 생성, "실시간 처리 상태" 수식을 5개 select + 공유 마지막 오류 조합으로 교체. 코드는 대부분 공유 헬퍼(_shared/webhookIngest.ts의 runSyncWebhookForPage)를 statusSpec 옵션으로 확장해서 5개 호출부만 교체(전용 커밋).
- ⚠️ 수식 작성 중 Notion 포뮬러 검증기 버그 발견/회피: 같은 prop("X")를 서로 다른 리스트 리터럴에서 3번 이상 중복 호출하면 검증기가 엉뚱한 속성명을 "유효하지 않다"고 오탐함. 해결: 각 prop()을 lets()로 한 번만 바인딩해서 변수로 재사용. ifs() 분기 수가 많아져도 같은 오탐이 재현되어, 분기를 최대한 병합(예: length()==1 / >1을 나누지 않고 join()으로 통합)해서 회피함. 앞으로 4개 이상 속성을 조합하는 수식(수업/클래스 DB 등)에서도 같은 패턴 적용 필요.
- 죽은 플래그 확인: "학생 페이지 동기화중"(sync-report-cache)은 이미 완전 동기 처리로 바뀌어 더 이상 어떤 플래그도 쓰지 않음 — 상태 모델로 옮기지 않고 Phase 5 정리 때 속성 자체를 삭제할 예정.
- 실제 등록 페이지(테스트용 "강인희 중3 B반")로 5개 버튼(등록/종료 처리/수업 생성/교재 생성/시간표) 전부 실호출 검증: 상태 ⚪→🔄→✅ 전환, 처리 시작 시각 기록, 마지막 오류 정상 비워짐, 실시간 처리 상태 수식 정상 표시 모두 확인.
- status-watchdog에 등록 DB 5개 스펙 추가(커밋). 검증 중 "종료 처리" 버튼이 실제로 6분 넘게 멈추는 상황이 재현되어(fetchWithRetry 타임아웃 부재로 추정, Phase 2와 동일 원인), 확장한 워치독을 수동 호출해서 정상적으로 "⏱️ 타임아웃 복구" 처리되는 것을 실제 장애로 검증함. 같은 호출에서 시간표 DB 4건 + 메뉴 DB 1건도 함께 회수되어 — 운영 중 조용히 멈춰 있던 사례로 추정, 별도 확인 필요할 수 있음(정보 공유용, 이미 회수 완료).
- 테스트 중 부작용 발견 및 정리: 멈췄던 "종료 처리"가 재시도 과정에서 테스트 등록이 실제 "중3 B반" 수업 24건의 등록(roster) 관계에 잘못 연결되고 출석 41건이 생성됨 — 수동으로 24건 관계 해제 + 41건 삭제로 원상 복구함. 종료 처리 로직 자체가 재시도 시 종료일 이후 데이터를 정리 못하고 넘어간 사례라, 추후 재확인 필요(정상 운영 중 재현 여부는 미확인).

**Phase 3 검증 기록 — 수업(학원) DB 4개 + 출석/진도교재 DB "학습기록 상태" (2026-09-22)**

- 대상: 수업 DB "생성 상태"(generate-classes 세션/출석 생성)/"출석조정 상태"(fix-attendance)/"학습기록 상태"(create-learning-record)/"보고서 일괄전송 상태"(send-class-daily-reports) 4개 + 실시간 처리 상태 수식 재작성.
- **범위 확장(원래 표에 없던 부분)**: 조사 중 "학습기록 생성중"이 수업 DB뿐 아니라 출석(학원) DB·진도교재(학원) DB에도 독립적으로 존재하고, 셋 다 create-learning-record의 같은 호출 경로(setBookGenRunning/setRecordGenDone 등)에서 함께 세팅/해제된다는 것을 확인 — 개별적으로 따로 트리거할 수 없는 한 몸이므로 이번 작업에서 3개 DB 모두 함께 상태(select) 모델로 전환함(하나의 `RECORD_GEN_STATUS_SPEC`을 세 DB에서 공유). 원래 Phase 0 표에는 수업 DB 항목만 있었던 것에 대한 의도적 범위 확장으로 기록.
- **배포 실패 1건 발견/수정**: 코드 정리 과정에서 `create-learning-record/index.ts`가 삭제된 `PROP_RECORD_GEN_RUNNING` import를 그대로 남겨둔 채 푸시됨 → GitHub Actions의 `deno check` 타입체크 단계에서 배포가 실제로 실패(커밋 5d6e32a). status-watchdog을 호출했을 때 신규 타겟 6개가 결과에 안 보이는 것으로 발견 → GitHub Actions API로 실패 원인 확인 → import 제거 후 재푸시(커밋 4a24fbd)로 배포 성공 확인. (배포 전 로컬 검증을 `node --experimental-strip-types --check`로만 했던 것이 원인 — 이 검증은 문법만 확인하고 타입은 확인하지 않아 놓친 사례. 이후 Deno CLI를 샌드박스에 설치해서 `deno check`를 로컬에서도 동일하게 돌릴 수 있게 함.)
- 실시간 처리 상태 수식: 등록 DB와 동일한 포뮬러 검증기 버그 회피 패턴(lets()로 각 prop() 한 번만 바인딩) 재적용 — 수업 DB(5개 변수: 마지막 오류/생성/출석조정/학습기록/보고서일괄전송 상태 + 삭제 처리중 체크박스), 출석 DB(신규 학습기록 상태 + 기존 삭제 처리중/보고서 전송중 체크박스 + 마지막 오류), 진도교재 DB(신규 학습기록 상태 + 마지막 오류만) 3곳 모두 수식 오류 없이 반영됨.
- 실증 검증:
  - **생성 상태**: 실제 시간표("중3 B반 (화)")로 `generate-classes` 단일 버튼 호출 → 기존에 없던 미래(2026-11-03) 세션 신규 생성, 생성 상태=✅ 완료/생성 처리 시작 시각 기록/실시간 처리 상태 수식 정상(완료 시 공백) 확인. 이미 존재하던 근시일 세션들은 그대로 재사용됨(중복 생성 없음, 정상).
  - **출석조정 상태 / 학습기록 상태 / 보고서 일괄전송 상태**: 등록/출석 관계가 전혀 없는 격리된 더미 수업 페이지를 신규 생성해서 실제 학생 데이터에 영향 없이 검증 — fix-attendance(0건 동기화, 상태=✅ 완료), create-learning-record(등록 0건 → 조기 반환, 상태=✅ 완료), send-class-daily-reports(출석 0건 → 조기 반환 분기, 실제 카카오 발송 없이 상태=⚠️ 오류 + 마지막 오류="이 수업에 연결된 출석 학생이 없습니다." 정상 기록, 실시간 처리 상태 수식도 동일 메시지로 정상 표시)까지 3개 함수 모두 확인 후 더미 페이지 삭제로 정리.
  - 출석/진도교재 DB의 "학습기록 상태" 자체는 (실제 학습기록을 만들지 않기 위해) 위 더미 세션의 조기 반환 경로에서는 도달하지 않음 — 코드 리뷰로 동일한 `RECORD_GEN_STATUS_SPEC`·동일한 markRunning/Done/Error 헬퍼를 공유함과 스키마 반영(속성명 일치, 수식 정상 컴파일)만 확인했고, 실제 등록이 있는 세션으로 생성까지 실행하는 end-to-end 검증은 아직 안 함(미래 날짜 세션에 실제 학습기록을 생성하는 것은 실제 데이터 오염 우려로 보류) — 필요 시 추후 실제 수업일이 지난 세션에서 자연 발생적으로 확인 가능.
- status-watchdog에 6개 타겟 추가(수업:생성/수업:출석조정/수업:학습기록/수업:보고서일괄전송/출석:학습기록/진도교재:학습기록) — 총 13개 타겟으로 정상 호출 확인(recovered:0, 크래시 없음).
- **범위 밖으로 확인된 항목(백로그用 기록)**: 출석(학원) DB 자체의 "보고서 전송중" 체크박스(개별 버튼용 send-daily-report 담당, 애초에 Phase 0 표에 누락되어 있었음)와 "삭제 처리중"(cascade-delete, 4DB 공통 항목에서 다룰 예정)은 이번 작업 범위에서 의도적으로 제외 — 아직 checkbox 그대로 남아있음.

**Phase 3 검증 기록 — 클래스(학원) DB 5개 (2026-09-22)**

- 대상: "보고서 생성 상태"(generate-report)/"수강료 생성 상태"(generate-tuition)/"학생 페이지 동기화 상태"(sync-class-report-cache)/"교재비 생성 상태"(sync-textbook-distribution:from-class-carts)/"교재 생성 상태"(sync-registration-textbook:create-class) 5개 + 실시간 처리 상태 수식 재작성.
- **구조 정리**: 기존엔 5개 호출부가 각자 자기 체크박스 이름만 다르게 넘겨서 makeClassStatusSetter(setCombinedSyncStatus를 감싸는 공용 헬퍼, generateShared.ts)를 반복 호출하는 구조였는데, 이번에 5곳 모두 statusTracking.ts의 isRunning/markRunning/markDone/markError를 직접 쓰도록 전환함(수업(학원) DB 그룹에서 이미 쓴 패턴과 동일). makeClassStatusSetter 자체는 더 이상 쓰는 곳이 없어져 코드에서 완전히 제거함.
- 난이도 사례: sync-textbook-distribution의 from-class-carts 라우트는 원래부터 "만들 게 없으면 무조건 즉시 완료", "모자란 게 있으면 잠금값과 무관하게 이어서 진행"이라는 자기만의 판단 로직을 갖고 있었는데, isRunning()으로 그 판단 로직을 그대로 이관했다.
- 실증 검증: 등록/출석/클래스 관계가 전혀 없는 격리된 더미 클래스 페이지를 신규 생성해서 5개 함수를 모두 실제로 호출 — generate-report/generate-tuition은 대상 설정(발송함 관계/월간 수업 총량)이 없어 조기 반환하며 상태=✅ 완료, sync-class-report-cache는 "토큰 발급된 등록 없음"으로 조기 반환하며 완료, sync-registration-textbook:create-class는 활성 등록 0건 처리로 완료까지 모두 확인. sync-textbook-distribution:from-class-carts는 활성 등록 자체가 없어 "이미 완료" 단축 경로를 탔는데(정상 동작), 상태를 강제로 "작업중"으로 만들어 재호출해 "멈춰있던 걸 복구" 분기(recovered_already_completed)까지 별도로 재현 확인. 5개 처리 시작 시각 모두 기록됨, 마지막 오류는 항상 비어있음, 실시간 처리 상태 수식은 평상시 공백으로 정상 표시. 검증 후 더미 페이지는 삭제.
- status-watchdog에 클래스 DB 5개 타겟 추가(클래스:보고서생성/클래스:수강료생성/클래스:학생페이지동기화/클래스:교재비생성/클래스:교재생성) — 호출 확인 결과 13개에서 18개 타겟으로 증가. 확인 중 수업:생성 타겟에서 실제로 멈춰있던 수업(학원) 페이지 1건이 발견되어 타임아웃 복구로 자동 회수되는 것을 실제로 확인함(이번 작업과 직접 관련된 건 아니지만, 워치독이 실제 운영 사례에서 계속 정상 동작함을 반복 실증하는 사례).
- 참고: generate-report/generate-tuition/sync-class-report-cache/sync-textbook-distribution/sync-registration-textbook 5개 함수 자체는 이미 이전 PART N-7/N-8 세션에서 로직 정확성을 검증해두었다. 이번 작업은 상태 모델(checkbox→select) 전환 자체에 한정되어, 각 함수의 비즈니스 로직을 다시 검증하지는 않았다.

**Phase 3 검증 기록 — 시험범위(학원) DB 1개 (2026-09-22)**

- 대상: "상태"(select, 신규)+"처리 시작 시각"(date, 신규) — sync-exam-scope("응시학생 등록"/"시험일정 추가" 버튼 공용)의 기존 "처리중" 체크박스를 전환. 이 DB는 플래그가 하나뿐이라 시간표(학원) DB와 같은 관례로 속성 이름을 범용적인 "상태"/"처리 시작 시각"으로 정함.
- 구조 정리: 기존 setExamScopeStatus(체크박스 잠금 + setStatus 콜백, examScopeTarget.ts)를 완전히 제거하고, index.ts가 handleSyncWebhook에 statusSpec(EXAM_SCOPE_STATUS_SPEC)만 넘기도록 바꿈 — 등록 DB 그룹에서 이미 지원되던 runSyncWebhookForPage의 statusSpec 분기를 그대로 재사용해 코드 변경량이 가장 적었다. 다만 "마지막 동기화"(성공 시각 기록용 별도 date 속성)는 markDone이 갱신해주는 대상이 아니라서, processExamScope 성공 경로 끝에서 직접 갱신하도록 옮김(기존과 동일하게 성공했을 때만 갱신됨).
- 실시간 처리 상태 수식: 변수가 2개뿐이라(마지막 오류, 상태) lets() 바인딩 없이도 기존 포뮬러 검증기 버그가 재현되지 않아 단순 ifs()로 그대로 반영.
- 실증 검증: 학년 관계가 비어있는 격리된 더미 시험범위 페이지를 신규 생성해서 curl로 직접 호출 → 학년이 없어 응시학생 등록을 건너뛰는 기존 분기(조기 반환) 그대로 탐, 상태=✅ 완료/처리 시작 시각 기록/마지막 동기화 기록/마지막 오류 항상 비어있음 확인. 검증 후 더미 페이지는 삭제. (학년이 있어 실제 성적 행을 생성하는 happy path는 실제 학생 데이터 오염 우려로 보류 — 이 함수의 비즈니스 로직 자체는 변경하지 않았으므로 상태 모델 전환 검증 목적상 조기 반환 경로 확인으로 충분하다고 판단.)
- status-watchdog에 타겟 추가(시험범위:처리) — 18개에서 19개 타겟으로 증가, 정상 호출 확인(recovered:0).

**Phase 3 검증 기록 — 삭제 처리중 (cascade-delete, 7개 DB) (2026-09-22)**

- 대상: "삭제 상태"(select, 신규)+"삭제 처리 시작 시각"(date, 신규) — cascade-delete의 기존 "삭제 처리중" 체크박스를 전환.
- **범위 확장(원래 표에 없던 부분)**: 마스터플랜 Phase 0 표에는 "수업/출석/학습기록/학습활동(4DB 공통)"이라고만 적혀 있었는데, 실제 _shared/cascadeDeleteTarget.ts의 CONFIG를 보면 cascade-delete는 교재비(카트)/교재배부/교재결제 3개 DB도 함께 재귀 삭제 대상으로 다루고 있었다 — 등록/수업 DB 그룹에서 "학습기록 상태"를 3개 DB로 확장했던 것과 같은 이유로 이번에도 7개 DB 전체로 범위를 넓혀 전환함.
- **속성 이름 결정**: 시험범위 DB처럼 플래그가 하나뿐인 DB(학습기록/학습활동/교재배부/교재결제)만 보면 범용 이름 "상태"/"처리 시작 시각"도 가능했지만, 수업/출석/교재비(카트) DB에는 이미 "생성 상태"/"출석조정 상태"/"학습기록 상태"/"담기 처리중" 같은 다른 상태 속성들이 같이 있어서 접두사 없는 "상태"만 두면 헷갈릴 수 있다고 판단, 처음 배포한 코드(커밋 27def040, statusProp:"상태")를 곧바로 "삭제 상태"/"삭제 처리 시작 시각"으로 정정(커밋 9459a59)한 뒤 스키마를 반영함 — 7개 DB 모두 같은 이름의 속성을 공유하되 각 DB에서 독립적으로 관리됨(다른 DB 그룹과 동일한 관례).
- 코드 구조: isDeletingFlagSet/markDeletingRunning/markDeletingDone/markDeletingError 함수 이름과 시그니처를 그대로 유지한 채 내부 구현만 isRunning/markRunning/markDone/markError(statusTracking.ts)로 교체 — cascade-delete/index.ts는 호출부를 바꿀 필요가 없어 주석 추가만 있음. depth 0에서 멈춘 락을 재시작할 때 붙이는 resumeNote(경고 메시지)는 markRunning이 마지막 오류를 비우는 부작용이 있어, markDeletingRunning 이후 별도 updatePageProperties 호출로 오류 필드에 다시 채워주도록 조정함(기존 "작업중=true + 오류 필드에 안내문구" 동작 그대로 유지).
- STALE_LOCK_MS(3분, last_edited_time 기반 즉시 프리체크)는 이번 전환과 무관하게 그대로 유지 — status-watchdog(기본 15분 임계값)과 이중 안전장치로 계속 병행.
- 실증 검증: 등록/출석/학습기록 관계가 전혀 없는 격리된 더미 학습활동 페이지를 신규 생성해서 cascade-delete를 curl로 직접 호출 → 삭제 상태=🔄 작업중 전환 및 삭제 처리 시작 시각 기록 확인 후, 곧바로 페이지가 휴지통으로 이동(deleted:true)되는 것을 확인. archivePage가 markDeletingDone보다 먼저 실행되는 기존 코드 순서상 최종 "✅ 완료" 표시는 이미 휴지통에 들어간 페이지에는 반영되지 않는데(다른 Phase 3 전환 DB들과 동일한 기존 동작, 이번에 새로 생긴 문제 아님), 마지막 오류가 비어있어 오류 없이 정상 완료됐음은 확인됨.
- status-watchdog에 7개 타겟 추가(수업:삭제/출석:삭제/학습기록:삭제/학습활동:삭제/교재비(카트):삭제/교재배부:삭제/교재결제:삭제) — 19개에서 26개 타겟으로 증가, 정상 호출 확인(recovered:0, 크래시 없음).

**Phase 3 검증 기록 — 학습기록 DB 출제 처리중 (create-assignment) (2026-09-22)**

- 대상: "출제 상태"(select, 신규)+"출제 처리 시작 시각"(date, 신규) — create-assignment의 기존 "출제 처리중" 체크박스를 전환.
- **마스터플랜 표 오기 정정**: Phase 0 표에는 이 항목이 "학습활동 DB 출제 처리중"으로 적혀 있었지만, 실제 "출제" 버튼과 해당 체크박스는 학습기록(학원) DB에 있다 — 학습활동(학원) DB는 출제 결과로 새 행이 생성되는 대상일 뿐, 자체 버튼/플래그는 없음. 위 체크리스트 항목도 이에 맞춰 정정함.
- 코드 구조 차이점(다른 항목들과 대조): cascade-delete는 index.ts가 이미 markDeletingRunning 같은 래퍼 함수만 호출하고 있어서 index.ts 자체는 손댈 필요가 없었는데, create-assignment/index.ts는 checkboxValue(recordPage, PROP_ASSIGNMENT_GEN_RUNNING)로 체크박스를 직접 읽고 있어서 이번엔 index.ts도 함께 수정해야 했다(isRunning(recordPage, ASSIGNMENT_GEN_STATUS_SPEC)로 교체). 또한 setAssignmentGenRunning(recordId, true)처럼 항상 true만 넘기던 boolean 파라미터도 이번에 제거해 setAssignmentGenRunning(recordId)로 단순화함(호출부 1곳).
- _shared/createAssignmentTarget.ts에서 setAssignmentGenRunning/Done/Error 세 함수를 statusTracking.ts의 markRunning/markDone/markError로 위임하도록 재작성 — 다른 항목들과 동일한 패턴.
- ⚠️ 실시간 처리 상태 수식 작성 중 새로운 포뮬러 검증기 오탐 패턴 발견: 이번엔 중복 prop() 호출이 전혀 없었는데도(출제 상태/삭제 상태/마지막 오류 각각 1회씩만 참조) lets()+리스트 리터럴 조합에서 "마지막 오류 is not a valid property"라는 오탐이 발생함. let()로 각 prop()을 먼저 개별 변수에 바인딩(assignSt/delSt/err)한 뒤 리스트 리터럴에서는 변수만 참조하도록 바꾸니 통과함 — 기존에 알려진 "3번 이상 중복 호출" 조건 없이도 lets()+리스트 리터럴 조합 자체가 오탐을 유발할 수 있다는 새 사례로 기록.
- 실증 검증: 등록 관계가 없는 격리된 더미 학습기록 페이지(구분="과제")를 신규 생성해서 create-assignment를 curl로 직접 호출 → 등록이 없어 조기 반환하는 기존 분기(record_has_no_registrations) 그대로 탐, 출제 상태=✅ 완료/출제 처리 시작 시각 기록/마지막 오류 항상 비어있음 확인. 검증 후 더미 페이지는 삭제.
- status-watchdog에 타겟 추가(학습기록:출제) — 26개에서 27개 타겟으로 증가, 정상 호출 확인(recovered:0, 크래시 없음).

**Phase 3 검증 기록 — 교재비(카트) DB 담기 처리중 (sync-textbook-distribution from-cart) (2026-09-22)**

- 대상: "담기 상태"(select, 신규)+"담기 처리 시작 시각"(date, 신규) — sync-textbook-distribution의 from-cart 라우트("진도교재 담기" 버튼)의 기존 "담기 처리중" 체크박스를 전환.
- 이 항목은 시험범위 DB와 거의 동일한 가장 쉬운 전환이었다 — index.ts가 이미 runSyncWebhookForPage(statusSpec 옵션 지원)를 쓰고 있어서, lockProp/setStatus 인자를 statusSpec으로 교체하는 것만으로 끝났다(index.ts 변경 4줄). _shared/textbookDistributionTarget.ts에서는 setCartStatus(makeSyncStatusSetter 기반)를 완전히 제거하고 CART_STATUS_SPEC만 export하도록 정리함.
- 다만 기존 setCartStatus("완료")가 함께 하던 "마지막 동기화"(성공 시각 기록용 별도 date 속성) 갱신도 markDone이 관여하지 않아서, sync-exam-scope와 동일한 패턴으로 distributeFromCartPage 성공 경로 마지막에서 직접 갱신하도록 옮김.
- 속성 이름 결정: 이 DB에는 이미 "삭제 상태" 같은 접두사 붙은 상태 속성이 있어서, 접두사 없는 "상태"를 쓰지 않고 cascade-delete와 같은 관례로 "담기 상태"/"담기 처리 시작 시각"으로 이름을 정함.
- 실시간 처리 상태 수식: let()로 각 prop()을 개별 변수(cartSt/delSt/err)에 바인딩한 다음 ifs()로 분기 — 학습기록 DB에서 발견한 패턴을 이번엔 바로 적용해서 포뮬러 검증기 오탐 없이 한 번에 통과함.
- 실증 검증: 등록 관계가 없는 격리된 더미 교재비 페이지를 신규 생성해서 sync-textbook-distribution/from-cart를 curl로 직접 호출 → 백그라운드 처리 대기(202 accepted) 후 완료에서 "교재비 페이지에 연결된 등록이 없음" 예외가 난 다음 markError가 정상 호출되어 담기 상태=⚠️ 오류/마지막 오류="교재비 페이지에 연결된 등록이 없음"/담기 처리 시작 시각 기록 모두 정상 확인(markRunning→markError 순으로 실증). 검증 후 더미 페이지는 삭제.
- status-watchdog에 타겟 추가(교재비(카트):담기) — 27개에서 28개 타겟으로 증가, 정상 호출 확인(recovered:0, 크래시 없음).

**Phase 3 검증 기록 — 알림톡 발송함 DB 일괄전송중 (send-selected-notifications) (2026-09-22)**

- 대상: "상태"(select, 신규)+"처리 시작 시각"(date, 신규) — send-selected-notifications의 기존 "일괄전송중" 체크박스를 전환. 이 DB엔 다른 상태 플래그가 없어서 시간표/메뉴/시험범위 DB와 같은 관례로 접두어 없는 범용 이름 "상태"/"처리 시작 시각"을 썼다.
- **체크리스트에 남아있던 "연결 함수 불일치" 의심 해소**: 체크리스트/메뉴얼은 이 버튼의 연결 함수를 send-selected-notifications라고 적어두었는데, DB의 기존 "일괄전송중" 체크박스 설명 문구에는 "send-report Edge Function이 처리 중"이라고 적혀 있어 불일치로 보였다. 코드 확인 결과 실제로 이 배치 페이지의 상태를 읽고 쓰는 함수는 send-selected-notifications뿐이다 — send-report/send-tuition-notice는 이 함수가 대상 건(보고서/수강료)마다 반복 호출하는 실제 발송 함수일 뿐, 발송함 페이지 자체의 상태 속성은 건드리지 않는다. 오래된 설명 문구가 혼동을 유발한 것으로 판단해 그 설명도 이번에 함께 정정함(코드 변경은 없음).
- 코드 구조: 이 함수는 다른 항목들과 달리 _shared/webhookIngest.ts의 runSyncWebhookForPage나 큐 워커를 쓰지 않고, 자체 전역 잠금(Deno KV 또는 메모리 기반 mutex)과 runInBackground로 직접 백그라운드 처리를 구성하는 구조라 send-class-daily-reports(수업 DB "보고서 일괄전송 상태", 이미 전환됨)와 가장 유사한 패턴을 그대로 따랐다: 인증 실패/발송함 로드 실패처럼 markRunning을 거치지 않은 채 즉시 실패하는 경로도 markError로 통일한 finishBatch(batchId, message) 헬퍼 하나로 정리(메세지 있으면 오류, 없으면 완료). already_processing 판단은 체크박스 직접 조회 대신 isRunning()으로 교체.
- 실증 검증: 보고서/수강료 관계가 전혀 없는 격리된 더미 발송함 페이지("구분" 비워둠)를 신규 생성해서 curl로 직접 호출 → "구분"이 유효한 값이 아니라는 기존 방어 분기(processBatch 초반 예외)가 그대로 동작해 실제 카카오 발송 없이 상태=⚠️ 오류/마지막 오류=해당 메세지/처리 시작 시각 기록 모두 정상 확인(markRunning→markError 순으로 실증). 실시간 처리 상태 수식도 같은 메세지로 정상 표시됨을 get_formula_value로 별도 확인. 검증 후 더미 페이지는 삭제.
- status-watchdog: 이 DB는 다른 함수가 데이터소스 전체를 쿼리한 적이 없어 전용 환경변수가 없었다 — 메뉴(학원) DB("시간표" 행)와 같은 이유로, 새 환경변수를 추가하는 대신 데이터소스 id를 status-watchdog/index.ts에 직접 적어 넣었다. 타겟 추가(알림톡발송함:일괄전송) — 28개에서 29개 타겟으로 증가, 정상 호출 확인(recovered:0, 크래시 없음).
- **Phase 3 전체 완료**: 마스터플랜 Phase 0 표에 있던 20개 플래그(범위 확장 포함 시 20개 이상) 전부 상태(select) 모델로 전환 완료. 다음은 Phase 4(워치독 전역 크론화, Supabase SQL 편집기 접근 필요) 또는 Phase 5(문서 정리).

## Phase 4 — 워치독 전역 크론화

- [x] Phase 3에서 전환한 모든 조합을 하나의 스케줄러가 순회하도록 구성 — status-watchdog 자체가 이미 모든 대상(29개)을 한 번의 호출로 순회하므로 추가 구성 불필요, 아래 검증 기록 참고
- [x] pg_cron 등록 확인/조정 — 아래 검증 기록 참고

**Phase 4 검증 기록 — status-watchdog pg_cron 등록 (2026-09-22)**

- **Supabase SQL 편집기 접근이 필요 없다는 것을 확인**: 이전까지는 Phase 4가 "Supabase SQL 편집기 접근 필요"로 보류돼 있었는데, GitHub Actions 워크플로(`.github/workflows/deploy-supabase-functions.yml`)가 `supabase/migrations/**` 경로 변경 시 `supabase db push`로 마이그레이션을 이미 자동 적용하고 있다는 것을 코드로 확인함 (기존 `process-sync-queue-every-minute` cron도 이 방식으로 등록돼 있었음). 즉 새 마이그레이션 SQL 파일을 GitHub main에 푸시하는 것만으로 pg_cron 등록이 끝난다 — 대시보드 접근 자체가 필요 없었다.
- 신규 마이그레이션(`20260922150000_status_watchdog_cron.sql`, 커밋 e38b469): `process-sync-queue-every-minute`(20260918190000_create_sync_queue.sql)와 동일한 pg_cron + pg_net 패턴을 그대로 재사용. 인증도 같은 Vault 시크릿(`sync_queue_admin_key`, 20260921020000_process_sync_queue_cron_auth.sql에서 이미 등록됨)을 공유해서 별도 대시보드 작업이 전혀 필요 없었다.
- 주기는 5분(`*/5 * * * *`)으로 결정 — status-watchdog 대상들의 기본 stale 임계값이 15분이므로, 5분 주기면 멈춘 작업이 임계값을 넘긴 뒤 최대 5분 안에 회수된다. Notion API 호출량(대상 29개 × 5분마다 1회 쿼리 ≈ 시간당 최대 348회)은 Notion API 레이트리밋에 비해 여유가 충분하다고 판단.
- **실증 검증(가장 확실한 방식)**: 알림톡 발송함 DB에 격리된 더미 페이지를 만들어 "상태"를 🔄 작업중으로, "처리 시작 시각"을 20분 전으로 수동 조작(사람이 실제로 멈춘 것과 동일한 상태를 인위적으로 재현)한 뒤, status-watchdog을 이번엔 **한 번도 직접 호출하지 않고** 약 5분을 기다림 → 실제로 pg_cron이 자동으로 실행되어 "상태"가 ⏱️ 타임아웃 복구로, "마지막 오류"에 회수 메세지가 자동으로 기록되는 것을 확인함(회수 시각이 대기 시작 후 1분 내로 찍힘 — 다음 5분 주기 tick에서 바로 처리됐다는 뜻). 검증 후 더미 페이지는 삭제.
- 결론: Phase 4 완료. 이제 Phase 3에서 전환한 29개 대상 전체가 사람이 수동으로 호출하지 않아도 5분마다 자동으로 회수된다.

## Phase 5 — 마무리

- [x] 자동화 검수 체크리스트/메뉴얼에 새 상태 모델 반영 — 아래 Phase 5 검증 기록 참고
- [x] 옛 checkbox 기반 문서/주석 정리 — 아래 Phase 5 검증 기록 참고

**Phase 5 검증 기록 (2026-09-22)**

- **죽은 체크박스 스키마 삭제**: Phase 3 전환 대상이 아니었던(즉 실제로 어떤 함수도 읽거나 쓰지 않는) 옛 "OO 처리중"류 체크박스를 코드 전체 grep으로 재확인 후 14개 DB에서 총 30개 삭제 — 등록 6, 클래스 5, 수업 5, 출석 2, 진도교재 1, 시험범위 1, 학습기록 2, 학습활동 1, 교재비(카트) 2, 교재배부 1, 교재결제 1, 알림톡발송함 1, 시간표 1, 메뉴 1. 관련 뷰 5개의 displayProperties에서도 삭제된 속성 참조를 정리했고, 클래스/시험범위 DB의 "실시간 처리 상태" 수식 설명 문구 2건도 갱신함. 예외: 출석(학원) DB "보고서 전송중"은 send-daily-report와 "실시간 처리 상태" 수식의 sendFlag가 실제로 계속 사용 중이라 삭제하지 않고 보존함.
- **코드 정리**: _shared/constants.ts에서 이미 죽은 export 8개(PROP_SYNC_TIMETABLE_RUNNING/PROP_SYNC_TEXTBOOK_RUNNING/PROP_SYNC_CLASS_SESSION_RUNNING/PROP_SYNC_END_RUNNING/PROP_SYNC_ENROLL_RUNNING/PROP_DELETING_RUNNING/ALL_SYNC_RUNNING_FLAGS/PROP_TIMETABLE_GEN_RUNNING)를 삭제하고 남은 주석을 갱신함(커밋 22c7772). 로컬 `deno check`(34개 함수 전체)·`node --experimental-strip-types --check`·`scripts/check-known-regressions.sh` 모두 통과 확인 후 푸시, GitHub Actions 배포(워크플로 실행 35742442739) 성공까지 확인함.
- **버튼 설명 정정**: 등록(학원) DB "학생 페이지 동기화"(sync-report-cache는 완전 동기 처리라 상태 속성이 없다는 점을 명확히 함, 이 버튼은 "실시간 처리 상태"에 반영되지 않음) + 등록(학원) DB "교재 생성"/클래스(학원) DB "교재 생성" 2건(옛 체크박스 문구를 "교재 상태"/"교재 생성 상태" select 기준으로 정정) — 총 3개 버튼 설명 수정.
- **문서 갱신**: 메뉴얼 4-2(등록 DB 처리 상태 설명)·6-4(상태 확인 원칙)를 select 모델 기준으로 수정하고, 신규 10-19 섹션에 이번 Phase 5 작업 전체를 기록함. 자동화 검수 체크리스트에도 동일 내용을 반영(등록 DB "학생 페이지 동기화" 항목 정정 + 상단에 Phase 5 완료 안내 추가).
- **결론: 마스터플랜(Phase 0~5) 전체 완료.**

## Phase 6 — 동시성 제한(N=3) + 대기열 상태 + fetch 타임아웃 (2026-09-22)

> 배경: 운영 중 화면 스캔에서 클래스/수업/출석 등 여러 페이지가 동시에 "🔄 작업중"으로 표시되는 것을 확인 — 실제로는 동시에 최대 N건만 진짜로 처리 중이고 나머지는 순서를 기다리는 중인데 구분이 안 됨. 사용자 요청(진행시켜줘로 승인): (1) 실질적으로 작업 중인 것만 "작업중"으로, 나머지는 "대기열"로 구분 표시. (2) fetch에 타임아웃을 추가해서 응답 없는 요청이 15분 워치독까지 기다리지 않고 스스로 복구되게.

- [x] `STATUS_QUEUED`("⏳ 대기열") 상태값 추가 (statusTracking.ts) — `isRunning()`이 QUEUED/RUNNING 모두 true로 취급(중복 트리거 방지 유지), `markQueued` 신규 헬퍼 추가
- [x] notionClient.ts `fetchWithRetry` / reportCacheShared.ts `fetchSupabaseWithRetry`에 AbortController 기반 30초 타임아웃 추가 — 타임아웃 시 기존 429/5xx 재시도 스케줄을 그대로 재사용
- [x] process-sync-queue를 `CONCURRENCY=3` 다중 레인(lane) 구조로 리팩토링 — `claim_next_sync_queue_item` RPC의 FOR UPDATE SKIP LOCKED로 동시성 안전 보장
- [x] cascade-delete/generate-report/generate-tuition을 큐 기반 처리로 재전환(각 N=3 동시성 제한 적용) — create-learning-record/sync-textbook-distribution(from-class-carts)/sync-class-report-cache는 웹훅 접수 시 `markQueued`, 실제 처리 시작 시 `markRunning`으로 분리
- [x] 영향받는 9개 DB(클래스/수업/출석/진도교재/학습기록/학습활동/교재비(카트)/교재배부/교재결제) 스키마에 "⏳ 대기열" select 옵션 추가 + "실시간 처리 상태" 수식에 대기열 분기 추가
- [x] 로컬 `deno check`(34개 함수) + `scripts/check-known-regressions.sh` 통과, 배포 전 전체 DB 🔄작업중 0건 확인 후 배포

**Phase 6 검증 기록 (2026-09-22)**

- PART N-4가 cascade-delete/generate-report/generate-tuition을 큐에서 빼서 즉시 동시 처리로 바꾼 이유는 sync_queue 워커의 깨우기(wakeSyncQueueWorker) 지연 버그였는데, 그 버그는 같은 날 PART N-3에서 이미 고쳐졌다 — 이번에 다시 큐 기반으로 되돌려도 그 지연 문제가 재발하지 않는다는 것을 근거로 안전하다고 판단함(N-4 결정의 부분적 번복이지만 전제 조건이 바뀌었기 때문).
- `markQueued`는 처리 시작 시각(`startedAtProp`)을 세팅하지 않음 — 오직 `markRunning`만 세팅. 따라서 워치독의 "몇 분째 멈춰있는지" 판단 시계는 실제로 작업이 시작된 시점부터만 흐르고, 대기열에 머무는 시간은 stale 판단에 영향을 주지 않는다.
- Notion 수식에서 대기열 분기는 항상 "작업중" 분기들 뒤에 배치 — 한 페이지가 여러 플래그를 함께 갖고 있을 때(예: 클래스 DB의 보고서/수강료/교재비/학생동기화 4개 플래그), 그 중 하나라도 진짜 작업중이면 대기열 표시보다 작업중 표시가 우선 노출되도록 함.
- 배포 전 9개 DB·13개 상태 플래그 전체에 대해 notion_query_sql로 🔄 작업중 건수를 스캔 — 전부 0건 확인 후 GitHub 푸시(커밋 741cd3644b4f6fcd392dcf3960883697eea0e56d) 및 GitHub Actions 배포 성공 확인, 로컬 클론(`/data/n9_repo`) 동기화까지 완료.
- 결론: Phase 6 완료. 이제 여러 페이지에서 동시에 버튼을 눌러도 실제로 처리 중인 최대 3건만 "🔄 작업중"으로, 나머지는 "⏳ 대기열"로 구분되어 표시된다.

## Phase 6 후속 — 큐 동시성 1로 되돌리고 등록별 처리 병렬화 (2026-09-22)

> 배경: Phase 6 배포 후 실제 운영에서 N=3으로 몇 시간 돌려본 결과 두 가지 문제가 나타남: (1) 학생 수가 많은 클래스의 보고서/수강료 생성이 등록별 순차 for 루프였던 탓에 한 항목이 몇 분씩 걸렸고, 그 동안 레인 하나가 계속 묶여 있었음. (2) 그렇게 오래 걸리는 항목을 처리하던 함수 실행이 Supabase Edge Function 실행시간 한도에 걸려 강제 종료되면 sync_queue_worker_lock까지 함께 유실되어, 다음 pg_cron 주기가 새로 락을 잡고 또 3개를 새로 집으면서 화면에 "작업중"이 3개 한도를 넘어 계속 쌓이는 현상 발생(사용자 보고). 사용자 요청에 따라 방향을 바꿈: 큐 동시성 자체는 다시 1로 낮춰 항상 예측 가능한 순서로 처리하고, 대신 각 큐 항목 내부(등록별 반복)를 병렬화해서 항목 하나의 처리 시간 자체를 줄임.

- [x] process-sync-queue: CONCURRENCY 3 -> 1 (완전히 하나씩, 큐에 쌓인 시간순 그대로 처리)
- [x] generateReportTarget.ts / generateTuitionTarget.ts: 등록별 순차 for 루프 -> generate-classes와 동일한 mapWithConcurrency(REG_CONCURRENCY=4) 병렬 처리로 전환
- [x] 타입체크(deno check 대응) 통과 확인 후 커밋 `b4c2cec7` 배포, GitHub Actions 배포 성공 확인, 로컬 클론 동기화
- [x] 배포 후 클래스(학원) DB·등록(학원) DB 전체를 대상으로 🔄 작업중/⏱️ 타임아웃 복구 잔여 건수 0건 확인 (세션 중단 후 재개해서 재확인, 2026-09-22)

결론: 이제 화면에는 항상 최대 1건만 "🔄 작업중"으로 보이고 처리 순서도 항상 요청이 들어온 시간순 그대로 예측 가능하다. 등록별 처리는 내부적으로 최대 4건씩 동시에 진행되어 학생 수가 많은 클래스도 큐 레인을 오래 붙잡지 않는다.


---

# 2부. 메뉴얼 부록 — 2026-09-18~22 전체 점검 결과와 수정 로그 (구 메뉴얼 10장)

## 10. 2026-09-18 전체 점검 결과와 수정 제안

### 10-1. 코드 개선 권장

1. (2026-09-20 확인: 이미 구현되어 있음 — 완료) 큐 작업이 `processing`에서 중단됐을 때 다시 pending으로 돌리는 복구 규칙과 제한된 재시도는 `_shared/syncQueue.ts`의 `recoverStaleSyncQueueItems()`·`markSyncQueueItemFailedOrRetry()`로 이미 구현되어 있었습니다.
2. (2026-09-21 해결) 워커 잠금의 120초 리스가 단일 긴 작업 중 만료되지 않도록 갱신했습니다. 새 함수 `renew_sync_queue_lock(lease_seconds)`(마이그레이션 `20260921000000_renew_sync_queue_lock.sql`)과 `syncQueue.ts`의 `renewWorkerLock()`을 추가하고, `process-sync-queue/index.ts`가 잠금 획득 직후부터 60초마다 `renewWorkerLock(120)`을 호출하는 `setInterval`을 실행하다가 `finally`에서 `releaseWorkerLock()`과 함께 정리하도록 고쳤습니다(10-17 참고).
3. (2026-09-21 문서화 완료, 보호 자체는 부분 해결) 전체 33개 Edge Function의 실제 인증 현황을 10-17에 표로 정리했습니다. 14개는 관리자 키 인증이 있지만, 나머지 19개는 여전히 인증이 전혀 없습니다(이번 라운드에서는 인증 추가를 generate-classes 하나로 한정해서 진행했고, 나머지 18개는 4번과 동일한 이유로 손대지 않았습니다 — 자세한 목록과 판단 근거는 10-17 참고).
4. (2026-09-21 범위 축소해 해결) `generate-classes`에 관리자 키(`x-admin-key`) 검증을 추가하고, 이 함수를 호출하는 노션 자동화 2건에 헤더를 추가해 연결했습니다: 시간표(학원) DB "수업추가" 버튼(단건 호출), 메뉴(학원) DB "다음주 수업 일괄 생성" 버튼(bulk 호출). 격리된 테스트 시간표(클래스 미연결 상태)로 "수업추가"를 실제 클릭해 401 없이 정상 응답되는 것까지 확인했습니다(클래스 미연결이라 실제 수업은 생성되지 않았고, 테스트 데이터는 삭제). **다만 이번 조치는 ****`generate-classes`**** 하나로 범위를 한정해 진행했고**, 나머지 18개 무인증 함수까지 확대하지는 않았습니다 — 각각 연결된 노션 자동화를 모두 찾아서 헤더를 추가해야 하는 작업이라 범위가 크고, 하나라도 놓치면 그 DB의 실제 운영 흐름이 조용히 401로 깨질 수 있기 때문입니다(자세한 목록은 10-17 참고). 이 저장소에서는 generate-classes를 자동으로 호출하는 예약 작업(pg_cron 등)을 찾지 못했지만, Supabase 대시보드에서만 설정된 숨은 호출이 있을 가능성을 배제할 수 없습니다. **배포 후 Supabase Edge Function 로그에서 generate-classes의 401 오류가 갑자기 늘어나는지 확인해 주세요** — 늘어난다면 그 숨은 호출자에도 같은 헤더를 추가해야 합니다.
5. (2026-09-21 해결) `constants.ts`에 기록돼 있던 “교재 동기화(`sync-registration-textbook`)가 다른 4개 함수와 달리 `PROP_SYNC_ENROLL_RUNNING`을 빠뜨리고 있다”는 예외를 실제 코드로 추적해보니, 이 목록(`otherFlagProps`)은 `setCombinedSyncStatus`가 “실시간 처리 상태” 수식 도입 이후 내부에서 전혀 읽지 않는 완전한 죽은 인자였습니다(체크박스 조합은 노션 수식이 실시간으로 직접 계산). 즉 이 누락은 실제 동작에 아무 영향이 없었습니다. “요구사항과 대조해 통일”하는 대신, 애초에 의미 없는 인자였던 `otherFlagProps` 자체를 `notionClient.ts`·`registrationSync.ts`·`generateShared.ts`와 5개 호출부(class-session/end/enroll/textbook/timetable) 전체에서 제거해, 이 불일치가 다시는 발생할 수 없도록 정리했습니다. 동작 변화는 없습니다.
6. (2026-09-21 확인: 이미 구현되어 있음 — 완료) `deploy-supabase-functions.yml`을 다시 읽어본 결과, DB 비밀번호 길이를 출력하는 디버그 코드는 이미 없었고, 배포 후 "배포된 함수 목록이 저장소와 일치하는지 검증", "필수 Secrets(SB_URL/SB_SERVICE_ROLE_KEY/NOTION_TOKEN/ADMIN_SECRET) 존재 여부 검증", "마이그레이션 상태 표시(`supabase migration list`)" 단계가 이미 모두 들어있었습니다. 추가 코드 변경이 필요 없습니다.
7. (2026-09-21 해결) 18개 무인증 함수 중 첫 번째로 `process-sync-queue`에 관리자 키 인증을 추가했습니다. pg_cron이 보내는 헤더는 Supabase Vault 시크릿을 참조하도록 했습니다. 자세한 내용과 인희님이 등록해야 하는 Vault 시크릿은 10-17 참고.
8. (2026-09-21 해결) **이식성 리팩토링**: 인희님이 "이 시스템을 다른 학원에 GitHub 저장소 공유 + 노션 템플릿 공유 + 웹훅 등록만으로 이식할 수 있는지" 물어보셔서 전체 코드를 감사한 결과, 노션 데이터소스(DB) ID 17개가 12개 넘는 파일에 리터럴 문자열로 중복 하드코딩되어 있고, Supabase 프로젝트 URL도 여러 곳(`constants.ts`, `send-selected-notifications`, GitHub Actions cron 워크플로 4개의 anon key 포함)에 하드코딩되어 있어 그대로는 다른 학원에 재사용할 수 없는 상태였습니다. 추가로 `adminShared.ts`의 알림톡 설정 DB ID에 이 학원 전용 값이 위험한 기본 fallback으로 박혀 있던 것도 발견해 제거했습니다(다른 학원에서 Secret을 빠뜨리면 강인희님의 알림톡 설정 DB로 잘못 조회/기록될 수 있던 구멍). 데이터소스 ID 17개를 전부 `_shared/constants.ts` 한 곳으로 모아 Supabase Secrets(`DATA_SOURCE_*_ID`)에서 읽도록 통일하고, 프로젝트 URL/anon key도 환경변수·GitHub Secrets로 옮겼습니다. 기존 운영 환경은 동일한 값을 새 Secret 이름으로 미리 등록한 뒤 배포해 동작 변화 없이 전환했고, 배포 직후 `sync-attendance`·`nightly-dashboard-link-audit`·`nightly-report-sync-audit`를 실제로 호출해 정상 동작을 확인했습니다. 새 학원으로 이식할 때 채워야 하는 값 전체 목록은 10-18 "이식 체크리스트" 참고.
9. (2026-09-21 해결, PART N) 15개 무인증 함수 중 cascade-delete·create-assignment·create-learning-record·fix-attendance·sync-exam-scope 5개에 관리자 키 인증을 추가했습니다. adminShared.ts의 resolveAdminKeyFromRequest/getCurrentAdminKey 패턴(다른 관리자 함수 6개와 동일)을 그대로 적용했고, sync-exam-scope는 webhookIngest.ts의 handleLockedQueueWebhook에 opt-in requireAdminKey 옵션을 새로 추가해 다른 호출자(sync-registration-enroll 등)에는 영향 없이 이 함수만 인증을 켰습니다. GitHub main에 커밋(de259cf) 후 자동 배포까지 확인했고, curl로 5개 함수 모두 "키 없이 호출 → 401 unauthorized", "x-admin-key: 0000로 호출 → 정상 진행"을 직접 확인했습니다. 연결된 노션 자동화(수업/출석/학습기록/학습활동 DB의 "삭제"·"출석 조정"·"학습기록 생성" 버튼, 시험범위 DB "응시학생 등록")에는 이미 헤더가 들어가 있었고, sync-exam-scope의 새 호출처(일정(학원) DB의 신규 웹훅, 10-4 참고)에도 인희님이 직접 헤더를 넣어 연결했습니다. 자세한 인증 분류는 10-17 참고.
10. (2026-09-21 진행 중, PART N-2) 나머지 10개 무인증 함수 중 generate-report·generate-tuition·sync-class-report-cache 3개에 관리자 키 인증을 추가했습니다. generate-report/generate-tuition은 webhookIngest.ts의 handleLockedBackgroundWebhook에도 sync-exam-scope와 동일한 opt-in requireAdminKey 옵션을 새로 추가해 켰습니다(다른 호출자에는 영향 없음). 인희님이 클래스(학원) DB의 "보고서 생성"·"월 수강료 생성"·"학생 페이지 동기화" 버튼 자동화에 먼저 x-admin-key 헤더를 추가한 것을 스크린샷으로 확인한 뒤 배포했고, curl로 3개 함수 모두 "키 없이 호출 → 401", "x-admin-key: 0000로 호출 → 정상 진행(400 classId/pageId 누락 응답까지 도달)"을 확인했습니다. 나머지 7개(generate-classes 계열 아님: sync-dashboard-link, sync-registration-class-session/end/enroll/textbook/timetable, sync-textbook-distribution)는 연결된 자동화 헤더 확인이 아직 끝나지 않아 보류 중입니다 — 특히 sync-textbook-distribution은 클래스 DB "교재비 생성"(from-class-carts) 버튼엔 헤더가 확인됐지만 교재비(학원) DB "진도교재 담기"(from-cart) 버튼은 아직 미확인이라 함께 확인되기 전까지 서버 인증을 켜지 않았습니다. 자세한 인증 분류는 10-17 참고.
11. (2026-09-21 해결, PART N-2 계속) 위 10번에서 보류했던 나머지 7개 함수(sync-dashboard-link, sync-registration-class-session/end/enroll/textbook/timetable, sync-textbook-distribution)에 관리자 키 인증을 추가했습니다. sync-registration-enroll/end는 webhookIngest.ts의 handleLockedQueueWebhook에 requireAdminKey: true를 켜는 것으로 처리했고, 나머지(class-session/timetable, textbook의 두 라우트, dashboard-link, textbook-distribution의 두 라우트)는 runLockedQueueWebhookForPage가 req를 받지 않아 이 옵션을 쓸 수 없어 각 파일 진입부에 cascade-delete와 동일한 인라인 검사를 추가했습니다. sync-registration-textbook의 cleanup-on-end 라우트는 노션 자동화가 아니라 _shared/registrationSync.ts의 callTextbookCleanup()이 내부적으로만 호출하는데, 그 호출이 지금까지 x-admin-key 헤더를 전혀 보내지 않고 있어서 함께 고치지 않으면 인증 추가 즉시 sync-registration-end/timetable의 내부 호출이 401로 깨질 뻔했습니다 — getCurrentAdminKey()로 헤더를 채우도록 같은 커밋에서 함께 수정했습니다. 인희님이 미리 스크린샷으로 확인해주신 등록(학원) DB의 5개 버튼(등록/종료 처리/수업 생성/교재 생성/학생 페이지 동기화)과 클래스(학원) DB "교재비 생성" 버튼에는 이미 x-admin-key 헤더가 있었고, 교재비(학원) DB "진도교재 담기" 버튼과 대시보드/일정/수업/출석(학원) DB의 "페이지가 생성되면 → 웹훅 보내기" 자동화 4개는 개별 스크린샷 확인 없이 인희님의 "확인 가능한 자동화에는 모두 넣었다"는 확인을 근거로 진행했습니다. GitHub main에 커밋(41399d2) 후 자동 배포를 확인했고, curl로 9개 엔드포인트(두 라우트씩 있는 sync-registration-textbook/sync-textbook-distribution 포함) 전부 "키 없이 호출 → 401 unauthorized"를, 코드 패턴별(handleLockedQueueWebhook / 인라인+runLockedQueueWebhookForPage / 인라인+커스텀 로직) 대표 엔드포인트에서 "x-admin-key: 0000로 호출 → 인증 통과 후 다음 단계로 정상 진행"까지 확인했습니다. cleanup-on-end의 실제 내부 호출 왕복(등록 종료 처리 시 사용)은 운영 데이터를 건드리지 않기 위해 별도 End-to-End 테스트는 하지 않았습니다 — 같은 getCurrentAdminKey() 패턴이 이미 다른 곳(wakeSyncQueueWorker 등)에서 정상 동작 중이라 문제 없을 것으로 예상하지만, 실제 "종료 처리" 버튼을 눌러 교재 정리까지 정상 동작하는지 인희님이 한 번 확인해 주시면 좋습니다. 자세한 인증 분류는 10-17 참고.

### 10-2. HTML·저장소 개선 권장

1. 등록별 링크 관리·전송 로그 확인, 수업·일정·보고서·수강료 조회, 일괄 알림톡 발송은 [등록(학원) DB](https://app.notion.com/p/36aba040586b83f28a28018a4102e093)·[알림톡 설정(학원) DB](https://app.notion.com/p/e40c92b353cf4f7ebef546ffe52f4007)·[전송로그(학원) DB](https://app.notion.com/p/c272036f5f4d40d3b9d4b9ed75f0bb67)·[알림톡 발송함(학원) DB](https://app.notion.com/p/20acbd04b7d04d2198d45e00ef3a83fe)과 클래스·수업·보고서 각 페이지의 노션 버튼으로 처리하며, 각 버튼의 자동화(웹훅) 연결을 확인했습니다. 관리자 비밀번호는 필요 시 Supabase Secrets의 `ADMIN_SECRET`을 직접 갱신합니다.
2. 일부 주석·오류 문구·라벨에 깨진 한글과 오타가 있습니다. 사용자에게 노출되는 문자열을 우선 정리하고 UTF-8 회귀 검사를 추가합니다.
3. `hada-report`, `attendance-kiosk`의 오래된 HTML 사본은 보관용임을 README에 표시하거나 보관 처리해 운영 기준 혼선을 막습니다.
4. 저장소 루트에 README를 추가해 운영 URL, 파일 역할, Edge Function 목록, 필수 환경변수 이름, 배포·복구·롤백 절차를 기록합니다.

### 10-3. 운영 정책 결정 필요

- 교재비 매출을 일반 결제/손익에 자동 반영할지
- 고등 과외/중등 과외처럼 학생별 수업 횟수가 다른 클래스의 `월간 수업 총량`을 어떻게 잡을지(현재는 임시로 12/회 일괄 적용, 4-6의 "총량=1 + 단가" 방식 적용 여부 검토 필요)
- 노션 버튼용 무인증 웹훅의 허용 범위와 보호 방식
- 레거시 GitHub Pages 주소를 계속 유지할지 완전히 통합할지
- 큐 failed 항목의 자동 재시도 횟수와 운영자 알림 방식

### 10-4. 진행 중 이슈 및 알려진 제약사항 (2026-09-18 로드맵 문서에서 이관, 원본은 폐기)

- (2026-09-21 해결) 시험범위 DB "응시학생 등록" 버튼에 `sync-exam-scope` 웹훅 자동화(URL·헤더)를 노션 화면에서 직접 연결했습니다. 실제 버튼 클릭으로 응시학생 등록부터 성적 생성까지 정상 동작하는 것을 확인했습니다.
- (2026-09-21 추가) 일정(학원) DB에 `sync-exam-scope`를 호출하는 웹훅 자동화 2개("페이지 생성"/"페이지 편집" 트리거, 각각 x-admin-key 헤더 포함)를 새로 연결했습니다. 이 함수는 받은 페이지 id를 시험범위 페이지로 취급해 학년/학교를 조회하므로, 일정 페이지의 웹훅 바디에 실제 시험범위 페이지 id(또는 그 id로 이어지는 관계)가 들어가도록 페이로드를 구성했습니다(인희님 확인: 정상). 두 자동화가 동시에 발동해도 이미 성적 행이 있는 학생은 건드리지 않는 멱등 처리라 중복 생성 위험은 없습니다.
- (2026-09-20 재점검, 10-14 참고) 출석 DB 자동화를 노션 화면에서 직접 열어 확인한 결과, "페이지 추가"와 "속성 편집"이 한 자동화에 동시에 체크된 경우는 없었습니다 -- "동기화 웹훅"과 "대시보드 웹훅"이 각각 트리거별로 분리된 별도 자동화 2개씩이었고, 이는 의도된 설계입니다(노션 자동화는 애초에 한 자동화에 트리거를 두 개 걸 수 없어 이 이상 통합할 수도 없습니다). 실제로 발생 가능한 현상은 "사람이 노션 화면에서 페이지를 만들면서 동시에 속성값도 채우면 두 자동화가 둘 다 발동해 같은 웹훅이 두 번 갈 수 있다"는 것인데, sync-attendance/sync-report-cache는 스냅샷을 덮어쓰는 멱등 처리라 데이터가 깨지지는 않습니다.
- (2026-09-20 확인) 출석 DB "동기화 웹훅" 자동화의 웹훅 액션 두 개는 각각 sync-report-cache, sync-attendance를 가리키는 것으로 확인했습니다.
- `NOTION_SEND_LOG_DB_ID` Secret이 아직 등록되지 않았고, 수강료·보고서 발신번호가 입력되지 않았습니다.
- (2026-09-18 해결) `run-auto-schedule` Edge Function 자체를 폐기했습니다. `pg_cron`에 `run-auto-schedule-job`이 남아있다면 더 이상 호출할 대상이 없으므로 함께 삭제해야 합니다(Supabase 대시보드에서 직접 확인·삭제 필요).
- (2026-09-21 해결) "링크 재발급"·"링크 비활성화" 자동화 연결을 완료했습니다. 노션 웹훅 버튼은 임의 JSON 바디를 만들 수 없다는 10-4의 기존 제약을 우회하기 위해, `sync-exam-scope`처럼 액션을 URL 쿼리가 아니라 **커스텀 헤더**로 받는 방식을 택했습니다: `toggle-report-link/index.ts`가 `x-link-action` 헤더 → URL `?action=` → `body.action` 순으로 액션을 확인하고, `registrationIds`가 없으면 `_shared/notionClient.ts`의 `extractPageId(body)`로 현재 페이지 ID를 추출하도록 고쳤습니다(기존 토큰 발급·재발급·비활성화 로직은 그대로 유지). 등록(학원) DB에 자동화 3개를 연결했습니다 — "링크 비활성화" 체크됨 → `x-link-action: disable`, "링크 비활성화" 체크 해제됨 → `x-link-action: enable`, "링크 재발급" 버튼 클릭 → `x-link-action: regenerate`(전부 `x-admin-key` 헤더 포함). 강인희님 본인의 테스트 등록("강인희 고1 A반")으로 실제 클릭 테스트: 재발급 시 토큰이 바뀌고, 비활성화 체크 시 토큰 앞에 `disabled:` 접두사가 붙고, 체크 해제 시 접두사가 사라지는 것까지 모두 확인했습니다.
- (2026-09-21 해결) `sync-textbook-distribution/index.ts`의 임시 계측 코드(`logDebugWebhookCall`, `DATA_SOURCE_DEBUG_LOG`)를 GitHub에서 제거하고, "🔧 웹훅 디버그 로그 (임시)" DB도 사용자 승인 후 삭제했습니다(원인은 이미 웹훅 주소 오류로 확인·수정됨).
- (2026-09-21 해결) [학생(학원) DB](https://app.notion.com/p/2baba040586b83949ab501922cdc3899) "학부모 연락처" 수식을 `ifs(prop("주요 연락처")=="어머니", prop("어머니 연락처"), prop("주요 연락처")=="아버지", prop("아버지 연락처"), "")`로 바꾸어, "주요 연락처"가 비어있을 때 무조건 아버지 연락처로 떨어지던 숨은 fallback을 제거했습니다(이제는 미지정 시 빈 값).
- (2026-09-21 원인 확인) "시간표 담당강사 자동채움"과 "출석 담당강사 자동 배치"는 서로 다른 DB의 서로 다른 자동화라 그 자체는 중복이 아니었습니다. 대신 노션 AI 자동 채우기 에이전트 목록을 확인한 결과, 시간표(학원) DB에 이름이 완전히 같은 "시간표 담당강사 자동채움" 에이전트가 2개 등록돼 있었습니다(출석 DB 쪽은 1개로 정상). 실제 중복은 이 부분입니다. (2026-09-21 추가 조치: 바로 아래 generate-classes의 담당강사 소스를 시간표에서 클래스로 바꾸고 실제 테스트로 검증함으로써, 시간표(학원) DB의 "시간표 담당강사 자동채움" 에이전트 2개는 이제 생성 파이프라인 어느 지점에도 영향을 주지 않아 안전하게 삭제해도 됩니다. 출석(학원) DB의 "출석 담당강사 자동 배치"는 사람이 직접 만든 출석 페이지에 여전히 필요하므로(5-10과 달리 API 생성이 아닌 경우) 유지해야 합니다. 에이전트 삭제는 여전히 임의로 진행하지 않았으니 인희님이 직접 삭제해 주세요.)
- (2026-09-21 해결) `generate-classes`의 수업·출석 "담당강사" 채우기가 시간표 페이지의 담당강사 속성을 읽어오는 방식이라, 시간표의 담당강사가 비어있거나(수작업 누락) 자동채움 에이전트가 유효하지 않은 경우 수업·출석에 담당강사가 안 채워지는 구조적 리스크가 있었습니다. `getClassInfo(classId)`를 새로 만들어 클래스(학원) DB의 클래스명·담당강사를 직접 읽도록 바꿈으로써, 수업·출석의 담당강사가 시간표의 값과 무관하게 항상 클래스 기준으로 정확히 채워지도록 고쳤습니다. 격리된 테스트 클래스·시간표(담당강사 의도적으로 비움)로 수업추가 버튼을 실제 클릭해, 생성된 수업의 담당강사가 클래스 기준으로 정확히 채워지는 것을 확인했습니다(테스트 데이터는 모두 삭제).
- (2026-09-21 해결) 교재비 안내문 알림톡(`send-textbook-notice`)을 실제로 클릭 테스트해보니 매번 조용히 실패하고 있었습니다. 원인은 "안내문 전송" 버튼 자동화에 `x-admin-key` 헤더가 아예 없었던 것 — 코드가 헤더 다음으로 확인하는 `body.adminKey`도 이 DB에는 없어 인증이 항상 거부되고 있었습니다. 헤더를 추가해 연결한 뒤 다시 클릭해 전송로그에 성공 기록이 남는 것까지 확인했습니다.
- (2026-09-21 부분 해결) 교재비 안내 카카오 메시지에 학생 자신의 이름이 아니라 "강인희 고1 A반"처럼 등록 페이지 제목이 나간다는 제보가 있었습니다. `send-textbook-notice/index.ts`가 `anyTitleText(registrationPage)`(등록 페이지 제목)로 학생이름을 만들던 버그를, 등록(학원) DB의 "학생이름(등록)" 롤업(학생(학원) DB 제목을 학생정보 관계로 참조해 학생 본인의 이름만 가져옴)을 읽도록 고쳤습니다. **다만 이것은 이름 버그만 고친 것이고**, 실제 수신 카카오 메시지의 "🏫 클래스: (공백)"과 "📞 학습문의: 010-3726-1231" 표기는 원인이 다릅니다 — GitHub 전체 검색 결과 코드 어디에도 "학습문의" 문자열이나 `#{클래스}` 같은 변수가 없고, 이 함수는 `#{학생이름}`와 `#{안내문}` 두 변수만 Solapi로 보내기 때문입니다. 즉 이 부분은 **Solapi에 등록된 "교재비 안내" 카카오 템플릿 자체의 레이아웃이 우리 코드의 2개-변수 설계와 다르거나(예: 다른 템플릿이 잘못 등록됨) 원하는 단일 통합텍스트 구조(교재비 페이지의 "안내문" 수식과 같은 형태)로 다시 등록되어야 하는 문제로 보이며**, Solapi 콘솔 접근 권한이 없어 AI가 직접 확인·수정할 수 없습니다. 인희님이 Solapi 콘솔에서 "교재비 안내"(템플릿 ID `KA01TP260916152920662Yk4HVhDSQEP`) 템플릿을 직접 확인하거나, 그 정확한 등록 내용을 공유해 주셔야 마저 해결할 수 있습니다.
- 대시보드(학원) DB가 제대로 작동하지 않는다는 보고가 있어 원인 확인이 필요합니다(10-13의 자동 연결 기능 대상).
- 진도교재 등록 체계의 예시 데이터 재현 테스트가 보류 중입니다.

### 10-5. 대용량 코드 파일 수정 안전 규칙 (student_report.html 작업 인수인계 문서에서 이관, 원본은 폐기)

> `student_report.html`은 과거 전체 파일을 한 번에 재작성해 두 차례 잘림 사고(11만자 파일이 73~77KB 지점에서 잘림)가 있었습니다. 대용량 HTML/JS 파일을 수정할 때는 아래 규칙을 지킵니다.

1. 한 번에 하나의 항목만 수정합니다. 여러 변경을 한 번에 묶어 재작성하지 않습니다.
2. 전체 파일을 재작성해 통째로 다시 올리지 않습니다. 기존 구조(HTML/CSS와 분리된 JS 파일 등)를 유지한 채 부분 수정만 적용합니다.
3. 수정 전에 변경 범위를 설명하고 승인을 받은 뒤 진행합니다.
4. `admin.html`, `dashboard.html`, `.github/`, `scripts/`, `supabase/` 등 요청받지 않은 파일·폴더는 건드리지 않습니다.
5. 문제가 생기면 알려진 정상 커밋으로 되돌릴 수 있도록 작업 전 기준 커밋 해시를 확인해 둡니다.

### 10-6. 2026-09-18 진행한 수정 내역

- **알림톡 자동발송 기능 폐기**: 트리거 없이 죽어있던 `run-auto-schedule` 함수와 알림톡 설정(학원) DB의 자동 발송 전용 속성 6개를 제거했습니다.
- **getScheduleConfig 회귀 수정**: 위 폐기 작업 중 `_shared/adminShared.ts`의 `getScheduleConfig()`를 통째로 지웠는데, 실제로는 `generate-tuition`·`textbookDistributionTarget.ts`·`send-textbook-notice` 세 곳이 계속 쓰고 있어 전체 Edge Function 배포가 `deno check` 단계에서 막혀 있었습니다. 자동 스케줄 전용 필드는 뺀 축소판(`{ rowId, notice }`)으로 복원해 해결했습니다.
- **"완럌" → "완료" 오타 수정**: `classReportCacheTarget.ts`·`textbookDistributionTarget.ts`에서 상태 문자열에 오타가 있어, 작업이 성공해도 내부적으로 "오류"로 잘못 처리되던 버그를 고쳤습니다.
- **catch(err) 타입 오류 수정**: `list-students`·`sync-student-report`·`toggle-report-link`에서 `err?.message`로 접근하던 부분을 `(err as Error)?.message`로 고쳤습니다.
- **전송로그(학원) DB "보고서 기간" → "해당 기간"**: 보고서뿐 아니라 수강료 청구기간에도 쓰이던 속성이라 이름을 더 일반적으로 바꿨습니다 (4-8 참고).
- **알림톡 설정(학원) DB에 "코드" 속성 추가**: Edge Function이 제목("발송 구분")이 아니라 이 속성으로 행을 찾도록 바꿔서, 제목을 자유롭게 바꿔도 발송 설정 조회가 깨지지 않게 했습니다 (4-8 참고). 제목을 "보고서"→"주간/월간 보고서"로 바꾸면서 조회가 조용히 fallback으로 넘어가던 사고를 계기로 도입했습니다.

### 10-7. 2026-09-19 진행한 수정 내역

- **출결 키오스크 Make.com 의존 제거**: `attendance_kiosk.html`이 쓰던 Make.com 웹훅(학생 검색 → 출석 기록 → Solapi 발송)을 없애고, 신규 Supabase Edge Function `kiosk-checkin`이 `list-students`와 같은 `x-admin-key` 인증으로 이 전체 과정을 직접 처리하도록 통합했습니다(5-10 참고). 기기마다 웹훅 주소를 설정하던 화면은 삭제했고, 그 자리의 아이콘은 🔒 로그아웃 버튼으로 바뀌었습니다.
- **형제·자매 공유 연락처 대응**: 같은 보호자 번호로 등록된 학생이 여러 명이면 화면에서 바로 고를 수 있게 했습니다.
- **보강(정규 수업 없는 날) 자동 처리**: 오늘 날짜에 예정된 출석이 없으면 `출석 상태 = 🔵 보강`인 출석을 새로 만듭니다.
- **중복 등원 처리 방지**: 이미 등원스템프가 찍힌 뒤 다시 등원 버튼을 누르면 덮어쓰지 않고 기존 처리 시각을 안내합니다.
- [알림톡 설정(학원) DB](https://app.notion.com/p/e40c92b353cf4f7ebef546ffe52f4007)에 추가했던 코드 "등원 알림"/"하원 알림" 행은 다음날(10-8) "키오스크 알림톡" 하나로 다시 통합됐습니다.
- 이전에 별도 페이지였던 "출결 체크 키오스크" 자료 DB 설명 문서는 이 메뉴얼로 통합하고 보관 처리했습니다.

### 10-8. 2026-09-19 추가 진행한 수정 내역

- **report_cache 동기화 신뢰성 보강**: `sync-attendance`의 웹훅 경로와 매시간 증분 경로가 출석 변경을 처리할 때 `sync-report-cache` 큐 작업도 함께 적재하도록 고쳤습니다(이전에는 `attendance_records`만 갱신되고 `report_cache` 갱신이 누락될 수 있었음). `nightly-report-sync-audit`에도 출석(학원) DB의 `last_edited_time` 기준 2차 스캔을 추가해, 첫 스캔에서 놓친 변경분을 매일 밤 다시 잡아냅니다.
- **등원 알림/하원 알림 → 키오스크 알림톡 통합**: [알림톡 설정(학원) DB](https://app.notion.com/p/e40c92b353cf4f7ebef546ffe52f4007)의 코드 "등원 알림"/"하원 알림" 두 행을 보관 처리하고, 코드 "키오스크 알림톡" 한 행으로 합쳤습니다(`활성 여부`는 아직 `false` — Solapi "등하원 안내" 템플릿 승인 후 pfId·템플릿 ID·발신번호 입력 필요, 4-8·5-10 참고). `_shared/adminShared.ts`의 `SendLogCategory` 타입과 [전송로그(학원) DB](https://app.notion.com/p/c272036f5f4d40d3b9d4b9ed75f0bb67) "발송 구분" 옵션도 같이 정리했습니다. `kiosk-checkin`은 이제 등원/하원 모두 단일 카테고리로 보내고, 템플릿 변수 `{학생이름, 구분("등원"/"하원"), 일자, 시간}`로 등원/하원을 구분합니다.
- **보강 캘린더 표시 버그 수정**: 출석의 "수업일시"는 UTC 인스턴트로 저장되는데, KST 0~8시대 값을 UTC 기준으로 날짜만 잘라내면 하루 전 날짜로 밀리는 버그가 있었습니다. 새벽 시간대 키오스크 보강 체크인이 대표 사례로, 전날 결석 기록과 날짜가 겹쳐 보강 표시가 캘린더에서 사라졌습니다. `student_report_part1.js`에 `isoToKstDate()`를 추가하고, `_shared/reportCacheShared.ts`의 `dmWeekday()`·`fmtDateKr()`와 `_shared/reportCacheBuilder.ts`의 과제 현황(`homework_days`) 날짜 계산을 모두 Asia/Seoul 기준 날짜 변환(`kstDateOf()`)으로 고쳤습니다. `student_report_part1.js`는 GitHub Pages 정적 파일이라 즉시 반영되며, 이미 캐시된 `report_cache` 행의 날짜/요일 값은 재빌드 전까지 예전 값이 남아있을 수 있지만 화면은 항상 원본 `iso`를 우선 사용해 영향이 없습니다.

### 10-9. 2026-09-19 키오스크 알림톡 활성화 후 실사용 버그 수정

"키오스크 알림톡" 코드 행이 pfId·템플릿 ID가 채워지고 활성화된 직후 실제 사용 중 발견된 문제들을 수정하고, 카카오 알림톡 수신까지 실제로 확인했습니다.

- **기존 출석 페이지의 출석 상태 미갱신 버그 수정**: 오늘 날짜 출석 페이지가 이미 있는 경우(정규 수업이 미리 만들어져 있던 날) `kiosk-checkin`이 등원/하원스템프만 찍고 `출석 상태`는 전혀 바꾸지 않던 버그를 고쳤습니다. 이제는 스템프를 찍을 때 현재 상태가 `🔵 보강`이 아니면 `출석 상태 = 🟢 출석`으로도 갱신합니다(키오스크가 방금 만든 보강 기록은 그대로 유지). 함께 하원에도 등원과 동일한 중복 처리 방지(`alreadyDone`)를 추가해, 하원을 여러 번 누르면 매번 덮어쓰고 알림톡도 재발송되던 문제도 함께 고쳤습니다 (5-10 참고).
- **알림톡 발신번호 fallback 누락 수정**: 활성화 직후에도 카카오 알림톡이 매번 실패하고 있었습니다. [전송로그(학원) DB](https://app.notion.com/p/c272036f5f4d40d3b9d4b9ed75f0bb67)의 실패 사유를 확인해보니 Solapi SDK가 빈 발신번호(`from`) 때문에 요청 자체를 거부하고 있었습니다. [알림톡 설정(학원) DB](https://app.notion.com/p/e40c92b353cf4f7ebef546ffe52f4007)의 "발신번호"는 운영 중인 모든 행에서 비어 있고, `send-daily-report` 등 다른 발송 함수들(`_shared/alimtalkShared.ts`)는 이 경우 Secrets의 `SOLAPI_SENDER_NUMBER`로 자동 대체하는데, `kiosk-checkin`만 빈 문자열 fallback을 써서 이 대체가 안 되고 있었습니다. 다른 함수와 동일하게 `SOLAPI_SENDER_NUMBER` fallback을 추가해 해결했습니다.
- 위 두 수정을 배포한 뒤 실제 키오스크에서 등원 처리 → 카카오 알림톡 수신까지 직접 확인되었습니다.

### 10-10. 2026-09-19 알림톡 템플릿 변수 한글 표기 + 리포트 캘린더 즉시 동기화 버튼

- **알림톡 일자·시간 변수 한글 표기**: Solapi 템플릿을 "#\{학생이름\} 학생이 #\{구분\}하였습니다. / ▪ 일자: #\{일자\} / ▪ 시간: #\{시간\}" 형태로 다듬으면서, `일자`/`시간` 변수 값도 "2026-09-19"/"09:40" 대신 "2026년 9월 19일"/"오전 9시 40분" 형식으로 바꿔달라는 요청이 있었습니다. `kiosk-checkin/index.ts`에 `formatKstDateKorean()`/`formatKstTimeKorean()`을 추가해 이 두 알림톡 변수에만 적용했습니다(제목 문자열 등 다른 곳에 쓰는 `todayKst()`/`formatKstTime()`은 그대로 유지). 실제 수신 화면에서 한글 표기를 확인했습니다.
- **API로 만든/수정한 출석 페이지는 웹훅 자동화가 걸리지 않는 문제 확인**: 키오스크로 체크인해 노션의 `출석 상태`는 정상적으로 바뀌었는데도, `student_report.html` 캘린더 탭(`report_cache` 기반)에는 한동안 반영되지 않는 문제가 있었습니다. 원인은 출석(학원) DB의 "생성 또는 편집 시 → 웹훅 보내기" 자동화가 사람이 노션 화면에서 직접 편집할 때만 발동하고, Notion API로 만든/수정한 페이지에는 걸리지 않는다는 점입니다(5-10의 "담당강사 자동 배치" 페이지-생성 자동화와 동일한 제약이 속성-편집 자동화에도 적용됨). 그래서 `kiosk-checkin`의 출석 페이지 생성/수정은 `sync-attendance` 웹훅을 트리거하지 못하고, 다음 매시간 증분 동기화나 야간 점검이 돌 때까지 `attendance_records`/`report_cache`가 갱신되지 않았습니다. **API로 노션 DB를 쓰는 모든 Edge Function은 그 DB에 걸린 페이지/속성 자동화가 발동한다고 가정하면 안 되고, 필요한 하위 동기화는 직접 호출해야 합니다.** (이번 커밋에서 `kiosk-checkin` 자체를 고치는 대신, 리포트 화면에 아래 수동 동기화 버튼을 추가하는 방식으로 우선 대응했습니다.)
- **리포트 캘린더 "동기화" 버튼 추가**: 학부모가 새로고침만으로는 최신 출결이 안 보일 때 직접 갱신을 요청할 수 있도록, `student_report.html` 캘린더 탭에 "🔄 최신 정보로 동기화" 버튼을 추가했습니다. 누르면 지금 보고 있는 등록의 `registrationId`로 `sync-report-cache`를 호출해 큐에 즉시 적재시키고(다른 버튼 웹훅과 동일하게 별도 인증 없이 신뢰), 워커가 처리할 시간을 잠깐 기다린 뒤 데이터를 다시 불러와 화면을 갱신합니다. 이를 위해 `_shared/reportCacheShared.ts`의 `selectReportCacheOverviewsByStudentKey()`가 각 등록 개요에 `registration_id`도 함께 담아 내려주도록 고쳤습니다(이전에는 `registration_overview` 컬럼만 가져와서, 화면에 열려 있는 등록이 URL 토큰의 등록이 아니면 `registrationId`를 알 방법이 없었습니다).

### 10-11. 2026-09-19 동기화 버튼 CORS 오류 수정 + 교재 목록 그리드 레이아웃

- **동기화 버튼이 항상 "실패"로 표시되던 버그 수정**: 10-10에서 추가한 "🔄 최신 정보로 동기화" 버튼을 실제로 눌러보면 서버 쪽 큐 적재는 매번 성공(`queued:true`)했는데도 브라우저 화면에는 항상 "동기화에 실패했어요"가 떴습니다. 원인은 데이터 부족이 아니라 CORS 헤더 누락이었습니다: `_shared/backgroundTask.ts`의 `respondAccepted()`가 202 응답에 `Access-Control-Allow-Origin` 등 CORS 헤더를 전혀 붙이지 않고 있었습니다. 6-1에 나열된 큐 기반 함수들은 지금까지 전부 노션 자동화(웹훅)나 서버 간 호출만 받아서 브라우저 CORS 제약을 받은 적이 없었는데, `sync-report-cache`를 브라우저 JS에서 직접 호출하는 이 버튼이 처음으로 CORS의 영향을 받은 사례입니다. 브라우저는 OPTIONS 사전 요청(preflight)은 통과시키지만, 실제 POST 응답에 `Access-Control-Allow-Origin`이 없으면 응답 본문·상태코드를 읽지 못하게 막아 `fetch()`가 실패로 처리됩니다. `respondAccepted()`에 다른 함수의 `ADMIN_CORS`/`CORS_HEADERS`와 동일한 CORS 헤더를 추가해 해결했습니다. `respondAccepted()`를 쓰는 6-1의 모든 큐 기반 함수가 같이 이 헤더를 받게 되며, 기존 호출 방식(노션 웹훅·서버 간 호출)에는 영향이 없습니다.
- **교재 카드 목록을 가로 스크롤 대신 2열 그리드로 변경**: `student_report.html`의 "교재" 탭에서 교재 카드가 가로로 넘치며 스크롤되던 것을, 2개씩 나란히 배치되고 넘치면 다음 줄로 넘어가는 그리드로 바꿨습니다(`.book-cards`를 `display: flex; overflow-x: auto`에서 `display: grid; grid-template-columns: repeat(2, 1fr)`로, `.book-card`의 고정 `flex-basis`는 제거).

### 10-12. 2026-09-19 교재 카드 크기 복원 + 동기화 버튼을 화면 전역 플로팅 버튼(FAB)으로 이동

- **교재 카드 그리드가 너무 커지던 문제 수정**: 10-11에서 `.book-cards`를 `grid-template-columns: repeat(2, 1fr)`로 바꾸면서 카드가 컨테이너 절반 너비까지 늘어나 이전보다 훨씬 커져 보이는 문제가 생겼습니다. 열 너비를 원래 카드 크기였던 `clamp(150px, 44vw, 220px)`로 고정하고(`repeat(2, clamp(150px, 44vw, 220px))`), `justify-content: center`로 가운데 정렬해 카드 크기는 이전과 동일하게 유지하면서 2개씩만 배치되도록 바로잡았습니다.
- **동기화 버튼을 캘린더 탭에서 화면 전역 플로팅 버튼(FAB)으로 이동**: 10-10에서 만든 "🔄 최신 정보로 동기화" 버튼은 캘린더 탭에서만 누를 수 있었습니다. 교재·학습기록·보고서 탭이나 인트로 화면에서도 바로 동기화할 수 있었으면 한다는 요청에 따라, 캘린더 탭 전용 버튼을 제거하고 `student_report.html` 화면 우측 하단에 고정(`position: fixed`) 플로팅 버튼 하나로 통합했습니다(`#app`과 형제 요소로 놓아 뷰가 바뀌어도 사라지지 않음). 등록 상세 화면(캘린더·교재·학습기록·보고서 탭 중 어디든)에서는 지금 열려있는 등록만, 아직 등록을 고르지 않은 인트로 화면에서는 학생의 모든 등록을 한 번에 동기화합니다(`currentReg()` 유무로 분기). 하단 탭바(교재/캘린더/학습기록/보고서)가 있는 "detail" 화면에서는 FAB와 토스트 메시지 위치를 탭바 위로 올리도록 `body.has-tabbar` 클래스를 `renderApp()`에서 토글합니다. 로컬 Playwright 스모크테스트로 인트·상세·캘린더 화면에서 버튼 위치와 클릭 후 동기화 성공(토스트 메시지 표시)까지 콘솔 오류 없이 확인했습니다.

### 10-13. 2026-09-20 대시보드(학원) DB 자동 연결 기능 추가

- **기능**: 수업(학원)/출석(학원)/일정(학원) 페이지가 생성되면 같은 날짜의 대시보드(학원) 페이지를 자동으로 찾거나 만들어 양방향으로 연결합니다. 일정은 기간(여러 날)을 가질 수 있어, 걸치는 모든 날짜의 대시보드에 전부 연결됩니다. 대시보드 자신이 생성/수정되면 그 날짜에 해당하는 수업/출석/일정을 다시 모아 재연결합니다(멱등한 전체 재빌드).
- **스키마 변경**: 일정(학원) DB의 "대시보드" relation에 걸려있던 제한1을 해제했습니다(멀티데이 일정이 여러 날짜의 대시보드에 동시에 연결되려면 필요). 수업/출석 DB의 "대시보드"는 계속 제한1입니다.
- **코드**: `_shared/dashboardLinkTarget.ts`(신규)가 실제 연결 로직을 담당하고, 새 큐 target `sync-dashboard-link`로 process-sync-queue에 등록했습니다(6-1 참고). `generate-classes`·`kiosk-checkin`은 Notion API로 직접 수업/출석 페이지를 만들어 페이지 자동화가 걸리지 않으므로(5-10과 동일한 제약), 생성/갱신 직후 코드에서 직접 큐에 적재합니다. 그 외 경로(사람이 노션에서 직접 만드는 경우)는 대시보드/일정/수업/출석 4개 DB에 새로 건 "페이지가 생성되면 → 웹훅 보내기" 자동화가 `sync-dashboard-link` Edge Function을 호출해 같은 큐로 들어옵니다.
- **테스트**: 4개 DB 모두 예시 페이지를 만들어 실제 웹훅 왕복으로 검증했습니다 — 수업/출석 단일 날짜 연결, 같은 날짜 대시보드 중복 생성 방지(find-or-create), 대시보드 선(先) 생성 후 자녀 연결, 일정 3일치 멀티데이 연결까지 모두 정상 확인했습니다. 일정(학원) DB 자동화는 처음 테스트에서 반응이 없어 확인해보니 자동화 설정 문제였고, 재설정 후 재테스트에서는 25초 내 정상 자동 처리를 확인했습니다. 테스트에 쓴 예시 페이지는 모두 삭제했습니다.
- **안전망(야간 점검) 추가**: `generate-classes`/`kiosk-checkin`은 페이지 생성 직후 코드에서 직접 큐에 적재하는데, 이 적재 호출 자체가 실패하면(예: Supabase 일시 장애) 그 페이지는 사람이 만든 게 아니라서 위 자동화도 걸리지 않아 영영 대시보드에 연결되지 않을 수 있습니다. 이 사각지대를 메우기 위해 새 Edge Function `nightly-dashboard-link-audit`를 추가했습니다: 매일 01:35 KST(6-3 참고)에 "오늘 편집됐지만 대시보드 relation이 비어있는" 수업/출석/일정 페이지만 골라 다시 연결을 시도합니다(`nightly-report-sync-audit`와 동일하게 범위를 "오늘"로 고정해 등록이 늘어도 비용이 늘지 않습니다). 이 기능 도입 이전에 만들어진 페이지는 오늘 편집되지 않는 한 대상에서 제외됩니다(의도된 동작).
- 남은 사항: 대시보드/일정/수업/출석 4개 DB의 웹훅 자동화와 야간 안전망 점검까지 모두 연결 완료. 대량 생성(예: 시간표 일괄 생성으로 수십 건의 수업/출석이 한 번에 생성되는 경우)은 큐의 순차 처리·재시도(6-1 참고) 구조를 그대로 타므로 별도 코드는 필요 없지만, 실제 대량 부하 테스트는 아직 하지 않았습니다.

### 10-14. 2026-09-20 웹훅·자동화 구조 점검 및 정리 (리스크 낮은 순으로 실행)

"웹훅이 너무 많은 것 아니냐"는 질문에서 출발해 전체 Edge Function과 노션 자동화 구조를 다시 점검하고, 리스크가 낮은 항목부터 순서대로 정리했습니다.

- ① extractPageId 중복 제거: cascade-delete, fix-attendance, create-assignment, create-learning-record 안에 각자 복사돼 있던 페이지ID 추출 함수를 지우고, _shared/notionClient.ts의 공용 extractPageId를 가져다 쓰도록 정리했습니다.
- ⑤ sync-registration-class-session 큐 전환: 이 함수만 즉시 처리 방식이라 나머지 sync-registration-enroll/end/timetable/textbook과 패턴이 달랐는데, 동일한 큐(_shared/registrationClassSessionTarget.ts 신설) 방식으로 맞췄습니다.
- ③ webhookIngest.ts 공용 헬퍼 도입: "락 확인 → 처리중 표시 → 큐 등록 → 워커 깨우기 → 202 응답, 실패 시 오류 표시"라는 거의 같은 코드가 여러 함수에 반복돼 있어 _shared/webhookIngest.ts로 통합했습니다. sync-registration-enroll/end, sync-exam-scope, sync-class-report-cache는 전체를 이 헬퍼로, sync-registration-timetable/class-session은 웹훅 처리 부분만, sync-textbook-distribution은 from-cart 경로만 이 헬퍼로 옮겼습니다(from-class-carts 경로는 고유 로직이 많아 그대로 뒀습니다). 부수 효과로 sync-class-report-cache에 원래 없던 try/catch 오류 처리가 추가됐고, 오류 메시지 오타("찾지 목함")도 통일됐습니다.
  - 배포 중간에 deno check 타입 오류가 한 번 발생해(SetSyncStatus 타입을 string으로 너무 넓게 잡았던 문제) 바로 다음 커밋으로 수정하고 재배포 성공을 확인했습니다.
- ② 출석 DB 자동화 재점검: 위 10-4 항목 정정 내용 참고. 노션 화면에 직접 로그인해 자동화 7개를 모두 열어 확인했고, 결론은 "현재 구조를 건드리지 않는다"입니다. 트리거를 하나라도 지우면 정상적인 재동기화 케이스를 놓칠 위험이 있어, 코드 리스크가 아닌 설정 리스크로 보고 보류했습니다.
- ④ 생성시 자동화 통합 검토: 여러 DB의 웹훅 액션 URL을 하나로 합치는 안을 검토했으나, 진행하지 않기로 했습니다. 노션 자동화 설정은 코드처럼 deno check 같은 안전망이 없는 수동 작업이라 URL 오타·오배포 리스크가 있고, 이미 sync-report-cache(6개 DB 공용)·sync-dashboard-link(4개 DB 공용)처럼 로직이 같은 것들은 이미 잘 통합돼 있어 실익이 크지 않다고 판단했습니다.

> 정리 원칙: 엔드포인트 개수 자체가 많고 적음이 기준이 아니라, 여러 DB가 "완전히 같은 처리"를 필요로 하는지 아니면 "서로 다른 목적"인지가 기준입니다. 같은 처리면 하나로 합치고(이미 잘 되어 있음), 다른 목적이면 분리된 게 오히려 정상입니다.

참고: ② 점검을 위해 노션 화면에 직접 로그인했습니다. 이는 자동화 설정처럼 API로 아예 노출되지 않는 노션 UI 전용 기능을 확인하기 위한 것으로, 스키마·페이지 편집 권한 자체가 달라진 것은 아닙니다.

### 10-15. 2026-09-20 웹훅 코드 정리 4~6단계 (추가 리팩토링)

10-14 이후 전체를 한 번 더 훑어 찾은 추가 항목들을 낮은 리스크부터 순서대로 실행했습니다.

- 4단계: sync-registration-textbook의 create-individual 라우트가 3단계 때 이름이 비슷한 sync-textbook-distribution과 헷갈려 빠졌던 것을 발견해, 동일하게 webhookIngest.ts로 옮겼습니다. 또한 send-tuition-notice·send-textbook-notice에 100% 중복돼 있던 getRollupText/extractRollupItemText를 alimtalkShared.ts로 옮겼습니다.
- 죽은 코드 제거: get-report는 2026-09-16부터 "준비 중"만 반환하는 스텁이었고(get-report-fast/get-report-detail이 실제 역할을 대체), student_report.html/js 전체를 확인한 결과 어디서도 호출하지 않는 것을 확인해 삭제했습니다. 이 스텁만 쓰던 legacy 모듈 _shared/reportShared.ts(대부분 reportCacheShared.ts와 중복)도 함께 삭제했습니다.
- 5단계: send-report·send-tuition-notice·send-textbook-notice·send-daily-report·send-class-daily-reports·send-selected-notifications 6개 함수에 똑같이 복사돼 있던 "x-admin-key 헤더 없으면 바디 adminKey로 폴백" 한 줄을 adminShared.ts의 resolveAdminKeyFromRequest()로 통합했습니다(현재 키와 비교하는 로직은 함수마다 달라 그대로 두고, 후보 키를 뽑는 부분만 통합).
- 6단계: generate-report·generate-tuition이 거의 동일하게 갖고 있던 "POST 확인 → body 파싱 → classId 추출 → 락 확인 → 처리중 표시 → 백그라운드 실행 → 완료/오류 표시 → 202 응답" 뼈대를 webhookIngest.ts의 새 헬퍼 handleLockedBackgroundWebhook()으로 통합했습니다. generate-classes는 단건/일괄/전체자동 등 진입점이 여러 개라 이번에는 그대로 두었습니다.
- 메뉴얼 정정: 10-1의 "큐 stale 복구·재시도" 항목이 실제로는 이미 _shared/syncQueue.ts에 구현돼 있음을 확인해 완료로 표시했습니다.
- 4개 커밋 모두 GitHub Actions 배포(deno check 포함) 성공을 확인했습니다.

### 10-16. 2026-09-21 알림톡 발송 버튼 실사용 테스트 및 자동화 연결 점검

인희님 요청으로 10-4에 미해결로 남아있던 웹훅 연결·자동화 중복 의심 항목을 실제로 점검했습니다.

- `send-daily-report`(출석(학원) DB "보고서 전송"), `send-report`([보고서(학원) DB](https://app.notion.com/p/50dba040586b83049d84016658d0dce1) "보고서 전송"): 자동화 연결(URL·헤더)이 이미 정상이었습니다. 실제 클릭 테스트로도 전송로그 성공 기록을 확인했고, 코드 수정은 필요 없었습니다.
- `send-class-daily-reports`([수업(학원) DB](https://app.notion.com/p/3b1ba040586b801b8bc3c906fe396b9c) "보고서 일괄 전송"), `send-selected-notifications`([알림톡 발송함(학원) DB](https://app.notion.com/p/20acbd04b7d04d2198d45e00ef3a83fe) "일괄 전송"): 자동화 연결(URL·헤더)을 열어 확인한 결과 이미 정상 연결돼 있었습니다. 두 버튼 옆의 코드 설명("자동화 연결 필요")은 실제 상태와 다른 오래된 문구였습니다. 다만 두 버튼 모두 실제로 누르면 여러 학생(많게는 140건 이상)에게 한 번에 알림톡이 나가는 일괄 처리라, 다른 학부모에게 실제 알림톡이 발송되는 것을 피하기 위해 이번에는 클릭 테스트까지는 하지 않았습니다. 확인이 더 필요하면 학생이 강인희 하나뿐인 클래스나 배치를 따로 만들어 테스트해 주세요.
- 나머지 `send-textbook-notice` 수정, "담당강사" 자동화 중복 원인, `toggle-report-link` 연결 시도 결과는 위 10-4 해당 항목에 반영했습니다.
- Supabase `cron.job` 테이블을 조회해 `run-auto-schedule-job`의 실제 잔존 여부와 이름을 확인하려 했으나, 이번 세션에는 Supabase 대시보드·CLI 접근 권한이 없어 확인하지 못했습니다. 10-4 안내대로 Supabase 대시보드에서 직접 확인·삭제해야 합니다.

### 10-17. 2026-09-21 전체 Edge Function 인증 정책 감사 (코드로 처리 가능한 리팩토링 1차)

인희님 요청으로 33개 Edge Function 전체의 `index.ts`를 다시 내려받아 인증 방식을 감사했습니다. 아래 표가 현재(2026-09-21) 기준 실제 코드 상태입니다.

**관리자 키(****`requireAdminKey`****) 인증 — 6개**: kiosk-checkin, sync-attendance, sync-report-cache, nightly-dashboard-link-audit, nightly-report-sync-audit, process-sync-queue(2026-09-21 추가, 아래 참고)

**관리자 키 + 토큰 기반 — 3개**: list-students, sync-student-report, toggle-report-link

**관리자 키(헤더 또는 ****`body.adminKey`****, ****`resolveAdminKeyFromRequest`****) — 5개**: send-class-daily-reports, send-daily-report, send-selected-notifications, send-textbook-notice, send-tuition-notice

**관리자 키 + 토큰 기반(****`resolveAdminKeyFromRequest`****) — 1개**: send-report

**인증 추가 완료(이번 라운드) — 16개**: generate-classes (2026-09-21, 위 10-1 4번 참고), cascade-delete, create-assignment, create-learning-record, fix-attendance, sync-exam-scope (2026-09-21, PART N: adminShared.ts의 resolveAdminKeyFromRequest/getCurrentAdminKey 패턴 적용. sync-exam-scope는 webhookIngest.ts의 handleLockedQueueWebhook에 requireAdminKey 옵션을 새로 추가해 opt-in으로 켰습니다. 연결된 노션 자동화 전체(수업/출석/학습기록/학습활동 DB의 관련 버튼, 시험범위 DB "응시학생 등록", 일정 DB의 신규 웹훅)에 x-admin-key 헤더를 확인/연결했습니다. 자세한 내용은 위 10-1 9번 참고.), generate-report, generate-tuition, sync-class-report-cache (2026-09-21, PART N-2: webhookIngest.ts의 handleLockedBackgroundWebhook에 동일한 requireAdminKey 옵션을 추가해 켰습니다. 자세한 내용은 위 10-1 10번 참고.), sync-registration-enroll, sync-registration-end (2026-09-21, PART N-2 계속: handleLockedQueueWebhook의 requireAdminKey 옵션 사용), sync-registration-class-session, sync-registration-timetable, sync-registration-textbook, sync-dashboard-link, sync-textbook-distribution (2026-09-21, PART N-2 계속: runLockedQueueWebhookForPage/커스텀 로직 진입부에 인라인 관리자 키 검사 추가. 자세한 내용은 위 10-1 11번 참고.)

**토큰 기반(관리자 키 없음) — 2개**: get-report-fast, get-report-detail (학부모 리포트 토큰으로 조회 대상을 제한하므로 완전한 무인증은 아닙니다)

**여전히 인증 없음 — 없음**(2026-09-21 기준 위 16개 등록/대시보드/교재배부 관련 함수까지 마저 켜지자, 이 목록으로 남았다고 보고된 필수 관리자 키 인증 대상 함수는 다 다뤘습니다.)

> 위 15개는 대부분 노션 버튼/자동화의 "웹훅 보내기" 액션으로만 호출되도록 설계되어 있어 URL을 모르면 실행하기 어렵지만, URL 자체는 비밀이 아니고(코드 저장소에 그대로 있음) 이 함수들의 요청 바디에 담긴 페이지 ID로 노션 데이터를 직접 바꿀 수 있습니다. 지금까지 인증을 추가한 것은 generate-classes와 process-sync-queue 두 개뿐이고, 나머지 15개까지 넓히려면 각 함수가 연결된 모든 노션 자동화(적게는 1개, 많게는 여러 DB에 걸쳐 여러 개)를 전부 찾아서 헤더를 추가해야 하고, 하나라도 놓치면 그 자동화가 조용히 401로 깨져 실제 운영 흐름(수업 생성, 등록 처리, 교재 배부 등)이 멈출 수 있습니다. 우선순위를 정해 한 번에 하나씩(자동화 연결 확인 → 헤더 추가 → 실제 클릭 테스트 순서로) 진행합니다.

(2026-09-21 해결) process-sync-queue에 `requireAdminKey` 인증을 추가했습니다. 이 함수는 pg_cron(1분마다 워커를 깨우는 안전망, 6-3 참고)과 다른 웹훅 함수들의 "즉시 트리거" 호출(`wakeSyncQueueWorker()`) 둘 다에서 호출되는데, pg_cron이 보내는 헤더에 관리자 키를 SQL 마이그레이션 파일에 평문으로 적어 넣을 수 없어서(자동 보안 검사가 차단) Supabase Vault에 `sync_queue_admin_key`라는 이름의 시크릿을 새로 만들고 마이그레이션이 그 값을 참조하도록 했습니다(`20260921020000_process_sync_queue_cron_auth.sql`). **이 Vault 시크릿은 아직 등록 전이면 인희님이 Supabase 대시보드 → Database → Vault에서 직접 추가해야 합니다** — 이름은 정확히 `sync_queue_admin_key`, 값은 현재 `ADMIN_SECRET`과 동일해야 pg_cron 쪽 인증이 완전히 동작합니다. `wakeSyncQueueWorker()`(다른 함수들이 큐 적재 직후 호출)는 `getCurrentAdminKey()`로 같은 키를 헤더에 실어 보내도록 `syncQueue.ts`를 함께 고쳤습니다.

get-report-fast·get-report-detail은 학부모 리포트 토큰으로 조회 대상을 제한하고 있어 위 표에서 별도 "토큰 기반" 항목으로 분류했습니다(get-report는 10-15에서 이미 삭제됨).

### 10-18. 2026-09-21 새 학원 이식 체크리스트

> 이 절은 이 시스템 전체를 **다른 학원(고객)에게 복제**할 때 쓰는 체크리스트입니다. 목표는 (1) GitHub 저장소 공유, (2) 노션 템플릿 공유, (3) 웹훅 등록만으로 이식하는 것입니다. 10-1의 8번 리팩토링 이후 코드 자체에는 이 학원 고유의 값이 하드코딩되어 있지 않지만, 아래 값들은 새 학원마다 반드시 새로 채워야 합니다.

**1) 새 Supabase 프로젝트 준비**

새 Supabase 프로젝트를 만들고, GitHub 저장소를 그 학원 소유로 fork/복제한 뒤 GitHub Actions 배포가 그 프로젝트를 향하도록 아래 GitHub 저장소 Secrets(Settings → Secrets and variables → Actions)를 설정합니다.

| GitHub Secret 이름 | 용도 |
| --- | --- |
| `SUPABASE_PROJECT_ID` | 새 프로젝트의 ref (배포 대상 프로젝트 지정, cron 워크플로 4개의 호출 URL 조립에도 사용) |
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI 배포용 개인 액세스 토큰 |
| `SUPABASE_DB_PASSWORD` | 새 프로젝트 DB 비밀번호 (마이그레이션 적용용) |
| `SUPABASE_ANON_KEY` | 새 프로젝트의 anon key (cron 워크플로 4개가 Edge Function 호출 시 사용, 2026-09-21부터 하드코딩 제거) |

**2) Supabase Edge Function Secrets (대시보드 → Edge Functions → Secrets)**

먼저 노션 쪽에서 새 학원의 각 DB를 만들고(또는 템플릿에서 복제하고) 그 데이터소스 ID를 확인한 뒤 아래 이름 그대로 등록합니다. 데이터소스 ID는 해당 DB를 열어 URL의 `?v=` 뒤가 아니라, DB 우측 상단 `...` → "뷰 복제 링크 복사" 또는 API로 확인합니다.

| 분류 | Secret 이름 | 비고 |
| --- | --- | --- |
| Notion 연결 | `NOTION_TOKEN` | 새 학원 노션 워크스페이스의 통합(인테그레이션) 토큰 |
| Notion 연결 | `NOTION_REGISTRATION_DB_ID` | 등록(학원) DB. **주의: 데이터소스 ID(****`DATA_SOURCE_REGISTRATION_ID`****)와는 다른 값입니다** — `adminShared.ts`의 옛 `/v1/databases/{id}/query` 방식으로 조회되어 데이터베이스 페이지 ID가 필요합니다 |
| Notion 연결 | `NOTION_SEND_LOG_DB_ID` | 전송로그(학원) DB. 위와 동일하게 데이터소스 ID가 아니라 데이터베이스 페이지 ID가 필요합니다 |
| Notion 연결 | `NOTION_ALIMTALK_CONFIG_DB_ID` | 알림톡 설정(학원) DB (비워두면 알림톡 발송이 조용히 fallback 처리되니 반드시 등록). 위와 동일하게 데이터베이스 페이지 ID가 필요합니다 |
| 데이터소스 ID (17개, 2026-09-21 신규) | `DATA_SOURCE_REGISTRATION_ID` | 등록(학원) DB |
|  | `DATA_SOURCE_CLASS_ID` | 클래스(학원) DB |
|  | `DATA_SOURCE_ATTENDANCE_ID` | 출석(학원) DB |
|  | `DATA_SOURCE_CLASS_SESSION_ID` | 수업(학원) DB |
|  | `DATA_SOURCE_LEARNING_RECORD_ID` | 학습기록(학원) DB |
|  | `DATA_SOURCE_STUDY_ACTIVITY_ID` | 학습활동(학원) DB |
|  | `DATA_SOURCE_DASHBOARD_ID` | 대시보드(학원) DB |
|  | `DATA_SOURCE_SCHEDULE_EVENT_ID` | 일정(학원) DB |
|  | `DATA_SOURCE_TEXTBOOK_CART_ID` | 교재비(학원) DB (이미 예전부터 존재) |
|  | `DATA_SOURCE_TEXTBOOK_DISTRIBUTION_ID` | 교재배부(학원) DB (이미 예전부터 존재) |
|  | `DATA_SOURCE_TEXTBOOK_PAYMENT_ID` | 교재결제(학원) DB |
|  | `DATA_SOURCE_TIMETABLE_ID` | 시간표(학원) DB |
|  | `DATA_SOURCE_TUITION_ID` | 수강료(학원) DB |
|  | `DATA_SOURCE_REPORT_ID` | 보고서(학원) DB |
|  | `DATA_SOURCE_EXAM_SCOPE_ID` | 시험범위(학원) DB |
|  | `DATA_SOURCE_GRADE_ID` | 성적(학원) DB |
|  | `DATA_SOURCE_STUDENT_ID` | 학생(학원) DB |
|  | `DATA_SOURCE_PROGRESS_BOOK_ID` | 진도교재(학원) DB (이미 예전부터 존재) |
| 인프라 | `SB_URL` | 새 Supabase 프로젝트 URL (예: `https://abcdefgh.supabase.co` 형태, ref 부분만 새 프로젝트 것으로) |
| 인프라 | `SB_SERVICE_ROLE_KEY` | 새 프로젝트의 service role key |
| 인프라 | `ADMIN_SECRET` | 이 학원의 관리자 키 (노션 자동화 헤더·웹앱 로그인에 사용할 값, 학원마다 다르게 설정 권장) |
| 알림톡 | `SOLAPI_API_KEY`, `SOLAPI_API_SECRET`, `SOLAPI_SENDER_NUMBER` | 그 학원의 Solapi 계정/발신번호 |

> 이 노션 워크스페이스는 데이터베이스마다 "데이터베이스(페이지) ID"와 "데이터소스 ID"가 서로 다른 별개 값입니다(하나에서 다른 하나를 유도할 수 없음). `DATA_SOURCE_*_ID` 17개는 데이터소스 ID(`collection://...`)를 쓰고, `NOTION_REGISTRATION_DB_ID`·`NOTION_SEND_LOG_DB_ID`·`NOTION_ALIMTALK_CONFIG_DB_ID` 3개는 데이터베이스 페이지 ID(그 DB가 인라인으로 들어있는 메뉴 페이지를 열었을 때 데이터베이스 블록의 실제 URL)를 씁니다. 데이터소스 ID를 이 3개에 넣으면 조회가 404로 실패합니다.

**3) Supabase Vault 시크릿**

Database → Vault → Add new secret 에서 이름 `sync_queue_admin_key`, 값은 위 `ADMIN_SECRET`과 동일하게 등록합니다(process-sync-queue의 pg_cron 인증용, 10-17 참고). 이 값이 없으면 process-sync-queue 자체 호출은 대부분 정상 동작하지만, 1분마다 도는 pg_cron 안전망 호출만 401로 실패합니다.

**4) 아직 자동화되지 않아 수동으로 고쳐야 하는 부분**

> 아래 항목들은 이번 리팩토링 범위 밖입니다 — 값 자체가 배포 파이프라인의 히스토리(마이그레이션)이거나 서버가 없는 정적 파일이라, 새 학원마다 파일을 직접 열어 값을 바꿔야 합니다.

- `supabase/migrations/20260918190000_create_sync_queue.sql`, `supabase/migrations/20260921020000_process_sync_queue_cron_auth.sql`: pg_cron이 호출하는 `url := 'https://twczhsxybkcvjkdfdxvs.supabase.co/...'` 부분을 새 프로젝트 URL로 바꾼 뒤 배포해야 합니다.
- `attendance_kiosk.html`, `student_report_part1.js`: 상단의 `SUPABASE_URL`/`SUPABASE_ANON_KEY` 상수를 새 프로젝트 값으로 바꿔야 합니다(GitHub Pages 등 정적 호스팅이라 서버 환경변수를 못 씀).

**5) 노션 템플릿 공유 + 웹훅 등록**

- [하다 학원관리(예시)](https://app.notion.com/p/629ba040586b837584ce01f7457f3c1e)를 복제해 새 학원 워크스페이스로 공유합니다.
- 6-1·6-2에 나열된 각 Edge Function을 호출하는 노션 자동화(버튼의 "웹훅 보내기" 액션)를 모두 새 프로젝트의 URL로 다시 연결하고, 관리자 키가 필요한 함수(10-17의 인증 있는 함수들)는 `x-admin-key` 커스텀 헤더도 새 `ADMIN_SECRET` 값으로 다시 넣어야 합니다.
- 6-3의 예약 실행(GitHub Actions cron, pg_cron)은 저장소·마이그레이션을 그대로 복제하면 함께 따라오지만, 위 4)의 URL을 먼저 고쳐야 정상 동작합니다.

**진행 상태**: 2026-09-21 현재 위 1)~3)은 코드/문서 준비가 끝났고, 강인희님 학원(현재 운영 환경)에는 이미 적용·검증까지 완료했습니다. 4)·5)는 실제로 새 학원이 생길 때 그 시점에 진행하면 됩니다.

### 10-19. 2026-09-22 처리 상태 관리 리팩토링 Phase 5: 옛 체크박스 스키마·문서 정리

Phase 0~4에서 select 기반 StatusSpec으로 전환이 끝난 뒤, 이제는 어디서도 읽거나 쓰지 않는 옛 "OO 처리중" 체크박스 속성 자체를 노션 스키마와 코드에서 제거하는 마무리 단계입니다.

- **노션 스키마 정리(30개 체크박스, 14개 DB)**: 등록(학원) DB 6개, 클래스(학원) DB 5개, 수업(학원) DB 5개, 출석(학원) DB 2개, 진도교재(학원) DB 1개, 시험범위(학원) DB 1개, 학습기록(학원) DB 2개, 학습활동(학원) DB 1개, 교재비(학원) DB 2개, 교재배부(학원) DB 1개, 교재결제(학원) DB 1개, 알림톡 발송함(학원) DB 1개, 시간표(학원) DB 1개, 메뉴(학원) DB 1개를 삭제했습니다. 모두 각 DB의 "실시간 처리 상태" 수식이나 코드 어디에서도 더 이상 참조하지 않는 죽은 속성임을 먼저 확인한 뒤 삭제했습니다. 삭제와 함께 영향받는 5개 뷰(교재비(카트)/교재배부/교재결제/알림톡 발송함 DB)의 표시 속성 목록에서도 같은 이름을 제거했고, 2개 DB(클래스/시험범위)의 "실시간 처리 상태" 수식 설명 텍스트도 새 모델을 반영해 갱신했습니다. **예외적으로 유지한 항목**: 출석(학원) DB의 "보고서 전송중" 체크박스는 `send-daily-report`가 여전히 실제로 읽고 쓰는 라이브 속성이라 삭제하지 않았습니다.
- **코드 정리**: `_shared/constants.ts`에서 위 삭제와 짝을 이루는 죽은 상수 8개(`PROP_SYNC_TIMETABLE_RUNNING`/`PROP_SYNC_TEXTBOOK_RUNNING`/`PROP_SYNC_CLASS_SESSION_RUNNING`/`PROP_SYNC_END_RUNNING`/`PROP_SYNC_ENROLL_RUNNING`/`PROP_DELETING_RUNNING`/`ALL_SYNC_RUNNING_FLAGS`/`PROP_TIMETABLE_GEN_RUNNING`)를 제거했습니다. 전체 저장소 grep으로 실제 사용처가 전혀 없음을 먼저 확인했고(다른 파일에는 과거 리팩토링을 설명하는 주석 속에만 이름이 남아있어 실제 참조는 아님), 제거 후 `deno check`(34개 함수 전체) 통과, 회귀 가드 스크립트 통과, GitHub Actions 배포(타입체크·마이그레이션·전체 함수 배포·필수 Secrets 검증) 성공까지 확인했습니다.
- **메뉴얼 갱신**: 4-2의 등록(학원) DB 처리 상태 설명, 6-4의 상태 확인 원칙, 등록/클래스 DB 일부 버튼 설명에 남아있던 "OO 체크박스" 문구를 select 기반 표현으로 고쳤습니다.
- 이 작업으로 [처리 상태 관리 리팩토링 마스터플랜 (2026-09-21 작성)](https://app.notion.com/p/903c90386c1d473494c5df6306c53517)의 Phase 5(마지막 단계)가 완료되어, 마스터플랜 전체가 종료되었습니다.


---

## 2026-09-24~25 후속 기록 — 수업 생성 429 안정화 및 웹훅 축소

### 확인된 원인

- `generate-classes`의 장시간 정지 원인은 내부 CPU 작업이 아니라 Notion API가 대량 생성 중 `429`와 긴 `Retry-After`(실측 약 28~56초 이상)를 반환한 것이었다.
- 수업 1건과 학생별 출석을 생성할 때마다 대시보드 연결 큐와 실시간 `report_cache` 재계산까지 연쇄 실행되어 Notion API 호출량과 `sync_queue` 적체가 커졌다.
- 일괄 생성 체인의 자기호출 응답 미검사, 상태 표시 실패가 후속 자기호출을 막는 경로도 함께 수정했다.

### 최종 반영

- `generate-classes` 호출 1회당 세션 1개와 해당 출석만 처리하고 다음 건은 자기호출로 이어가는 고정 단위 체인으로 변경했다.
- 등록별 동시성을 `REG_CONCURRENCY=4`로 제한하고, 미연결 출석 검색을 등록별 N회에서 세션당 1회로 통합했다.
- `generate-classes`/`kiosk-checkin`의 `enqueueDashboardLink()` 호출을 제거하고, `nightly-dashboard-link-audit` 함수와 워크플로도 삭제했다.
- `sync-attendance`의 실시간(pageId) 경로에서 `refreshReportCacheForRegistrations` 호출을 제거했다. 원본 `attendance_records` 동기화는 유지하며, 시간당 incremental 동기화와 발송 직전 재계산을 안전망으로 사용한다.
- 등록/학습기록/학습활동/보고서 DB의 생성·편집 시 `sync-report-cache` 자동화 5개를 Notion에서 제거했다. 정규교재와 일정 관련 자동화, 학부모 화면의 수동 동기화, 클래스의 수동 학생 페이지 동기화는 별개 기능이므로 유지한다.
- 실제 스케줄러가 없던 `generate-classes`의 죽은 자동 크론 분기와 `AUTO_HORIZON_DAYS`를 제거했다. 현재 공식 진입점은 단일 시간표 버튼과 메뉴의 일괄 생성 버튼이다.

### 운영 확인

- 조치 후 기존에 멈추던 `고2 A반 (수)` 시간표가 `✅ 완료`, 오류 없음으로 끝났고 출석 15명도 정상 생성됐다.
- 2026-09-25 사용자 운영 확인: **대시보드 웹훅과 실시간 보고서 캐시 웹훅을 제거한 뒤 수업 생성이 정상 작동 중**이다.
- 따라서 해당 웹훅은 복구하지 않고 제거 상태를 유지한다. 현재는 추가 구조 변경보다 재발 여부를 관찰한다.

### 관련 커밋

- `f44e0dc` — Notion 429/Retry-After 진단 로깅
- `78836be` — 수업·출석 생성 경로의 대시보드 즉시 큐 적재 제거
- `5ce1ef0` — 죽은 `generate-classes` 자동 크론 분기 제거
- `340d855` — `sync-attendance` 실시간 경로의 즉시 `report_cache` 재계산 제거
- 그 외 체인 안정화: `51ce674`, `aeb7601`, `8500595`, `3ebb60c`, `5cd6ae5`
