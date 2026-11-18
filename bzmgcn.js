/** @type {import('./_venera_.js')} */

/**
 * 包子漫畫 (bzmgcn.com 及其鏡像) Venera 漫畫源
 *
 * 說明：主域名 bzmgcn.com / www.bzmgcn.com 會 301 到被 Cloudflare 攔截的
 * www.baozimh.com（403），所以這裡不寫死任何一個域名，而是內建鏡像候選列表：
 *   https://<cn|tw>.webmota.com
 *   https://<cn|tw>.kukuc.co
 *   https://<cn|tw>.twmanga.com
 *   https://<cn|tw>.dinnerku.com
 *   https://tw.baozimhcn.com   （cn. 前綴會 302 到被封的域名，只在繁體模式用）
 * 每次請求按順序嘗試，成功的寫進 saveData 記住，失敗自動換下一個。
 *
 * 資料來源全部是站點 SSR 出的 HTML，沒有簽名 / cookie / 加密：
 *   發現頁  GET /                                                 （板塊 + 漫畫卡片）
 *   搜索    GET /search?q=<kw>
 *   分類    GET /api/bzmhq/amp_comic_list?type=&region=&state=&page=&limit=36
 *   詳情    GET /comic/<comicId>                                   （章節 a[href*="page_direct"]）
 *   章節圖  GET /comic/chapter/<comicId>/<section>_<chapter>.html  （登錄閱讀頁，內含全部 <img>）
 *
 * 注意：官方 venera-configs 那份 baozi.js 用的 appcn.baozimh.com 現在 403，
 * 且 app 版路徑 /baozimhapp/comic/chapter/... 在鏡像上 404，
 * 所以這裡改用桌面閱讀頁 /comic/chapter/...html，實測 200 且圖片齊全。
 *
 * 大章節會被站點切成多頁：0_24.html → 0_24_2.html → …，
 * 靠頁面底部的「點擊進入下一頁」(div.next_chapter) 連結串起來。
 */

const BZ_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

// 封面 CDN：所有鏡像都指向 static-tw（實測 200，支援 ?w=&h= 縮放）
const BZ_COVER_BASE = 'https://static-tw.baozimh.com'

// 鏡像域名候選（按順序嘗試）。實測 bzmgcn.com 301→403、baozimh.com 403，都不放進來。
const BZ_MIRRORS = ['webmota.com', 'kukuc.co', 'twmanga.com', 'dinnerku.com', 'baozimhcn.com']

// cn.<domain> 在這些域名上會 302 到被封的 www.baozimh.com，簡體模式跳過
const BZ_CN_BROKEN = ['baozimhcn.com']

/* ------------------------------------------------------------------ 純字串工具
 * 全部用正則解析，不依賴 HtmlDocument：
 * 這樣 node 本地測試（local-test.js 沒有偽造 HtmlDocument）也能跑，
 * 而且比建 DOM 快。
 * ------------------------------------------------------------------ */

/** HTML 實體還原 */
function bzUnescape(s) {
    return String(s == null ? '' : s)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => bzFromCode(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (m, d) => bzFromCode(parseInt(d, 10)))
}

function bzFromCode(c) {
    try {
        return String.fromCharCode(c)
    } catch (e) {
        return ''
    }
}

/** 去標籤 + 壓空白 + 還原實體 */
function bzText(html) {
    return bzUnescape(
        String(html == null ? '' : html)
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]*>/g, ' ')
    )
        .replace(/[\u3000\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/** 取第一個捕獲組 */
function bzFirst(html, re) {
    const m = re.exec(String(html == null ? '' : html))
    return m ? m[1] : ''
}

/** 檔名安全化（App 只會替換這幾個字元，這裡先自己處理，避免不同版本差異） */
function bzSafeName(s) {
    return String(s == null ? '' : s)
        .replace(/[\/\\:*?"<>|]/g, '_')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * 列表卡片解析（首頁 / 搜索 / 最新上架 共用同一套 DOM）
 * 一張卡片長這樣：
 *   <div class="comics-card ...">
 *     <a href="/comic/<id>" title="..."><amp-img ... src="封面"><div class="tabs cls"><span>標籤</span></div></a>
 *     <a ...><h3>標題</h3><small>更新至 xx</small></a>
 *   </div>
 */
function bzParseCards(html, host) {
    const out = []
    const chunks = String(html == null ? '' : html).split('class="comics-card ')
    for (let i = 1; i < chunks.length; i++) {
        const c = chunks[i]
        const href = /href="(\/comic\/[^"]+)"/.exec(c)
        if (!href) continue
        const id = String(href[1]).split('/').pop().split('?')[0].trim()
        if (!id) continue
        const title = bzText(bzFirst(c, /<h3[^>]*>([\s\S]*?)<\/h3>/))
        let cover = bzUnescape(bzFirst(c, /<amp-img[^>]*\ssrc="([^"]+)"/))
        if (!cover || cover.indexOf('default_cover') >= 0) cover = ''
        const tags = []
        const tabs = bzFirst(c, /class="tabs[^"]*"[^>]*>([\s\S]*?)<\/div>/)
        if (tabs) {
            const re = /<span[^>]*>([\s\S]*?)<\/span>/g
            let m
            while ((m = re.exec(tabs)) !== null) {
                const t = bzText(m[1])
                if (t) tags.push(t)
            }
        }
        const sub = bzText(bzFirst(c, /<small[^>]*>([\s\S]*?)<\/small>/))
        out.push(
            new Comic({
                id: id,
                title: title || id,
                cover: cover,
                tags: tags.slice(0, 3),
                description: sub,
                subTitle: sub,
            })
        )
    }
    return out
}

/** 數字補零（支援 12.5 這種非整數話數） */
function bzFmtNum(n, width) {
    const v = Number(n)
    const w = Math.max(1, Math.floor(Number(width) || 1))
    if (!isFinite(v)) return String(n)
    if (Math.abs(v - Math.round(v)) < 1e-9) {
        const s = String(Math.abs(Math.round(v))).padStart(w, '0')
        return (v < 0 ? '-' : '') + s
    }
    const ip = Math.trunc(v)
    const frac = String(v).split('.')[1] || ''
    return String(Math.abs(ip)).padStart(w, '0') + '.' + frac
}

/**
 * 章節標題 → { num, title }
 * 站點章節標題格式很雜，實測有：
 *   "784 潛入"            → 784 / 潛入
 *   "新767 坦白"          → 767 / 坦白
 *   "114.要聽爸媽的話"     → 114 / 要聽爸媽的話
 *   "第660回"             → 660 / (空)
 *   "《一人之下番外鏽鐵》第1話分鏡" → 1 / 整個標題（序號在句中，不動標題）
 *   "一人之下 X 品客薯片"  → null / 原樣（沒有話數）
 */
function bzParseChapterTitle(raw) {
    const orig = String(raw == null ? '' : raw)
        .replace(/[\u3000\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    let s = orig
    let num = null
    // 整條標題就是個話數（站點有 264 個這種「318」只有號碼沒有標題的章節）
    if (/^\d+(?:\.\d+)?$/.test(s)) {
        return { num: parseFloat(s), title: '' }
    }
    let m = /^第\s*(\d+(?:\.\d+)?)\s*[话話回章集节節]\s*[：:.、,，\-—–~～]?\s*/.exec(s)
    if (m) {
        num = parseFloat(m[1])
        s = s.slice(m[0].length)
    }
    if (num === null) {
        m = /^(?:新|番外|序章|特別篇)?\s*(\d+(?:\.\d+)?)\s*(?:[话話回章][：:.、,，\-—–~～]?\s*|[.、,:：\-—–~～]\s*|\s+)/.exec(s)
        if (m) {
            num = parseFloat(m[1])
            s = s.slice(m[0].length)
        }
    }
    if (num === null) {
        m = /第\s*(\d+(?:\.\d+)?)\s*[话話回章集节節]/.exec(s)
        if (m) num = parseFloat(m[1])
    }
    // 番外/特別篇：序号不是标题开头的一部分，不能占用正片话数（否则和正片第1话重号）
    const extra = /番外|特別篇|特别篇|序章|後記|后记|公告|休載|休载|恢復更新|恢复更新/.test(s)
    s = s.replace(/^[：:.\-—–、,，\s]+/, '').replace(/[\s：:.\-—–、,，]+$/, '').trim()
    if (!s) s = num === null ? orig : ''
    // 番外里再剥一次「第N话」前缀，避免标题重复
    if (extra) {
        s = s.replace(/^第\s*(?:\d+|[一二三四五六七八九十百千零〇两]+)\s*[话話回章集节節][\s.、,，:：\-]*/, '').trim()
        if (!s) s = orig
    }
    return { num: num, title: s, extra: extra }
}

/**
 * 章節 key（= App 下載時的檔案夾名）。預設 `書名 第003話：標題`。
 * 話數補零：本地閱讀器按字串排序，不補零 `第10話` 會排到 `第3話` 前面。
 */
function bzChapterKey(style, padWidth, book, num, title, used) {
    const b = bzSafeName(book)
    const t = bzSafeName(title)
    const n = bzFmtNum(num, padWidth)
    let key
    if (style === 'num') key = bzFmtNum(num, Math.max(4, padWidth))
    else if (style === 'numTitle') key = bzFmtNum(num, Math.max(4, padWidth)) + (t ? '. ' + t : '')
    else if (style === 'title') key = t || '第' + n + '话'
    else key = (b ? b + ' ' : '') + '第' + n + '话' + (t ? '：' + t : '')
    // JS 物件會把「規範整數」形式的 key 排到最前，章節順序會全亂 → 強制非純數字
    if (/^(0|[1-9]\d*)$/.test(key)) key = '第' + n + '话'
    if (used) {
        if (used[key]) {
            let k = 2
            while (used[key + ' (' + k + ')']) k++
            key = key + ' (' + k + ')'
        }
        used[key] = true
    }
    return key
}

/** 圖片加 CDN 縮放段：/w640/scomic/... （站點只認 w640，w1080 會 404） */
function bzWithQuality(url, q) {
    const u = String(url == null ? '' : url)
    const qual = String(q == null ? '' : q).replace(/^\/+|\/+$/g, '')
    if (!qual || !/^https?:\/\//.test(u)) return u
    const m = /^(https?:\/\/[^\/]+)(\/[\s\S]*)$/.exec(u)
    if (!m) return u
    if (m[2].indexOf('/' + qual + '/') === 0) return u
    return m[1] + '/' + qual + m[2]
}

/** 從 id / 鏈接裡取 comicId */
function bzComicId(id) {
    const s = String(id == null ? '' : id).trim()
    if (!s) return ''
    const m = /\/comic\/([A-Za-z0-9_.\-]+)/.exec(s)
    if (m && m[1] !== 'chapter') return m[1]
    if (/^[A-Za-z0-9_.\-]+$/.test(s)) return s
    return ''
}

/**
 * 章節圖片 CDN 統一。
 * 站點在閱讀頁裡給的是 s1/s2/s3.bzcdn.net，但這些域名會 302 跳到隨機分片域名
 * （如 s1-mha1-nlams.bzcdn.net），分片域名在很多網絡下連不上（實測 SSL 直接失敗），
 * 表現就是閱讀時 404 / 打不開。
 * 實測同一路徑在 static-tw.baozimh.com 上直接 200，所以統一換到它上面。
 */
const BZ_IMG_HOST_RE = /^https?:\/\/[a-z0-9-]*\.?bzcdn\.net/i

function bzNormalizeImageHost(url) {
    const u = String(url == null ? '' : url)
    if (!BZ_IMG_HOST_RE.test(u)) return u
    return u.replace(BZ_IMG_HOST_RE, BZ_COVER_BASE)
}

/** 章節圖片：閱讀頁裡所有 <img>（實測全部來自 s1/s2.bzcdn.net，沒有廣告圖） */
function bzParseImages(html) {
    const out = []
    const seen = {}
    const re = /<img[^>]*\ssrc="([^"]+)"/g
    let m
    while ((m = re.exec(String(html == null ? '' : html))) !== null) {
        let u = bzUnescape(m[1]).trim()
        if (!u) continue
        if (u.indexOf('//') === 0) u = 'https:' + u
        if (!/^https?:\/\//.test(u)) continue
        if (u.indexOf('/scomic/') < 0) continue
        u = u.split('?')[0]
        u = bzNormalizeImageHost(u)
        if (seen[u]) continue
        seen[u] = 1
        out.push(u)
    }
    return out
}

/**
 * 過濾掉「不屬於本書」的圖片。
 * 站點數據損壞時，某些書的章節頁會指向**另一部漫畫**的圖片
 * （例如《我的召喚物全是SSS級天賦》正文全是《美少年綁架事件》的圖，且全部 404）。
 * 圖片路徑形如 /scomic/<slug>/0/<code>/1.jpg，slug 就是漫畫 id，可以直接比對。
 */
function bzFilterBadImages(images, cid) {
    const id = String(cid == null ? '' : cid).trim()
    if (!id) return images
    const out = []
    for (const u of images) {
        const m = /\/scomic\/([^\/]+)\//.exec(String(u))
        if (!m) {
            out.push(u) // 路徑裡沒有 slug，無法判斷，保留
            continue
        }
        const slug = m[1]
        if (slug === id || slug.indexOf(id) === 0 || id.indexOf(slug) === 0) out.push(u)
    }
    return out
}

/** 閱讀頁底部的「點擊進入下一頁」連結（同一章的分頁） */
function bzNextPageHref(html) {
    const s = String(html == null ? '' : html)
    let m = /class="next_chapter"[^>]*>\s*<a[^>]*href="([^"]+)"/.exec(s)
    if (!m) m = /href="([^"]*\/comic\/chapter\/[^"]*)"[^>]*class="[^"]*next_chapter/.exec(s)
    return m ? bzUnescape(m[1]) : ''
}

class BzmgcnSource extends ComicSource {
    name = '包子漫畫'
    key = 'bzmgcn'
    version = '1.0.0'
    minAppVersion = '1.0.0'
    // 換成你自己的倉庫地址
    url = 'https://cdn.jsdelivr.net/gh/your-name/venera-configs@main/bzmgcn.js'

    // ------------------------------------------------------------ 站點 / 域名

    /** 簡繁：站點用 cn. / tw. 前綴區分 */
    get lang() {
        return this.loadSetting('language') === 'tw' ? 'tw' : 'cn'
    }

    /**
     * 候選站點（完整 origin）。
     * 順序：設置裡手動指定的 → 上次成功的 → 內建鏡像列表。
     * 手動指定時只用那一個，方便用戶在自動切換失靈時鎖定。
     */
    hostCandidates() {
        const manual = String(this.loadSetting('domain') || 'auto')
        const lang = this.lang
        const build = (d) => 'https://' + (d.indexOf('.') === 0 ? lang + '.' + d.slice(1) : d)

        if (manual !== 'auto') {
            // 手動選定：只用這一個（帶 cn./tw. 前綴的按簡繁自動切換）
            const one = build(manual)
            // 兼容用戶手填完整 URL
            if (/^https?:\/\//.test(manual)) return [manual.replace(/\/+$/, '')]
            return [one.replace(/\/+$/, '')]
        }

        const out = []
        const push = (u) => {
            const h = String(u == null ? '' : u).trim().replace(/\/+$/, '')
            if (!h || !/^https?:\/\//.test(h)) return
            if (out.indexOf(h) < 0) out.push(h)
        }
        // 上次成功的排最前，避免每次从头试
        push(this.loadData('host_ok'))
        for (const d of BZ_MIRRORS) {
            if (this.lang === 'cn' && BZ_CN_BROKEN.indexOf(d) >= 0) continue
            push('https://' + this.lang + '.' + d)
        }
        return out
    }

    get currentHost() {
        const hosts = this.hostCandidates()
        return hosts.length ? hosts[0] : 'https://cn.webmota.com'
    }

    get headers() {
        return {
            'User-Agent': BZ_UA,
            'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': this.lang === 'tw' ? 'zh-TW,zh;q=0.9' : 'zh-CN,zh;q=0.9',
        }
    }

    /** 圖片請求頭：圖片本身沒防盜鏈，但帶上 Referer / UA 更穩 */
    get imageHeaders() {
        return {
            'User-Agent': BZ_UA,
            'Referer': this.currentHost + '/',
            'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
        }
    }

    /**
     * 按候選域名依次取值；path 可以是字串，也可以是 (host) => 字串（要拼絕對地址的接口用）。
     * 成功就記住這個域名，下次直接用。
     */
    /** 带超时的请求；App 的 Network 没有 timeout 参数，卡住会一直转圈 */
    withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
        ])
    }

    /**
     * 按候選域名依次取值；path 可以是字串，也可以是 (host) => 字串。
     * 每個域名最多等 8 秒，超時就換下一個 —— 避免某個域名卡住導致一直轉圈。
     * 成功就記住這個域名，下次優先用它。
     */
    async fetchPage(pathOrFn) {
        const hosts = this.hostCandidates()
        let lastErr = ''
        for (const host of hosts) {
            const p = typeof pathOrFn === 'function' ? pathOrFn(host) : pathOrFn
            const url = host + (String(p).charAt(0) === '/' ? p : '/' + p)
            try {
                const res = await this.withTimeout(Network.get(url, this.headers), 8000)
                if (!res || res.status !== 200) {
                    lastErr = 'HTTP ' + (res ? res.status : '?') + ' ' + url
                    continue
                }
                const body = String(res.body == null ? '' : res.body)
                if (body.length < 500) {
                    lastErr = '響應過短(' + body.length + ') ' + url
                    continue
                }
                try {
                    this.saveData('host_ok', host)
                } catch (e) {
                    // 存不了不影響功能
                }
                return { host: host, body: body }
            } catch (e) {
                lastErr = String((e && e.message) || e) + ' ' + url
            }
        }
        throw '所有鏡像域名都不可用：' + lastErr
    }

    /**
     * 檢測封面能不能下載。
     * 站點有約 6% 的書 cover/*.jpg 根本沒上傳（新書常見），表現是 404。
     * 用 Range 只取 1 字節，成本很低。
     */
    async coverAlive(url) {
        if (!url) return false
        try {
            const r = await this.withTimeout(
                Network.fetchBytes(
                    'GET',
                    url,
                    Object.assign({ Range: 'bytes=0-0' }, this.imageHeaders),
                    null
                ),
                5000
            )
            return !!r && r.status >= 200 && r.status < 400
        } catch (e) {
            return false
        }
    }

    /** 取某章的第一張正文圖（用於封面缺失時兜底） */
    async firstPageOf(cid, epKey) {
        try {
            const real = await this.comic.resolveHid(cid, epKey)
            const hm = /^(\d+)_(\d+)$/.exec(String(real))
            if (!hm) return ''
            const r = await this.fetchPage(
                '/comic/chapter/' + encodeURIComponent(cid) + '/' + hm[1] + '_' + hm[2] + '.html'
            )
            const imgs = bzParseImages(r.body)
            return imgs.length ? imgs[0] : ''
        } catch (e) {
            return ''
        }
    }

    // ------------------------------------------------------------ 發現頁

    explore = [
        {
            title: '首頁',
            type: 'multiPartPage',
            load: async (page) => {
                const r = await this.fetchPage('/')
                const parts = []
                const segs = String(r.body).split('index-recommend-items')
                for (let i = 1; i < segs.length; i++) {
                    const seg = segs[i]
                    const t = bzText(bzFirst(seg, /catalog-title[^>]*>([\s\S]{0,120}?)<\/div>/))
                    const comics = bzParseCards(seg, r.host)
                    if (comics.length) parts.push({ title: t || '推薦 ' + i, comics: comics })
                }
                if (!parts.length) throw '首頁解析失敗（可能被防火牆攔截）'
                return parts
            },
        },
        {
            title: '最新上架',
            type: 'multiPageComicList',
            load: async (page) => {
                const p = Number(page) > 1 ? '/list/new?page=' + Number(page) : '/list/new'
                const r = await this.fetchPage(p)
                const comics = bzParseCards(r.body, r.host)
                if (!comics.length) throw '最新上架解析失敗'
                return { comics: comics, maxPage: 1 }
            },
        },
    ]

    // ------------------------------------------------------------ 分類

    category = {
        title: '包子漫畫',
        parts: [
            {
                name: '類型',
                type: 'fixed',
                itemType: 'category',
                categories: [
                    '全部',
                    '戀愛',
                    '純愛',
                    '古風',
                    '異能',
                    '懸疑',
                    '劇情',
                    '科幻',
                    '奇幻',
                    '玄幻',
                    '穿越',
                    '冒險',
                    '推理',
                    '武俠',
                    '格鬥',
                    '戰爭',
                    '熱血',
                    '搞笑',
                    '大女主',
                    '都市',
                    '總裁',
                    '後宮',
                    '日常',
                    '韓漫',
                    '少年',
                    '其它',
                ],
                categoryParams: [
                    'all',
                    'lianai',
                    'chunai',
                    'gufeng',
                    'yineng',
                    'xuanyi',
                    'juqing',
                    'kehuan',
                    'qihuan',
                    'xuanhuan',
                    'chuanyue',
                    'mouxian',
                    'tuili',
                    'wuxia',
                    'gedou',
                    'zhanzheng',
                    'rexie',
                    'gaoxiao',
                    'danuzhu',
                    'dushi',
                    'zongcai',
                    'hougong',
                    'richang',
                    'hanman',
                    'shaonian',
                    'qita',
                ],
            },
            {
                name: '地區',
                type: 'fixed',
                itemType: 'category',
                categories: ['全部', '國漫', '日本', '韓國', '歐美'],
                categoryParams: ['r:all', 'r:cn', 'r:jp', 'r:kr', 'r:en'],
            },
        ],
        enableRankingPage: false,
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            const p = String(param == null ? '' : param)
            // "r:cn" 表示按地區篩選（類型=all），其它按類型篩選（地區用選項）
            let type = p || 'all'
            let region = (options && options[0]) || 'all'
            if (p.indexOf('r:') === 0) {
                type = 'all'
                region = p.slice(2) || 'all'
            }
            const state = (options && options[1]) || 'all'
            const pg = Number(page) > 0 ? Number(page) : 1
            const path = (host) =>
                '/api/bzmhq/amp_comic_list?type=' +
                encodeURIComponent(type) +
                '&region=' +
                encodeURIComponent(region) +
                '&state=' +
                encodeURIComponent(state) +
                '&filter=%2a&page=' +
                pg +
                '&limit=36&language=' +
                this.lang +
                '&__amp_source_origin=' +
                encodeURIComponent(host)
            const r = await this.fetchPage(path)
            let json
            try {
                json = JSON.parse(r.body)
            } catch (e) {
                throw '分類接口返回的不是 JSON（域名可能被換成驗證頁）'
            }
            const items = Array.isArray(json.items) ? json.items : []
            return {
                comics: items.map((e) => this.parseApiComic(e)).filter((x) => x),
                maxPage: json.next ? pg + 1 : pg,
            }
        },
        optionList: [
            {
                label: '地區',
                options: ['all-全部', 'cn-國漫', 'jp-日本', 'kr-韓國', 'en-歐美'],
            },
            {
                label: '狀態',
                options: ['all-全部', 'serial-連載中', 'pub-已完結'],
            },
        ],
    }

    /** 分類接口的漫畫（欄位和 HTML 卡片不同） */
    parseApiComic(e) {
        if (!e) return null
        const id = String(e.comic_id || e.id || '').split('/').pop()
        if (!id) return null
        let cover = String(e.topic_img || e.cover || '')
        if (cover && !/^https?:\/\//.test(cover)) {
            cover = BZ_COVER_BASE + '/cover/' + (cover.charAt(0) === '/' ? cover.slice(1) : cover)
            if (cover.indexOf('?') < 0) cover += '?w=285&h=375&q=100'
        }
        const tags = Array.isArray(e.type_names) ? e.type_names : []
        return new Comic({
            id: id,
            title: bzText(e.name || id),
            subTitle: bzText(e.author || ''),
            cover: cover,
            tags: tags.slice(0, 3).map((t) => bzText(t)),
            description: bzText(e.author || ''),
        })
    }

    // ------------------------------------------------------------ 搜索

    search = {
        load: async (keyword, options, page) => {
            const kw = String(keyword == null ? '' : keyword).trim()
            if (!kw) return { comics: [], maxPage: 1 }
            const r = await this.fetchPage('/search?q=' + encodeURIComponent(kw))
            // 搜索頁沒有分頁（站點一次給全），關鍵詞無結果時卡片數為 0
            return { comics: bzParseCards(r.body, r.host), maxPage: 1 }
        },
        optionList: [],
    }

    // ------------------------------------------------------------ 詳情

    /** 從詳情頁取章節條目：{sec, slot, raw}，按 section_slot + chapter_slot 去重 */
    parseChapterEntries(html) {
        const out = []
        const seen = {}
        const re = /<a[^>]*href="([^"]*page_direct[^"]*)"[^>]*class="[^"]*comics-chapters__item[^"]*"[^>]*>([\s\S]*?)<\/a>/g
        let m
        while ((m = re.exec(String(html == null ? '' : html))) !== null) {
            const href = bzUnescape(m[1])
            const sec = bzFirst(href, /section_slot=(\d+)/) || '0'
            const slot = bzFirst(href, /chapter_slot=(\d+)/)
            if (!slot) continue
            const k = sec + '_' + slot
            // 詳情頁前 24 章是「最近更新」，和下面的完整目錄重複 → 必須去重，否則章節會出現兩遍
            if (seen[k]) continue
            seen[k] = 1
            const t = bzFirst(m[2], /<span[^>]*>([\s\S]*?)<\/span>/)
            out.push({ sec: sec, slot: Number(slot), raw: bzText(t) })
        }
        return out
    }

    /**
     * 章節排序 + 生成 key。
     * 站點目錄順序不可信（實測有「215 如之奈何」夾在 224 後面的情況），
     * 所以先按 chapter_slot 排（= 上傳順序），再按解析出的話數排；
     * 沒有話數的章節（"恢復周更！"）依附在前一個有號碼的章節後面。
     */
    buildChapters(entries, comicTitle) {
        const style = this.loadSetting('chapter_name') || 'bookEp'
        const pad = Number(this.loadSetting('ep_pad'))
        const padWidth = isFinite(pad) && pad >= 0 ? pad : 3
        const list = entries.slice().sort((a, b) => a.slot - b.slot || Number(a.sec) - Number(b.sec))
        let prev = 0
        let frac = 0
        for (const e of list) {
            const p = bzParseChapterTitle(e.raw)
            e.num = p.num
            e.text = p.title
            e.extra = !!p.extra
            if (p.num !== null && isFinite(p.num)) {
                e.sort = p.num
                prev = p.num
                frac = 0
            } else {
                frac += 1
                e.sort = prev + frac / 1000
            }
        }
        // 番外/特別篇统一排到正片之后，避免和正片话数重号
        list.sort((a, b) => {
            if (a.extra !== b.extra) return a.extra ? 1 : -1
            return a.sort - b.sort || a.slot - b.slot
        })
        const used = {}
        const chapters = {}
        const map = {}
        const idxMap = {}
        for (let i = 0; i < list.length; i++) {
            const e = list[i]
            const num = e.num !== null && isFinite(e.num) ? e.num : Math.floor(e.sort)
            let key
            let label
            if (e.extra) {
                // 番外：书名 番外：标题
                const b = bzSafeName(comicTitle)
                const t = bzSafeName(e.text) || '特別篇'
                key = (b ? b + ' ' : '') + '番外：' + t
                label = '番外：' + t
                if (used[key]) {
                    let k = 2
                    while (used[key + ' (' + k + ')']) k++
                    key = key + ' (' + k + ')'
                }
                used[key] = true
            } else {
                key = bzChapterKey(style, padWidth, comicTitle, num, e.text, used)
                label = '第' + bzFmtNum(num, padWidth) + '话' + (e.text ? '：' + e.text : '')
            }
            const real = e.sec + '_' + e.slot
            chapters[key] = label
            map[key] = real
            idxMap[String(i)] = real
        }
        return { chapters: chapters, map: map, idxMap: idxMap, count: list.length }
    }

    comic = {
        loadInfo: async (id) => {
            const cid = bzComicId(id)
            if (!cid) throw '無效的漫畫 id：' + id
            const r = await this.fetchPage('/comic/' + encodeURIComponent(cid))
            const html = r.body

            const title =
                bzText(bzFirst(html, /<h1[^>]*class="[^"]*comics-detail__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/)) || cid
            const author = bzText(bzFirst(html, /<h2[^>]*class="[^"]*comics-detail__author[^"]*"[^>]*>([\s\S]*?)<\/h2>/))
            const desc = bzText(bzFirst(html, /<p[^>]*class="[^"]*comics-detail__desc[^"]*"[^>]*>([\s\S]*?)<\/p>/))

            // 封面：詳情頁第一張 /cover/ 海報（跳過 default_cover 佔位圖）
            let cover = ''
            const cre = /<amp-img[^>]*\ssrc="(https?:\/\/[^"]*\/cover\/[^"]+)"/g
            let cm
            while ((cm = cre.exec(html)) !== null) {
                const u = bzUnescape(cm[1])
                if (u.indexOf('default_cover') >= 0) continue
                cover = u
                break
            }

            // 更新時間：(2026年06月26日 更新)
            let updateTime = ''
            const dm = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(html)
            if (dm) {
                updateTime =
                    dm[1] + '-' + String(dm[2]).padStart(2, '0') + '-' + String(dm[3]).padStart(2, '0')
            }

            // 標籤區：第一個 span 是狀態，第二個是地區，其餘是題材
            const tagTexts = []
            const tagBlock = bzFirst(html, /<div[^>]*class="[^"]*tag-list[^"]*"[^>]*>([\s\S]*?)<\/div>/)
            if (tagBlock) {
                const re = /<span[^>]*>([\s\S]*?)<\/span>/g
                let m
                while ((m = re.exec(tagBlock)) !== null) {
                    const t = bzText(m[1])
                    if (t) tagTexts.push(t)
                }
            }
            const statusRe = /(連載中|连载中|已完結|已完结|休載|休载|暫停|暂停)/
            const regions = ['國漫', '国漫', '日漫', '日本', '韓漫', '韩漫', '歐美', '欧美']
            let status = ''
            let region = ''
            const genres = []
            for (const t of tagTexts) {
                if (!status && statusRe.test(t)) {
                    status = t
                    continue
                }
                if (!region && regions.indexOf(t) >= 0) {
                    region = t
                    continue
                }
                if (genres.indexOf(t) < 0) genres.push(t)
            }
            const tags = {}
            if (status) tags['狀態'] = [status]
            if (region) tags['地區'] = [region]
            if (genres.length) tags['題材'] = genres
            if (author) tags['作者'] = [author]

            const entries = this.parseChapterEntries(html)
            if (!entries.length) throw '章節列表解析失敗（頁面結構可能已變）'
            const built = this.buildChapters(entries, title)

            // 存映射：章節 key → 站點真實 id（section_slot_chapter_slot）
            try {
                this.saveData('epmap_' + cid, built.map)
                this.saveData('idxmap_' + cid, built.idxMap)
            } catch (e) {
                // 忽略
            }
            /*
             * 封面兜底：站點有些書（尤其新書）的 cover/*.jpg 沒上傳，直接 404。
             * 這時改用該書第一章的第一張正文圖 —— 包子很多書的正文首頁本身就是封面圖。
             * 開關默認開，嫌打開詳情頁慢可以關掉。
             */
            if (cover && this.loadSetting('cover_fallback') !== false) {
                const alive = await this.coverAlive(cover)
                if (!alive) {
                    const firstKey = Object.keys(built.chapters)[0]
                    if (firstKey) {
                        const fb = await this.firstPageOf(cid, firstKey)
                        // 回退圖本身也可能是壞的（站點數據錯亂時常見），再驗一次
                        if (fb && (await this.coverAlive(fb))) cover = fb
                    }
                }
            }

            // 整書封面：每章第一頁要插這張，所以存一份大圖
            if (cover) {
                const big = /\/cover\//.test(cover)
                    ? cover.replace(/([?&])w=\d+/, '$1w=720').replace(/([?&])h=\d+/, '$1h=960')
                    : cover
                try {
                    this.saveData('cover_' + cid, big)
                } catch (e) {
                    // 忽略
                }
            }

            const descLines = []
            if (desc) descLines.push(desc)
            descLines.push('')
            if (status) descLines.push('狀態：' + status)
            if (author) descLines.push('作者：' + author)
            if (region) descLines.push('地區：' + region)
            if (updateTime) descLines.push('更新：' + updateTime)
            descLines.push('章節：' + built.count + ' 章')

            return new ComicDetails({
                title: title,
                subTitle: author,
                cover: cover,
                description: descLines.join('\n'),
                tags: tags,
                chapters: built.chapters,
                isFavorite: false,
                uploader: author,
                updateTime: updateTime,
                url: r.host + '/comic/' + cid,
            })
        },

        /**
         * 章節 key → 站點真實 id 反查（三級兜底）
         * 1) loadInfo 時存下的映射
         * 2) 重新拉一次章節表（會重建映射）
         * 3) 原樣返回（兼容老數據裡直接存原生 0_123 的 id）
         */
        resolveHid: async (comicId, epId) => {
            const cid = bzComicId(comicId)
            const s = String(epId == null ? '' : epId).trim()
            if (!s) return s
            if (/^\d+_\d+$/.test(s)) return s
            let map = null
            try {
                map = this.loadData('epmap_' + cid)
            } catch (e) {
                map = null
            }
            if (map && map[s]) return map[s]
            let idx = null
            try {
                idx = this.loadData('idxmap_' + cid)
            } catch (e) {
                idx = null
            }
            if (idx && /^\d+$/.test(s) && idx[s]) return idx[s]
            // 二級：重拉章節表（loadInfo 內部會重寫 epmap / idxmap）
            try {
                await this.comic.loadInfo(cid)
            } catch (e) {
                // 拉不到就走第三級
            }
            try {
                map = this.loadData('epmap_' + cid)
                idx = this.loadData('idxmap_' + cid)
            } catch (e) {
                map = null
                idx = null
            }
            if (map && map[s]) return map[s]
            if (idx && /^\d+$/.test(s) && idx[s]) return idx[s]
            return s
        },

        loadEp: async (comicId, epId) => {
            const cid = bzComicId(comicId)
            if (!cid) throw '無效的漫畫 id：' + comicId
            if (!epId) throw '沒有選擇章節'
            const real = await this.comic.resolveHid(cid, epId)
            const hm = /^(\d+)_(\d+)$/.exec(String(real))
            if (!hm) throw '章節 id 無法識別：' + epId
            const seg0 = hm[1] + '_' + hm[2]

            const images = []
            const seen = {}
            let part = 1
            // 大章節站點會切成 0_24.html / 0_24_2.html，靠 next_chapter 連結往下翻
            for (let guard = 1; guard <= 40; guard++) {
                const seg = part === 1 ? seg0 : seg0 + '_' + part
                const r = await this.fetchPage(
                    '/comic/chapter/' + encodeURIComponent(cid) + '/' + seg + '.html'
                )
                const imgs = bzParseImages(r.body)
                if (!imgs.length) {
                    if (part === 1) throw '章節圖片解析失敗（' + seg + '）'
                    break
                }
                for (const u of imgs) {
                    if (seen[u]) continue
                    seen[u] = 1
                    images.push(u)
                }
                const next = bzNextPageHref(r.body)
                if (!next) break
                // 只跟進「同一章的第 N 頁」，其它情況（下一章 / 回到底部）就停
                const nm = new RegExp('/' + seg0 + '_(\\d+)\\.html').exec(next)
                if (!nm || Number(nm[1]) !== part + 1) break
                part = Number(nm[1])
            }
            if (!images.length) throw '章節沒有圖片（' + cid + ' / ' + epId + '）'

            // 過濾掉指向其它漫畫的圖（站點數據損壞時會出現）
            let cleaned = bzFilterBadImages(images, cid)
            if (images.length && !cleaned.length) {
                throw '本章數據異常（圖片指向其他漫畫），建議換源閱讀'
            }

            const q = this.loadSetting('img_quality')
            let list = cleaned.map((u) => bzWithQuality(u, q))

            // 每章第一頁插入整書封面（用整書封面，不是章節縮略圖）
            if (this.loadSetting('ep_book_cover') !== false && list.length) {
                let bookCover = null
                try {
                    bookCover = this.loadData('cover_' + cid)
                } catch (e) {
                    bookCover = null
                }
                if (!bookCover) {
                    try {
                        const info = await this.comic.loadInfo(cid)
                        bookCover = info && info.cover ? info.cover : null
                    } catch (e) {
                        bookCover = null
                    }
                }
                if (bookCover) list = [bookCover].concat(list)
            }
            return { images: list }
        },

        onImageLoad: (url) => {
            const u = String(url == null ? '' : url)
            return {
                url: u,
                headers: this.imageHeaders,
                onLoadFailed: () => {
                    // 1) CDN 不認縮放段時退回原圖
                    const q = String(this.loadSetting('img_quality') || '').replace(/^\/+|\/+$/g, '')
                    if (q) {
                        const stripped = u.replace(new RegExp('^(https?://[^/]+)/' + q + '/'), '$1/')
                        if (stripped !== u) return { url: stripped, headers: this.imageHeaders }
                    }
                    // 2) 封面 / 圖片 CDN 換成 static 站
                    if (u.indexOf('s1.bzcdn.net') >= 0) {
                        return { url: u.replace('s1.bzcdn.net', 'static-tw.baozimh.com'), headers: this.imageHeaders }
                    }
                    if (u.indexOf('static-tw.baozimh.com') >= 0) {
                        return { url: u.replace('static-tw.baozimh.com', 's1.bzcdn.net'), headers: this.imageHeaders }
                    }
                    return null
                },
            }
        },

        onThumbnailLoad: (url) => {
            return { url: String(url == null ? '' : url), headers: { 'User-Agent': BZ_UA } }
        },

        link: {
            domains: [
                'bzmgcn.com',
                'baozimh.com',
                'baozimhcn.com',
                'webmota.com',
                'kukuc.co',
                'twmanga.com',
                'dinnerku.com',
            ],
            linkToId: (url) => {
                const id = bzComicId(url)
                return id || null
            },
        },
    }

    // ------------------------------------------------------------ 設置

    settings = {
        domain: {
            title: '站點域名',
            type: 'select',
            options: [
                { value: 'auto', text: '自動切換（推薦）' },
                { value: '.webmota.com', text: 'webmota.com' },
                { value: '.kukuc.co', text: 'kukuc.co' },
                { value: '.twmanga.com', text: 'twmanga.com' },
                { value: '.dinnerku.com', text: 'dinnerku.com' },
                { value: '.baozimhcn.com', text: 'baozimhcn.com' },
                { value: '.baozimh.com', text: 'baozimh.com' },
                { value: '.bzmgcn.com', text: 'bzmgcn.com' },
            ],
            default: 'auto',
        },
        language: {
            title: '簡繁',
            type: 'select',
            options: [
                { value: 'cn', text: '簡體 (cn.)' },
                { value: 'tw', text: '繁體 (tw.)' },
            ],
            default: 'cn',
        },
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
        cover_fallback: {
            title: '封面缺失時用正文首圖',
            type: 'switch',
            default: true,
        },
        ep_book_cover: {
            title: '每章第一頁插入整書封面',
            type: 'switch',
            // 包子站有不少書的 cover/*.jpg 本身就不存在（實測 108 本裡缺 7 本），
            // 而這些書的正文第一頁通常就是封面圖，插一張 404 進去反而難看，所以默認關。
            default: false,
        },
        img_quality: {
            title: '圖片清晰度',
            type: 'select',
            options: [
                { value: '', text: '原圖（預設）' },
                { value: 'w640', text: '640 寬（省流量，約 1/2.5 大小）' },
            ],
            default: '',
        },
    }

    translation = {
        zh_CN: {
            '簡繁': '简繁',
            '簡體 (cn.)': '简体 (cn.)',
            '繁體 (tw.)': '繁体 (tw.)',
            '章節資料夾命名': '章节目录命名',
            '書名 第003话：標題': '书名 第003话：标题',
            '0003. 標題': '0003. 标题',
            '0003（純序號）': '0003（纯序号）',
            '標題（不含序號）': '标题（不含序号）',
            '話數補零位數': '话数补零位数',
            '不補零（第3话，排序會亂）': '不补零（第3话，排序会乱）',
            '每章第一頁插入整書封面': '每章第一页插入整书封面',
            '圖片清晰度': '图片清晰度',
            '原圖（預設）': '原图（默认）',
            '640 寬（省流量，約 1/2.5 大小）': '640 宽（省流量，约 1/2.5 大小）',
            '站點域名（留空自動切換鏡像）': '站点域名（留空自动切换镜像）',
            '首頁': '首页',
            '最新上架': '最新上架',
            '類型': '类型',
            '地區': '地区',
            '狀態': '状态',
            '題材': '题材',
            '作者': '作者',
            '推薦': '推荐',
        },
        zh_TW: {
            '首頁': '首頁',
        },
    }
}
