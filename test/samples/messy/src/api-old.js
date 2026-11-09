/**
 * 旧版接口实现——功能已被 src/api.js 取代。
 * 保留原因不详，可能是某次重构时忘了删。
 */

export async function fetchLegacyUser(id) {
  return { id, legacy: true };
}
