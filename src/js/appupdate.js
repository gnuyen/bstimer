"use strict";

// Tells users of an old bsTimer iOS app that a newer build exists. The app adds
// "bsTimer/<revision>" to its user agent; the newest revision comes from
// siteConfig['latestAppRevision'] (0 turns the check off). Shown at most once a day.
var appUpdate = execMain(function() {
	var m = /\bbsTimer\/(\d+)/.exec(navigator.userAgent);
	var current = m ? ~~m[1] : 0;
	var latest = ~~siteConfig['latestAppRevision'];

	function check() {
		if (!current || !latest || current >= latest) {
			return;
		}
		var key = 'bstimerUpdateHint';
		var mark = latest + '|' + new Date().toDateString();
		try {
			if (localStorage[key] == mark) {
				return;
			}
			localStorage[key] = mark;
		} catch (e) {}
		logohint.push('bsTimer app r' + latest + ' is available (this is r' + current + ')');
	}

	$(function() {
		setTimeout(check, 3000);
	});

	return {
		current: current,
		latest: latest
	};
});
