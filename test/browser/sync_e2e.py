#!/usr/bin/env python3
"""End-to-end test of bsTimer sync in Safari through safaridriver (WebDriver).

Needs: the site served at BASE with a config that sets syncDebug: true and
customIdSync: false, and `safaridriver -p 4444` running (after `safaridriver --enable`).
Usage: python3 sync_e2e.py [BASE]   (default http://localhost:8080/)
"""
import json
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8080/'
WD = 'http://localhost:4444'
failures = 0


def wd(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(WD + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b'{}').get('value')
    except urllib.error.HTTPError as e:
        return {'error': json.loads(e.read() or b'{}').get('value')}


def check(name, cond, detail=''):
    global failures
    print(('ok - ' if cond else 'not ok - ') + name + ('' if cond else '  ' + str(detail)))
    if not cond:
        failures += 1


sid = wd('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'safari'}}})['sessionId']
S = '/session/' + sid


def js(script, *args):
    return wd('POST', S + '/execute/sync', {'script': script, 'args': list(args)})


def js_async(script, *args):
    """script gets `done` as its last argument and must call done(value)."""
    return wd('POST', S + '/execute/async', {'script': 'var done = arguments[arguments.length - 1];' + script, 'args': list(args)})


def wait_ready(timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        r = js('return !!(window.bsSync && window.kernel && window.storage && document.readyState === "complete")')
        if r is True:
            time.sleep(1)
            return True
        time.sleep(0.5)
    return False


def sync():
    return js_async('bsSync.syncNow("manual").then(function(r){ done(JSON.stringify(r)); }, function(e){ done("ERR " + e); });')


def cloud():
    return js_async('''
var rq = indexedDB.open("bstimer-sync", 1);
rq.onsuccess = function() {
  var g = rq.result.transaction("kv").objectStore("kv").get("debugCloud");
  g.onsuccess = function() { done(JSON.stringify(g.result || null)); };
  g.onerror = function() { done("null"); };
};
rq.onerror = function() { done("null"); };''')


def set_cloud(value):
    return js_async('''
var rq = indexedDB.open("bstimer-sync", 1);
rq.onsuccess = function() {
  var t = rq.result.transaction("kv", "readwrite");
  t.objectStore("kv").put(JSON.parse(arguments[0]), "debugCloud");
  t.oncomplete = function() { done("ok"); };
};'''.replace('arguments[0]', json.dumps(json.dumps(value))))


def session_names():
    return js('var d = JSON.parse(kernel.getProp("sessionData")); return Object.keys(d).map(function(k){ return d[k].name; });')


try:
    # Fresh start: no sync state, no marker.
    wd('POST', S + '/url', {'url': BASE})
    check('page loads with bsSync', wait_ready())
    js_async('var d = indexedDB.deleteDatabase("bstimer-sync"); d.onsuccess = d.onerror = d.onblocked = function(){ done(1); };')
    wd('POST', S + '/refresh', {})
    check('reloads after reset', wait_ready())

    # Export dialog: sync section present, typed-id row removed.
    js("$('.mybutton').filter(function(){ return $(this).text().indexOf(BUTTON_EXPORT) >= 0; }).first().click();")
    time.sleep(1)
    ui = js('''
var fileLink = $('a').filter(function(){ return $(this).text() == EXPORT_FROMFILE; }).first();
return {sync: $('.bsSync').length, rows: fileLink.closest('table').find('tr').length, text: $('.bsSync').text()};''')
    check('export dialog shows the sync section', ui and ui.get('sync') == 1, ui)
    check('typed-id server row is removed (2 rows left)', ui and ui.get('rows') == 2, ui)
    js('$(".dialog .click, .dialog input[type=button]").filter(function(){ return /OK|Close/i.test($(this).val() || $(this).text()); }).click();')

    # First sync uploads.
    r = json.loads(sync())
    check('first sync ok (autosync on load may already have uploaded)', r.get('status') == 'ok', r)
    c = json.loads(cloud())
    n_local = int(js('return ~~kernel.getProp("sessionN")'))
    check("untouched default sessions aren't uploaded", c and len(c['data']['sessions']) == 0, (n_local, c and list(c['data']['sessions'])))
    uids = js('var d = JSON.parse(kernel.getProp("sessionData")); return Object.keys(d).map(function(k){ return d[k].uid; });')
    check('local sessions got uids', uids and all(uids), uids)

    # Another device adds a session: it arrives after a reload.
    c['data']['sessions']['remote1'] = {'meta': {'name': 'From cloud', 'opt': {}, 'rank': 99},
                                         'solves': [[[0, 12345], "R U R' U'", '', 1760000000]]}
    c['tag'] = str(int(c['tag']) + 1)
    set_cloud(c)
    sync()  # applies and reloads
    time.sleep(2)
    check('reloads after applying', wait_ready())
    names = session_names()
    check('session from the cloud arrived', names and 'From cloud' in names, names)
    check('untouched default sessions give way to the synced ones', names == ['From cloud'], names)
    got = js_async('''
var d = JSON.parse(kernel.getProp("sessionData")); var idx = 0;
for (var k in d) if (d[k].name == "From cloud") idx = k;
storage.exportAll().then(function(o){ done(JSON.stringify(o["session" + idx] || [])); });''')
    check('its solve arrived', json.loads(got) and json.loads(got)[0][0][1] == 12345, got)

    # A csTimer import replaces the settings (and with them our mark): sync must ask.
    mark_before = js('return kernel.getProp("bsSyncMark")')
    js('kernel.setProp("bsSyncMark", "imported-file")')
    wd('POST', S + '/execute/async', {'script': 'var done = arguments[0]; bsSync.syncNow("manual"); setTimeout(function(){ done(1); }, 100);', 'args': []})
    time.sleep(1)
    alert = wd('GET', S + '/alert/text')
    check('asks after an import', isinstance(alert, str) and 'combine' in alert.lower(), alert)
    wd('POST', S + '/alert/accept', {})  # combine
    time.sleep(3)
    wait_ready()
    mark_after = js('return kernel.getProp("bsSyncMark")')
    check('a new mark is set after combining', mark_after not in (None, '', 'imported-file', mark_before), (mark_before, mark_after))
    check('the mark survives a reload (csTimer keeps its settings)', (wd('POST', S + '/refresh', {}), wait_ready(), js('return kernel.getProp("bsSyncMark")'))[2] == mark_after)
    names = session_names()
    check('combine kept the cloud session', names and 'From cloud' in names, names)

    # Autosync: renaming a session uploads within a few seconds.
    js('var d = JSON.parse(kernel.getProp("sessionData")); for (var k in d) if (d[k].name == "From cloud") d[k].name = "Renamed"; kernel.setProp("sessionData", JSON.stringify(d));')
    time.sleep(8)
    c = json.loads(cloud())
    check('autosync uploaded the rename', c and c['data']['sessions'].get('remote1', {}).get('meta', {}).get('name') == 'Renamed',
          c and c['data']['sessions'].get('remote1'))
finally:
    wd('DELETE', S)

print('# all passed' if failures == 0 else '# %d FAILURES' % failures)
sys.exit(1 if failures else 0)
