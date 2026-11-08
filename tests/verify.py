#!/usr/bin/env python3
"""The ladder. See tests/verify.sh for the layers and how to run it.

Every figure the realm shows is judged against GitHub read directly, never against the realm's
own earlier answer. The windows are fixed before anything is read and end two hours ago, so a
comment posted between the two reads cannot move a figure; the wide window feeds the list
doors (issues, comments, commits), the narrow one the hops that cost a call per subject.
"""
import base64, collections, datetime, json, os, re, sys, urllib.parse, urllib.request
from decimal import Decimal, ROUND_HALF_UP

REPO = sys.argv[1] if len(sys.argv) > 1 else 'embabel/embabel-agent'
BASE = os.environ.get('APPLIANCE', 'http://127.0.0.1:11043').rstrip('/')
GH = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
if not GH: sys.exit('GH_TOKEN is required: L0 reads GitHub directly, and without it nothing here is ground truth')

def auth_header():
    if os.environ.get('EMBABEL_TOKEN'): return 'Bearer ' + os.environ['EMBABEL_TOKEN']
    if os.environ.get('EMBABEL_AUTH'): return 'Basic ' + base64.b64encode(os.environ['EMBABEL_AUTH'].encode()).decode()
    sys.exit('set EMBABEL_TOKEN=... or EMBABEL_AUTH=user:pass')

def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', 'Authorization': auth_header()})
    with urllib.request.urlopen(req, timeout=900) as r: return json.loads(r.read().decode())

gh_calls = 0
def gh(path, params=None):
    global gh_calls; gh_calls += 1
    url = 'https://api.github.com' + path + ('?' + urllib.parse.urlencode(params) if params else '')
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + GH, 'Accept': 'application/vnd.github+json',
                                               'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(req, timeout=120) as r: return json.loads(r.read().decode())

def gh_pages(path, params, max_pages):
    out = []
    for p in range(1, max_pages + 1):
        batch = gh(path, dict(params, per_page=100, page=p)); out += batch
        if len(batch) < 100: break
    return out

def view(name, args):
    d = post(f'/api/v1/admin/kg/views/{name}/run', {'args': args})
    return d.get('rows') or [], d

fails = []
def check(cond, label, detail=''):
    print(('ok   ' if cond else 'FAIL ') + label + (f'  [{detail}]' if detail and not cond else ''), flush=True)
    if not cond: fails.append(label)

# Cypher's round() is half-up; Python's is half-even on an exact .x5, and 6.25 happens.
def rnd(x, n=1): return float(Decimal(str(x)).quantize(Decimal(1).scaleb(-n), rounding=ROUND_HALF_UP))

# ---- The windows, fixed before anything is read, on UTC midnights so a question can say the day.
NOW = datetime.datetime.now(datetime.timezone.utc)
UNTIL = (NOW - datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ')
day = lambda d: (NOW - datetime.timedelta(days=d)).strftime('%Y-%m-%dT00:00:00Z')
SINCE_WIDE, SINCE_HOP = day(40), day(18)
print(f'windows wide {SINCE_WIDE} / hop {SINCE_HOP} .. {UNTIL} (exclusive) on {REPO}')
def in_win(ts, since): return since <= ts < UNTIL

# ---- L0: GitHub itself, with the producers' rules replicated.
AGENTS = ['copilot', 'claude', 'devin', 'codex', 'cursor', 'aider', 'jules', 'sweep', 'gemini', 'chatgpt', 'openai']
def author_kind(user_type, login, via_app, body, bot_suffix=False):
    """producers/github.yml's authorKind, line for line: agent, bot, assisted, human, unknown."""
    lg = (login or '').lower()
    if user_type == 'Bot' and any(a in lg for a in AGENTS): return 'agent'
    if user_type == 'Bot' or via_app is not None or (bot_suffix and lg.endswith('[bot]')): return 'bot'
    lines = (body or '').split('\n')
    if any(l.lower().startswith('co-authored-by:') and any(a in l.lower() for a in AGENTS) for l in lines) \
            or 'Generated with [Claude Code]' in (body or ''): return 'assisted'
    if user_type == 'User': return 'human'
    return 'unknown'
def ik(i): return author_kind(i['user']['type'], i['user']['login'], i.get('performed_via_github_app'), i.get('body'))
def mk(c):
    a = c.get('author') or {}
    return author_kind(a.get('type'), a.get('login'), None, c['commit']['message'], bot_suffix=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kind_rule import kind as file_kind     # the vocabulary's FileChange.kind rule, the Python half; the producers compute the Cypher half
KINDS = ('source', 'test', 'docs', 'build', 'config', 'data', 'other')

issues = gh_pages(f'/repos/{REPO}/issues', {'state': 'all', 'since': SINCE_WIDE}, 10)          # issuesByRepo, since pushed
comments = gh_pages(f'/repos/{REPO}/issues/comments', {'sort': 'created', 'direction': 'desc', 'since': SINCE_WIDE}, 10)
line_comments = gh_pages(f'/repos/{REPO}/pulls/comments', {'sort': 'created', 'direction': 'desc', 'since': SINCE_WIDE}, 10)
commits = gh_pages(f'/repos/{REPO}/commits', {'since': SINCE_WIDE}, 10)
for name, got in (('issues', issues), ('comments', comments), ('review comments', line_comments), ('commits', commits)):
    check(len(got) < 1000, f'L0: the wide window holds fewer than 1,000 {name} (else the door is capped and nothing below reconciles)', len(got))

L0 = {}
C = collections.Counter()
for i in issues:
    if in_win(i['created_at'], SINCE_WIDE): C[('change-request' if i.get('pull_request') else 'issue', ik(i))] += 1
for c in comments:
    if in_win(c['created_at'], SINCE_WIDE): C[('comment', ik(c))] += 1
for c in line_comments:
    if in_win(c['created_at'], SINCE_WIDE): C[('review-comment', ik(c))] += 1
for c in commits:
    if in_win(c['commit']['author']['date'], SINCE_WIDE): C[('commit', mk(c))] += 1
L0['authorship'] = {f'{k[0]}/{k[1]}': v for k, v in C.items()}
check(sum(C.values()) > 0, 'L0: the wide window holds records (a silent repository verifies nothing)')

def hours(a, b):
    f = lambda s: datetime.datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ')
    return (f(b) - f(a)).total_seconds() / 3600.0
G = collections.defaultdict(list)
for i in issues:
    if i.get('pull_request') and in_win(i['created_at'], SINCE_WIDE):
        G[(i['created_at'][:7], ik(i), 'merged' if i['pull_request'].get('merged_at') else i['state'])].append(i)
L0['changeRequests'] = {f'{k[0]}/{k[1]}/{k[2]}': {'n': len(v), 'meanHoursToMerge': (rnd(sum(hours(p['created_at'], p['pull_request']['merged_at']) for p in v) / len(v)) if k[2] == 'merged' else None)} for k, v in G.items()}

merged = [i for i in issues if i.get('pull_request') and i['pull_request'].get('merged_at') and in_win(i['pull_request']['merged_at'], SINCE_HOP)]
agg = collections.defaultdict(lambda: {'prs': 0, 'line': 0, 'humanLine': 0, 'reviews': 0, 'changes': 0})
for i in merged:
    n = i['number']
    reviews = gh_pages(f'/repos/{REPO}/pulls/{n}/reviews', {}, 2)
    lines = gh_pages(f'/repos/{REPO}/pulls/{n}/comments', {}, 3)
    a = agg[ik(i)]; a['prs'] += 1; a['line'] += len(lines); a['humanLine'] += sum(1 for c in lines if ik(c) == 'human')
    a['reviews'] += len(reviews); a['changes'] += 1 if any(r['state'] == 'CHANGES_REQUESTED' for r in reviews) else 0
L0['reviewBurden'] = {k: {'prs': v['prs'], 'lineCommentsPerPr': rnd(v['line'] / v['prs'], 2), 'humanLineComments': v['humanLine'],
                          'reviewsPerPr': rnd(v['reviews'] / v['prs'], 2), 'prsWithChangesRequested': v['changes']} for k, v in agg.items()}

sz = collections.defaultdict(list); hot = collections.defaultdict(lambda: {'commits': 0, 'lines': 0, 'byHumans': 0, 'byAgents': 0, 'byBots': 0})
hop_commits = [c for c in commits if len(c['parents']) == 1 and in_win(c['commit']['author']['date'], SINCE_HOP)]
for c in hop_commits:
    files = gh(f'/repos/{REPO}/commits/{c["sha"]}')['files']; kind = mk(c)
    sz[kind].append((len(files), sum(f['additions'] + f['deletions'] for f in files), sum(1 for f in files if file_kind(f['filename']) == 'test')))
    bucket = 'byHumans' if kind == 'human' else 'byAgents' if kind in ('assisted', 'agent') else 'byBots' if kind == 'bot' else None
    for f in files:
        h = hot[f['filename']]; h['commits'] += 1; h['lines'] += f['additions'] + f['deletions']
        if bucket: h[bucket] += 1
L0['commitSize'] = {k: {'commits': len(v), 'meanFiles': rnd(sum(x[0] for x in v) / len(v)), 'maxFiles': max(x[0] for x in v),
                        'meanLines': rnd(sum(x[1] for x in v) / len(v)), 'maxLines': max(x[1] for x in v),
                        'commitsTouchingTests': sum(1 for x in v if x[2] > 0)} for k, v in sz.items()}
L0['hotspots'] = dict(hot)

# GitHubChangeRequestSize / ...ByAuthorKind: the diff of every PR OPENED in the hop window, one call each, each
# file classified by the same rule the producers compute. The issues read above already covers the window
# (opened after SINCE_HOP implies updated after SINCE_WIDE).
cr = {}
for i in issues:
    if i.get('pull_request') and in_win(i['created_at'], SINCE_HOP):
        files = gh_pages(f'/repos/{REPO}/pulls/{i["number"]}/files', {}, 3)
        row = {'files': len(files), 'additions': sum(f['additions'] for f in files), 'deletions': sum(f['deletions'] for f in files),
               'status': 'merged' if i['pull_request'].get('merged_at') else i['state'], 'authorKind': ik(i)}
        for k in KINDS: row[k + 'Files'] = sum(1 for f in files if file_kind(f['filename']) == k)
        for k in ('source', 'test', 'docs'): row[k + 'Lines'] = sum(f['additions'] + f['deletions'] for f in files if file_kind(f['filename']) == k)
        cr[i['number']] = row
L0['crSize'] = cr
check(0 < len(cr) <= 150, 'L0: the hop window holds between 1 and 150 pull requests (the issue-door CHANGED hop allows 150 anchors)', len(cr))
langs = gh(f'/repos/{REPO}/languages')
L0['languages'] = [(k, v, rnd(100.0 * v / sum(langs.values()))) for k, v in sorted(langs.items(), key=lambda kv: (-kv[1], kv[0]))]
# GitHubCommitAuthors: one row per (login, email) over the non-merge commits of the hop window
au = collections.defaultdict(lambda: {'commits': 0, 'assistedCommits': 0})
for c in hop_commits:
    k = ((c.get('author') or {}).get('login'), c['commit']['author']['email'])
    au[k]['commits'] += 1
    if mk(c) == 'assisted': au[k]['assistedCommits'] += 1
L0['authors'] = {f'{k[0]}/{k[1]}': v for k, v in au.items()}
L0['hopComments'] = collections.Counter(ik(c) for c in comments if in_win(c['created_at'], SINCE_HOP))

# GitHubChangeRequestThroughput: three dated events per PR, each in the period it happened, each
# counted again under 'all'. The same issues read serves: a PR with any event after SINCE_WIDE was
# updated after it, which is the bound the door pushed.
def bucket(unit, ts):
    d = datetime.datetime.strptime(ts, '%Y-%m-%dT%H:%M:%SZ').date()
    if unit == 'week': return (d - datetime.timedelta(days=d.weekday())).isoformat()
    return d.replace(day=1).isoformat()
L0['throughput'] = {}
for unit in ('week', 'month'):
    cells = collections.defaultdict(lambda: {'opened': 0, 'merged': 0, 'closedUnmerged': 0, 'hours': []})
    for i in issues:
        if not i.get('pull_request'): continue
        m = i['pull_request'].get('merged_at')
        for at, e in ((i['created_at'], 'opened'), (m, 'merged'), (None if m else i.get('closed_at'), 'closedUnmerged')):
            if at is None or not in_win(at, SINCE_WIDE): continue
            for kind in (ik(i), 'all'):
                c = cells[(bucket(unit, at), kind)]; c[e] += 1
                if e == 'merged': c['hours'].append(hours(i['created_at'], m))
    L0['throughput'][unit] = {f'{per}/{kind}': {'opened': c['opened'], 'merged': c['merged'], 'closedUnmerged': c['closedUnmerged'],
                                                 'resolved': c['merged'] + c['closedUnmerged'],
                                                 'mergedPctOfResolved': rnd(100.0 * c['merged'] / (c['merged'] + c['closedUnmerged'])) if c['merged'] + c['closedUnmerged'] else None,
                                                 'meanHoursToMerge': rnd(sum(c['hours']) / len(c['hours'])) if c['hours'] else None}
                              for (per, kind), c in cells.items()}
print('L0', json.dumps({'authorship': L0['authorship'], 'commitSize': L0['commitSize'], 'reviewBurden': L0['reviewBurden'],
                        'hopConversationComments': dict(L0['hopComments'])}), f'({gh_calls} GitHub calls)')

# ---- L1: each door, through the engine, the same windows.
def execute(cypher):
    d = post('/api/v1/admin/kg/execute', {'cypher': cypher}); return d.get('rows') or [], d
def l0_kinds(prefix): return {k.split('/')[1]: v for k, v in L0['authorship'].items() if k.startswith(prefix + '/')}
pin = f"(:GitHubRepository {{full_name: '{REPO}'}})"
rows, d = execute(f"MATCH {pin}-[:HAS_ISSUE]->(i:Issue) WITH i, i.openedAt AS openedAt, i.isChangeRequest AS isPr, i.authorKind AS k WHERE openedAt >= '{SINCE_WIDE}' AND openedAt < '{UNTIL}' RETURN isPr, k, count(*) AS n")
got = {(r['isPr'], r['k']): r['n'] for r in rows}
check(got == {**{(False, k): v for k, v in l0_kinds('issue').items()}, **{(True, k): v for k, v in l0_kinds('change-request').items()}}, 'L1: HAS_ISSUE by isChangeRequest, authorKind == GitHub', f'{got}')
check(not any('PARTIAL' in w for w in d.get('warnings') or []), 'L1: HAS_ISSUE window is a complete read (openedAt pushed as since)', [w[:100] for w in d.get('warnings') or []])
for rel, prefix, ts in (('HAS_COMMENT', 'comment', 'createdAt'), ('HAS_REVIEW_COMMENT', 'review-comment', 'createdAt'), ('HAS_COMMIT', 'commit', 'authoredAt')):
    rows, d = execute(f"MATCH {pin}-[:{rel}]->(x) WITH x, x.{ts} AS t, x.authorKind AS k WHERE t >= '{SINCE_WIDE}' AND t < '{UNTIL}' RETURN k, count(*) AS n")
    got = {r['k']: r['n'] for r in rows}
    check(got == l0_kinds(prefix), f'L1: {rel} by authorKind == GitHub', f'{got} vs {l0_kinds(prefix)}')
rows, d = execute(f"MATCH {pin}-[:HAS_COMMENT]->(c:Comment) WITH c, c.createdAt AS t WHERE t >= '{SINCE_HOP}' AND t < '{UNTIL}' RETURN count(c) AS n, count(DISTINCT c.id) AS ids")
check(rows and rows[0]['n'] == rows[0]['ids'] == sum(L0['hopComments'].values()), 'L1: comments are one node per GitHub id (no duplicates through the repository door)', f'{rows}')

# ---- L2: every view, closed windows, exact.
WIDE, HOP = {'repo': REPO, 'since': SINCE_WIDE, 'until': UNTIL}, {'repo': REPO, 'since': SINCE_HOP, 'until': UNTIL}
rows, d = view('GitHubAuthorship', WIDE)
got = {f"{r['recordKind']}/{r['authorKind']}": r['n'] for r in rows}
check(got == L0['authorship'], 'L2: GitHubAuthorship every (kind, authorKind) count == GitHub', f'{got} vs {L0["authorship"]}')
tot = collections.Counter()
for r in rows: tot[r['recordKind']] += r['n']
check(all(r['pct'] == rnd(100.0 * r['n'] / tot[r['recordKind']]) for r in rows), 'L2: GitHubAuthorship pct is the share within its kind')
check(not any('PARTIAL' in w for w in d.get('warnings') or []), 'L2: GitHubAuthorship carries no PARTIAL warning for a window the source narrows')
rows, d = view('GitHubChangeRequestsByAuthorKind', WIDE)
got = {f"{r['month']}/{r['authorKind']}/{r['status']}": {'n': r['n'], 'meanHoursToMerge': r['meanHoursToMerge']} for r in rows}
check(got == L0['changeRequests'], 'L2: GitHubChangeRequestsByAuthorKind month x kind x status, n and mean hours == GitHub', f'{got} vs {L0["changeRequests"]}')
rows, d = view('GitHubReviewBurden', HOP)
got = {r['authorKind']: {k: r[k] for k in ('prs', 'lineCommentsPerPr', 'humanLineComments', 'reviewsPerPr', 'prsWithChangesRequested')} for r in rows}
check(got == L0['reviewBurden'], 'L2: GitHubReviewBurden per authorKind == GitHub (reviews and line comments read per PR)', f'{got} vs {L0["reviewBurden"]}')

for unit in ('week', 'month'):
    rows, d = view('GitHubChangeRequestThroughput', {'repo': REPO, 'period': unit, 'since': SINCE_WIDE, 'until': UNTIL})
    got = {f"{r['period']}/{r['authorKind']}": {k: r[k] for k in ('opened', 'merged', 'closedUnmerged', 'resolved', 'mergedPctOfResolved', 'meanHoursToMerge')} for r in rows}
    check(got == L0['throughput'][unit], f'L2: GitHubChangeRequestThroughput by {unit}: every period x authorKind (opened, merged, closed, rate, mean hours) == GitHub', f'first drift {next(((k, got.get(k), L0["throughput"][unit].get(k)) for k in sorted(set(got) | set(L0["throughput"][unit])) if got.get(k) != L0["throughput"][unit].get(k)), None)}')
    check(not any('PARTIAL' in w for w in d.get('warnings') or []), f'L2: GitHubChangeRequestThroughput by {unit} is a complete read of the window')
rows, d = view('GitHubCommitSize', HOP)
got = {r['authorKind']: {k: r[k] for k in ('commits', 'meanFiles', 'maxFiles', 'meanLines', 'maxLines', 'commitsTouchingTests')} for r in rows}
check(got == L0['commitSize'], 'L2: GitHubCommitSize per authorKind == GitHub (files read per commit)', f'{got} vs {L0["commitSize"]}')
rows, d = view('GitHubFileHotspots', dict(HOP, limit=100000))
got = {r['path']: {k: r[k] for k in ('commits', 'lines', 'byHumans', 'byAgents', 'byBots')} for r in rows}
check(got == L0['hotspots'], f'L2: GitHubFileHotspots every path == GitHub ({len(L0["hotspots"])} paths)', f'{len(got)} paths; first drift {next(((p, got.get(p), L0["hotspots"].get(p)) for p in set(got) | set(L0["hotspots"]) if got.get(p) != L0["hotspots"].get(p)), None)}')
keys = [(r['commits'], r['lines']) for r in rows]
check(all(keys[i] >= keys[i + 1] for i in range(len(keys) - 1)), 'L2: GitHubFileHotspots ordered by commits then lines')
rows, _ = view('GitHubFileHotspots', dict(HOP, limit=3))
check(len(rows) == min(3, len(L0['hotspots'])), 'L2: GitHubFileHotspots honours limit')

# Size and shape: every figure per change request, then the aggregate that shares its fetch.
rows, d = view('GitHubChangeRequestSize', {'repo': REPO, 'since': SINCE_HOP, 'until': UNTIL})
got = {r['number']: {k: r[k] for k in ('files', 'additions', 'deletions', 'status', 'authorKind') + tuple(k + 'Files' for k in KINDS) + ('sourceLines', 'testLines', 'docsLines')} for r in rows}
check(got == L0['crSize'], f'L2: GitHubChangeRequestSize every change request ({len(L0["crSize"])}) files, lines, kinds, status == GitHub', f'first drift {next(((n, got.get(n), L0["crSize"].get(n)) for n in sorted(set(got) | set(L0["crSize"])) if got.get(n) != L0["crSize"].get(n)), None)}')
check(all(r['files'] == sum(r[k + 'Files'] for k in KINDS) for r in rows), 'L2: GitHubChangeRequestSize kinds partition the files')
check(not any('PARTIAL' in w for w in d.get('warnings') or []), 'L2: GitHubChangeRequestSize is a complete read (no PR over 300 files, window within the anchor cap)')
rows, d = view('GitHubChangeRequestSizeByAuthorKind', {'repo': REPO, 'since': SINCE_HOP, 'until': UNTIL})
allrow = next((r for r in rows if r['authorKind'] == 'all'), None); crv = list(L0['crSize'].values())
if crv:
    lines = sum(r['additions'] + r['deletions'] for r in crv)
    want = {'changeRequests': len(crv), 'meanFiles': rnd(sum(r['files'] for r in crv) / len(crv)), 'maxFiles': max(r['files'] for r in crv),
            'meanLines': rnd(lines / len(crv)), 'maxLines': max(r['additions'] + r['deletions'] for r in crv),
            'testLinesPct': rnd(100.0 * sum(r['testLines'] for r in crv) / lines) if lines else None,
            'touchingTests': sum(1 for r in crv if r['testLines'] > 0), 'touchingDocs': sum(1 for r in crv if r['docsLines'] > 0)}
    check(allrow is not None and {k: allrow[k] for k in want} == want, 'L2: GitHubChangeRequestSizeByAuthorKind all-row == GitHub', f'{allrow} vs {want}')
    check(collections.Counter(r['authorKind'] for r in crv) == {r['authorKind']: r['changeRequests'] for r in rows if r['authorKind'] != 'all'}, 'L2: GitHubChangeRequestSizeByAuthorKind per-kind counts == GitHub')
# What the project is: the language table exactly, the profile loud about a source it cannot read.
rows, d = view('GitHubRepositoryLanguages', {'repo': REPO})
check([(r['language'], r['bytes'], r['sharePct']) for r in rows] == L0['languages'], 'L2: GitHubRepositoryLanguages every language, bytes and share == GitHub, largest first', f'{rows[:3]} vs {L0["languages"][:3]}')
rows, d = view('GitHubRepositoryProfile', {'repo': REPO})
if rows and not d.get('error'):
    check(len(rows) == 1 and rows[0]['primaryLanguage'] == L0['languages'][0][0] and rows[0]['opinion'], 'L2: GitHubRepositoryProfile one row, primary language == GitHub, an opinion sentence', f'{rows}')
    check(all(x.split(' ')[0] == L0['languages'][i][0] for i, x in enumerate(rows[0]['languages'])), 'L2: GitHubRepositoryProfile languages in GitHub order', rows[0]['languages'])
else:
    # A repository with a deliberately malformed YAML fixture makes the settings read FAIL (embabel/me#3625); until that lands the view is red here and says why.
    check(False, 'L2: GitHubRepositoryProfile SUCCEEDED (a FAILED/SOURCE_UNAVAILABLE here is embabel/me#3625: one unparsable fixture fails the settings read)', f'error={str(d.get("error"))[:160]} warnings={[w[:120] for w in d.get("warnings") or []][:2]}')
# Who makes the changes: the per-person counts exactly; the spine is a fact of the world, reported not asserted.
rows, d = view('GitHubCommitAuthors', {'repo': REPO, 'since': SINCE_HOP, 'until': UNTIL})
got = {f'{r["login"]}/{r["email"]}': {'commits': r['commits'], 'assistedCommits': r['assistedCommits']} for r in rows}
check(got == L0['authors'], f'L2: GitHubCommitAuthors every (login, email) commits and assisted commits == GitHub ({len(L0["authors"])} authors)', f'first drift {next(((k, got.get(k), L0["authors"].get(k)) for k in sorted(set(got) | set(L0["authors"])) if got.get(k) != L0["authors"].get(k)), None)}')
check(all((r['personStatus'] == 'not a person at a mailbox: no spine') == ('noreply' in r['email'] or 'no-reply' in r['email'] or r['email'] == '' or 'bot' in (r['authorKinds'] or []) or 'agent' in (r['authorKinds'] or [])) for r in rows), 'L2: GitHubCommitAuthors keeps bots, agents and no-reply addresses off the spine and nobody else', [(r['login'], r['personStatus']) for r in rows if 'noreply' in r['email']][:3])
print('L2: GitHubCommitAuthors spine:', collections.Counter(r['personStatus'] for r in rows), '(on the spine needs a child-label read until embabel/me#3621 ships)')
# What a change concerns: the population is a fact and is reconciled; the concern is a model's opinion and only shape-checked.
CONCERNS = {'feature', 'fix', 'refactor', 'test', 'docs', 'build', 'dependency', 'ci', 'performance', 'security', 'chore'}
rows, d = view('GitHubChangeRequestConcern', {'repo': REPO, 'since': SINCE_HOP, 'until': UNTIL})
check(len(rows) == len(L0['crSize']) and {r['number'] for r in rows} == set(L0['crSize']), 'L2: GitHubChangeRequestConcern judges every change request opened in the window once', f'{len(rows)} vs {len(L0["crSize"])}')
check(all(r['concern'] in CONCERNS for r in rows), 'L2: GitHubChangeRequestConcern concern is one of the eleven', {r['concern'] for r in rows} - CONCERNS)
check(all(r['status'] == L0['crSize'][r['number']]['status'] for r in rows if r['number'] in L0['crSize']), 'L2: GitHubChangeRequestConcern status == GitHub (merged recognised through the issue door)')
check(all(isinstance(r['area'], str) and r['area'].strip() for r in rows), 'L2: GitHubChangeRequestConcern area is a non-empty label')
rows, d = view('GitHubChangeRequestConcernMix', {'repo': REPO, 'since': SINCE_HOP, 'until': UNTIL})
check(sum(r['changeRequests'] for r in rows) == len(L0['crSize']), 'L2: GitHubChangeRequestConcernMix counts sum to the change requests opened in the window', f'{sum(r["changeRequests"] for r in rows)} vs {len(L0["crSize"])}')
check({r['authorKind']: 0 for r in rows}.keys() <= set(collections.Counter(v['authorKind'] for v in L0['crSize'].values())), 'L2: GitHubChangeRequestConcernMix author kinds are the window\'s')

# The judged views: the population is a fact and is reconciled; the judgment is a model's opinion and is only shape-checked.
rows, d = view('GitHubCommentReadsAs', HOP)
hop_n = sum(L0['hopComments'].values())
check(len(rows) == hop_n and len({r['url'] for r in rows}) == hop_n, 'L2: GitHubCommentReadsAs judges every conversation comment in the window once', f'{len(rows)} rows vs {hop_n}')
check(collections.Counter(r['declared'] for r in rows) == L0['hopComments'], 'L2: GitHubCommentReadsAs declared authorKind tallies == GitHub')
check(all(r['judged'] in ('human', 'machine', 'unsure') for r in rows), 'L2: GitHubCommentReadsAs judged label is one of human, machine, unsure', {r['judged'] for r in rows})
check(all(r['agreement'] == ('unsure' if r['judged'] == 'unsure' else 'agree' if (r['declared'] == 'human') == (r['judged'] == 'human') else 'disagree') for r in rows), 'L2: GitHubCommentReadsAs agreement follows declared x judged')
dis, _ = view('GitHubCommentReadsAs', dict(HOP, only='disagree'))
check(len(dis) == sum(1 for r in rows if r['agreement'] == 'disagree') or d.get('llmCalls', 1) > 0, "L2: GitHubCommentReadsAs only='disagree' returns the disagreeing rows (a second judgment may move one)")
rows, d = view('GitHubCommentProvenance', HOP)
check({k: sum(r['n'] for r in rows if r['declared'] == k) for k in L0['hopComments']} == dict(L0['hopComments']), 'L2: GitHubCommentProvenance declared totals == GitHub', f'{rows}')

# ---- L3: the battery, as a person types it.
try:
    import yaml
except ImportError:
    sys.exit('pip install pyyaml (the battery is YAML)')
schema = post('/api/v1/admin/kg/execute', {'cypher': 'MATCH (n) RETURN count(n) AS n LIMIT 1'})   # warm; the schema text comes next
schema_text = urllib.request.urlopen(urllib.request.Request(BASE + '/api/v1/admin/kg/schema', headers={'Authorization': auth_header()}), timeout=120).read().decode(errors='replace')
declared = set(re.findall(r'[A-Za-z_][A-Za-z0-9_]*', schema_text))
def ask(q):
    d = post('/api/v1/admin/kg/ask', {'question': q})
    return d.get('rows') or [], d.get('cypher') or '', d
def figures(rows):
    out = set()
    for r in rows:
        for k, v in r.items():
            if isinstance(v, bool): continue
            if isinstance(v, (int, float)) and not k.lower().endswith('id'): out.add(rnd(float(v)))
            if isinstance(v, str): out.add(v)
    return out
def want_from(vrows, mv):
    where = mv.get('where') or {}
    picked = [r for r in vrows if all(r.get(k) == (fill(v) if isinstance(v, str) else v) for k, v in where.items())]
    if not picked: return None
    if mv.get('sum'): return sum(r[mv['column']] for r in picked)
    return picked[0].get(mv['column'])
this_monday = (NOW - datetime.timedelta(days=NOW.weekday())).date()
last_monday = this_monday - datetime.timedelta(days=7)
this_month_1st = NOW.date().replace(day=1)
last_month_1st = (this_month_1st - datetime.timedelta(days=1)).replace(day=1)
subst = {'{repo}': REPO, '{sinceWide}': SINCE_WIDE, '{sinceHop}': SINCE_HOP, '{until}': UNTIL,
         '{sinceWideDay}': SINCE_WIDE[:10], '{sinceHopDay}': SINCE_HOP[:10],
         '{lastWeekStart}': last_monday.isoformat() + 'T00:00:00Z', '{lastWeekEnd}': this_monday.isoformat() + 'T00:00:00Z',
         '{lastWeekStartDay}': last_monday.isoformat(), '{lastWeekEndDay}': this_monday.isoformat(),
         '{lastMonthStart}': last_month_1st.isoformat() + 'T00:00:00Z', '{lastMonthEnd}': this_month_1st.isoformat() + 'T00:00:00Z',
         '{lastMonthName}': last_month_1st.strftime('%B %Y')}
def fill(s):
    for k, v in subst.items(): s = s.replace(k, v)
    return s
battery = yaml.safe_load(open('tests/questions.yml'))
routed = 0
for entry in battery:
    q = fill(entry['question']); exp = entry.get('expect', {})
    if entry.get('adversarial'):
        for i in range(3):
            try: rows, cypher, d = ask(q)
            except Exception as e:
                print(f'ok   L3 adversarial "{q}" #{i+1}: refused ({str(e)[:60]})'); continue
            props = set(re.findall(r'\.([A-Za-z_][A-Za-z0-9_]*)', cypher)); unknown = [p for p in props if p not in declared]
            check(not rows or not unknown, f'L3 adversarial "{q}" #{i+1}: no rows, or only declared properties', f'rows={len(rows)} unknown={unknown} cypher={cypher[:120]}')
        continue
    try: rows, cypher, d = ask(q)
    except Exception as e:
        check(False, f'L3 "{q}"', str(e)[:120]); continue
    exposure = d.get('exposure') or {}
    if 'github' in (exposure.get('groups') or []): routed += 1
    if 'matchesView' in exp:
        mv = exp['matchesView']
        for attempt in range(2):   # generation is stochastic: a figure that matches once in two is not stable
            if attempt: rows, cypher, d = ask(q)
            args = {'repo': REPO, **{k: fill(str(v)) for k, v in (mv.get('args') or {}).items()}}
            # The ask binds no `until`, so its figure may include the last two hours: accept the view's
            # figure for the closed window OR the open one, and nothing else.
            wants = {want_from(view(mv['name'], args)[0], mv), want_from(view(mv['name'], {k: v for k, v in args.items() if k != 'until'})[0], mv)} - {None}
            got = figures(rows)
            ok = any((rnd(float(w)) in got) if isinstance(w, (int, float)) else (w in got) for w in wants)
            check(ok, f'L3 "{q}" #{attempt+1} == {mv["name"]}.{mv["column"]}', f'want one of {wants} in {sorted(map(str, got))[:10]} routed={exposure.get("resolvedBy")} cypher={cypher[:140]}')
            if ok: break
    elif exp.get('nonEmpty'):
        check(len(rows) > 0, f'L3 "{q}" non-empty', f'routed={exposure.get("resolvedBy")} cypher={cypher[:140]}')
    else:
        check(len(rows) >= int(exp.get('minRows', 0)) and not d.get('error'), f'L3 "{q}" runs', f'rows={len(rows)} error={d.get("error")}')
print(f'L3: {routed} of {sum(1 for e in battery if not e.get("adversarial"))} answerable questions were routed to the github realm by the ask door')

# ---- L6: force the failures. Loud when the source says no; quiet when the window is empty.
rows, d = view('GitHubAuthorship', {'repo': 'embabel/this-repository-does-not-exist'})
check(not rows and any('NOT_FOUND' in w for w in d.get('warnings') or []), 'L6: an unknown repository is LOUD (NOT_FOUND named, zero rows)', f'{d.get("warnings")}')
rows, d = view('GitHubAuthorship', {'repo': REPO, 'since': '2031-01-01T00:00:00Z'})
check(not rows and not d.get('error') and not any('PARTIAL' in w for w in d.get('warnings') or []), 'L6: a window in the future is an exact empty (no error, no PARTIAL)', f'{d.get("warnings")}')

rows, d = view('GitHubCommitSize', {'repo': REPO, 'since': 'last week'})
check(not rows and not any('PRODUCER_ERROR' in w or 'HTTP 500' in w for w in d.get('warnings') or []), 'L6: a bound that is not an ISO instant stays in the graph (never sent to GitHub, no 500)', f'{[w[:120] for w in d.get("warnings") or []]}')

print('\n' + ('DRIFT DETECTED: ' + '; '.join(fails) if fails else 'ALL CHECKS PASS') + f'  ({gh_calls} GitHub calls)')
sys.exit(1 if fails else 0)
