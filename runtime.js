/**
 * 让 Venera 漫画源能在 Node.js 里运行。
 *
 * 源是给 App 的 QuickJS 引擎写的，引用了 ComicSource / Comic / Network / Convert
 * 这些全局对象。这里用真实的 Node 能力把它们实现出来，源文件就能原样跑。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

// ---------------------------------------------------------------- 全局桩

class ComicSource {
    constructor() {
        this.__data = {}
        this.__storeFile = null // 由 attachStore 注入
    }

    /**
     * 挂一个磁盘文件，让 saveData/loadData 跨进程保留。
     * 关键用途：包子源会把「哪个镜像域名可用」记在 host_ok 里，
     * 不持久化的话每次运行都要重新试错（每个坏域名要等 8 秒超时）。
     */
    __attach(file) {
        this.__storeFile = file
        try {
            if (fs.existsSync(file)) this.__data = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch {
            this.__data = {}
        }
    }

    __flush() {
        if (!this.__storeFile) return
        try {
            fs.mkdirSync(path.dirname(this.__storeFile), { recursive: true })
            fs.writeFileSync(this.__storeFile, JSON.stringify(this.__data, null, 2))
        } catch {
            // 写不了不影响抓取
        }
    }

    loadSetting(k) {
        return this.settings && this.settings[k] ? this.settings[k].default : undefined
    }
    loadData(k) {
        return this.__data[k] ?? null
    }
    saveData(k, v) {
        this.__data[k] = v
        this.__flush()
    }
    deleteData(k) {
        delete this.__data[k]
        this.__flush()
    }
    get isLogged() {
        return false
    }
    init() {}
}

function Comic(o) {
    Object.assign(this, o)
}
function ComicDetails(o) {
    Object.assign(this, o)
}

async function req(method, url, headers, data) {
    const h = Object.assign({ 'User-Agent': UA }, headers || {})
    const opt = { method, headers: h }
    if (data && method !== 'GET') opt.body = typeof data === 'string' ? data : Buffer.from(data)
    const r = await fetch(url, opt)
    return r
}

const Network = {
    async get(url, headers) {
        const r = await req('GET', url, headers)
        return { status: r.status, headers: {}, body: await r.text() }
    },
    async post(url, headers, data) {
        const r = await req('POST', url, headers, data)
        return { status: r.status, headers: {}, body: await r.text() }
    },
    async sendRequest(method, url, headers, data) {
        const r = await req(method, url, headers, data)
        return { status: r.status, headers: {}, body: await r.text() }
    },
    async fetchBytes(method, url, headers, data) {
        const r = await req(method, url, headers, data)
        return { status: r.status, headers: {}, body: await r.arrayBuffer() }
    },
}

const Convert = {
    encodeUtf8: (s) => Buffer.from(String(s), 'utf8'),
    decodeUtf8: (b) => Buffer.from(b).toString('utf8'),
    encodeBase64: (b) => Buffer.from(b).toString('base64'),
    decodeBase64: (s) => Buffer.from(String(s), 'base64'),
    hexEncode: (b) => Buffer.from(b).toString('hex'),
    md5: (b) => crypto.createHash('md5').update(Buffer.from(b)).digest(),
    sha1: (b) => crypto.createHash('sha1').update(Buffer.from(b)).digest(),
    sha256: (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest(),
    hmac: (k, v) => crypto.createHmac('sha256', Buffer.from(k)).update(Buffer.from(v)).digest(),
    hmacString: (k, v) => crypto.createHmac('sha256', Buffer.from(k)).update(Buffer.from(v)).digest('hex'),
}

function randomInt(a, b) {
    return a + Math.floor(Math.random() * (b - a + 1))
}
function randomDouble(a, b) {
    return a + Math.random() * (b - a)
}
function createUuid() {
    return crypto.randomUUID()
}

const globals = { ComicSource, Comic, ComicDetails, Network, Convert, randomInt, randomDouble, createUuid }
Object.assign(globalThis, globals)
globalThis.console = console

// ---------------------------------------------------------------- 加载源

/**
 * 读取一个源文件并实例化。
 * 和 App 一样，用「第一个以 class 开头的行」定位源类。
 */
function loadSource(file, storeFile) {
    const src = fs.readFileSync(file, 'utf8')
    const line = src.split('\n').find((l) => l.trim().startsWith('class '))
    if (!line || !line.startsWith('class ')) {
        throw new Error(`${path.basename(file)}: 找不到合法的 class 声明行`)
    }
    const cls = line.split('class')[1].split('extends ComicSource')[0].trim()
    const factory = new Function(
        'ComicSource',
        'Comic',
        'ComicDetails',
        'Network',
        'Convert',
        'randomInt',
        'randomDouble',
        'createUuid',
        `${src}\n; return ${cls};`
    )
    const Inst = factory(ComicSource, Comic, ComicDetails, Network, Convert, randomInt, randomDouble, createUuid)
    const inst = new Inst()
    if (storeFile) inst.__attach(storeFile)
    return inst
}

module.exports = { loadSource, Network, Convert, UA }
