# 我的漫画库

自动抓取漫画 → 打包成 CBZ → 生成 OPDS，用可达阅读器等支持 OPDS 的客户端在线看。

## 在可达阅读器里添加

填这个地址（OPDS 1.2）：

```
https://xwll723.github.io/comic-library/opds/index.xml
```

添加后能看到书目，点进去是章节列表，点章节会下载 CBZ。

## 怎么加书 / 删书

编辑 `books.txt`，一行一本，书名或链接都行：

```
# 井号开头是注释
超能立方
星star
我独自升级
```

提交后会自动触发一次抓取。

## 它是怎么工作的

```
books.txt（你写）
    ↓
GitHub Actions 每天 6:00（北京时间）自动运行
    ↓
用内置的四个源搜索 → 抓取新章节 → 下载图片 → 打包 CBZ
    ↓
写进 library/ 目录 → 生成 opds/ 下的 XML
    ↓
GitHub Pages 自动发布 → 阅读器读取
```

几个设计：

- **只抓新章节**：每次对比 `state/` 里记录的进度，抓过的不会重复抓
- **内置多源**：包子 / G站 / 拷贝 / 嬉皮，某本书在某个源数据坏了会自动换下一个源
- **域名记忆**：源会把可用的镜像域名记在 `state/_data_*.json`，下次不用重新试探
- **每本每次最多 5 章**：避免单次跑太久，可以改 `.github/workflows/daily.yml` 里的 `CRAWL_LIMIT`

## 目录结构

```
books.txt            书单
crawl.js             抓取主流程
opds.js              OPDS 生成
runtime.js           让 Venera 源能在 Node 里跑
zip.js               CBZ 打包
library/<书名>/       下载的 CBZ
state/<书名>.json     每本书的抓取进度
state/_data_*.json   源的内部状态（可用域名等）
opds/                生成的 OPDS 目录
```

## 手动运行

在 Actions 页面点「Run workflow」即可，也可以本地跑：

```bash
node crawl.js --limit 3      # 每本最多 3 章
node opds.js
```

## 已知限制

- 仓库和 Pages 都有约 1GB 的软上限，攒多了需要清理（或者改用外部对象存储）
- 部分漫画在源站本身数据损坏（章节图 404），会被自动跳过并换源；所有源都坏的书抓不到
- 时间不精确：Actions 的定时任务在高峰期可能延迟几十分钟
