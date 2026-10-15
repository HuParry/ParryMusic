## upload-oss.sh

[upload-oss.sh](upload-oss.sh)是一个同步本地文件到OSS的脚本文件，方便用户上传资源到OSS。

脚本需要用到阿里云OSS的[ossutil 2.x](https://help.aliyun.com/zh/oss/developer-reference/ossutil-overview/?spm=a2c4g.11186623.0.0.123b1102Z0zo0m)工具，请提前下载安装好。

需要在脚本中修改以下变量值：
```shell
# ---------- 在这里填写配置 ----------
OSSUTIL_BIN='ossutil'                 # 也可填二进制绝对路径，例如 /usr/local/bin/ossutil
BUCKET='YOUR_BUCKET'
PREFIX=''                            # Bucket 根目录留空；子目录示例：parrymusic
REGION='cn-hangzhou'                  # Bucket 所在地域
ENDPOINT=''                          # 留空使用该地域的公网 Endpoint；也可填写完整 https:// 地址
ACCESS_KEY_ID='YOUR_ACCESS_KEY_ID'
ACCESS_KEY_SECRET='YOUR_ACCESS_KEY_SECRET'
STS_TOKEN=''                         # 使用临时凭据时填写，否则留空
# ------------------------------------
```
BUCKET、REGION、ACCESS_KEY_ID、ACCESS_KEY_SECRET是必填项。

配置好OSS bucket相关参数后，执行脚本就能上传（需在项目根目录下执行脚本）：
```shell
bash upload-oss.sh
```
