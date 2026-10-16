# bsTimer

bsTimer is csTimer with a few changes that are useful when you host it yourself or run it in the bsTimer iOS app (https://github.com/gnuyen/bstimer-ios), which adds Web Bluetooth on iPhone. It tracks upstream closely; all credit for csTimer goes to cs0x7f and its contributors. Licence stays GPL-3.0.

## Changes from csTimer

- Site config: server URLs and sign-in client ids live in `src/js/bstimer/config.js` instead of being spread through the code. Defaults are csTimer's own, so an unconfigured copy behaves like upstream.
- Server settings: `src/siteconfig.php` loads WCA secrets and other server-side settings from one file outside git (see below); `oauthwca.php` reads them from there.
- Error reports: `src/bug.php` stores the JavaScript error reports csTimer sends, without the browser fingerprint or IP address, in a size-capped log outside the web root.
- Unconfigured online tools are hidden: an empty `compServer` hides Online Competition, an empty `battleSocket` hides Online battle.
- App update notice: when the bsTimer iOS app's user agent (`bsTimer/<revision>`) is older than `latestAppRevision`, the page shows a logo hint at most once a day (`src/js/bstimer/appupdate.js`).
- Offline support: `src/sw.js` is a working service worker. The page loads from the network when it can and from a cached copy when offline; scripts and styles are served from cache and refreshed in the background, so a deploy shows up on the second load.
- Screen Wake Lock: the screen stays awake while a timer is running (`src/js/kernel.js`).
- `src/js/bstimer/app-auth.js`: hands Google sign-in back to the bsTimer iOS app. It only acts on URLs carrying `state=cstimer-ios`, which only the app adds.
- `src/userdata2.php`: the export/import-to-server backend, with prepared statements, validated ids, content-checked write-once slices, size limits and no cross-origin access. Settings come from the server settings file.
- Sync between devices: the Export dialog has a "Sync" section (`src/js/bstimer/sync*.js`, `src/sync.php`). It keeps sessions and solves in step across the devices that share a sync code.
- `src/js/bstimer/keepawake.js`: re-requests the screen wake lock when a timer starts. It works in an installed web app, where the page's own wake lock is not enough.
- `src/js/bstimer/syncicloud.js`: syncs to the user's iCloud when the page runs inside the bsTimer iOS app.

## Sync

### On the web

Nothing syncs until the user opens Export and chooses "Show my sync code" (creates a code, uploads everything, and starts automatic sync), "Use a code from another device", "Sign in with WCA" or "Sign in with Google" (after signing in to that account in the Export dialog). Only sessions and solves sync by default; "Also sync settings" adds settings, but display and input settings always stay per device.

Typed-ID saves ("upload to server" with an ID you choose, via `userdata2.php`) are separate from sync: what you upload is what you download, and every save is kept as history.

### Merging

Sync merges rather than overwrites. Each session gets a permanent id stored in csTimer's session data; solves are matched by time stamp, time and scramble. Untouched default sessions (empty, numbered, no options) are not uploaded.

If the device's data was replaced by an import of a csTimer file, sync asks whether to combine, replace the synced copy, or pause. If a sync would delete solves (more than 10, or 5%) or sessions, it asks first; declining pauses automatic sync until "Sync now". Before applying anything, the device keeps a local backup (the last 5, under "Local backups…").

### In the iOS app

In bsTimer mode the app syncs to the user's iCloud automatically, with no sign-in. It also keeps a copy on the sync server, whose code is stored in iCloud key-value storage, so other Apple devices and reinstalls use the same code. "Show my sync code (for the website)" shows that code so the website can join. The page talks to the app through `webkit.messageHandlers.bsCloud` (see `syncicloud.js`). In csTimer.net mode (chosen in the iOS Settings app) none of this runs.

### Server history

The server keeps the newest 20 synced versions plus one per day for 120 days (`sync_keep_recent` and `sync_keep_days`); "Earlier versions…" restores one.

## Hosting your own copy

Serve the `src/` folder with PHP (index.php picks the language).

### Site settings

Don't edit `src/js/bstimer/config.js`. Create `src/js/bstimer/config.local.js` (git ignores it) and set only what differs; index.php loads it before config.js. For example:

```js
var SITE_CONFIG = {
	'dataServer': 'https://timer.example.org/',
	'wcaClientId': '<your WCA application id>',
	'googleClientId': '<your id>.apps.googleusercontent.com'
};
```

| Setting | Used for | Default |
|---|---|---|
| dataServer | Base URL (with trailing slash) of `userdata2.php` (Export → upload/download to server). That script isn't part of csTimer's source; leave the default or host your own. | `https://cstimer.net/` |
| customIdSync | Show "Export to server" with an id the user types. That id is the only key (no password), so anyone who guesses it can read or overwrite the backup. false leaves only the WCA-account server export. | `true` |
| syncServer | The sync endpoint, e.g. `sync.php`. Empty turns server sync off. | empty |
| syncDebug | Testing only: a fake cloud stored in the browser. | `false` |
| compServer | Base URL of `comp.php` for online competitions. Empty hides the Online Competition tool. | `https://cstimer.net/` |
| battleSocket | WebSocket for the battle tool. Empty hides the Online battle tool. | `wss://cstimer.net/ws20230409` |
| wcaClientId | WCA sign-in. Register an application at worldcubeassociation.org and add your page URL as a redirect URI. Put the application id and secret in the server settings file (below). | csTimer's |
| googleClientId | Google Drive backup sign-in. Create an OAuth client in Google Cloud and list your redirect URI. | csTimer's |
| wcaRedirectUri, googleRedirectUri | Redirect URI sent when signing in, if it must differ from the page's own URL (for example without a trailing slash). | the page URL without its query |
| latestAppRevision | Newest bsTimer iOS app revision; older apps get an update hint. 0 turns the check off. | `0` |

### Server settings

Server-side PHP reads its settings through `src/siteconfig.php` from the first of these files that exists:
1. the path in the `BSTIMER_CONFIG` environment variable,
2. `bstimer-config.php` one level above the web root (recommended: the web server can't serve it),
3. `config.local.php` in the web root (git ignores it).
The file returns an array with only the settings you change:
```php
<?php
return [
	'wca_application_id' => '<your WCA application id>',
	'wca_application_secret' => '<your WCA application secret>',
	'wca_token_salt' => '<a long random string>',
	'wca_referrer_pattern' => '/^(https:\/\/timer\.example\.org\/)(\?.*)?$/i',
	'userdata_dsn' => 'mysql:host=localhost;dbname=cstimer;charset=utf8mb4',
	'userdata_db_user' => '<db user>',
	'userdata_db_password' => '<db password>',
	'userdata_table' => 'my_cstimer_saves',
	'userdata_allow_custom_ids' => true,
	'userdata_max_item_bytes' => 1048576,
	'userdata_max_items' => 200,
];
```

| Setting | Used for |
|---|---|
| wca_application_id / wca_application_secret | your WCA application |
| wca_token_salt | salt for the anonymous `cstimer_token` given to signed-in users; keep it secret and don't change it once in use |
| wca_referrer_pattern | regex the page URL must match; its first capture group is the redirect URI sent to WCA |
| bug_log | where bug.php writes; default `bstimer-logs/bug.log` one level above the web root |
| bug_log_max_bytes | log size before it rotates to `.1`; default 1 MiB |
| userdata_dsn, userdata_db_user, userdata_db_password | Database for `userdata2.php` (PDO DSN, e.g. `mysql:host=localhost;dbname=cstimer;charset=utf8mb4`). Empty DSN disables it. |
| userdata_table | Table with columns `username` (primary key), `save_data`, `value_hash`, `upload_time`. |
| userdata_allow_custom_ids | false refuses typed ids: main backup rows must be WCA tokens. Pair it with `customIdSync: false`. |
| userdata_max_item_bytes, userdata_max_items | Largest stored value, and most ids in one request. |
| sync_dsn, sync_db_user, sync_db_password | Database for sync; empty means the userdata database settings. |
| sync_table_prefix | Prefix for the sync tables; default `bstimer_sync_`. Tables are created on first use. |
| sync_keep_recent | Newest synced versions always kept; default 20. |
| sync_keep_days | Additionally keep the newest version of each UTC day within this many days; default 120. |
| google_client_id | Your Google OAuth client id (the same as googleClientId); turns on "Sign in with Google" for sync. sync.php asks Google to confirm that each token was issued to this client. Empty (the default) turns it off. |

Only hashes of codes and session tokens are stored.

### Deploying

Upload `src/` to your web server, including your `src/js/bstimer/config.local.js`. Keep secrets out of the PHP files: put them in the server settings file, then the PHP files can be uploaded like everything else.

### Security notes

- Use WCA sign-in for server backups and set `customIdSync: false` with `userdata_allow_custom_ids => false`: typed ids work like passwords anyone can guess.
- `wca_token_salt` must be a long random secret. Changing it changes every WCA user's storage id.
- Keep the server settings file outside the web root, and don't leave logs or old copies of PHP scripts in it: anything PHP-executable or readable there is public.

## Keeping up with csTimer

Branches: `master` mirrors upstream; `bstimer` holds the changes and is the default branch. To update:

```sh
git remote add upstream https://github.com/cs0x7f/cstimer.git   # once
git fetch upstream
git switch master && git merge --ff-only upstream/master && git push origin master
git switch bstimer && git merge master
```

Conflicts are usually limited to the few files listed under "Changes from csTimer". Keep site-specific values out of the repository: they belong in `config.local.js`.

## Notes on csTimer's own deployment

- `dist/` is csTimer's built site for cstimer.net. Its `timer.php` includes `baidutongji.php`, which loads Baidu Analytics with cstimer.net's site id. `src/index.php` does not. If you host `dist/`, remove that include.
- csTimer sends JavaScript error reports to `bug.php` on the same site, including a browser fingerprint; bsTimer's `bug.php` stores them without the fingerprint.
- The defaults in config.js point to cstimer.net's servers and sign-in apps. The sign-in apps only accept cstimer.net's redirect URIs, so WCA and Google sign-in need your own ids on another domain.

## Tests

Unit tests: `node --test test/js/`. PHP tests: `php test/php/<name>.test.php`.

Browser tests live in `test/browser/` and run with safaridriver:
- `sync_e2e.py` — the debug transport.
- `sync_server_e2e.py` — two web devices against the real `sync.php`.
- `app_sync_e2e.py` — two app devices with a fake iCloud bridge from `test/browser/app_router.php`, plus a web device.

Warn: the browser tests erase the site data of the origin they run on, so only point them at a local test server.
