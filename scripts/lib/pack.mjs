// 确定性打包：把某个目录打成 theme.tar.gz，**不依赖平台自带的 tar**。
//
// ★为什么不用 `tar`（2026-11-22 三审）：`npm run package` 声称「可复现」，在 CI/Linux
//   上成立（GNU tar 的 gzip 头 mtime 同被 `--mtime` 钉住），在 Windows 上不成立：
//   · 系统自带的是 bsdtar 3.8.9，它的 **gzip 头写的是本次打包的真实时刻**（实测两次
//     `890c233c…` ≠ `e3aa13ba…`，裸 tar 流完全相同 `877dd241…`，差异只有 gzip 头那
//     4 字节 MTIME；`--mtime` 只钉 tar 成员，钉不住压缩层）。
//   · 它也没有 `--mode`（实测 `Option --mode=644 is not supported`），产物权限位直接
//     跟着文件系统的 umask 走：Windows 上是 0666/0777，CI 的 Linux 检出是 0644/0755。
//     于是 Windows 自建的包与发布资产**永远**对不上，`sha256sum -c` 那条校验形同虚设。
//   把 tar 头与 gzip 头都自己写，两边才真的同字节。
//
// 产出与 `tar -cf - --owner=0 --group=0 --numeric-owner --mtime=@0 --sort=name` 的
// **裸流等价**（ustar 格式、0644/0755、属主全 0、mtime 0、按名字排序），压缩层用
// `zlib.gzipSync(..., { level: 9 })` 并显式把 gzip 头的 MTIME 写 0。
//
// 用：
//   import { packDirectory } from './lib/pack.mjs'
//   packDirectory('release/staging', 'release/theme.tar.gz', { files: ['theme.json', ...] })
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { gunzipSync, deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'

/** 目录条目 0755、普通文件 0644 —— 与 CI 的 git 检出（umask 022 下）同一套。 */
const MODE_DIR = 0o755
const MODE_FILE = 0o644
/** 固定 mtime：SOURCE_DATE_EPOCH 没设就是 0（1970-01-01）。 */
const mtime = () => {
  const raw = process.env.SOURCE_DATE_EPOCH
  if (!raw) return 0
  const epoch = Number(raw)
  if (!Number.isFinite(epoch) || epoch < 0) throw new Error(`SOURCE_DATE_EPOCH 不合法: ${raw}`)
  return Math.floor(epoch)
}

/** 八进制字段：宽度 width（含结尾 NUL），溢出时退回 GNU 的 base-256 写法。 */
const octal = (value, width) => {
  const text = value.toString(8)
  if (text.length > width - 1) {
    // GNU tar 对超宽数字用 base-256（最高位置一的那个字节起算）。单文件大小与 mtime
    // 在我们这里远到不了 8 GiB / 2106 年，但路径长度之外还有 uid，留着以免静默截断。
    const buf = Buffer.alloc(width)
    let n = BigInt(value)
    for (let i = width - 1; i >= 0 && n > 0n; i--) {
      buf[i] = Number(n & 0xffn)
      n >>= 8n
    }
    buf[0] |= 0x80
    return buf
  }
  return Buffer.from(`${text.padStart(width - 1, '0')}\0`, 'latin1')
}

/** 512 字节的 ustar 头（与 GNU tar 的 `ustar  \0` 老格式一致，见文件头注释的实测）。 */
const header = ({ name, size, type, mode, at }) => {
  const buf = Buffer.alloc(512)
  // name（100）/ mode（8）/ uid（8）/ gid（8）/ size（12）/ mtime（12）/ chksum（8）
  buf.write(name, 0, 100, 'utf8')
  octal(mode, 8).copy(buf, 100)
  octal(0, 8).copy(buf, 108)
  octal(0, 8).copy(buf, 116)
  octal(size, 12).copy(buf, 124)
  octal(at, 12).copy(buf, 136)
  buf.write('        ', 148, 8, 'latin1')      // 校验和先占 8 个空格
  buf[156] = type.charCodeAt(0)                // '0' 文件 / '5' 目录
  buf.write('ustar  \0', 257, 8, 'latin1')     // GNU tar 的老 magic（不是 'ustar\0' + '00'）
  // uname/gname/devmajor/devminor 全 0 字节：`--owner=0 --group=0` 之后 GNU tar 也不写名字。
  const sum = buf.reduce((n, byte) => n + byte, 0)
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return buf
}

/** 收集目录树里的条目，按**字节序**排序（GNU tar `--sort=name` 的口径）。 */
const collect = (root, file) => {
  const stats = statSync(`${root}/${file}`)
  if (!stats.isDirectory()) return [{ path: file, dir: false, size: stats.size }]
  const out = [{ path: `${file}/`, dir: true, size: 0 }]
  const names = readdirSync(`${root}/${file}`).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  for (const name of names) out.push(...collect(root, `${file}/${name}`))
  return out
}

/**
 * 打包。`files` 是要打进去的顶层条目（与 `tar ... FILE...` 同义），目录递归、按字节序。
 * 返回 { digest, size } —— digest 是整包的 sha256（十六进制）。
 */
export const packDirectory = (root, archive, { files }) => {
  const at = mtime()
  const chunks = []
  for (const file of files) {
    for (const entry of collect(root, file)) {
      if (entry.dir) {
        chunks.push(header({ name: entry.path, size: 0, type: '5', mode: MODE_DIR, at }))
        continue
      }
      const body = readFileSync(`${root}/${entry.path}`)
      chunks.push(header({ name: entry.path, size: body.length, type: '0', mode: MODE_FILE, at }), body)
      // 文件内容按 512 对齐补齐。
      const rest = body.length % 512
      if (rest) chunks.push(Buffer.alloc(512 - rest))
    }
  }
  // 结尾：两个全零块 + 补到 10240 的整数倍（GNU tar 的 blocking factor 20）。
  chunks.push(Buffer.alloc(1024))
  const tar = Buffer.concat(chunks)
  const pad = (10240 - (tar.length % 10240)) % 10240
  const raw = pad ? Buffer.concat([tar, Buffer.alloc(pad)]) : tar

  // gzip 头自己写：`zlib.gzipSync` 的头是 `1f 8b 08 00 00 00 00 00 00 XX`（mtime 已 0、
  // XFL 0、OS 取决于 zlib 的编译目标 —— Linux 上是 03，Windows 上见过 0a），
  // 而发布资产（CI 的 gzip）OS 字节是 03。自己拼头，两端才同字节。
  const deflated = deflateRawSync(raw, { level: 9 })
  const gz = Buffer.alloc(10 + deflated.length + 8)
  gz[0] = 0x1f
  gz[1] = 0x8b
  gz[2] = 0x08                                  // deflate
  gz[3] = 0x00                                  // flags
  gz.writeUInt32LE(at >>> 0, 4)                 // MTIME：钉死（0）
  gz[8] = 0x00                                  // XFL
  gz[9] = 0x03                                  // OS = Unix，与 CI 的 gzip 一致
  deflated.copy(gz, 10)
  gz.writeUInt32LE(crc32(raw) >>> 0, 10 + deflated.length)
  gz.writeUInt32LE(raw.length >>> 0, 10 + deflated.length + 4)

  writeFileSync(archive, gz)
  return { digest: createHash('sha256').update(gz).digest('hex'), size: gz.length }
}

/**
 * 读回一个 .tar.gz 的条目清单（只读头，不解内容）。打包后的自检用 ——
 * 不借外部的 `tar`，于是「这份包能不能被解开」在 Windows 上也照样验得了。
 */
export const listArchive = (archive) => {
  const raw = gunzipSync(readFileSync(archive))
  const entries = []
  for (let offset = 0; offset + 512 <= raw.length; ) {
    const head = raw.subarray(offset, offset + 512)
    if (head.every((byte) => byte === 0)) break
    const field = (from, to) => head.subarray(from, to).toString('latin1').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 136).trim() || '0', 8)
    entries.push({ name: field(0, 100), dir: head[156] === 0x35, size })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}
let table = null
const crc32 = (buf) => {
  if (!table) {
    table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}
