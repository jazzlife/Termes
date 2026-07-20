# 03. Platform Adapters

## 목적

Device gateway에 Linux, Windows, Android, Tizen adapter를 추가한다. 외부 장치가 없어도 command builder와 policy test는 통과해야 하며, 실제 장치가 있으면 smoke가 확장 실행되어야 한다.

## 선행 조건

- `02-device-gateway-core.md`
- 현재 파일 재확인:
  - `services/device-gateway/src/main.ts`
  - `infra/compose/.env.example`
  - `packages/shared/src/index.ts`

## 공통 adapter 계약

모든 adapter는 같은 interface를 구현한다.

```ts
type DeviceAdapter = {
  discover(): Promise<DeviceGatewayDevice[]>;
  run(device: DeviceGatewayDevice, request: DeviceGatewayCommandRequest): Promise<DeviceGatewayCommandResult>;
};
```

공통 정책:

- endpoint host allowlist. `DEVICE_ALLOWED_HOSTS` 또는 `WINRM_ALLOWED_HOSTS`가 비어 있으면 개발/로컬 검증을 위해 제한하지 않고, 값이 있으면 쉼표 구분 exact host 또는 `*.example.com` 패턴만 허용한다.
- command timeout
- bounded stdout/stderr
- blocked pattern 검사
- artifact path root 검사
- secret redaction. `password`, `token`, `secret`, `apiKey`, `privateKey`, `authorization`, `credential` 계열 params 값은 DB 원장과 command stdout/stderr에서 `[REDACTED]`로 치환한다.

## Linux SSH adapter

Transport: `ssh`

Actions:

- `linux.system.info`
- `linux.shell`
- `linux.service.status`
- `linux.journal.query`

Blocked by default:

- `rm -rf /`
- `mkfs`
- `dd if=`
- `shutdown`
- `reboot`
- `:(){ :|:& };:`

Reserved approval-only actions:

- `linux.service.restart`

## Windows adapter

Transport:

- `winrm`: production contract
- `ssh`: MVP executable path for Windows OpenSSH

Actions:

- `windows.system.info`
- `windows.powershell`
- `windows.service.status`
- `windows.eventlog.query`

Blocked by default:

- `Format-Volume`
- `Remove-Item -Recurse C:\`
- `Clear-EventLog`
- `Stop-Computer`
- `Restart-Computer`
- destructive `diskpart`
- destructive `bcdedit`

Windows MVP rule:

- WinRM transport must exist in schema/API/UI.
- If WinRM library is not installed, return `transport_unavailable` with setup guidance.
- Windows OpenSSH path must be executable when host credentials are configured.
- Windows mock command tests must prove policy blocking.

Reserved approval-only actions:

- `windows.service.restart`
- `windows.app.install.msix`
- `windows.app.install.msi`
- `windows.app.uninstall`

## Android ADB adapter

Transport: `adb`

Actions:

- `android.system.info`
- `android.shell`
- `android.logcat`

Rules:

- Missing `adb` returns capability unavailable, not process crash.
- Destructive shell action requires explicit serial and policy approval.
- logcat has line limit and timeout.

Reserved approval-only actions:

- `android.install`
- `android.uninstall`

## Tizen SDB adapter

Transport: `sdb`

Actions:

- `tizen.system.info`
- `tizen.shell`
- `tizen.dlog`

Rules:

- Missing `sdb` returns capability unavailable.
- install/uninstall are approval candidates.
- dlog has line limit and timeout.

Reserved approval-only actions:

- `tizen.install`
- `tizen.uninstall`

## 구현 프롬프트

```text
당신은 Termes Platform Adapter Engineer입니다.

02 문서의 device-gateway core를 먼저 읽고, 이 문서의 platform adapter를 구현하십시오.
구현 전 services/device-gateway/src/main.ts의 현재 구조를 다시 읽으십시오.

작업:
1. `supportedActions`와 capability seed의 action 목록을 일치시킨다.
2. local_mock adapter dispatch를 유지한다.
3. linux ssh adapter dispatch를 구현한다.
4. windows adapter dispatch를 구현한다. WinRM은 contract와 validation을 포함하고, Windows OpenSSH 실행 경로를 제공한다.
5. android adb adapter dispatch를 구현한다.
6. tizen sdb adapter dispatch를 구현한다.
7. platform별 command builder와 blocked command test를 추가한다.
8. 외부 binary가 없는 경우에도 health/build가 실패하지 않게 한다.
9. endpoint host allowlist와 secret redaction을 검증한다.

검증:
- pnpm lint
- pnpm build
- local_mock smoke
- blocked command smoke
- 환경변수가 있으면 실제 ssh/windows/adb/sdb smoke

완료 후:
- 지원하지 않는 환경에서도 명확한 unavailable 에러를 반환하는지 확인한다.
```

## 체크리스트

- [ ] `supportedActions`, DB capability seed, UI quick action이 일치한다.
- [ ] local_mock adapter dispatch가 있다.
- [ ] Linux SSH action이 정의됐다.
- [ ] Windows WinRM transport가 계약에 포함됐다.
- [ ] Windows OpenSSH 실행 경로가 있다.
- [ ] Windows 위험 명령 차단 test가 있다.
- [ ] Android ADB action이 정의됐다.
- [ ] ADB binary 없음이 graceful error다.
- [ ] Tizen SDB action이 정의됐다.
- [ ] SDB binary 없음이 graceful error다.
- [ ] stdout/stderr bounded output이 모든 adapter에 적용됐다.
- [ ] endpoint allowlist가 모든 network transport에 적용됐다.
- [ ] command params와 stdout/stderr secret redaction이 적용됐다.
- [ ] `pnpm lint`가 통과했다.
