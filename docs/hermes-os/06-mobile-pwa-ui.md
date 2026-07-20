# 06. Mobile PWA UI

## 목적

모바일 PWA에서 device 등록, 명령 실행, command result/log 확인, task plan/verification 확인이 가능하도록 UI를 구현한다.

## 선행 조건

- `04-control-plane-api.md`
- `05-orchestrator-capability-verification.md`
- 현재 파일 재확인:
  - `apps/web/src/main.tsx`
  - `apps/web/src/styles.css`
  - `apps/web/src/api.ts`
  - `packages/shared/src/index.ts`

## UI 원칙

- 첫 화면은 실제 작업 UI다.
- 모바일 390x844에서 터치 조작 가능해야 한다.
- 버튼 최소 높이 44px.
- 기존 프로젝트 등록 drawer 패턴과 일관되게 구성한다.
- 설명 텍스트로 기능을 대신하지 말고 실제 컨트롤을 제공한다.
- 로그/결과는 접이식, 복사 가능, overflow-safe.
- Local, Windows, Android, Tizen, Linux badge를 명확히 표시한다.

## 화면 구성

### Devices entry

상단 또는 프로젝트 액션 영역에 Devices 버튼 추가.

### Devices drawer

필드:

- platform segmented control
- transport selector
- status filter
- device list
- discover button
- register button

### Device detail drawer

표시:

- platform
- transport
- endpoint
- status
- labels
- last seen
- quick actions

### Command drawer

공통:

- action selector
- params form
- requires approval 표시
- run button

Platform quick actions:

- Windows: system info, service status, eventlog query, powershell
- Linux: system info, service status, journal query, shell
- Android: system info, logcat, shell
- Tizen: system info, dlog, shell

Transport UI:

- Windows: WinRM, OpenSSH
- Linux: SSH
- Android: ADB
- Tizen: SDB
- Local smoke: local_mock

Windows command form:

- WinRM endpoint 또는 OpenSSH endpoint를 transport에 맞게 표시한다.
- credential secret 값은 화면에 다시 표시하지 않는다.
- destructive PowerShell pattern은 실행 버튼을 비활성화하고 blocked 상태를 보여준다.

### Command result panel

표시:

- status
- duration
- exitCode
- stdout
- stderr
- artifactUri
- verification status/confidence

### Task plan panel

Task detail에 표시:

- selected capabilities
- plan steps
- active step
- device command links
- verification results

## 구현 프롬프트

```text
당신은 Termes Mobile PWA Engineer입니다.

04, 05, 06 문서를 읽고 모바일 Devices UI를 구현하십시오.
현재 apps/web/src/main.tsx와 styles.css를 다시 읽고 기존 프로젝트 drawer의 모바일 패턴을 따르십시오.

작업:
1. apps/web/src/api.ts의 device API client를 사용한다.
2. Devices 버튼과 drawer를 추가한다.
3. device list/register/edit UI를 추가한다.
4. transport selector를 추가한다. Windows는 WinRM과 OpenSSH를 선택할 수 있어야 한다.
5. command run drawer를 추가한다.
6. command result/log drawer를 추가한다.
7. task detail에 task plan/verification panel을 추가한다.
8. SSE events를 받아 command/plan 상태를 갱신한다.
9. Windows quick actions를 포함한다.
10. 모바일 viewport에서 텍스트 겹침과 터치 크기를 확인한다.

검증:
- pnpm lint
- Playwright 390x844 viewport
- local_mock device 등록
- local_mock.echo 실행
- command completed 표시
- task plan panel 표시

완료 후:
- 테스트 데이터는 삭제한다.
```

## 체크리스트

- [ ] Devices 진입 버튼이 있다.
- [ ] 모바일 drawer가 열린다.
- [ ] device list가 platform badge를 표시한다.
- [ ] Windows badge가 있다.
- [ ] Windows transport selector에 WinRM과 OpenSSH가 있다.
- [ ] device 등록 UI가 있다.
- [ ] command action selector가 있다.
- [ ] Windows quick actions가 있다.
- [ ] local_mock command를 실행할 수 있다.
- [ ] stdout/stderr/result가 보인다.
- [ ] verification result가 보인다.
- [ ] task plan steps가 보인다.
- [ ] SSE로 상태가 갱신된다.
- [ ] 390x844에서 텍스트가 겹치지 않는다.
- [ ] 버튼 터치 영역이 44px 이상이다.
- [ ] `pnpm lint`가 통과했다.
