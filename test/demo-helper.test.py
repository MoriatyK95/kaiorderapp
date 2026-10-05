"""Offline contract tests: fake curl/sleep; never contact demo infrastructure."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAKE_CURL = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
assert args[0] == '-q'
assert args[args.index('--noproxy') + 1] == '*'
assert not any(a in args for a in ['-L', '-k', '--insecure', '--cookie', '--netrc', '--retry'])
assert 'SSLKEYLOGFILE' not in os.environ
log = pathlib.Path(os.environ['DEMO_LOG'])
previous = [json.loads(s) for s in log.read_text().splitlines()] if log.exists() else []
with log.open('a') as f: f.write(json.dumps(args) + '\n')
url, scenario = args[-1], os.environ.get('SCENARIO', '')
status, rc, connected = 200, 0, '0.010000'
headers = ['server: cloudflare', 'cf-ray: 0123456789abcdef-SIN', 'content-type: application/json', 'cache-control: no-store', 'set-cookie: TOP_SECRET_COOKIE']
body = json.dumps({'status':'ok', 'ok':True, 'headers':{'x-demo-message': 'Through Tunnel' if 'tunnel.' in url else 'Through Cloudflare', 'cookie':'TOP_SECRET_COOKIE', 'authorization':'TOP_SECRET_JWT'}, 'rawHeaders':['TOP_SECRET_JWT']})
if url.startswith('http:'):
    status = 301
    headers.append('location: https://demo.kaiorderapp.com/api/health')
if '/secure' in url:
    status = 302
    headers.append('location: https://lively-feather-51bb.cloudflareaccess.com/cdn-cgi/access/login/tunnel.kaiorderapp.com?state=TOP_SECRET_STATE')
    if scenario == 'bad_redirect': headers[-1] = 'location: https://evil.example/?state=TOP_SECRET_STATE'
    if scenario == 'svg_leak': body = '<svg>TOP_SECRET_FLAG</svg>'
    if scenario == 'secure_200': status = 200
if '/api/rate-test' in url:
    count = sum('/api/rate-test' in a[-1] for a in previous)
    if scenario != 'no_limit' and 2 <= count <= 2: status = 429
    if scenario == 'baseline_429' and count == 0: status = 429
    if scenario == 'bad_burst' and count == 1: status = 503
    if scenario == 'recovery_429' and count >= 2: status = 429
if '--resolve' in args:
    assert args[args.index('--resolve')+1] == 'demo.kaiorderapp.com:443:8.8.8.8'
    status, rc, connected = 0, 28, '0.000000'
    if scenario == 'tls_error': rc = 60
    if scenario == 'refused': rc = 7
    if scenario == 'body_timeout': connected = '0.010000'
    if scenario == 'direct_open': status, rc, connected = 200, 0, '0.010000'
if scenario == 'bad_json': body = 'TOP_SECRET_MALFORMED'
if scenario == 'transport_error': rc = 6
pathlib.Path(args[args.index('--dump-header')+1]).write_text('HTTP/2 %s\r\n'%status+'\r\n'.join(headers)+'\r\n\r\n')
pathlib.Path(args[args.index('--output')+1]).write_text(body)
print('%03d %s'%(status,connected), end='')
print('TOP_SECRET_ERROR',file=sys.stderr)
sys.exit(rc)
'''


class DemoHelperTests(unittest.TestCase):
    def run_mode(self, mode, scenario='', origin='8.8.8.8'):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / 'curl').write_text(FAKE_CURL)
            (p / 'curl').chmod(0o755)
            (p / 'sleep').write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$DEMO_SLEEP"\n')
            (p / 'sleep').chmod(0o755)
            env = dict(os.environ, PATH=d+os.pathsep+os.environ['PATH'],
                       SCENARIO=scenario, ORIGIN_IP=origin, DEMO_LOG=str(p/'requests'),
                       DEMO_SLEEP=str(p/'sleeps'), SSLKEYLOGFILE=str(p/'tls-secrets'), TMPDIR=d)
            result = subprocess.run(['bash', str(ROOT/'kaiorderapp-demo.sh'), mode], env=env,
                                    capture_output=True, text=True, timeout=15)
            self.assertNotIn('TOP_SECRET', result.stdout + result.stderr)
            self.assertFalse(list(p.glob('kaiorderapp-demo.*')), 'raw response temp files remain')
            requests = [json.loads(x) for x in (p/'requests').read_text().splitlines()] if (p/'requests').exists() else []
            sleeps = (p/'sleeps').read_text().splitlines() if (p/'sleeps').exists() else []
            return result, requests, sleeps

    def test_all_seven_modes(self):
        for mode in ('proxy', 'direct', 'rate', 'tunnel', 'access', 'private', 'preflight'):
            with self.subTest(mode=mode):
                result, _, _ = self.run_mode(mode)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_rate_stops_on_first_429_then_health_wait_recovery(self):
        result, calls, sleeps = self.run_mode('rate')
        self.assertEqual(result.returncode, 0)
        self.assertEqual([a[-1].split('.com')[1] for a in calls],
                         ['/api/rate-test']*3 + ['/api/health', '/api/rate-test'])
        self.assertEqual(sleeps, ['0.2', '20'])

    def test_no_limit_caps_burst_at_30_and_fails(self):
        result, calls, sleeps = self.run_mode('rate', 'no_limit')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 31)  # baseline + 30 burst
        self.assertNotIn('20', sleeps)

    def test_rate_unexpected_results_fail(self):
        for scenario, count in [('baseline_429', 1), ('bad_burst', 2), ('recovery_429', 5)]:
            with self.subTest(scenario=scenario):
                result, calls, _ = self.run_mode('rate', scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(calls), count)

    def test_redirect_and_flag_boundary(self):
        for scenario in ('bad_redirect', 'svg_leak', 'secure_200'):
            with self.subTest(scenario=scenario):
                result, calls, _ = self.run_mode('private', scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(calls), 1)

    def test_direct_rejects_false_positive_results(self):
        for scenario in ('tls_error', 'refused', 'body_timeout', 'direct_open'):
            with self.subTest(scenario=scenario):
                result, _, _ = self.run_mode('direct', scenario)
                self.assertNotEqual(result.returncode, 0)

    def test_invalid_or_missing_origin_makes_no_requests(self):
        for origin in ('', '127.0.0.1', 'not-an-ip', '8.8.8.8\nSECRET'):
            result, calls, _ = self.run_mode('preflight', origin=origin)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])

    def test_bad_body_and_transport_fail_without_leaking(self):
        for scenario in ('bad_json', 'transport_error'):
            result, calls, _ = self.run_mode('proxy', scenario)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(len(calls), 1)

    def test_preflight_does_not_burst(self):
        result, calls, sleeps = self.run_mode('preflight')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(sum('/api/rate-test' in a[-1] for a in calls), 1)
        self.assertEqual(sleeps, [])

    def test_help_and_invalid_mode_do_not_request(self):
        for mode, expected in [('--help', 0), ('unknown', 2)]:
            result, calls, _ = self.run_mode(mode)
            self.assertEqual(result.returncode, expected)
            self.assertEqual(calls, [])

if __name__ == '__main__':
    unittest.main()
