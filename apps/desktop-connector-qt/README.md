# Termes Connector Qt

Qt 6/C++로 구현한 독립형 Termes Desktop Connector입니다. 기존 `apps/desktop-connector`의 HTTP 페어링, outbound WebSocket 프로토콜, 로컬 승인, OS 권한 확인, 보안 자격 증명 저장과 3:2 운영 UI를 같은 계약으로 제공합니다.

## macOS 빌드

```bash
cmake -S . -B build -G Ninja -DCMAKE_PREFIX_PATH="$(brew --prefix qt)"
cmake --build build
open build/termes-connector-qt.app
```

## Windows 빌드

Qt 6의 MSVC x64 키트를 설치한 Developer PowerShell에서 실행합니다.

```powershell
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH="$env:QT_ROOT"
cmake --build build
```
