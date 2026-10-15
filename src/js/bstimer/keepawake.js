// keepawake.js: re-request the Screen Wake Lock whenever a timer starts.
'use strict';

var keepAwake = execMain(function() {
	// Bail out if the Wake Lock API is unavailable.
	if (!(navigator['wakeLock'] && navigator['wakeLock']['request'])) {
		return {};
	}

	// State: current lock, whether a request is in flight, and whether a timer is running.
	var lock = null;
	var pending = false;
	var timing = false;

	// Request a screen wake lock, skipping if hidden, pending, or already held.
	function request() {
		if (document.visibilityState !== 'visible' || pending || (lock && !lock['released'])) {
			return;
		}
		pending = true;
		navigator['wakeLock']['request']('screen').then(function(l) {
			pending = false;
			lock = l;
			l.addEventListener('release', function() {
				if (lock === l) {
					lock = null;
				}
			});
		}, function() {
			pending = false;
		});
	}

	// Wire up listeners once the page is ready.
	$(function() {
		// Re-request whenever the timer leaves idle.
		kernel.regListener('keepawake', 'timerStatus', function(signal, value) {
			timing = value !== -1;
			if (timing) {
				request();
			}
		});
		// Re-request when the page becomes visible while timing.
		document.addEventListener('visibilitychange', function() {
			if (timing) {
				request();
			}
		});
	});

	// Nothing public.
	return {};
});
