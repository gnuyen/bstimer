# bsTimer

bsTimer is csTimer with a few changes that are useful when you host it yourself or run it in the bsTimer iOS app (https://github.com/gnuyen/bstimer-ios), which adds Web Bluetooth on iPhone. It tracks upstream closely; all credit for csTimer goes to cs0x7f and its contributors. Licence stays GPL-3.0.

## Changes from csTimer

- Site config: server URLs and sign-in client ids live in `src/js/config.js` instead of being spread through the code. Defaults are csTimer's own, so an unconfigured copy behaves like upstream.
- Offline support: `src/sw.js` is a working service worker. The page loads from the network when it can and from a cached copy when offline; scripts and styles are served from cache and refreshed in the background, so a deploy shows up on the second load.
- Screen Wake Lock: the screen stays awake while a timer is running (`src/js/kernel.js`).
- `src/js/app-auth.js`: hands Google sign-in back to the bsTimer iOS app. It only acts on URLs carrying `state=cstimer-ios`, which only the app adds.

## Hosting your own copy

Serve the `src/` folder with PHP (index.php picks the language).

### Site settings

Don't edit `src/js/config.js`. Create `src/js/config.local.js` (git ignores it) and set only what differs; index.php loads it before config.js. For example:

```js
var SITE_CONFIG = {
	'dataServer': 'https://timer.example.org/',
	'wcaClientId': '<your WCA application id>',
	'googleClientId': '<your id>.apps.googleusercontent.com'
};
```

| Setting | Used for | Default |
|---|---|---|
| dataServer | Base URL (with trailing slash) of `userdata2.php` (Export → upload/download to server) and `comp.php` (online competitions). These server scripts aren't part of csTimer's source; leave the default or host your own. | `https://cstimer.net/` |
| battleSocket | WebSocket for the battle tool | `wss://cstimer.net/ws20230409` |
| wcaClientId | WCA sign-in. Register an application at worldcubeassociation.org and add your page URL as a redirect URI. The token exchange happens in `oauthwca.php` on your server, which needs your application id and secret and a referrer pattern matching your domain. | csTimer's |
| googleClientId | Google Drive backup sign-in. Create an OAuth client in Google Cloud and list your redirect URI. | csTimer's |
| wcaRedirectUri, googleRedirectUri | Redirect URI sent when signing in, if it must differ from the page's own URL (for example without a trailing slash). | the page URL without its query |

### Deploying

Upload `src/` to your web server, including your `src/js/config.local.js`. Don't overwrite server-side scripts that hold your own secrets, such as a customised `oauthwca.php`.

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
- csTimer reports JavaScript errors to `stat.php` on the same site with a browser fingerprint; without such a script the requests simply fail.
- The defaults in config.js point to cstimer.net's servers and sign-in apps. The sign-in apps only accept cstimer.net's redirect URIs, so WCA and Google sign-in need your own ids on another domain.
