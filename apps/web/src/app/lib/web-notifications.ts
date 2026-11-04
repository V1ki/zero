export const webNotificationsApi = '/api/listeners/web-notifications'
export const webNotificationHistoryKey = ['listeners', 'web-notifications', 'history']

export function localWebNotifications() {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
}
