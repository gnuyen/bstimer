#!/usr/bin/env python3
"""End-to-end test of account features: the OAuth state check on sign-in returns, and deleting synced data.

Same setup as app_sync_e2e.py: `php -S 127.0.0.1:8080 ../test/browser/app_router.php` from src/,
reachable as localhost:8080 (an app with a fake iCloud bridge) and localhost:8082 (a plain browser),
and `safaridriver -p 4444` running. The router's oauthwca.php stand-in counts code exchanges (GET /oauthhits). The test's own
requests use port 8080, since every port reaches the same server.
"""
import json
import sys
import time
import urllib.request
import urllib.parse

A = 'http://localhost:8080/'
W = 'http://localhost:8082/'
WD = 'http://localhost:4444'
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


def oauth_hits(reset=False):
    url = A + 'oauthhits' + ('?reset=1' if reset else '')
    with urllib.request.urlopen(url, timeout=30) as r:
        return int(r.read().decode().strip() or 0)


def server(post):
    data = urllib.parse.urlencode(post).encode()
    req = urllib.request.Request(A + 'sync.php', data=data, method='POST',
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b'{}')


def accept_alerts(timeout=20):
    texts = []
    end = time.time() + timeout
    last = time.time()
    while time.time() < end:
        t = alert_text()
        if t is not None:
            texts.append(t)
            wd('POST', S + '/alert/accept', {})
            last = time.time()
            time.sleep(0.5)
        elif texts and time.time() - last > 3:
            break
        else:
            time.sleep(0.5)
    return texts


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
    # ---- step 1: OAuth state, WCA (plain browser W)
    check('web W loads', goto(W))
    reset()
    oauth_hits(reset=True)
    st = js('return sessionStorage.oauthState')
    check('WCA sign-in has a state', isinstance(st, str) and st != '', st)
    check('WCA login url carries the state',
          (js('return exportFunc.wcaLoginUrl') or '').endswith('&state=' + st),
          js('return exportFunc.wcaLoginUrl'))

    goto(W + '?code=FAKECODE&state=bogus')
    time.sleep(2)
    check('a sign-in code with the wrong state is not exchanged', oauth_hits() == 0, oauth_hits())
    check('the refused code is cleared from the address', js('return location.search') == '',
          js('return location.search'))

    st = js('return sessionStorage.oauthState')
    goto(W + '?code=FAKECODE&state=' + st)
    time.sleep(2)
    check('a sign-in code with this tab\'s state is exchanged', oauth_hits() == 1, oauth_hits())
    accept_alerts(5)

    goto(W + '?code=FAKECODE')
    time.sleep(2)
    accept_alerts(3)
    check('a code without state is not exchanged', oauth_hits() == 1, oauth_hits())

    # ---- step 2: OAuth state, Google (W)
    goto(W + '?g=1#access_token=TOKEN&state=bogus')  # a query change forces a real page load
    time.sleep(2)
    accept_alerts(3)
    check('a Google token with the wrong state is ignored',
          js('return location.hash') == '' and js('return localStorage.gglData || null') is None,
          (js('return location.hash'), js('return localStorage.gglData || null')))

    # ---- step 3: delete synced data on the web (W)
    check('web W loads', goto(W))
    reset()
    load_data([['3x3', 50, 1760000000]])
    open_export()
    click_link('Show my sync code')
    txt = wait_status(lambda t: 'Last synced' in t and 'Sync code' in t)
    check('web shows the sync code', 'Last synced' in txt and 'Sync code' in txt, txt)
    code = js('var m = $(".bsSync").text().match(/Sync code:\\s*([0-9A-Z]{4}(?:-[0-9A-Z]{1,4})+)/); return m ? m[1].replace(/-/g, "") : null')
    check('web sync code is readable', isinstance(code, str) and code != '', code)
    check('web server copy exists', server({'action': 'head', 'code': code})['version'] >= 1,
          server({'action': 'head', 'code': code}))
    links = js('return $(".bsSyncPrivacy a").map(function(){ return $(this).attr("href"); }).get()')
    check('the Sync section links the help and privacy pages', links == ['support.html', 'privacy.html'], links)
    click_link('Delete synced data…')
    texts = accept_alerts(20)
    check('web delete confirms and reports',
          any('Delete your synced data' in t for t in texts) and any('was deleted' in t for t in texts),
          texts)
    check('web server copy is gone', server({'action': 'head', 'code': code})['retcode'] == 401,
          server({'action': 'head', 'code': code}))
    check('this device keeps its data',
          js_async('storage.exportAll().then(function(o){ done(JSON.stringify((o.session1 || []).length)); });') == '50',
          js_async('storage.exportAll().then(function(o){ done(JSON.stringify((o.session1 || []).length)); });'))
    check('the section offers to start again',
          'Show my sync code' in (wait_status(lambda t: 'Show my sync code' in t, 30) or ''),
          wait_status(lambda t: 'Show my sync code' in t, 30))

    # ---- step 4: delete in the app (A, fake iCloud)
    cloud('reset')
    check('app A loads', goto(A))
    reset()
    load_data([['OH', 20, 1761000000]])
    wait_idle()
    r = json.loads(js_async('bsSync.syncNow("manual").then(function(r){ done(JSON.stringify(r)); });'))
    wait_idle()
    st = cloud('peek')
    check('the app synced to iCloud and keeps a server code there',
          st['data'] is not None and st['code'], st)
    code = st['code']
    open_export()
    click_link('Delete synced data…')
    texts = accept_alerts(20)
    check('app delete confirmation mentions iCloud', any('your iCloud' in t for t in texts), texts)
    st = cloud('peek')
    check('the iCloud copy and code are deleted', st['data'] is None and st['code'] is None, st)
    check('app server copy is gone', server({'action': 'head', 'code': code})['retcode'] == 401,
          server({'action': 'head', 'code': code}))
    time.sleep(8)
    check('autosync does not upload again', cloud('peek')['data'] is None, cloud('peek'))
    check('app A reloads', goto(A))
    time.sleep(6)
    check('a reload does not start syncing again',
          cloud('peek')['data'] is None and cloud('peek')['code'] is None, cloud('peek'))

    # 5. App settings: kept in iCloud apart from sync, restored on a fresh install only
    B = 'http://localhost:8081/'
    cloud('reset')
    goto(A); reset()
    js('kernel.setProp("timerSize", 7); kernel.setProp("useMilli", true); return 1;')
    time.sleep(6)
    saved = json.loads(cloud('peek').get('settings') or '{}')
    check('the app saves its settings to iCloud', saved.get('timerSize') == 7 and saved.get('useMilli') is True, saved)
    check('session bookkeeping is not part of them', 'sessionData' not in saved and 'bsSyncMark' not in saved, list(saved))
    goto(B); reset()  # a fresh install: empty storage, then the first load restores and reloads
    time.sleep(4); wait_ready()
    check('a fresh install gets the settings back', js('return [kernel.getProp("timerSize"), kernel.getProp("useMilli")]') == [7, True],
          js('return [kernel.getProp("timerSize"), kernel.getProp("useMilli")]'))
    goto(A); js('kernel.setProp("timerSize", 9); return 1;'); time.sleep(6)
    goto(B); time.sleep(3)
    check('an existing install is not overwritten later', js('return kernel.getProp("timerSize")') == 7, js('return kernel.getProp("timerSize")'))
    goto(W); reset()
    check('the website does not get the app settings', js('return kernel.getProp("timerSize")') != 9, js('return kernel.getProp("timerSize")'))
finally:
    wd('DELETE', S)

print('# all passed' if failures == 0 else '# %d FAILURES' % failures)
sys.exit(1 if failures else 0)
