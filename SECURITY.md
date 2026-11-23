# 보안 설계서 (Security Architecture) · 토목기사 필기 CBT 120제

이 문서는 `civil-cbt-120-easy` 웹 애플리케이션과 Vercel 프로덕션 인프라, 로컬 실행 서버, GitHub 저장소 전반에 적용된 다계층 방어(Defense-in-Depth) 보안 설계를 정리합니다.

---

## 1. 위협 모델 및 보안 원칙
- **서비스 특성**: 개인정보·로그인·DB 서버 없이 동작하는 **100% 정적 클라이언트(Zero-Backend)** 교육 웹앱 (모든 학습 기록은 사용자 기기 `localStorage`에만 로컬 저장).
- **주요 위협 벡터**:
  1. **DOM XSS / 콘텐츠 인젝션**: 기출문제 HTML·수식 렌더링 과정에서의 악성 스크립트 삽입 위험
  2. **CDN 공급망 변조(Supply-Chain)**: 외부 CDN(KaTeX, ONNX Runtime Web) 변조 시 스크립트 탈취 위험
  3. **클릭재킹·MIME 스니핑·리퍼러 유출**: 보안 HTTP 응답 헤더 미설정으로 인한 브라우저 공격
  4. **크롤링·취약점 스캔·DDoS**: `.env`·관리자 경로 탐색 및 대량 데이터 스크래핑
  5. **시크릿·토큰 유출**: `.env.local`(Vercel OIDC 토큰), API 키, 2FA 키의 저장소/배포 노출
  6. **계정 탈취**: Vercel / GitHub 계정의 2단계 인증(2FA) 미설정

---

## 2. 계층별 적용 보안 통제 (Defense-in-Depth)

### Layer 1 · HTTP 보안 응답 헤더 (`vercel.json`)
모든 경로(`/(.*)`)에 아래 보안 헤더를 강제 적용합니다.

| 헤더 | 설정 값 | 방어 대상 |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'self'`; `script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'` (인라인 스크립트·`unsafe-eval` 전면 금지); `connect-src` HuggingFace/jsDelivr 한정; `img-src 'self' https://cbtbank.kr data: blob:`; `object-src 'none'`; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`; `upgrade-insecure-requests` | XSS, 데이터 유출, 클릭재킹, 혼합 콘텐츠 |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | HTTPS 다운그레이드 · MITM |
| `X-Content-Type-Options` | `nosniff` | MIME 타입 혼동 공격 |
| `X-Frame-Options` | `DENY` | 클릭재킹(Clickjacking) |
| `Referrer-Policy` | `no-referrer` | 외부 이미지/CDN 요청 시 URL 리퍼러 유출 방지 |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` | 불필요한 브라우저 하드웨어 권한 원천 차단 |
| `Cross-Origin-Opener-Policy` | `same-origin` | 교차 출처 윈도우 참조(XS-Leaks) 차단 |
| `X-DNS-Prefetch-Control` | `off` | 불필요한 DNS 프리페치 추적 방지 |

### Layer 2 · 공급망 무결성 (Subresource Integrity · SRI)
- `index.html`의 KaTeX 0.16.11 CSS/JS 3종과 `supertonic_web.js`의 ONNX Runtime Web 1.21.0(`ort.all.min.js`)에 **SHA-384 암호화 해시(`integrity="sha384-..."`)** 와 `crossorigin="anonymous"`를 고정했습니다.
- CDN 파일이 1바이트라도 변조되면 브라우저가 실행을 즉시 차단합니다.

### Layer 3 · 클라이언트 DOM XSS 방어 (`app.js`)
- 모든 문제 지문·보기·해설 HTML 렌더링(`innerHTML`) 직전에 **`DOMParser` 기반 화이트리스트 새니타이저(`sanitizeHtml`)** 를 통과시킵니다.
- 허용된 교육용 HTML 태그(`br, p, div, span, b, sub, sup, img, table...`)만 유지하고 `<script>`, `<iframe>`, `<object>`, `<embed>`, `<svg>`, 모든 `on*=` 이벤트 핸들러, `javascript:` URI, 위험 CSS 표현식을 제거합니다.
- `<img src>`는 로컬 `./images/...`, 공식 기출 이미지 호스트(`https://cbtbank.kr/...`), 안전한 `data:image/` Base64만 허용합니다.

### Layer 4 · Vercel 플랫폼 보안 & WAF (Firewall)
- **L3/L4/L7 자동 DDoS 완화**: Vercel 전 플랜 기본 활성화.
- **Deployment Protection**: Preview 배포 보호 유지, `.vercelignore`로 `.env*`, `.vercel/`, `server.py`, `.github/`, `README.md`, `SECURITY.md`의 정적 서빙 원천 차단.
- **WAF 커스텀 규칙 (단계적 배포 · Staged Rollout)**:
  - 취약점 스캐너 경로(`/.env`, `/.git/config`, `/wp-admin`, `/phpmyadmin` 등) 모니터링 및 차단 규칙
  - `/data/` 대량 스크래핑 감지 레이트 리밋 규칙(IP 기준)

### Layer 5 · 로컬 서버 보안 (`server.py`)
- `127.0.0.1` 루프백 전용 바인딩 (외부 네트워크 노출 없음).
- 디렉터리 목록 조회(`list_directory`) `403 Forbidden` 차단.
- 점 파일(`/.env*`, `/.git*`, `/.vercel*`) 및 소스/배치 파일(`*.py`, `*.bat`) HTTP 접근 `403` 차단.
- `POST /api/tts` 최대 입력 길이 제한(2,000자), 화자 ID 화이트리스트(`F1~F5`), 속도 범위 클램핑(`0.8~1.5`).

### Layer 6 · 저장소 및 CI 보안 (`.gitignore` & GitHub Actions)
- `.gitignore`로 `.env*`, `.vercel/`, 개인 키·로그 파일의 Git 커밋을 원천 차단합니다.
- `.github/workflows/security-check.yml`이 매 Push/PR마다 자동으로:
  1. 시크릿/토큰/2FA 키 패턴 유출 검사
  2. 7,320문항 JSON 내 `<script>`/`on*=`/`http://` 혼입 검사
  3. `vercel.json` 필수 보안 헤더 및 `index.html` SRI 해시 누락 검사

---

## 3. 취약점 제보 (Reporting a Vulnerability)
보안 취약점을 발견하신 경우 공개 이슈가 아닌 저장소 소유자에게 비공개로 제보해 주시기 바랍니다.
