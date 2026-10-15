'use strict';

var syncMerge = (function() {
	// deep clone of JSON data (never mutate inputs)
	function clone(x) {
		return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
	}
	// JSON equality (inputs are JSON data)
	function eq(a, b) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	// solve identity: timestamp | raw time | scramble
	function solveKey(solve) {
		return solve[3] + '|' + solve[0][1] + '|' + solve[1];
	}
	// turn a solve list into { id: solve } with occurrence counters
	function keySolves(list) {
		var out = {}, counts = {}, i, k, id;
		for (i = 0; i < list.length; i++) {
			k = solveKey(list[i]);
			counts[k] = (counts[k] || 0) + 1;
			id = k + '#' + (counts[k] - 1);
			out[id] = list[i];
		}
		return out;
	}
	// three-way value merge; returns { v, has, conflict }
	function mergeValue(b, bHas, l, lHas, r, rHas) {
		var res = { v: undefined, has: false, conflict: false };
		if (lHas && rHas) {
			if (eq(l, r)) { res.v = l; res.has = true; }
			else if (bHas && eq(b, l)) { res.v = r; res.has = true; }
			else if (bHas && eq(b, r)) { res.v = l; res.has = true; }
			else { res.v = l; res.has = true; res.conflict = true; }
		} else if (lHas) {
			if (bHas && eq(b, l)) { res.has = false; }
			else { res.v = l; res.has = true; }
		} else if (rHas) {
			if (bHas && eq(b, r)) { res.has = false; }
			else { res.v = r; res.has = true; }
		}
		return res;
	}
	// did the session change relative to base? (solves or non-derived meta)
	function sessionChanged(baseS, curS) {
		if (!eq(baseS['solves'], curS['solves'])) { return true; }
		var bm = baseS['meta'] || {}, cm = curS['meta'] || {}, k;
		for (k in bm) {
			if (Object.prototype.hasOwnProperty.call(bm, k) && k !== 'stat' && k !== 'date' && !eq(bm[k], cm[k])) { return true; }
		}
		for (k in cm) {
			if (Object.prototype.hasOwnProperty.call(cm, k) && k !== 'stat' && k !== 'date' && !eq(cm[k], bm[k])) { return true; }
		}
		return false;
	}
	// merge one session; b may be undefined
	function mergeSession(b, l, r, conflicts) {
		var bK = b ? keySolves(b['solves']) : {};
		var lK = l ? keySolves(l['solves']) : {};
		var rK = r ? keySolves(r['solves']) : {};
		var ids = [], seen = {}, i, id, res, out = [];
		// order: local first, then remote, then base (stable tie-break)
		for (id in lK) { if (Object.prototype.hasOwnProperty.call(lK, id)) { ids.push(id); seen[id] = true; } }
		for (id in rK) { if (Object.prototype.hasOwnProperty.call(rK, id) && !seen[id]) { ids.push(id); seen[id] = true; } }
		for (id in bK) { if (Object.prototype.hasOwnProperty.call(bK, id) && !seen[id]) { ids.push(id); seen[id] = true; } }
		for (i = 0; i < ids.length; i++) {
			id = ids[i];
			res = mergeValue(
				bK[id], Object.prototype.hasOwnProperty.call(bK, id),
				lK[id], Object.prototype.hasOwnProperty.call(lK, id),
				rK[id], Object.prototype.hasOwnProperty.call(rK, id)
			);
			if (res.conflict) { conflicts['n']++; }
			if (res.has) { out.push(res.v); }
		}
		// stable sort by timestamp ascending
		out.sort(function(a, b2) { return a[3] - b2[3]; });
		// meta: drop derived stat/date; merge opt per key; mergeValue per other key
		var bm = b ? (b['meta'] || {}) : {};
		var lm = l ? (l['meta'] || {}) : {};
		var rm = r ? (r['meta'] || {}) : {};
		var mkeys = {}, mk, meta = {};
		for (mk in bm) { if (Object.prototype.hasOwnProperty.call(bm, mk)) { mkeys[mk] = true; } }
		for (mk in lm) { if (Object.prototype.hasOwnProperty.call(lm, mk)) { mkeys[mk] = true; } }
		for (mk in rm) { if (Object.prototype.hasOwnProperty.call(rm, mk)) { mkeys[mk] = true; } }
		for (mk in mkeys) {
			if (!Object.prototype.hasOwnProperty.call(mkeys, mk)) { continue; }
			if (mk === 'stat' || mk === 'date') { continue; }
			if (mk === 'opt') {
				var bo = bm['opt'] || {}, lo = lm['opt'] || {}, ro = rm['opt'] || {}, ok, or;
				for (ok in bo) { if (Object.prototype.hasOwnProperty.call(bo, ok)) { mkeys['opt:' + ok] = true; } }
				for (ok in lo) { if (Object.prototype.hasOwnProperty.call(lo, ok)) { mkeys['opt:' + ok] = true; } }
				for (ok in ro) { if (Object.prototype.hasOwnProperty.call(ro, ok)) { mkeys['opt:' + ok] = true; } }
				meta['opt'] = {};
				for (ok in mkeys) {
					if (!Object.prototype.hasOwnProperty.call(mkeys, ok) || ok.indexOf('opt:') !== 0) { continue; }
					ok = ok.substring(4);
					or = mergeValue(bo[ok], Object.prototype.hasOwnProperty.call(bo, ok),
						lo[ok], Object.prototype.hasOwnProperty.call(lo, ok),
						ro[ok], Object.prototype.hasOwnProperty.call(ro, ok));
					if (or.conflict) { conflicts['n']++; }
					if (or.has) { meta['opt'][ok] = or.v; }
				}
			} else {
				res = mergeValue(bm[mk], Object.prototype.hasOwnProperty.call(bm, mk),
					lm[mk], Object.prototype.hasOwnProperty.call(lm, mk),
					rm[mk], Object.prototype.hasOwnProperty.call(rm, mk));
				if (res.conflict) { conflicts['n']++; }
				if (res.has) { meta[mk] = res.v; }
			}
		}
		return { 'meta': meta, 'solves': out };
	}
	function merge(base, local, remote, opts) {
		var conflicts = { 'n': 0 };
		var bS = base ? (base['sessions'] || {}) : {};
		var lS = local ? (local['sessions'] || {}) : {};
		var rS = remote ? (remote['sessions'] || {}) : {};
		var bP = base ? (base['properties'] || {}) : {};
		var lP = local ? (local['properties'] || {}) : {};
		var rP = remote ? (remote['properties'] || {}) : {};
		var localOnly = (opts && opts['localOnly']) ? opts['localOnly'] : [];
		var i, uid, res, merged = {};
		// first-sync: rename local sessions that share a solveKey with an unmatched remote session
		if (base === null) {
			var lKeys = {}, rKeys = {}, k;
			for (k in lS) { if (Object.prototype.hasOwnProperty.call(lS, k)) { lKeys[k] = true; } }
			for (k in rS) { if (Object.prototype.hasOwnProperty.call(rS, k)) { rKeys[k] = true; } }
			var matched = {}, renames = {};
			for (uid in lS) {
				if (!Object.prototype.hasOwnProperty.call(lS, uid) || rKeys[uid]) { continue; }
				var lSet = {}, ls, j;
				for (j = 0; j < lS[uid]['solves'].length; j++) { lSet[solveKey(lS[uid]['solves'][j])] = true; }
				for (k in rS) {
					if (!Object.prototype.hasOwnProperty.call(rS, k) || lKeys[k] || matched[k]) { continue; }
					var found = false;
					for (j = 0; j < rS[k]['solves'].length; j++) {
						if (lSet[solveKey(rS[k]['solves'][j])]) { found = true; break; }
					}
					if (found) {
						renames[uid] = k;
						matched[k] = true;
						break;
					}
				}
			}
			// Move each matched local session to its remote uid; the local uid disappears.
			var renamedLS = {};
			for (uid in lS) {
				if (Object.prototype.hasOwnProperty.call(lS, uid)) {
					renamedLS[renames[uid] || uid] = lS[uid];
				}
			}
			lS = renamedLS;
		}
		// union of session uids
		var uids = {}, u;
		for (u in bS) { if (Object.prototype.hasOwnProperty.call(bS, u)) { uids[u] = true; } }
		for (u in lS) { if (Object.prototype.hasOwnProperty.call(lS, u)) { uids[u] = true; } }
		for (u in rS) { if (Object.prototype.hasOwnProperty.call(rS, u)) { uids[u] = true; } }
		for (u in merged) { if (Object.prototype.hasOwnProperty.call(merged, u)) { uids[u] = true; } }
		for (uid in uids) {
			if (!Object.prototype.hasOwnProperty.call(uids, uid)) { continue; }
			var bH = Object.prototype.hasOwnProperty.call(bS, uid);
			var lH = Object.prototype.hasOwnProperty.call(lS, uid);
			var rH = Object.prototype.hasOwnProperty.call(rS, uid);
			var mH = Object.prototype.hasOwnProperty.call(merged, uid);
			if (mH) {
				// first-sync matched: local renamed to remote uid
				res = mergeSession(bS[uid], merged[uid], rS[uid], conflicts);
				merged[uid] = res;
			} else if (lH && rH) {
				merged[uid] = mergeSession(bS[uid], lS[uid], rS[uid], conflicts);
			} else if (lH) {
				if (bH) {
					if (sessionChanged(bS[uid], lS[uid])) {
						// changed locally, deleted remotely: keep local edits
						merged[uid] = mergeSession(bS[uid], lS[uid], bS[uid], conflicts);
					}
					// else unchanged: deleted remotely -> drop
				} else {
					merged[uid] = mergeSession(undefined, lS[uid], undefined, conflicts);
				}
			} else if (rH) {
				if (bH) {
					if (sessionChanged(bS[uid], rS[uid])) {
						merged[uid] = mergeSession(bS[uid], bS[uid], rS[uid], conflicts);
					}
				} else {
					merged[uid] = mergeSession(undefined, undefined, rS[uid], conflicts);
				}
			}
		}
		// renumber ranks 1..n by (rank asc, uid asc)
		var order = [], t;
		for (t in merged) { if (Object.prototype.hasOwnProperty.call(merged, t)) { order.push(t); } }
		order.sort(function(a, b2) {
			var ra = merged[a]['meta']['rank'], rb = merged[b2]['meta']['rank'];
			if (ra < rb) { return -1; }
			if (ra > rb) { return 1; }
			if (a < b2) { return -1; }
			if (a > b2) { return 1; }
			return 0;
		});
		for (i = 0; i < order.length; i++) { merged[order[i]]['meta']['rank'] = i + 1; }
		// properties
		var props = {}, pk;
		for (pk in bP) { if (Object.prototype.hasOwnProperty.call(bP, pk)) { props[pk] = true; } }
		for (pk in lP) { if (Object.prototype.hasOwnProperty.call(lP, pk)) { props[pk] = true; } }
		for (pk in rP) { if (Object.prototype.hasOwnProperty.call(rP, pk)) { props[pk] = true; } }
		var outProps = {};
		for (pk in props) {
			if (!Object.prototype.hasOwnProperty.call(props, pk)) { continue; }
			var isLocal = false, li;
			for (li = 0; li < localOnly.length; li++) { if (localOnly[li] === pk) { isLocal = true; break; } }
			if (isLocal) {
				if (Object.prototype.hasOwnProperty.call(lP, pk)) { outProps[pk] = lP[pk]; }
			} else {
				res = mergeValue(bP[pk], Object.prototype.hasOwnProperty.call(bP, pk),
					lP[pk], Object.prototype.hasOwnProperty.call(lP, pk),
					rP[pk], Object.prototype.hasOwnProperty.call(rP, pk));
				if (res.conflict) { conflicts['n']++; }
				if (res.has) { outProps[pk] = res.v; }
			}
		}
		return { 'snapshot': clone({ 'sessions': merged, 'properties': outProps }), 'conflicts': conflicts['n'] };
	}
	return { 'merge': merge, 'solveKey': solveKey };
})();
