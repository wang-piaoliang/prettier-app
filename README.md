# prettier

皮肤状态与妆容的长期观察 —— 手机 App（PWA）。

**这个仓库是公开的，里面只有代码，没有任何个人数据。**

照片、观察记录、本人背景全部存在另一个**私有**仓库里，
App 打开后要填 GitHub 令牌才能读到。令牌只存在你自己的设备上。

## 打开

<https://wang-piaoliang.github.io/prettier-app/>

Safari 打开 → 分享 → 添加到主屏幕，就是一个独立 App。

首次进入要填两项：

| | |
|---|---|
| 数据仓库 | `用户名/仓库名`，你自己的私有仓库 |
| GitHub 令牌 | Settings → Developer settings → Personal access tokens → **Fine-grained tokens**，只勾这一个仓库，权限给 **Contents: Read and write** |

## 数据仓库的结构

```
entries.json      全部观察记录
settings.json     主线问题、评分维度、本人背景
photos/<记录id>/NN.jpg
```

每次改动都是一次 commit，所以任何记录和照片都能回到历史上任意一版。

## 文件

- `index.html` —— 入口：令牌页 + 时间线/趋势/记一条/主线
- `assets/store.js` —— GitHub 仓库当数据库的**通用**存储层（用 Git Data API，
  一条记录连同照片打包成一次提交，不会留下半截状态）
- `assets/photo.js` —— 压平 iPhone 的 HDR + 亮度归一。
  不做这一步的话每张照片明暗都不同，色斑深浅没法纵向比
- `assets/app.js` —— 界面逻辑
- `sw.js` —— 离线缓存，**只缓存外壳，不缓存照片**

## 为什么用 GitHub 当后端

原本用 Cloudflare Workers + D1 + KV，但 `workers.dev` 和 `pages.dev`
在国内网络下 DNS 被污染（实测 `pages.dev` 解析到 `127.0.0.1`），
手机不挂代理打不开。`api.github.com` 实测直连 0.44s 可用，于是改用它。

## 改了外壳之后

把 `sw.js` 里的 `VERSION` 加一，否则装过的设备会继续用旧缓存。
（外壳走网络优先，所以正常情况下刷新就会更新。）
