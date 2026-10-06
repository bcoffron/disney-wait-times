// Theme Park CP in-park router: Dijkstra over a curated guest-path graph,
// landmark-anchored turn steps in feet, left/right only (no compass points).
// Shared by the offline QA harness and app.html. Exposes window.TPCPRouter.
(function (global) {
  'use strict';
  var FT_PER_M = 3.28084;
  function havFt(a, b) {
    var R = 6371000, p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180;
    var dp = (b[0] - a[0]) * Math.PI / 180, dl = (b[1] - a[1]) * Math.PI / 180;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(h)) * FT_PER_M;
  }
  function bearing(a, b) {
    var dl = (b[1] - a[1]) * Math.PI / 180, p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180;
    var x = Math.sin(dl) * Math.cos(p2);
    var y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
  }
  function squash(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ').trim().replace(/^the /, '');
  }
  function fmtDist(ft) {
    if (ft < 1000) return (Math.round(ft / 10) * 10) + ' ft';
    return (ft / 5280).toFixed(2) + ' mi';
  }
  function fmtLeg(ft) { return (Math.round(ft / 10) * 10) + ' ft'; }

  function prep(graph) {
    if (graph._adjArr) return graph;
    var n = graph.nodes.length, adj = new Array(n);
    for (var i = 0; i < n; i++) adj[i] = [];
    Object.keys(graph.adj).forEach(function (k) {
      var u = +k;
      graph.adj[k].forEach(function (e) { adj[u].push([e[0], e[1]]); });
    });
    graph._adjArr = adj;
    graph._placeBySquash = {};
    (graph.places || []).forEach(function (p) {
      if (p.node != null) graph._placeBySquash[squash(p.n)] = p;
    });
    return graph;
  }
  function snap(graph, lat, lon) {
    prep(graph);
    var best = -1, bd = Infinity;
    for (var i = 0; i < graph.nodes.length; i++) {
      var d = havFt([lat, lon], graph.nodes[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return { node: best, distFt: bd };
  }
  function place(graph, name) {
    prep(graph);
    var sq = squash(name);
    if (graph._placeBySquash[sq]) return graph._placeBySquash[sq];
    // containment fallback (catalog name vs card title variants)
    var keys = Object.keys(graph._placeBySquash);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(sq) === 0 || sq.indexOf(keys[i]) === 0) return graph._placeBySquash[keys[i]];
    }
    var flat = sq.replace(/ /g, '');
    for (var k = 0; k < keys.length; k++) {
      if (keys[k].replace(/ /g, '') === flat) return graph._placeBySquash[keys[k]];
    }
    return null;
  }
  function route(graph, fromNode, toNode) {
    prep(graph);
    var n = graph.nodes.length, dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1);
    dist[fromNode] = 0;
    var heap = [[0, fromNode]];
    function push(it) { heap.push(it); var i = heap.length - 1; while (i > 0) { var par = (i - 1) >> 1; if (heap[par][0] <= heap[i][0]) break; var t = heap[par]; heap[par] = heap[i]; heap[i] = t; i = par; } }
    function pop() { var top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; var i = 0; for (;;) { var l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; var t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m; } } return top; }
    while (heap.length) {
      var cur = pop(), d = cur[0], u = cur[1];
      if (u === toNode) break;
      if (d > dist[u]) continue;
      var es = graph._adjArr[u];
      for (var j = 0; j < es.length; j++) {
        var nd = d + es[j][1];
        if (nd < dist[es[j][0]]) { dist[es[j][0]] = nd; prev[es[j][0]] = u; push([nd, es[j][0]]); }
      }
    }
    if (dist[toNode] === Infinity) return null;
    var path = [toNode];
    while (path[path.length - 1] !== fromNode) path.push(prev[path[path.length - 1]]);
    path.reverse();
    return { distFt: dist[toNode], path: path, coords: path.map(function (i) { return graph.nodes[i]; }) };
  }
  function stepsFor(graph, routeRes, fromName, toName) {
    var pts = routeRes.coords, i;
    var cum = [0];
    for (i = 1; i < pts.length; i++) cum.push(cum[i - 1] + havFt(pts[i - 1], pts[i]));
    var events = [];
    for (i = 2; i < pts.length - 1; i++) {
      var bIn = bearing(pts[i - 2], pts[i]);
      var bOut = bearing(pts[i], pts[Math.min(i + 2, pts.length - 1)]);
      var turn = (bOut - bIn + 540) % 360 - 180;
      if (Math.abs(turn) >= 42) {
        var near = null, nd = Infinity;
        (graph.places || []).forEach(function (p) {
          if (p.lat == null) return;
          var d = havFt(pts[i], [p.lat, p.lon]);
          if (d < nd) { nd = d; near = p.n; }
        });
        events.push({ at: cum[i], side: turn > 0 ? 'right' : 'left', near: nd <= 180 ? near : null });
      }
    }
    var out = [];
    // Opener: a visible place ON this route in the direction of travel.
    if (pts.length > 1) {
      var b0 = bearing(pts[0], pts[Math.min(8, pts.length - 1)]);
      var head = pts.slice(0, Math.max(3, Math.floor(pts.length * 0.6)));
      var best = null, bscore = Infinity;
      (graph.places || []).forEach(function (p) {
        if (p.lat == null || p.n === fromName || p.n === toName) return;
        var d = havFt(pts[0], [p.lat, p.lon]);
        if (d > 2500) return;
        var onRoute = false;
        for (var j = 0; j < head.length; j++) if (havFt([p.lat, p.lon], head[j]) <= 260) { onRoute = true; break; }
        if (!onRoute) return;
        var diff = Math.abs((bearing(pts[0], [p.lat, p.lon]) - b0 + 540) % 360 - 180);
        if (diff <= 45) { var sc = diff + d / 100; if (sc < bscore) { bscore = sc; best = p.n; } }
      });
      if (best) out.push({ t: 'Head toward ' + best, at: 0 });
      else {
        var dst = place(graph, toName);
        if (dst && dst.lat != null) {
          var dd = Math.abs((bearing(pts[0], [dst.lat, dst.lon]) - b0 + 540) % 360 - 180);
          if (dd <= 45) out.push({ t: 'Head toward ' + toName, at: 0 });
        }
      }
    }
    var last = 0;
    events.forEach(function (ev) {
      if (ev.at - last < 75) return; // merge exit-plaza turn clusters
      var ref = (ev.near && ev.at > 100 && ev.near !== fromName) ? ' (near ' + ev.near + ')' : '';
      out.push({ t: 'Walk ' + fmtLeg(ev.at - last) + ', then turn ' + ev.side + ref, at: Math.round(ev.at) });
      last = ev.at;
    });
    out.push({ t: 'Continue ' + fmtLeg(routeRes.distFt - last) + ' -- ' + toName + ' is ahead', at: Math.round(routeRes.distFt) });
    return out;
  }
  global.TPCPRouter = { havFt: havFt, bearing: bearing, squash: squash, fmtDist: fmtDist, snap: snap, place: place, route: route, stepsFor: stepsFor, prep: prep };
})(typeof window !== 'undefined' ? window : globalThis);
