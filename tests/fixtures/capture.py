#!/usr/bin/env python3
"""Recapture the Ship rate app's fixtures: run GitHubChangeRequestThroughput live with the exact
arguments the page computes today, for both default repositories and every time box, and write the
whole envelopes to envelopes.json with the instant the page's clock is pinned to in captured-at.json.
Env: APPLIANCE (default http://127.0.0.1:11043) and EMBABEL_TOKEN (a Bearer token) or EMBABEL_AUTH
(the full Authorization header value)."""
import json, os, sys, datetime, urllib.request, time
BASE = os.environ.get('APPLIANCE', 'http://127.0.0.1:11043')
AUTH = os.environ.get('EMBABEL_AUTH') or ('Bearer ' + os.environ['EMBABEL_TOKEN'] if os.environ.get('EMBABEL_TOKEN') else sys.exit('set EMBABEL_TOKEN or EMBABEL_AUTH'))
HERE = os.path.dirname(os.path.abspath(__file__))
REPOS = ['embabel/embabel-agent', 'embabel/embabel-agent-examples']   # two public repositories; the page's default is the first
N = {'week': 12, 'month': 12, 'quarter': 6, 'year': 1}          # the page's PERIODS[*].n
now = datetime.datetime.now(datetime.timezone.utc)
def start(period, d):
    if period == 'week': x = d.date() - datetime.timedelta(days=d.weekday()); return datetime.datetime(x.year, x.month, x.day, tzinfo=datetime.timezone.utc)
    if period == 'month': return d.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if period == 'quarter': return d.replace(month=3 * ((d.month - 1) // 3) + 1, day=1, hour=0, minute=0, second=0, microsecond=0)
    return d.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
def step(period, d, k):
    if period == 'week': return d + datetime.timedelta(days=7 * k)
    if period == 'month': m = d.month - 1 + k; return d.replace(year=d.year + m // 12, month=m % 12 + 1)
    if period == 'quarter': m = d.month - 1 + 3 * k; return d.replace(year=d.year + m // 12, month=m % 12 + 1)
    return d.replace(year=d.year + k)
fx = {}
for repo in REPOS:
    for period in N:
        args = {'repo': repo, 'period': period, 'since': step(period, start(period, now), -N[period]).strftime('%Y-%m-%dT%H:%M:%SZ'), 'until': ''}
        req = urllib.request.Request(f'{BASE}/api/v1/views/GitHubChangeRequestThroughput/invoke', data=json.dumps({'args': args}).encode(), headers={'Content-Type': 'application/json', 'Authorization': AUTH})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=900) as r: env = json.loads(r.read().decode())
        fx['view:GitHubChangeRequestThroughput:' + json.dumps(dict(sorted(args.items())), separators=(',', ':'))] = env
        m = env.get('metrics') or {}
        print(f"{repo} {period} since {args['since']}: {env.get('status')} {len(env.get('data') or [])} rows, {m.get('durationMs')} ms, {m.get('externalCalls')} GitHub calls, {round(time.time() - t0, 1)} s wall", flush=True)
json.dump(fx, open(os.path.join(HERE, 'envelopes.json'), 'w'), indent=1)
json.dump({'capturedAt': now.strftime('%Y-%m-%dT%H:%M:%SZ')}, open(os.path.join(HERE, 'captured-at.json'), 'w'))
print('captured', len(fx), 'envelopes at', now.isoformat())
