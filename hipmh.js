/** @type {import('./_venera_.js')} */

/**
 * 嬉皮漫畫 (hipmh.com) Venera 漫画源
 *
 * 数据全部来自站点自己的 API，不需要 cookie，也不需要签名。
 *   API:   https://hipapi1.s3file.top/v1 (章节图片接口是 /v2)
 *   封面:  https://cover.s3imgs.top + 相对路径
 *   图片:  https://hip-tx-1.s3imgs.top + 相对路径
 *
 * 章节图片接口返回的 images 字段是加密字符串（前缀 qM9 / 后缀 Z7），
 * 这里用纯 JS 复刻了解码流程（详见 decodeImages 注释），
 * 另外要复刻官方的「1x1 占位图剔除」逻辑（removePlaceholderImage）。
 */

// API 域名候选：主域名失效时按顺序尝试下一个
const HIP_API_HOSTS = ['https://hipapi1.s3file.top', 'https://hipapi.s3file.top']
const HIP_COVER_BASE = 'https://cover.s3imgs.top'
const HIP_IMG_LINES = {
    line1: 'https://hip-tx-1.s3imgs.top',
    line2: 'https://hip-cf-1.s3imgs.top',
    // line=9 的章节要用 -s1 系列域名
    line1s: 'https://hip-tx-s1.s3imgs.top',
    line2s: 'https://hip-cf-s1.s3imgs.top',
}
const HIP_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

// 图片解密用的两张字符表（源表 -> 标准 base64 表）
const IMG_SRC_ALPHABET = '_-9876543210abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const IMG_DST_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

class HipmhSource extends ComicSource {
    name = '嬉皮漫畫'
    key = 'hipmh'
    version = '1.0.0'
    minAppVersion = '1.0.0'
    // 换成你自己的仓库地址
    url = 'https://cdn.jsdelivr.net/gh/your-name/venera-configs@main/hipmh.js'

    // ---------------------------------------------------------------- 基础

    get mainHost() {
        return (this.loadSetting('main_host') || 'https://m.hipmh.com').replace(/\/+$/, '')
    }

    // API 域名偶尔会换。候选列表按顺序尝试，成功了记住，下次直接用。
    get apiHosts() {
        const list = []
        const custom = (this.loadSetting('api_host') || '').trim()
        const norm = (u) =>
            String(u || '')
                .trim()
                .replace(/\/+$/, '')
                .replace(/\/(v1|v2)$/, '')
        if (custom) list.push(norm(custom))
        const saved = this.loadData('api_host_ok')
        if (saved) list.push(norm(saved))
        for (const h of HIP_API_HOSTS) list.push(norm(h))
        return list.filter((h, i) => h && list.indexOf(h) === i)
    }

    get headers() {
        return {
            'User-Agent': HIP_UA,
            'Accept': 'application/json',
            'Referer': this.mainHost + '/',
        }
    }

    get imageHeaders() {
        return {
            'User-Agent': HIP_UA,
            'Referer': this.mainHost + '/',
        }
    }

    // ---------------------------------------------------------------- 工具函数

    /** 补全封面 / 图片地址 */
    fullCover(path) {
        if (!path) return ''
        const p = String(path).trim()
        if (/^https?:\/\//.test(p) || p.startsWith('//')) return p
        return HIP_COVER_BASE + (p.startsWith('/') ? p : '/' + p)
    }

    /** 线路 key：line=9 的章节用 -s1 系列域名 */
    imgKeys(line) {
        const s1 = Number(line) === 9
        return {
            line1: s1 ? 'line1s' : 'line1',
            line2: s1 ? 'line2s' : 'line2',
        }
    }

    fullImageByKey(path, key) {
        if (!path) return ''
        const p = String(path).trim()
        if (/^https?:\/\//.test(p) || p.startsWith('//')) return p
        const base = HIP_IMG_LINES[key] || HIP_IMG_LINES.line2
        return base + (p.startsWith('/') ? p : '/' + p)
    }

    /**
     * 当前该用哪条线路（同步，不测速）。
     * 两条线路在不同网络下差别巨大（实测 tx 单张完整下载 29s、cf 0.5s），
     * 所以默认用 cf；测速结果只用来「下次」更准，绝不阻塞本次阅读。
     */
    lineKeyNow(line) {
        const preset = this.loadSetting('img_line')
        if (preset === 'line1' || preset === 'line2') return preset
        const cacheKey = 'line_pick_' + this.imgKeys(line).line1
        const cached = this.loadData(cacheKey)
        if (cached && cached.key && cached.ts && Date.now() - cached.ts < 6 * 3600 * 1000) {
            return cached.key
        }
        return 'line2'
    }

    /** 后台测速（不 await），结果缓存 6 小时，供后续章节使用 */
    refreshLineLater(samplePath, line) {
        const preset = this.loadSetting('img_line')
        if (preset === 'line1' || preset === 'line2') return
        if (!samplePath || /^https?:\/\//.test(samplePath)) return
        const cacheKey = 'line_pick_' + this.imgKeys(line).line1
        const cached = this.loadData(cacheKey)
        if (cached && cached.key && cached.ts && Date.now() - cached.ts < 6 * 3600 * 1000) return
        if (this.__probing) return
        this.__probing = true

        const withTimeout = (promise, ms) =>
            Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
            ])

        const probe = async (key) => {
            const started = Date.now()
            try {
                const url =
                    HIP_IMG_LINES[this.imgKeys(line)[key]] +
                    (samplePath.startsWith('/') ? samplePath : '/' + samplePath)
                const r = await withTimeout(
                    Network.fetchBytes(
                        'GET',
                        url,
                        Object.assign({ 'Range': 'bytes=0-16383' }, this.imageHeaders),
                        null
                    ),
                    2500
                )
                if (r && r.status >= 200 && r.status < 400) return Date.now() - started
            } catch (e) {
                // 超时或失败都算最差
            }
            return 1e9
        }

        Promise.all([probe('line1'), probe('line2')])
            .then((times) => {
                const key = times[1] < times[0] ? 'line2' : 'line1'
                try {
                    this.saveData(cacheKey, { key: key, ts: Date.now(), t1: times[0], t2: times[1] })
                } catch (e) {
                    // 存储失败不影响阅读
                }
            })
            .catch(() => {})
            .then(() => {
                this.__probing = false
            })
    }

    /** 4xx（除 403/429）属于业务错误，换域名没用 */
    static isRetryable(err) {
        const s = String((err && err.message) || err)
        const m = /HTTP (\d{3})/.exec(s)
        if (m) {
            const code = Number(m[1])
            return code >= 500 || code === 403 || code === 429
        }
        return true // 网络层异常
    }

    /** 按候选域名依次请求；v2 用于章节图片接口 */
    async apiGet(pathAndQuery, useV2) {
        let lastErr = ''
        for (const host of this.apiHosts) {
            const url = `${host}${useV2 ? '/v2' : '/v1'}${pathAndQuery}`
            try {
                const data = await this.getJson(url)
                try {
                    this.saveData('api_host_ok', host)
                } catch (e) {
                    // 忽略存储失败
                }
                return data
            } catch (e) {
                lastErr = e
                if (!HipmhSource.isRetryable(e)) throw e
            }
        }
        throw lastErr || '所有 API 域名都不可用'
    }

    /** App 的 Network 没有 timeout，卡住会一直转圈，这里自己加 */
    withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), ms)),
        ])
    }

    /**
     * 图片存活探测（只取 1 字节）。
     * 嬉皮的图片路径是 hash，不含 slug，无法像别家那样比对归属，
     * 所以这里用「图数异常少时抽查」的兜底策略。
     */
    async imageAlive(url) {
        if (!url) return false
        try {
            const r = await this.withTimeout(
                Network.fetchBytes('GET', url, Object.assign({ Range: 'bytes=0-0' }, this.imageHeaders), null),
                5000
            )
            return !!r && r.status >= 200 && r.status < 400
        } catch (e) {
            return false
        }
    }

    async getJson(url) {
        const res = await this.withTimeout(Network.get(url, this.headers), 10000)
        if (res.status !== 200) throw `HTTP ${res.status}: ${url}`
        let json
        try {
            json = JSON.parse(res.body)
        } catch (e) {
            throw `接口返回的不是 JSON: ${String(res.body).slice(0, 80)}`
        }
        if (json.code !== 200) throw `接口错误 ${json.code}: ${json.message || ''}`
        return json.data
    }

    static b64urlDecode(s) {
        let t = String(s).replace(/-/g, '+').replace(/_/g, '/')
        const pad = (4 - (t.length % 4)) % 4
        if (pad) t += '='.repeat(pad)
        try {
            return Convert.decodeUtf8(Convert.decodeBase64(t))
        } catch (e) {
            return ''
        }
    }

    static b64urlEncode(str) {
        const s = Convert.encodeBase64(Convert.encodeUtf8(String(str)))
        return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    /** 完整 id "bToyMzQ3NQ-slug" -> mid "bToyMzQ3NQ" */
    static midOf(id) {
        const s = String(id || '').trim()
        if (!s) return ''
        // 传入的是完整链接
        const fromUrl = /\/works\/([^\/?#]+)/.exec(s)
        const raw = fromUrl ? fromUrl[1] : s
        return raw.split('-')[0]
    }

    /**
     * 前端章节 id -> 图片接口需要的 hid
     * 前端: m:23475-c:195198 (base64url) + "-" + base64url("23475:839.00")
     * 接口: c:195198 (base64url) + "-" + 同一段
     */
    static apiHidOf(hid) {
        const s = String(hid || '').trim()
        if (!s) return ''
        if (s.indexOf('-') < 0) return s
        for (let i = 1; i < s.length; i++) {
            if (s[i] !== '-') continue
            const head = s.slice(0, i)
            const dec = HipmhSource.b64urlDecode(head)
            if (!dec) continue
            if (/^c:\d+$/.test(dec)) return s // 已经是接口格式
            const m = /^m:\d+-c:(\d+)$/.exec(dec)
            if (m) return HipmhSource.b64urlEncode('c:' + m[1]) + s.slice(i)
        }
        return s
    }

    /** 从章节 hid 反推漫画 mid（详情页只需要 mid） */
    static midFromHid(hid) {
        const s = String(hid || '')
        for (let i = 1; i < s.length; i++) {
            if (s[i] !== '-') continue
            const dec = HipmhSource.b64urlDecode(s.slice(0, i))
            if (!dec) continue
            const m = /^m:(\d+)-c:\d+$/.exec(dec)
            if (m) return HipmhSource.b64urlEncode('m:' + m[1])
        }
        return ''
    }

    /**
     * 章节图片解密
     *
     * 站点返回的 images 形如 "qM9....Z7"，结构为：
     *   [A: g2][Vx][B: left][pL0][C: g1]，总长 = body.length
     * 拼回 C + A + B 后，每 7 个字符一组、奇数号组倒序，
     * 再按自定义字符表换成标准 base64，最后 base64url 解码得到 JSON 数组。
     */
    static decodeImages(enc) {
        if (typeof enc !== 'string' || !enc.startsWith('qM9') || !enc.endsWith('Z7')) {
            throw '章节图片数据格式不正确'
        }
        const body = enc.slice(3, enc.length - 2)
        const total = body.length - 5
        if (total <= 0) throw '章节图片数据为空'

        const g1 = Math.floor(total / 3)
        const g2 = Math.floor((total - g1) / 2)
        const left = total - g1 - g2

        const a = body.slice(0, g2)
        if (body.slice(g2, g2 + 2) !== 'Vx') throw '章节图片数据校验失败(Vx)'
        const b = body.slice(g2 + 2, g2 + 2 + left)
        if (body.slice(g2 + 2 + left, g2 + 5 + left) !== 'pL0') throw '章节图片数据校验失败(pL0)'
        const c = body.slice(g2 + 5 + left)
        if (c.length !== g1) throw '章节图片数据长度异常'

        const payload = c + a + b
        let reversed = ''
        for (let i = 0, gi = 0; i < payload.length; i += 7, gi++) {
            const chunk = payload.slice(i, i + 7)
            reversed += gi % 2 ? chunk.split('').reverse().join('') : chunk
        }

        let mapped = ''
        for (let i = 0; i < reversed.length; i++) {
            const k = IMG_SRC_ALPHABET.indexOf(reversed[i])
            if (k < 0) throw `章节图片数据含非法字符: ${reversed[i]}`
            mapped += IMG_DST_ALPHABET[k]
        }

        let std = mapped.replace(/-/g, '+').replace(/_/g, '/')
        const pad = (4 - (std.length % 4)) % 4
        if (pad) std += '='.repeat(pad)

        const text = Convert.decodeUtf8(Convert.decodeBase64(std))
        const arr = JSON.parse(text)
        if (!Array.isArray(arr)) throw '章节图片数据解析失败'
        return arr.filter(x => typeof x === 'string' && x.length > 0)
    }

    /**
     * 官方客户端会按 order_id / sid 算出一个下标，把那张 1x1 占位图删掉，
     * 不删的话阅读时会多出一张透明页。算法与前端一致。
     */
    static removePlaceholderImage(images, orderId, sid) {
        const D = 2654435761
        const R = 2246822507
        const n = images.length
        if (!n) return images
        const m = Math.floor(Number(orderId))
        const g = Math.floor(Number(sid))
        if (!isFinite(m) || !isFinite(g) || m < 0 || g < 0) return images
        try {
            const L = BigInt(g) * BigInt(D)
            const v = BigInt(n) * BigInt(R)
            let b = Number((L ^ v) % BigInt(n))
            if (b < 0) b += n
            const idx = Number(BigInt(m) ^ BigInt(b))
            if (idx < 0 || idx >= n) return images
            const out = images.slice()
            out.splice(idx, 1)
            return out
        } catch (e) {
            // 引擎不支持 BigInt 时不动原数组
            return images
        }
    }

    static parseComic(it) {
        if (!it) return null
        const mid = it.mid || it.id || ''
        const id = String(mid).split('-')[0]
        if (!id) return null
        const cover = it.vertical_image_url || it.cover_image_url || it.image_url || ''
        const authors = it.author_names || []
        const genres = (it.genres || []).map(x => (typeof x === 'string' ? x : x.name))
        const views = it.stats && it.stats.views ? it.stats.views : it.views
        return new Comic({
            id: id,
            title: it.title || '',
            subTitle: authors.join(' / '),
            cover: cover ? (cover.startsWith('http') ? cover : HIP_COVER_BASE + cover) : '',
            tags: genres.slice(0, 3),
            description: views ? `阅读 ${views}` : '',
        })
    }

    static statusText(s) {
        if (s === 'completed') return '已完結'
        if (s === 'ongoing') return '連載中'
        if (s === 'hiatus') return '休載'
        return s || ''
    }

    /**
     * 生成章节 key。App 下载时直接拿它当文件夹名。
     * 默认风格 bookEp：`一人之下 第3话：姐姐3`
     *
     * 话数默认补零到 3 位（第003话）：不补的话 "第10话" 会排到 "第3话" 前面，
     * 因为本地阅读器按文件名字符串排序。超过 999 话在设置里改 4 位。
     *
     * 可选风格：
     *   bookEp  -> 一人之下 第3话：姐姐3
     *   numTitle-> 0003. 姐姐3
     *   num     -> 0003
     *   title   -> 姐姐3
     * key 必须唯一，重名会自动补 (2)。
     */
    static chapterKey(index, c, comicTitle, used) {
        const style = this.__keyStyle || 'bookEp'
        const padWidth = this.__epPad === undefined ? 3 : Number(this.__epPad) || 0
        const seq = index + 1
        const fmt = (n) => (padWidth > 1 ? String(n).padStart(padWidth, '0') : String(n))
        const book = String(comicTitle || '').replace(/[\/\\:*?"<>|]/g, '_').trim()

        // 章节号优先用站点给的 chapter_number，保证和站点编号一致
        let n = Number(c.chapter_number)
        if (!isFinite(n) || n <= 0) n = seq
        const numStr = String(n)

        // 标题：去掉开头的「1.」「第3话」之类，只保留纯标题
        let title = String(c.title || '').trim()
        if (title) {
            const esc = numStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            title = title
                .replace(new RegExp('^' + esc + '[\\s.、,，:：\\-]*'), '')
                .replace(/^第\s*[\d.]+\s*[话話章回集节節][\s.、,，:：\-]*/, '')
                .replace(/^[\d.]+\s+/, '')
                .trim()
        }
        title = title.replace(/[\/\\:*?"<>|]/g, '_')

        let key
        if (style === 'numTitle') key = `${String(seq).padStart(4, '0')}. ${title || numStr}`
        else if (style === 'num') key = String(seq).padStart(4, '0')
        else if (style === 'title') key = title || numStr
        else key = `${book ? book + ' ' : ''}第${fmt(n)}話${title ? '：' + title : ''}`

        // JS 对象里「规范整数」形式的 key 会被引擎排到最前，导致章节乱序
        if (/^(0|[1-9]\d*)$/.test(key)) key = `第${fmt(n)}話`

        // 去重
        if (used && used[key]) {
            let k = 2
            while (used[key + ` (${k})`]) k++
            key = key + ` (${k})`
        }
        if (used) used[key] = true
        return key
    }

    /**
     * 把「序号. 标题」形式的章节 id 还原成站点 hid。
     * 直接用原始 hid 调用时原样返回，兼容旧数据/收藏夹里存的旧 id。
     */
    async resolveHid(comicId, epId) {
        const s = String(epId || '').trim()
        if (!s) return s
        const mid = HipmhSource.midOf(comicId)
        let map = null
        try {
            map = this.loadData('hidmap_' + mid)
        } catch (e) {
            map = null
        }
        if (map && map[s]) return map[s]
        // 旧 id 形态：本身就是一个 hid
        if (HipmhSource.apiHidOf(s) !== s || s.indexOf('-') > 0) return s
        // 兜底：重新取一次章节表，用当前命名规则构造一遍
        const info = await this.fetchChapters(mid)
        const sorted = info.slice().sort((a, b) => {
            const x = Number(a.chapter_number)
            const y = Number(b.chapter_number)
            if (isFinite(x) && isFinite(y) && x !== y) return x - y
            return 0
        })
        const used = {}
        for (let i = 0; i < sorted.length; i++) {
            const c = sorted[i]
            if (!c || !c.hid) continue
            if (HipmhSource.chapterKey(i, c, '', used) === s) return c.hid
        }
        return s
    }

    async fetchChapters(mid) {
        const per = 50
        const first = await this.apiGet(
            `/manga/chapters?mid=${encodeURIComponent(mid)}&page=1&per_page=${per}&order=asc`
        )
        const items = first.items || []
        const totalPages = Math.min(Number(first.total_pages) || 1, 60)
        if (totalPages > 1) {
            const reqs = []
            for (let p = 2; p <= totalPages; p++) {
                reqs.push(
                    this.apiGet(
                        `/manga/chapters?mid=${encodeURIComponent(mid)}&page=${p}&per_page=${per}&order=asc`
                    ).catch(() => null)
                )
            }
            const rest = await Promise.all(reqs)
            for (const r of rest) {
                if (r && Array.isArray(r.items)) items.push(...r.items)
            }
        }
        return items
    }

    // ---------------------------------------------------------------- 发现页

    explore = [
        {
            title: '首頁',
            type: 'multiPartPage',
            load: async (page) => {
                const d = await this.apiGet('/home')
                const parts = []
                const add = (title, list) => {
                    const comics = (list || []).map(HipmhSource.parseComic).filter(x => x)
                    if (comics.length) parts.push({ title: title, comics: comics })
                }
                add('人氣排行', d.popularity_ranking)
                add('本週熱門', d.weekly_hot)
                add('最近更新', d.recent_updates)
                add('新作上架', d.new_releases)
                add('高分韓漫', d.high_rated_korean)
                add('完結推薦', d.completed_recommendations)
                return parts
            },
        },
    ]

    // ---------------------------------------------------------------- 分类

    category = {
        title: '分類',
        parts: [
            {
                name: '地區',
                type: 'fixed',
                itemType: 'category',
                categories: ['國漫', '日漫', '韓漫'],
                categoryParams: ['2', '3', '1'],
            },
            {
                name: '題材',
                type: 'fixed',
                itemType: 'category',
                categories: [
                    '全部',
                    '動作',
                    '劇情',
                    '冒險',
                    '武俠',
                    '玄幻',
                    '系統',
                    '異能',
                    '逆襲',
                    '重生',
                    '穿越',
                    '大女主',
                    '復仇',
                    '宮鬥',
                ],
                categoryParams: ['', '40', '3', '38', '39', '27', '67', '51', '32', '46', '20', '30', '31', '44'],
            },
        ],
        enableRankingPage: true,
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            // 地區用 category 参数，題材用 genre 参数，param 为空表示全部
            const isRegion = ['2', '3', '1'].indexOf(String(param)) >= 0
            const sort = options && options[0] ? options[0] : 'updated'
            let q = `sort=${sort}&page=${page}&per_page=18`
            if (isRegion) {
                q = `category=${encodeURIComponent(param)}&` + q
            } else if (param) {
                q = `genre=${encodeURIComponent(param)}&` + q
            }
            const d = await this.apiGet(`/mangas?${q}`)
            return {
                comics: (d.items || []).map(HipmhSource.parseComic).filter(x => x),
                maxPage: Number(d.total_pages) || 1,
            }
        },
        optionList: [
            {
                label: '排序',
                options: ['updated-最近更新', 'popular-人氣', 'latest-最新'],
            },
        ],
        ranking: {
            options: ['popular-人氣榜', 'updated-最近更新', 'latest-新作', 'completed-已完結'],
            load: async (option, page) => {
                const isCompleted = option === 'completed'
                const sort = isCompleted ? 'popular' : option
                const status = isCompleted ? '&status=completed' : ''
                const d = await this.apiGet(`/mangas?sort=${sort}${status}&page=${page}&per_page=18`)
                return {
                    comics: (d.items || []).map(HipmhSource.parseComic).filter(x => x),
                    maxPage: Number(d.total_pages) || 1,
                }
            },
        },
    }

    // ---------------------------------------------------------------- 搜索

    search = {
        load: async (keyword, options, page) => {
            const kw = String(keyword || '').trim()
            if (!kw) return { comics: [], maxPage: 1 }
            const d = await this.apiGet(`/search?q=${encodeURIComponent(kw)}&page=${page}`)
            return {
                comics: (d.data || []).map(HipmhSource.parseComic).filter(x => x),
                maxPage: Number(d.total_pages) || 1,
            }
        },
    }

    // ---------------------------------------------------------------- 详情

    comic = {
        idMatch: '^(?:(?:https?://)?(?:m\\.)?hipmh\\.com/works/)?([A-Za-z0-9_-]{6,})(?:/[^\\s]*)?$',

        loadInfo: async (id) => {
            const mid = HipmhSource.midOf(id)
            if (!mid) throw '无效的漫画 id'
            const d = await this.apiGet(`/manga?mid=${encodeURIComponent(mid)}`)

            const tags = {}
            const genres = (d.genres || []).map(x => x.name || x)
            if (genres.length) tags['題材'] = genres
            const tagsList = (d.tags || []).map(x => x.name || x).filter(x => x)
            if (tagsList.length) tags['標籤'] = tagsList
            const cats = (d.categories || []).map(x => x.name || x)
            if (cats.length) tags['地區'] = cats
            const authors = (d.authors || []).map(x => x.name || x).filter(x => x)
            if (authors.length) tags['作者'] = authors

            /*
             * 章节 id 用「序号. 标题」而不是站点原始 hid 串。
             * 原因：App 下载时直接用章节 id 当文件夹名，用 hid 会出现
             * bToyMzQ3NS1jOjE5NTE5OA-MjM0NzU6ODM5LjAw 这种看不懂的目录。
             * 这里保留 4 位补零序号，既保证文件夹按章节顺序排列，又能一眼看懂。
             * loadEp / 收藏 等回调收到该 id 后，用 map/hid 反查真实 hid。
             */
            const chapters = {}
            const items = await this.fetchChapters(mid)
            const items2 = items.slice().sort((a, b) => {
                const x = Number(a.chapter_number)
                const y = Number(b.chapter_number)
                if (isFinite(x) && isFinite(y) && x !== y) return x - y
                return 0
            })
            const hidMap = {}
            const used = {}
            HipmhSource.__keyStyle = this.loadSetting('chapter_name') || 'bookEp'
            const pad = Number(this.loadSetting('ep_pad'))
            HipmhSource.__epPad = isFinite(pad) ? pad : 3
            for (let i = 0; i < items2.length; i++) {
                const c = items2[i]
                if (!c || !c.hid) continue
                const key = HipmhSource.chapterKey(i, c, d.title, used)
                chapters[key] = c.title || `第${c.chapter_number}話`
                hidMap[key] = c.hid
            }
            // 供 loadEp 反查：key 不在 map 里时视为原生 hid
            try {
                this.saveData('hidmap_' + mid, hidMap)
            } catch (e) {
                // 忽略存储失败
            }
            // 记住整书封面，loadEp 要往每章第一页插这张
            const bookCover = this.fullCover(d.vertical_image_url || d.cover_image_url)
            if (bookCover) {
                try {
                    this.saveData('cover_' + mid, bookCover)
                } catch (e) {
                    // 忽略
                }
            }

            const stats = d.stats || {}
            const descLines = []
            if (d.description) descLines.push(d.description)
            descLines.push('')
            descLines.push(`狀態：${HipmhSource.statusText(d.status)}`)
            if (authors.length) descLines.push(`作者：${authors.join('、')}`)
            if (stats.views) descLines.push(`閱讀：${stats.views}`)
            if (d.updated_at) descLines.push(`更新：${String(d.updated_at).split('T')[0]}`)

            return new ComicDetails({
                title: d.title || '',
                subTitle: authors.join(' / '),
                cover: this.fullCover(d.vertical_image_url || d.cover_image_url),
                description: descLines.join('\n'),
                tags: tags,
                chapters: chapters,
                isFavorite: false,
                uploader: authors.join('、'),
                updateTime: String(d.updated_at || '').split('T')[0],
                url: `${this.mainHost}/works/${d.slug || mid}`,
            })
        },

        loadEp: async (comicId, epId) => {
            if (!epId) throw '沒有選擇章節'
            const realHid = await this.resolveHid(comicId, epId)
            const apiHid = HipmhSource.apiHidOf(realHid)
            const d = await this.apiGet(`/chapter?hid=${encodeURIComponent(apiHid)}`, true)
            let list = HipmhSource.decodeImages(d.images)
            list = HipmhSource.removePlaceholderImage(list, d.order_id, d.sid)
            const line = Number(d.line)
            const key = this.lineKeyNow(line)
            this.refreshLineLater(list[0], line)

            /*
             * 每章第一页插入整书封面。
             * 这样本地阅读器里每章的封面页都是同一张（而不是各章首图乱跳），
             * 翻章时也不会突然出现不相干的画面。
             * 用 ComicDetails.cover 那张（站点竖版封面），不是章节自己的 264x135 小缩略图。
             */
            if (this.loadSetting('ep_book_cover') !== false && list.length) {
                const mid = HipmhSource.midOf(comicId)
                let bookCover = null
                try {
                    bookCover = this.loadData('cover_' + mid)
                } catch (e) {
                    bookCover = null
                }
                // 缓存里没有就现取一次详情（首次进章节时常见）
                if (!bookCover) {
                    try {
                        const info = await this.comic.loadInfo(comicId)
                        bookCover = info && info.cover ? info.cover : null
                    } catch (e) {
                        bookCover = null
                    }
                }
                if (bookCover) list = [bookCover].concat(list)
            }
            /*
             * 站点数据损坏时，个别章节会只给 1-2 张图且全部 404。
             * 正常章节不会这么少，所以只在图数 <= 2 时抽查一次，成本很低。
             */
            let urls = list.map(p => this.fullImageByKey(p, key))
            if (urls.length && urls.length <= 2) {
                const alive = []
                for (const u of urls) {
                    if (await this.imageAlive(u)) alive.push(u)
                }
                if (!alive.length) throw '本章數據異常（圖片無法下載），建議換源閱讀'
                urls = alive
            }

            return {
                images: urls,
            }
        },

        onImageLoad: (url) => {
            // 线路抖动时自动换另一条线路重试一次
            const swaps = [
                ['hip-tx-1.s3imgs.top', 'hip-cf-1.s3imgs.top'],
                ['hip-cf-1.s3imgs.top', 'hip-tx-1.s3imgs.top'],
                ['hip-tx-s1.s3imgs.top', 'hip-cf-s1.s3imgs.top'],
                ['hip-cf-s1.s3imgs.top', 'hip-tx-s1.s3imgs.top'],
            ]
            return {
                url: url,
                headers: this.imageHeaders,
                onLoadFailed: () => {
                    for (const pair of swaps) {
                        if (String(url).indexOf(pair[0]) >= 0) {
                            return { url: String(url).replace(pair[0], pair[1]), headers: this.imageHeaders }
                        }
                    }
                    return null
                },
            }
        },

        onThumbnailLoad: (url) => {
            return { url: url, headers: { 'User-Agent': HIP_UA } }
        },

        link: {
            domains: ['hipmh.com', 'm.hipmh.com', 'reader.hipmh.top', 'www.hipmh.com'],
            linkToId: (url) => {
                const u = String(url || '')
                const works = /\/works\/([^\/?#]+)/.exec(u)
                if (works) return works[1].split('-')[0]
                const chap = /\/chapter\/([^\/?#]+)/.exec(u)
                if (chap) {
                    const mid = HipmhSource.midFromHid(decodeURIComponent(chap[1]))
                    if (mid) return mid
                }
                return null
            },
        },
    }

    // ---------------------------------------------------------------- 设置

    settings = {
        chapter_name: {
            title: '章節資料夾命名',
            type: 'select',
            options: [
                { value: 'bookEp', text: '書名 第3话：標題' },
                { value: 'numTitle', text: '0003. 標題' },
                { value: 'num', text: '0003（純序號）' },
                { value: 'title', text: '標題（不含序號）' },
            ],
            default: 'bookEp',
        },
        ep_book_cover: {
            title: '每章第一頁插入整書封面',
            type: 'switch',
            default: true,
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
        img_line: {
            title: '圖片線路',
            type: 'select',
            options: [
                { value: 'auto', text: '自動測速 (推薦)' },
                { value: 'line2', text: '線路二 (hip-cf)' },
                { value: 'line1', text: '線路一 (hip-tx)' },
            ],
            default: 'auto',
        },
        api_host: {
            title: 'API 域名（留空自動切換）',
            type: 'input',
            validator: '^$|^https?://.+$',
            default: '',
        },
        main_host: {
            title: '站點域名',
            type: 'input',
            validator: '^https?://.+$',
            default: 'https://m.hipmh.com',
        },
    }

    translation = {
        zh_CN: {
            '圖片線路': '图片线路',
            '線路一 (hip-tx)': '线路一 (hip-tx)',
            '線路二 (hip-cf)': '线路二 (hip-cf)',
            'API 域名': 'API 域名',
            '站點域名': '站点域名',
        },
        zh_TW: {},
        en: {},
    }
}
