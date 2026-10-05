#!/usr/bin/env bash
# Stand & Deliver: anonymous, read-only checks. Bash 3.2+, curl, Python 3.
# Never source this file or run it with shell verbose/tracing enabled.
set +x
set +v
set -euo pipefail
umask 077

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash kaiorderapp-demo.sh proxy|direct|rate|tunnel|access|private|preflight
Run on your laptop, not EC2 or CloudShell. Requires curl and Python 3.
Before direct/preflight, export ORIGIN_IP using the CURRENT EC2 public IPv4.
No cookies, tokens, login, infrastructure changes or authenticated requests.
Rate: baseline, at most 30 burst requests, stop at first 429, health check,
20 seconds quiet, one recovery request. Wait 20 seconds before repeating.
Preflight checks all non-burst modes plus one rate-test baseline.
HELP
}
[[ $# -eq 1 ]] || { usage; exit 2; }
case "$1" in
  -h|--help) usage; exit 0 ;;
  proxy|direct|rate|tunnel|access|private|preflight) mode=$1 ;;
  *) usage; exit 2 ;;
esac
command -v curl >/dev/null || fail 'curl is required.'
command -v python3 >/dev/null || fail 'Python 3 is required.'
# Ignore user curl configuration, proxies and optional TLS session-key logging.
unset SSLKEYLOGFILE
work=$(mktemp -d "${TMPDIR:-/tmp}/kaiorderapp-demo.XXXXXXXX") || fail 'Cannot create private temporary directory.'
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
proxy_url=https://demo.kaiorderapp.com
tunnel_url=https://tunnel.kaiorderapp.com

# Raw responses remain in mode-600 temporary files, never in terminal output.
# No redirects, retries, cookie jar, netrc, verbose output or insecure TLS.
request() {
  local url=$1
  shift
  curl_rc=0
  curl -q -4 --noproxy '*' --proto '=http,https' --silent \
    --connect-timeout 5 --max-time 15 --max-filesize 1048576 \
    --dump-header "$work/headers" --output "$work/body" \
    --write-out '%{http_code} %{time_connect}' "$@" "$url" \
    >"$work/result" 2>"$work/error" || curl_rc=$?
  read -r code connected <"$work/result" || true
  [[ ${code:-} =~ ^[0-9][0-9][0-9]$ ]] || fail 'curl did not return a valid HTTP status.'
}
transport_ok() {
  [[ $curl_rc -eq 0 ]] || fail "Request failed (curl exit $curl_rc); raw diagnostics withheld. Check DNS, connectivity and TLS off-screen."
}
expect() {
  transport_ok
  [[ $code == "$1" ]] || fail "Unexpected HTTP $code; expected $1. Stop and inspect off-screen."
}
# Validate data, then print fixed summaries only. Even allowlisted header values
# could contain arbitrary data, so never interpolate response values into output.
check() {
  python3 - "$work" "$@" <<'PY'
import json, pathlib, re, sys
from urllib.parse import urlsplit
try:
    root, kind, *args = sys.argv[1:]
    p = pathlib.Path(root)
    headers = {}
    for line in (p / 'headers').read_text(errors='replace').splitlines():
        if line.startswith('HTTP/'):
            headers = {}
        elif ':' in line:
            key, value = line.split(':', 1)
            headers.setdefault(key.lower(), []).append(value.strip())
    def one(name):
        values = headers.get(name, [])
        if len(values) != 1:
            raise ValueError()
        return values[0]
    if kind in ('health', 'echo', 'rate'):
        if one('content-type').split(';')[0].strip().lower() != 'application/json':
            raise ValueError()
        data = json.loads((p / 'body').read_bytes())
        if not isinstance(data, dict):
            raise ValueError()
        if kind == 'health' and data.get('status') != 'ok':
            raise ValueError()
        if kind == 'rate' and data.get('ok') is not True:
            raise ValueError()
        if kind == 'echo':
            if data.get('headers', {}).get('x-demo-message') != args[0]:
                raise ValueError()
            if 'no-store' not in one('cache-control').lower().split(', '):
                raise ValueError()
    elif kind == 'edge':
        if one('server').lower() != 'cloudflare' or not re.fullmatch(r'[0-9a-fA-F]{16,32}-[A-Z]{3}', one('cf-ray')):
            raise ValueError()
    elif kind == 'https':
        if one('location') != 'https://demo.kaiorderapp.com/api/health':
            raise ValueError()
    elif kind == 'access':
        u = urlsplit(one('location'))
        if (u.scheme != 'https' or u.hostname != 'lively-feather-51bb.cloudflareaccess.com'
                or u.username or u.password or u.port not in (None, 443)
                or not u.path.startswith('/cdn-cgi/access/login/')):
            raise ValueError()
        body = (p / 'body').read_bytes().lower()
        if 'image/svg+xml' in headers.get('content-type', [''])[0].lower() or b'<svg' in body:
            raise ValueError()
    else:
        raise ValueError()
except Exception:
    # No exception text: parsing failures may embed credentials or raw bodies.
    sys.exit(1)
PY
}
validated() { check "$@" || fail 'Response validation failed; body and headers withheld. Inspect off-screen.'; }
health() {
  request "$1/api/health"; expect 200; validated health
  printf 'Health: HTTP 200; status ok\n'
}
route() {
  health "$1"
  validated edge
  printf 'Cloudflare metadata: server and cf-ray validated (values withheld)\n'
  request "$1/api/headers" -H "X-Demo-Message: $2"
  expect 200; validated echo "$2"
  printf 'Custom header received: X-Demo-Message: %s; no-store verified\n' "$2"
}
proxy() {
  route "$proxy_url" 'Through Cloudflare'
  request 'http://demo.kaiorderapp.com/api/health'; transport_ok
  case "$code" in 301|302|307|308) ;; *) fail "HTTP-to-HTTPS redirect expected; got HTTP $code." ;; esac
  validated https
  printf 'HTTP redirect: %s -> HTTPS, same host/path (not followed)\n' "$code"
  printf 'Proxy headers alone do not prove Full (strict); pair with saved configuration.\n'
}
validate_ip() {
  python3 - <<'PY' || fail 'Set ORIGIN_IP to the current public EC2 IPv4 from AWS before running this mode.'
import ipaddress, os, sys
try:
    ip = ipaddress.IPv4Address(os.environ.get('ORIGIN_IP', ''))
    sys.exit(0 if ip.is_global else 1)
except ValueError:
    sys.exit(1)
PY
}
direct() {
  validate_ip
  health "$proxy_url"
  request "$proxy_url/api/health" --connect-timeout 8 --max-time 10 \
    --resolve "demo.kaiorderapp.com:443:$ORIGIN_IP"
  # Only a timeout before TCP connection counts, not TLS errors, refusal, or an
  # origin that connected successfully and then stalled while serving the body.
  if [[ $curl_rc -eq 28 && $code == 000 && $connected =~ ^0([.]0+)?$ ]]; then
    printf 'Direct: connection timed out before TCP connected; TLS hostname preserved.\n'
  else
    fail "Direct result is not the expected connection timeout (curl $curl_rc, HTTP $code)."
  fi
  health "$proxy_url"
  printf 'Consistent with origin restriction, only if ORIGIN_IP is current. Not account-specific authentication.\n'
}
tunnel() {
  route "$tunnel_url" 'Through Tunnel'
  printf 'Pair with saved Tunnel routing; headers alone do not establish the route.\n'
  printf 'Browser: https://tunnel.kaiorderapp.com -> add dish -> submit mock order.\n'
}
anonymous() {
  request "$tunnel_url$1"; expect 302; validated access
  printf '%s: HTTP 302 -> verified Access login (redirect/state withheld); no SVG returned.\n' "$1"
}
access() {
  request "$tunnel_url/"; expect 200
  printf 'Public homepage: HTTP 200\n'
  anonymous /secure
  anonymous /secure/SG
  printf 'Private browser: open /secure; approved email login; retrieve OTP off-screen.\n'
}
private() {
  anonymous /secure/SG
  printf 'Authenticated browser only: /secure -> country link; verify identity sentence, then SVG 200, image/svg+xml, private/no-store.\n'
  printf 'Show response headers only; hide cookies, tokens, inbox and login URLs.\n'
}
rate_baseline() {
  request "$proxy_url/api/rate-test"; expect 200; validated rate
  printf 'Baseline: HTTP 200\n'
}
rate() {
  rate_baseline
  local i limited=0
  for ((i=1; i<=30; i++)); do
    request "$proxy_url/api/rate-test"; transport_ok
    printf 'Burst %02d: HTTP %s\n' "$i" "$code"
    case "$code" in
      429) limited=1; break ;;
      200) validated rate ;;
      *) fail "Unexpected burst HTTP $code; stopping." ;;
    esac
    [[ $i -eq 30 ]] || sleep 0.2
  done
  [[ $limited -eq 1 ]] || fail 'No 429 within 30 burst requests. Stop; inspect the rule after the demo.'
  health "$proxy_url"
  printf 'Health 200 observed immediately after rate-test 429; this is sequential evidence, not simultaneous proof.\n'
  printf 'Waiting 20 seconds without requests before one recovery check...\n'
  sleep 20
  request "$proxy_url/api/rate-test"; expect 200; validated rate
  printf 'Recovery: HTTP 200. Demo complete: 200 -> 429 -> 200.\n'
}
preflight() {
  validate_ip
  proxy; direct; tunnel; access; private; rate_baseline
  printf 'Preflight passed. Burst not run: rehearse rate separately, then leave it quiet for at least 20 seconds.\n'
  printf 'Privately confirm current AWS IP, TLS/Tunnel/Access settings, private R2, FLAGS and SG asset; complete browser rehearsal.\n'
}
"$mode"
