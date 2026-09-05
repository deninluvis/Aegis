// Aegis service worker.
//
// The ONLY job this does is let notifyForContact() in script.js show local notifications
// on browsers (Chrome/Android, Safari/iOS) that refuse to run the page-level Notification()
// constructor and require ServiceWorkerRegistration.showNotification() instead. There is no
// caching, no offline support, and no push subscription — this worker never talks to a
// server and never sees a message.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Some browsers only offer the "install as app" prompt when a fetch handler is present at
// all — this one never calls respondWith(), so every request still goes straight to the
// network exactly as if this listener didn't exist.
self.addEventListener('fetch', () => {});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const contactId = e.notification.data && e.notification.data.contactId;
  e.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) {
        client.postMessage({ type: 'aegis-notification-click', contactId: contactId });
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
