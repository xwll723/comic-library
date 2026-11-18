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
const LIBURL = BASE + '/library'

const esc = (s) =>
    String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')

/** 章节 feed 的文件名：纯 ASCII，避免各种客户端对中文 URL 编码处理不一致 */
function feedFileName(key) {
    return 'b' + crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 10) + '.xml'
}

/** 稳定的 uuid，同一本书每次生成都一样，避免客户端重复入库 */
function uuidFor(str) {
    const h = crypto.createHash('sha1').update(String(str)).digest('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

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

/** 章节缩略图是否已生成 */
function chapterThumb(key, cbzName) {
    const p = path.join(LIB, key, 'thumbs', cbzName.replace(/\.cbz$/i, '.jpg'))
    if (!fs.existsSync(p)) return null
    return `${LIBURL}/${encodeURIComponent(key)}/thumbs/${encodeURIComponent(path.basename(p))}`
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
        const files = listCbz(b.key)
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
                const updated = new Date(fs.statSync(path.join(LIB, b.key, f)).mtime).toISOString().replace(/\.\d+Z$/, 'Z')
                const th = chapterThumb(b.key, f)
                const thLink = th
                    ? `\n    <link rel="http://opds-spec.org/image/thumbnail" href="${esc(th)}" type="image/jpeg"/>`
                    : ''
                return `  <entry>
    <title>${esc(title)}</title>
    <id>urn:uuid:${uuidFor(b.key + '/' + f)}</id>
    <updated>${updated}</updated>${thLink}
    <link rel="http://opds-spec.org/acquisition"
          href="${LIBURL}/${encodeURIComponent(b.key)}/${encodeURIComponent(f)}"
          type="application/vnd.comicbook+zip"/>
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
        const cover = localCover(b.key) || b.cover
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
