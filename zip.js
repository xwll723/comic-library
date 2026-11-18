/**
 * 内存里的 CBZ 打包（CBZ = 图片的 zip 压缩包）。
 * 用 store 模式（不压缩）：图片本身已是压缩格式，再 deflate 只费 CPU 不省空间。
 */
const zlib = require('zlib')

const CRC_TABLE = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c
    }
    return t
})()

function crc32(buf) {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
}

class ZipWriter {
    constructor() {
        this.parts = []
        this.central = []
        this.offset = 0
    }
    add(name, data, { deflate = false } = {}) {
        const nameBuf = Buffer.from(name, 'utf8')
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data)
        const crc = crc32(raw)
        let body = raw
        let method = 0
        if (deflate && raw.length > 256) {
            const z = zlib.deflateRawSync(raw, { level: 9 })
            if (z.length < raw.length) {
                body = z
                method = 8
            }
        }
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
        local.writeUInt16LE(method, 8)
        local.writeUInt16LE(0, 10)
        local.writeUInt16LE(0x21, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(body.length, 18)
        local.writeUInt32LE(raw.length, 22)
        local.writeUInt16LE(nameBuf.length, 26)
        local.writeUInt16LE(0, 28)
        this.parts.push(local, nameBuf, body)

        const cen = Buffer.alloc(46)
        cen.writeUInt32LE(0x02014b50, 0)
        cen.writeUInt16LE(20, 4)
        cen.writeUInt16LE(20, 6)
        cen.writeUInt16LE(0x0800, 8)
        cen.writeUInt16LE(method, 10)
        cen.writeUInt16LE(0, 12)
        cen.writeUInt16LE(0x21, 14)
        cen.writeUInt32LE(crc, 16)
        cen.writeUInt32LE(body.length, 20)
        cen.writeUInt32LE(raw.length, 24)
        cen.writeUInt16LE(nameBuf.length, 28)
        cen.writeUInt32LE(this.offset, 42)
        this.central.push(cen, nameBuf)

        this.offset += local.length + nameBuf.length + body.length
    }
    finish() {
        const cenBuf = Buffer.concat(this.central)
        const end = Buffer.alloc(22)
        end.writeUInt32LE(0x06054b50, 0)
        end.writeUInt16LE(this.central.length / 2, 8)
        end.writeUInt16LE(this.central.length / 2, 10)
        end.writeUInt32LE(cenBuf.length, 12)
        end.writeUInt32LE(this.offset, 16)
        return Buffer.concat([...this.parts, cenBuf, end])
    }
}

/**
 * 把图片数组打包成 CBZ。
 * @param {{url:string, data:Buffer, ext:string}[]} images
 */
function makeCbz(images) {
    const zip = new ZipWriter()
    images.forEach((img, i) => {
        const pad = String(i).padStart(3, '0')
        zip.add(`${pad}${img.ext || '.jpg'}`, img.data)
    })
    return zip.finish()
}

module.exports = { ZipWriter, makeCbz }
