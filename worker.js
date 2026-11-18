/**
 * Cloudflare Worker：Hugging Face 文件代理
 *
 * 为什么需要它：
 *   HF 的下载地址会 302 跳到 AWS CDN，很多阅读器（如可达）不跟随重定向，直接报 404。
 *   Worker 在服务端把重定向跟完，对客户端返回 200 + 文件流。
 *
 * 路由：
 *   /file/<path>  →  代理 HF 上的 library/<path>
 *   /health       →  健康检查
 *
 * 环境变量（在 Worker 设置里配）：
 *   HF_REPO     xwll/comic-library
 *   HF_TOKEN    HF 的 read token（HF 仓库设私密时必须）
 *   ACCESS_KEY  可选，访问密钥；设置了就要求 URL 带 ?k=xxx
 */

export default {
    async fetch(request, env) {
        const url = new URL(request.url)

        if (url.pathname === '/health') {
            return json({ ok: true, repo: env.HF_REPO || null })
        }

        // 可选访问密钥
        if (env.ACCESS_KEY && url.searchParams.get('k') !== env.ACCESS_KEY) {
            return new Response('403 forbidden', { status: 403 })
        }

        // /file/library/xxx/0001.cbz
        const m = /^\/file\/(.+)$/.exec(url.pathname)
        if (!m) {
            return json({ error: 'not found', hint: 'use /file/<path>' }, 404)
        }
        const path = decodeURIComponent(m[1])
        const repo = env.HF_REPO || 'xwll/comic-library'
        const hfUrl = `https://huggingface.co/datasets/${repo}/resolve/main/${encodeURI(path)}`

        const headers = {}
        if (env.HF_TOKEN) headers['Authorization'] = `Bearer ${env.HF_TOKEN}`

        let upstream
        try {
            // redirect: follow 是关键——把 HF 的 302 在服务端跟完
            upstream = await fetch(hfUrl, { headers, redirect: 'follow' })
        } catch (e) {
            return new Response('upstream error: ' + e.message, { status: 502 })
        }

        if (!upstream.ok) {
            return new Response(`hugging face returned ${upstream.status}`, {
                status: upstream.status,
            })
        }

        const ct = upstream.headers.get('content-type') || 'application/octet-stream'
        const out = new Headers()
        out.set('Content-Type', ct)
        const len = upstream.headers.get('content-length')
        if (len) out.set('Content-Length', len)
        // 文件不会变，缓存一天，省流量
        out.set('Cache-Control', 'public, max-age=86400')
        out.set('Access-Control-Allow-Origin', '*')

        return new Response(upstream.body, { status: 200, headers: out })
    },
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}
