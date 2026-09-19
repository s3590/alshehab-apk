/*
 * Firebase Cloud Messaging Service Worker
 * الشهاب Pro
 *
 * ملاحظات مهمة:
 * 1) هذا الملف مخصص لإشعارات الويب وPWA.
 * 2) تطبيق Capacitor الأصلي يعتمد على إضافة Push Notifications وقد لا يستخدم هذا الملف
 *    عند تشغيل APK؛ يجب التعامل مع إشعارات Capacitor داخل كود التطبيق أيضًا.
 * 3) غيّر CACHE_VERSION عند وجود تغيير جوهري في ملفات التطبيق أو استراتيجية التخزين المؤقت.
 */

'use strict';

/* -------------------------------------------------------------------------- */
/* 1. Firebase SDK                                                              */
/* -------------------------------------------------------------------------- */

importScripts(
  'https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js'
);

const SERVER_URL = 'https://my-bot-ehio.onrender.com';
const CACHE_VERSION = 'CACHE_VERSION_PLACEHOLDER';
const CACHE_NAME = `shehab-offline-${CACHE_VERSION}`;
const FCM_SDK_VERSION = '8.10.1';

firebase.initializeApp({
  apiKey: 'AIzaSyBBYxCDcGilfl_xAiAFzaYH-G-7L_jR7Zo',
  authDomain: 'alshehab-pro.firebaseapp.com',
  projectId: 'alshehab-pro',
  storageBucket: 'alshehab-pro.firebasestorage.app',
  messagingSenderId: '356161376498',
  appId: '1:356161376498:web:6b76713ca26e4e3c76c06b'
});

const messaging = firebase.messaging();

/* -------------------------------------------------------------------------- */
/* 2. Static assets                                                             */
/* -------------------------------------------------------------------------- */

const CORE_ASSETS = [
  '/',
  '/static/manifest.json',
  '/static/logo.png',
  '/static/localforage.min.js',
  '/static/100.png',
  '/static/250.png',
  '/static/500.png',
  '/static/1000.png',
  '/static/3000.png',
  '/static/yemen_mobile.png',
  '/static/you.png',
  '/static/sabafon.png',
  '/static/y.png',
  '/static/adsl.png',
  `https://www.gstatic.com/firebasejs/${FCM_SDK_VERSION}/firebase-app.js`,
  `https://www.gstatic.com/firebasejs/${FCM_SDK_VERSION}/firebase-messaging.js`
];

/* -------------------------------------------------------------------------- */
/* 3. Small utilities                                                           */
/* -------------------------------------------------------------------------- */

function isSameOrigin(url) {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch (_) {
    return false;
  }
}

function isApiRequest(request) {
  try {
    const url = new URL(request.url);
    return (
      url.origin === APP_ORIGIN &&
      (url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/webhook/') ||
        url.pathname.startsWith('/auth/') ||
        url.pathname.startsWith('/login') ||
        url.pathname.startsWith('/logout'))
    );
  } catch (_) {
    return true;
  }
}

function isCacheableResponse(response) {
  // 🌟 التعديل: السماح بالاستجابات الناجحة (200) أو العابرة للنطاقات (Opaque/CORS) لكي تظهر الصور في تطبيق الأندرويد
  return Boolean(
    response &&
      (response.ok || response.status === 0 || response.status === 200) &&
      (response.type === 'basic' || response.type === 'default' || response.type === 'cors' || response.type === 'opaque') &&
      !response.headers.has('set-cookie')
  );
}

function normaliseString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim();
}

function parsePayloadData(payload) {
  const data = payload && payload.data && typeof payload.data === 'object'
    ? payload.data
    : {};

  const notification = payload && payload.notification && typeof payload.notification === 'object'
    ? payload.notification
    : {};

  return {
    title: normaliseString(data.title || notification.title, 'إشعار جديد'),
    body: normaliseString(data.body || notification.body, ''),
    icon: normaliseString(data.icon, LOGO_URL),
    badge: normaliseString(data.badge, LOGO_URL),
    route: normaliseString(data.route || data.action || data.url, ''),
    data
  };
}

function safeNotificationActions(rawActions) {
  if (!rawActions) return [];

  try {
    const parsed = typeof rawActions === 'string' ? JSON.parse(rawActions) : rawActions;
    if (!Array.isArray(parsed)) return [];

    // نسمح فقط بالحقول التي يفهمها Notification API، وبعدد محدود من الأزرار.
    return parsed
      .slice(0, 3)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        action: normaliseString(item.action).slice(0, 64),
        title: normaliseString(item.title).slice(0, 64),
        icon: normaliseString(item.icon).slice(0, 512)
      }))
      .filter((item) => item.action && item.title);
  } catch (error) {
    console.warn('[FCM] Invalid notification actions:', error);
    return [];
  }
}

function buildAppUrl(route, data = {}) {
  const url = new URL('/', APP_ORIGIN);

  // لا نسمح بفتح نطاق خارجي من بيانات الإشعار.
  if (route) {
    const cleanRoute = String(route).replace(/^[/#?]+/, '').slice(0, 128);
    if (cleanRoute) url.searchParams.set('action', cleanRoute);
  }

  // تمرير معرّف آمن ومحدود عند الحاجة، وليس كامل payload.
  const notificationId = normaliseString(data.notification_id || data.id).slice(0, 128);
  if (notificationId) url.searchParams.set('notification_id', notificationId);

  return url.href;
}

async function broadcastMessage(message) {
  const windowClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });

  for (const client of windowClients) {
    try {
      client.postMessage(message);
    } catch (error) {
      console.warn('[SW] Could not message client:', error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 4. Background FCM messages                                                  */
/* -------------------------------------------------------------------------- */

messaging.onBackgroundMessage(async (payload) => {
  const details = parsePayloadData(payload);
  const data = details.data;

  // الرسائل الصامتة تستخدم لتنبيه التطبيق بالمزامنة دون إظهار إشعار للمستخدم.
  if (data.is_silent === 'true' || data.silent === 'true') {
    await syncOfflineQueue();
    return;
  }

  const options = {
    body: details.body,
    icon: isSameOrigin(details.icon) ? details.icon : LOGO_URL,
    badge: isSameOrigin(details.badge) ? details.badge : LOGO_URL,
    dir: 'rtl',
    lang: 'ar',
    tag: normaliseString(data.notification_tag || data.tag, 'shehab-notification').slice(0, 64),
    renotify: data.renotify === 'true',
    requireInteraction: data.requireInteraction === 'true',
    vibrate: [200, 100, 200],
    data: {
      ...data, // 🚀 السطر المنقذ: تمرير كل البيانات القادمة من السيرفر (مثل client_id و order_id) وعدم مسحها!
      route: details.route,
      notification_id: normaliseString(data.notification_id || data.id).slice(0, 128),
      source: 'firebase-messaging',
      received_at: new Date().toISOString()
    }
  };

  const actions = safeNotificationActions(data.actions);
  if (actions.length > 0) options.actions = actions;

  await self.registration.showNotification(details.title, options);
});

/* -------------------------------------------------------------------------- */
/* 5. Notification click handling (Smart Deep Linking & Inline Actions)        */
/* -------------------------------------------------------------------------- */

self.addEventListener('notificationclick', (event) => {
  event.notification.close(); // إغلاق الإشعار فوراً عند النقر

  const notificationData = event.notification.data || {};
  const actionId = normaliseString(event.action);
  const replyText = normaliseString(event.reply).slice(0, 1000);
  
  // استخراج المسار والبيانات للتوجيه الذكي
  const route = normaliseString(notificationData.route || '');
  const clientId = normaliseString(notificationData.client_id || '');
  const orderId = normaliseString(notificationData.order_id || '');

  // بناء الرابط العميق لفتحه إذا كان التطبيق مغلقاً تماماً (مع تمرير الرد المباشر)
  let urlParams = new URLSearchParams();
  if (route) urlParams.append('action', route);
  if (clientId) urlParams.append('client_id', clientId);
  if (orderId) urlParams.append('order_id', orderId);
  if (actionId) urlParams.append('action_id', actionId); // 👈 تمرير نوع الزر
  if (replyText) urlParams.append('reply_text', replyText); // 👈 تمرير نص الرد
  
  const queryString = urlParams.toString() ? '?' + urlParams.toString() : '';
  const targetUrl = new URL('/', self.location.origin).href + queryString;

  event.waitUntil((async () => {
    // مسح العداد من أيقونة التطبيق
    if ('clearAppBadge' in navigator) {
      try { await navigator.clearAppBadge(); } catch (_) {}
    }

    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    // 1. إذا كان التطبيق مفتوحاً في الخلفية، نركز عليه ونرسل له التوجيه الذكي والرد
    for (const client of windowClients) {
      if (isSameOrigin(client.url) && 'focus' in client) {
        await client.focus();
        
        client.postMessage({
          type: 'DEEP_LINK',
          route: route,
          client_id: clientId,
          order_id: orderId,
          actionId: actionId,
          inputValue: replyText
        });
        return;
      }
    }

    // 2. إذا كان التطبيق مغلقاً تماماً (Cold Start)، نفتح نافذة جديدة بالرابط المجهز
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

/* -------------------------------------------------------------------------- */
/* 6. Install and activate                                                     */
/* -------------------------------------------------------------------------- */

self.addEventListener('install', (event) => {
  // تفعيل النسخة الجديدة بعد اكتمال التثبيت.
  self.skipWaiting();

  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // فشل أصل واحد لا يمنع تثبيت بقية Service Worker.
    await Promise.all(
      CORE_ASSETS.map(async (assetUrl) => {
        try {
          const response = await fetch(assetUrl, {
            cache: 'no-cache',
            credentials: 'same-origin'
          });
          if (isCacheableResponse(response)) {
            await cache.put(assetUrl, response);
          }
        } catch (error) {
          console.warn('[SW] Could not precache:', assetUrl, error);
        }
      })
    );
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();

    // حذف إصدارات هذا التطبيق فقط، دون حذف Cache خاص بتطبيقات أخرى.
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith('shehab-offline-') && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    );

    await self.clients.claim();
  })());
});

/* -------------------------------------------------------------------------- */
/* 7. Fetch strategy                                                           */
/* -------------------------------------------------------------------------- */

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Service Worker يجب ألا يعترض POST أو API أو Webhook أو طلبات تسجيل الدخول.
  if (request.method !== 'GET' || isApiRequest(request)) return;

  let requestUrl;
  try {
    requestUrl = new URL(request.url);
  } catch (_) {
    return;
  }

  // لا نخزّن مصادر خارجية عامة إلا إذا كانت ضمن أصول التطبيق المحددة مسبقًا.
  const allowedExternalFirebase =
    requestUrl.origin === 'https://www.gstatic.com' &&
    requestUrl.pathname.startsWith(`/firebasejs/${FCM_SDK_VERSION}/`);

  if (requestUrl.origin !== APP_ORIGIN && !allowedExternalFirebase) return;

  event.respondWith((async () => {
    const cachedResponse = await caches.match(request, { ignoreSearch: true });

    // للصفحات: الشبكة أولًا لضمان حصول المستخدم على آخر نسخة، ثم Offline fallback.
    if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
      try {
        const networkResponse = await fetch(request);
        if (isCacheableResponse(networkResponse)) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(APP_SHELL_URL, networkResponse.clone());
        }
        return networkResponse;
      } catch (_) {
        return cachedResponse || caches.match(APP_SHELL_URL, { ignoreSearch: true });
      }
    }

    // للصور وملفات JS/CSS: Cache First مع تحديث الخلفية.
    if (cachedResponse) {
      event.waitUntil((async () => {
        try {
          const networkResponse = await fetch(request);
          if (isCacheableResponse(networkResponse)) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, networkResponse.clone());
          }
        } catch (_) {
          // النسخة المخزنة تكفي عند عدم توفر الشبكة.
        }
      })());
      return cachedResponse;
    }

    try {
      const networkResponse = await fetch(request);
      if (isCacheableResponse(networkResponse)) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    } catch (_) {
      return new Response('', {
        status: 504,
        statusText: 'Offline'
      });
    }
  })());
});

/* -------------------------------------------------------------------------- */
/* 8. Background sync                                                          */
/* -------------------------------------------------------------------------- */

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-offline-data') {
    event.waitUntil(syncOfflineQueue());
  }
});

async function syncOfflineQueue() {
  try {
    await broadcastMessage({
      type: 'TRIGGER_SYNC',
      source: 'service-worker',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[SW] Sync error:', error);
  }
}

/* -------------------------------------------------------------------------- */
/* 9. Messages from the application                                            */
/* -------------------------------------------------------------------------- */

self.addEventListener('message', (event) => {
  const message = event.data || {};

  if (message.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (message.type === 'TRIGGER_SYNC') {
    event.waitUntil(syncOfflineQueue());
  }
});
