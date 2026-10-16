#!/usr/bin/env python3
"""End-to-end test of bsTimer server sync between two "devices" in Safari.

http://localhost:8080 and http://localhost:8081 (forwarded to the same server) are different origins, so they have
separate csTimer data and sync state while talking to the same sync.php.
Needs: the site served on port 8080 with a config that sets syncServer: 'sync.php'
(and a throwaway sync database), and `safaridriver -p 4444` running.
"""
import json
import sys
import time
import urllib.request

A = 'http://localhost:8080/'
B = 'http://localhost:8081/'
WD = 'http://localhost:4444'
N_SOLVES = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
failures = 0


def wd(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(WD + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read() or b'{}').get('value')
    except urllib.error.HTTPError as e:
        return {'error': json.loads(e.read() or b'{}').get('value')}


def check(name, cond, detail=''):
    global failures
    print(('ok - ' if cond else 'not ok - ') + name + ('' if cond else '  ' + str(detail)[:400]))
    if not cond:
        failures += 1


sid = wd('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'safari'}}})['sessionId']
S = '/session/' + sid
js = lambda s, *a: wd('POST', S + '/execute/sync', {'script': s, 'args': list(a)})
js_async = lambda s, *a: wd('POST', S + '/execute/async', {'script': 'var done = arguments[arguments.length - 1]; setTimeout(function(){ done(JSON.stringify({status: "test-timeout"})); }, 120000); try {' + s + '} catch (e) { done(JSON.stringify({status: "throw", error: String(e)})); }', 'args': list(a)})


def goto(url):
    wd('POST', S + '/url', {'url': url})
    return wait_ready()


def wait_ready(timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        if js('return !!(window.bsSync && window.kernel && window.storage && document.readyState === "complete")') is True:
            time.sleep(1.5)
            return True
        time.sleep(0.5)
    return False


def reset():
    js_async('''localStorage.clear();
var n = 0; function one(){ if (++n == 2) done(1); }
var a = indexedDB.deleteDatabase("bstimer-sync"); a.onsuccess = a.onerror = a.onblocked = one;
var b = indexedDB.deleteDatabase("cstimer"); b.onsuccess = b.onerror = b.onblocked = one;''')
    wd('POST', S + '/refresh', {})
    return wait_ready()


def load_data(sessions):
    """sessions: list of (name, number of solves, timestamp base). Replaces csTimer's data."""
    js_async('''
var spec = arguments[0], obj = {}, data = {};
spec.forEach(function(s, i) {
  var solves = [];
  for (var k = 0; k < s[1]; k++) solves.push([[k % 50 == 0 ? 2000 : 0, 8000 + (k * 37) % 9000], "R U R' U' F" + (k % 7) + " L" + k, k % 100 == 0 ? "c" + k : "", s[2] + k]);
  obj["session" + (i + 1)] = solves;
  data[i + 1] = {name: s[0], opt: {}, rank: i + 1};
});
kernel.setProp("sessionN", spec.length);
kernel.setProp("sessionData", JSON.stringify(data));
storage.importAll(obj).then(function(){ done(1); });''', sessions)
    wd('POST', S + '/refresh', {})
    return wait_ready()


def all_solves():
    return js_async('''
var d = JSON.parse(kernel.getProp("sessionData")), n = ~~kernel.getProp("sessionN");
storage.exportAll().then(function(o){
  var out = {};
  for (var i = 1; i <= n; i++) out[d[i].name] = o["session" + i] || [];
  done(JSON.stringify(out));
});''')


def open_export():
    js("$('.mybutton.c2').click();")
    time.sleep(1)


def click_link(text):
    return js('var t = arguments[0]; var l = $(".bsSync a.click, .bsSync span.click").filter(function(){ return $(this).text() == t; }); l.first().click(); return l.length;', text)


def status_text():
    return js('return $(".bsSync").text()')


def wait_status(pred, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        t = status_text() or ''
        if pred(t):
            return t
        time.sleep(1)
    return status_text()


def alert_text():
    v = wd('GET', S + '/alert/text')
    return v if isinstance(v, str) else None


try:
    # ---- device A: existing data, then "Show my sync code"
    check('device A loads', goto(A))
    reset()
    load_data([['3x3', N_SOLVES, 1760000000], ['OH', 1200, 1761000000], ['empty', 0, 0]])
    a_before = json.loads(all_solves())
    check('device A has its data', len(a_before['3x3']) == N_SOLVES and len(a_before['OH']) == 1200, {k: len(v) for k, v in a_before.items()})
    open_export()
    check('sync section offers to start', 'Show my sync code' in (status_text() or ''), status_text())
    t0 = time.time()
    click_link('Show my sync code')
    txt = wait_status(lambda t: 'Last synced' in t and 'Sync code' in t)
    check('code shown and first full upload done (%.1fs)' % (time.time() - t0), txt and 'Sync code' in txt and 'Last synced' in txt, txt)
    code = js('var m = $(".bsSync").text().match(/Sync code:\\s*([0-9A-Z]{4}(?:-[0-9A-Z]{1,4})+)/); return m ? m[1] : null')
    check('code is grouped in fours', code and len(code.replace('-', '')) == 26, code)
    check('copy icon present', js('return $(".bsSync span.click[title=Copy]").length') == 1)
    check("device A's data unchanged by the upload", json.loads(all_solves()) == a_before)

    # ---- device B: fresh, joins with the code
    check('device B loads', goto(B))
    reset()
    open_export()
    click_link('Use a code from another device')
    time.sleep(1)
    check('asks for the code', 'sync code' in (alert_text() or '').lower(), alert_text())
    wd('POST', S + '/alert/text', {'text': code.lower()})
    wd('POST', S + '/alert/accept', {})
    time.sleep(3)
    wait_ready(180)  # applying reloads the page
    b = json.loads(all_solves())
    check('device B received every session', set(a_before) <= set(b), list(b))
    check('device B received every solve byte-for-byte', all(b.get(k) == v for k, v in a_before.items()),
          {k: (len(v), len(b.get(k, []))) for k, v in a_before.items()})

    # B adds a solve and renames a session
    js_async('''
var d = JSON.parse(kernel.getProp("sessionData")), n = ~~kernel.getProp("sessionN"), idx = 0;
for (var i = 1; i <= n; i++) if (d[i].name == "OH") idx = i;
d[idx].name = "One-handed"; kernel.setProp("sessionData", JSON.stringify(d));
storage.exportAll().then(function(o){ o["session" + idx].push([[0, 7777], "B U2", "from B", 1769999999]); return storage.importAll(o); }).then(function(){ done(1); });''')
    time.sleep(1)
    raw = js_async('bsSync.syncNow("manual").then(function(r){ done(JSON.stringify(r)); }, function(e){ done(JSON.stringify({status: "reject", error: String(e)})); });')
    if not isinstance(raw, str):
        print('# raw reply:', raw, '| page load time:', js('return performance.timeOrigin'))
        wait_ready(120)
        raw = js_async('bsSync.syncNow("manual").then(function(r){ done(JSON.stringify(r)); }, function(e){ done(JSON.stringify({status: "reject", error: String(e)})); });')
    r = json.loads(raw) if isinstance(raw, str) else {'raw': raw}
    check('device B uploads its change', r.get('status') == 'ok' and r.get('pushed'), r)

    # ---- device A receives it
    goto(A)
    r = json.loads(js_async('bsSync.syncNow("manual").then(function(r){ done(JSON.stringify(r)); }, function(e){ done(JSON.stringify({status: "reject", error: String(e)})); });'))
    time.sleep(3)
    wait_ready(180)
    a2 = json.loads(all_solves())
    check('device A got the rename and the new solve', 'One-handed' in a2 and len(a2['One-handed']) == 1201, {k: len(v) for k, v in a2.items()})
    check("device A's other solves are untouched", a2['3x3'] == a_before['3x3'])

    # ---- deletion guard: A loses most of a session (e.g. a broken import)
    def wait_idle(timeout=60):
        end = time.time() + timeout
        while time.time() < end and js('return bsSync.busy()') is not False:
            time.sleep(0.5)
    wait_idle()  # no sync running or scheduled
    head_before = json.loads(js_async('bsSync.transports.server.versions().then(function(v){ done(JSON.stringify(v)); });'))[0]['version']
    js_async('''
var d = JSON.parse(kernel.getProp("sessionData")), n = ~~kernel.getProp("sessionN"), idx = 0;
for (var i = 1; i <= n; i++) if (d[i].name == "3x3") idx = i;
storage.exportAll().then(function(o){ o["session" + idx] = o["session" + idx].slice(0, 100); return storage.importAll(o); }).then(function(){ done(1); });''')
    wait_idle()  # the truncation may have scheduled an autosync; let it run (it will ask) or settle
    if not alert_text():
        js('bsSync.syncNow("manual"); return 1;')
    end = time.time() + 30
    while time.time() < end and not alert_text():
        time.sleep(0.5)
    txt = alert_text() or ''
    check('deletion guard asks before deleting solves from the synced copy', 'would delete' in txt and 'solves' in txt, txt)
    wd('POST', S + '/alert/dismiss', {})
    time.sleep(2)
    versions = json.loads(js_async('bsSync.transports.server.versions().then(function(v){ done(JSON.stringify(v)); });'))
    check('nothing was uploaded after declining', versions and versions[0]['version'] == head_before, (head_before, versions))
    check('versions are listed', len(versions) >= 2, versions)
    time.sleep(7)
    check('autosync does not ask again after a decline', alert_text() is None, alert_text())

    # restore A's own data from the synced copy
    r = json.loads(js_async('bsSync.syncNow("manual", "replaceLocal").then(function(r){ done(JSON.stringify(r)); });'))
    time.sleep(3)
    wait_ready(180)
    a3 = json.loads(all_solves())
    check('"download synced copy" brings the deleted solves back', len(a3['3x3']) == N_SOLVES, len(a3.get('3x3', [])))
    backups = json.loads(js_async('''
var rq = indexedDB.open("bstimer-sync", 1);
rq.onsuccess = function(){ var g = rq.result.transaction("kv").objectStore("kv").get("backups"); g.onsuccess = function(){ done(JSON.stringify((g.result || []).length)); }; };'''))
    check('a local backup was kept before applying', backups >= 1, backups)
finally:
    wd('DELETE', S)

print('# all passed' if failures == 0 else '# %d FAILURES' % failures)
sys.exit(1 if failures else 0)
