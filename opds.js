/**
 * 生成 OPDS 1.2 目录
 *
 * 结构：index.xml（所有书） → <书名>.xml（章节列表） → 指向 library/ 下的 CBZ
 *
 * 用法：node opds.js
 * 其中 BASE_URL 决定绝对地址，默认从 GitHub Actions 环境推断。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = __dirname
const ST = path.join(ROOT, 'state')
const LIB = path.join(ROOT, 'library')
const OUT = path.join(ROOT, 'opds')

// 站点根地址：GitHub Pages 形式 https://<user>.github.io/<repo>
function siteBase() {
    if (process.env.SITE_BASE) return process.env.SITE_BASE.replace(/\/+$/, '')
    const repo = process.env.GITHUB_REPOSITORY // owner/name
    if (repo) {
        const [owner, name] = repo.split('/')
        return `https://${owner}.github.io/${name}`
    }
    return 'https://example.github.io/comic-library'
}

const BASE = siteBase()
const OPDS = BASE + '/opds'
// CBZ 存在 Hugging Face，不在本仓库
const HF_REPO = process.env.HF_REPO || 'xwll/comic-library'
// 走 Cloudflare Worker 代理：HF 直链会 302，阅读器不跟随会报 404
const WORKER = process.env.HF_WORKER || 'https://hf-proxy.xwll723825.workers.dev'
const LIBURL = `${WORKER}/file/library`

const esc = (s) =>
    String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')

/** 书目录 / feed 名：纯 ASCII，避免客户端对中文 URL 编码处理不一致 */
function bookSlug(key) {
    return 'b' + crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 10)
}
function feedFileName(key) {
    return bookSlug(key) + '.xml'
}

/** 稳定的 uuid，同一本书每次生成都一样，避免客户端重复入库 */
function uuidFor(str) {
    const h = crypto.createHash('sha1').update(String(str)).digest('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

/** 兜底：拿不到话数时用章节名做文件名 */
function safeKey(k) {
    return String(k).replace(/[\/\\:*?"<>|\s]/g, '_').slice(0, 60)
}

/** 从章节 key 里取话数，用于排序 */
function epNo(key) {
    const m = /第\s*(\d+(?:\.\d+)?)\s*[話话]/.exec(key)
    return m ? Number(m[1]) : null
}

function readStates() {
    if (!fs.existsSync(ST)) return []
    return fs
        .readdirSync(ST)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_data_'))
        .map((f) => {
            const key = f.replace(/\.json$/, '')
            try {
                const st = JSON.parse(fs.readFileSync(path.join(ST, f), 'utf8'))
                return { key, ...st }
            } catch {
                return null
            }
        })
        .filter(Boolean)
}

/** 找本地封面文件（站点封面有防盗链，必须自己存一份） */
function localCover(key) {
    const dir = path.join(LIB, key)
    if (!fs.existsSync(dir)) return null
    const hit = fs.readdirSync(dir).find((f) => /^cover\.(jpg|jpeg|png|webp|gif)$/i.test(f))
    return hit ? `${LIBURL}/${encodeURIComponent(key)}/${encodeURIComponent(hit)}` : null
}

/** 列出某本书实际的 CBZ 文件 */
function listCbz(key) {
    const dir = path.join(LIB, key)
    if (!fs.existsSync(dir)) return []
    return fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.cbz'))
        .sort()
}

function build() {
    fs.mkdirSync(OUT, { recursive: true })
    // 清理旧的书籍 feed，避免删书后残留
    for (const f of fs.readdirSync(OUT)) {
        if (f.endsWith('.xml') && f !== 'index.xml') fs.unlinkSync(path.join(OUT, f))
    }

    const books = readStates()
    const entries = []
    let bookCount = 0
    let chapCount = 0

    for (const b of books) {
        // 章节来自抓取记录（CBZ 存在 Hugging Face，本地不留）
        const files = (b.done || []).map((k) => {
            const n = epNo(k)
            return (n !== null ? String(n).padStart(4, '0') : safeKey(k)) + '.cbz'
        })
        files.sort()
        if (!files.length) continue
        bookCount++
        chapCount += files.length

        const feedName = feedFileName(b.key)
        const bookUrl = `${OPDS}/${encodeURIComponent(feedName)}`

        // 该书的章节 feed
        const chEntries = files
            .map((f) => {
                const no = /^(\d+)/.exec(f)
                const num = no ? Number(no[1]) : null
                // 在 state.chapters 里找回原始章节名（更好看）
                const keyList = b.chapters || []
                const match = keyList.find((k) => {
                    const n = epNo(k)
                    return n !== null && num !== null && n === num
                })
                const title = match || f.replace(/\.cbz$/i, '')
                // CBZ 存在 HF，本地没有文件，用当前时间做 updated
                const updated = now()
                return `  <entry>
    <title>${esc(title)}</title>
    <id>urn:uuid:${uuidFor(b.key + '/' + f)}</id>
    <updated>${updated}</updated>
    <link rel="http://opds-spec.org/acquisition"
          href="${LIBURL}/${encodeURIComponent(b.key)}/${encodeURIComponent(f)}"
          type="application/zip"/>
    <link rel="http://opds-spec.org/acquisition"
          href="${LIBURL}/${bookSlug(b.key)}/${encodeURIComponent(f)}"
          type="application/vnd.comicbook+zip"/>
    <link rel="http://opds-spec.org/acquisition"
          href="${LIBURL}/${bookSlug(b.key)}/${encodeURIComponent(f)}"
          type="application/x-cbr"/>
  </entry>`
            })
            .join('\n')

        const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:uuid:${uuidFor(b.key)}</id>
  <title>${esc(b.title || b.key)}</title>
  <updated>${now()}</updated>
  <author><name>${esc(b.source || 'comic')}</name></author>
  <link rel="self" href="${bookUrl}"
        type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <link rel="start" href="${OPDS}/index.xml"
        type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="up" href="${OPDS}/index.xml"
        type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
${chEntries}
</feed>`
        fs.writeFileSync(path.join(OUT, feedName), feed)

        const content = `${files.length} 章`
        // 优先用本地存的封面；没存到才退回站点原图
        // 封面也传到了 HF，state 里记着文件名
        const cover = b.coverFile ? `${LIBURL}/${encodeURIComponent(b.key)}/${encodeURIComponent(b.coverFile)}` : b.cover
        const coverType = cover && /\.png$/i.test(cover) ? 'image/png' : cover && /\.webp$/i.test(cover) ? 'image/webp' : 'image/jpeg'
        const coverLink = cover
            ? `\n    <link rel="http://opds-spec.org/image" href="${esc(cover)}" type="${coverType}"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="${esc(cover)}" type="${coverType}"/>`
            : ''
        entries.push(`  <entry>
    <title>${esc(b.title || b.key)}</title>
    <id>urn:uuid:${uuidFor(b.key)}</id>
    <updated>${now()}</updated>
    <content type="text">${esc(content)}</content>${coverLink}
    <link rel="subsection" href="${bookUrl}"
          type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  </entry>`)
    }

    const index = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:uuid:${uuidFor('comic-library-index')}</id>
  <title>我的漫画库</title>
  <updated>${now()}</updated>
  <author><name>comic-library</name></author>
  <link rel="self" href="${OPDS}/index.xml"
        type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${OPDS}/index.xml"
        type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
${entries.join('\n')}
</feed>`
    fs.writeFileSync(path.join(OUT, 'index.xml'), index)

    console.log(`OPDS 已生成：${bookCount} 本 / ${chapCount} 章`)
    console.log(`入口地址：${OPDS}/index.xml`)
}

build()
