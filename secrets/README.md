# Secrets

이 디렉터리는 프로젝트 개발에 필요한 민감 정보를 암호화된 형태로 보관합니다.

- 암호문: `secrets/server-access.enc.json`
- 기본 키 위치: `~/.config/termes/server-access.key`
- 키 권한: `0600`

복호화된 값은 repository에 저장하지 않습니다.

사용 예:

```bash
node scripts/secrets.mjs env
```

현재 shell에 환경변수로 주입해야 할 때:

```bash
eval "$(node scripts/secrets.mjs env)"
```

주의:

- `node scripts/secrets.mjs decrypt`는 평문 JSON을 터미널에 출력합니다.
- 출력 결과를 로그, 이슈, 문서, git에 남기지 마십시오.
- 복호화 키는 프로젝트 밖에 있으므로 repository를 공유해도 secret은 복호화되지 않습니다.
