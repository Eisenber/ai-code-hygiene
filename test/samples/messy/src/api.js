/**
 * 用户接口（真实存在的部分）。
 */

/** @param {string} id */
export async function fetchUser(id) {
  if (!id) throw new Error('id is required');
  return { id, name: `user-${id}` };
}

/** @param {string} id */
export async function updateProfile(id, patch) {
  return { id, ...patch, updatedAt: Date.now() };
}

/** 已下线：文档里仍在引用它。 */
export function legacyPost(path, body) {
  return { path, body };
}

export const API_VERSION = '2.0.0';
