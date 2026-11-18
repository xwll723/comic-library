class MangacopySource extends ComicSource {

    name = "拷贝漫画"

    key = "mangacopy"

    version = "1.0.0"

    minAppVersion = "1.0.0"

    url = "https://example.com/mangacopy.js"

    /// 站点 API 域名候选（按顺序试，成功即记住）。
    /// api.copy4000.com / api.mangacopy.com / api.copy-manga.com / api.copy2000.online 实测均可用，
    /// 站点换域名时把新的加在这里即可。
    static apiHosts = [
        "https://api.copy4000.com",
        "https://api.mangacopy.com",
        "https://api.copy-manga.com",
        "https://api.copy2000.online",
        "https://api.copy202601.com",
    ]

    /// H5 端 app 版本号（服务端会校验，过低会返回 210）
    static appVersion = "2026.10.16"

    static pageSize = 30

    /// 主题分类表（站点 path_word）
    static themeDict = {
        "全部": "",
        "愛情": "aiqing",
        "歡樂向": "huanlexiang",
        "冒險": "maoxian",
        "奇幻": "qihuan",
        "百合": "baihe",
        "校园": "xiaoyuan",
        "科幻": "kehuan",
        "東方": "dongfang",
        "耽美": "danmei",
        "生活": "shenghuo",
        "格鬥": "gedou",
        "轻小说": "qingxiaoshuo",
        "悬疑": "xuanyi",
        "其他": "qita",
        "神鬼": "shengui",
        "职场": "zhichang",
        "萌系": "mengxi",
        "治愈": "zhiyu",
        "長條": "changtiao",
        "四格": "sige",
        "搞笑": "gaoxiao",
        "热血": "rexue",
        "励志": "lizhi",
        "彩色": "COLOR",
        "後宮": "hougong",
        "美食": "meishi",
        "侦探": "zhentan",
        "魔幻": "mohuan",
        "战争": "zhanzheng",
        "历史": "lishi",
        "异世界": "yishijie",
        "惊悚": "jingsong",
        "都市": "dushi",
        "穿越": "chuanyue",
        "恐怖": "kongbu",
        "重生": "chongsheng",
        "武侠": "wuxia",
    }

    /// 接口对请求头敏感：缺 platform / version 时搜索会静默返回空列表，
    /// platform 只认请求头，不认 query 参数。
    get headers() {
        return {
            "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "platform": "1",
            "version": MangacopySource.appVersion,
            "webp": "1",
            "region": this.loadSetting("region") || "0",
            "Referer": "https://mangacopy.com/",
            "Origin": "https://mangacopy.com",
        }
    }

    get apiHost() {
        return this.loadData("api_host") || MangacopySource.apiHosts[0]
    }

    hostList() {
        const saved = this.loadData("api_host")
        const all = MangacopySource.apiHosts.slice()
        if (saved && all.indexOf(saved) >= 0) {
            const i = all.indexOf(saved)
            all.splice(i, 1)
            all.unshift(saved)
        }
        return all
    }

    /// 接口有频率限制（code 210），同一时刻只发一个请求并留出间隔
    async throttle() {
        const now = Date.now()
        const last = this._lastCall || 0
        const gap = 350
        if (now - last < gap) {
            await new Promise((r) => setTimeout(r, gap - (now - last)))
        }
        this._lastCall = Date.now()
    }

    /// App 的 Network 没有 timeout，卡住会一直转圈，这里自己加
    withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), ms)),
        ])
    }

    /// GET /api/v3/xxx，自动换域名、处理 210 频率限制
    /// 返回 results 字段（可能为 null）
    async api(path) {
        const hosts = this.hostList()
        let lastErr = ""
        for (let round = 0; round < 2; round++) {
            for (let i = 0; i < hosts.length; i++) {
                const url = hosts[i] + "/api/v3" + path
                let res
                await this.throttle()
                try {
                    res = await this.withTimeout(Network.get(url, this.headers), 10000)
                } catch (e) {
                    lastErr = "网络错误 " + e
                    continue
                }
                if (res.status !== 200) {
                    lastErr = "HTTP " + res.status
                    continue
                }
                let data
                try {
                    data = JSON.parse(res.body)
                } catch (e) {
                    lastErr = "返回非 JSON"
                    continue
                }
                if (data.code !== 200) {
                    lastErr = "code " + data.code + " " + String(data.message || "").slice(0, 60)
                    // 210 = 访问过于频繁 / 版本校验，换域名或稍等重试
                    continue
                }
                this.saveData("api_host", hosts[i])
                return data.results
            }
            // 全部域名都失败，退避后再试（多半是频率限制 code 210）
            if (round === 0) {
                await new Promise((r) => setTimeout(r, 5000))
            }
        }
        throw "接口请求失败: " + lastErr
    }

    abs(url) {
        if (!url) return ""
        if (url.startsWith("http")) return url
        if (url.startsWith("//")) return "https:" + url
        return "https://" + url.replace(/^\/+/, "")
    }

    static maxPageOf(total, size) {
        const t = parseInt(total || 0)
        if (!t || t <= 0) return 1
        return Math.max(1, Math.ceil(t / size))
    }

    parseComic(raw) {
        let c = raw
        if (c && c.comic) c = c.comic
        if (!c) return null
        let tags = []
        if (Array.isArray(c.theme)) tags = c.theme.map((t) => t && t.name).filter((t) => !!t)
        let author = null
        let authorNum = 0
        if (Array.isArray(c.author) && c.author.length > 0) {
            author = c.author[0].name
            authorNum = c.author.length
        }
        if (authorNum > 1) author = author + " 等" + authorNum + "位"
        let desc = c.datetime_updated || ""
        if (raw && raw.sort !== undefined && raw.sort !== null) {
            const rise = raw.rise_sort > 0 ? "▲" : raw.rise_sort < 0 ? "▽" : "-"
            const pop = raw.popular || 0
            desc = raw.sort + " " + rise + "\n" + (author || "") + "\n🔥" + (pop / 10000).toFixed(1) + "W"
        }
        let subTitle = author
        if (!subTitle && c.status && c.status.display) subTitle = c.status.display
        return new Comic({
            id: c.path_word,
            title: c.name,
            subTitle: subTitle,
            cover: this.abs(c.cover),
            tags: tags,
            description: desc,
        })
    }

    /// 书架/收藏用不到，但接口 id 与 uuid 需要区分：列表里是 path_word
    explore = [
        {
            title: "拷贝漫画",
            type: "multiPartPage",
            load: async () => {
                const parts = [
                    { title: "热门", query: "ordering=-popular" },
                    { title: "最新更新", query: "ordering=-datetime_updated" },
                    { title: "日漫", query: "ordering=-popular&top=japan" },
                    { title: "已完结", query: "ordering=-popular&top=finish" },
                ]
                const out = []
                for (let i = 0; i < parts.length; i++) {
                    try {
                        const r = await this.api(
                            "/comics?limit=" +
                                MangacopySource.pageSize +
                                "&offset=0&" +
                                parts[i].query +
                                "&platform=1&_update=true"
                        )
                        const list = (r && r.list) || []
                        if (list.length) {
                            out.push({
                                title: parts[i].title,
                                comics: list.map((x) => this.parseComic(x)).filter((x) => !!x),
                            })
                        }
                    } catch (e) {
                        // 单个板块失败不影响其它板块
                    }
                }
                if (!out.length) throw "首页数据获取失败"
                return out
            },
        },
    ]

    search = {
        load: async (keyword, options, page) => {
            const kw = (keyword || "").trim()
            if (!kw) throw "请输入关键词"
            const qType = (options && options[0]) || ""
            const offset = (page - 1) * MangacopySource.pageSize
            let r
            if (kw.startsWith("作者:")) {
                // 按作者名反查作品列表
                const author = kw.substring(3).trim()
                r = await this.api(
                    "/comics?limit=" +
                        MangacopySource.pageSize +
                        "&offset=" +
                        offset +
                        "&ordering=-datetime_updated&author=" +
                        encodeURIComponent(author) +
                        "&platform=1&_update=true"
                )
            } else {
                r = await this.api(
                    "/search/comic?limit=" +
                        MangacopySource.pageSize +
                        "&offset=" +
                        offset +
                        "&q=" +
                        encodeURIComponent(kw) +
                        "&q_type=" +
                        encodeURIComponent(qType) +
                        "&platform=1&_update=true"
                )
            }
            const list = (r && r.list) || []
            return {
                comics: list.map((x) => this.parseComic(x)).filter((x) => !!x),
                maxPage: MangacopySource.maxPageOf(r && r.total, MangacopySource.pageSize),
            }
        },
        optionList: [
            {
                type: "select",
                options: ["-全部", "name-名称", "author-作者", "local-汉化组"],
                label: "搜索选项",
            },
        ],
    }

    category = {
        title: "拷贝漫画",
        parts: [
            {
                name: "主题",
                type: "fixed",
                categories: Object.keys(MangacopySource.themeDict),
                categoryParams: Object.values(MangacopySource.themeDict),
                itemType: "category",
            },
            {
                name: "分区",
                type: "fixed",
                categories: ["全部", "日漫", "韩漫", "美漫", "已完结"],
                categoryParams: ["", "japan", "korea", "west", "finish"],
                itemType: "category",
            },
        ],
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            let paramWord = param
            if (paramWord === undefined || paramWord === null || paramWord === "" || paramWord === "undefined") {
                paramWord = MangacopySource.themeDict[category] || ""
            }
            const opts = options || []
            const top = String(opts[0] || "").replace(/^-/, "")
            const ordering = String(opts[1] || "*datetime_updated").replace("*", "-")
            const path =
                "/comics?limit=" +
                MangacopySource.pageSize +
                "&offset=" +
                (page - 1) * MangacopySource.pageSize +
                "&theme=" +
                encodeURIComponent(paramWord || "") +
                "&top=" +
                encodeURIComponent(top) +
                "&ordering=" +
                encodeURIComponent(ordering) +
                "&platform=1&_update=true"
            const r = await this.api(path)
            const list = (r && r.list) || []
            return {
                comics: list.map((x) => this.parseComic(x)).filter((x) => !!x),
                maxPage: MangacopySource.maxPageOf(r && r.total, MangacopySource.pageSize),
            }
        },
        optionList: [
            {
                type: "select",
                options: ["-全部", "japan-日漫", "korea-韩漫", "west-美漫", "finish-已完结"],
                label: "分区",
            },
            {
                type: "select",
                options: [
                    "*datetime_updated-时间倒序",
                    "datetime_updated-时间正序",
                    "*popular-热度倒序",
                    "popular-热度正序",
                ],
                label: "排序",
            },
        ],
        ranking: {
            options: ["day-日榜", "week-周榜", "month-月榜"],
            load: async (option, page) => {
                const dateType = String(option || "day").split("-")[0]
                const r = await this.api(
                    "/ranks?limit=" +
                        MangacopySource.pageSize +
                        "&offset=" +
                        (page - 1) * MangacopySource.pageSize +
                        "&type=1&audience_type=" +
                        (this.loadSetting("audience") || "male") +
                        "&date_type=" +
                        dateType +
                        "&platform=1&_update=true"
                )
                const list = (r && r.list) || []
                return {
                    comics: list.map((x) => this.parseComic(x)).filter((x) => !!x),
                    maxPage: MangacopySource.maxPageOf(r && r.total, MangacopySource.pageSize),
                }
            },
        },
    }

    /**
     * 过滤掉「不属于本书」的图片。
     * 图片路径形如 /m/<slug>/<code>/xxx.jpg，slug 就是漫画的 path_word。
     * 站点数据损坏时会出现指向其它漫画的图。
     */
    static filterBadImages(images, slug) {
        const id = String(slug == null ? '' : slug).trim()
        if (!id) return images
        const out = []
        for (const u of images) {
            const m = /\/m\/([^\/]+)\//.exec(String(u))
            if (!m) {
                out.push(u)
                continue
            }
            const s2 = m[1]
            if (s2 === id || s2.indexOf(id) === 0 || id.indexOf(s2) === 0) out.push(u)
        }
        return out
    }

    /// 章节可读名：书名 第003话：标题
    chapterName(bookTitle, ep, usedIndex) {
        const rawName = String((ep && ep.name) || "").trim()
        let num = null
        const m = rawName.match(/第\s*(\d+(?:\.\d+)?)/)
        if (m) {
            num = parseFloat(m[1])
        } else if (typeof ep.index === "number") {
            num = ep.index + 1
        } else if (typeof ep.ordered === "number" && ep.ordered > 0) {
            num = Math.round(ep.ordered / 10)
        }
        if (num === null || isNaN(num) || num <= 0) num = usedIndex
        let numStr
        if (Math.abs(num - Math.round(num)) < 0.0001) {
            numStr = String(Math.round(num)).padStart(3, "0")
        } else {
            const intPart = Math.floor(num)
            numStr = String(intPart).padStart(3, "0") + "." + String(num).split(".")[1]
        }
        let title = rawName
            .replace(/^第\s*\d+(?:\.\d+)?\s*[话話回卷集章節节]/g, "")
            .replace(/^\d+\s*[.、,，:：]\s*/, "")
            .replace(/^[话話回卷集]\s*/, "")
            .trim()
        let name = bookTitle + " 第" + numStr + "话"
        if (title) name = name + "：" + title
        return name
    }

    /// 章节 id（可读名） -> 站点 uuid；并兼容旧的原生 uuid
    async resolveHid(comicId, epId) {
        const map = this.loadData("ep_" + comicId)
        if (map && map[epId]) return map[epId]
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(String(epId))) return epId
        try {
            await this.comic.loadInfo(comicId)
        } catch (e) {
            // 忽略，仍然原样返回
        }
        const map2 = this.loadData("ep_" + comicId)
        if (map2 && map2[epId]) return map2[epId]
        return epId
    }

    comic = {
        loadInfo: async (id) => {
            const d = await this.api("/comic2/" + id + "?platform=1&_update=true")
            if (!d || !d.comic) throw "漫画详情获取失败(可能被限制)"
            const c = d.comic
            const bookTitle = c.name || id
            const cover = this.abs(c.cover)
            this.saveData("cover_" + id, cover)

            let groups = d.groups
            if (!groups || !Object.keys(groups).length) {
                groups = { "默认": { path_word: "default", name: "默认" } }
            }
            const groupKeys = Object.keys(groups)
            const multiGroup = groupKeys.length > 1

            const chapters = {}
            const hidMap = {}
            let seq = 1

            for (let gi = 0; gi < groupKeys.length; gi++) {
                const g = groups[groupKeys[gi]] || {}
                const groupPath = g.path_word || "default"
                const groupName = g.name || groupKeys[gi]
                let offset = 0
                let total = null
                let pages = 0
                while (pages < 40) {
                    const r = await this.api(
                        "/comic/" +
                            id +
                            "/group/" +
                            groupPath +
                            "/chapters?limit=100&offset=" +
                            offset +
                            "&platform=1&_update=true"
                    )
                    const list = (r && r.list) || []
                    if (!list.length) break
                    if (total === null && r && typeof r.total === "number") total = r.total
                    for (let i = 0; i < list.length; i++) {
                        const ep = list[i]
                        if (!ep || !ep.uuid) continue
                        let name = this.chapterName(bookTitle, ep, seq)
                        // 主分组（default / 默認 / 默认）不加前缀，只有其它版本才标注
                        const isMainGroup =
                            groupPath === 'default' || /^(默認|默认)$/.test(String(groupName))
                        if (multiGroup && !isMainGroup) name = name + " [ " + groupName + " ]" 
                        let key = name
                        let dup = 2
                        while (chapters[key] !== undefined) {
                            key = name + "（" + dup + "）"
                            dup++
                        }
                        chapters[key] = key
                        hidMap[key] = ep.uuid
                        seq++
                    }
                    offset += list.length
                    pages++
                    if (total !== null && offset >= total) break
                }
            }

            // 排序：按话数从旧到新（保持站点顺序，Map 顺序即对象插入顺序）
            this.saveData("ep_" + id, hidMap)

            let authors = []
            if (Array.isArray(c.author)) authors = c.author.map((a) => a && a.name).filter((a) => !!a)
            let themes = []
            if (Array.isArray(c.theme)) themes = c.theme.map((t) => t && t.name).filter((t) => !!t)
            let status = c.status && c.status.display ? c.status.display : ""

            const tags = {}
            if (authors.length) tags["作者"] = authors
            if (themes.length) tags["标签"] = themes
            if (status) tags["状态"] = [status]
            if (c.datetime_updated) tags["更新"] = [c.datetime_updated]

            return new ComicDetails({
                title: bookTitle,
                cover: cover,
                description: c.brief || c.alias || "",
                tags: tags,
                chapters: chapters,
                subId: c.uuid,
                url: "https://mangacopy.com/comic/" + id,
            })
        },

        loadEp: async (comicId, epId) => {
            const uuid = await this.resolveHid(comicId, epId)
            const d = await this.api(
                "/comic/" + comicId + "/chapter2/" + uuid + "?platform=1&_update=true"
            )
            if (!d || !d.chapter) throw "章节数据获取失败(可能被限制或需登录)"
            const ch = d.chapter
            const contents = ch.contents || []
            if (!contents.length) throw "本章没有图片"
            let urls = contents.map((x) => this.abs(x && x.url)).filter((u) => !!u)
            // words 是每张图在章节里的顺序下标
            const words = ch.words
            if (Array.isArray(words) && words.length === urls.length) {
                const sorted = new Array(urls.length)
                for (let i = 0; i < urls.length; i++) sorted[words[i]] = urls[i]
                urls = sorted.filter((u) => !!u)
            }
            // 过滤掉指向其它漫画的图（站点数据损坏时会出现）
            const cleaned = MangacopySource.filterBadImages(urls, comicId)
            if (urls.length && !cleaned.length) throw '本章数据异常（图片指向其他漫画），建议换源阅读'
            const images = cleaned
            // 每章第一页插入整书封面（默认开）
            if (this.loadSetting("ep_book_cover") !== false) {
                let cover = this.loadData("cover_" + comicId)
                if (!cover) {
                    try {
                        const info = await this.comic.loadInfo(comicId)
                        cover = info && info.cover
                    } catch (e) {
                        cover = null
                    }
                }
                if (cover) images.unshift(this.abs(cover))
            }
            return { images: images }
        },
    }

    settings = {
        ep_book_cover: {
            title: "每章开头插入书籍封面",
            type: "switch",
            default: true,
        },
        region: {
            title: "线路（region 请求头）",
            type: "select",
            options: [
                { value: "0", text: "海外线路" },
                { value: "1", text: "大陆线路" },
            ],
            default: "0",
        },
        audience: {
            title: "排行榜受众",
            type: "select",
            options: [
                { value: "male", text: "男频" },
                { value: "female", text: "女频" },
            ],
            default: "male",
        },
    }
}
