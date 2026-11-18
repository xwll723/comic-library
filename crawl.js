/**
 * 漫画抓取主流程
 *
 * 读 books.txt → 逐本在四个源里找 → 抓新章节 → 打包 CBZ → 写进 library/ → 更新 state
 *
 * 用法：
 *   node crawl.js                 抓所有书的新章节
 *   node crawl.js --limit 2       每本书最多抓 2 章（测试用）
 *   node crawl.js --book 我独自升级  只抓一本
 */
const fs = require('fs')
const path = require('path')
const { loadSource } = require('./runtime')
const { makeCbz } = require('./zip')

const ROOT = __dirname
const LIB = path.join(ROOT, 'library')
const ST = path.join(ROOT, 'state')

// 源优先级：包子最全，其次 G站，再拷贝，最后嬉皮
const SOURCES = [
    { file: 'bzmgcn.js', name: '包子漫畫' },
    { file: 'godamh.js', name: 'G站漫畫' },
    { file: 'mangacopy.js', name: '拷贝漫画' },
    { file: 'hipmh.js', name: '嬉皮漫畫' },
]

const args = process.argv.slice(2)
const argOf = (n) => {
    const i = args.indexOf(n)
    return i >= 0 ? args[i + 1] : null
}
const LIMIT = Number(argOf('--limit')) || 0
const ONLY = argOf('--book')

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

// ---------------------------------------------------------------- 工具

const log = (...a) => console.log(...a)

/** 文件名安全化 */
function safeName(s) {
    return String(s || '')
        .replace(/[\/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
}

function loadState(key) {
    const f = path.join(ST, key + '.json')
    if (!fs.existsSync(f)) return { done: [], complete: false, title: '', cover: '' }
    try {
        return JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch {
        return { done: [], complete: false, title: '', cover: '' }
    }
}

function saveState(key, st) {
    fs.mkdirSync(ST, { recursive: true })
    fs.writeFileSync(path.join(ST, key + '.json'), JSON.stringify(st, null, 2))
}

/** 从章节 key 里取章节号，用于排序和文件名 */
function epNumberOf(key) {
    const m = /第\s*(\d+(?:\.\d+)?)\s*[話话]/.exec(key)
    return m ? Number(m[1]) : null
}

async function fetchImage(url, headers, timeoutMs = 25000) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
        const r = await fetch(url, {
            headers: Object.assign({ 'User-Agent': UA }, headers || {}),
            signal: ctrl.signal,
        })
        if (!r.ok) return null
        const ct = r.headers.get('content-type') || ''
        if (!ct.startsWith('image/')) return null
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length < 512) return null // 太小多半是占位图/错误页
        const ext = ct.includes('webp') ? '.webp' : ct.includes('png') ? '.png' : ct.includes('gif') ? '.gif' : '.jpg'
        return { url, data: buf, ext }
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}

/** 并发下载，保持顺序，失败跳过 */
async function downloadAll(urls, headers, concurrency = 8) {
    const out = new Array(urls.length)
    let i = 0
    async function worker() {
        while (i < urls.length) {
            const idx = i++
            out[idx] = await fetchImage(urls[idx], headers)
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker))
    return out.filter(Boolean)
}

/** 在四个源里找这本书，返回所有匹配的候选（按优先级排序） */
async function findCandidates(instances, keyword) {
    const norm = (x) => String(x).toLowerCase().replace(/[\s:：·\-—_]/g, '')
    const kw = norm(keyword)
    const out = []
    for (const s of instances) {
        try {
            const r = await s.inst.search.load(keyword, [], 1)
            const hit = (r.comics || [])[0]
            if (!hit) continue
            const t = norm(hit.title)
            // 标题要足够接近，避免搜到不相关的书
            if (!t.includes(kw) && !kw.includes(t)) continue
            out.push({ ...s, comic: hit })
        } catch (e) {
            log(`    ${s.name} 搜索出错: ${String(e).slice(0, 60)}`)
        }
    }
    return out
}

/**
 * 试抓一章，判断这个源的数据是否可用。
 * 有些书在某个站上数据损坏（章节图全部 404），必须能识别出来换源。
 */
async function probeChapter(cand, key) {
    try {
        const ep = await cand.inst.comic.loadEp(cand.comic.id, key)
        const urls = (ep && ep.images) || []
        if (!urls.length) return false
        for (const u of urls.slice(0, 2)) {
            const img = await fetchImage(u)
            if (img) return true
        }
        return false
    } catch (e) {
        return false
    }
}

// ---------------------------------------------------------------- 主流程

async function main() {
    const booksFile = path.join(ROOT, 'books.txt')
    if (!fs.existsSync(booksFile)) {
        log('找不到 books.txt')
        process.exit(1)
    }
    let books = fs
        .readFileSync(booksFile, 'utf8')
        .split('\n')
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean)
    if (ONLY) books = books.filter((b) => b.includes(ONLY))
    if (!books.length) {
        log('书单为空')
        return
    }

    log(`=== 开始，共 ${books.length} 本书${LIMIT ? `，每本上限 ${LIMIT} 章` : ''}`)

    // 预加载所有源
    const instances = []
    for (const s of SOURCES) {
        try {
            const storeFile = path.join(ST, '_data_' + s.file.replace('.js', '') + '.json')
            instances.push({ ...s, inst: loadSource(path.join(ROOT, s.file), storeFile) })
        } catch (e) {
            log(`源 ${s.name} 加载失败: ${String(e).slice(0, 60)}`)
        }
    }
    // 预检：并发探一次首页，让源自己把可用域名挑出来（结果会写进 state/_data_*.json）
    const probeResults = await Promise.all(
        instances.map(async (x) => {
            const t0 = Date.now()
            try {
                const parts = await x.inst.explore[0].load(null)
                const n = (parts || []).reduce((a, p) => a + ((p.comics || []).length), 0)
                return { name: x.name, ok: n > 0, n, ms: Date.now() - t0 }
            } catch (e) {
                return { name: x.name, ok: false, n: 0, ms: Date.now() - t0, err: String(e).slice(0, 50) }
            }
        })
    )
    log('源预检：' + probeResults.map((r) => `${r.name}${r.ok ? '✓' : '✗'}(${r.ms}ms)`).join('  '))
    const healthy = instances.filter((x) => probeResults.find((r) => r.name === x.name && r.ok))
    if (!healthy.length) {
        log('所有源都不可用，本次跳过')
        return
    }
    log(`可用源: ${healthy.map((x) => x.name).join(' / ')}`)

    let totalNew = 0
    let totalBytes = 0

    for (const keyword of books) {
        log(`\n--- 《${keyword}》`)
        const candidates = await findCandidates(healthy, keyword)
        if (!candidates.length) {
            log('    所有源都没找到，跳过')
            continue
        }

        const stateKey = safeName(keyword)
        const st = loadState(stateKey)
        const doneSet = new Set(st.done || [])

        let used = null // 最终选定的源
        let info = null
        let allKeys = []

        for (const cand of candidates) {
            let i2
            try {
                i2 = await cand.inst.comic.loadInfo(cand.comic.id)
            } catch (e) {
                log(`    ${cand.name} 详情失败: ${String(e).slice(0, 50)}`)
                continue
            }
            const keys = Object.keys(i2.chapters || {})
            if (!keys.length) {
                log(`    ${cand.name} 无章节，跳过`)
                continue
            }
            keys.sort((a, b) => {
                const x = epNumberOf(a)
                const y = epNumberOf(b)
                if (x !== null && y !== null) return x - y
                if (x !== null) return -1
                if (y !== null) return 1
                return a.localeCompare(b, 'zh', { numeric: true })
            })

            // 试抓：优先试还没抓过的章节，都抓过了就试第一章
            const probeKey = keys.find((k) => !doneSet.has(k)) || keys[0]
            const ok = await probeChapter(cand, probeKey)
            if (!ok) {
                log(`    ${cand.name} 试抓失败（共 ${keys.length} 章），换下一个源`)
                continue
            }
            log(`    ✓ 采用 ${cand.name} | ${i2.title} | ${keys.length} 章 | id=${String(cand.comic.id).slice(0, 36)}`)
            used = cand
            info = i2
            allKeys = keys
            break
        }

        if (!used) {
            log('    所有源都抓不到有效内容，跳过这本书')
            continue
        }

        st.title = info.title || keyword
        st.cover = info.cover || st.cover || ''
        st.status = /完結|完结|已完結/.test(info.description || '') ? 'completed' : st.status || 'ongoing'
        st.source = used.name
        st.chapters = allKeys
        st.done = st.done || []

        // 封面存到本地：站点封面多半有防盗链，阅读器直接请求会被拒
        const coverDir = path.join(LIB, stateKey)
        fs.mkdirSync(coverDir, { recursive: true })
        const coverFile = path.join(coverDir, 'cover.jpg')
        if (st.cover && !fs.existsSync(coverFile)) {
            const img = await fetchImage(st.cover)
            if (img) {
                fs.writeFileSync(path.join(coverDir, 'cover' + img.ext), img.data)
                log(`    封面已保存 (${(img.data.length / 1024).toFixed(0)}KB)`)
            } else {
                log(`    封面下载失败，跳过`)
            }
        }

        let todo = allKeys.filter((k) => !doneSet.has(k))
        if (!todo.length) {
            log(`    已是最新（共 ${allKeys.length} 章）`)
            st.complete = st.status === 'completed'
            saveState(stateKey, st)
            continue
        }
        if (LIMIT) todo = todo.slice(0, LIMIT)
        log(`    待抓 ${todo.length} 章`)

        const dir = path.join(LIB, stateKey)
        fs.mkdirSync(dir, { recursive: true })

        let failStreak = 0
        for (const key of todo) {
            const num = epNumberOf(key)
            const fname = safeName(num !== null ? String(num).padStart(4, '0') : key) + '.cbz'
            const out = path.join(dir, fname)
            if (fs.existsSync(out)) {
                if (!doneSet.has(key)) {
                    doneSet.add(key)
                    st.done.push(key)
                }
                continue
            }
            const t0 = Date.now()
            try {
                const ep = await used.inst.comic.loadEp(used.comic.id, key)
                const urls = (ep && ep.images) || []
                if (!urls.length) {
                    log(`    ✗ ${key} 没有图片`)
                    failStreak++
                    continue
                }
                const imgs = await downloadAll(urls)
                if (!imgs.length) {
                    log(`    ✗ ${key} 图片全部下载失败`)
                    failStreak++
                    if (failStreak >= 3) log(`    连续 ${failStreak} 章失败，剩余章节放弃（下次换源重试）`)
                    if (failStreak >= 3) break
                    continue
                }
                failStreak = 0
                const cbz = makeCbz(imgs)
                fs.writeFileSync(out, cbz)
                totalBytes += cbz.length
                totalNew++
                doneSet.add(key)
                st.done.push(key)
                log(
                    `    ✓ ${fname}  ${imgs.length}/${urls.length} 张  ${(cbz.length / 1048576).toFixed(1)}MB  ${Date.now() - t0}ms`
                )
            } catch (e) {
                log(`    ✗ ${key} ${String(e).slice(0, 60)}`)
                failStreak++
                if (failStreak >= 3) break
            }
            saveState(stateKey, st) // 每章存一次，中途失败也不丢进度
        }

        st.complete = st.status === 'completed' && (st.done || []).length >= allKeys.length
        saveState(stateKey, st)
    }

    log(`\n=== 完成：新增 ${totalNew} 章，共 ${(totalBytes / 1048576).toFixed(1)}MB`)
}

main().catch((e) => {
    console.error('运行失败:', e)
    process.exit(1)
})
