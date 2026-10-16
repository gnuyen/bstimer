#!/usr/bin/env python3
"""End-to-end test of bsTimer sync between two iOS "app" devices and a plain web browser.

The site is served by `php -S 127.0.0.1:8080 ../test/browser/app_router.php` from src/,
tunnelled so that http://localhost:8080/, http://localhost:8081/ and http://localhost:8082/
all reach it. 8080 = app device A, 8081 = app device B (both have a fake iCloud bridge
shared through POST /fakecloud), 8082 = a plain web browser W (no bridge).
Needs: `safaridriver -p 4444` running.
"""
import json
import sys
import time
import urllib.request

A = 'http://localhost:8080/'
B = 'http://localhost:8081/'
W = 'http://localhost:8082/'
WD = 'http://localhost:4444'
N_SOLVES = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
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


def cloud(op, **kw):
    body = {'op': op}
    body.update(kw)
    req = urllib.request.Request(A + 'fakecloud', data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b'{}')


def cloud_solves():
    st = cloud('peek')
    if st.get('data') is None:
        return {}
    data = json.loads(st['data'])
    out = {}
    for sess in data.get('sessions', {}).values():
        out[sess['meta']['name']] = sess.get('solves', [])
    return out


def sync():
    raw = js_async('bsSync.syncNow("manual").then(function(r){ done(JSON.stringify(r)); }, function(e){ done(JSON.stringify({status: "reject", error: String(e)})); });')
    if not isinstance(raw, str):
        print('# raw reply:', raw, '| page load time:', js('return performance.timeOrigin'))
        wait_ready(120)
        raw = js_async('bsSync.syncNow("manual").then(function(r){ done(JSON.stringify(r)); }, function(e){ done(JSON.stringify({status: "reject", error: String(e)})); });')
    return json.loads(raw) if isinstance(raw, str) else {'raw': raw}


def wait_for(fn, timeout=60):
    end = time.time() + timeout
    val = None
    while time.time() < end:
        val = fn()
        if val:
            return val
        time.sleep(1)
    return val


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


def wait_idle(timeout=60):
    end = time.time() + timeout
    while time.time() < end and js('return bsSync.busy()') is not False:
        time.sleep(0.5)


try:
    # ---- step 1: app A autosyncs to iCloud without any sign-in
    cloud('reset')
    check('app A loads', goto(A))
    reset()
    load_data([['3x3', N_SOLVES, 1760000000], ['OH', 500, 1761000000]])
    a_before = json.loads(all_solves())
    check('app A has its data', len(a_before.get('3x3', [])) == N_SOLVES and len(a_before.get('OH', [])) == 500,
          {k: len(v) for k, v in a_before.items()})

    def a_in_cloud():
        c = cloud_solves()
        return c if len(c.get('3x3', [])) == N_SOLVES else None
    wait_for(a_in_cloud, timeout=90)
    check('app A autosyncs to iCloud without any sign-in', len(cloud_solves().get('3x3', [])) == N_SOLVES,
          {k: len(v) for k, v in cloud_solves().items()})

    def code_in_cloud():
        st = cloud('peek')
        return st.get('code') if st.get('code') else None
    code = wait_for(code_in_cloud, timeout=90)
    check('app A created a server code and stored it in iCloud', bool(code), code)

    # ---- step 2: app B gets the data from iCloud on its own
    check('app B loads', goto(B))
    reset()

    def b_has_data():
        try:
            b = json.loads(all_solves())
        except Exception:
            return None
        if len(b.get('3x3', [])) == N_SOLVES:
            return b
        try:
            wait_ready(5)
        except Exception:
            pass
        return None
    wait_for(b_has_data, timeout=120)
    b = json.loads(all_solves())
    check('app B gets the data from iCloud on its own', len(b.get('3x3', [])) == N_SOLVES,
          {k: len(v) for k, v in b.items()})
    check('app B 3x3 equals A original', b.get('3x3') == a_before.get('3x3'),
          (len(b.get('3x3', [])), len(a_before.get('3x3', []))))
    wait_idle()
    check('app B uses the same server code from iCloud',
          js('return bsSync.transports.server.available()') is True,
          js('return bsSync.transports.server.available()'))
    wait_for(lambda: js("return JSON.stringify(bsSync.transports.icloud.code())") == json.dumps(code), 30)
    check('app B icloud code matches',
          js("return JSON.stringify(bsSync.transports.icloud.code())") == json.dumps(code),
          (js("return JSON.stringify(bsSync.transports.icloud.code())"), code))

    # ---- step 3: web W joins through the server copy
    check('web W loads', goto(W))
    reset()
    open_export()
    check('web shows the start options', 'Use a code from another device' in (status_text() or ''), status_text())
    click_link('Use a code from another device')
    time.sleep(1)
    wd('POST', S + '/alert/text', {'text': code.lower()})
    wd('POST', S + '/alert/accept', {})
    time.sleep(3)
    wait_ready(180)
    w = json.loads(all_solves())
    check('web gets the data through the server copy',
          len(w.get('3x3', [])) == N_SOLVES and len(w.get('OH', [])) == 500,
          {k: len(v) for k, v in w.items()})
    js_async('''
var d = JSON.parse(kernel.getProp("sessionData")), n = ~~kernel.getProp("sessionN"), idx = 0;
for (var i = 1; i <= n; i++) if (d[i].name == "OH") idx = i;
storage.exportAll().then(function(o){ o["session" + idx].push([[0, 7777], "W U2", "from web", 1769999999]); return storage.importAll(o); }).then(function(){ done(1); });''')
    time.sleep(1)
    r = sync()
    check('web uploads its solve', r.get('status') == 'ok' and r.get('pushed'), r)

    # ---- step 4: app A gets the web solve from the server copy
    check('app A reloads', goto(A))
    r = sync()
    time.sleep(3)
    wait_ready(180)

    def a_oh_501():
        a = json.loads(all_solves())
        return a if len(a.get('OH', [])) == 501 else None
    wait_for(a_oh_501, timeout=60)
    check('app A gets the web solve from the server copy', len(json.loads(all_solves()).get('OH', [])) == 501,
          {k: len(v) for k, v in json.loads(all_solves()).items()})

    def a_oh_501_cloud():
        c = cloud_solves()
        return c if len(c.get('OH', [])) == 501 else None
    wait_for(a_oh_501_cloud, timeout=90)
    check('app A passes the web solve on to iCloud', len(cloud_solves().get('OH', [])) == 501,
          {k: len(v) for k, v in cloud_solves().items()})

    # ---- step 5: app B gets the web solve through iCloud
    check('app B reloads', goto(B))
    r = sync()
    time.sleep(3)
    wait_ready(180)

    def b_oh_501():
        b = json.loads(all_solves())
        return b if len(b.get('OH', [])) == 501 else None
    wait_for(b_oh_501, timeout=60)
    check('app B gets the web solve through iCloud', len(json.loads(all_solves()).get('OH', [])) == 501,
          {k: len(v) for k, v in json.loads(all_solves()).items()})

    # ---- step 6: deletion asked once for both backends (on B)
    wait_idle()
    js_async('''
var d = JSON.parse(kernel.getProp("sessionData")), n = ~~kernel.getProp("sessionN"), idx = 0;
for (var i = 1; i <= n; i++) if (d[i].name == "3x3") idx = i;
storage.exportAll().then(function(o){ o["session" + idx] = o["session" + idx].slice(0, 100); return storage.importAll(o); }).then(function(){ done(1); });''')
    wait_idle()
    if not alert_text():
        js('bsSync.syncNow("manual"); return 1;')
    end = time.time() + 30
    while time.time() < end and not alert_text():
        time.sleep(0.5)
    txt = alert_text() or ''
    check('deletion guard asks', 'would delete' in txt, txt)
    wd('POST', S + '/alert/accept', {})
    count = 0
    end = time.time() + 20
    while time.time() < end:
        if alert_text() is not None:
            count += 1
            wd('POST', S + '/alert/dismiss', {})
        time.sleep(0.5)
    check('asked only once for iCloud and the server copy', count == 0, count)

    def cloud_3x3_100():
        c = cloud_solves()
        return c if len(c.get('3x3', [])) == 100 else None
    wait_for(cloud_3x3_100, timeout=60)
    check('deletion reached iCloud', len(cloud_solves().get('3x3', [])) == 100,
          {k: len(v) for k, v in cloud_solves().items()})

    def server_3x3_100():
        raw = js_async('bsSync.transports.server.get().then(function(c){ var n = 0; var s = c.data.sessions; for (var k in s) if (s[k].meta.name == "3x3") n = s[k].solves.length; done(JSON.stringify(n)); });')
        try:
            n = int(json.loads(raw))
        except Exception:
            return None
        return n if n == 100 else None
    wait_for(server_3x3_100, timeout=60)
    check('deletion reached the server copy', server_3x3_100() == 100, server_3x3_100())

    # ---- step 7: app UI (still on B)
    wait_idle()
    open_export()
    check('app shows iCloud in the heading', 'iCloud' in (status_text() or ''), status_text())
    check('app hides the code until asked', 'Sync code:' not in (status_text() or ''), status_text())
    click_link('Show my sync code (for the website)')
    time.sleep(2)
    st = status_text() or ''
    check('app shows the code on request', code.replace('-', '') in st.replace('-', ''), st)
    check('app has no web-only sign-in links', 'Sign in with WCA' not in st, st)
finally:
    wd('DELETE', S)

print('# all passed' if failures == 0 else '# %d FAILURES' % failures)
sys.exit(1 if failures else 0)
