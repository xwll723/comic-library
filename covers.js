/**
 * 补下载封面：遍历 state 里的每本书，把站点的封面存到 library/<书>/cover.xxx
 *
 * 为什么需要：站点封面 URL 大多有防盗链，阅读器直接请求会被拒（403/404），
 * 必须自己存一份、用本站域名提供。
 *
 * 用法：node covers.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const ST = path.join(ROOT, 'state')
const LIB = path.join(ROOT, 'library')
const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

async function grab(url) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
        const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
        if (!r.ok) return null
        const ct = r.headers.get('content-type') || ''
        if (!ct.startsWith('image/')) return null
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length < 1024) return null
        const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : ct.includes('gif') ? '.gif' : '.jpg'
        return { buf, ext }
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}

;(async () => {
    const files = fs.existsSync(ST) ? fs.readdirSync(ST).filter((f) => f.endsWith('.json') && !f.startsWith('_data_')) : []
    let ok = 0
    let skip = 0
    let fail = 0
    for (const f of files) {
        const key = f.replace(/\.json$/, '')
        const dir = path.join(LIB, key)
        if (!fs.existsSync(dir)) {
            skip++
            continue
        }
        const has = fs.readdirSync(dir).some((x) => /^cover\.(jpg|jpeg|png|webp|gif)$/i.test(x))
        if (has) {
            skip++
            continue
        }
        let st
        try {
            st = JSON.parse(fs.readFileSync(path.join(ST, f), 'utf8'))
        } catch {
            continue
        }
        if (!st.cover) {
            fail++
            continue
        }
        const got = await grab(st.cover)
        if (got) {
            fs.writeFileSync(path.join(dir, 'cover' + got.ext), got.buf)
            console.log(`✓ ${key}  cover${got.ext}  ${(got.buf.length / 1024).toFixed(0)}KB`)
            ok++
        } else {
            console.log(`✗ ${key}  封面下载失败（${String(st.cover).slice(0, 60)}）`)
            fail++
        }
    }
    console.log(`\n封面：成功 ${ok}，跳过 ${skip}，失败 ${fail}`)
})()
