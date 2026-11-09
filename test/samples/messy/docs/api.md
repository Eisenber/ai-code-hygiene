# API 文档

本文件描述当前对外的用户接口。

## 已实现

### `fetchUser`

按 id 获取用户。

### `updateProfile`

更新用户资料。

## 待迁移

以下接口来自 `src/legacy/post.js`，V2 将不再提供：

- `fetchUserV3`：新版本的用户读取接口（尚未实现）
- `legacyPost`：旧的内容发布接口

迁移期间请继续使用 `fetchUser`。
