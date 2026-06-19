/* Theme Park Co-Pilot service worker - push notifications only (no offline cache by design) */
'use strict';

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    if (event.data) { data = event.data.json(); }
  } catch (e) {
    try { data = { title: 'Theme Park Co-Pilot', body: event.data ? event.data.text() : '' }; }
    catch (e2) { data = {}; }
  }
  var title = data.title || 'Theme Park Co-Pilot';
  var options = {
    body: data.body || '',
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    tag: data.tag || 'tpcp-alert',
    renotify: true,
    data: { url: data.url || '/app.html' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/app.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf('/app.html') > -1 && 'focus' in c) { return c.focus(); }
      }
      if (self.clients.openWindow) { return self.clients.openWindow(target); }
    })
  );
});
