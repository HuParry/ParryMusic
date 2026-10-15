## 阿里云OSS静态网站托管

OSS静态网站托管功能，支持将存储在存储空间（Bucket）中的静态文件（如HTML、CSS、JavaScript等）直接发布为一个公开访问的网站，无需维护传统服务器即可实现高可用网站部署，显著降低运维成本和技术门槛。

在项目根目录运行 [upload-oss.sh](./upload-oss.sh) 脚本，将项目文件上传到 Bucket 的网站目录，关于脚本的说明见[upload-oss.sh使用说明](upload-guide.md)。

在 OSS Bucket「静态页面」设置默认首页为 **index.html**（在Bucket左侧菜单栏单击数据管理 > 静态页面）。子目录首页选择**开通**，文件 404 规则选择**Index**，默认404页为**error.html**，错误文档响应码为**404**。

需要允许访客匿名读取这些网站文件与音乐对象，通常采用「公共读」；无需允许公开写入。

绑定自己的域名并配置 HTTPS，通过该网站域名访问。中国内地地域的自定义域名须按阿里云要求完成备案。详见 [OSS 官方静态网站文档](https://help.aliyun.com/zh/oss/user-guide/hosting-static-websites)。

页面始终使用相对路径，也可以整体部署在 `/player/` 这样的子目录；访问子目录时使用 `/player/` 或 `/player/index.html`。

建议 index.html、config.js、music/playlist.js 使用 Cache-Control: no-cache，保证浏览器能读取更新。如果使用 CDN，更新后同步刷新这些文件的缓存。音乐和封面可使用较长缓存，但替换同名文件时也应刷新缓存。

