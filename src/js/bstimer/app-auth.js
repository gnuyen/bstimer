// Hand Google sign-in results back to the bsTimer iOS app.
// The app starts Google sign-in in a system auth session, appending ".cstimer-ios" to the page's
// state; Google redirects here with #access_token=...&state=<page state>.cstimer-ios, and this
// forwards the fragment to the app's callback scheme, which closes the session. Browsers never
// add that marker, so normal web logins are unaffected.
// Load it in index.php's <head>, before csTimer's own scripts:
//   <script type="text/javascript" src="js/bstimer/app-auth.js"></script>
(function () {
	var h = location.hash;
	if (/[#&]state=([A-Za-z0-9_-]*\.)?cstimer-ios(&|$)/.test(h) && /[#&]access_token=/.test(h)) {
		location.replace('cstimerbt://auth' + h);
	}
})();
