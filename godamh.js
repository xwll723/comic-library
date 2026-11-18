/**
 * G站漫畫 (godamh.com) —— Venera 漫画源
 *
 * 站点是 Astro SSR，列表/详情都在服务端直出的 HTML 里（没有列表 JSON 接口），
 * 只有两块数据走 API：
 *
 *   详情+章节表  https://v2.apikk.top/api/v2/manga/get?mid=<纯数字 mid>&mode=all
 *   章节图片     https://v2.apikk.top/api/v2/chapter/getinfo?m=<mid>&c=<章节id>
 *
 * mid 就是 /manga/<slug>-<mid> 末尾那串数字（必须纯数字，传 slug 会 400）。
 * getinfo 返回的 data.info.images.images 是混淆字符串（前缀 J7r / 后缀 nQ），
 * 解码流程见下面 decodeChapterImages 的注释。
 *
 * 图片（章节内页）在 c-nd3 / c-nd2 系列域名；封面在 c-nc-1.6wm.top，
 * 两者路径不互通（c-nd3 拿 /manga/ 的封面会 404），所以封面用 HTML 里的原 URL，
 * 章节图才拼图片域名。
 */

const GDM_SITE = 'https://godamh.com'
const GDM_API_HOST = 'v2.apikk.top'
const GDM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0'

// 章节内页图片域名：line=2 的章节走 -nd2 系列，其余走 -nd3（与站点前端一致）
const GDM_IMG_HOSTS = {
    c: { line2: 'c-nd2-1.6wm.top', other: 'c-nd3-1.6wm.top' },
    t: { line2: 't-nd2-1.6wm.top', other: 't-nd3-1.6wm.top' },
}

/* -------------------------------------------------------------- 图片解密 */

// 混淆字符串用的自定义字母表 -> 标准 base64url 字母表
const GDM_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const GDM_CUSTOM = '_-9876543210abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const GDM_PREFIX = 'J7r'
const GDM_MARKER1 = 'kD'
const GDM_MARKER2 = 'W4s'
const GDM_SUFFIX = 'nQ'
const GDM_GROUP = 7

// 预计算：自定义字符码 -> 标准字符码
const GDM_TABLE = new Array(128).fill(-1)
for (let i = 0; i < GDM_CUSTOM.length; i++) {
    GDM_TABLE[GDM_CUSTOM.charCodeAt(i)] = GDM_STD.charCodeAt(i)
}

/**
 * 章节图片解密（纯 JS 复刻站点 /assets/runtime/chapter-decoder.js 的算法）
 *
 * 1. 去掉前缀 J7r / 后缀 nQ
 * 2. 去掉两段标记 kD 与 W4s，得到三段 part1 / part2 / part3
 *    （part3 长度 = floor(len/3)，part1 = floor((len-|part3|)/2)，剩下的给 part2）
 * 3. 重新拼成 part3 + part1 + part2
 * 4. 每 7 个字符一组，奇数号组整体反转（去锯齿）
 * 5. 自定义字母表映射回标准 base64url
 * 6. base64 解码 -> UTF-8 -> JSON 数组 [{url, order, isLoaded}]
 */
function decodeChapterImages(input) {
    if (typeof input !== 'string' || input.length < 16 ||
        input.indexOf(GDM_PREFIX) !== 0 ||
        input.slice(-GDM_SUFFIX.length) !== GDM_SUFFIX) {
        throw '章节图片数据格式不正确'
    }
    const body = input.slice(GDM_PREFIX.length, input.length - GDM_SUFFIX.length)
    const payloadLen = body.length - GDM_MARKER1.length - GDM_MARKER2.length
    if (payloadLen <= 0) throw '章节图片数据为空'

    const len3 = Math.floor(payloadLen / 3)
    const len1 = Math.floor((payloadLen - len3) / 2)
    const len2 = payloadLen - len3 - len1

    const part1 = body.slice(0, len1)
    const marker1 = body.slice(len1, len1 + GDM_MARKER1.length)
    const part2 = body.slice(len1 + GDM_MARKER1.length, len1 + GDM_MARKER1.length + len2)
    const marker2 = body.slice(len1 + GDM_MARKER1.length + len2, len1 + GDM_MARKER1.length + len2 + GDM_MARKER2.length)
    const part3 = body.slice(len1 + GDM_MARKER1.length + len2 + GDM_MARKER2.length)

    if (marker1 !== GDM_MARKER1 || marker2 !== GDM_MARKER2 || part3.length !== len3) {
        throw '章节图片数据校验失败'
    }

    const reordered = part3 + part1 + part2

    let unzigzag = ''
    for (let i = 0, block = 0; i < reordered.length; i += GDM_GROUP, block++) {
        const chunk = reordered.slice(i, i + GDM_GROUP)
        unzigzag += block % 2 === 1 ? chunk.split('').reverse().join('') : chunk
    }

    let standard = ''
    for (let i = 0; i < unzigzag.length; i++) {
        const code = unzigzag.charCodeAt(i)
        const mapped = code < GDM_TABLE.length ? GDM_TABLE[code] : -1
        if (mapped < 0) throw '章节图片数据含非法字符'
        standard += String.fromCharCode(mapped)
    }

    let b64 = standard.replace(/-/g, '+').replace(/_/g, '/')
    // 必须补 padding：App 的 Convert.decodeBase64 走 Dart base64Decode，
    // 长度不是 4 的倍数会直接抛异常并返回 null（表现为 JSON.parse(undefined)）
    const pad = (4 - (b64.length % 4)) % 4
    if (pad) b64 += '='.repeat(pad)

    const bytes = Convert.decodeBase64(b64)
    if (!bytes) throw '章节图片数据 base64 解码失败'
    const text = Convert.decodeUtf8(bytes)
    if (!text) throw '章节图片数据 UTF-8 解码失败'
    const list = JSON.parse(text)
    if (!Array.isArray(list)) throw '章节图片数据解析失败'
    return list
}

class GodamhSource extends ComicSource {
    name = 'G站漫畫'
    key = 'godamh'
    version = '1.0.0'
    minAppVersion = '1.0.0'
    // 换成自己的仓库地址
    url = 'https://cdn.jsdelivr.net/gh/your-name/venera-configs@main/godamh.js'

    /* ------------------------------------------------------------ 基础 */

    get site() {
        return (this.loadSetting('site_url') || GDM_SITE).replace(/\/+$/, '')
    }

    get apiBase() {
        const h = (this.loadSetting('api_host') || GDM_API_HOST).replace(/\/+$/, '')
        return /^https?:\/\//.test(h) ? h : 'https://' + h
    }

    get imgHost() {
        return (this.loadSetting('img_host') || '').replace(/\/+$/, '').replace(/^https?:\/\//, '')
    }

    get headers() {
        return {
            'User-Agent': GDM_UA,
            'Referer': this.site + '/',
            'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-TW,zh;q=0.9,zh-CN;q=0.8',
        }
    }

    /** App 的 Network 没有 timeout，卡住会一直转圈，这里自己加 */
    withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), ms)),
        ])
    }

    /**
     * 过滤掉「不属于本书」的图片。
     * 站点数据损坏时，某章的图片会指向另一部漫画（路径里 slug 对不上）。
     * 图片路径形如 /scomic/<slug>/0/<code>/1.webp，slug 就是漫画 slug。
     */
    static filterBadImages(images, slug) {
        const id = String(slug == null ? '' : slug).replace(/^\/+/, '').trim()
        if (!id) return images
        const out = []
        for (const u of images) {
            const m = /\/scomic\/([^\/]+)\//.exec(String(u))
            if (!m) {
                out.push(u) // 路径里没有 slug，无法判断，保留
                continue
            }
            const s2 = m[1]
            if (s2 === id || s2.indexOf(id) === 0 || id.indexOf(s2) === 0) out.push(u)
        }
        return out
    }

    async getHtml(path) {
        const url = /^https?:\/\//.test(path) ? path : this.site + path
        const res = await this.withTimeout(Network.get(url, this.headers), 10000)
        if (res.status !== 200) throw `HTTP ${res.status}: ${url}`
        return res.body
    }

    async getApi(pathAndQuery) {
        const url = `${this.apiBase}/api/v2${pathAndQuery}`
        const res = await this.withTimeout(Network.get(url, this.headers), 10000)
        if (res.status !== 200) throw `HTTP ${res.status}: ${url}`
        let json
        try {
            json = JSON.parse(res.body)
        } catch (e) {
            throw `接口返回的不是 JSON: ${String(res.body).slice(0, 80)}`
        }
        if (!json || !json.data) throw `接口数据为空: ${url}`
        return json.data
    }

    /* ------------------------------------------------------------ HTML 工具 */

    static text(html) {
        return String(html || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim()
    }

    /** 取字符串里最后一个正则捕获（用「最近的」那个，才能对上卡片自身的链接/图） */
    static lastCapture(str, re) {
        let m
        let out = null
        re.lastIndex = 0
        while ((m = re.exec(str))) out = m[1]
        return out
    }

    static attrOf(tag, name) {
        const m = new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(String(tag || ''))
        return m ? m[1] : ''
    }

    /** /manga/<slug>-<mid> 或完整 URL -> 站内路径 */
    static pathOf(id) {
        let s = String(id || '').trim()
        s = s.replace(/^https?:\/\/[^/]+/i, '')
        s = s.split('#')[0].split('?')[0]
        if (!s) return ''
        if (s.charAt(0) !== '/') s = '/manga/' + s
        return s.replace(/\/+$/, '')
    }

    /**
     * 路径末尾的数字**不是** API 需要的 mid（/manga/xxx-26482 的真实 mid 是 32975），
     * 所以 mid 一律以详情页 #mangachapters 的 data-mid 为准，这里只是给纯数字 id 兜底。
     */
    static midOf(id) {
        const p = GodamhSource.pathOf(id)
        const m = /^\/(?:manga|comic)\/(\d+)$/.exec(p)
        return m ? m[1] : ''
    }

    /**
     * 列表卡片解析。
     * 站点列表每张卡都是 <a href="/manga/..."><img src=...><h3 class="cardtitle">书名</h3></a>，
     * 用 h3.cardtitle 定位后再往回找最近的 <a href> 与 <img src>，
     * 比整段 DOM 解析轻，也不会被侧栏/推荐位干扰。
     */
    static parseCards(html) {
        const s = String(html || '')
        const out = []
        const seen = {}
        const re = /<h3[^>]*class="cardtitle[^"]*"[^>]*>([\s\S]*?)<\/h3>/g
        let m
        while ((m = re.exec(s))) {
            const title = GodamhSource.text(m[1])
            if (!title) continue
            const before = s.slice(Math.max(0, m.index - 1600), m.index)
            const href = GodamhSource.lastCapture(before, /href="(\/manga\/[^"#?]+)"/g)
            if (!href) continue
            const cover = GodamhSource.lastCapture(before, /<img[^>]*?src="(https?:\/\/[^"]+)"/g) || ''
            const id = GodamhSource.pathOf(href)
            if (!id || seen[id]) continue
            seen[id] = 1
            out.push(new Comic({ id: id, title: title, cover: cover }))
        }
        return out
    }

    /** 首页顶部的「近期更新」横滑卡片：<a class="slicarda">…<h3 class="slicardtitle"> */
    static parseSliceCards(html) {
        const s = String(html || '')
        const out = []
        const seen = {}
        const re = /<a\s+href="(\/manga\/[^"#?]+)"[^>]*class="[^"]*slicarda[^"]*"[^>]*>([\s\S]*?)<\/a>/g
        let m
        while ((m = re.exec(s))) {
            const id = GodamhSource.pathOf(m[1])
            const inner = m[2]
            const title = GodamhSource.text(
                (function () {
                    const t = /<h3[^>]*class="[^"]*slicardtitle[^"]*"[^>]*>([\s\S]*?)<\/h3>/.exec(inner)
                    return t ? t[1] : ''
                })()
            )
            if (!id || !title || seen[id]) continue
            const cover = GodamhSource.lastCapture(inner, /<img[^>]*?src="(https?:\/\/[^"]+)"/g) || ''
            const tag = GodamhSource.text(
                (function () {
                    const t = /<p[^>]*class="[^"]*slicardtagp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(inner)
                    return t ? t[1] : ''
                })()
            )
            seen[id] = 1
            out.push(new Comic({ id: id, title: title, cover: cover, subTitle: tag }))
        }
        return out
    }

    /** 最大页码：分页链接两种形态 /page/N（分类）与 ?page=N（搜索），取最大 */
    static maxPage(html) {
        const s = String(html || '')
        let max = 1
        let m
        let re = /\/page\/(\d{1,5})/g
        while ((m = re.exec(s))) {
            const n = Number(m[1])
            if (n > max && n < 10000) max = n
        }
        re = /[?&]page=(\d{1,5})/g
        while ((m = re.exec(s))) {
            const n = Number(m[1])
            if (n > max && n < 10000) max = n
        }
        return max
    }

    /** 首页板块：hometitle(h2) + 紧随其后的 cardlist，viewMore 用 hometitle 前那个 <a> */
    static parseHomeSections(html) {
        const s = String(html || '')
        const marks = []
        const re = /class="hometitle"/g
        let m
        while ((m = re.exec(s))) marks.push(m.index)
        const parts = []
        for (let i = 0; i < marks.length; i++) {
            const start = marks[i]
            const end = i + 1 < marks.length ? marks[i + 1] : s.length
            const seg = s.slice(start, end)
            const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(seg)
            const title = h2 ? GodamhSource.text(h2[1]) : ''
            if (!title) continue
            const comics = GodamhSource.parseCards(seg)
            if (!comics.length) continue
            const back = s.slice(Math.max(0, start - 900), start)
            const more = GodamhSource.lastCapture(back, /href="(\/(?:manga|hots|dayup|newss)[^"#?]*)"/g) || ''
            const part = { title: title, comics: comics }
            if (more) part.viewMore = { page: 'category', attributes: { category: title, param: more } }
            parts.push(part)
        }
        return parts
    }

    /* ------------------------------------------------------------ 章节 key */

    /**
     * 生成章节 key。App 下载时直接拿它当文件夹名，用户看得见，所以做成可读的
     * `书名 第003话：标题`。话数补零 3 位（本地阅读器按字符串排序，不补零
     * 会把「第10话」排到「第3话」前面），话数用站点自己的 attributes.order。
     */
    static chapterKey(index, chapter, comicTitle, used) {
        const style = GodamhSource.__keyStyle || 'bookEp'
        const padWidth = GodamhSource.__epPad === undefined ? 3 : Number(GodamhSource.__epPad) || 0
        const seq = index + 1
        const fmt = (n) => (padWidth > 1 ? String(n).padStart(padWidth, '0') : String(n))
        const book = String(comicTitle || '').replace(/[\/\\:*?"<>|]/g, '_').trim()

        let n = Number(chapter.order)
        if (!isFinite(n) || n <= 0) n = seq
        const numStr = String(n)

        // 去掉标题自带的序号：「001 xxx」「28 xxx」「第3话 xxx」「1.xxx」
        let title = String(chapter.title || '').trim()
        if (title) {
            const esc = numStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            title = title
                .replace(new RegExp('^' + esc + '[\\s.、,，:：\\-]+'), '')
                .replace(/^第\s*[\d.]+\s*[话話章回集节節卷巻][\s.、,，:：\-]*/, '')
                .replace(/^第\s*[一二三四五六七八九十百千零〇两]+\s*[话話章回集节節卷巻][\s.、,，:：\-]*/, '')
                .replace(/^[一二三四五六七八九十百千零〇两]+\s*[.、,，:：\-]+/, '')
                .replace(/^\d{1,4}[\s.、,，:：\-]+/, '')
                .trim()
        }
        title = title.replace(/[\/\\:*?"<>|]/g, '_')

        let key
        if (style === 'numTitle') key = `${String(seq).padStart(4, '0')}. ${title || numStr}`
        else if (style === 'num') key = String(seq).padStart(4, '0')
        else if (style === 'title') key = title || numStr
        else key = `${book ? book + ' ' : ''}第${fmt(n)}话${title ? '：' + title : ''}`

        // 纯数字 key 会被 JS 引擎排到对象最前面，章节顺序会乱
        if (/^(0|[1-9]\d*)$/.test(key)) key = `第${fmt(n)}话`

        // 重名保护
        if (used) {
            if (used[key]) {
                let k = 2
                while (used[key + ` (${k})`]) k++
                key = key + ` (${k})`
            }
            used[key] = true
        }
        return key
    }

    /** 章节表（按 order 升序）+ key -> 真实章节 id 映射 */
    static buildChapters(list, comicTitle) {
        const chapters = {}
        const map = {}
        const used = {}
        let prev = 0
        for (let i = 0; i < list.length; i++) {
            const c = list[i]
            if (!c || c.id === undefined || c.id === null) continue
            // 站点的 order 有 0、有小数的（7.1）、也有重号的，直接用会出现「第001话」重复。
            // 这里做单调化：能用站点号就用，不能用/回退时取上一个 +1，保证严格递增且和站点编号尽量一致。
            let n = Math.floor(Number(c.order))
            if (!isFinite(n) || n <= 0) n = prev + 1
            if (n <= prev) n = prev + 1
            prev = n
            const key = GodamhSource.chapterKey(i, { title: c.title, order: n }, comicTitle, used)
            chapters[key] = c.title || `第${n}话`
            map[key] = String(c.id)
        }
        return { chapters: chapters, map: map }
    }

    /** 拉章节表（mode=all 一次给全，按 order 升序） */
    async fetchChapterList(mid) {
        if (!mid) throw '缺少漫画 mid'
        const d = await this.getApi(`/manga/get?mid=${encodeURIComponent(mid)}&mode=all`)
        const raw = Array.isArray(d.chapters) ? d.chapters : []
        const list = []
        for (const c of raw) {
            const a = c && c.attributes ? c.attributes : {}
            if (c && c.id !== undefined && c.id !== null) {
                list.push({ id: String(c.id), title: String(a.title || ''), order: Number(a.order) || 0 })
            }
        }
        list.sort((x, y) => {
            if (x.order && y.order && x.order !== y.order) return x.order - y.order
            return 0
        })
        return { list: list, mid: String(d.id || mid), title: String(d.title || '') }
    }

    /** 取漫画真实 mid：本地缓存 → 详情页 data-mid（API 只认这个，slug 会 400） */
    async resolveMid(path) {
        const p = GodamhSource.pathOf(path)
        let mid = ''
        try {
            mid = this.loadData('mid_' + p) || ''
        } catch (e) {
            mid = ''
        }
        if (mid) return String(mid)
        const html = await this.getHtml(p)
        const m = /<div id="mangachapters"[^>]*data-mid="(\d+)"/.exec(html)
        if (m) {
            try {
                this.saveData('mid_' + p, m[1])
            } catch (e) {
                // 忽略
            }
            return m[1]
        }
        return GodamhSource.midOf(p)
    }

    /**
     * 可读 key -> 真实章节 id。
     * 顺序：saveData 缓存表 → 重新拉详情+章节表建表 → 原样返回（兼容旧的 mid@cid / 纯 id）。
     */
    async resolveHid(comicId, epId) {
        const s = String(epId || '').trim()
        if (!s) return s
        // 兼容旧格式 mid@chapterId
        if (s.indexOf('@') > 0) return s.split('@')[1]

        const path = GodamhSource.pathOf(comicId)
        const mid = await this.resolveMid(path)
        if (mid) {
            let map = null
            try {
                map = this.loadData('hidmap_' + mid)
            } catch (e) {
                map = null
            }
            if (map && map[s]) return map[s]
        }
        // 缓存没有：重新走一次 loadInfo（会重建 hidmap），再查
        try {
            await this.comic.loadInfo(comicId)
            const mid2 = await this.resolveMid(path) || mid
            const map2 = mid2 ? this.loadData('hidmap_' + mid2) : null
            if (map2 && map2[s]) return map2[s]
        } catch (e) {
            // 拉不到就把原值往下传（可能本来就是原生 chapter id）
        }
        return s
    }

    /* ------------------------------------------------------------ 发现页 */

    explore = [
        {
            title: '首頁',
            type: 'multiPartPage',
            load: async (page) => {
                const p = Number(page) || 1
                // 第 2 页起直接翻全站列表，避免首页只有一屏
                if (p > 1) {
                    const html = await this.getHtml(`/manga/page/${p}`)
                    return [{ title: `全部漫畫 · 第${p}頁`, comics: GodamhSource.parseCards(html) }]
                }
                const html = await this.getHtml('/')
                const parts = []
                const recent = GodamhSource.parseSliceCards(html)
                if (recent.length) {
                    parts.push({ title: '近期更新', comics: recent, viewMore: { page: 'category', attributes: { category: '近期更新', param: '/dayup' } } })
                }
                for (const part of GodamhSource.parseHomeSections(html)) parts.push(part)
                if (!parts.length) throw '首頁解析為空，站點可能改版了'
                return parts
            },
        },
    ]

    /* ------------------------------------------------------------ 分类 */

    category = {
        title: '分類',
        parts: [
            {
                name: '類型',
                type: 'fixed',
                itemType: 'category',
                categories: ['全部', '韓漫', '熱門', '國漫', '日漫', '歐美', '其他'],
                categoryParams: [
                    '/manga',
                    '/manga-genre/kr',
                    '/hots',
                    '/manga-genre/cn',
                    '/manga-genre/jp',
                    '/manga-genre/ou-mei',
                    '/manga-genre/qita',
                ],
            },
            {
                name: '題材',
                type: 'fixed',
                itemType: 'category',
                categories: [
                    '全部', '復仇', '古風', '奇幻', '逆襲', '異能', '宅向', '穿越', '熱血',
                    '純愛', '系統', '重生', '冒險', '靈異', '大女主', '劇情', '戀愛',
                    '玄幻', '女神', '科幻', '魔幻', '推理', '獵奇', '治癒', '都市',
                    '異形', '青春', '末日', '懸疑', '修仙', '戰鬥',
                ],
                categoryParams: [
                    '',
                    '/manga-tag/fuchou',
                    '/manga-tag/gufeng',
                    '/manga-tag/qihuan',
                    '/manga-tag/nixi',
                    '/manga-tag/yineng',
                    '/manga-tag/zhaixiang',
                    '/manga-tag/chuanyue',
                    '/manga-tag/rexue',
                    '/manga-tag/chunai',
                    '/manga-tag/xitong',
                    '/manga-tag/zhongsheng',
                    '/manga-tag/maoxian',
                    '/manga-tag/lingyi',
                    '/manga-tag/danvzhu',
                    '/manga-tag/juqing',
                    '/manga-tag/lianai',
                    '/manga-tag/xuanhuan',
                    '/manga-tag/nvshen',
                    '/manga-tag/kehuan',
                    '/manga-tag/mohuan',
                    '/manga-tag/tuili',
                    '/manga-tag/lieqi',
                    '/manga-tag/zhiyu',
                    '/manga-tag/doushi',
                    '/manga-tag/yixing',
                    '/manga-tag/qingchun',
                    '/manga-tag/mori',
                    '/manga-tag/xuanyi',
                    '/manga-tag/xiuxian',
                    '/manga-tag/zhandou',
                ],
            },
        ],
        enableRankingPage: false,
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            const p = Number(page) || 1
            let base = String(param || '').trim()
            if (!base || base === '/manga') base = '/manga'
            const html = await this.getHtml(`${base}/page/${p}`)
            const comics = GodamhSource.parseCards(html)
            if (!comics.length && p > 1) return { comics: comics, maxPage: p - 1 }
            return { comics: comics, maxPage: GodamhSource.maxPage(html) }
        },
    }

    /* ------------------------------------------------------------ 搜索 */

    search = {
        load: async (keyword, options, page) => {
            const kw = String(keyword || '').trim()
            if (!kw) return { comics: [], maxPage: 1 }
            const p = Number(page) || 1
            // 站点搜索：/s/<关键词>?page=N（/s/?q= 只给第一页）
            const html = await this.getHtml(`/s/${encodeURIComponent(kw)}?page=${p}`)
            // 站点搜不到东西时会回一屏「您可能喜歡」的推荐位，必须识别掉，否则用户看到一堆无关的书
            if (/暫無漫畫|暂无漫画|暫無結果|暂无结果/.test(html)) return { comics: [], maxPage: 1 }
            const comics = GodamhSource.parseCards(html)
            if (!comics.length) return { comics: [], maxPage: 1 }
            return { comics: comics, maxPage: GodamhSource.maxPage(html) }
        },
        enableTagsSuggestions: false,
    }

    /* ------------------------------------------------------------ 详情 / 阅读 */

    comic = {
        idMatch: '^(?:(?:https?://)?(?:www\\.)?godamh\\.com)?/manga/[A-Za-z0-9_\\-]+',

        loadInfo: async (id) => {
            const path = GodamhSource.pathOf(id)
            if (!path) throw '無效的漫畫 id'
            const html = await this.getHtml(path)

            // 标题（h1 里还有「連載中」之类的状态 span，取第一个尖括号前的文本）
            let title = ''
            const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)
            if (h1) title = GodamhSource.text(h1[1].split('<')[0])
            if (!title) {
                const og = /<meta property="og:title" content="([^"]*)"/.exec(html)
                if (og) title = GodamhSource.text(og[1]).split('-')[0].trim()
            }
            if (!title) throw '詳情頁解析失敗（標題為空）'

            // 封面：详情页主视觉图（不是列表缩略图），兜底用 og:image
            let cover = ''
            const coverTag = /<img[^>]*class="object-cover[^"]*"[^>]*>/.exec(html)
            if (coverTag) cover = GodamhSource.attrOf(coverTag[0], 'src')
            if (!cover) {
                const og = /<meta property="og:image" content="([^"]*)"/.exec(html)
                if (og) cover = og[1]
            }
            if (cover.indexOf('//') === 0) cover = 'https:' + cover

            // 状态
            let status = ''
            if (h1) {
                const st = /<span[^>]*>\s*([^<]{2,8})\s*<\/span>/.exec(h1[1])
                if (st) status = GodamhSource.text(st[1])
            }

            // 作者
            const authors = []
            const authorBlock = /作者：<\/span>([\s\S]*?)<\/div>/.exec(html)
            if (authorBlock) {
                const re = /<span[^>]*>([\s\S]*?)<\/span>/g
                let m
                while ((m = re.exec(authorBlock[1]))) {
                    const a = GodamhSource.text(m[1]).replace(/[,，]$/, '').trim()
                    if (a) authors.push(a)
                }
            }
            // 類型
            const genres = []
            const genreBlock = /類型：<\/span>([\s\S]*?)<\/div>/.exec(html)
            if (genreBlock) {
                const re = /<span[^>]*>([\s\S]*?)<\/span>/g
                let m
                while ((m = re.exec(genreBlock[1]))) {
                    const g = GodamhSource.text(m[1]).replace(/[,，]$/, '').trim()
                    if (g) genres.push(g)
                }
            }
            // 标签（#日常 #都市 …）
            const tagsList = []
            const tagRe = /<a href="\/manga-tag\/[^"]*"[^>]*>\s*<span[^>]*>\s*#?\s*([^<]*?)\s*<\/span>/g
            let tm
            while ((tm = tagRe.exec(html))) {
                const t = GodamhSource.text(tm[1])
                if (t) tagsList.push(t)
            }

            // 简介
            let description = ''
            const descEl = /<p class="text-medium[^"]*">([\s\S]*?)<\/p>/.exec(html)
            if (descEl) description = GodamhSource.text(descEl[1])

            const tags = {}
            if (authors.length) tags['作者'] = authors
            if (genres.length) tags['類型'] = genres
            if (tagsList.length) tags['標籤'] = tagsList

            // mid：详情页里 #mangachapters 的 data-mid 最稳（URL 末尾那串数字不是 mid！）
            let mid = ''
            const midEl = /<div id="mangachapters"[^>]*data-mid="(\d+)"/.exec(html)
            if (midEl) mid = midEl[1]
            if (!mid) mid = GodamhSource.midOf(path)
            if (!mid) throw '無法取得漫畫 mid'
            try {
                this.saveData('mid_' + path, mid)
            } catch (e) {
                // 忽略
            }

            // 章节表（API）
            const info = await this.fetchChapterList(mid)
            GodamhSource.__keyStyle = this.loadSetting('chapter_name') || 'bookEp'
            const pad = Number(this.loadSetting('ep_pad'))
            GodamhSource.__epPad = isFinite(pad) ? pad : 3

            const built = GodamhSource.buildChapters(info.list, title)
            if (!Object.keys(built.chapters).length) throw '章節列表為空'
            try {
                this.saveData('hidmap_' + mid, built.map)
            } catch (e) {
                // 忽略
            }
            // 记住整书封面：loadEp 要往每章第一页插这张
            if (cover) {
                try {
                    this.saveData('cover_' + mid, cover)
                } catch (e) {
                    // 忽略
                }
            }

            const lines = []
            if (description) lines.push(description)
            lines.push('')
            if (status) lines.push(`狀態：${status}`)
            if (authors.length) lines.push(`作者：${authors.join('、')}`)
            if (genres.length) lines.push(`類型：${genres.join('、')}`)
            lines.push(`章節：${Object.keys(built.chapters).length}`)

            return new ComicDetails({
                title: title,
                subTitle: authors.join(' / ') || status,
                cover: cover,
                description: lines.join('\n'),
                tags: tags,
                chapters: built.chapters,
                isFavorite: false,
                updateTime: '',
                url: this.site + path,
            })
        },

        loadEp: async (comicId, epId) => {
            if (!epId) throw '沒有選擇章節'
            const path = GodamhSource.pathOf(comicId)
            const mid = await this.resolveMid(path)
            if (!mid) throw '無法取得漫畫 mid'
            const realCid = await this.resolveHid(comicId, epId)
            if (!/^\d+$/.test(String(realCid))) throw `章節 id 反查失敗: ${realCid}`

            const d = await this.getApi(`/chapter/getinfo?m=${encodeURIComponent(mid)}&c=${encodeURIComponent(realCid)}`)
            const info = d && d.info ? d.info : null
            if (!info || !info.images) throw '章節圖片數據為空'

            const raw = info.images && info.images.images !== undefined ? info.images.images : info.images
            let list
            if (typeof raw === 'string') list = decodeChapterImages(raw)
            else if (Array.isArray(raw)) list = raw
            else throw '未知的章節圖片數據格式'

            const line = Number(info.images && info.images.line !== undefined ? info.images.line : info.line) || 1
            const host = this.imgHostFor(line, 'c')

            let images = []
            for (const it of list) {
                const u = it && it.url ? String(it.url) : ''
                if (!u) continue
                images.push(/^https?:\/\//.test(u) ? u : `https://${host}${u.charAt(0) === '/' ? '' : '/'}${u}`)
            }
            if (!images.length) throw '章節圖片列表為空'

            // 过滤掉指向其它漫画的图（站点数据损坏时会出现）
            const cleaned = GodamhSource.filterBadImages(images, path)
            if (!cleaned.length) throw '本章數據異常（圖片指向其他漫畫），建議換源閱讀'
            images = cleaned

            // 每章第一页插入整书封面（用详情页那张竖版封面，而不是 264x135 的章节缩略图）
            if (this.loadSetting('ep_book_cover') !== false) {
                let bookCover = null
                try {
                    bookCover = this.loadData('cover_' + mid)
                } catch (e) {
                    bookCover = null
                }
                if (!bookCover) {
                    try {
                        const det = await this.comic.loadInfo(comicId)
                        bookCover = det && det.cover ? det.cover : null
                    } catch (e) {
                        bookCover = null
                    }
                }
                if (bookCover) images = [bookCover].concat(images)
            }

            return { images: images }
        },

        onImageLoad: (url) => {
            const swaps = [
                ['c-nd3-1.6wm.top', 'c-nd2-1.6wm.top'],
                ['c-nd2-1.6wm.top', 'c-nd3-1.6wm.top'],
                ['c-nc-1.6wm.top', 'c-nc-2.6wm.top'],
            ]
            return {
                url: url,
                headers: { 'User-Agent': GDM_UA, 'Referer': this.site + '/' },
                onLoadFailed: () => {
                    for (const pair of swaps) {
                        if (String(url).indexOf(pair[0]) >= 0) {
                            return {
                                url: String(url).replace(pair[0], pair[1]),
                                headers: { 'User-Agent': GDM_UA, 'Referer': this.site + '/' },
                            }
                        }
                    }
                    return null
                },
            }
        },

        onThumbnailLoad: (url) => {
            return { url: url, headers: { 'User-Agent': GDM_UA, 'Referer': this.site + '/' } }
        },

        link: {
            domains: ['godamh.com', 'www.godamh.com', 'm.g-mh.org', 'g-mh.com'],
            linkToId: (url) => {
                const u = String(url || '')
                const m = /\/manga\/([^\/?#]+)/.exec(u)
                return m ? GodamhSource.pathOf(m[0]) : null
            },
        },
    }

    /** line → 图片域名（line=2 走 -nd2，其余 -nd3；用户填了 img_host 就优先用它） */
    imgHostFor(line, route) {
        const custom = this.imgHost
        if (custom) return custom
        const set = GDM_IMG_HOSTS[route === 't' ? 't' : 'c']
        return Number(line) === 2 ? set.line2 : set.other
    }

    /* ------------------------------------------------------------ 设置 */

    settings = {
        chapter_name: {
            title: '章節資料夾命名',
            type: 'select',
            options: [
                { value: 'bookEp', text: '書名 第003话：標題' },
                { value: 'numTitle', text: '0003. 標題' },
                { value: 'num', text: '0003（純序號）' },
                { value: 'title', text: '標題（不含序號）' },
            ],
            default: 'bookEp',
        },
        ep_pad: {
            title: '話數補零位數',
            type: 'select',
            options: [
                { value: '3', text: '3 位（第003话，推薦）' },
                { value: '4', text: '4 位（第0003话）' },
                { value: '0', text: '不補零（第3话，排序會亂）' },
            ],
            default: '3',
        },
        ep_book_cover: {
            title: '每章第一頁插入整書封面',
            type: 'switch',
            default: true,
        },
        api_host: {
            title: 'API 域名',
            type: 'input',
            validator: '^$|^https?://.+$|^[A-Za-z0-9.-]+$',
            default: GDM_API_HOST,
        },
        img_host: {
            title: '圖片域名（留空自動選 c-nd3／c-nd2）',
            type: 'input',
            validator: '^$|^https?://.+$|^[A-Za-z0-9.-]+$',
            default: '',
        },
        site_url: {
            title: '站點域名',
            type: 'input',
            validator: '^https?://.+$',
            default: GDM_SITE,
        },
    }

    translation = {
        zh_CN: {
            '章節資料夾命名': '章节文件夹命名',
            '話數補零位數': '话数补零位数',
            '每章第一頁插入整書封面': '每章第一页插入整书封面',
            '首頁': '首页',
            '分類': '分类',
            '類型': '类型',
            '題材': '题材',
            '全部': '全部',
            '近期更新': '近期更新',
            '站點域名': '站点域名',
            '圖片域名（留空自動選 c-nd3／c-nd2）': '图片域名（留空自动选 c-nd3／c-nd2）',
        },
        zh_TW: {},
        en: {},
    }
}
