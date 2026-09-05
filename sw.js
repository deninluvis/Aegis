// Aegis service worker.
//
// Two jobs, both purely local:
// 1. Let notifyForContact() in script.js show notifications on browsers (Chrome/Android,
//    Safari/iOS) that refuse to run the page-level Notification() constructor and require
//    ServiceWorkerRegistration.showNotification() instead.
// 2. Show a notification when a real Web Push arrives — this is what wakes the app even
//    when it isn't running. The push payload is end-to-end encrypted by the browser before
//    it ever leaves this device's registration step, and the relay that delivers it only
//    ever carries a display name/avatar and a room code, never message content.
//
// There is no caching and no offline support — every other request goes straight to network.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Some browsers only offer the "install as app" prompt when a fetch handler is present at
// all — this one never calls respondWith(), so every request still goes straight to the
// network exactly as if this listener didn't exist.
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = data.title || 'Aegis';
  const body = data.body || 'You have a new message';
  e.waitUntil(self.registration.showNotification(title, {
    body: body,
    tag: data.tag || 'aegis-push',
    icon: 'icon-192.png',
    data: { roomCode: data.roomCode },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const contactId = e.notification.data && e.notification.data.contactId;
  const roomCode = e.notification.data && e.notification.data.roomCode;
  e.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) {
        client.postMessage({ type: 'aegis-notification-click', contactId: contactId, roomCode: roomCode });
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
